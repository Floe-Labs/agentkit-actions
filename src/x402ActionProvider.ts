import {
  ActionProvider,
  CreateAction,
  EvmWalletProvider,
  Network,
} from "@coinbase/agentkit";
import { encodeFunctionData } from "viem";
import { z } from "zod";
import {
  BASE_MAINNET_MATCHER,
  USDC_USDC_MAX_ORIGINATION_LTV_BPS,
} from "./constants.js";
import type { Address } from "./types.js";
import { formatBps, formatTokenAmount, formatAddress, formatDuration } from "./utils.js";
import { buildProxyResponseNote } from "./proxyNote.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address");

const NonNegIntString = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "Must be a non-negative integer");

export const GrantCreditDelegationSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9 _-]+$/)
    .describe(
      "Human-friendly label for this agent (e.g. 'alpha', 'paid-search-bot'). " +
        "Unique per developer. Used by the CLI/dashboard to identify the agent later.",
    ),
  facilitatorUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "Must use HTTPS")
    .describe("The facilitator API base URL (e.g. https://credit-api.floelabs.xyz)"),
  borrowLimit: NonNegIntString.describe("Maximum borrow limit in USDC (e.g. '10000' for $10K)"),
  maxRateBps: NonNegIntString.default("1500")
    .refine((v) => BigInt(v) <= 10000n, "Must be <= 10000 basis points")
    .describe("Maximum interest rate in basis points (e.g. '1500' = 15%)"),
  expiryDays: NonNegIntString.default("90")
    .refine((v) => { const d = BigInt(v); return d >= 1n && d <= 3650n; }, "Must be 1-3650 days")
    .describe("Number of days until delegation expires"),
});

export const OpenCreditLineSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9 _-]+$/)
    .describe(
      "The agent name from `grant_credit_delegation` / `floe-agent register`. Must already exist server-side.",
    ),
  facilitatorUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "Must use HTTPS")
    .describe("The facilitator API base URL (e.g. https://credit-api.floelabs.xyz)"),
  /** The Privy wallet's USDC deposit, e.g. "10000" for $10K. Borrow amount = deposit * maxLtvBps / 10000. */
  depositUsdc: NonNegIntString.describe("USDC deposit amount (e.g. '10000' for $10K)"),
  maxLtvBps: z
    .number()
    .int()
    .min(1)
    .max(USDC_USDC_MAX_ORIGINATION_LTV_BPS)
    .default(9500)
    .describe(
      `Optional LTV cap (1..${USDC_USDC_MAX_ORIGINATION_LTV_BPS}) for the USDC/USDC credit line. Default 9500 (95%) — the conservative origination ceiling with ~5% headroom for interest accrual before liquidation. Values 9501..${USDC_USDC_MAX_ORIGINATION_LTV_BPS} enable the aggressive mode, only safe for short-duration loans that you repay on a tight cadence: at ${USDC_USDC_MAX_ORIGINATION_LTV_BPS} with a 12% APR loan there is only 50bps of headroom to the 9950bps liquidation threshold, which interest closes in roughly 15 days.`,
    ),
  /** Optional agent id override — the CLI persists this in `.floe-agent.json`, so most callers don't need to supply it. */
  agentId: z.number().int().positive().optional().describe(
    "Server-issued numeric agent id (from POST /v1/developer/agents). Pass when not already known.",
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

export const X402AwaitSettlementSchema = z.object({
  nonce: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Reservation nonce returned in the 502 body when x402_fetch failed with " +
        "`upstream_paid_request_failed_ambiguous`. The settlement helper polls until " +
        "the reservation reaches a terminal state (settled | payment_rejected | expired_unsettled).",
    ),
  intervalSeconds: z
    .number()
    .positive()
    .max(60)
    .default(2)
    .describe("Polling interval in seconds (default 2)."),
  timeoutSeconds: z
    .number()
    .positive()
    .max(3600)
    .default(900)
    .describe("Maximum time to wait in seconds before giving up (default 900 = 15 min)."),
});

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

