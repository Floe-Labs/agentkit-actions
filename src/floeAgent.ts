/**
 * FloeAgent — runtime client for agents that hold no wallet, no private key,
 * no chain knowledge. Authenticates with a `floe_*` agent runtime key and
 * speaks only HTTP to the Floe credit API. The agent's wallet (a non-custodial
 * Privy wallet provisioned at registration time) signs everything server-side.
 *
 * What this client covers: the agent's *runtime* loop — paying for x402 APIs,
 * reading credit / loan / spend state, and managing spend limits + credit
 * threshold subscriptions. Anything that needs management auth (registering
 * a new agent, opening a credit line, rotating keys) belongs in the
 * `floe-agent` CLI or the dashboard, both of which run with the developer's
 * Privy wallet so the dev never types a private key either.
 *
 * If you want code-level access to management operations or self-custody
 * borrow flows, use the lower-level `FloeActionProvider` /
 * `X402ActionProvider` with a wallet provider.
 */

const DEFAULT_BASE_URL = "https://credit-api.floelabs.xyz";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FloeAgentConfig {
  /** Agent runtime key (`floe_*`) minted by `floe-agent register` or the dashboard. */
  apiKey: string;
  /** Optional override; defaults to the Floe production credit API. */
  baseUrl?: string;
  /** Optional override; defaults to 15s per request. */
  timeoutMs?: number;
}

export interface X402FetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Stripe-style retry-safe key (≤255 chars). Same key + same agent within 10 min returns the cached response. */
  idempotencyKey?: string;
}

export interface X402FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** USDC paid for this call (raw 6-decimal units, integer string). Absent for free passthrough responses. */
  costRaw?: string;
  /** True when this was a cached replay against the same idempotency key. */
  idempotentReplay: boolean;
}

export interface BalanceResult {
  creditLimitRaw: string;
  creditUsedRaw: string;
  creditAvailableRaw: string;
  pendingSettlementsRaw: string;
  activeLoans: Array<{ loanId: string; principalRaw?: string }>;
  delegationActive: boolean;
}

export interface TransactionsResult {
  transactions: Array<{
    targetUrl: string;
    method: string;
    paymentAmountRaw: string;
    status: string;
    x402TxHash?: string | null;
    createdAt: string;
  }>;
  nextCursor?: number;
  hasMore: boolean;
}

export class FloeAgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "FloeAgentError";
  }
}

export class FloeAgent {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: FloeAgentConfig) {
    if (!config.apiKey?.startsWith("floe_")) {
      throw new Error(
        "FloeAgent: apiKey must be a `floe_…` runtime key (mint one with `floe-agent register`).",
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Fetch any URL through the Floe x402 facilitator. If the URL returns
   * HTTP 402, the facilitator pays automatically from the agent's credit
   * line and retries; the agent code sees the final 2xx (or a Floe error
   * code if credit is unavailable). Free URLs pass through unchanged.
   */
  async x402Fetch(input: X402FetchInput): Promise<X402FetchResult> {
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;

    const resp = await this.request("POST", "/v1/proxy/fetch", {
      url: input.url,
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body,
    }, headers);

    const responseHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    const body = await resp.text();

    if (!resp.ok) {
      let parsed: { error?: string; detail?: string } = {};
      try {
        parsed = JSON.parse(body) as { error?: string; detail?: string };
      } catch {
        // non-JSON error body — keep as-is
      }
      throw new FloeAgentError(
        parsed.detail ?? parsed.error ?? `x402_fetch failed: ${resp.status}`,
        resp.status,
        parsed.error,
        body,
      );
    }

    return {
      status: resp.status,
      headers: responseHeaders,
      body,
      costRaw: responseHeaders["x-floe-cost-usdc"] ?? undefined,
      idempotentReplay: responseHeaders["x-floe-idempotent-replay"] === "true",
    };
  }

  /** Check the agent's credit limit, used, available, and active loans. */
  async getBalance(): Promise<BalanceResult> {
    const resp = await this.request("GET", "/v1/agents/balance");
    const data = await this.parseJson<{
      creditLimit: string;
      creditUsed: string;
      creditAvailable: string;
      pendingSettlements?: string;
      activeLoans?: Array<{ loanId: string; principalRaw?: string }>;
      delegationActive?: boolean;
    }>(resp, "get_balance");
    return {
      creditLimitRaw: data.creditLimit,
      creditUsedRaw: data.creditUsed,
      creditAvailableRaw: data.creditAvailable,
      pendingSettlementsRaw: data.pendingSettlements ?? "0",
      activeLoans: data.activeLoans ?? [],
      delegationActive: data.delegationActive ?? false,
    };
  }

  /** Paginated x402 payment history for this agent. */
  async getTransactions(limit = 20, cursor?: number): Promise<TransactionsResult> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) qs.set("cursor", String(cursor));
    const resp = await this.request("GET", `/v1/agents/transactions?${qs.toString()}`);
    return this.parseJson<TransactionsResult>(resp, "get_transactions");
  }

  /**
   * Preview an x402 call without paying — returns the expected cost and
   * whether the agent currently has enough credit. Cheap, idempotent,
   * doesn't reserve balance.
   */
  async estimateX402Cost(url: string, method = "GET"): Promise<{
    costRaw: string | null;
    willExceedAvailable: boolean;
    x402: boolean;
  }> {
    const qs = new URLSearchParams({ url, method });
    const resp = await this.request("GET", `/v1/x402/estimate?${qs.toString()}`);
    return this.parseJson(resp, "estimate_x402_cost");
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(extraHeaders ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new FloeAgentError(`Request timed out after ${this.timeoutMs}ms`, 408);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJson<T>(resp: Response, operation: string): Promise<T> {
    const text = await resp.text();
    if (!resp.ok) {
      let parsed: { error?: string; detail?: string } = {};
      try {
        parsed = JSON.parse(text) as { error?: string; detail?: string };
      } catch {
        // ignore
      }
      throw new FloeAgentError(
        parsed.detail ?? parsed.error ?? `${operation} failed: ${resp.status}`,
        resp.status,
        parsed.error,
        text,
      );
    }
    return JSON.parse(text) as T;
  }
}
