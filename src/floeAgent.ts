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
  /**
   * Dollar amount the agent can actually spend right now. Backed by
   * `spendableRaw` from the facilitator (= drawn facility credit − in-flight
   * payments − held budgets). This is the number the proxy gates on.
   *
   * NOT the same as `creditAvailable` (borrowing headroom): an agent with
   * a $100 delegation but no facility loan opened has `available === 0`.
   */
  available: number;
  /**
   * Dollar amount of operator-delegation headroom — how much more the
   * agent *could* borrow from its credit line, not what it can spend.
   * Backed by `creditAvailableRaw`.
   */
  creditAvailable: number;
  /**
   * On-chain USDC balance of the Privy custodial wallet. `null` when the
   * facilitator could not read it (RPC down) or the field is absent
   * (older facilitator).
   *
   * Cached server-side for ~5s to coalesce dashboard polling. For
   * "I just swept my wallet, check the new balance" flows the freshness
   * can lag by that window — read on-chain directly if you need it real-time.
   */
  walletUsdc: number | null;
  /** Dollar amount currently reserved against in-flight payments. */
  pending: number;
  /** Raw 6-decimal USDC strings (advanced; prefer the dollar fields above). */
  raw: {
    creditLimitRaw: string;
    creditUsedRaw: string;
    creditAvailableRaw: string;
    spendableRaw: string;
    walletUsdcRaw: string | null;
    pendingSettlementsRaw: string;
    heldUnspentRaw: string;
    activeLoans: Array<{ loanId: string; principalRaw?: string }>;
    delegationActive: boolean;
  };
}

/** State of an x402 reservation as returned by `awaitSettlement`. */
export type ReservationTerminalState = "settled" | "expired_unsettled" | "payment_rejected";
export type ReservationState = ReservationTerminalState | "reserved" | "sent" | "pending_settlement";

export interface ReservationStatus {
  nonce: string;
  state: ReservationState;
  terminal: boolean;
  paymentAmountRaw: string;
  txHash: string | null;
  validBefore: number;
  reservedAt: string | null;
  sentAt: string | null;
  settledAt: string | null;
}

export interface AwaitSettlementOptions {
  /** Polling interval. Defaults to 2_000 ms. */
  intervalMs?: number;
  /** Absolute timeout in ms after which the helper throws. Defaults to 15 min. */
  timeoutMs?: number;
  /** AbortSignal to cancel polling early. */
  signal?: AbortSignal;
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
    /**
     * Raw response body text. Preserved as a string for back-compat —
     * pre-FLO-567 callers that did `err.detail.includes(...)` keep working.
     * For the parsed JSON shape (e.g. `body.reservation.nonce` on a 502
     * ambiguous), read `err.body` instead.
     */
    readonly detail?: string,
    /**
     * Parsed JSON response body when the server returned JSON, otherwise
     * undefined. Added in FLO-567 so callers can extract structured fields
     * (like `reservation.nonce` on a 502) without re-parsing `detail`.
     */
    readonly body?: unknown,
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

    const payload: Record<string, unknown> = {
      url: opts.url,
      method: opts.method ?? "GET",
    };
    if (opts.headers !== undefined) payload.headers = opts.headers;
    if (opts.body !== undefined) payload.body = opts.body;