// ── Merchant allowlist schemas (D1 feature; TS parity, D9) ──────────────────
// An allowlist "entry" is an ordinary agent policy row (kind='api' for hosts,
// kind='vendor' for payees) that doubles as "allowed AND capped". The mode flag
// toggles which proxy gates enforce them. 'off' (the default) = allow any vendor.

export const SetAllowlistModeSchema = z.object({
  mode: z
    .enum(["off", "host", "vendor", "both"])
    .describe(
      "Allowlist enforcement mode. 'off' = allow any vendor (default, no friction). " +
        "'host' = default-deny unlisted hosts pre-fetch. 'vendor' = default-deny unlisted " +
        "payees pre-sign. 'both' = enforce host AND payee gates.",
    ),
});

export const GetAllowlistModeSchema = z.object({});

export const AddAllowlistEntrySchema = z.object({
  kind: z
    .enum(["api", "vendor"])
    .describe(
      "'api' for a host allowlist entry (matchKey = hostname) or 'vendor' for a payee " +
        "allowlist entry (matchKey = recipient wallet address).",
    ),
  matchKey: z
    .string()
    .min(1)
    .max(255)
    .describe("Host (for kind='api') or payee wallet address (for kind='vendor')."),
  limitRaw: z
    .string()
    .regex(/^[1-9]\d*$/, "Must be a positive integer (raw USDC, 6 decimals)")
    .describe("Spend cap for this entry in raw USDC units (6 decimals). e.g. '1000000' = $1."),
  matchKind: z
    .enum(["host_exact", "host_suffix", "recipient"])
    .optional()
    .describe(
      "Optional matcher: 'host_exact' | 'host_suffix' (api) or 'recipient' (vendor). " +
        "Defaults server-side (api → host_suffix, vendor → recipient).",
    ),
});

export const RemoveAllowlistEntrySchema = z.object({
  policyId: z
    .number()
    .int()
    .positive()
    .describe("Policy id of the allowlist entry (from list_allowlist)."),
});

export const ListAllowlistSchema = z.object({});

// ── ABI fragments for operator functions ────────────────────────────────────

