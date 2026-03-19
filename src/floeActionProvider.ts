import {
  ActionProvider,
  CreateAction,
  EvmWalletProvider,
  Network,
} from "@coinbase/agentkit";
import { encodeFunctionData, encodeDeployData } from "viem";
import { z } from "zod";

import {
  LENDING_MATCHER_ABI,
  LENDING_VIEWS_ABI,
  ERC20_ABI,
  FLASH_ARB_RECEIVER_ABI,
  AERODROME_QUOTER_V2_ABI,
  AERODROME_QUOTER_V2_ADDRESS,
  PRICE_ORACLE_ABI,
  BASE_MAINNET_MATCHER,
  BASE_MAINNET_VIEWS,
  BASE_MAINNET_ORACLE,
  AERODROME_SWAP_ROUTER_ADDRESS,
  BASE_WETH_ADDRESS,
  ORACLE_PRICE_SCALE,
  BASIS_POINTS,
} from "./constants.js";
import {
  FLASH_ARB_RECEIVER_BYTECODE,
  FLASH_ARB_RECEIVER_CONSTRUCTOR_ABI,
} from "./flashArbBytecode.js";
import {
  GetMarketsSchema,
  GetLoanSchema,
  GetMyLoansSchema,
  CheckLoanHealthSchema,
  GetPriceSchema,
  GetAccruedInterestSchema,
  GetLiquidationQuoteSchema,
  GetIntentBookSchema,
  PostLendIntentSchema,
  PostBorrowIntentSchema,
  MatchIntentsSchema,
  RepayLoanSchema,
  AddCollateralSchema,
  WithdrawCollateralSchema,
  LiquidateLoanSchema,
  GetFlashLoanFeeSchema,
  EstimateFlashArbProfitSchema,
  FlashLoanSchema,
  FlashArbSchema,
  GetFlashArbBalanceSchema,
  DeployFlashArbReceiverSchema,
  CheckFlashArbReadinessSchema,
  VerifyFlashArbReceiverSchema,
} from "./schemas.js";
import type { FloeConfig, Address } from "./types.js";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import {
  formatBps,
  formatTokenAmount,
  formatDuration,
  formatTimestamp,
  formatAddress,
  formatPrice,
  resolveTokenMeta,
  computeHealthPercent,
} from "./utils.js";

export class FloeActionProvider extends ActionProvider<EvmWalletProvider> {
  private matcherAddress: Address;
  private viewsAddress: Address;
  private knownMarketIds: `0x${string}`[];
  private deployedReceiverAddress: Address | null = null;

  constructor(config?: Partial<FloeConfig>) {
    super("floe", []);
    this.matcherAddress = config?.lendingIntentMatcherAddress ?? BASE_MAINNET_MATCHER;
    this.viewsAddress = config?.lendingViewsAddress ?? BASE_MAINNET_VIEWS;
    this.knownMarketIds = config?.knownMarketIds ?? [];
  }

  supportsNetwork = (network: Network): boolean => {
    return network.chainId === "8453" || network.chainId === "84532";
  };

  private resolveReceiverAddress(providedAddress?: string): Address {
    const addr = providedAddress ?? this.deployedReceiverAddress;
    if (!addr) {
      throw new Error(
        "No receiver address provided and no receiver deployed in this session. " +
        "Provide a receiverAddress or run deploy_flash_arb_receiver first."
      );
    }
    return addr as Address;
  }

