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
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const USDC_DECIMALS = 6;
const USDC_SCALE = 10 ** USDC_DECIMALS;

/**
 * Convert a raw USDC integer string (6 decimals) to a dollar number.
 *
 * Display-quality precision only. `Number(raw)` is exact up to
 * `Number.MAX_SAFE_INTEGER` raw units, i.e. roughly $9.0 × 10^9 of USDC.
 * Real-world agent balances fall well below that ceiling, so this is fine
 * for showing dollars. Anything that needs settlement-grade precision
 * (e.g. on-chain math, accounting reconciliation) should keep using the
 * raw integer strings on `FetchResult.costRaw` / `BalanceResult.raw.*Raw`
 * and never round-trip through this function.
 */
function rawToDollars(raw: string | null | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / USDC_SCALE;
}

export interface FloeAgentClientConfig {
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

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Dollar amount paid for this call (0 for free passthrough). */
  cost: number;
  /** True when this was a cached replay against the same idempotency key. */
  idempotentReplay: boolean;
  /** Raw 6-decimal USDC integer string (advanced; prefer `cost`). */
  costRaw?: string;
}

/** @deprecated Use FetchResult — kept for one release for compatibility. */
export type X402FetchResult = FetchResult;

export interface BalanceResult {
  /** Dollar amount available to spend right now. */
  available: number;
  /** Dollar amount currently reserved against in-flight payments. */
  pending: number;
  /** Raw 6-decimal USDC strings (advanced; prefer `available` / `pending`). */
  raw: {
    creditLimitRaw: string;
    creditUsedRaw: string;
    creditAvailableRaw: string;
    pendingSettlementsRaw: string;
    activeLoans: Array<{ loanId: string; principalRaw?: string }>;
    delegationActive: boolean;
  };
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

  constructor(config: FloeAgentClientConfig) {
    if (!config.apiKey?.startsWith("floe_")) {
      throw new Error(
        "FloeAgent: apiKey must be a `floe_…` runtime key (mint one with `floe-agent register`).",
      );
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `FloeAgent: timeoutMs must be a finite positive number (got ${String(config.timeoutMs)}).`,
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  /**
   * Call any URL. If the API is x402-gated, payment happens automatically
   * (debited from your prepaid balance). Free URLs pass through unchanged.
   *
   * Pass a URL string for the simple case, or an object for advanced
   * options (HTTP method, headers, body, idempotency key).
   */
  async fetch(input: string | X402FetchInput): Promise<FetchResult> {
    const opts: X402FetchInput =
      typeof input === "string" ? { url: input } : input;

    const headers: Record<string, string> = {};
    if (opts.idempotencyKey !== undefined) {
      if (opts.idempotencyKey.length === 0 || opts.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new FloeAgentError(
          `idempotencyKey must be 1..${MAX_IDEMPOTENCY_KEY_LENGTH} characters (got ${opts.idempotencyKey.length}).`,
          400,
        );
      }
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }

    const resp = await this.request("POST", "/v1/proxy/fetch", {
      url: opts.url,
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
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
        parsed.detail ?? parsed.error ?? `fetch failed: ${resp.status}`,
        resp.status,
        parsed.error,
        body,
      );
    }

    const costRaw = responseHeaders["x-floe-cost-usdc"];
    return {
      status: resp.status,
      headers: responseHeaders,
      body,
      cost: rawToDollars(costRaw),
      costRaw: costRaw ?? undefined,
      idempotentReplay: responseHeaders["x-floe-idempotent-replay"] === "true",
    };
  }

  /** @deprecated Use `fetch` — same behavior, friendlier name. */
  async x402Fetch(input: X402FetchInput): Promise<FetchResult> {
    return this.fetch(input);
  }

  /**
   * Return the agent's spendable balance, in dollars.
   *
   * For most code this is the one number you want:
   *
   *     if (await agent.balance() < 5) topUp();
   *
   * For richer detail (active loans, pending settlements, raw integer
   * units), call `balanceDetails()`.
   */
  async balance(): Promise<number> {
    const detail = await this.balanceDetails();
    return detail.available;
  }

  /** Full balance breakdown including pending settlements and raw values. */
  async balanceDetails(): Promise<BalanceResult> {
    const resp = await this.request("GET", "/v1/agents/balance");
    const data = await this.parseJson<{
      creditLimit: string;
      creditUsed: string;
      creditAvailable: string;
      pendingSettlements?: string;
      activeLoans?: Array<{ loanId: string; principalRaw?: string }>;
      delegationActive?: boolean;
    }>(resp, "balance");
    const pendingRaw = data.pendingSettlements ?? "0";
    return {
      available: rawToDollars(data.creditAvailable),
      pending: rawToDollars(pendingRaw),
      raw: {
        creditLimitRaw: data.creditLimit,
        creditUsedRaw: data.creditUsed,
        creditAvailableRaw: data.creditAvailable,
        pendingSettlementsRaw: pendingRaw,
        activeLoans: data.activeLoans ?? [],
        delegationActive: data.delegationActive ?? false,
      },
    };
  }

  /** @deprecated Use `balance()` (dollars) or `balanceDetails()` (full). */
  async getBalance(): Promise<BalanceResult> {
    return this.balanceDetails();
  }

  /** Paginated x402 payment history for this agent. */
  async getTransactions(limit = 20, cursor?: number): Promise<TransactionsResult> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) qs.set("cursor", String(cursor));
    const resp = await this.request("GET", `/v1/agents/transactions?${qs.toString()}`);
    return this.parseJson<TransactionsResult>(resp, "get_transactions");
  }

  /**
   * Preview the cost of calling a URL without actually paying. Returns the
   * expected dollar price (0 if free) and whether the agent currently has
   * enough balance to pay it.
   */
  async estimateCost(url: string, method = "GET"): Promise<{
    cost: number;
    canAfford: boolean;
    isPaid: boolean;
  }> {
    const qs = new URLSearchParams({ url, method });
    const resp = await this.request("GET", `/v1/x402/estimate?${qs.toString()}`);
    const data = await this.parseJson<{
      costRaw: string | null;
      willExceedAvailable: boolean;
      x402: boolean;
    }>(resp, "estimate_cost");
    return {
      cost: rawToDollars(data.costRaw),
      canAfford: !data.willExceedAvailable,
      isPaid: data.x402,
    };
  }

  /** @deprecated Use `estimateCost`. */
  async estimateX402Cost(url: string, method = "GET") {
    return this.estimateCost(url, method);
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
      if (e instanceof FloeAgentError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new FloeAgentError(`Request timed out after ${this.timeoutMs}ms`, 408);
      }
      // Network failures (DNS resolution, connection refused, socket reset)
      // and any other transport-layer exception. Surface as a typed error
      // so callers can branch on FloeAgentError uniformly instead of
      // type-sniffing the raw exception.
      const msg = e instanceof Error ? e.message : String(e);
      throw new FloeAgentError(`Network error contacting Floe: ${msg}`, 0, "network_error", e);
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
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new FloeAgentError(
        `${operation} returned ${resp.status} but the body was not valid JSON.`,
        resp.status,
        "invalid_response_body",
        text,
      );
    }
  }
}
