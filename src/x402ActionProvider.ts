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
      "Bounded collateral allowance to grant the matcher (raw token units). " +
      "Mutually exclusive with `unsafeInfiniteApproval`. " +
      "If neither field is set, no approve tx is sent — call `approve_token` separately " +
      "before any facilitator-initiated borrow can succeed.",
    ),
  unsafeInfiniteApproval: z.boolean().optional()
    .describe(
      "Opt in to unlimited (MAX_UINT256) collateral approval to the matcher. " +
      "Saves one approve() per top-up but means a matcher compromise can drain " +
      "your full collateral token balance. Mutually exclusive with `collateralApproval`.",
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
      // Reject incoherent approval combinations before any side effects (no
      // facilitator pre-register, no on-chain setOperator). The schema accepts
      // both fields so existing callers don't get a validation error from the
      // framework; the choice is enforced here.
      if (args.collateralApproval !== undefined && args.unsafeInfiniteApproval) {
        return "Cannot set both `collateralApproval` and `unsafeInfiniteApproval` — pick one.";
      }

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

      // Step 3: Approve collateral. The approve step is skipped unless the
      // caller opts in explicitly. Previously this defaulted to MAX_UINT256,
      // which silently granted the matcher unlimited spend power on every
      // delegation grant. Now the caller picks one of:
      //   unsafeInfiniteApproval=true → MAX_UINT256
      //   collateralApproval=<raw>    → exact bounded amount
      //   neither set                 → no approve tx (caller handles via approve_token)
      let approveTxHash: string | null = null;
      if (args.unsafeInfiniteApproval) {
        const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        approveTxHash = await this.ensureAllowance(
          walletProvider,
          args.collateralToken as Address,
          this.matcherAddress,
          MAX_UINT256,
        );
      } else if (args.collateralApproval !== undefined) {
        approveTxHash = await this.ensureAllowance(
          walletProvider,
          args.collateralToken as Address,
          this.matcherAddress,
          BigInt(args.collateralApproval),
        );
      }
      const approvalRequested = args.unsafeInfiniteApproval === true || args.collateralApproval !== undefined;

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
        approvalRequested
          ? (approveTxHash ? `**Approval tx**: ${approveTxHash}` : "**Approval**: Already sufficient")
          : "**Approval**: NOT SET — facilitator-initiated borrows will fail until you grant an allowance. " +
            "Call `approve_token`, or re-run with `collateralApproval=<raw>` or `unsafeInfiniteApproval=true`.",
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
}

// ── Factory ─────────────────────────────────────────────────────────────────

export const x402ActionProvider = (config?: Partial<X402Config>) =>
  new X402ActionProvider(config);
