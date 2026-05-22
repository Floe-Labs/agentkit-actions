/**
 * FLO-567 — Tests for FloeAgent.awaitSettlement + balanceDetails field
 * disambiguation.
 *
 * We stub global `fetch` directly: the SDK only uses the global, has no
 * injected transport, and these tests are pure-unit on the polling logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FloeAgent, FloeAgentError } from "../src/floeAgent.js";

const API_KEY = "floe_test_runtime_key_aaaaaaaaaaaaaaaa";
const BASE_URL = "http://facilitator.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function newAgent() {
  return new FloeAgent({ apiKey: API_KEY, baseUrl: BASE_URL, timeoutMs: 5_000 });
}

describe("FloeAgent.balanceDetails — FLO-567 field disambiguation", () => {
  it("prefers explicit *Raw fields and exposes both spendable and headroom", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        // Legacy fields still present from a new facilitator.
        balance: "4000000",
        creditLimit: "10000000",
        creditUsed: "4000000",
        creditAvailable: "6000000",
        // New explicit fields.
        spendableRaw: "4000000",
        creditAvailableRaw: "6000000",
        walletUsdcRaw: "123456",
        pendingSettlementsRaw: "500000",
        heldUnspentRaw: "0",
        activeLoans: [],
        delegationActive: true,
      }),
    );
    const agent = newAgent();
    const detail = await agent.balanceDetails();
    expect(detail.available).toBeCloseTo(4); // spendable, NOT 6
    expect(detail.creditAvailable).toBeCloseTo(6);
    expect(detail.walletUsdc).toBeCloseTo(0.123456, 5);
    expect(detail.pending).toBeCloseTo(0.5);
    expect(detail.raw.spendableRaw).toBe("4000000");
    expect(detail.raw.walletUsdcRaw).toBe("123456");
  });

  it("falls back to legacy fields against an older facilitator (no new keys)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        balance: "1000000",
        creditLimit: "5000000",
        creditUsed: "1000000",
        creditAvailable: "4000000",
        activeLoans: [],
        delegationActive: true,
      }),
    );
    const agent = newAgent();
    const detail = await agent.balanceDetails();
    // available now correctly reads the (legacy) spendable `balance`, not creditAvailable.
    expect(detail.available).toBeCloseTo(1);
    expect(detail.creditAvailable).toBeCloseTo(4);
    expect(detail.walletUsdc).toBeNull();
  });

  it("agent.balance() returns spendable dollars, not borrowing headroom", async () => {
    // The reporter's confusion: agent has $5 of headroom but $0 spendable.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        balance: "0",
        creditLimit: "5000000",
        creditUsed: "0",
        creditAvailable: "5000000",
        spendableRaw: "0",
        creditAvailableRaw: "5000000",
        walletUsdcRaw: null,
        pendingSettlementsRaw: "0",
        heldUnspentRaw: "0",
        activeLoans: [],
        delegationActive: true,
      }),
    );
    const agent = newAgent();
    expect(await agent.balance()).toBe(0);
  });
});

describe("FloeAgent.awaitSettlement", () => {
  it("returns immediately when the reservation is already terminal", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        nonce: "n1",
        state: "settled",
        terminal: true,
        paymentAmountRaw: "1000000",
        txHash: "0xabc",
        validBefore: 0,
        reservedAt: null,
        sentAt: null,
        settledAt: "2026-05-22T12:00:00Z",
      }),
    );
    const agent = newAgent();
    const status = await agent.awaitSettlement("n1", { intervalMs: 10, timeoutMs: 500 });
    expect(status.state).toBe("settled");
    expect(status.terminal).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls until terminal state is reached", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n2", state: "pending_settlement", terminal: false, paymentAmountRaw: "1000000", txHash: null, validBefore: 0, reservedAt: null, sentAt: null, settledAt: null }))
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n2", state: "pending_settlement", terminal: false, paymentAmountRaw: "1000000", txHash: null, validBefore: 0, reservedAt: null, sentAt: null, settledAt: null }))
      .mockResolvedValueOnce(jsonResponse(200, { nonce: "n2", state: "settled", terminal: true, paymentAmountRaw: "1000000", txHash: "0xdef", validBefore: 0, reservedAt: null, sentAt: null, settledAt: "2026-05-22T12:00:01Z" }));
    const agent = newAgent();
    const status = await agent.awaitSettlement("n2", { intervalMs: 10, timeoutMs: 5_000 });
    expect(status.state).toBe("settled");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws a 408 FloeAgentError on timeout, attaching the last status on err.body", async () => {
    // Body can only be read once per Response — use a factory so each poll
    // gets a fresh body.
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { nonce: "n3", state: "pending_settlement", terminal: false, paymentAmountRaw: "1000000", txHash: null, validBefore: 0, reservedAt: null, sentAt: null, settledAt: null }),
    );
    const agent = newAgent();
    await expect(
      agent.awaitSettlement("n3", { intervalMs: 10, timeoutMs: 40 }),
    ).rejects.toMatchObject({
      status: 408,
      code: "await_settlement_timeout",
      // The last reservation status is stashed on `body` (not `detail`)
      // so callers can inspect what state we gave up in without re-fetching.
      body: { nonce: "n3", state: "pending_settlement", terminal: false },
    });
  });

  it("URL-encodes the nonce", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { nonce: "weird/nonce?", state: "settled", terminal: true, paymentAmountRaw: "1", txHash: null, validBefore: 0, reservedAt: null, sentAt: null, settledAt: null }),
    );
    const agent = newAgent();
    await agent.awaitSettlement("weird/nonce?", { intervalMs: 10, timeoutMs: 500 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/v1/agents/reservations/weird%2Fnonce%3F");
  });

  it.each(["settled", "payment_rejected", "expired_unsettled"] as const)(
    "propagates terminal=true for state=%s",
    async (terminalState) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          nonce: `n-${terminalState}`,
          state: terminalState,
          terminal: true,
          paymentAmountRaw: "1000000",
          txHash: terminalState === "settled" ? "0xabc" : null,
          validBefore: 0,
          reservedAt: null,
          sentAt: null,
          settledAt: terminalState === "settled" ? "2026-05-22T12:00:00Z" : null,
        }),
      );
      const agent = newAgent();
      const status = await agent.awaitSettlement(`n-${terminalState}`, { intervalMs: 10, timeoutMs: 500 });
      expect(status.state).toBe(terminalState);
      expect(status.terminal).toBe(true);
    },
  );

  it("rejects immediately when called with an already-aborted signal", async () => {
    // Regression for the FLO-567 review: `addEventListener("abort", …)` on
    // an already-fired signal is a no-op, so the early `aborted` check
    // is what prevents a sneaky extra poll iteration.
    const agent = newAgent();
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled before start"));
    await expect(
      agent.awaitSettlement("n-pre-abort", { intervalMs: 10, timeoutMs: 5_000, signal: ctrl.signal }),
    ).rejects.toThrow(/cancel/);
    // Crucially: zero HTTP calls — the helper bailed at the top-of-loop
    // throwIfAborted before even hitting the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the in-flight HTTP request, not just the sleep gap", async () => {
    // Stub fetch to hang until its abort signal fires, then resolve the
    // promise the test cares about: the signal got plumbed down.
    let abortedDuringFetch = false;
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            abortedDuringFetch = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const agent = newAgent();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("cancel mid-fetch")), 20);
    await expect(
      agent.awaitSettlement("n-hang", { intervalMs: 10, timeoutMs: 5_000, signal: ctrl.signal }),
    ).rejects.toThrow(/cancel/);
    expect(abortedDuringFetch).toBe(true);
  });

  it("aborts when the provided signal is fired", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { nonce: "n4", state: "pending_settlement", terminal: false, paymentAmountRaw: "1", txHash: null, validBefore: 0, reservedAt: null, sentAt: null, settledAt: null }),
    );
    const agent = newAgent();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("user cancelled")), 30);
    await expect(
      agent.awaitSettlement("n4", { intervalMs: 100, timeoutMs: 5_000, signal: ctrl.signal }),
    ).rejects.toThrow(/cancel/);
  });
});

describe("FloeAgent.fetch — FLO-567 nonce bubbling", () => {
  it("attaches the parsed 502 body (including reservation.nonce) to FloeAgentError.body", async () => {
    const rawJson = JSON.stringify({
      error: "upstream_paid_request_failed_ambiguous",
      detail: "EHOSTUNREACH",
      reservation: { nonce: "n-bubble-1", validBefore: 1_700_000_000 },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(rawJson, { status: 502, headers: { "content-type": "application/json" } }),
    );
    const agent = newAgent();
    try {
      await agent.fetch("https://upstream.example/paid");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FloeAgentError);
      const err = e as FloeAgentError;
      expect(err.status).toBe(502);
      expect(err.code).toBe("upstream_paid_request_failed_ambiguous");
      // `detail` keeps its legacy string semantics — raw response body.
      // Existing callers that do `err.detail.includes(...)` keep working.
      expect(typeof err.detail).toBe("string");
      expect(err.detail).toBe(rawJson);
      // `body` is the parsed JSON for structured access.
      const body = err.body as { reservation?: { nonce?: string } };
      expect(body.reservation?.nonce).toBe("n-bubble-1");
    }
  });
});
