/**
 * Note-building helper for the x402_fetch action, kept in its own module so it
 * can be unit-tested without importing x402ActionProvider.ts — importing that
 * module evaluates the @CreateAction class decorators, which need tsc-emitted
 * parameter metadata and fail under vitest/esbuild.
 */

/**
 * Build the markdown note returned by `x402_fetch` from a successful proxy
 * response. Surfaces the tx hash and (FLO-552) the dollar amount paid —
 * preferring the decimal `X-Floe-Payment-Amount` header and falling back to
 * formatting the raw-units `X-Floe-Cost-USDC` so older facilitators still
 * show an amount.
 */
export function buildProxyResponseNote(headers: Headers, body: string): string {
  const paymentTx = headers.get("payment-response") || headers.get("x-payment-response");
  const costRaw = headers.get("x-floe-cost-usdc");
  const paidAmountFromRaw =
    costRaw && /^\d+$/.test(costRaw)
      ? `${costRaw.slice(0, -6) || "0"}.${costRaw.slice(-6).padStart(6, "0")}`
      : null;
  const paidAmount = headers.get("x-floe-payment-amount") ?? paidAmountFromRaw;

  const lines = ["## Response\n"];
  if (paymentTx || paidAmount) {
    const parts: string[] = [];
    if (paidAmount) parts.push(`$${paidAmount} USDC`);
    if (paymentTx) parts.push(`tx: ${paymentTx}`);
    lines.push(`*Paid via x402 — ${parts.join(" — ")}*\n`);
  }
  lines.push("```", body.slice(0, 4000), "```");
  return lines.join("\n");
}