    const maxAutoBorrowRetries = 2;
    for (let attempt = 0; attempt <= maxAutoBorrowRetries; attempt++) {
      const resp = await this.request("POST", "/v1/proxy/fetch", payload, headers);

      const responseHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      const body = await resp.text();

      if (!resp.ok) {
        let parsed: { error?: string; detail?: string; retry_after_seconds?: number; reservation?: { nonce?: string; validBefore?: number } } = {};
        let parsedOk = false;
        try {
          parsed = JSON.parse(body) as typeof parsed;
          parsedOk = true;
        } catch {
          // non-JSON error body — keep as-is
        }

        // Auto-borrow retry: server is topping up the credit line. Wait
        // and retry before giving up.
        if (
          resp.status === 402 &&
          parsedOk &&
          typeof parsed === "object" &&
          parsed !== null &&
          parsed.error === "auto_borrow_in_progress" &&
          attempt < maxAutoBorrowRetries
        ) {
          const raw = parsed.retry_after_seconds;
          const delaySec = Math.min(Math.max(Number(raw) || 10, 1), 60);
          await new Promise((r) => setTimeout(r, delaySec * 1000));
          continue;
        }

        // `detail` stays the raw body string for back-compat. `body` carries
        // the parsed JSON when available so callers can read structured
        // fields like `err.body.reservation.nonce` after a 502 ambiguous
        // and hand it to `awaitSettlement(nonce)`.
        throw new FloeAgentError(
          parsed.detail ?? parsed.error ?? `fetch failed: ${resp.status}`,
          resp.status,
          parsed.error,
          body,
          parsedOk ? parsed : undefined,
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
    // Unreachable — the loop always returns or throws.
    throw new FloeAgentError("auto-borrow retries exhausted", 402);
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
      // Legacy + new fields. New ones (spendableRaw, creditAvailableRaw,
      // walletUsdcRaw, pendingSettlementsRaw, heldUnspentRaw) ship with
      // FLO-567 — fall back to legacy names so this SDK works against
      // older facilitator deploys during the rollout window.
      creditLimit: string;
      creditUsed: string;
      creditAvailable: string;
      balance?: string;
      spendableRaw?: string;
      creditAvailableRaw?: string;
      walletUsdcRaw?: string | null;
      pendingSettlementsRaw?: string;
      pendingSettlements?: string;
      heldUnspentRaw?: string;
      activeLoans?: Array<{ loanId: string; principalRaw?: string }>;
      delegationActive?: boolean;
    }>(resp, "balance");

    // Spendable = drawn-but-unspent credit. Prefer the explicit field;
    // fall back to the (already-spendable) legacy `balance` field.
    const spendableRaw = data.spendableRaw ?? data.balance ?? "0";
    const creditAvailableRaw = data.creditAvailableRaw ?? data.creditAvailable;
    const pendingRaw = data.pendingSettlementsRaw ?? data.pendingSettlements ?? "0";
    const heldRaw = data.heldUnspentRaw ?? "0";
    const walletUsdcRaw = data.walletUsdcRaw ?? null;

    return {
      available: rawToDollars(spendableRaw),
      creditAvailable: rawToDollars(creditAvailableRaw),
      walletUsdc: walletUsdcRaw === null ? null : rawToDollars(walletUsdcRaw),
      pending: rawToDollars(pendingRaw),
      raw: {
        creditLimitRaw: data.creditLimit,
        creditUsedRaw: data.creditUsed,
        creditAvailableRaw,
        spendableRaw,
        walletUsdcRaw,
        pendingSettlementsRaw: pendingRaw,
        heldUnspentRaw: heldRaw,
        activeLoans: data.activeLoans ?? [],
        delegationActive: data.delegationActive ?? false,
      },
    };
  }

  /**
   * Poll the facilitator until an x402 reservation reaches a terminal state.
   *
   * Use this after `fetch()` throws with `code: "upstream_paid_request_failed_ambiguous"` —
   * the thrown error's `body.reservation.nonce` (parsed JSON) is what to pass
   * in. The helper resolves with the final reservation status:
   *
   *   - `settled` — payment confirmed on-chain.
   *   - `payment_rejected` — the call never reached the upstream; credit released.
   *   - `expired_unsettled` — authorization expired before reconciliation;
   *     the agent should treat this as the upstream may or may not have charged.
   *
   * Throws if the timeout elapses or `signal` is aborted before a terminal
   * state is reached.
   */
  async awaitSettlement(nonce: string, opts: AwaitSettlementOptions = {}): Promise<ReservationStatus> {
    const intervalMs = opts.intervalMs ?? 2_000;
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("awaitSettlement: intervalMs must be a finite number > 0");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("awaitSettlement: timeoutMs must be a finite number > 0");
    }

    const deadline = Date.now() + timeoutMs;
    // Loop until terminal, timeout, or external abort. We poll a small
    // fixed interval rather than backing off because reconciliation flips
    // most ambiguous payments within seconds; a long interval would just
    // add latency for the common case.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      opts.signal?.throwIfAborted?.();
      // Thread the caller's signal into the HTTP call too — without this,
      // a hung facilitator response would block the loop until the per-
      // request timeout (default 30s) instead of cancelling immediately.
      const resp = await this.request(
        "GET",
        `/v1/agents/reservations/${encodeURIComponent(nonce)}`,
        undefined,
        undefined,
        opts.signal,
      );
      const status = await this.parseJson<ReservationStatus>(resp, "await_settlement");
      if (status.terminal) return status;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new FloeAgentError(
          `awaitSettlement: timed out after ${timeoutMs}ms (last state: ${status.state})`,
          408,
          "await_settlement_timeout",
          undefined,
          status,
        );
      }
      await new Promise<void>((resolve, reject) => {
        // Guard: if the signal already fired BEFORE the sleep started,
        // `addEventListener("abort", ...)` is a no-op (the event has
        // already been dispatched) — without this check the sleep would
        // run to completion and we'd do one extra poll iteration before
        // `throwIfAborted` caught it at the top of the loop.
        if (opts.signal?.aborted) {
          reject(opts.signal.reason ?? new Error("aborted"));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener?.("abort", onAbort);
          reject(opts.signal!.reason ?? new Error("aborted"));
        };
        const timer = setTimeout(() => {
          opts.signal?.removeEventListener?.("abort", onAbort);
          resolve();
        }, Math.min(intervalMs, remaining));
        opts.signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    }
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
    /**
     * External AbortSignal. Composed with the per-request timeout signal
     * so callers (e.g. `awaitSettlement`) can cancel an in-flight HTTP
     * call mid-poll instead of only cancelling the sleep between polls.
     */
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? new FloeAgentError("aborted", 0, "aborted");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    // Compose: when the caller's signal fires, propagate into the
    // internal controller so the in-flight fetch aborts immediately.
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
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
      if (externalSignal?.aborted) {
        // Caller cancelled — surface their reason, not a generic timeout.
        throw externalSignal.reason ?? new FloeAgentError("aborted", 0, "aborted");
      }
      if (e instanceof Error && e.name === "AbortError") {
        throw new FloeAgentError(`Request timed out after ${this.timeoutMs}ms`, 408);
      }
      // Network failures (DNS resolution, connection refused, socket reset)
      // and any other transport-layer exception. Surface as a typed error
      // so callers can branch on FloeAgentError uniformly instead of
      // type-sniffing the raw exception.
      const msg = e instanceof Error ? e.message : String(e);
      // Pass `msg` as `detail` (string) for back-compat — pre-FLO-567 callers
      // reading `err.detail` after a network error got the underlying
      // exception's stringified form via the old `unknown` field. The full
      // exception object now lives on `body` for callers that want it.
      throw new FloeAgentError(`Network error contacting Floe: ${msg}`, 0, "network_error", msg, e);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async parseJson<T>(resp: Response, operation: string): Promise<T> {
    const text = await resp.text();
    if (!resp.ok) {
      let parsed: { error?: string; detail?: string } = {};
      let parsedOk = false;
      try {
        parsed = JSON.parse(text) as { error?: string; detail?: string };
        parsedOk = true;
      } catch {
        // ignore
      }
      throw new FloeAgentError(
        parsed.detail ?? parsed.error ?? `${operation} failed: ${resp.status}`,
        resp.status,
        parsed.error,
        text,
        parsedOk ? parsed : undefined,
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
