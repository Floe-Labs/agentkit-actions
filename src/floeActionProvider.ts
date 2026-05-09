import {
  ActionProvider,
  CreateAction,
  EvmWalletProvider,
  Network,
} from "@coinbase/agentkit";
import { encodeFunctionData, encodeDeployData, createPublicClient, http, parseEventLogs } from "viem";
import { base } from "viem/chains";
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
  LOG_LENDER_OFFER_POSTED_EVENT,
  LOG_INTENTS_MATCHED_DETAILED_EVENT,
  MATCHER_DEPLOYMENT_BLOCK,
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
  RequestCreditSchema,
  ManualMatchCreditSchema,
  CheckCreditStatusSchema,
  RepayCreditSchema,
  RenewCreditLineSchema,
  InstantBorrowSchema,
  RenewCreditLineV2Schema,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publicClient: any | null = null;
  private rpcUrl?: string;

  constructor(config?: Partial<FloeConfig>) {
    super("floe", []);
    this.matcherAddress = config?.lendingIntentMatcherAddress ?? BASE_MAINNET_MATCHER;
    this.viewsAddress = config?.lendingViewsAddress ?? BASE_MAINNET_VIEWS;
    this.knownMarketIds = config?.knownMarketIds ?? [];
    this.rpcUrl = config?.rpcUrl;
    if (config?.rpcUrl) {
      this.publicClient = createPublicClient({
        chain: base,
        transport: http(config.rpcUrl),
      });
    }
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

    const txRequest = {
      to: tokenAddress,
      data,
    };

    await this.requireNishvaultPreSendReceipt(walletProvider, txRequest);

    const txHash = await walletProvider.sendTransaction(txRequest);

    const meta = await resolveTokenMeta(tokenAddress, walletProvider);
    return `Approved ${formatTokenAmount(requiredAmount, meta.decimals, meta.symbol)} to ${formatAddress(spenderAddress)} (tx: ${txHash})`;
  }

  private async getChainIdNumber(walletProvider: EvmWalletProvider): Promise<number | null> {
    try {
      const net = (walletProvider as unknown as {
        getNetwork?: () =>
          | Promise<{ chainId?: number | string | bigint }>
          | { chainId?: number | string | bigint };
      }).getNetwork?.();
      const resolved = net && typeof (net as Promise<unknown>).then === "function" ? await net : net;
      const id = (resolved as { chainId?: number | string | bigint } | undefined)?.chainId;
      if (typeof id === "bigint") return Number(id);
      if (typeof id === "number") return id;
      if (typeof id === "string") {
        const parsed = Number(id);
        if (!Number.isNaN(parsed)) return parsed;
      }
    } catch {
      // Fail safe when the opt-in guard is enabled; do not preflight an unknown chain as mainnet.
    }
    return null;
  }

  private async requireNishvaultPreSendReceipt(walletProvider: EvmWalletProvider, tx: {
    to: Address;
    data?: `0x${string}`;
    value?: bigint;
  }): Promise<void> {
    if (process.env.NISHVAULT_PRE_SEND_GUARD !== "1") return;

    const chainId = await this.getChainIdNumber(walletProvider);

    if (chainId === null) {
      throw new Error(
        "NISHVAULT_PRE_SEND_GUARD=1 could not determine the connected chainId; refusing to preflight or broadcast.",
      );
    }

    if (chainId !== 8453) {
      throw new Error(
        `Nishvault pre-send guard currently supports Base mainnet chainId 8453 only; connected chainId is ${chainId}.`,
      );
    }

    const packageName = "nishvault-preflight-buy";
    type NishvaultPreflight = (input: {
      sellerUrl: string;
      transaction: {
        to: Address;
        data: `0x${string}`;
        value: `0x${string}`;
        chainId: number;
      };
    }) => Promise<{ ok?: boolean; status?: number }>;

    let preflightTransactionRequest: NishvaultPreflight;

    try {
      const mod = (await import(packageName)) as { preflightTransactionRequest?: unknown };
      preflightTransactionRequest = mod.preflightTransactionRequest as NishvaultPreflight;
    } catch (error) {
      throw new Error(
        "NISHVAULT_PRE_SEND_GUARD=1 requires `npm install nishvault-preflight-buy` before broadcasting transactions.",
      );
    }

    if (typeof preflightTransactionRequest !== "function") {
      throw new Error(
        "NISHVAULT_PRE_SEND_GUARD=1 requires `nishvault-preflight-buy` to export preflightTransactionRequest.",
      );
    }

    const timeoutMs = this.getNishvaultPreSendGuardTimeoutMs();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        preflightTransactionRequest({
          sellerUrl: process.env.NISHVAULT_SELLER_URL || "https://api.nishvault.com",
          transaction: {
            to: tx.to,
            data: tx.data || "0x",
            value: `0x${(tx.value || 0n).toString(16)}`,
            chainId,
          },
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`Nishvault pre-send guard timed out after ${timeoutMs}ms before broadcast.`)),
            timeoutMs,
          );
        }),
      ]);

      if (!receipt?.ok) {
        throw new Error("Nishvault PRE_SEND_PROOF_RECEIPT missing before broadcast");
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private getNishvaultPreSendGuardTimeoutMs(): number {
    const raw = process.env.NISHVAULT_PRE_SEND_GUARD_TIMEOUT_MS;
    if (!raw) return 10_000;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("NISHVAULT_PRE_SEND_GUARD_TIMEOUT_MS must be a positive number of milliseconds.");
    }

    return parsed;
  }

  private async scanAvailableLendIntents(
    walletProvider: EvmWalletProvider,
    marketId: `0x${string}`,
  ): Promise<any[]> {
    if (!this.publicClient) {
      throw new Error(
        "RPC URL not configured. Pass rpcUrl in FloeConfig to browse available credit offers.",
      );
    }

    const logs = await this.publicClient.getContractEvents({
      address: this.matcherAddress,
      abi: LOG_LENDER_OFFER_POSTED_EVENT,
      eventName: "LogLenderOfferPosted",
      args: { marketId },
      fromBlock: MATCHER_DEPLOYMENT_BLOCK,
      toBlock: "latest" as const,
    });

    const hashSet = new Set<`0x${string}`>();
    for (const l of logs) {
      hashSet.add((l as any).args.offerHash as `0x${string}`);
    }
    const uniqueHashes = [...hashSet];
    if (uniqueHashes.length === 0) return [];

    const now = BigInt(Math.floor(Date.now() / 1000));
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    const intents = await Promise.all(
      uniqueHashes.map(async (hash) => {
        const intent = (await walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getOnChainLendIntent",
          args: [hash],
        })) as any;
        return { hash, intent };
      }),
    );

    return intents.filter(
      ({ intent }) =>
        intent.lender !== ZERO_ADDRESS &&
        intent.filledAmount < intent.amount &&
        intent.expiry > now &&
        BigInt(intent.validFromTimestamp ?? 0n) <= now,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractLoanIdFromReceipt(receipt: any): string | null {
    try {
      const parsed = parseEventLogs({
        abi: LOG_INTENTS_MATCHED_DETAILED_EVENT,
        logs: receipt.logs ?? [],
      });
      if (parsed.length > 0) {
        return (parsed[0].args as any).loanId.toString();
      }
    } catch {
      // Fall through
    }
    return null;
  }

  /**
   * Preflight a borrow request against a lend intent.
   * Returns null if compatible, or a human-readable error string explaining why not.
   * Used by both manualMatchCredit (single-intent path) and instantBorrow (auto-select path).
   */
  private checkLendIntentCompatibility(
    lendIntent: any,
    params: {
      marketId: `0x${string}`;
      borrowAmount: bigint;
      maxInterestRateBps: bigint;
      minLtvBps: bigint;
      duration: bigint;
    },
  ): string | null {
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    if ((lendIntent.lender as string).toLowerCase() === ZERO_ADDRESS) {
      return "Lend intent not found on-chain. It may have been revoked or already fully matched.";
    }

    // Market must match
    const intentMarket = (lendIntent.marketId as string).toLowerCase();
    if (intentMarket !== params.marketId.toLowerCase()) {
      return `Lend intent belongs to market ${intentMarket}, but borrow requested market ${params.marketId}.`;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(lendIntent.validFromTimestamp ?? 0n) > now) {
      return "Lend intent is not yet valid (validFromTimestamp in the future).";
    }
    if (BigInt(lendIntent.expiry) <= now) {
      return "Lend intent has expired.";
    }

    const remaining = (lendIntent.amount as bigint) - (lendIntent.filledAmount as bigint);
    if (remaining < params.borrowAmount) {
      return `Lend intent only has ${remaining} remaining (raw units), but you requested ${params.borrowAmount}.`;
    }

    // Exact-fill constraint: borrow struct always posts minFillAmount == borrowAmount
    // with allowPartialFill=false, so a lend intent that disallows partial fills
    // can only accept a borrow EQUAL to its remaining amount.
    const allowPartialFill = Boolean(lendIntent.allowPartialFill);
    if (!allowPartialFill && params.borrowAmount !== remaining) {
      return `Lend intent does not allow partial fills; requested ${params.borrowAmount} but remaining is ${remaining} (must match exactly).`;
    }
    const minFillAmount = BigInt(lendIntent.minFillAmount ?? 0n);
    if (params.borrowAmount < minFillAmount) {
      return `Requested borrow amount (${params.borrowAmount}) is below the lend intent's minimum fill (${minFillAmount}).`;
    }

    if ((lendIntent.minInterestRateBps as bigint) > params.maxInterestRateBps) {
      return `Requested maxInterestRateBps (${params.maxInterestRateBps}) is below the lend intent's minimum rate (${lendIntent.minInterestRateBps}).`;
    }
    // Protocol requires 800bps gap between borrower minLtvBps and lender maxLtvBps
    const requiredMaxLtvBps = params.minLtvBps + 800n;
    if ((lendIntent.maxLtvBps as bigint) < requiredMaxLtvBps) {
      return `Requested minLtvBps (${params.minLtvBps}) requires lender maxLtvBps >= ${requiredMaxLtvBps} (800bps buffer), but the lend intent only allows ${lendIntent.maxLtvBps}.`;
    }
    if (params.duration < (lendIntent.minDuration as bigint) || params.duration > (lendIntent.maxDuration as bigint)) {
      return `Requested duration (${params.duration}s) is outside the lend intent's allowed range [${lendIntent.minDuration}, ${lendIntent.maxDuration}]s.`;
    }

    return null;
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

      const onBehalfOf = (args.onBehalfOf ?? userAddress) as Address;
      const intentStruct = {
        borrower: userAddress,
        onBehalfOf,
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
        onBehalfOf !== userAddress ? `- **USDC Sent To**: ${formatAddress(onBehalfOf)}` : "",
      ].filter(Boolean).join("\n");
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

  // ════════════════════════════════════════════════════════════════════════
  // CREDIT FACILITY ACTIONS (24-28)
  // ════════════════════════════════════════════════════════════════════════

  @CreateAction({
    name: "request_credit",
    description:
      "Browse available credit offers for a market. Scans on-chain events and reads intent data directly from the contract. Shows how much capital is available, at what rates, and for how long. Use this to find a lend intent to match against with manual_match_credit.",
    schema: RequestCreditSchema,
  })
  async requestCredit(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RequestCreditSchema>,
  ): Promise<string> {
    try {
      const marketId = args.marketId as `0x${string}`;

      const [availableIntents, market] = await Promise.all([
        this.scanAvailableLendIntents(walletProvider, marketId),
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getMarket",
          args: [marketId],
        }) as Promise<any>,
      ]);

      if (availableIntents.length === 0) {
        return `## No Credit Offers Available\n\nNo open lend intents found for market ${marketId}. Try a different market or check back later.`;
      }

      const loanMeta = await resolveTokenMeta(market.loanToken, walletProvider);
      const collateralMeta = await resolveTokenMeta(market.collateralToken, walletProvider);

      let filtered = availableIntents;

      if (args.minAmount) {
        const minAmount = BigInt(args.minAmount);
        filtered = filtered.filter(
          ({ intent }) => intent.amount - intent.filledAmount >= minAmount,
        );
      }
      if (args.maxRateBps) {
        const maxRate = BigInt(args.maxRateBps);
        filtered = filtered.filter(
          ({ intent }) => intent.minInterestRateBps <= maxRate,
        );
      }

      filtered.sort(
        (a, b) =>
          Number(b.intent.amount - b.intent.filledAmount) -
          Number(a.intent.amount - a.intent.filledAmount),
      );
      filtered = filtered.slice(0, args.maxResults);

      if (filtered.length === 0) {
        return `## No Matching Credit Offers\n\nFound ${availableIntents.length} open offer(s) in ${loanMeta.symbol}/${collateralMeta.symbol}, but none match your filters.`;
      }

      const lines = [
        `## Available Credit Offers — ${loanMeta.symbol}/${collateralMeta.symbol}\n`,
        `Found ${filtered.length} offer(s):\n`,
      ];

      for (const { hash, intent } of filtered) {
        const remaining = (intent.amount as bigint) - (intent.filledAmount as bigint);
        lines.push(
          `### Offer \`${hash.slice(0, 10)}…\``,
          `- **Offer Hash**: ${hash}`,
          `- **Lender**: ${formatAddress(intent.lender)}`,
          `- **Available**: ${formatTokenAmount(remaining, loanMeta.decimals, loanMeta.symbol)}`,
          `- **Min Interest Rate**: ${formatBps(intent.minInterestRateBps)}`,
          `- **Max LTV (Liquidation Threshold)**: ${formatBps(intent.maxLtvBps)}`,
          `- **Duration**: ${formatDuration(intent.minDuration)} — ${formatDuration(intent.maxDuration)}`,
          `- **Expiry**: ${formatTimestamp(intent.expiry)}`,
          `- **Partial Fill**: ${intent.allowPartialFill ? "Yes" : "No"}`,
          `- **Grace Period**: ${intent.gracePeriod > 0n ? formatDuration(intent.gracePeriod) : "Protocol default"}`,
          ``,
        );
      }

      lines.push(
        `\nTo open a credit facility, use **manual_match_credit** with the offer hash of your chosen offer.`,
      );

      return lines.join("\n");
    } catch (e) {
      return `Error browsing credit offers: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "manual_match_credit",
    description:
      "Open a credit facility by matching against a specific lend intent. This is a two-transaction operation: (1) registers your borrow intent with automatic collateral approval, (2) matches it with the chosen lend intent to create a loan. Returns the new loan ID on success.",
    schema: ManualMatchCreditSchema,
  })
  async manualMatchCredit(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ManualMatchCreditSchema>,
  ): Promise<string> {
    try {
      const userAddress = (await walletProvider.getAddress()) as Address;
      const lendHash = args.lendIntentHash as `0x${string}`;
      const marketId = args.marketId as `0x${string}`;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiry = now + BigInt(args.expirySeconds);
      const salt = `0x${[...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join("")}` as `0x${string}`;

      // Fetch market and validate lend intent in parallel
      const [market, lendIntent] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getMarket",
          args: [marketId],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getOnChainLendIntent",
          args: [lendHash],
        }) as Promise<any>,
      ]);

      // Full compatibility preflight — catch all mismatches before TX1
      // to avoid leaving a stray borrow intent on-chain when TX2 reverts.
      const incompatibility = this.checkLendIntentCompatibility(lendIntent, {
        marketId,
        borrowAmount: BigInt(args.borrowAmount),
        maxInterestRateBps: BigInt(args.maxInterestRateBps),
        minLtvBps: BigInt(args.minLtvBps),
        duration: BigInt(args.duration),
      });
      if (incompatibility) {
        return incompatibility;
      }

      // Auto-approve collateral
      const parsedCollateral = BigInt(args.collateralAmount);
      const approvalAmount = (parsedCollateral * 101n) / 100n;
      const approvalResult = await this.ensureAllowance(
        walletProvider,
        market.collateralToken as Address,
        this.matcherAddress,
        approvalAmount,
      );

      // Build borrow intent struct
      const borrowStruct = {
        borrower: userAddress,
        onBehalfOf: (args.onBehalfOf ?? userAddress) as Address,
        borrowAmount: BigInt(args.borrowAmount),
        collateralAmount: parsedCollateral,
        minFillAmount: BigInt(args.borrowAmount),
        maxInterestRateBps: BigInt(args.maxInterestRateBps),
        minLtvBps: BigInt(args.minLtvBps),
        minDuration: BigInt(args.duration),
        maxDuration: BigInt(args.duration),
        allowPartialFill: false,
        validFromTimestamp: 0n,
        matcherCommissionBps: BigInt(args.matcherCommissionBps),
        expiry,
        marketId,
        salt,
        conditions: [],
        preHooks: [],
        postHooks: [],
      };

      // TX 1: Register borrow intent
      const registerData = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "registerBorrowIntent",
        args: [borrowStruct],
      });
      const registerTxHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data: registerData,
      });
      await walletProvider.waitForTransactionReceipt(registerTxHash);

      // TX 2: Match intents
      const matchData = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "matchLoanIntents",
        args: [
          lendIntent,
          "0x" as `0x${string}`,
          borrowStruct,
          "0x" as `0x${string}`,
          marketId,
          true,
          true,
        ],
      });
      const matchTxHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data: matchData,
      });
      const matchReceipt = await walletProvider.waitForTransactionReceipt(matchTxHash);

      const loanId = this.extractLoanIdFromReceipt(matchReceipt);
      const loanMeta = await resolveTokenMeta(market.loanToken, walletProvider);
      const collateralMeta = await resolveTokenMeta(market.collateralToken, walletProvider);

      return [
        `## Credit Facility Opened\n`,
        `- **Approval**: ${approvalResult ?? "Allowance sufficient, no approval needed"}`,
        `- **Register Borrow Intent TX**: ${registerTxHash}`,
        `- **Match TX**: ${matchTxHash}`,
        loanId ? `- **Loan ID**: ${loanId}` : `- **Loan ID**: Check transaction receipt`,
        `- **Borrowed**: ${formatTokenAmount(BigInt(args.borrowAmount), loanMeta.decimals, loanMeta.symbol)}`,
        `- **Collateral**: ${formatTokenAmount(parsedCollateral, collateralMeta.decimals, collateralMeta.symbol)}`,
        `- **Interest Rate**: up to ${formatBps(BigInt(args.maxInterestRateBps))}`,
        `- **Duration**: ${formatDuration(BigInt(args.duration))}`,
        loanId
          ? `\nUse **check_credit_status** with loan ID ${loanId} to monitor your credit facility.`
          : "",
      ].join("\n");
    } catch (e) {
      return `Error opening credit facility: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "check_credit_status",
    description:
      "Check the status of an active credit facility (loan). Returns a combined view of health, remaining balance, accrued interest, and time to expiry. Designed for AI agents monitoring their working capital positions.",
    schema: CheckCreditStatusSchema,
  })
  async checkCreditStatus(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CheckCreditStatusSchema>,
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
        return `## Credit Facility — Loan #${args.loanId}\n\n**Status**: Fully repaid. No active credit facility.`;
      }

      const loanMeta = await resolveTokenMeta(loan.loanToken, walletProvider);
      const collateralMeta = await resolveTokenMeta(loan.collateralToken, walletProvider);

      const endTime = loan.startTime + loan.duration;
      const graceEnd = endTime + loan.gracePeriod;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const timeRemaining = endTime > now ? endTime - now : 0n;
      const isOverdue = now > graceEnd;
      const inGracePeriod = now > endTime && now <= graceEnd;

      const totalDebt = loan.principal + interestData[0];
      const distanceBps = loan.liquidationLtvBps - currentLtv;

      // Early repayment terms calculation
      const principal = loan.principal as bigint;
      const rateBps = loan.interestRateBps as bigint;
      const dur = loan.duration as bigint;
      const minIntBps = loan.minInterestBps as bigint;
      const fullTermInterest = (principal * rateBps * dur) / (10000n * 365n * 24n * 60n * 60n);
      const isPastMaturity = now >= endTime;
      let earlyRepayPenalty = 0n;
      let proRatedInterest = interestData[0];
      if (!isPastMaturity && minIntBps > 0n) {
        const minRequired = (fullTermInterest * minIntBps) / 10000n;
        if (minRequired > interestData[0]) {
          earlyRepayPenalty = minRequired - interestData[0];
          proRatedInterest = minRequired;
        }
      }
      const totalRepayNow = loan.principal + interestData[0] + earlyRepayPenalty;

      const lines = [
        `## Credit Facility Status — Loan #${args.loanId}\n`,
        `### Balance`,
        `- **Principal**: ${formatTokenAmount(loan.principal, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Accrued Interest**: ${formatTokenAmount(interestData[0], loanMeta.decimals, loanMeta.symbol)}`,
        `- **Total Debt**: ${formatTokenAmount(totalDebt, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Collateral**: ${formatTokenAmount(loan.collateralAmount, collateralMeta.decimals, collateralMeta.symbol)}`,
        ``,
        `### Health`,
        `- **Healthy**: ${healthy ? "Yes" : "NO — Liquidatable!"}`,
        `- **Current LTV**: ${formatBps(currentLtv)}`,
        `- **Liquidation LTV**: ${formatBps(loan.liquidationLtvBps)}`,
        `- **Buffer**: ${formatBps(distanceBps)} (${computeHealthPercent(currentLtv, loan.liquidationLtvBps)})`,
        ``,
        `### Timeline`,
        `- **Started**: ${formatTimestamp(loan.startTime)}`,
        `- **Duration**: ${formatDuration(loan.duration)}`,
        `- **Time Remaining**: ${timeRemaining > 0n ? formatDuration(timeRemaining) : isOverdue ? "OVERDUE" : "Expired (in grace period)"}`,
        `- **Grace Period**: ${loan.gracePeriod > 0n ? formatDuration(loan.gracePeriod) : "Protocol default"}`,
        ``,
        `### Early Repayment Terms`,
        `- **Min Interest**: ${minIntBps > 0n ? `${formatBps(minIntBps)} of full-term interest` : "None (no minimum)"}`,
        `- **Full-Term Interest**: ${formatTokenAmount(fullTermInterest, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Early Repay Penalty**: ${earlyRepayPenalty > 0n ? formatTokenAmount(earlyRepayPenalty, loanMeta.decimals, loanMeta.symbol) : "None"}`,
        `- **Total If Repaid Now**: ${formatTokenAmount(totalRepayNow, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Interest Rate**: ${formatBps(loan.interestRateBps)} APR`,
      ];

      if (!healthy) {
        lines.push(
          "\n**CRITICAL**: This credit facility can be liquidated. Repay immediately or add collateral.",
        );
      } else if (distanceBps < 500n) {
        lines.push(
          "\n**Warning**: Close to liquidation threshold. Consider adding collateral.",
        );
      }

      if (inGracePeriod) {
        lines.push(
          "\n**Warning**: Loan has expired and is in grace period. Repay before grace period ends to avoid overdue liquidation.",
        );
      } else if (isOverdue) {
        lines.push(
          "\n**CRITICAL**: Loan is overdue. It can be liquidated at any time.",
        );
      } else if (timeRemaining > 0n && timeRemaining < 86400n) {
        lines.push(
          "\n**Notice**: Less than 24 hours remaining. Consider repaying or renewing.",
        );
      }

      return lines.join("\n");
    } catch (e) {
      return `Error checking credit status: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "repay_credit",
    description:
      "Fully repay a credit facility (loan). Automatically calculates the total repayment including accrued interest, handles token approval, and executes the repayment. Always repays the full principal.",
    schema: RepayCreditSchema,
  })
  async repayCredit(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RepayCreditSchema>,
  ): Promise<string> {
    try {
      const loanId = BigInt(args.loanId);
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
      const repayAmount = loan.principal;
      const estimatedTotal = repayAmount + interestData[0];
      const maxTotalRepayment =
        estimatedTotal + (estimatedTotal * slippageBps) / BASIS_POINTS;

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
        `## Credit Facility Repaid\n`,
        `- **Approval**: ${approvalResult ?? "Allowance sufficient, no approval needed"}`,
        `- **Transaction**: ${txHash}`,
        `- **Loan ID**: ${args.loanId}`,
        `- **Principal Repaid**: ${formatTokenAmount(repayAmount, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Estimated Interest**: ${formatTokenAmount(interestData[0], loanMeta.decimals, loanMeta.symbol)}`,
        `- **Max Total (with ${formatBps(slippageBps)} slippage)**: ${formatTokenAmount(maxTotalRepayment, loanMeta.decimals, loanMeta.symbol)}`,
      ].join("\n");
    } catch (e) {
      return `Error repaying credit facility: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "renew_credit_line",
    description:
      "Renew an expiring credit facility in two steps: repay the existing loan, then open a new one by matching a fresh lend intent. Executes 3 transactions: (1) repay existing loan, (2) register new borrow intent, (3) match with new lend intent. Returns both old and new loan details.",
    schema: RenewCreditLineSchema,
  })
  async renewCreditLine(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RenewCreditLineSchema>,
  ): Promise<string> {
    try {
      const oldLoanId = BigInt(args.loanId);
      const slippageBps = BigInt(args.slippageBps);

      // ── Phase 1: Repay existing loan ──────────────────────────────────
      const [oldLoan, interestData] = await Promise.all([
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getLoan",
          args: [oldLoanId],
        }) as Promise<any>,
        walletProvider.readContract({
          address: this.matcherAddress,
          abi: LENDING_MATCHER_ABI,
          functionName: "getAccruedInterest",
          args: [oldLoanId],
        }) as Promise<[bigint, bigint]>,
      ]);

      if (oldLoan.repaid) {
        return `Loan #${args.loanId} is already repaid. Use manual_match_credit to open a new credit facility.`;
      }

      const loanMeta = await resolveTokenMeta(oldLoan.loanToken, walletProvider);
      const repayAmount = oldLoan.principal;
      const estimatedTotal = repayAmount + interestData[0];
      const maxTotalRepayment =
        estimatedTotal + (estimatedTotal * slippageBps) / BASIS_POINTS;

      const repayApproval = await this.ensureAllowance(
        walletProvider,
        oldLoan.loanToken as Address,
        this.matcherAddress,
        maxTotalRepayment,
      );

      const repayData = encodeFunctionData({
        abi: LENDING_MATCHER_ABI,
        functionName: "repayLoan",
        args: [oldLoanId, repayAmount, maxTotalRepayment],
      });

      const repayTxHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data: repayData,
      });
      await walletProvider.waitForTransactionReceipt(repayTxHash);

      // ── Phase 2: Open new credit facility ─────────────────────────────
      const userAddress = (await walletProvider.getAddress()) as Address;
      const lendHash = args.lendIntentHash as `0x${string}`;
      const marketId = args.marketId as `0x${string}`;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiry = now + 300n; // 5 min expiry for the borrow intent
      const salt = `0x${[...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join("")}` as `0x${string}`;

      let newLoanId: string | null = null;
      let registerTxHash: `0x${string}` | undefined;
      let matchTxHash: `0x${string}` | undefined;

      try {
        const [market, lendIntent] = await Promise.all([
          walletProvider.readContract({
            address: this.matcherAddress,
            abi: LENDING_MATCHER_ABI,
            functionName: "getMarket",
            args: [marketId],
          }) as Promise<any>,
          walletProvider.readContract({
            address: this.matcherAddress,
            abi: LENDING_MATCHER_ABI,
            functionName: "getOnChainLendIntent",
            args: [lendHash],
          }) as Promise<any>,
        ]);

        if (lendIntent.lender === "0x0000000000000000000000000000000000000000") {
          return [
            `## Credit Line — Partial Renewal\n`,
            `### Old Loan Repaid`,
            `- **Repay TX**: ${repayTxHash}`,
            `- **Loan ID**: ${args.loanId}`,
            `- **Repay Approval**: ${repayApproval ?? "No approval needed"}`,
            ``,
            `### New Credit — FAILED`,
            `Lend intent ${lendHash} not found on-chain. Use **request_credit** to find a new offer, then **manual_match_credit** to open a new credit facility.`,
          ].join("\n");
        }

        // Auto-approve collateral
        const parsedCollateral = BigInt(args.collateralAmount);
        const collateralApprovalAmount = (parsedCollateral * 101n) / 100n;
        await this.ensureAllowance(
          walletProvider,
          market.collateralToken as Address,
          this.matcherAddress,
          collateralApprovalAmount,
        );

        const borrowStruct = {
          borrower: userAddress,
          onBehalfOf: userAddress,
          borrowAmount: BigInt(args.borrowAmount),
          collateralAmount: parsedCollateral,
          minFillAmount: BigInt(args.borrowAmount),
          maxInterestRateBps: BigInt(args.maxInterestRateBps),
          minLtvBps: BigInt(args.minLtvBps),
          minDuration: BigInt(args.duration),
          maxDuration: BigInt(args.duration),
          allowPartialFill: false,
          validFromTimestamp: 0n,
          matcherCommissionBps: BigInt(args.matcherCommissionBps),
          expiry,
          marketId,
          salt,
          conditions: [],
          preHooks: [],
          postHooks: [],
        };

        // TX 2: Register borrow intent
        const registerData = encodeFunctionData({
          abi: LENDING_MATCHER_ABI,
          functionName: "registerBorrowIntent",
          args: [borrowStruct],
        });
        registerTxHash = await walletProvider.sendTransaction({
          to: this.matcherAddress,
          data: registerData,
        });
        await walletProvider.waitForTransactionReceipt(registerTxHash);

        // TX 3: Match
        const matchData = encodeFunctionData({
          abi: LENDING_MATCHER_ABI,
          functionName: "matchLoanIntents",
          args: [
            lendIntent,
            "0x" as `0x${string}`,
            borrowStruct,
            "0x" as `0x${string}`,
            marketId,
            true,
            true,
          ],
        });
        matchTxHash = await walletProvider.sendTransaction({
          to: this.matcherAddress,
          data: matchData,
        });
        const matchReceipt = await walletProvider.waitForTransactionReceipt(matchTxHash);
        newLoanId = this.extractLoanIdFromReceipt(matchReceipt);
      } catch (matchError) {
        return [
          `## Credit Line — Partial Renewal\n`,
          `### Old Loan Repaid`,
          `- **Repay TX**: ${repayTxHash}`,
          `- **Loan ID**: ${args.loanId}`,
          ``,
          `### New Credit — FAILED`,
          `Error during new credit setup: ${matchError instanceof Error ? matchError.message : String(matchError)}`,
          registerTxHash ? `- **Register Borrow Intent TX**: ${registerTxHash}` : "",
          `\nThe old loan was repaid successfully. Use **manual_match_credit** to retry opening a new credit facility.`,
        ]
          .filter(Boolean)
          .join("\n");
      }

      const collateralMeta = await resolveTokenMeta(oldLoan.collateralToken, walletProvider);

      return [
        `## Credit Line Renewed\n`,
        `### Old Loan Repaid`,
        `- **Repay TX**: ${repayTxHash}`,
        `- **Old Loan ID**: ${args.loanId}`,
        `- **Principal Repaid**: ${formatTokenAmount(repayAmount, loanMeta.decimals, loanMeta.symbol)}`,
        `- **Repay Approval**: ${repayApproval ?? "No approval needed"}`,
        ``,
        `### New Credit Facility Opened`,
        `- **Register Borrow Intent TX**: ${registerTxHash}`,
        `- **Match TX**: ${matchTxHash}`,
        newLoanId ? `- **New Loan ID**: ${newLoanId}` : `- **New Loan ID**: Check transaction receipt`,
        `- **Borrowed**: ${formatTokenAmount(BigInt(args.borrowAmount), loanMeta.decimals, loanMeta.symbol)}`,
        `- **Collateral**: ${formatTokenAmount(BigInt(args.collateralAmount), collateralMeta.decimals, collateralMeta.symbol)}`,
        `- **Interest Rate**: up to ${formatBps(BigInt(args.maxInterestRateBps))}`,
        `- **Duration**: ${formatDuration(BigInt(args.duration))}`,
        newLoanId
          ? `\nUse **check_credit_status** with loan ID ${newLoanId} to monitor your new credit facility.`
          : "",
      ].join("\n");
    } catch (e) {
      return `Error renewing credit line: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AUTO-SELECT CREDIT ACTIONS
  // ════════════════════════════════════════════════════════════════════════

  @CreateAction({
    name: "instant_borrow",
    description:
      "Instantly borrow funds by auto-selecting the best available lend intent. Single action: queries the on-chain intent book, picks the lowest-rate compatible offer, and executes the 2-tx borrow flow (register + match). For DeFi agents that need capital in seconds, not minutes of browsing. Requires rpcUrl in FloeConfig.",
    schema: InstantBorrowSchema,
  })
  async instantBorrow(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof InstantBorrowSchema>,
  ): Promise<string> {
    try {
      const marketId = args.marketId as `0x${string}`;
      const borrowAmount = BigInt(args.borrowAmount);
      const maxInterestRateBps = BigInt(args.maxInterestRateBps);
      const minLtvBps = BigInt(args.minLtvBps);
      const duration = BigInt(args.duration);

      const available = await this.scanAvailableLendIntents(walletProvider, marketId);

      // Filter with compatibility checks (same rules as manualMatchCredit preflight)
      const compatible = available.filter(
        ({ intent }) =>
          this.checkLendIntentCompatibility(intent, {
            marketId,
            borrowAmount,
            maxInterestRateBps,
            minLtvBps,
            duration,
          }) === null,
      );

      if (compatible.length === 0) {
        return (
          "No matching liquidity found for your borrow request. " +
          "Try adjusting your maxInterestRateBps, duration, or borrowAmount."
        );
      }

      // Pick lowest rate
      compatible.sort(
        (a, b) =>
          Number((a.intent.minInterestRateBps as bigint) - (b.intent.minInterestRateBps as bigint)),
      );
      const best = compatible[0];

      // Delegate to manualMatchCredit for the 2-TX execution
      return await this.manualMatchCredit(walletProvider, {
        lendIntentHash: best.hash,
        borrowAmount: args.borrowAmount,
        collateralAmount: args.collateralAmount,
        maxInterestRateBps: args.maxInterestRateBps,
        minLtvBps: args.minLtvBps,
        duration: args.duration,
        marketId: args.marketId,
        matcherCommissionBps: "50",
        expirySeconds: "300",
        onBehalfOf: args.onBehalfOf,
      });
    } catch (e) {
      return `Error in instant borrow: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @CreateAction({
    name: "repay_and_reborrow",
    description:
      "Repay an existing credit facility and instantly borrow again in one action. Auto-selects the best available lend intent for the new loan. If the reborrow fails (no liquidity), the repayment still succeeds. Use this for agents cycling credit continuously. Requires rpcUrl in FloeConfig.",
    schema: RenewCreditLineV2Schema,
  })
  async repayAndReborrow(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RenewCreditLineV2Schema>,
  ): Promise<string> {
    try {
      // Preflight: instantBorrow needs RPC for event scanning.
      // Fail BEFORE repaying to avoid partial success (loan repaid but can't reborrow).
      if (!this.publicClient) {
        return (
          "Cannot repay_and_reborrow: rpcUrl is not configured in FloeConfig. " +
          "RPC access is required to scan for available lend intents during the reborrow step. " +
          "Use repay_credit + instant_borrow separately if you want manual control."
        );
      }

      // Read old loan data BEFORE repaying (needed for defaults on the new loan)
      const oldLoan = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: LENDING_MATCHER_ABI,
        functionName: "getLoan",
        args: [BigInt(args.loanId)],
      })) as any;

      if (oldLoan.repaid) {
        return `Loan #${args.loanId} is already repaid. Use instant_borrow to open a new credit facility.`;
      }

      // Step 1: Repay existing loan
      const repayResult = await this.repayCredit(walletProvider, {
        loanId: args.loanId,
        slippageBps: args.slippageBps,
      });

      // Gate on success — repayCredit returns formatted markdown starting with this header
      if (!repayResult.startsWith("## Credit Facility Repaid")) {
        return repayResult; // Pass through the error
      }

      // Step 2: Instant borrow with old loan defaults
      const borrowResult = await this.instantBorrow(walletProvider, {
        marketId: oldLoan.marketId as string,
        borrowAmount: args.newBorrowAmount ?? String(oldLoan.principal),
        collateralAmount: args.newCollateralAmount ?? String(oldLoan.collateralAmount),
        maxInterestRateBps: args.maxInterestRateBps ?? String(oldLoan.interestRateBps),
        duration: args.duration ?? String(oldLoan.duration),
        minLtvBps: String(oldLoan.ltvBps),
        onBehalfOf: args.onBehalfOf,
      });

      // Gate on success — manualMatchCredit returns "## Credit Facility Opened" on success
      if (borrowResult.startsWith("## Credit Facility Opened")) {
        return [
          `## Credit Line Renewed\n`,
          `### Old Loan Repaid`,
          repayResult.replace("## Credit Facility Repaid\n", ""),
          ``,
          `### New Credit Facility`,
          borrowResult.replace("## Credit Facility Opened\n", ""),
        ].join("\n");
      }

      // Partial success: repay OK, reborrow failed
      return [
        `## Credit Line — Partial Renewal\n`,
        `### Old Loan Repaid`,
        repayResult.replace("## Credit Facility Repaid\n", ""),
        ``,
        `### New Credit — FAILED`,
        borrowResult,
        `\nOld loan repaid successfully. Use **instant_borrow** to try again later.`,
      ].join("\n");
    } catch (e) {
      return `Error renewing credit line: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
