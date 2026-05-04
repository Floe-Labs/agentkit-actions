import {
  ActionProvider,
  CreateAction,
  EvmWalletProvider,
  Network,
} from "@coinbase/agentkit";
import { encodeFunctionData } from "viem";
import { z } from "zod";
import { LENDING_MATCHER_ABI, ERC20_ABI, BASE_MAINNET_MATCHER } from "./constants.js";
import type { Address } from "./types.js";
import { formatBps, formatTokenAmount, formatAddress, formatDuration } from "./utils.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address");

const NonNegIntString = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "Must be a non-negative integer");

// Known collateral tokens on Base
const KNOWN_COLLATERAL: Record<string, boolean> = {
  "0x4200000000000000000000000000000000000006": true, // WETH
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": true, // cbBTC
};

export const GrantCreditDelegationSchema = z.object({
  facilitatorAddress: AddressSchema.describe("The facilitator's operator address"),
  facilitatorUrl: z.string().url()
    .refine((u) => u.startsWith("https://"), "Must use HTTPS")
    .describe("The facilitator API base URL (e.g. https://x402.floe.xyz)"),
  borrowLimit: NonNegIntString.describe("Maximum borrow limit in USDC (e.g. '10000' for $10K)"),
  maxRateBps: NonNegIntString.default("1500")
    .refine((v) => BigInt(v) <= 10000n, "Must be <= 10000 basis points")
    .describe("Maximum interest rate in basis points (e.g. '1500' = 15%)"),
  expiryDays: NonNegIntString.default("90")
    .refine((v) => { const d = BigInt(v); return d >= 1n && d <= 3650n; }, "Must be 1-3650 days")
    .describe("Number of days until delegation expires"),
  collateralToken: AddressSchema
    .refine((v) => KNOWN_COLLATERAL[v.toLowerCase()] === true, "Must be WETH or cbBTC")
    .describe("Collateral token address (WETH or cbBTC)"),
  collateralApproval: NonNegIntString.optional()
    .describe(
      "Optional bounded collateral allowance to grant the matcher (raw token units). " +
      "If omitted, an unlimited approval is set (matches standard DeFi UX; matcher is a governance-controlled protocol). " +
      "Set this to cap exposure if the matcher were ever compromised.",
    ),
});

export const RevokeCreditDelegationSchema = z.object({
  facilitatorAddress: AddressSchema.describe("The facilitator's operator address to revoke"),
});

export const CheckCreditDelegationSchema = z.object({
  facilitatorAddress: AddressSchema.describe("The facilitator's operator address to check"),
});

export const X402FetchSchema = z.object({
  url: z.string().url().describe("The URL to fetch (may require x402 payment)"),
  method: z.string().default("GET").describe("HTTP method"),
  headers: z.record(z.string(), z.string()).optional().describe("Optional HTTP headers"),
  body: z.string().optional().describe("Optional request body"),
});

export const X402GetBalanceSchema = z.object({});

export const X402GetTransactionsSchema = z.object({
  limit: z.string().default("20").describe("Number of transactions to return"),
});

// ── Agent Awareness schemas ─────────────────────────────────────────────────
// The 9 actions below let an agent reason about its own credit before
// committing capital. Identity is taken from the configured facilitatorApiKey
// (Bearer), so none of these accept a wallet address parameter.

export const GetCreditRemainingSchema = z.object({});
export const GetLoanStateSchema = z.object({});
export const GetSpendLimitSchema = z.object({});

export const SetSpendLimitSchema = z.object({
  limitRaw: z
    .string()
    .regex(/^[1-9]\d*$/, "Must be a positive integer (raw USDC, 6 decimals)")
    .describe("Session spend cap in raw USDC units (6 decimals). e.g. '1000000' = $1."),
});

export const ClearSpendLimitSchema = z.object({});
export const ListCreditThresholdsSchema = z.object({});

export const RegisterCreditThresholdSchema = z.object({
  thresholdBps: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .describe("Utilization threshold in bps (5000 = 50%, 9500 = 95% triggers credit.at_limit)."),
  webhookId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional webhook id to pin to (must be owned by this developer). Omit for fanout."),
});

