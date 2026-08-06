import chalk from "chalk";
import {
  DevApiClient,
  requireDevAuth,
  resolveAgentAuth,
  resolveDevAuth,
  authRequired,
  runWithErrorHandling,
} from "../devApiClient.js";
import {
  hasFlag,
  parseFlag,
  positionals,
  printJson,
  usageError,
  usdToRawArg,
} from "../shared.js";

/**
 * `floe-agent allowlist mode|add|remove|list` — merchant allowlist. Entries are
 * ordinary policy rows (kind='api' hosts / kind='vendor' payees, always
 * capped via limitRaw); `mode` flips which proxy gates enforce them.
 * Agent key → self-service routes; dev key → --agent <id> operator routes.
 */
const MODES = ["off", "host", "vendor", "both"];

interface Route {
  client: DevApiClient;
  policiesPath: string;
  modePath: string;
}

async function resolveRoute(args: string[], json: boolean): Promise<Route> {
  const agentId = parseFlag(args, "agent");
  if (agentId) {
    if (!/^\d+$/.test(agentId)) usageError("--agent must be a numeric agentId.", json);
    const auth = await requireDevAuth(json);
    const base = `/v1/developer/agents/${agentId}`;
    return {
      client: new DevApiClient(auth),
      policiesPath: `${base}/policies`,
      modePath: `${base}/allowlist-mode`,
    };
  }
  const agentAuth = await resolveAgentAuth();
  if (agentAuth) {
    return {
      client: new DevApiClient(agentAuth.auth, agentAuth.baseUrl),
      policiesPath: "/v1/agents/policies",
      modePath: "/v1/agents/allowlist-mode",
    };
  }
  if (await resolveDevAuth()) {
    usageError("Developer credentials need a target: pass --agent <id>.", json);
  }
  authRequired(json, "agent");
}

export async function runAllowlistCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const pos = positionals(args);
  const verb = pos[0];
  await runWithErrorHandling(json, async () => {
    if (verb === "mode") {
      const newMode = pos[1];
      // Usage errors beat auth errors — validate before resolving credentials.
      if (newMode !== undefined && !MODES.includes(newMode)) {
        usageError(`Usage: floe-agent allowlist mode [${MODES.join("|")}] [--agent <id>] [--json]`, json);
      }
      const route = await resolveRoute(args, json);
      if (newMode === undefined) {
        const res = (await route.client.request("GET", route.modePath)).body;
        if (json) printJson(res);
        else console.log(`  Allowlist mode: ${chalk.bold((res as { mode?: string }).mode ?? "off")}`);
        return;
      }
      const res = (await route.client.request("PUT", route.modePath, { body: { mode: newMode } })).body as {
        mode: string;
        warning?: { code: string; dimensions: string[] };
      };
      if (json) {
        printJson(res);
        return;
      }
      console.log(chalk.green(`  Allowlist mode set to ${res.mode}.`));
      if (res.warning?.code === "no_active_entries") {
        console.log(
          chalk.yellow(
            `  Warning: no active entries for ${res.warning.dimensions.join(", ")} — ` +
              "every call on that dimension now fails closed. Add entries with `floe-agent allowlist add`.",
          ),
        );
      }
      return;
    }

    if (verb === "add") {
      const kind = parseFlag(args, "kind") ?? "api";
      if (kind !== "api" && kind !== "vendor") {
        usageError("--kind must be 'api' (host) or 'vendor' (payee wallet).", json);
      }
      const matchKey = parseFlag(args, "match") ?? pos[1];
      if (!matchKey) {
        usageError(
          "Usage: floe-agent allowlist add <host|payee> [--kind api|vendor] (--limit <usd> | --limit-raw <raw>) " +
            "[--match-kind host_exact|host_suffix|recipient] [--agent <id>] [--json]",
          json,
        );
      }
      const limitUsd = parseFlag(args, "limit");
      const limitRaw =
        parseFlag(args, "limit-raw") ?? (limitUsd ? usdToRawArg(limitUsd, "--limit", json) : undefined);
      if (!limitRaw) usageError("Allowlist entries are capped — pass --limit <usd> or --limit-raw <raw>.", json);

      const route = await resolveRoute(args, json);
      const body: Record<string, unknown> = { kind, matchKey, limitRaw };
      const matchKind = parseFlag(args, "match-kind");
      if (matchKind) body.matchKind = matchKind;
      const res = (await route.client.request("POST", route.policiesPath, { body })).body;
      if (json) printJson(res);
      else console.log(chalk.green(`  Allowlist entry added: ${JSON.stringify(res)}`));
      return;
    }

    if (verb === "remove") {
      const policyId = pos[1];
      if (!policyId || !/^\d+$/.test(policyId)) {
        usageError("Usage: floe-agent allowlist remove <policyId> [--agent <id>] [--json]", json);
      }
      const route = await resolveRoute(args, json);
      await route.client.request("DELETE", `${route.policiesPath}/${policyId}`);
      if (json) printJson({ removed: true, policyId: Number(policyId) });
      else console.log(chalk.green(`  Allowlist entry ${policyId} removed.`));
      return;
    }

    if (verb === "list") {
      const route = await resolveRoute(args, json);
      const res = (await route.client.request("GET", route.policiesPath)).body as {
        policies?: Array<Record<string, unknown>>;
      };
      // Allowlist entries are the kind='api'/'vendor' subset of policies.
      const entries = (res.policies ?? []).filter((p) => p.kind === "api" || p.kind === "vendor");
      if (json) {
        printJson({ policies: entries });
        return;
      }
      if (entries.length === 0) {
        console.log(chalk.dim("No allowlist entries."));
        return;
      }
      console.log("");
      for (const p of entries) {
        console.log(
          `  ${chalk.bold(`#${p.id}`)} ${p.kind}:${p.matchKey}  ${chalk.dim(`limitRaw=${p.limitRaw}`)}`,
        );
      }
      console.log("");
      return;
    }

    usageError("Usage: floe-agent allowlist <mode|add|remove|list> [--agent <id>] [--json]", json);
  });
}
