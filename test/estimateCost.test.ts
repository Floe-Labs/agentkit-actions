/**
 * Regression test for FloeAgent.estimateCost.
 *
 * The method previously called GET /v1/x402/estimate and read top-level
 * `costRaw` / `willExceedAvailable`, but the server route is POST-only and
 * returns `priceRaw` + nested `reflection.willExceedAvailable`. These tests
 * lock the corrected contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FloeAgent } from "../src/floeAgent.js";

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

describe("FloeAgent.estimateCost", () => {
  it("POSTs to /v1/x402/estimate with a JSON body and maps the real response shape", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        url: "https://api.vendor.test/data",
        method: "GET",
        x402: true,
        priceRaw: "1500000", // 1.5 USDC
        reflection: { willExceedAvailable: false },
      }),
    );

    const agent = newAgent();
    const out = await agent.estimateCost("https://api.vendor.test/data", "GET");

    // Method + path + body
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${BASE_URL}/v1/x402/estimate`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://api.vendor.test/data",
      method: "GET",
    });

    // Field mapping: priceRaw -> cost, reflection.willExceedAvailable -> canAfford
    expect(out.cost).toBeCloseTo(1.5, 6);
    expect(out.canAfford).toBe(true);
    expect(out.isPaid).toBe(true);
  });

  it("reports canAfford=false when reflection says the payment exceeds available", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        x402: true,
        priceRaw: "9000000",
        reflection: { willExceedAvailable: true },
      }),
    );
    const out = await newAgent().estimateCost("https://api.vendor.test/data");
    expect(out.canAfford).toBe(false);
  });

  it("treats a non-x402 URL (no reflection) as free and affordable", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { x402: false }));
    const out = await newAgent().estimateCost("https://example.com");
    expect(out.isPaid).toBe(false);
    expect(out.cost).toBe(0);
    expect(out.canAfford).toBe(true);
  });
});
