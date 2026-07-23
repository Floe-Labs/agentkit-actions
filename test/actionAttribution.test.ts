/**
 * action attribution on FloeAgent: fetch() sends the
 * X-Floe-Task-Id / X-Floe-Action-Id tags, and reportOutcome() posts the
 * caller's result signal. Same fetch-stub approach as budgetAdvisory.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FloeAgent, FloeAgentError } from "../src/floeAgent.js";

const API_KEY = "floe_test_runtime_key_aaaaaaaaaaaaaaaa";
const BASE_URL = "http://facilitator.test";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

describe("FloeAgent.fetch — attribution tags (FLO-633)", () => {
  it("sends X-Floe-Action-Id and X-Floe-Task-Id on the Floe request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }, { "x-floe-cost-usdc": "1000" }));

    await newAgent().fetch({
      url: "https://api.example.com/data",
      taskId: "batch-7",
      actionId: " Summarize-Doc-42 ", // trimmed client-side; lowercased server-side
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Floe-Task-Id"]).toBe("batch-7");
    expect(headers["X-Floe-Action-Id"]).toBe("Summarize-Doc-42");
  });

  it("omits the headers when tags are not provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await newAgent().fetch("https://api.example.com/data");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Floe-Action-Id"]).toBeUndefined();
    expect(headers["X-Floe-Task-Id"]).toBeUndefined();
  });

  it("rejects an over-long actionId locally (no request made)", async () => {
    await expect(
      newAgent().fetch({ url: "https://api.example.com", actionId: "x".repeat(129) }),
    ).rejects.toThrow(FloeAgentError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string tag as a typed error (runtime callers bypass TS types)", async () => {
    await expect(
      newAgent().fetch({ url: "https://api.example.com", taskId: 42 as never }),
    ).rejects.toMatchObject({ name: "FloeAgentError", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects control characters in a tag rather than letting fetch() throw", async () => {
    // A raw CR/LF reaches undici, which throws inside request() — the transport
    // catch would then mislabel it `network_error`. Reject it here instead.
    await expect(
      newAgent().fetch({ url: "https://api.example.com", actionId: "abc\r\nX-Injected: 1" }),
    ).rejects.toThrow(/printable Latin-1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("FloeAgent.reportOutcome (FLO-633)", () => {
  it("POSTs the outcome and returns the stored result", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        actionId: "summarize-doc-42",
        outcome: { status: "success", scoreBps: 9000, note: null, reportCount: 1, reportedAt: "2026-07-15T00:00:00Z" },
      }),
    );

    const result = await newAgent().reportOutcome("summarize-doc-42", { status: "success", scoreBps: 9000 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/agents/actions/summarize-doc-42/outcome`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ status: "success", scoreBps: 9000 });
    expect(result.outcome.reportCount).toBe(1);
    expect(result.outcome.status).toBe("success");
  });

  it("validates scoreBps range locally", async () => {
    await expect(
      newAgent().reportOutcome("a1", { status: "success", scoreBps: 20000 }),
    ).rejects.toThrow(/scoreBps/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates status and note locally (runtime callers bypass TS types)", async () => {
    await expect(
      newAgent().reportOutcome("a1", { status: "great" as never }),
    ).rejects.toThrow(/invalid outcome status/);
    await expect(
      newAgent().reportOutcome("a1", { status: "success", note: "x".repeat(501) }),
    ).rejects.toThrow(/note/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a null/non-object report as a typed error", async () => {
    await expect(
      newAgent().reportOutcome("a1", null as never),
    ).rejects.toMatchObject({ name: "FloeAgentError", status: 400 });
    await expect(
      newAgent().reportOutcome("a1", "success" as never),
    ).rejects.toThrow(/report must be an object/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps a malformed 2xx body in a typed FloeAgentError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(newAgent().reportOutcome("a1", { status: "success" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response_body",
    });
  });

  it("keeps the typed error contract when the error body is JSON null", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("null", { status: 500, headers: { "content-type": "application/json" } }),
    );
    await expect(newAgent().reportOutcome("a1", { status: "failure" })).rejects.toMatchObject({
      name: "FloeAgentError",
      status: 500,
      code: undefined,
      body: null,
    });
  });

  it("surfaces server errors as FloeAgentError, with the parsed body attached", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "invalid_action_id" }));
    await expect(newAgent().reportOutcome("a1", { status: "failure" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_action_id",
      // parity with fetch() / parseJson: structured fields readable off err.body
      body: { error: "invalid_action_id" },
    });
  });
});