export const DeleteCreditThresholdSchema = z.object({
  id: z.number().int().positive().describe("Threshold subscription id from list_credit_thresholds."),
});

export const EstimateX402CostSchema = z.object({
  url: z.string().url().describe("Target x402-protected URL to preflight."),
  method: z
    .string()
    .regex(/^[A-Z]{3,7}$/)
    .default("GET")
    .describe("HTTP method (default GET)."),
});

// ── ABI fragments for operator functions ────────────────────────────────────

const OPERATOR_ABI = [
  {
    name: "setOperator",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "borrowLimit", type: "uint256" },
      { name: "maxRateBps", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "onBehalfOfRestriction", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "revokeOperator",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [],
  },
  {
    name: "getOperatorPermission",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agent", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "approved", type: "bool" },
          { name: "borrowLimit", type: "uint256" },
          { name: "borrowed", type: "uint256" },
          { name: "maxRateBps", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "onBehalfOfRestriction", type: "address" },
        ],
      },
    ],
  },
] as const;

const FETCH_TIMEOUT_MS = 15_000;

// ── Config ──────────────────────────────────────────────────────────────────

export interface X402Config {
  facilitatorUrl?: string;
  facilitatorApiKey?: string;
  matcherAddress?: Address;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class X402ActionProvider extends ActionProvider<EvmWalletProvider> {
  private matcherAddress: Address;
  private defaultFacilitatorUrl: string;
  private defaultFacilitatorApiKey: string;

  constructor(config?: Partial<X402Config>) {
    super("x402", []);
    this.matcherAddress = (config?.matcherAddress ?? BASE_MAINNET_MATCHER) as Address;
    // Normalize: strip trailing slash
    this.defaultFacilitatorUrl = (config?.facilitatorUrl ?? "").replace(/\/+$/, "");
    this.defaultFacilitatorApiKey = config?.facilitatorApiKey ?? "";
  }

  supportsNetwork = (network: Network): boolean => {
    return network.chainId === "8453" || network.chainId === "84532";
  };

  private async facilitatorFetch(
    path: string,
    options?: RequestInit,
    overrideUrl?: string,
    overrideKey?: string,
  ): Promise<Response> {
    const baseUrl = overrideUrl || this.defaultFacilitatorUrl;
    const apiKey = overrideKey || this.defaultFacilitatorApiKey;
    if (!baseUrl) throw new Error("facilitatorUrl not configured");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(options?.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
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
    return walletProvider.sendTransaction({ to: tokenAddress, data });
  }

  private generateNonce(): string {
    // Crypto-safe nonce for replay prevention
    const c = (globalThis as unknown as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (buf: Uint8Array) => Uint8Array;
      };
    }).crypto;
    if (c?.randomUUID) {
      return `${Date.now()}-${c.randomUUID()}`;
    }
    if (c?.getRandomValues) {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      return `${Date.now()}-${Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;
    }
    // Node fallback
    const nodeCrypto = require("crypto") as typeof import("crypto");
    return `${Date.now()}-${nodeCrypto.randomBytes(16).toString("hex")}`;
  }

  private async getChainIdString(walletProvider: EvmWalletProvider): Promise<string> {
    try {
      const net = (walletProvider as unknown as { getNetwork?: () => Promise<{ chainId?: number | string | bigint }> | { chainId?: number | string | bigint } }).getNetwork?.();
      const resolved = net && typeof (net as Promise<unknown>).then === "function" ? await net : net;
      const id = (resolved as { chainId?: number | string | bigint } | undefined)?.chainId;
      if (id !== undefined && id !== null) return typeof id === "bigint" ? id.toString() : String(id);
    } catch { /* fall through */ }
    return "8453";
  }

  private buildSignMessage(nonce: string, facilitatorAddress: string, chainId: string): string {
    return `Register with Floe Facilitator\nFacilitator: ${facilitatorAddress}\nChain: ${chainId}\nNonce: ${nonce}`;
  }

  // ── grant_credit_delegation ─────────────────────────────────────────────

  @CreateAction({
    name: "grant_credit_delegation",
    description:
      "Grant credit delegation to an x402 facilitator. This allows the facilitator to borrow USDC on your behalf using your collateral. " +
      "The facilitator uses borrowed funds to pay for x402 API resources automatically. " +
      "You set a maximum borrow limit, interest rate cap, and expiry. " +
      "This action: (1) calls the facilitator to create a Privy wallet for you, (2) calls setOperator on the lending contract, (3) approves your collateral token, (4) completes registration with the facilitator.",
    schema: GrantCreditDelegationSchema,
  })
  async grantCreditDelegation(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GrantCreditDelegationSchema>,
  ): Promise<string> {
    try {
      const agentAddress = await walletProvider.getAddress();
      const facilitatorUrl = args.facilitatorUrl.replace(/\/+$/, "");

      // Step 1: Pre-register with facilitator to get Privy wallet address
      const chainIdStr = await this.getChainIdString(walletProvider);
      const nonce = this.generateNonce();
      const signMessage = this.buildSignMessage(nonce, args.facilitatorAddress, chainIdStr);
      const signature = await walletProvider.signMessage(signMessage);

      const preRegResp = await this.facilitatorFetch("/agents/pre-register", {
        method: "POST",
        body: JSON.stringify({ walletAddress: agentAddress, signature, nonce }),
      }, facilitatorUrl);

      if (!preRegResp.ok) {
        const err = (await preRegResp.json()) as { error?: string };
        return `Pre-registration failed: ${err.error ?? preRegResp.statusText}`;
      }

      const { privyWalletAddress } = (await preRegResp.json()) as { privyWalletAddress: string };

      if (!/^0x[0-9a-fA-F]{40}$/.test(privyWalletAddress)) {
        return `Pre-registration returned invalid Privy wallet address: ${privyWalletAddress}`;
      }

      // Step 2: Call setOperator on the lending contract
      const usdcDecimals = 6;
      const borrowLimitRaw = BigInt(args.borrowLimit) * BigInt(10 ** usdcDecimals);
      const maxRateBps = BigInt(args.maxRateBps);
      const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000)) + BigInt(args.expiryDays) * 86400n;

      const setOperatorData = encodeFunctionData({
        abi: OPERATOR_ABI,
        functionName: "setOperator",
        args: [
          args.facilitatorAddress as `0x${string}`,
          borrowLimitRaw,
          maxRateBps,
          expiryTimestamp,
          privyWalletAddress as `0x${string}`,
        ],
      });

      const setOpTxHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data: setOperatorData,
      });

      // Step 3: Approve collateral. Defaults to unlimited (matcher is a governance-controlled
      // protocol; standard DeFi UX). Users can bound exposure via args.collateralApproval.
      const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      const approvalAmount = args.collateralApproval ? BigInt(args.collateralApproval) : MAX_UINT256;
      const approveTxHash = await this.ensureAllowance(
        walletProvider,
        args.collateralToken as Address,
        this.matcherAddress,
        approvalAmount,
      );

      // Step 4: Complete registration with facilitator
      const regNonce = this.generateNonce();
      const regMessage = this.buildSignMessage(regNonce, args.facilitatorAddress, chainIdStr);
      const regSignature = await walletProvider.signMessage(regMessage);

      const regResp = await this.facilitatorFetch("/agents/register", {
        method: "POST",
        body: JSON.stringify({ walletAddress: agentAddress, signature: regSignature, nonce: regNonce }),
      }, facilitatorUrl);

      if (!regResp.ok) {
        const err = (await regResp.json()) as { error?: string };
        return `Registration failed (delegation was set on-chain): ${err.error ?? regResp.statusText}. ` +
          `You can retry registration later — the on-chain delegation is active.`;
      }

      const regResult = (await regResp.json()) as {
        agentId: string;
        apiKey: string;
        privyWalletAddress: string;
        creditLimit: string;
      };

      // Store for subsequent calls in this session
      this.defaultFacilitatorApiKey = regResult.apiKey;
      this.defaultFacilitatorUrl = facilitatorUrl;

      const creditLimitFormatted = formatTokenAmount(BigInt(regResult.creditLimit), usdcDecimals, "USDC");
      const keyPreview = regResult.apiKey.slice(-4);

      return [
        "## Credit Delegation Granted\n",
        `**Facilitator**: ${formatAddress(args.facilitatorAddress)}`,
        `**Privy Wallet**: ${formatAddress(regResult.privyWalletAddress)}`,
        `**Credit Limit**: ${creditLimitFormatted}`,
        `**Max Rate**: ${formatBps(maxRateBps)} APR`,
        `**Expires**: ${formatDuration(BigInt(args.expiryDays) * 86400n)}`,
        "",
        `**setOperator tx**: ${setOpTxHash}`,
        approveTxHash ? `**Approval tx**: ${approveTxHash}` : "**Approval**: Already sufficient",
        "",
        `> API key stored for this session (ending ...${keyPreview}).`,
        "> Pass it via `X402Config.facilitatorApiKey` if you need it across sessions.",
      ].join("\n");
    } catch (e) {
      return `Error granting credit delegation: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── revoke_credit_delegation ────────────────────────────────────────────

  @CreateAction({
    name: "revoke_credit_delegation",
    description:
      "Immediately revoke credit delegation from a facilitator. " +
      "The facilitator will no longer be able to register new borrow intents on your behalf. " +
      "Existing loans continue until repaid or rolled over. Active intents become unmatchable.",
    schema: RevokeCreditDelegationSchema,
  })
  async revokeCreditDelegation(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RevokeCreditDelegationSchema>,
  ): Promise<string> {
    try {
      const data = encodeFunctionData({
        abi: OPERATOR_ABI,
        functionName: "revokeOperator",
        args: [args.facilitatorAddress as `0x${string}`],
      });

      const txHash = await walletProvider.sendTransaction({
        to: this.matcherAddress,
        data,
      });

      return [
        "## Credit Delegation Revoked\n",
        `**Facilitator**: ${formatAddress(args.facilitatorAddress)}`,
        `**Transaction**: ${txHash}`,
        "",
        "The facilitator can no longer register new borrow intents on your behalf.",
        "Existing loans and active intents are unaffected until they expire or are repaid.",
      ].join("\n");
    } catch (e) {
      return `Error revoking delegation: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── check_credit_delegation ─────────────────────────────────────────────

  @CreateAction({
    name: "check_credit_delegation",
    description:
      "Check the status of your credit delegation to a facilitator. " +
      "Shows whether the delegation is active, how much has been borrowed vs the limit, " +
      "the interest rate cap, expiry, and where funds are routed.",
    schema: CheckCreditDelegationSchema,
  })
  async checkCreditDelegation(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CheckCreditDelegationSchema>,
  ): Promise<string> {
    try {
      const agentAddress = await walletProvider.getAddress();
      const perm = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: OPERATOR_ABI,
        functionName: "getOperatorPermission",
        args: [agentAddress as `0x${string}`, args.facilitatorAddress as `0x${string}`],
      })) as {
        approved: boolean;
        borrowLimit: bigint;
        borrowed: bigint;
        maxRateBps: bigint;
        expiry: bigint;
        onBehalfOfRestriction: string;
      };

      const now = BigInt(Math.floor(Date.now() / 1000));
      const isExpired = now > perm.expiry;
      const daysLeft = isExpired ? 0n : (perm.expiry - now) / 86400n;
      const available = perm.borrowLimit > perm.borrowed ? perm.borrowLimit - perm.borrowed : 0n;
      const nearExpiry = daysLeft < 7n && daysLeft > 0n;
      const usdcDecimals = 6;

      const lines = [
        "## Credit Delegation Status\n",
        `**Facilitator**: ${formatAddress(args.facilitatorAddress)}`,
        `**Status**: ${perm.approved ? (isExpired ? "Expired" : "Active") : "Not Active"}`,
        "",
        `**Borrow Limit**: ${formatTokenAmount(perm.borrowLimit, usdcDecimals, "USDC")}`,
        `**Borrowed**: ${formatTokenAmount(perm.borrowed, usdcDecimals, "USDC")}`,
        `**Available**: ${formatTokenAmount(available, usdcDecimals, "USDC")}`,
        `**Max Rate**: ${formatBps(perm.maxRateBps)} APR`,
        `**Expiry**: ${isExpired ? "EXPIRED" : `${daysLeft} days remaining`}`,
      ];

      if (perm.onBehalfOfRestriction !== "0x0000000000000000000000000000000000000000") {
        lines.push(`**Funds Route To**: ${formatAddress(perm.onBehalfOfRestriction)}`);
      }
      if (nearExpiry) {
        lines.push("", "**Delegation expiring soon!** Consider renewing via `grant_credit_delegation`.");
      }

      return lines.join("\n");
    } catch (e) {
      return `Error checking delegation: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── x402_fetch ──────────────────────────────────────────────────────────

  @CreateAction({
    name: "x402_fetch",
    description:
      "Fetch a URL through the x402 facilitator proxy. If the URL requires payment (HTTP 402), " +
      "the facilitator pays automatically using your credit line. Non-payment URLs pass through normally.",
    schema: X402FetchSchema,
  })
  async x402Fetch(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof X402FetchSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/proxy/fetch", {
        method: "POST",
        body: JSON.stringify({
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        const errorObj = err as { error?: string };
        const errorMap: Record<string, string> = {
          funding_in_progress: "Funding in progress — the facilitator is borrowing funds. Retry in 30 seconds.",
          credit_frozen: "Credit frozen — your collateral health ratio is too low.",
          insufficient_balance: "Insufficient credit — your credit line is fully utilized.",
          account_closed: "Account closed — no further payments.",
        };
        return errorMap[errorObj.error ?? ""] ?? `Facilitator error: ${errorObj.error ?? resp.statusText}`;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const body = contentType.includes("json")
        ? JSON.stringify(await resp.json(), null, 2)
        : await resp.text();

      const paymentTx = resp.headers.get("payment-response") || resp.headers.get("x-payment-response");

      const lines = ["## Response\n"];
      if (paymentTx) {
        lines.push(`*Paid via x402 — tx: ${paymentTx}*\n`);
      }
      lines.push("```", body.slice(0, 4000), "```");

      return lines.join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return "Facilitator request timed out. Retry later.";
      }
      return `Error fetching URL: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── x402_get_balance ────────────────────────────────────────────────────

  @CreateAction({
    name: "x402_get_balance",
    description:
      "Check your x402 credit status — available credit, active loans, health ratio, and next rollover date.",
    schema: X402GetBalanceSchema,
  })
  async x402GetBalance(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof X402GetBalanceSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/balance");
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return `Error: ${(err as { error?: string }).error ?? resp.statusText}`;
      }

      const data = (await resp.json()) as {
        creditLimit: string;
        creditUsed: string;
        creditAvailable: string;
        activeLoans: Array<{ loanId: string; principalRaw?: string }>;
        delegationActive: boolean;
        privyWalletBalance: string;
        privyWalletAddress: string;
      };

      const usdcDecimals = 6;
      return [
        "## x402 Credit Status\n",
        `**Credit Limit**: ${formatTokenAmount(BigInt(data.creditLimit || "0"), usdcDecimals, "USDC")}`,
        `**Credit Used**: ${formatTokenAmount(BigInt(data.creditUsed || "0"), usdcDecimals, "USDC")}`,
        `**Credit Available**: ${formatTokenAmount(BigInt(data.creditAvailable || "0"), usdcDecimals, "USDC")}`,
        `**Active Loans**: ${data.activeLoans?.length ?? 0}`,
        `**Delegation Active**: ${data.delegationActive ? "Yes" : "No"}`,
      ].join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error fetching balance: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── x402_get_transactions ───────────────────────────────────────────────

  @CreateAction({
    name: "x402_get_transactions",
    description: "Get your recent x402 payment history — URLs accessed, amounts paid, and transaction hashes.",
    schema: X402GetTransactionsSchema,
  })
  async x402GetTransactions(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof X402GetTransactionsSchema>,
  ): Promise<string> {
    try {
      const parsed = parseInt(args.limit, 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;
      const resp = await this.facilitatorFetch(`/agents/transactions?limit=${limit}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return `Error: ${(err as { error?: string }).error ?? resp.statusText}`;
      }

      const data = (await resp.json()) as {
        transactions: Array<{
          targetUrl: string;
          method: string;
          paymentAmountRaw: string | null;
          status: string;
          x402TxHash: string | null;
          createdAt: string;
        }>;
        hasMore: boolean;
      };

      if (!data.transactions?.length) return "No transactions found.";

      const usdcDecimals = 6;
      const lines = ["## Recent Transactions\n"];
      for (const tx of data.transactions) {
        const amount = tx.paymentAmountRaw
          ? formatTokenAmount(BigInt(tx.paymentAmountRaw), usdcDecimals, "USDC")
          : "—";
        const statusIcon = tx.status === "success" ? "OK" : tx.status === "passthrough" ? "FREE" : "FAIL";
        lines.push(`**${statusIcon}** ${tx.method} ${tx.targetUrl} — ${amount}`);
      }

      if (data.hasMore) lines.push("\n*More transactions available — increase limit.*");
      return lines.join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error fetching transactions: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // AGENT AWARENESS (9) — answer "do I have credit?", "is this call worth
  // it?", "where am I in the loan lifecycle?" before committing capital.
  // All require facilitatorApiKey to be set on the provider config.
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Internal helper for the agent-awareness actions: parse an error response
   * shape and return a human-readable string. Centralized here so each new
   * action stays readable. Returns null on success (response was JSON-parsed
   * and the caller can use it).
   */
  private async readJsonOrError(resp: Response): Promise<{ ok: true; data: unknown } | { ok: false; msg: string }> {
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      const e = err as { error?: string; detail?: string; message?: string };
      const msg = e.detail ?? e.error ?? e.message ?? resp.statusText;
      return { ok: false, msg };
    }
    // 204 No Content (and any other empty-body 2xx) is a legitimate success
    // shape — return an empty object so DELETE handlers don't surface a
    // false "Invalid JSON" to the caller. The text-then-parse pattern is
    // safer than `resp.json()` because `JSON.parse('')` throws.
    if (resp.status === 204) return { ok: true, data: {} };
    const text = await resp.text();
    if (text.length === 0) return { ok: true, data: {} };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, msg: "Invalid JSON in response" };
    }
  }

  // ── get_credit_remaining ────────────────────────────────────────────────

  @CreateAction({
    name: "get_credit_remaining",
    description:
      "Return the calling agent's current credit headroom: available USDC, headroomToAutoBorrow, " +
      "utilizationBps, and any active session spend-limit. Use BEFORE deciding whether to make a paid call.",
    schema: GetCreditRemainingSchema,
  })
  async getCreditRemaining(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof GetCreditRemainingSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/credit-remaining");
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as {
        available: string;
        creditLimit: string;
        headroomToAutoBorrow: string;
        utilizationBps: number;
        sessionSpendLimit: string | null;
        sessionSpendRemaining: string | null;
      };
      const usdc = 6;
      const lines = [
        "## Credit Remaining\n",
        `**Available**: ${formatTokenAmount(BigInt(d.available), usdc, "USDC")}`,
        `**Credit Limit**: ${formatTokenAmount(BigInt(d.creditLimit), usdc, "USDC")}`,
        `**Headroom to Auto-Borrow**: ${formatTokenAmount(BigInt(d.headroomToAutoBorrow), usdc, "USDC")}`,
        `**Utilization**: ${formatBps(BigInt(d.utilizationBps))}`,
      ];
      if (d.sessionSpendLimit) {
        lines.push(
          `**Session Cap**: ${formatTokenAmount(BigInt(d.sessionSpendLimit), usdc, "USDC")} ` +
          `(remaining ${formatTokenAmount(BigInt(d.sessionSpendRemaining ?? "0"), usdc, "USDC")})`,
        );
      }
      return lines.join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error fetching credit-remaining: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── get_loan_state ──────────────────────────────────────────────────────

  @CreateAction({
    name: "get_loan_state",
    description:
      "Return the agent's coarse loan state-machine view: idle | borrowing | at_limit | repaying. " +
      "Use to gate actions that only make sense in specific states (e.g. don't spend while at_limit).",
    schema: GetLoanStateSchema,
  })
  async getLoanState(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof GetLoanStateSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/loan-state");
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as { state: string; reason: string; details?: Record<string, unknown> };
      return [
        "## Loan State\n",
        `**State**: ${d.state}`,
        `**Reason**: ${d.reason}`,
        d.details ? `**Details**: ${JSON.stringify(d.details, null, 2)}` : "",
      ].filter(Boolean).join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error fetching loan-state: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── get_spend_limit ─────────────────────────────────────────────────────

  @CreateAction({
    name: "get_spend_limit",
    description:
      "Return the agent's currently-active session spend cap, if any. Returns inactive when no cap is set.",
    schema: GetSpendLimitSchema,
  })
  async getSpendLimit(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof GetSpendLimitSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/spend-limit");
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as {
        active: boolean;
        limitRaw: string | null;
        sessionSpentRaw?: string;
        sessionRemainingRaw?: string;
      };
      if (!d.active) return "## Spend Limit\n\nNo session spend cap set.";
      const usdc = 6;
      return [
        "## Spend Limit\n",
        `**Cap**: ${formatTokenAmount(BigInt(d.limitRaw ?? "0"), usdc, "USDC")}`,
        `**Spent this session**: ${formatTokenAmount(BigInt(d.sessionSpentRaw ?? "0"), usdc, "USDC")}`,
        `**Remaining**: ${formatTokenAmount(BigInt(d.sessionRemainingRaw ?? "0"), usdc, "USDC")}`,
      ].join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error fetching spend-limit: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── set_spend_limit ─────────────────────────────────────────────────────

  @CreateAction({
    name: "set_spend_limit",
    description:
      "Set or update the agent's session spend cap (raw USDC, 6 decimals). Resets the session window — " +
      "anything spent before this call no longer counts. Operator-defined; distinct from the on-chain creditLimit.",
    schema: SetSpendLimitSchema,
  })
  async setSpendLimit(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof SetSpendLimitSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/spend-limit", {
        method: "PUT",
        body: JSON.stringify({ limitRaw: args.limitRaw }),
      });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as { limitRaw: string; sessionStartedAt: string };
      return [
        "## Spend Limit Set\n",
        `**Cap**: ${formatTokenAmount(BigInt(d.limitRaw), 6, "USDC")}`,
        `**Session Started**: ${d.sessionStartedAt}`,
      ].join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error setting spend-limit: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── clear_spend_limit ───────────────────────────────────────────────────

  @CreateAction({
    name: "clear_spend_limit",
    description:
      "Remove the agent's session spend cap. Subsequent paid calls will only be bounded by the on-chain creditLimit.",
    schema: ClearSpendLimitSchema,
  })
  async clearSpendLimit(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof ClearSpendLimitSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/spend-limit", { method: "DELETE" });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      return "## Spend Limit Cleared\n\nNo cap is now active.";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error clearing spend-limit: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── list_credit_thresholds ──────────────────────────────────────────────

  @CreateAction({
    name: "list_credit_thresholds",
    description:
      "List the agent's registered credit-utilization thresholds. Each fires a credit.warning / " +
      "credit.at_limit / credit.recovered webhook when crossed.",
    schema: ListCreditThresholdsSchema,
  })
  async listCreditThresholds(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof ListCreditThresholdsSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/credit-thresholds");
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as {
        subscriptions: Array<{
          id: number;
          thresholdBps: number;
          lastState: string;
          lastFiredAt: string | null;
          webhookId: number | null;
        }>;
      };
      if (!d.subscriptions.length) return "## Credit Thresholds\n\nNone registered.";
      const lines = ["## Credit Thresholds\n"];
      for (const s of d.subscriptions) {
        lines.push(
          `**#${s.id}** ${formatBps(BigInt(s.thresholdBps))} — state: ${s.lastState}` +
          (s.webhookId !== null ? ` (pinned webhook ${s.webhookId})` : "") +
          (s.lastFiredAt ? ` (last fired ${s.lastFiredAt})` : ""),
        );
      }
      return lines.join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error listing thresholds: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── register_credit_threshold ───────────────────────────────────────────

  @CreateAction({
    name: "register_credit_threshold",
    description:
      "Register a credit-utilization threshold. When utilizationBps crosses thresholdBps from below, " +
      "the agent's webhook receives credit.warning (or credit.at_limit if >= 9500). Drops below → credit.recovered. " +
      "Cap of 20 thresholds per agent.",
    schema: RegisterCreditThresholdSchema,
  })
  async registerCreditThreshold(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof RegisterCreditThresholdSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/agents/credit-thresholds", {
        method: "POST",
        body: JSON.stringify({
          thresholdBps: args.thresholdBps,
          ...(args.webhookId !== undefined ? { webhookId: args.webhookId } : {}),
        }),
      });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as {
        id: number;
        thresholdBps: number;
        lastState: string;
        webhookId: number | null;
      };
      return [
        "## Credit Threshold Registered\n",
        `**#${d.id}** at ${formatBps(BigInt(d.thresholdBps))} — state: ${d.lastState}` +
          (d.webhookId !== null ? ` (pinned webhook ${d.webhookId})` : " (fanout to all credit.* webhooks)"),
      ].join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error registering threshold: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── delete_credit_threshold ─────────────────────────────────────────────

  @CreateAction({
    name: "delete_credit_threshold",
    description: "Delete one of the agent's credit-utilization thresholds by id (from list_credit_thresholds).",
    schema: DeleteCreditThresholdSchema,
  })
  async deleteCreditThreshold(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof DeleteCreditThresholdSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch(`/agents/credit-thresholds/${args.id}`, { method: "DELETE" });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      return `## Credit Threshold Deleted\n\nThreshold #${args.id} removed.`;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error deleting threshold: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── estimate_x402_cost ──────────────────────────────────────────────────

  @CreateAction({
    name: "estimate_x402_cost",
    description:
      "Preflight an x402-protected URL and return its USDC cost without paying. Reflects against the " +
      "calling agent's available credit and session spend-limit so you can decide gating in one round-trip. " +
      "Use BEFORE x402_fetch.",
    schema: EstimateX402CostSchema,
  })
  async estimateX402Cost(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof EstimateX402CostSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/x402/estimate", {
        method: "POST",
        body: JSON.stringify({ url: args.url, method: args.method }),
      });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as {
        url: string;
        method: string;
        x402: boolean;
        priceRaw?: string;
        asset?: string;
        network?: string;
        payTo?: string;
        cached: boolean;
        reflection?: {
          available: string;
          willExceedAvailable: boolean;
          willExceedHeadroom: boolean;
          willExceedSpendLimit: boolean;
        };
      };
      if (!d.x402) {
        return `## x402 Estimate\n\n**${d.method} ${d.url}** is not x402-protected — no payment required.`;
      }
      const usdc = 6;
      const asset = (d.asset ?? "USDC").toUpperCase();
      const formattedPrice =
        asset === "USDC"
          ? formatTokenAmount(BigInt(d.priceRaw ?? "0"), usdc, "USDC")
          : `${d.priceRaw ?? "0"} ${asset} (raw units)`;
      const lines = [
        "## x402 Estimate\n",
        `**${d.method} ${d.url}**`,
        `**Price**: ${formattedPrice}`,
        `**Network**: ${d.network ?? "—"}`,
        `**Pay To**: ${d.payTo ? formatAddress(d.payTo) : "—"}`,
        `**Cached**: ${d.cached ? "yes" : "no"}`,
      ];
      if (d.reflection) {
        const r = d.reflection;
        lines.push(
          "",
          "### Decision",
          `**Available**: ${formatTokenAmount(BigInt(r.available), usdc, "USDC")}`,
          `**Would exceed available?**: ${r.willExceedAvailable ? "YES — DO NOT CALL" : "no"}`,
          `**Would exceed auto-borrow headroom?**: ${r.willExceedHeadroom ? "YES" : "no"}`,
          `**Would exceed session spend-limit?**: ${r.willExceedSpendLimit ? "YES — DO NOT CALL" : "no"}`,
        );
      }
      return lines.join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error estimating cost: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export const x402ActionProvider = (config?: Partial<X402Config>) =>
  new X402ActionProvider(config);
