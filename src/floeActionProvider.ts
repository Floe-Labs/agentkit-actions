import {
  ActionProvider,
  CreateAction,
  type EvmWalletProvider,
  type Network,
} from "@coinbase/agentkit";
import { encodeFunctionData } from "viem";
import { z } from "zod";

import {
  LENDING_MATCHER_ABI,
  LENDING_VIEWS_ABI,
  ERC20_ABI,
  BASE_MAINNET_MATCHER,
  BASE_MAINNET_VIEWS,
  ORACLE_PRICE_SCALE,
  BASIS_POINTS,
} from "./constants.js";
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
} from "./schemas.js";
import type { FloeConfig, Address } from "./types.js";
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

  constructor(config?: Partial<FloeConfig>) {
    super("floe", []);
    this.matcherAddress = config?.lendingIntentMatcherAddress ?? BASE_MAINNET_MATCHER;
    this.viewsAddress = config?.lendingViewsAddress ?? BASE_MAINNET_VIEWS;
    this.knownMarketIds = config?.knownMarketIds ?? [];
  }

  supportsNetwork = (network: Network): boolean => {
    return network.chainId === "8453" || network.chainId === "84532";
  };

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
      const ids = args.marketIds ?? this.knownMarketIds;
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
      "Post a lend intent on Floe. This registers your willingness to lend at a fixed rate and terms. Unlike Aave/Compound where you deposit into a pool, Floe matches your intent to a specific borrower. You need to approve the loan token to the matcher contract before the intent can be matched.",
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

      const intentStruct = {
        lender: userAddress,
        onBehalfOf: userAddress,
        amount: BigInt(args.amount),
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
        `- **Transaction**: ${txHash}`,
        `- **Amount**: ${args.amount} (raw units)`,
        `- **Min Interest Rate**: ${formatBps(BigInt(args.minInterestRateBps))}`,
        `- **Max LTV**: ${formatBps(BigInt(args.maxLtvBps))}`,
        `- **Duration**: ${formatDuration(BigInt(args.minDuration))} — ${formatDuration(BigInt(args.maxDuration))}`,
        `- **Expiry**: ${formatTimestamp(expiry)}`,
        `- **Partial Fill**: ${args.allowPartialFill ? "Yes" : "No"}`,
        `\n**Important**: You must approve the loan token to ${formatAddress(this.matcherAddress)} before this intent can be matched.`,
      ].join("\n");
    } catch (e) {
      return `Error posting lend intent: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "post_borrow_intent",
    description:
      "Post a borrow intent on Floe. This registers your request to borrow at a fixed rate and terms. You must approve the collateral token to the matcher contract before this intent can be matched.",
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

      const intentStruct = {
        borrower: userAddress,
        onBehalfOf: userAddress,
        borrowAmount: BigInt(args.borrowAmount),
        collateralAmount: BigInt(args.collateralAmount),
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
        `- **Transaction**: ${txHash}`,
        `- **Borrow Amount**: ${args.borrowAmount} (raw units)`,
        `- **Collateral**: ${args.collateralAmount} (raw units)`,
        `- **Max Interest Rate**: ${formatBps(BigInt(args.maxInterestRateBps))}`,
        `- **Min LTV**: ${formatBps(BigInt(args.minLtvBps))}`,
        `- **Duration**: ${formatDuration(BigInt(args.minDuration))} — ${formatDuration(BigInt(args.maxDuration))}`,
        `- **Matcher Commission**: ${formatBps(BigInt(args.matcherCommissionBps))}`,
        `- **Expiry**: ${formatTimestamp(expiry)}`,
        `\n**Important**: You must approve the collateral token to ${formatAddress(this.matcherAddress)} before this intent can be matched.`,
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
      "Repay a Floe loan (fully or partially). You must approve the loan token to the matcher contract before calling this. The maxTotalRepayment is calculated automatically with slippage to account for interest accruing between submission and execution.",
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
      "Add collateral to an existing Floe loan to improve its health factor and reduce liquidation risk. You must approve the collateral token to the matcher contract first.",
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
}
