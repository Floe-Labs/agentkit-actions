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

describe("FloeAgent.emitOutcome (P3.1)", () => {
  it("POSTs the claim and returns it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        outcome: {
          eventId: "oev_00112233445566aa",
          interactionId: "int_00112233445566bb",
          outcomeKind: "meeting_booked",
          status: "reported",
          quantity: 1,
          occurredAt: "2026-09-15T00:00:00Z",
          confirmedAt: null,
          source: "agent",
          externalSystem: null,
          externalRef: null,
          evidenceNote: null,
          supersedesEventId: null,
          billedInPeriodId: null,
        },
      }),
    );

    const claim = await newAgent().emitOutcome({
      taskId: "call-8821",
      outcomeKind: "meeting_booked",
      idempotencyKey: "call-8821:meeting_booked",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/agents/outcomes`);
    expect(init.method).toBe("POST");
    // Omitted optionals are ABSENT, not null — the route is `.strict()`.
    expect(JSON.parse(init.body as string)).toEqual({
      taskId: "call-8821",
      outcomeKind: "meeting_booked",
      idempotencyKey: "call-8821:meeting_booked",
    });
    expect(claim.eventId).toBe("oev_00112233445566aa");
    expect(claim.status).toBe("reported");
    expect(claim.confirmedAt).toBeNull();
  });

  it("sends the evidence allowlist when given", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        outcome: {
          eventId: "oev_00112233445566aa", interactionId: "int_1", outcomeKind: "meeting_booked",
          status: "reported", quantity: 2, occurredAt: "2026-09-15T00:00:00Z", confirmedAt: null,
          source: "agent", externalSystem: "hubspot", externalRef: "DEAL-9", evidenceNote: null,
          supersedesEventId: null, billedInPeriodId: null,
        },
      }),
    );

    await newAgent().emitOutcome({
      taskId: "call-8821",
      outcomeKind: "meeting_booked",
      idempotencyKey: "k1",
      quantity: 2,
      externalSystem: "hubspot",
      externalRef: "DEAL-9",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.quantity).toBe(2);
    // Verbatim: a CRM id is case-sensitive, and equality on this pair is what
    // proves two claims are one fact.
    expect(sent.externalRef).toBe("DEAL-9");
  });

  /**
   * The route declares `occurredAt` as `z.string().datetime()`. A value that
   * is merely a string round-trips to a 400 the SDK could have named itself —
   * the trip this method's local-validation posture exists to avoid.
   */
  it("rejects an occurredAt that is not an ISO-8601 UTC timestamp, locally", async () => {
    for (const bad of [
      "not-a-date",
      "2026-09-15",                 // date only — the route refuses it
      "2026-09-15T10:30:00+01:00",  // offset — `.datetime()` demands Z
      "2026-13-45T00:00:00Z",       // shape-valid, not a real instant
    ]) {
      await expect(
        newAgent().emitOutcome({
          taskId: "call-1", outcomeKind: "meeting_booked", idempotencyKey: "k1",
          occurredAt: bad,
        }),
      ).rejects.toThrow(/occurredAt/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a well-formed occurredAt and sends it verbatim", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        outcome: {
          eventId: "oev_00112233445566aa", interactionId: "int_1", outcomeKind: "meeting_booked",
          status: "reported", quantity: 1, occurredAt: "2026-09-15T10:30:00Z", confirmedAt: null,
          source: "agent", externalSystem: null, externalRef: null, evidenceNote: null,
          supersedesEventId: null, billedInPeriodId: null,
        },
      }),
    );

    await newAgent().emitOutcome({
      taskId: "call-1", outcomeKind: "meeting_booked", idempotencyKey: "k1",
      occurredAt: "2026-09-15T10:30:00Z",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).occurredAt).toBe("2026-09-15T10:30:00Z");
  });

  it("rejects an external ref with no system, locally", async () => {
    await expect(
      newAgent().emitOutcome({
        taskId: "call-1", outcomeKind: "meeting_booked", idempotencyKey: "k1",
        externalRef: "DEAL-9",
      }),
    ).rejects.toThrow(/externalRef requires externalSystem/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates outcomeKind and quantity locally", async () => {
    await expect(
      newAgent().emitOutcome({
        taskId: "call-1", outcomeKind: "x".repeat(65), idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/outcomeKind/);
    await expect(
      newAgent().emitOutcome({
        taskId: "call-1", outcomeKind: "meeting_booked", idempotencyKey: "k1", quantity: 0,
      }),
    ).rejects.toThrow(/quantity/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The key may be longer than an attribution tag. Rejecting one the API
  // would have accepted is a client bug, not strictness.
  it("accepts an idempotency key longer than a tag but caps it at 200", async () => {
    await expect(
      newAgent().emitOutcome({
        taskId: "call-1", outcomeKind: "meeting_booked", idempotencyKey: "k".repeat(201),
      }),
    ).rejects.toThrow(/idempotencyKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a refused task id as a typed error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        error: "task_not_found",
        message: "No call in your account carries this task id yet.",
      }),
    );
    await expect(
      newAgent().emitOutcome({
        taskId: "never-happened", outcomeKind: "meeting_booked", idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ status: 404, code: "task_not_found" });
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
