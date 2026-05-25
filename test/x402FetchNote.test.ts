/**
 * FLO-552 — the x402_fetch note must surface the dollar amount paid.
 *
 * Tests the pure note-builder directly. The full X402ActionProvider can't be
 * instantiated under vitest/esbuild (the @CreateAction decorators need
 * tsc-emitted parameter metadata), which is why the note logic lives in an
 * exported helper.
 */

import { describe, it, expect } from "vitest";
import { buildProxyResponseNote } from "../src/proxyNote.js";

describe("buildProxyResponseNote — FLO-552 paid amount", () => {
  it("uses the decimal X-Floe-Payment-Amount header", () => {
    const note = buildProxyResponseNote(
      new Headers({ "x-floe-payment-amount": "0.001000", "payment-response": "0xabc" }),
      "{}",
    );
    expect(note).toContain("$0.001000 USDC");
    expect(note).toContain("tx: 0xabc");
  });

  it("falls back to formatting raw X-Floe-Cost-USDC", () => {
    const note = buildProxyResponseNote(new Headers({ "x-floe-cost-usdc": "1000" }), "{}");
    expect(note).toContain("$0.001000 USDC");
  });

  it("omits the paid line when no payment headers are present", () => {
    const note = buildProxyResponseNote(new Headers({}), "{}");
    expect(note).not.toContain("Paid via x402");
  });
});