  private async ensureAllowance(
    walletProvider: EvmWalletProvider,
    tokenAddress: Address,
    spenderAddress: Address,
    requiredAmount: bigint,
  ): Promise<string | null> {
    const owner = (await walletProvider.getAddress()) as Address;
    const currentAllowance = (await walletProvider.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spenderAddress],
    })) as bigint;

    if (currentAllowance >= requiredAmount) return null;

    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spenderAddress, requiredAmount],
    });
    const txHash = await walletProvider.sendTransaction({
      to: tokenAddress,
      data,
    });

    const meta = await resolveTokenMeta(tokenAddress, walletProvider);
    return `Approved ${formatTokenAmount(requiredAmount, meta.decimals, meta.symbol)} to ${formatAddress(spenderAddress)} (tx: ${txHash})`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // READ ACTIONS (1-8)
  // ════════════════════════════════════════════════════════════════════════

  @CreateAction({
    name: "get_markets",
    description:
      "Get information about Floe lending markets. Each market represents a unique loan token + collateral token pair with its own interest rate floor, LTV limits, and liquidation incentive. Unlike Aave/Compound pool-based lending, Floe markets are intent-based — lenders and borrowers post offers that get matched at fixed rates and terms.",
    schema: GetMarketsSchema,
  })
  async getMarkets(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetMarketsSchema>,
  ): Promise<string> {
    try {
      const ids = args?.marketIds?.length ? args.marketIds : this.knownMarketIds;
      if (ids.length === 0) {
        return "No market IDs provided and no known markets configured. Pass marketIds or configure knownMarketIds in the provider constructor.";
      }

      const results = await Promise.all(
        ids.map((id) =>
          walletProvider.readContract({
            address: this.matcherAddress,
            abi: LENDING_MATCHER_ABI,
            functionName: "getMarket",
            args: [id as `0x${string}`],
          }),
        ),
      );

      const lines: string[] = ["## Floe Lending Markets\n"];

      for (let i = 0; i < results.length; i++) {
        const m = results[i] as any;
        const [loanMeta, collMeta] = await Promise.all([
          resolveTokenMeta(m.loanToken, walletProvider),
          resolveTokenMeta(m.collateralToken, walletProvider),
        ]);

        lines.push(`### Market: ${collMeta.symbol}/${loanMeta.symbol}`);
        lines.push(`- **Market ID**: ${ids[i]}`);
        lines.push(`- **Loan Token**: ${loanMeta.symbol} (${m.loanToken})`);
        lines.push(`- **Collateral Token**: ${collMeta.symbol} (${m.collateralToken})`);
        lines.push(`- **Min Interest Rate**: ${formatBps(m.interestRateBps)}`);
        lines.push(`- **Min LTV**: ${formatBps(m.ltvBps)}`);
        lines.push(`- **Liquidation Incentive**: ${formatBps(m.liquidationIncentiveBps)}`);
        lines.push(`- **Market Fee**: ${formatBps(m.marketFeeBps)}`);
        lines.push(
          `- **Total Outstanding**: ${formatTokenAmount(m.totalPrincipalOutstanding, loanMeta.decimals, loanMeta.symbol)}`,
        );
        lines.push(`- **Total Loans Created**: ${m.totalLoans.toString()}`);

        const pauses: string[] = [];
        if (m.pauseStatuses.isBorrowPaused) pauses.push("borrowing");
        if (m.pauseStatuses.isRepayPaused) pauses.push("repayment");
        if (m.pauseStatuses.isLiquidatePaused) pauses.push("liquidation");
        if (m.pauseStatuses.isAddCollateralPaused) pauses.push("add collateral");
        if (m.pauseStatuses.isWithdrawCollateralPaused) pauses.push("withdraw collateral");
        lines.push(
          pauses.length > 0
            ? `- **Paused**: ${pauses.join(", ")}`
            : "- **Status**: All operations active",
        );
        lines.push("");
      }

      return lines.join("\n");
    } catch (e) {
      return `Error fetching markets: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "get_loan",
    description:
      "Get detailed information about a specific Floe loan. Returns the loan's terms (rate, LTV, duration), current health status, accrued interest, and participant addresses.",
    schema: GetLoanSchema,
  })
  async getLoan(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetLoanSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const [loan, currentLtv, healthy, interestData] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getLoan",
          args: [loanId],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getCurrentLtvBps",
          args: [loanId],
        }) as Promise<bigint>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "isHealthy",
          args: [loanId],
        }) as Promise<boolean>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getAccruedInterest",
          args: [loanId],
        }) as Promise<[bigint, bigint]>,
      ]);

      const [loanMeta, collMeta] = await Promise.all([
        resolveTokenMeta(loan.loanToken, walletProvider),
        resolveTokenMeta(loan.collateralToken, walletProvider),
      ]);

      const endTime = loan.startTime + loan.duration;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const isOverdue = now > endTime + loan.gracePeriod;
      const timeRemaining = endTime > now ? endTime - now : 0n;

      const lines = [
        `## Loan #${args.loanId}\n`,
        `- **Status**: ${loan.repaid ? "Repaid" : healthy ? "Healthy" : "⚠ UNHEALTHY — Liquidatable"}`,
        `- **Lender**: ${formatAddress(loan.lender)}`,
        `- **Borrower**: ${formatAddress(loan.borrower)}`,
        `- **Principal**: ${formatTokenAmount(loan.principal, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Collateral**: ${formatTokenAmount(loan.collateralAmount, collMeta.decimals, collMeta.symbol)}`,
        `- **Interest Rate**: ${formatBps(loan.interestRateBps)} annual`,
        `- **Accrued Interest**: ${formatTokenAmount(interestData[0], loanMeta.decimals, loanMeta.symbol)} (${formatDuration(interestData[1])} elapsed)`,
        `- **Origination LTV**: ${formatBps(loan.ltvBps)}`,
        `- **Current LTV**: ${formatBps(currentLtv)}`,
        `- **Liquidation LTV**: ${formatBps(loan.liquidationLtvBps)}`,
        `- **Health Buffer**: ${computeHealthPercent(currentLtv, loan.liquidationLtvBps)}`,
        `- **Start**: ${formatTimestamp(loan.startTime)}`,
        `- **Duration**: ${formatDuration(loan.duration)}`,
        `- **Time Remaining**: ${loan.repaid ? "N/A" : timeRemaining > 0n ? formatDuration(timeRemaining) : isOverdue ? "OVERDUE" : "Expired (in grace period)"}`,
        `- **Grace Period**: ${formatDuration(loan.gracePeriod)}`,
        `- **Market Fee**: ${formatBps(loan.marketFeeBps)}`,
        `- **Matcher Commission**: ${formatBps(loan.matcherCommissionBps)}`,
        `- **Min Interest Bps**: ${formatBps(loan.minInterestBps)}`,
        `- **Market ID**: ${loan.marketId}`,
      ];

      return lines.join("\n");
    } catch (e) {
      return `Error fetching loan: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "get_my_loans",
    description:
      "Get all loans associated with the connected wallet (as lender or borrower). Returns a summary of each loan's status, amounts, and health.",
    schema: GetMyLoansSchema,
  })
  async getMyLoans(
    walletProvider: EvmWalletProvider,
    _args: z.infer<typeof GetMyLoansSchema>,
  ): Promise<string> {
    try {
      const userAddress = await walletProvider.getAddress();
      const loanIds = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getLoanIdsByUser",
        args: [userAddress as Address],
      })) as bigint[];

      if (loanIds.length === 0) {
        return `No loans found for ${formatAddress(userAddress)}.`;
      }

      const loans = await Promise.all(
        loanIds.map((id) =>
          walletProvider.readContract({
            address: this.matcherAddress,
            abi: LENDING_MATCHER_ABI,
            functionName: "getLoan",
            args: [id],
          }),
        ),
      );

      const lines = [`## My Loans (${formatAddress(userAddress)})\n`];
      lines.push(`Found ${loanIds.length} loan(s).\n`);

      for (let i = 0; i < loans.length; i++) {
        const loan = loans[i] as any;
        const loanMeta = await resolveTokenMeta(loan.loanToken, walletProvider);
        const collMeta = await resolveTokenMeta(loan.collateralToken, walletProvider);
        const role =
          loan.lender.toLowerCase() === userAddress.toLowerCase()
            ? "Lender"
            : "Borrower";

        lines.push(
          `**Loan #${loanIds[i].toString()}** — ${role} | ${loan.repaid ? "Repaid" : "Active"} | ${formatTokenAmount(loan.principal, loanMeta.decimals, loanMeta.symbol)} → ${formatTokenAmount(loan.collateralAmount, collMeta.decimals, collMeta.symbol)} | Rate: ${formatBps(loan.interestRateBps)}`,
        );
      }

      return lines.join("\n");
    } catch (e) {
      return `Error fetching loans: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "check_loan_health",
    description:
      "Check the health status of a Floe loan. Returns current LTV vs liquidation threshold, accrued interest, time remaining, and whether the loan is at risk of liquidation.",
    schema: CheckLoanHealthSchema,
  })
  async checkLoanHealth(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CheckLoanHealthSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const [loan, currentLtv, healthy, interestData] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getLoan",
          args: [loanId],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getCurrentLtvBps",
          args: [loanId],
        }) as Promise<bigint>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "isHealthy",
          args: [loanId],
        }) as Promise<boolean>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getAccruedInterest",
          args: [loanId],
        }) as Promise<[bigint, bigint]>,
      ]);

      if (loan.repaid) {
        return `Loan #${args.loanId} has been fully repaid. No health check needed.`;
      }

      const loanMeta = await resolveTokenMeta(loan.loanToken, walletProvider);

      const endTime = loan.startTime + loan.duration;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const timeRemaining = endTime > now ? endTime - now : 0n;
      const isOverdue = now > endTime + loan.gracePeriod;

      const distanceBps = loan.liquidationLtvBps - currentLtv;
      const totalDebt = loan.principal + interestData[0];

      const lines = [
        `## Health Check — Loan #${args.loanId}\n`,
        `- **Healthy**: ${healthy ? "Yes" : "NO — Liquidatable!"}`,
        `- **Current LTV**: ${formatBps(currentLtv)}`,
        `- **Liquidation LTV**: ${formatBps(loan.liquidationLtvBps)}`,
        `- **Distance to Liquidation**: ${formatBps(distanceBps)} (${computeHealthPercent(currentLtv, loan.liquidationLtvBps)} buffer)`,
        `- **Total Debt**: ${formatTokenAmount(totalDebt, loanMeta.decimals, loanMeta.symbol)} (principal + interest)`,
        `- **Accrued Interest**: ${formatTokenAmount(interestData[0], loanMeta.decimals, loanMeta.symbol)}`,
        `- **Time Remaining**: ${timeRemaining > 0n ? formatDuration(timeRemaining) : isOverdue ? "OVERDUE — can be liquidated" : "Expired (in grace period)"}`,
      ];

      if (!healthy) {
        lines.push(
          "\n**Action Required**: This loan can be liquidated. The borrower should repay or add collateral immediately.",
        );
      } else if (distanceBps < 500n) {
        lines.push(
          "\n**Warning**: This loan is close to the liquidation threshold. Consider adding collateral.",
        );
      }

      return lines.join("\n");
    } catch (e) {
      return `Error checking loan health: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "get_price",
    description:
      "Get the oracle price for a collateral/loan token pair from Floe's price oracle (Chainlink primary + Pyth fallback).",
    schema: GetPriceSchema,
  })
  async getPrice(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetPriceSchema>,
  ): Promise<string> {
    try {
      const price = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getPrice",
        args: [args.collateralToken as Address, args.loanToken as Address],
      })) as bigint;

      const [collMeta, loanMeta] = await Promise.all([
        resolveTokenMeta(args.collateralToken as Address, walletProvider),
        resolveTokenMeta(args.loanToken as Address, walletProvider),
      ]);

      return [
        `## Oracle Price\n`,
        `- **Pair**: ${collMeta.symbol} / ${loanMeta.symbol}`,
        `- **Price**: 1 ${collMeta.symbol} = ${formatPrice(price)} ${loanMeta.symbol}`,
        `- **Raw Price (36-decimal scale)**: ${price.toString()}`,
      ].join("\n");
    } catch (e) {
      return `Error fetching price: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "get_accrued_interest",
    description:
      "Get the accrued interest on a Floe loan. Returns the interest amount and time elapsed since loan origination.",
    schema: GetAccruedInterestSchema,
  })
  async getAccruedInterest(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetAccruedInterestSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const [interestData, loan] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getAccruedInterest",
          args: [loanId],
        }) as Promise<[bigint, bigint]>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getLoan",
          args: [loanId],
        }) as Promise<any>,
      ]);

      const loanMeta = await resolveTokenMeta(loan.loanToken, walletProvider);

      return [
        `## Accrued Interest — Loan #${args.loanId}\n`,
        `- **Interest**: ${formatTokenAmount(interestData[0], loanMeta.decimals, loanMeta.symbol)}`,
        `- **Time Elapsed**: ${formatDuration(interestData[1])}`,
        `- **Interest Rate**: ${formatBps(loan.interestRateBps)} annual`,
        `- **Principal**: ${formatTokenAmount(loan.principal, loanMeta.decimals, loanMeta.symbol)}`,
      ].join("\n");
    } catch (e) {
      return `Error fetching accrued interest: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "get_liquidation_quote",
    description:
      "Get a liquidation quote for a Floe loan. Shows the profit/loss breakdown, collateral to receive, and whether the loan is underwater. Useful for evaluating liquidation opportunities.",
    schema: GetLiquidationQuoteSchema,
  })
  async getLiquidationQuote(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetLiquidationQuoteSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const repayAmount = BigInt(args.repayAmount);

      const [quote, loan] = await Promise.all([
        walletProvider.readContract({
          address: this.viewsAddress,
          abi: LENDING_VIEWS_ABI,
          functionName: "getLiquidationQuote",
          args: [loanId, repayAmount],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getLoan",
          args: [loanId],
        }) as Promise<any>,
      ]);

      const [loanMeta, collMeta] = await Promise.all([
        resolveTokenMeta(loan.loanToken, walletProvider),
        resolveTokenMeta(loan.collateralToken, walletProvider),
      ]);

      return [
        `## Liquidation Quote — Loan #${args.loanId}\n`,
        `- **Underwater**: ${quote.isUnderwater ? "Yes — bad debt scenario" : "No — solvent liquidation"}`,
        `- **Requires Full Liquidation**: ${quote.requiresFullLiquidation ? "Yes" : "No"}`,
        `- **Repay Amount**: ${formatTokenAmount(quote.repayAmount, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Interest Amount**: ${formatTokenAmount(quote.interestAmount, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Total Liquidator Pays**: ${formatTokenAmount(quote.totalLiquidatorPays, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Collateral to Receive**: ${formatTokenAmount(quote.collateralToReceive, collMeta.decimals, collMeta.symbol)}`,
        `- **Collateral Value**: ${formatTokenAmount(quote.collateralValueReceived, loanMeta.decimals, loanMeta.symbol)} (in ${loanMeta.symbol} terms)`,
        `- **Lender Receives**: ${formatTokenAmount(quote.lenderReceives, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Protocol Fee**: ${formatTokenAmount(quote.protocolFeeAmount, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Liquidator Profit**: ${formatTokenAmount(quote.liquidatorProfit, loanMeta.decimals, loanMeta.symbol)} (${formatBps(quote.liquidatorProfitBps)})`,
        quote.badDebtAmount > 0n
          ? `- **Bad Debt**: ${formatTokenAmount(quote.badDebtAmount, loanMeta.decimals, loanMeta.symbol)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (e) {
      return `Error fetching liquidation quote: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "get_intent_book",
    description:
      "Look up an on-chain lend or borrow intent by its hash. Returns the full intent details including amounts, rates, duration, and whether it has been filled.",
    schema: GetIntentBookSchema,
  })
  async getIntentBook(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetIntentBookSchema>,
  ): Promise<string> {
    try {
      const hash = args.intentHash as `0x${string}`;

      if (args.intentType === "lend") {
        const intent = (await walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getOnChainLendIntent",
          args: [hash],
        })) as any;

        if (
          intent.lender === "0x0000000000000000000000000000000000000000"
        ) {
          return `No on-chain lend intent found for hash ${hash}.`;
        }

        const market = (await walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getMarket",
          args: [intent.marketId],
        })) as any;
        const loanMeta = await resolveTokenMeta(market.loanToken, walletProvider);

        const remaining = BigInt(intent.amount) - BigInt(intent.filledAmount);

        return [
          `## Lend Intent\n`,
          `- **Hash**: ${hash}`,
          `- **Lender**: ${formatAddress(intent.lender)}`,
          `- **Total Amount**: ${formatTokenAmount(intent.amount, loanMeta.decimals, loanMeta.symbol)}`,
          `- **Filled**: ${formatTokenAmount(intent.filledAmount, loanMeta.decimals, loanMeta.symbol)}`,
          `- **Remaining**: ${formatTokenAmount(remaining, loanMeta.decimals, loanMeta.symbol)}`,
          `- **Min Fill**: ${formatTokenAmount(intent.minFillAmount, loanMeta.decimals, loanMeta.symbol)}`,
          `- **Min Interest Rate**: ${formatBps(intent.minInterestRateBps)}`,
          `- **Max LTV**: ${formatBps(intent.maxLtvBps)}`,
          `- **Duration**: ${formatDuration(intent.minDuration)} — ${formatDuration(intent.maxDuration)}`,
          `- **Partial Fill**: ${intent.allowPartialFill ? "Yes" : "No"}`,
          `- **Expiry**: ${formatTimestamp(intent.expiry)}`,
          `- **Grace Period**: ${formatDuration(intent.gracePeriod)}`,
          `- **Market ID**: ${intent.marketId}`,
        ].join("\n");
      } else {
        const intent = (await walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getOnChainBorrowIntent",
          args: [hash],
        })) as any;

        if (
          intent.borrower === "0x0000000000000000000000000000000000000000"
        ) {
          return `No on-chain borrow intent found for hash ${hash}.`;
        }

        const market = (await walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getMarket",
          args: [intent.marketId],
        })) as any;

        const [loanMeta, collMeta] = await Promise.all([
          resolveTokenMeta(market.loanToken, walletProvider),
          resolveTokenMeta(market.collateralToken, walletProvider),
        ]);

        return [
          `## Borrow Intent\n`,
          `- **Hash**: ${hash}`,
          `- **Borrower**: ${formatAddress(intent.borrower)}`,
          `- **Borrow Amount**: ${formatTokenAmount(intent.borrowAmount, loanMeta.decimals, loanMeta.symbol)}`,
          `- **Collateral**: ${formatTokenAmount(intent.collateralAmount, collMeta.decimals, collMeta.symbol)}`,
          `- **Min Fill**: ${formatTokenAmount(intent.minFillAmount, loanMeta.decimals, loanMeta.symbol)}`,
          `- **Max Interest Rate**: ${formatBps(intent.maxInterestRateBps)}`,
          `- **Min LTV**: ${formatBps(intent.minLtvBps)}`,
          `- **Duration**: ${formatDuration(intent.minDuration)} — ${formatDuration(intent.maxDuration)}`,
          `- **Partial Fill**: ${intent.allowPartialFill ? "Yes" : "No"}`,
          `- **Matcher Commission**: ${formatBps(intent.matcherCommissionBps)}`,
          `- **Expiry**: ${formatTimestamp(intent.expiry)}`,
          `- **Market ID**: ${intent.marketId}`,
        ].join("\n");
      }
    } catch (e) {
      return `Error fetching intent: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // WRITE ACTIONS (9-15)
  // ════════════════════════════════════════════════════════════════════════

  @CreateAction({
    name: "post_lend_intent",
    description:
      "Post a lend intent on Floe. This registers your willingness to lend at a fixed rate and terms. Unlike Aave/Compound where you deposit into a pool, Floe matches your intent to a specific borrower. The loan token is automatically approved before posting.",
    schema: PostLendIntentSchema,
  })
  async postLendIntent(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof PostLendIntentSchema>,
  ): Promise<string> {
    try {
      const userAddress = (await walletProvider.getAddress()) as Address;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiry = now + BigInt(args.expirySeconds);
      const salt = `0x${[...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join("")}` as `0x${string}`;

      const parsedAmount = BigInt(args.amount);

      // Fetch market to resolve loan token for approval
      const market = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getMarket",
        args: [args.marketId as `0x${string}`],
      })) as any;

      // Auto-approve loan token with 1% buffer
      const approvalAmount = (parsedAmount * 101n) / 100n;
      const approvalResult = await this.ensureAllowance(
        walletProvider,
        market.loanToken as Address,
        this.matcherAddress,
        approvalAmount,
      );

      const intentStruct = {
        lender: userAddress,
        onBehalfOf: userAddress,
        amount: parsedAmount,
        minFillAmount: BigInt(args.minFillAmount),
        filledAmount: 0n,
        minInterestRateBps: BigInt(args.minInterestRateBps),
        maxLtvBps: BigInt(args.maxLtvBps),
        minDuration: BigInt(args.minDuration),
        maxDuration: BigInt(args.maxDuration),
        allowPartialFill: args.allowPartialFill,
        validFromTimestamp: 0n,
        expiry,
        marketId: args.marketId as `0x${string}`,
        salt,
        gracePeriod: BigInt(args.gracePeriod),
        minInterestBps: BigInt(args.minInterestBps),
        conditions: [],
        preHooks: [],
        postHooks: [],
      };

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "registerLendIntent",
        args: [intentStruct],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Lend Intent Posted\n`,
        `- **Approval**: ${approvalResult ?? "Allowance sufficient, no approval needed"}`,
        `- **Transaction**: ${txHash}`,
        `- **Amount**: ${args.amount} (raw units)`,
        `- **Min Interest Rate**: ${formatBps(BigInt(args.minInterestRateBps))}`,
        `- **Max LTV**: ${formatBps(BigInt(args.maxLtvBps))}`,
        `- **Duration**: ${formatDuration(BigInt(args.minDuration))} — ${formatDuration(BigInt(args.maxDuration))}`,
        `- **Expiry**: ${formatTimestamp(expiry)}`,
        `- **Partial Fill**: ${args.allowPartialFill ? "Yes" : "No"}`,
      ].join("\n");
    } catch (e) {
      return `Error posting lend intent: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "post_borrow_intent",
    description:
      "Post a borrow intent on Floe. This registers your request to borrow at a fixed rate and terms. The collateral token is automatically approved before posting.",
    schema: PostBorrowIntentSchema,
  })
  async postBorrowIntent(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof PostBorrowIntentSchema>,
  ): Promise<string> {
    try {
      const userAddress = (await walletProvider.getAddress()) as Address;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiry = now + BigInt(args.expirySeconds);
      const salt = `0x${[...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join("")}` as `0x${string}`;

      const parsedCollateral = BigInt(args.collateralAmount);

      // Fetch market to resolve collateral token for approval
      const market = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getMarket",
        args: [args.marketId as `0x${string}`],
      })) as any;

      // Auto-approve collateral token with 1% buffer
      const approvalAmount = (parsedCollateral * 101n) / 100n;
      const approvalResult = await this.ensureAllowance(
        walletProvider,
        market.collateralToken as Address,
        this.matcherAddress,
        approvalAmount,
      );

      const intentStruct = {
        borrower: userAddress,
        onBehalfOf: userAddress,
        borrowAmount: BigInt(args.borrowAmount),
        collateralAmount: parsedCollateral,
        minFillAmount: BigInt(args.minFillAmount),
        maxInterestRateBps: BigInt(args.maxInterestRateBps),
        minLtvBps: BigInt(args.minLtvBps),
        minDuration: BigInt(args.minDuration),
        maxDuration: BigInt(args.maxDuration),
        allowPartialFill: args.allowPartialFill,
        validFromTimestamp: 0n,
        matcherCommissionBps: BigInt(args.matcherCommissionBps),
        expiry,
        marketId: args.marketId as `0x${string}`,
        salt,
        conditions: [],
        preHooks: [],
        postHooks: [],
      };

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "registerBorrowIntent",
        args: [intentStruct],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Borrow Intent Posted\n`,
        `- **Approval**: ${approvalResult ?? "Allowance sufficient, no approval needed"}`,
        `- **Transaction**: ${txHash}`,
        `- **Borrow Amount**: ${args.borrowAmount} (raw units)`,
        `- **Collateral**: ${args.collateralAmount} (raw units)`,
        `- **Max Interest Rate**: ${formatBps(BigInt(args.maxInterestRateBps))}`,
        `- **Min LTV**: ${formatBps(BigInt(args.minLtvBps))}`,
        `- **Duration**: ${formatDuration(BigInt(args.minDuration))} — ${formatDuration(BigInt(args.maxDuration))}`,
        `- **Matcher Commission**: ${formatBps(BigInt(args.matcherCommissionBps))}`,
        `- **Expiry**: ${formatTimestamp(expiry)}`,
      ].join("\n");
    } catch (e) {
      return `Error posting borrow intent: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "match_intents",
    description:
      "Match a lend intent with a borrow intent to create a loan. Both intents must be registered on-chain and belong to the same market. This is typically done by solver bots but can be called by anyone.",
    schema: MatchIntentsSchema,
  })
  async matchIntents(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof MatchIntentsSchema>,
  ): Promise<string> {
    try {
      const lendHash = args.lendIntentHash as `0x${string}`;
      const borrowHash = args.borrowIntentHash as `0x${string}`;
      const marketId = args.marketId as `0x${string}`;

      const [lendIntent, borrowIntent] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getOnChainLendIntent",
          args: [lendHash],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getOnChainBorrowIntent",
          args: [borrowHash],
        }) as Promise<any>,
      ]);

      if (lendIntent.lender === "0x0000000000000000000000000000000000000000") {
        return `Lend intent ${lendHash} not found on-chain.`;
      }
      if (borrowIntent.borrower === "0x0000000000000000000000000000000000000000") {
        return `Borrow intent ${borrowHash} not found on-chain.`;
      }

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "matchLoanIntents",
        args: [
          lendIntent,
          "0x" as `0x${string}`,
          borrowIntent,
          "0x" as `0x${string}`,
          marketId,
          true,
          true,
        ],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Intents Matched\n`,
        `- **Transaction**: ${txHash}`,
        `- **Lend Intent**: ${lendHash}`,
        `- **Borrow Intent**: ${borrowHash}`,
        `- **Market**: ${marketId}`,
        `\nA new loan has been created. Check the transaction receipt for the loan ID.`,
      ].join("\n");
    } catch (e) {
      return `Error matching intents: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "repay_loan",
    description:
      "Repay a Floe loan (fully or partially). The loan token is automatically approved and maxTotalRepayment is calculated with slippage to account for interest accruing between submission and execution.",
    schema: RepayLoanSchema,
  })
  async repayLoan(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RepayLoanSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const repayAmount = BigInt(args.repayAmount);
      const slippageBps = BigInt(args.slippageBps);

      const [loan, interestData] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getLoan",
          args: [loanId],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getAccruedInterest",
          args: [loanId],
        }) as Promise<[bigint, bigint]>,
      ]);

      if (loan.repaid) {
        return `Loan #${args.loanId} is already repaid.`;
      }

      const loanMeta = await resolveTokenMeta(loan.loanToken, walletProvider);

      // Calculate proportional interest for partial repayment
      const proportionalInterest =
        loan.principal > 0n
          ? (interestData[0] * repayAmount) / loan.principal
          : 0n;
      const estimatedTotal = repayAmount + proportionalInterest;
      const maxTotalRepayment =
        estimatedTotal + (estimatedTotal * slippageBps) / BASIS_POINTS;

      // Auto-approve loan token for repayment
      const approvalResult = await this.ensureAllowance(
        walletProvider,
        loan.loanToken as Address,
        this.matcherAddress,
        maxTotalRepayment,
      );

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "repayLoan",
        args: [loanId, repayAmount, maxTotalRepayment],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Loan Repaid\n`,
        `- **Approval**: ${approvalResult ?? "Allowance sufficient, no approval needed"}`,
        `- **Transaction**: ${txHash}`,
        `- **Loan ID**: ${args.loanId}`,
        `- **Repay Amount**: ${formatTokenAmount(repayAmount, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Estimated Interest**: ${formatTokenAmount(proportionalInterest, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Max Total Repayment (with ${formatBps(slippageBps)} slippage)**: ${formatTokenAmount(maxTotalRepayment, loanMeta.decimals, loanMeta.symbol)}`,
      ].join("\n");
    } catch (e) {
      return `Error repaying loan: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "add_collateral",
    description:
      "Add collateral to an existing Floe loan to improve its health factor and reduce liquidation risk. The collateral token is automatically approved.",
    schema: AddCollateralSchema,
  })
  async addCollateral(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof AddCollateralSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const amount = BigInt(args.amount);

      const loan = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getLoan",
        args: [loanId],
      })) as any;

      const collMeta = await resolveTokenMeta(loan.collateralToken, walletProvider);

      // Auto-approve collateral token (exact amount, no buffer needed)
      const approvalResult = await this.ensureAllowance(
        walletProvider,
        loan.collateralToken as Address,
        this.matcherAddress,
        amount,
      );

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "addCollateral",
        args: [loanId, amount],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Collateral Added\n`,
        `- **Approval**: ${approvalResult ?? "Allowance sufficient, no approval needed"}`,
        `- **Transaction**: ${txHash}`,
        `- **Loan ID**: ${args.loanId}`,
        `- **Added**: ${formatTokenAmount(amount, collMeta.decimals, collMeta.symbol)}`,
        `- **Previous Collateral**: ${formatTokenAmount(loan.collateralAmount, collMeta.decimals, collMeta.symbol)}`,
        `- **New Total**: ${formatTokenAmount(loan.collateralAmount + amount, collMeta.decimals, collMeta.symbol)}`,
      ].join("\n");
    } catch (e) {
      return `Error adding collateral: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "withdraw_collateral",
    description:
      "Withdraw excess collateral from a Floe loan. Only the borrower can call this. The resulting LTV must stay below the liquidation threshold minus a 3% safety buffer.",
    schema: WithdrawCollateralSchema,
  })
  async withdrawCollateral(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof WithdrawCollateralSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const amount = BigInt(args.amount);

      const loan = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getLoan",
        args: [loanId],
      })) as any;

      const collMeta = await resolveTokenMeta(loan.collateralToken, walletProvider);

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "withdrawCollateral",
        args: [loanId, amount],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Collateral Withdrawn\n`,
        `- **Transaction**: ${txHash}`,
        `- **Loan ID**: ${args.loanId}`,
        `- **Withdrawn**: ${formatTokenAmount(amount, collMeta.decimals, collMeta.symbol)}`,
        `- **Previous Collateral**: ${formatTokenAmount(loan.collateralAmount, collMeta.decimals, collMeta.symbol)}`,
        `- **Remaining**: ${formatTokenAmount(loan.collateralAmount - amount, collMeta.decimals, collMeta.symbol)}`,
      ].join("\n");
    } catch (e) {
      return `Error withdrawing collateral: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "liquidate_loan",
    description:
      "Liquidate an unhealthy Floe loan. The loan must have currentLTV >= liquidationLTV or be overdue. The liquidator pays debt and receives collateral + liquidation incentive. For underwater loans (collateral < debt), the liquidator gets all collateral at a discount.",
    schema: LiquidateLoanSchema,
  })
  async liquidateLoan(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof LiquidateLoanSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
      const repayAmount = BigInt(args.repayAmount);
      const slippageBps = BigInt(args.slippageBps);

      const [loan, healthy, interestData] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getLoan",
          args: [loanId],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "isHealthy",
          args: [loanId],
        }) as Promise<boolean>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getAccruedInterest",
          args: [loanId],
        }) as Promise<[bigint, bigint]>,
      ]);

      if (loan.repaid) {
        return `Loan #${args.loanId} is already repaid and cannot be liquidated.`;
      }

      if (healthy) {
        return `Warning: Loan #${args.loanId} is currently healthy. Liquidation will revert on-chain. Wait until the loan becomes unhealthy (currentLTV >= liquidationLTV or overdue).`;
      }

      const loanMeta = await resolveTokenMeta(loan.loanToken, walletProvider);

      const proportionalInterest =
        loan.principal > 0n
          ? (interestData[0] * repayAmount) / loan.principal
          : 0n;
      const estimatedTotal = repayAmount + proportionalInterest;
      const maxTotalRepayment =
        estimatedTotal + (estimatedTotal * slippageBps) / BASIS_POINTS;

      // Auto-approve loan token for liquidation
      const approvalResult = await this.ensureAllowance(
        walletProvider,
        loan.loanToken as Address,
        this.matcherAddress,
        maxTotalRepayment,
      );

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "liquidateLoan",
        args: [loanId, repayAmount, maxTotalRepayment],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Loan Liquidated\n`,
        `- **Approval**: ${approvalResult ?? "Allowance sufficient, no approval needed"}`,
        `- **Transaction**: ${txHash}`,
        `- **Loan ID**: ${args.loanId}`,
        `- **Repay Amount**: ${formatTokenAmount(repayAmount, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Max Total Repayment (with ${formatBps(slippageBps)} slippage)**: ${formatTokenAmount(maxTotalRepayment, loanMeta.decimals, loanMeta.symbol)}`,
        `\nCheck the transaction receipt for the collateral received and final profit.`,
      ].join("\n");
    } catch (e) {
      return `Error liquidating loan: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // FLASH LOAN ACTIONS (16-20)
  // ════════════════════════════════════════════════════════════════════════

  @CreateAction({
    name: "get_flash_loan_fee",
    description:
      "Get Floe's flash loan fee. Flash loans let you borrow any token held by the protocol within a single transaction — you must repay principal + fee before the transaction ends or it reverts atomically.",
    schema: GetFlashLoanFeeSchema,
  })
  async getFlashLoanFee(
    walletProvider: EvmWalletProvider,
    _args: z.infer<typeof GetFlashLoanFeeSchema>,
  ): Promise<string> {
    try {
      const feeBps = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getFlashloanFeeBps",
        args: [],
      })) as bigint;

      const feePercent = Number(feeBps) / 100;
      return [
        `## Flash Loan Fee\n`,
        `- **Fee**: ${feeBps.toString()} bps (${feePercent.toFixed(2)}%)`,
        `- **Example**: Borrowing 1,000 USDC costs ${(1000 * feePercent / 100).toFixed(2)} USDC in fees`,
        `\nFlash loans are atomic — if you can't repay principal + fee in the same transaction, the entire transaction reverts.`,
      ].join("\n");
    } catch (e) {
      return `Error fetching flash loan fee: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "estimate_flash_arb_profit",
    description:
      "Estimate the profit of a flash loan arbitrage route before executing. Calls Aerodrome's on-chain QuoterV2 to simulate each swap leg and calculates net profit after the flash loan fee. Returns an estimate — actual execution may differ due to price movement.",
    schema: EstimateFlashArbProfitSchema,
  })
  async estimateFlashArbProfit(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof EstimateFlashArbProfitSchema>,
  ): Promise<string> {
    try {
      const tokenMeta = await resolveTokenMeta(args.token as Address, walletProvider);
      const flashAmount = BigInt(args.amount);

      // Get flash loan fee
      const feeBps = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getFlashloanFeeBps",
        args: [],
      })) as bigint;
      const feeAmount = (flashAmount * feeBps) / BASIS_POINTS;

      // Simulate each leg via Aerodrome QuoterV2
      let currentAmount = flashAmount;
      const legResults: string[] = [];

      for (let i = 0; i < args.legs.length; i++) {
        const leg = args.legs[i];
        const inMeta = await resolveTokenMeta(leg.tokenIn as Address, walletProvider);
        const outMeta = await resolveTokenMeta(leg.tokenOut as Address, walletProvider);

        try {
          const quoteResult = (await walletProvider.readContract({
            address: AERODROME_QUOTER_V2_ADDRESS,
            abi: AERODROME_QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: leg.tokenIn as Address,
                tokenOut: leg.tokenOut as Address,
                amountIn: currentAmount,
                tickSpacing: leg.tickSpacing,
                sqrtPriceLimitX96: 0n,
              },
            ],
          })) as [bigint, bigint, number, bigint];

          const amountOut = quoteResult[0];
          legResults.push(
            `- **Leg ${i + 1}**: ${formatTokenAmount(currentAmount, inMeta.decimals, inMeta.symbol)} → ${formatTokenAmount(amountOut, outMeta.decimals, outMeta.symbol)}`,
          );
          currentAmount = amountOut;
        } catch (e) {
          legResults.push(
            `- **Leg ${i + 1}**: ${inMeta.symbol} → ${outMeta.symbol} — **Quote failed** (pool may not exist for tick spacing ${leg.tickSpacing})`,
          );
          return [
            `## Flash Arb Estimate — Failed\n`,
            ...legResults,
            `\nQuote failed at leg ${i + 1}. Check that the pool exists and has liquidity for the given tick spacing.`,
          ].join("\n");
        }
      }

      const repayment = flashAmount + feeAmount;
      const profitRaw = currentAmount > repayment ? currentAmount - repayment : 0n;
      const isProfitable = currentAmount > repayment;

      return [
        `## Flash Arb Profit Estimate\n`,
        `- **Flash Borrow**: ${formatTokenAmount(flashAmount, tokenMeta.decimals, tokenMeta.symbol)}`,
        `- **Fee**: ${formatTokenAmount(feeAmount, tokenMeta.decimals, tokenMeta.symbol)} (${formatBps(feeBps)})`,
        `- **Repayment**: ${formatTokenAmount(repayment, tokenMeta.decimals, tokenMeta.symbol)}`,
        ``,
        `### Swap Route`,
        ...legResults,
        ``,
        `- **Final Output**: ${formatTokenAmount(currentAmount, tokenMeta.decimals, tokenMeta.symbol)}`,
        `- **Estimated Profit**: ${isProfitable ? formatTokenAmount(profitRaw, tokenMeta.decimals, tokenMeta.symbol) : "UNPROFITABLE — output does not cover repayment"}`,
        `\n**Disclaimer**: This is an estimate based on current on-chain state. Actual profit may differ due to price movement, MEV, or gas costs. Gas costs are not included in this estimate.`,
      ].join("\n");
    } catch (e) {
      return `Error estimating flash arb profit: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "get_flash_arb_balance",
    description:
      "Check the accumulated profit balance in a FlashArbReceiver contract. After successful arbitrages, profit stays in the receiver contract until the owner sweeps it via rescueTokens().",
    schema: GetFlashArbBalanceSchema,
  })
  async getFlashArbBalance(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetFlashArbBalanceSchema>,
  ): Promise<string> {
    try {
      const receiverAddress = this.resolveReceiverAddress(args.receiverAddress);
      const tokenMeta = await resolveTokenMeta(args.token as Address, walletProvider);

      const balance = (await walletProvider.readContract({
        address: args.token as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [receiverAddress],
      })) as bigint;

      // Verify it's a FlashArbReceiver by reading the owner
      let owner: string;
      try {
        owner = (await walletProvider.readContract({
          address: receiverAddress,
          abi: FLASH_ARB_RECEIVER_ABI,
          functionName: "owner",
          args: [],
        })) as string;
      } catch {
        return `Error: ${receiverAddress} does not appear to be a FlashArbReceiver contract (owner() call failed).`;
      }

      return [
        `## FlashArbReceiver Balance\n`,
        `- **Receiver**: ${formatAddress(receiverAddress)}`,
        `- **Owner**: ${formatAddress(owner)}`,
        `- **${tokenMeta.symbol} Balance**: ${formatTokenAmount(balance, tokenMeta.decimals, tokenMeta.symbol)}`,
        balance > 0n
          ? `\nProfit is available to sweep. The owner can call rescueTokens() to withdraw.`
          : `\nNo accumulated profit for this token.`,
      ].join("\n");
    } catch (e) {
      return `Error checking flash arb balance: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "flash_loan",
    description:
      "Execute a raw flash loan from Floe. CRITICAL: The connected wallet (msg.sender) IS the flash loan receiver — the protocol sends tokens to msg.sender and calls receiveFlashLoan() on msg.sender. This means the connected wallet MUST be a smart contract implementing IFlashloanReceiver. EOA wallets will cause a revert. For arbitrage with an EOA wallet, use the flash_arb action instead.",
    schema: FlashLoanSchema,
  })
  async flashLoan(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof FlashLoanSchema>,
  ): Promise<string> {
    try {
      const tokenMeta = await resolveTokenMeta(args.token as Address, walletProvider);
      const amount = BigInt(args.amount);
      const callerAddress = await walletProvider.getAddress();

      const feeBps = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getFlashloanFeeBps",
        args: [],
      })) as bigint;
      const feeAmount = (amount * feeBps) / BASIS_POINTS;

      const data = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "flashLoan",
        args: [
          args.token as Address,
          amount,
          args.callbackData as `0x${string}`,
        ],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        `## Flash Loan Submitted\n`,
        `- **Transaction**: ${txHash}`,
        `- **Token**: ${formatTokenAmount(amount, tokenMeta.decimals, tokenMeta.symbol)}`,
        `- **Fee**: ${formatTokenAmount(feeAmount, tokenMeta.decimals, tokenMeta.symbol)} (${formatBps(feeBps)})`,
        `- **Receiver (msg.sender)**: ${formatAddress(callerAddress)}`,
        `\nThe protocol will transfer tokens to the caller, invoke receiveFlashLoan(), then pull repayment. Check the transaction receipt for details.`,
      ].join("\n");
    } catch (e) {
      return `Error executing flash loan: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "flash_arb",
    description:
      "Execute a flash loan arbitrage via a deployed FlashArbReceiver contract. Borrows tokens from Floe, executes a series of Aerodrome Slipstream swaps, repays the loan + fee, and retains profit in the receiver contract. The connected wallet must be the owner of the FlashArbReceiver. Use estimate_flash_arb_profit first to check profitability.",
    schema: FlashArbSchema,
  })
  async flashArb(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof FlashArbSchema>,
  ): Promise<string> {
    try {
      const receiverAddress = this.resolveReceiverAddress(args.receiverAddress);
      const tokenMeta = await resolveTokenMeta(args.token as Address, walletProvider);
      const amount = BigInt(args.amount);
      const minProfit = BigInt(args.minProfit);
      const deadline = args.deadline
        ? BigInt(args.deadline)
        : BigInt(Math.floor(Date.now() / 1000) + 300); // 5 minutes

      // Build ArbLeg structs
      const legs = args.legs.map((leg) => ({
        isMultiHop: leg.isMultiHop,
        tickSpacing: leg.tickSpacing,
        tokenIn: leg.tokenIn as Address,
        tokenOut: leg.tokenOut as Address,
        amountIn: BigInt(leg.amountIn),
        minAmountOut: BigInt(leg.minAmountOut),
        path: (leg.path || "0x") as `0x${string}`,
      }));

      // ABI-encode ArbParams struct. The contract does abi.decode(params, (ArbParams))
      // which is equivalent to decoding (ArbLeg[], uint256, uint256) as flat params.
      const arbParamsEncoded = encodeAbiParameters(
        parseAbiParameters([
          "(bool isMultiHop, int24 tickSpacing, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes path)[] legs",
          "uint256 minProfit",
          "uint256 deadline",
        ]),
        [
          legs.map((l) => ({
            isMultiHop: l.isMultiHop,
            tickSpacing: l.tickSpacing,
            tokenIn: l.tokenIn,
            tokenOut: l.tokenOut,
            amountIn: l.amountIn,
            minAmountOut: l.minAmountOut,
            path: l.path,
          })),
          minProfit,
          deadline,
        ],
      );

      // Call executeArb on the FlashArbReceiver
      const data = encodeFunctionData({
        abi: FLASH_ARB_RECEIVER_ABI,
        functionName: "executeArb",
        args: [
          args.token as Address,
          amount,
          arbParamsEncoded,
        ],
      });

      const txHash = await walletProvider.sendTransaction({
        to: receiverAddress,
        data,
      });

      const feeBps = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getFlashloanFeeBps",
        args: [],
      })) as bigint;
      const feeAmount = (amount * feeBps) / BASIS_POINTS;

      const legSummary = legs.map((l, i) => {
        const inSymbol = formatAddress(l.tokenIn);
        const outSymbol = formatAddress(l.tokenOut);
        return `  ${i + 1}. ${inSymbol} → ${outSymbol}${l.isMultiHop ? " (multi-hop)" : ` (tick ${l.tickSpacing})`}`;
      });

      return [
        `## Flash Arb Executed\n`,
        `- **Transaction**: ${txHash}`,
        `- **Flash Borrow**: ${formatTokenAmount(amount, tokenMeta.decimals, tokenMeta.symbol)}`,
        `- **Fee**: ${formatTokenAmount(feeAmount, tokenMeta.decimals, tokenMeta.symbol)} (${formatBps(feeBps)})`,
        `- **Min Profit**: ${formatTokenAmount(minProfit, tokenMeta.decimals, tokenMeta.symbol)}`,
        `- **Receiver**: ${formatAddress(receiverAddress)}`,
        `- **Deadline**: ${new Date(Number(deadline) * 1000).toUTCString()}`,
        ``,
        `### Route (${legs.length} legs)`,
        ...legSummary,
        `\nProfit remains in the receiver contract. Use get_flash_arb_balance to check, then rescueTokens() to withdraw.`,
      ].join("\n");
    } catch (e) {
      return `Error executing flash arb: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // DEPLOY / VERIFY / READINESS ACTIONS (21-23)
  // ════════════════════════════════════════════════════════════════════════

  @CreateAction({
    name: "deploy_flash_arb_receiver",
    description:
      "Deploy a new FlashArbReceiver contract. Runs pre-flight checks (flash loan fee, WETH liquidity, circuit breaker, SwapRouter) and aborts if any blocker is found. The connected wallet becomes the owner automatically. The deployed address is stored in session state so subsequent flash_arb / get_flash_arb_balance calls can use it without an explicit address.",
    schema: DeployFlashArbReceiverSchema,
  })
  async deployFlashArbReceiver(
    walletProvider: EvmWalletProvider,
    _args: z.infer<typeof DeployFlashArbReceiverSchema>,
  ): Promise<string> {
    try {
      const connectedWallet = (await walletProvider.getAddress()) as Address;
      const blockers: string[] = [];
      const checks: string[] = [];

      // Pre-flight check 1: Flash loan fee
      try {
        const feeBps = (await walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getFlashloanFeeBps",
          args: [],
        })) as bigint;
        checks.push(`- Flash loan fee: ${formatBps(feeBps)} OK`);
      } catch (e) {
        blockers.push(`- Flash loan fee: FAILED to read (${e instanceof Error ? e.message : String(e)})`);
      }

      // Pre-flight check 2: WETH liquidity in the matcher (pool)
      try {
        const wethBalance = (await walletProvider.readContract({
          address: BASE_WETH_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [this.matcherAddress],
        })) as bigint;
        const wethMeta = await resolveTokenMeta(BASE_WETH_ADDRESS, walletProvider);
        if (wethBalance === 0n) {
          blockers.push(`- WETH liquidity in matcher: 0 — no flash loans available`);
        } else {
          checks.push(`- WETH liquidity in matcher: ${formatTokenAmount(wethBalance, wethMeta.decimals, wethMeta.symbol)} OK`);
        }
      } catch (e) {
        blockers.push(`- WETH liquidity check: FAILED (${e instanceof Error ? e.message : String(e)})`);
      }

      // Pre-flight check 3: Circuit breaker
      try {
        const isActive = (await walletProvider.readContract({
          address: BASE_MAINNET_ORACLE,
          abi: PRICE_ORACLE_ABI,
          functionName: "isCircuitBreakerActive",
          args: [],
        })) as boolean;
        if (isActive) {
          blockers.push(`- Circuit breaker: ACTIVE — oracle is paused`);
        } else {
          checks.push(`- Circuit breaker: inactive OK`);
        }
      } catch (e) {
        checks.push(`- Circuit breaker: could not read (non-blocking, ${e instanceof Error ? e.message : String(e)})`);
      }

      // Pre-flight check 4: SwapRouter has code
      try {
        await walletProvider.readContract({
          address: AERODROME_SWAP_ROUTER_ADDRESS,
          abi: [{ type: "function", name: "factory", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" }] as const,
          functionName: "factory",
          args: [],
        });
        checks.push(`- SwapRouter (${formatAddress(AERODROME_SWAP_ROUTER_ADDRESS)}): has code OK`);
      } catch {
        blockers.push(`- SwapRouter (${formatAddress(AERODROME_SWAP_ROUTER_ADDRESS)}): factory() call failed — may not be deployed`);
      }

      if (blockers.length > 0) {
        return [
          `## Deploy FlashArbReceiver — ABORTED\n`,
          `### Blockers`,
          ...blockers,
          ``,
          `### Passed`,
          ...checks,
          `\nFix the blockers above before deploying.`,
        ].join("\n");
      }

      // Deploy
      const deployData = encodeDeployData({
        abi: FLASH_ARB_RECEIVER_CONSTRUCTOR_ABI,
        bytecode: FLASH_ARB_RECEIVER_BYTECODE,
        args: [this.matcherAddress, AERODROME_SWAP_ROUTER_ADDRESS, connectedWallet],
      });

      const txHash = await walletProvider.sendTransaction({
        to: undefined as unknown as Address,
        data: deployData,
      });

      // Wait for receipt to get contractAddress
      const receipt = await walletProvider.waitForTransactionReceipt(txHash);
      const contractAddress = (receipt as any).contractAddress as Address;

      if (!contractAddress) {
        return `## Deploy FlashArbReceiver — FAILED\n\nTransaction ${txHash} was mined but no contract address in receipt. The deployment may have reverted.`;
      }

      this.deployedReceiverAddress = contractAddress;

      return [
        `## FlashArbReceiver Deployed\n`,
        `### Pre-flight checks`,
        ...checks,
        ``,
        `### Deployment`,
        `- **Transaction**: ${txHash}`,
        `- **Contract Address**: ${contractAddress}`,
        `- **Owner**: ${formatAddress(connectedWallet)}`,
        `- **Lending Protocol**: ${formatAddress(this.matcherAddress)}`,
        `- **Swap Router**: ${formatAddress(AERODROME_SWAP_ROUTER_ADDRESS)}`,
        `\nAddress stored in session — subsequent flash_arb and get_flash_arb_balance calls will use it automatically.`,
      ].join("\n");
    } catch (e) {
      return `Error deploying FlashArbReceiver: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "check_flash_arb_readiness",
    description:
      "Check whether the environment is ready for flash loan arbitrage. Verifies flash loan fee, WETH liquidity in the matcher, oracle circuit breaker status, and SwapRouter availability. If a receiverAddress is provided (or one was deployed in this session), also validates the receiver's immutables and owner.",
    schema: CheckFlashArbReadinessSchema,
  })
  async checkFlashArbReadiness(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CheckFlashArbReadinessSchema>,
  ): Promise<string> {
    try {
      const checks: string[] = [];
      const connectedWallet = (await walletProvider.getAddress()) as Address;

      // Check 1: Flash loan fee
      try {
        const feeBps = (await walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getFlashloanFeeBps",
          args: [],
        })) as bigint;
        checks.push(`- Flash loan fee: ${formatBps(feeBps)} OK`);
      } catch (e) {
        checks.push(`- Flash loan fee: FAILED (${e instanceof Error ? e.message : String(e)})`);
      }

      // Check 2: WETH liquidity
      try {
        const wethBalance = (await walletProvider.readContract({
          address: BASE_WETH_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [this.matcherAddress],
        })) as bigint;
        const wethMeta = await resolveTokenMeta(BASE_WETH_ADDRESS, walletProvider);
        checks.push(
          wethBalance === 0n
            ? `- WETH liquidity in matcher: 0 WARNING`
            : `- WETH liquidity in matcher: ${formatTokenAmount(wethBalance, wethMeta.decimals, wethMeta.symbol)} OK`,
        );
      } catch (e) {
        checks.push(`- WETH liquidity check: FAILED (${e instanceof Error ? e.message : String(e)})`);
      }

      // Check 3: Circuit breaker
      try {
        const isActive = (await walletProvider.readContract({
          address: BASE_MAINNET_ORACLE,
          abi: PRICE_ORACLE_ABI,
          functionName: "isCircuitBreakerActive",
          args: [],
        })) as boolean;
        checks.push(isActive ? `- Circuit breaker: ACTIVE WARNING` : `- Circuit breaker: inactive OK`);
      } catch (e) {
        checks.push(`- Circuit breaker: could not read (${e instanceof Error ? e.message : String(e)})`);
      }

      // Check 4: SwapRouter
      try {
        await walletProvider.readContract({
          address: AERODROME_SWAP_ROUTER_ADDRESS,
          abi: [{ type: "function", name: "factory", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" }] as const,
          functionName: "factory",
          args: [],
        });
        checks.push(`- SwapRouter: ${formatAddress(AERODROME_SWAP_ROUTER_ADDRESS)} OK`);
      } catch {
        checks.push(`- SwapRouter: ${formatAddress(AERODROME_SWAP_ROUTER_ADDRESS)} FAILED — factory() call failed`);
      }

      // Optional receiver checks
      const receiverAddr = args.receiverAddress ?? this.deployedReceiverAddress;
      if (receiverAddr) {
        checks.push(`\n### Receiver Verification (${formatAddress(receiverAddr as string)})`);
        try {
          const [owner, lendingProtocol, swapRouter] = await Promise.all([
            walletProvider.readContract({
              address: receiverAddr as Address,
              abi: FLASH_ARB_RECEIVER_ABI,
              functionName: "owner",
              args: [],
            }) as Promise<string>,
            walletProvider.readContract({
              address: receiverAddr as Address,
              abi: FLASH_ARB_RECEIVER_ABI,
              functionName: "LENDING_PROTOCOL",
              args: [],
            }) as Promise<string>,
            walletProvider.readContract({
              address: receiverAddr as Address,
              abi: FLASH_ARB_RECEIVER_ABI,
              functionName: "SWAP_ROUTER",
              args: [],
            }) as Promise<string>,
          ]);

          const ownerMatch = owner.toLowerCase() === connectedWallet.toLowerCase();
          const protocolMatch = lendingProtocol.toLowerCase() === this.matcherAddress.toLowerCase();
          const routerMatch = swapRouter.toLowerCase() === AERODROME_SWAP_ROUTER_ADDRESS.toLowerCase();

          checks.push(`- Owner: ${formatAddress(owner)} ${ownerMatch ? "MATCHES wallet OK" : "MISMATCH — expected " + formatAddress(connectedWallet)}`);
          checks.push(`- LENDING_PROTOCOL: ${formatAddress(lendingProtocol)} ${protocolMatch ? "OK" : "MISMATCH — expected " + formatAddress(this.matcherAddress)}`);
          checks.push(`- SWAP_ROUTER: ${formatAddress(swapRouter)} ${routerMatch ? "OK" : "MISMATCH — expected " + formatAddress(AERODROME_SWAP_ROUTER_ADDRESS)}`);
        } catch (e) {
          checks.push(`- Receiver read failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return [
        `## Flash Arb Readiness Check\n`,
        `**Wallet**: ${formatAddress(connectedWallet)}`,
        `**Matcher**: ${formatAddress(this.matcherAddress)}`,
        ``,
        `### Environment`,
        ...checks,
      ].join("\n");
    } catch (e) {
      return `Error checking readiness: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "verify_flash_arb_receiver",
    description:
      "Verify a deployed FlashArbReceiver contract. Reads owner(), LENDING_PROTOCOL(), and SWAP_ROUTER() and validates each matches expected values. Use this to confirm a receiver is correctly configured before executing arbitrage.",
    schema: VerifyFlashArbReceiverSchema,
  })
  async verifyFlashArbReceiver(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof VerifyFlashArbReceiverSchema>,
  ): Promise<string> {
    try {
      const receiverAddress = this.resolveReceiverAddress(args.receiverAddress);
      const connectedWallet = (await walletProvider.getAddress()) as Address;
      const issues: string[] = [];

      const [owner, lendingProtocol, swapRouter] = await Promise.all([
        walletProvider.readContract({
          address: receiverAddress,
          abi: FLASH_ARB_RECEIVER_ABI,
          functionName: "owner",
          args: [],
        }) as Promise<string>,
        walletProvider.readContract({
          address: receiverAddress,
          abi: FLASH_ARB_RECEIVER_ABI,
          functionName: "LENDING_PROTOCOL",
          args: [],
        }) as Promise<string>,
        walletProvider.readContract({
          address: receiverAddress,
          abi: FLASH_ARB_RECEIVER_ABI,
          functionName: "SWAP_ROUTER",
          args: [],
        }) as Promise<string>,
      ]);

      const ownerMatch = owner.toLowerCase() === connectedWallet.toLowerCase();
      const protocolMatch = lendingProtocol.toLowerCase() === this.matcherAddress.toLowerCase();
      const routerMatch = swapRouter.toLowerCase() === AERODROME_SWAP_ROUTER_ADDRESS.toLowerCase();

      if (!ownerMatch) issues.push(`Owner mismatch: ${formatAddress(owner)} (expected ${formatAddress(connectedWallet)})`);
      if (!protocolMatch) issues.push(`LENDING_PROTOCOL mismatch: ${formatAddress(lendingProtocol)} (expected ${formatAddress(this.matcherAddress)})`);
      if (!routerMatch) issues.push(`SWAP_ROUTER mismatch: ${formatAddress(swapRouter)} (expected ${formatAddress(AERODROME_SWAP_ROUTER_ADDRESS)})`);

      const lines = [
        `## FlashArbReceiver Verification — ${formatAddress(receiverAddress)}\n`,
        `- **owner()**: ${formatAddress(owner)} ${ownerMatch ? "PASSED" : "FAILED"}`,
        `- **LENDING_PROTOCOL()**: ${formatAddress(lendingProtocol)} ${protocolMatch ? "PASSED" : "FAILED"}`,
        `- **SWAP_ROUTER()**: ${formatAddress(swapRouter)} ${routerMatch ? "PASSED" : "FAILED"}`,
      ];

      if (issues.length > 0) {
        lines.push(`\n### ISSUES FOUND`);
        lines.push(...issues.map((i) => `- ${i}`));
      } else {
        lines.push(`\nAll checks PASSED. This receiver is correctly configured for use with the connected wallet.`);
      }

      return lines.join("\n");
    } catch (e) {
      return `Error verifying FlashArbReceiver: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
