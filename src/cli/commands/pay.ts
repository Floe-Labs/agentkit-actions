import chalk from "chalk";
import { randomUUID } from "crypto";
import { DevApiClient, requireAgentAuth, runWithErrorHandling } from "../devApiClient.js";
import {
  EXIT_PAYMENT_REQUIRED,
  collectFlags,
  exitForStatus,
  hasFlag,
  parseFlag,
  positionals,
  printJson,
  rawToUsd,
  usageError,
} from "../shared.js";

/**
 * `floe pay <url>` — the felt demo: one real x402 call through
 * POST /v1/proxy/fetch (agent key). Free URLs pass through; 402-gated ones
 * are paid from the agent's balance and the settled cost comes back on the
 * `x-floe-cost-usdc` header.
 *
 * An Idempotency-Key is always sent (auto-generated UUID unless
 * --idempotency-key is given) so a retried command can never double-pay.
 * Insufficient credit exits 5 per the CLI contract.
 */
export async function runPayCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const url = positionals(args)[0];
  if (!url) {
    usageError(
      'Usage: floe pay <url> [--method <M>] [--body <raw>] [--header "K: V"]… ' +
        "[--task-id <id>] [--idempotency-key <k>] [--json]",
      json,
    );
  }
  await runWithErrorHandling(json, async () => {
    const { auth, baseUrl } = await requireAgentAuth(json);
    const client = new DevApiClient(auth, baseUrl);

    const payload: Record<string, unknown> = {
      url,
      method: (parseFlag(args, "method") ?? "GET").toUpperCase(),
    };
    const body = parseFlag(args, "body");
    if (body !== undefined) payload.body = body;
    const headerFlags = collectFlags(args, "header");
    if (headerFlags.length > 0) {
      const headers: Record<string, string> = {};
      for (const h of headerFlags) {
        const idx = h.indexOf(":");
        if (idx < 1) throw new Error(`--header must be "Name: value" (got '${h}').`);
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
      payload.headers = headers;
    }

    const requestHeaders: Record<string, string> = {
      "Idempotency-Key": parseFlag(args, "idempotency-key") ?? randomUUID(),
    };
    const taskId = parseFlag(args, "task-id");
    if (taskId) requestHeaders["X-Floe-Task-Id"] = taskId;

    const res = await client.request("POST", "/v1/proxy/fetch", {
      body: payload,
      headers: requestHeaders,
      expectError: true,
    });

    if (res.status >= 400) {
      const errBody = res.body as { error?: string; detail?: string; message?: string } | string;
      const code = typeof errBody === "object" && errBody !== null ? errBody.error : undefined;
      const message =
        (typeof errBody === "object" && errBody !== null
          ? errBody.detail || errBody.message || errBody.error
          : String(errBody)) ?? `pay failed: ${res.status}`;
      // 402 and the API's insufficient-credit family → exit 5.
      const paymentShort =
        res.status === 402 || (code ?? "").includes("insufficient") || code === "no_credit_limit";
      if (json) {
        printJson({ error: "payment_failed", status: res.status, code: code ?? null, message, body: errBody });
      } else {
        console.error(chalk.red(`Payment failed (${res.status}): ${message}`));
        if (code === "upstream_paid_request_failed_ambiguous") {
          console.error(
            chalk.yellow(
              "  Settlement is ambiguous — do NOT retry. Check the reservation via the API before paying again.",
            ),
          );
        }
      }
      process.exit(paymentShort ? EXIT_PAYMENT_REQUIRED : exitForStatus(res.status));
    }

    const costRaw = res.headers.get("x-floe-cost-usdc");
    const replay = res.headers.get("x-floe-idempotent-replay") === "true";
    if (json) {
      printJson({
        status: res.status,
        costRaw: costRaw ?? null,
        idempotentReplay: replay,
        body: res.body,
      });
      return;
    }
    console.log("");
    console.log(`  ${chalk.bold("Status:")} ${res.status}${replay ? chalk.dim(" (idempotent replay)") : ""}`);
    console.log(`  ${chalk.bold("Cost:")}   ${costRaw ? `${rawToUsd(costRaw)} USDC` : "free"}`);
    console.log("");
    const bodyStr = typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
    console.log(bodyStr);
  });
}
