/**
 * FLO-590 — FloeAgent.fetch parses X-Floe-Budget-Advisory into
 * FetchResult.budgetAdvisory, mirroring the existing x-floe-cost-usdc →
 * cost/costRaw pattern. Same fetch-stub approach as awaitSettlement.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FloeAgent } from "../src/floeAgent.js";
import type { BudgetAdvisory } from "../src/floeAgent.js";

const API_KEY = "floe_test_runtime_key_aaaaaaaaaaaaaaaa";
const BASE_URL = "http://facilitator.test";

function proxyResponse(extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-floe-cost-usdc": "10000",
      ...extraHeaders,
    },
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

describe("FloeAgent.fetch — X-Floe-Budget-Advisory parsing (FLO-590)", () => {
  it("parses a valid advisory header into result.budgetAdvisory", async () => {
    const advisory: BudgetAdvisory = {
      near_limit: true,
      tightest: {
        scope: "task",
        match: "task-123",
        used_bps: 8200,
        remaining_raw: "450000",
        window_kind: "rolling",
        window_resets_at: "2026-07-14T23:00:00.000Z",
      },
    };
    fetchMock.mockResolvedValueOnce(
      proxyResponse({ "x-floe-budget-advisory": JSON.stringify(advisory) }),
    );

    const result = await newAgent().fetch("https://api.example.com/data");

    expect(result.budgetAdvisory).toEqual(advisory);
    expect(result.budgetAdvisory?.tightest.scope).toBe("task");
    expect(result.budgetAdvisory?.tightest.used_bps).toBe(8200);
    expect(result.budgetAdvisory?.near_limit).toBe(true);
    // Sibling fields keep working unchanged.
    expect(result.cost).toBeCloseTo(0.01);
    expect(result.costRaw).toBe("10000");
    // Raw header stays reachable for callers that already read it.
    expect(result.headers["x-floe-budget-advisory"]).toBe(JSON.stringify(advisory));
  });

  it("leaves budgetAdvisory undefined when the header is absent", async () => {
    fetchMock.mockResolvedValueOnce(proxyResponse());

    const result = await newAgent().fetch("https://api.example.com/data");

    expect(result.budgetAdvisory).toBeUndefined();
    expect("budgetAdvisory" in result).toBe(false);
  });

  it("leaves budgetAdvisory undefined on a malformed header without throwing", async () => {
    fetchMock.mockResolvedValueOnce(
      proxyResponse({ "x-floe-budget-advisory": "{" }),
    );

    const result = await newAgent().fetch("https://api.example.com/data");

    expect(result.status).toBe(200);
    expect(result.budgetAdvisory).toBeUndefined();
    expect(result.cost).toBeCloseTo(0.01);
  });
});
