import {
  ActionProvider,
  CreateAction,
  EvmWalletProvider,
  Network,
} from "@coinbase/agentkit";
import { encodeFunctionData } from "viem";
import { z } from "zod";
import { LENDING_MATCHER_ABI, ERC20_ABI, BASIS_POINTS, BASE_MAINNET_MATCHER } from "./constants.js";
import type { Address } from "./types.js";
import { formatBps, formatTokenAmount, formatAddress, formatDuration } from "./utils.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address");

export const GrantCreditDelegationSchema = z.object({
  facilitatorAddress: AddressSchema.describe("The facilitator's operator address"),
  facilitatorUrl: z.string().url().describe("The facilitator API base URL (e.g. https://x402.floe.xyz)"),
  borrowLimit: z.string().describe("Maximum borrow limit in USDC (e.g. '10000' for $10K)"),
  maxRateBps: z.string().default("1500").describe("Maximum interest rate in basis points (e.g. '1500' = 15%)"),
  expiryDays: z.string().default("90").describe("Number of days until delegation expires"),
  collateralToken: AddressSchema.describe("Collateral token address (WETH or cbBTC)"),
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

// ── Config ──────────────────────────────────────────────────────────────────

export interface X402Config {
  facilitatorUrl?: string;
  facilitatorApiKey?: string;
  matcherAddress?: string;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class X402ActionProvider extends ActionProvider<EvmWalletProvider> {
  private matcherAddress: Address;
  private facilitatorUrl: string;
  private facilitatorApiKey: string;

  constructor(config?: Partial<X402Config>) {
    super("x402", []);
    this.matcherAddress = (config?.matcherAddress ?? BASE_MAINNET_MATCHER) as Address;
    this.facilitatorUrl = config?.facilitatorUrl ?? "";
    this.facilitatorApiKey = config?.facilitatorApiKey ?? "";
  }

  supportsNetwork = (network: Network): boolean => {
    return network.chainId === "8453";
  };

  private async facilitatorFetch(path: string, options?: RequestInit): Promise<Response> {
    if (!this.facilitatorUrl) throw new Error("facilitatorUrl not configured");
    if (!this.facilitatorApiKey) throw new Error("facilitatorApiKey not configured");
    return fetch(`${this.facilitatorUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.facilitatorApiKey}`,
        ...(options?.headers ?? {}),
      },
    });
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
      const facilitatorUrl = args.facilitatorUrl;

      // Step 1: Pre-register with facilitator to get Privy wallet address
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const signMessage = `Register with Floe Facilitator\nNonce: ${nonce}`;
      const signature = await walletProvider.signMessage(signMessage);

      const preRegResp = await fetch(`${facilitatorUrl}/agents/pre-register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: agentAddress, signature, nonce }),
      });

      if (!preRegResp.ok) {
        const err = (await preRegResp.json()) as { error?: string };
        return `Pre-registration failed: ${err.error ?? preRegResp.statusText}`;
      }

      const { privyWalletAddress } = (await preRegResp.json()) as { privyWalletAddress: string };

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

      // Step 3: Approve collateral token spending
      // Max approval — agent controls exposure via operator delegation limits
      const approvalAmount = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"); // type(uint256).max
      const approveTxHash = await this.ensureAllowance(
        walletProvider,
        args.collateralToken as Address,
        this.matcherAddress,
        approvalAmount,
      );

      // Step 4: Complete registration with facilitator
      const regNonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const regMessage = `Register with Floe Facilitator\nNonce: ${regNonce}`;
      const regSignature = await walletProvider.signMessage(regMessage);

      const regResp = await fetch(`${facilitatorUrl}/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: agentAddress, signature: regSignature, nonce: regNonce }),
      });

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

      // Store the API key for subsequent x402 calls
      this.facilitatorApiKey = regResult.apiKey;
      this.facilitatorUrl = facilitatorUrl;

      const creditLimitFormatted = formatTokenAmount(BigInt(regResult.creditLimit), usdcDecimals, "USDC");

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
        `> **API Key**: \`${regResult.apiKey}\``,
        "> Save this key — it won't be shown again.",
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

      // Verify on-chain
      const agentAddress = await walletProvider.getAddress();
      const perm = (await walletProvider.readContract({
        address: this.matcherAddress,
        abi: OPERATOR_ABI,
        functionName: "getOperatorPermission",
        args: [agentAddress as `0x${string}`, args.facilitatorAddress as `0x${string}`],
      })) as { approved: boolean };

      if (perm.approved) {
        return `Warning: revokeOperator tx sent (${txHash}) but delegation still shows as approved. It may not have confirmed yet.`;
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
        `**Status**: ${perm.approved ? (isExpired ? "⚠️ Expired" : "✅ Active") : "❌ Not Active"}`,
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
        lines.push("", "⚠️ **Delegation expiring soon!** Consider renewing via `grant_credit_delegation`.");
      }

      if (isExpired && perm.approved) {
        lines.push("", "⚠️ **Delegation is expired.** No new borrows can be made. Renew to continue.");
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
        const errorObj = err as { error?: string; retryAfterMs?: number };
        if (errorObj.error === "funding_in_progress") {
          return "⏳ Funding in progress — the facilitator is borrowing funds. Retry in 30 seconds.";
        }
        if (errorObj.error === "credit_frozen") {
          return "❄️ Credit frozen — your collateral health ratio is too low. Add collateral or wait for price recovery.";
        }
        if (errorObj.error === "insufficient_balance") {
          return "💸 Insufficient credit — your credit line is fully utilized. Wait for a top-up or reduce usage.";
        }
        return `Facilitator error: ${errorObj.error ?? resp.statusText}`;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const body = contentType.includes("json")
        ? JSON.stringify(await resp.json(), null, 2)
        : await resp.text();

      const paymentTx = resp.headers.get("x-payment-response") || resp.headers.get("payment-response");

      const lines = ["## Response\n"];
      if (paymentTx) {
        lines.push(`*Paid via x402 — tx: ${paymentTx}*\n`);
      }
      lines.push("```", body.slice(0, 4000), "```");

      return lines.join("\n");
    } catch (e) {
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
        activeLoans: Array<{ loanId: string; borrowAmount?: string; principalRaw?: string; status: string }>;
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
        `**Delegation Active**: ${data.delegationActive ? "✅ Yes" : "❌ No"}`,
        `**Privy Wallet**: ${formatAddress(data.privyWalletAddress)}`,
        `**Wallet Balance**: ${formatTokenAmount(BigInt(data.privyWalletBalance || "0"), usdcDecimals, "USDC")}`,
      ].join("\n");
    } catch (e) {
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
      const limit = parseInt(args.limit, 10) || 20;
      const resp = await this.facilitatorFetch(`/agents/transactions?limit=${limit}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return `Error: ${(err as { error?: string }).error ?? resp.statusText}`;
      }

      const data = (await resp.json()) as {
        transactions: Array<{
          id: number;
          targetUrl: string;
          method: string;
          paymentAmountRaw: string | null;
          status: string;
          x402TxHash: string | null;
          createdAt: string;
        }>;
        hasMore: boolean;
      };

      if (!data.transactions?.length) {
        return "No transactions found.";
      }

      const usdcDecimals = 6;
      const lines = ["## Recent Transactions\n"];
      for (const tx of data.transactions) {
        const amount = tx.paymentAmountRaw
          ? formatTokenAmount(BigInt(tx.paymentAmountRaw), usdcDecimals, "USDC")
          : "—";
        const status = tx.status === "success" ? "✅" : tx.status === "passthrough" ? "🔄" : "❌";
        lines.push(
          `${status} **${tx.method}** ${tx.targetUrl}`,
          `   Amount: ${amount} | ${tx.createdAt}`,
          tx.x402TxHash ? `   Tx: ${tx.x402TxHash}` : "",
        );
      }

      if (data.hasMore) {
        lines.push("\n*More transactions available — increase limit to see more.*");
      }

      return lines.join("\n");
    } catch (e) {
      return `Error fetching transactions: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export const x402ActionProvider = (config?: Partial<X402Config>) =>
  new X402ActionProvider(config);