const OPERATOR_ABI = [
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
  /**
   * Optional human-readable label for the active agent. Surfaced in
   * action output when present so multi-agent CLI sessions are easy
   * to disambiguate. Doesn't affect auth — the API key alone identifies
   * the agent server-side.
   */
  agentName?: string;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class X402ActionProvider extends ActionProvider<EvmWalletProvider> {
  private matcherAddress: Address;
  private defaultFacilitatorUrl: string;
  private defaultFacilitatorApiKey: string;
  private agentName: string;

  constructor(config?: Partial<X402Config>) {
    super("x402", []);
    this.matcherAddress = (config?.matcherAddress ?? BASE_MAINNET_MATCHER) as Address;
    // Normalize: strip trailing slash
    this.defaultFacilitatorUrl = (config?.facilitatorUrl ?? "").replace(/\/+$/, "");
    this.defaultFacilitatorApiKey = config?.facilitatorApiKey ?? "";
    this.agentName = config?.agentName ?? "";
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

    // When the caller supplies its own wallet-signature auth (the
    // grant_credit_delegation action signs X-Wallet-Address / X-Signature /
    // X-Timestamp directly), skip the cached Bearer to avoid double-auth.
    // The server accepts whichever it sees first, and a stale Bearer from
    // a previous successful registration would otherwise silently misroute
    // a re-invocation of grant_credit_delegation to the wrong identity.
    //
    // Use the Headers constructor so we get case-insensitive lookup that
    // also handles the Headers / tuple-array forms of HeadersInit. A plain
    // `"X-Signature" in headers` check would silently miss those shapes
    // and re-introduce the double-auth landmine.
    const callerSigned = new Headers(options?.headers ?? {}).has("X-Signature");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey && !callerSigned ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(options?.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── grant_credit_delegation ─────────────────────────────────────────────

  @CreateAction({
    name: "grant_credit_delegation",
    description:
      "Register a new Floe credit agent. Floe creates a managed Privy wallet for the agent, " +
      "delegates the facilitator on-chain server-side, and returns a scoped API key. " +
      "You set a name, maximum borrow limit, interest rate cap, and expiry. " +
      "The developer wallet is only used to sign the auth headers — no on-chain transactions are sent. " +
      "The returned API key is stored for the rest of this session and used by every other x402 action. " +
      "For multi-agent setups, prefer the CLI: `floe-agent register --name <name>` (stores the key in the OS keychain).",
    schema: GrantCreditDelegationSchema,
  })
  async grantCreditDelegation(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GrantCreditDelegationSchema>,
  ): Promise<string> {
    try {
      const facilitatorUrl = args.facilitatorUrl.replace(/\/+$/, "");
      const usdcDecimals = 6;
      const borrowLimitRaw = (BigInt(args.borrowLimit) * BigInt(10 ** usdcDecimals)).toString();
      const maxRateBpsNum = Number(args.maxRateBps);
      const expirySeconds = Number(args.expiryDays) * 86400;

      const authHeaders = await this.buildSignedHeaders(walletProvider);

      // Step 1: create the managed agent. Server provisions Privy wallet
      // + setOperator() delegation in-flight; we just wait for the result.
      const createResp = await this.facilitatorFetch(
        "/v1/developer/agents",
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            name: args.name,
            borrowLimitRaw,
            maxRateBps: maxRateBpsNum,
            expirySeconds,
          }),
        },
        facilitatorUrl,
      );

      if (!createResp.ok) {
        const err = (await createResp.json().catch(() => ({}))) as { error?: string; detail?: string };
        return `Agent creation failed: ${err.detail ?? err.error ?? createResp.statusText}`;
      }
      const created = (await createResp.json()) as {
        agentId: number;
        status: string;
        privyWalletAddress: string;
        delegationTxHash: string;
      };

      // Step 2: mint an API key for the freshly-created agent. Auth
      // headers expire after 5 minutes, so we re-sign rather than reuse.
      const keyHeaders = await this.buildSignedHeaders(walletProvider);
      const keyResp = await this.facilitatorFetch(
        `/v1/developer/agents/${created.agentId}/keys`,
        {
          method: "POST",
          headers: keyHeaders,
          body: JSON.stringify({ label: args.name }),
        },
        facilitatorUrl,
      );
      if (!keyResp.ok) {
        const err = (await keyResp.json().catch(() => ({}))) as { error?: string; detail?: string };
        return (
          `Agent created (id=${created.agentId}) but key minting failed: ${err.detail ?? err.error ?? keyResp.statusText}. ` +
          `Mint a key via the dashboard or \`floe-agent rotate ${args.name}\` to recover.`
        );
      }
      const keyBody = (await keyResp.json()) as { key: string; keyPrefix: string };

      // Store for subsequent calls in this session.
      this.defaultFacilitatorApiKey = keyBody.key;
      this.defaultFacilitatorUrl = facilitatorUrl;
      this.agentName = args.name;

      const keyPreview = keyBody.key.slice(-4);
      return [
        "## Floe Agent Registered\n",
        `**Name**: ${args.name}`,
        `**Agent ID**: ${created.agentId}`,
        `**Status**: ${created.status}`,
        `**Privy Wallet**: ${formatAddress(created.privyWalletAddress)}`,
        `**Credit Limit**: ${formatTokenAmount(BigInt(borrowLimitRaw), usdcDecimals, "USDC")}`,
        `**Max Rate**: ${formatBps(BigInt(args.maxRateBps))} APR`,
        `**Expires**: ${formatDuration(BigInt(args.expiryDays) * 86400n)}`,
        `**Delegation tx**: ${created.delegationTxHash}`,
        "",
        `> API key stored for this session (ending ...${keyPreview}).`,
        "> For persistent storage across sessions, prefer `floe-agent register --name " +
          args.name +
          "` from the CLI — it saves the key to your OS keychain.",
        "",
        `> **Next step:** the agent's Privy wallet has no USDC yet, so its credit line is not yet open.`,
        `> Fund the Privy wallet (\`${created.privyWalletAddress}\`) with USDC, then call \`open_credit_line\``,
        `> (or \`floe-agent open-credit-line --name ${args.name} --deposit <usdc>\` from the CLI).`,
      ].join("\n");
    } catch (e) {
      return `Error registering Floe agent: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── open_credit_line ────────────────────────────────────────────────────

  @CreateAction({
    name: "open_credit_line",
    description:
      "Open the USDC/USDC credit line for a previously-registered Floe agent. The agent's Privy wallet " +
      "must already hold at least `depositUsdc` USDC (fund it via the dashboard's Coinbase on-ramp or a " +
      "direct on-chain transfer first). Floe server-signs the borrow intent FROM the agent's Privy wallet; " +
      "the solver matches it asynchronously and the agent's spendable credit becomes non-zero a few seconds later. " +
      "Returns the on-chain registerTxHash + a placeholder loanId. For multi-agent setups, prefer the CLI: " +
      "`floe-agent open-credit-line --name <name> --deposit <usdc>`.",
    schema: OpenCreditLineSchema,
  })
  async openCreditLine(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof OpenCreditLineSchema>,
  ): Promise<string> {
    try {
      const facilitatorUrl = args.facilitatorUrl.replace(/\/+$/, "");
      const usdcDecimals = 6;
      const depositRaw = (BigInt(args.depositUsdc) * BigInt(10 ** usdcDecimals)).toString();
      if (BigInt(depositRaw) <= 0n) {
        return `Invalid depositUsdc: ${args.depositUsdc}. Must be > 0.`;
      }

      // If the caller didn't pass an explicit agent id, list their agents
      // and find one matching the requested name. The list endpoint accepts
      // the same wallet-signature auth we already build below.
      let agentId = args.agentId;
      if (!agentId) {
        const listHeaders = await this.buildSignedHeaders(walletProvider);
        const listResp = await this.facilitatorFetch(
          "/v1/developer/agents",
          { method: "GET", headers: listHeaders },
          facilitatorUrl,
        );
        if (!listResp.ok) {
          const err = (await listResp.json().catch(() => ({}))) as { error?: string; detail?: string };
          return `Failed to list agents: ${err.detail ?? err.error ?? listResp.statusText}`;
        }
        const body = (await listResp.json()) as { agents: Array<{ id: number; name: string }> };
        const match = body.agents.find((a) => a.name === args.name);
        if (!match) {
          return (
            `No agent named "${args.name}" found for this developer. ` +
            `Register one with \`grant_credit_delegation\` first.`
          );
        }
        agentId = match.id;
      }

      const openHeaders = await this.buildSignedHeaders(walletProvider);
      const openResp = await this.facilitatorFetch(
        `/v1/developer/agents/${agentId}/open-credit-line`,
        {
          method: "POST",
          headers: openHeaders,
          body: JSON.stringify({
            depositRaw,
            maxLtvBps: args.maxLtvBps,
          }),
        },
        facilitatorUrl,
      );
      if (!openResp.ok) {
        const err = (await openResp.json().catch(() => ({}))) as { error?: string; detail?: string };
        return `Open credit line failed: ${err.detail ?? err.error ?? openResp.statusText}`;
      }
      const result = (await openResp.json()) as {
        loanId: string;
        registerTxHash: string;
        approveTxHash: string | null;
        principalRaw: string;
        collateralAmountRaw: string;
        status: string;
      };

      const lines = [
        "## Credit Line Submitted\n",
        `**Agent**: ${args.name} (id=${agentId})`,
        `**Deposit**: ${formatTokenAmount(BigInt(result.collateralAmountRaw), usdcDecimals, "USDC")}`,
        `**Borrow**: ${formatTokenAmount(BigInt(result.principalRaw), usdcDecimals, "USDC")}`,
        `**Register tx**: ${result.registerTxHash}`,
      ];
      if (result.approveTxHash) {
        lines.push(`**Approve tx**: ${result.approveTxHash}`);
      }
      lines.push(
        "",
        `> Status: \`${result.status}\`. The solver matches against an open lend offer asynchronously;`,
        `> spendable credit (\`creditIn\`) becomes non-zero once status flips to \`active\` (usually a few seconds).`,
      );
      return lines.join("\n");
    } catch (e) {
      return `Error opening credit line: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * EIP-191 wallet-signed auth headers for the Floe Developer API.
   * Message format MUST match middleware/auth.ts:47 server-side.
   */
  private async buildSignedHeaders(
    walletProvider: EvmWalletProvider,
  ): Promise<Record<string, string>> {
    const address = await walletProvider.getAddress();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `Floe Credit API\nTimestamp: ${timestamp}`;
    const signature = await walletProvider.signMessage(message);
    return {
      "X-Wallet-Address": address,
      "X-Signature": signature,
      "X-Timestamp": timestamp,
      "Content-Type": "application/json",
    };
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

      // Confirm the revocation landed on-chain (parity with the PY SDK):
      // a fire-and-forget tx hash would let a silently-reverted revoke
      // read as success while the facilitator can still borrow.
      const agentAddress = await walletProvider.getAddress();
      const perm = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: OPERATOR_ABI,
        functionName: "getOperatorPermission",
        args: [agentAddress as `0x${string}`, args.facilitatorAddress as `0x${string}`],
      })) as { approved: boolean };
      if (perm.approved) {
        return `Warning: revokeOperator tx sent (${txHash}) but the delegation still shows approved. It may not have confirmed yet — re-check with \`check_credit_delegation\`.`;
      }

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
      const resp = await this.facilitatorFetch("/v1/proxy/fetch", {
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
        const errorObj = err as { error?: string; detail?: string; reservation?: { nonce?: string; validBefore?: number } };
        const errorMap: Record<string, string> = {
          funding_in_progress: "Funding in progress — the facilitator is borrowing funds. Retry in 30 seconds.",
          credit_frozen: "Credit frozen — your collateral health ratio is too low.",
          insufficient_balance: "Insufficient credit — your credit line is fully utilized.",
          account_closed: "Account closed — no further payments.",
        };
        // FLO-567: a 502 ambiguous response carries the reservation nonce.
        // Surface it so the LLM can call `x402_await_settlement` to resolve
        // the in-flight state, instead of retrying (which would double-charge).
        if (errorObj.error === "upstream_paid_request_failed_ambiguous" && errorObj.reservation?.nonce) {
          return [
            "Payment is in-flight but the upstream response is ambiguous (HTTP 502). ",
            "DO NOT retry — that may double-charge. Use `x402_await_settlement` with this nonce to resolve:\n",
            `**nonce**: \`${errorObj.reservation.nonce}\``,
            errorObj.detail ? `\n\n_Detail: ${errorObj.detail}_` : "",
          ].join("");
        }
        return errorMap[errorObj.error ?? ""] ?? `Facilitator error: ${errorObj.error ?? resp.statusText}`;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const body = contentType.includes("json")
        ? JSON.stringify(await resp.json(), null, 2)
        : await resp.text();

      return buildProxyResponseNote(resp.headers, body);
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
      "Check your x402 credit status: spendable USDC (what you can pay with right now), " +
      "borrowing headroom (how much more you could draw from your credit line), " +
      "on-chain wallet USDC, active loans, and delegation state.",
    schema: X402GetBalanceSchema,
  })
  async x402GetBalance(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof X402GetBalanceSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/v1/agents/balance");
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return `Error: ${(err as { error?: string }).error ?? resp.statusText}`;
      }

      const data = (await resp.json()) as {
        // Legacy fields (kept by facilitator for back-compat).
        balance?: string;
        creditLimit: string;
        creditUsed: string;
        creditAvailable: string;
        // FLO-567 explicit fields.
        spendableRaw?: string;
        creditAvailableRaw?: string;
        walletUsdcRaw?: string | null;
        pendingSettlementsRaw?: string;
        pendingSettlements?: string;
        heldUnspentRaw?: string;
        activeLoans?: Array<{ loanId: string; principalRaw?: string }>;
        delegationActive?: boolean;
      };

      const usdcDecimals = 6;
      const spendableRaw = data.spendableRaw ?? data.balance ?? "0";
      const creditAvailableRaw = data.creditAvailableRaw ?? data.creditAvailable ?? "0";
      const pendingRaw = data.pendingSettlementsRaw ?? data.pendingSettlements ?? "0";

      const fmt = (raw: string) => formatTokenAmount(BigInt(raw || "0"), usdcDecimals, "USDC");
      const lines = [
        "## x402 Credit Status\n",
        `**Spendable now**: ${fmt(spendableRaw)} — what you can pay with right now.`,
        `**Borrowing headroom**: ${fmt(creditAvailableRaw)} — how much more you could draw from your credit line.`,
      ];
      if (data.walletUsdcRaw !== undefined && data.walletUsdcRaw !== null) {
        lines.push(`**Wallet USDC (on-chain)**: ${fmt(data.walletUsdcRaw)}`);
      }
      if (data.heldUnspentRaw && data.heldUnspentRaw !== "0") {
        lines.push(`**Held unspent**: ${fmt(data.heldUnspentRaw)} — reserved but not yet settled.`);
      }
      lines.push(
        `**Credit Limit**: ${fmt(data.creditLimit)}`,
        `**Credit Used**: ${fmt(data.creditUsed)}`,
      );
      if (pendingRaw !== "0") {
        lines.push(`**Pending settlement**: ${fmt(pendingRaw)} — use \`x402_await_settlement\` to resolve.`);
      }
      lines.push(
        `**Active Loans**: ${data.activeLoans?.length ?? 0}`,
        `**Delegation Active**: ${data.delegationActive ? "Yes" : "No"}`,
      );
      return lines.join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error fetching balance: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── x402_await_settlement ───────────────────────────────────────────────
  //
  // FLO-567: when `x402_fetch` returns a 502 `upstream_paid_request_failed_ambiguous`,
  // the reservation is in `pending_settlement` and gets resolved by background
  // reconciliation. This action polls the per-reservation endpoint until it
  // reaches a terminal state (settled | payment_rejected | expired_unsettled).

  @CreateAction({
    name: "x402_await_settlement",
    description:
      "Poll the facilitator until a pending x402 reservation reaches a terminal state. " +
      "Use this AFTER an `x402_fetch` call returned a 502 ambiguous error with a nonce — " +
      "do NOT retry the original call (that may double-charge). Resolves with the final " +
      "state: settled (paid on-chain), payment_rejected (credit released), or " +
      "expired_unsettled (authorization expired; treat as may-or-may-not have charged).",
    schema: X402AwaitSettlementSchema,
  })
  async x402AwaitSettlement(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof X402AwaitSettlementSchema>,
  ): Promise<string> {
    // Honor the caller's requested timeout even when smaller than the
    // polling interval — the in-loop Math.min(intervalMs, remaining)
    // already caps each sleep so we never overshoot the deadline.
    const intervalMs = Math.max(100, Math.floor(args.intervalSeconds * 1000));
    const timeoutMs = Math.max(100, Math.floor(args.timeoutSeconds * 1000));
    const deadline = Date.now() + timeoutMs;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const resp = await this.facilitatorFetch(
          `/v1/agents/reservations/${encodeURIComponent(args.nonce)}`,
        );
        if (resp.status === 404) {
          return `Reservation \`${args.nonce}\` not found. Verify the nonce belongs to this agent and was issued recently.`;
        }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: resp.statusText }));
          return `Error polling reservation: ${(err as { error?: string }).error ?? resp.statusText}`;
        }
        const status = (await resp.json()) as {
          nonce: string;
          state: string;
          terminal: boolean;
          txHash: string | null;
          paymentAmountRaw: string;
          settledAt: string | null;
        };
        if (status.terminal) {
          // State-aware heading so a `payment_rejected` or `expired_unsettled`
          // outcome doesn't read as a successful settlement to the LLM.
          const heading =
            status.state === "settled"
              ? "## Reservation settled"
              : status.state === "payment_rejected"
                ? "## Reservation rejected (credit released)"
                : status.state === "expired_unsettled"
                  ? "## Reservation expired (may or may not have charged upstream)"
                  : `## Reservation ${status.state}`;
          const lines = [
            `${heading}\n`,
            `**State**: \`${status.state}\``,
            `**Nonce**: \`${status.nonce}\``,
            `**Amount**: ${formatTokenAmount(BigInt(status.paymentAmountRaw || "0"), 6, "USDC")}`,
          ];
          if (status.txHash) lines.push(`**Tx**: \`${status.txHash}\``);
          if (status.settledAt) lines.push(`**Settled at**: ${status.settledAt}`);
          return lines.join("\n");
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return `Timed out after ${args.timeoutSeconds}s waiting for reservation \`${args.nonce}\` to settle (last state: \`${status.state}\`). Call this action again to resume waiting.`;
        }
        await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
      }
    } catch (e) {
      // Mirror the other x402 actions: a transient facilitator/network
      // failure during polling should return a re-try hint rather than
      // throwing out of the tool call, so the agent can call this action
      // again with the same nonce instead of dropping the in-flight state.
      if (e instanceof Error && e.name === "AbortError") {
        return `Facilitator request timed out while polling reservation \`${args.nonce}\`. Call this action again to resume waiting.`;
      }
      const msg = e instanceof Error ? e.message : String(e);
      return `Error polling reservation \`${args.nonce}\`: ${msg}. Call this action again to resume waiting.`;
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
      const resp = await this.facilitatorFetch(`/v1/agents/transactions?limit=${limit}`);
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
      const resp = await this.facilitatorFetch("/v1/agents/credit-remaining");
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
      const resp = await this.facilitatorFetch("/v1/agents/loan-state");
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
      const resp = await this.facilitatorFetch("/v1/agents/spend-limit");
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
      const resp = await this.facilitatorFetch("/v1/agents/spend-limit", {
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
      const resp = await this.facilitatorFetch("/v1/agents/spend-limit", { method: "DELETE" });
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
      const resp = await this.facilitatorFetch("/v1/agents/credit-thresholds");
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
      const resp = await this.facilitatorFetch("/v1/agents/credit-thresholds", {
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
      const resp = await this.facilitatorFetch(`/v1/agents/credit-thresholds/${args.id}`, { method: "DELETE" });
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
      const resp = await this.facilitatorFetch("/v1/x402/estimate", {
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

  // ════════════════════════════════════════════════════════════════════════
  // MERCHANT ALLOWLIST (5) — opt-in, default-deny host (pre-fetch) and payee
  // (post-402, pre-sign) gating. Default mode 'off' = allow any vendor. All
  // require facilitatorApiKey (agent-key auth) like the awareness actions.
  // ════════════════════════════════════════════════════════════════════════

  // ── set_allowlist_mode ──────────────────────────────────────────────────

  @CreateAction({
    name: "set_allowlist_mode",
    description:
      "Set the agent's merchant-allowlist enforcement mode: off | host | vendor | both. " +
      "'off' (default) allows any vendor. 'host' blocks unlisted hosts before the first " +
      "fetch; 'vendor' blocks unlisted payees before signing; 'both' enforces both. " +
      "Allowlist entries themselves are managed with add_allowlist_entry.",
    schema: SetAllowlistModeSchema,
  })
  async setAllowlistMode(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof SetAllowlistModeSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/v1/agents/allowlist-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: args.mode }),
      });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as { mode: string };
      return `## Allowlist Mode Set\n\n**Mode**: \`${d.mode ?? args.mode}\``;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error setting allowlist mode: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── get_allowlist_mode ──────────────────────────────────────────────────

  @CreateAction({
    name: "get_allowlist_mode",
    description:
      "Return the agent's current merchant-allowlist enforcement mode (off | host | vendor | both).",
    schema: GetAllowlistModeSchema,
  })
  async getAllowlistMode(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof GetAllowlistModeSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/v1/agents/allowlist-mode");
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as { mode: string };
      return `## Allowlist Mode\n\n**Mode**: \`${d.mode ?? "off"}\``;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error fetching allowlist mode: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── add_allowlist_entry ─────────────────────────────────────────────────

  @CreateAction({
    name: "add_allowlist_entry",
    description:
      "Add a merchant-allowlist entry — an allowed-AND-capped policy row. Use kind='api' to " +
      "allowlist a host (matchKey = hostname) or kind='vendor' to allowlist a payee " +
      "(matchKey = recipient wallet). limitRaw caps spend against this entry (raw USDC, 6 " +
      "decimals). Enforcement only kicks in once set_allowlist_mode is host/vendor/both.",
    schema: AddAllowlistEntrySchema,
  })
  async addAllowlistEntry(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof AddAllowlistEntrySchema>,
  ): Promise<string> {
    // Kind-aware cross-field validation: the flat schema allows incoherent
    // combos (e.g. a vendor entry whose matchKey is a hostname, or an api
    // entry asking for the 'recipient' matcher). Reject those before the
    // round-trip. Reuse the existing AddressSchema for the payee check.
    if (args.kind === "vendor") {
      if (!AddressSchema.safeParse(args.matchKey).success) {
        return "Error: kind='vendor' requires matchKey to be a payee wallet address (0x + 40 hex).";
      }
      if (args.matchKind !== undefined && args.matchKind !== "recipient") {
        return "Error: kind='vendor' only supports matchKind='recipient'.";
      }
    } else {
      // kind === 'api' (host entry)
      if (
        args.matchKind !== undefined &&
        args.matchKind !== "host_exact" &&
        args.matchKind !== "host_suffix"
      ) {
        return "Error: kind='api' only supports matchKind='host_exact' or 'host_suffix'.";
      }
    }
    try {
      const body: Record<string, unknown> = {
        kind: args.kind,
        matchKey: args.matchKey,
        limitRaw: args.limitRaw,
      };
      if (args.matchKind) body.matchKind = args.matchKind;
      const resp = await this.facilitatorFetch("/v1/agents/policies", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as {
        policy: { id: number; kind: string; matchKey: string; limitRaw: string };
      };
      const p = d.policy;
      return [
        "## Allowlist Entry Added\n",
        `**#${p.id}** ${p.kind} — \`${p.matchKey}\``,
        `**Cap**: ${formatTokenAmount(BigInt(p.limitRaw ?? args.limitRaw), 6, "USDC")}`,
      ].join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error adding allowlist entry: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── remove_allowlist_entry ──────────────────────────────────────────────

  @CreateAction({
    name: "remove_allowlist_entry",
    description:
      "Remove (revoke) a merchant-allowlist entry by policy id (from list_allowlist).",
    schema: RemoveAllowlistEntrySchema,
  })
  async removeAllowlistEntry(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof RemoveAllowlistEntrySchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch(`/v1/agents/policies/${args.policyId}`, {
        method: "DELETE",
      });
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      return `## Allowlist Entry Removed\n\nEntry #${args.policyId} revoked.`;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error removing allowlist entry: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── list_allowlist ──────────────────────────────────────────────────────

  @CreateAction({
    name: "list_allowlist",
    description:
      "List the agent's merchant-allowlist entries (host 'api' and payee 'vendor' policies) " +
      "with their spend caps. Does not include session/task spend policies.",
    schema: ListAllowlistSchema,
  })
  async listAllowlist(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof ListAllowlistSchema>,
  ): Promise<string> {
    try {
      const resp = await this.facilitatorFetch("/v1/agents/policies");
      const result = await this.readJsonOrError(resp);
      if (!result.ok) return `Error: ${result.msg}`;
      const d = result.data as {
        policies: Array<{
          id: number;
          kind: string;
          matchKey: string;
          matchKind: string | null;
          limitRaw: string;
        }>;
      };
      const entries = (d.policies ?? []).filter(
        (p) => p.kind === "api" || p.kind === "vendor",
      );
      if (!entries.length) return "## Allowlist\n\nNo host/payee allowlist entries.";
      const lines = ["## Allowlist\n"];
      for (const p of entries) {
        const cap = formatTokenAmount(BigInt(p.limitRaw ?? "0"), 6, "USDC");
        lines.push(
          `**#${p.id}** ${p.kind} — \`${p.matchKey}\` ` +
            `(matchKind ${p.matchKind ?? "—"}) — cap ${cap}`,
        );
      }
      return lines.join("\n");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "Request timed out.";
      return `Error listing allowlist: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export const x402ActionProvider = (config?: Partial<X402Config>) =>
  new X402ActionProvider(config);
