import chalk from "chalk";
import { DevApiClient, requireDevAuth, runWithErrorHandling } from "../devApiClient.js";
import { hasFlag, parseFlag, positionals, printJson, usageError } from "../shared.js";

/**
 * `floe webhooks create|list|test|rotate-secret|deliveries` — developer
 * webhook CRUD via /v1/developer/webhooks. The event catalog spans loan
 * lifecycle (loan.health_warning / expiry_warning / liquidated / repaid)
 * plus the onboarding events (agent.created, key.created, key.rotated,
 * x402.first_settlement); we pass event names through verbatim so new
 * server-side events work without a CLI release.
 */
export async function runWebhooksCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const pos = positionals(args);
  const verb = pos[0];
  // Usage errors beat auth errors: validate the invocation before resolving
  // credentials so a malformed call exits 2 with or without a key set.
  if (!verb || !["create", "list", "test", "rotate-secret", "deliveries"].includes(verb)) {
    usageError("Usage: floe webhooks <create|list|test|rotate-secret|deliveries> [id] [--json]", json);
  }
  const url = parseFlag(args, "url") ?? (verb === "create" ? pos[1] : undefined);
  const events = parseFlag(args, "events");
  if (verb === "create" && (!url || !events)) {
    usageError(
      "Usage: floe webhooks create --url <https-url> --events <e1,e2> " +
        "[--scope global|wallet|loan --scope-value <v>] [--description <d>] [--json]",
      json,
    );
  }
  if (verb === "create" && url) {
    // The usage contract requires an HTTPS endpoint — reject malformed or
    // plain-http URLs before auth/API calls (server-side validation remains
    // the security boundary).
    let protocol: string | null = null;
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = null;
    }
    if (protocol !== "https:") {
      usageError(`--url must be a valid https:// URL, got '${url}'.`, json);
    }
  }
  const id = pos[1];
  if ((verb === "test" || verb === "rotate-secret" || verb === "deliveries") && (!id || !/^\d+$/.test(id))) {
    usageError(`Usage: floe webhooks ${verb} <webhookId> [--json]`, json);
  }
  await runWithErrorHandling(json, async () => {
    const auth = await requireDevAuth(json);
    const client = new DevApiClient(auth);

    if (verb === "create") {
      const body: Record<string, unknown> = {
        url,
        events: (events as string).split(",").map((e) => e.trim()).filter(Boolean),
        scope: parseFlag(args, "scope") ?? "global",
      };
      const scopeValue = parseFlag(args, "scope-value");
      if (scopeValue) body.scopeValue = scopeValue;
      const description = parseFlag(args, "description");
      if (description) body.description = description;
      const res = (await client.request("POST", "/v1/developer/webhooks", { body })).body;
      if (json) {
        printJson(res);
        return;
      }
      printJson(res); // includes the signing secret — shown once, keep it verbatim
      console.log(chalk.dim("  The `secret` above is shown once — store it for signature verification."));
      return;
    }

    if (verb === "list") {
      printJson((await client.request("GET", "/v1/developer/webhooks")).body);
      return;
    }

    if (verb === "test") {
      const res = (await client.request("POST", `/v1/developer/webhooks/${id}/test`, { body: {} }))
        .body;
      if (json) printJson(res);
      else console.log(chalk.green(`  Test delivery queued: ${JSON.stringify(res)}`));
      return;
    }
    if (verb === "rotate-secret") {
      const res = (
        await client.request("POST", `/v1/developer/webhooks/${id}/rotate-secret`, { body: {} })
      ).body;
      printJson(res); // new secret — shown once
      return;
    }
    printJson((await client.request("GET", `/v1/developer/webhooks/${id}/deliveries`)).body);
  });
}
