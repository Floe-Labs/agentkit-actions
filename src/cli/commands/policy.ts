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
  positiveIntArg,
  printJson,
  usageError,
  usdToRawArg,
} from "../shared.js";

/**
 * `floe policy list|set|delete|reset` — spend-policy CRUD across three
 * surfaces that share one body shape (policy-schemas.ts server-side):
 *
 *   --agent <id>  → /v1/developer/agents/:id/policies  (dev key)
 *   --team        → /v1/developer/policies              (dev key; kind may
 *                   be 'session', reset unsupported)
 *   neither       → /v1/agents/policies                 (agent key
 *                   self-service)
 */

interface PolicyRoute {
  client: DevApiClient;
  basePath: string;
  supportsReset: boolean;
  team: boolean;
}

async function resolveRoute(args: string[], json: boolean): Promise<PolicyRoute> {
  const agentId = parseFlag(args, "agent");
  const team = hasFlag(args, "team");
  if (agentId && team) usageError("Pass --agent <id> OR --team, not both.", json);
  if (team) {
    const auth = await requireDevAuth(json);
    return { client: new DevApiClient(auth), basePath: "/v1/developer/policies", supportsReset: false, team: true };
  }
  if (agentId) {
    if (!/^\d+$/.test(agentId)) usageError("--agent must be a numeric agentId.", json);
    const auth = await requireDevAuth(json);
    return {
      client: new DevApiClient(auth),
      basePath: `/v1/developer/agents/${agentId}/policies`,
      supportsReset: true,
      team: false,
    };
  }
  const agentAuth = await resolveAgentAuth();
  if (agentAuth) {
    return {
      client: new DevApiClient(agentAuth.auth, agentAuth.baseUrl),
      basePath: "/v1/agents/policies",
      supportsReset: true,
      team: false,
    };
  }
  // A dev credential without --agent/--team is ambiguous, not unauthenticated.
  if (await resolveDevAuth()) {
    usageError("Developer credentials need a scope: pass --agent <id> or --team.", json);
  }
  authRequired(json, "agent");
}

export async function runPolicyCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const pos = positionals(args);
  const verb = pos[0];
  await runWithErrorHandling(json, async () => {
    if (verb === "list") {
      const route = await resolveRoute(args, json);
      const query = hasFlag(args, "include-revoked") ? "?includeRevoked=true" : "";
      const res = (await route.client.request("GET", `${route.basePath}${query}`)).body as {
        policies?: Array<Record<string, unknown>>;
      };
      if (json) {
        printJson(res);
        return;
      }
      const policies = res.policies ?? [];
      if (policies.length === 0) {
        console.log(chalk.dim("No policies."));
        return;
      }
      console.log("");
      for (const p of policies) {
        console.log(
          `  ${chalk.bold(`#${p.id}`)} ${p.kind}${p.matchKey ? `:${p.matchKey}` : ""}  ` +
            chalk.dim(`limitRaw=${p.limitRaw} window=${p.windowKind}${p.label ? ` (${p.label})` : ""}`),
        );
      }
      console.log("");
      return;
    }

    if (verb === "set") {
      const kind = parseFlag(args, "kind");
      const validKinds = ["task", "api", "vendor", "session"];
      if (!kind || !validKinds.includes(kind)) {
        usageError(
          "Usage: floe policy set --kind <task|api|vendor|session> --match <key> " +
            "(--limit <usd> | --limit-raw <raw>) [--window-kind once|rolling] [--window-seconds <s>] " +
            "[--label <l>] [--action block|suspend_agent] [--agent <id>|--team] [--json]",
          json,
        );
      }
      const route = await resolveRoute(args, json);
      if (kind === "session" && !route.team) {
        usageError(
          "kind=session is team-scope only (`--team`). For a per-agent session cap use `floe limit set`.",
          json,
        );
      }
      const matchKey = parseFlag(args, "match");
      if (kind !== "session" && !matchKey) {
        usageError(`--match <key> is required for kind=${kind}.`, json);
      }
      const limitUsd = parseFlag(args, "limit");
      const limitRaw =
        parseFlag(args, "limit-raw") ?? (limitUsd ? usdToRawArg(limitUsd, "--limit", json) : undefined);
      if (!limitRaw) usageError("Pass --limit <usd> or --limit-raw <raw USDC>.", json);

      const body: Record<string, unknown> = { kind, limitRaw };
      if (matchKey) body.matchKey = matchKey;
      const matchKind = parseFlag(args, "match-kind");
      if (matchKind) body.matchKind = matchKind;
      const windowKind = parseFlag(args, "window-kind");
      if (windowKind) body.windowKind = windowKind;
      // Presence-based: an explicitly supplied-but-empty flag is a usage
      // error, not a silent no-op.
      if (hasFlag(args, "window-seconds")) {
        body.windowSeconds = positiveIntArg(
          parseFlag(args, "window-seconds") ?? "",
          "--window-seconds",
          json,
        );
      }
      const label = parseFlag(args, "label");
      if (label) body.label = label;
      const action = parseFlag(args, "action");
      if (action) body.action = action;

      const res = (await route.client.request("POST", route.basePath, { body })).body;
      if (json) printJson(res);
      else console.log(chalk.green(`  Policy created: ${JSON.stringify(res)}`));
      return;
    }

    if (verb === "delete" || verb === "reset") {
      const policyId = pos[1];
      if (!policyId || !/^\d+$/.test(policyId)) {
        usageError(`Usage: floe policy ${verb} <policyId> [--agent <id>|--team] [--json]`, json);
      }
      // Usage errors beat auth errors — --team reset is invalid regardless
      // of credentials (the team surface has no reset endpoint).
      if (verb === "reset" && hasFlag(args, "team")) {
        usageError("Team policies have no reset endpoint — delete and re-create instead.", json);
      }
      const route = await resolveRoute(args, json);
      if (verb === "reset") {
        if (!route.supportsReset) {
          usageError("Team policies have no reset endpoint — delete and re-create instead.", json);
        }
        const res = (
          await route.client.request("POST", `${route.basePath}/${policyId}/reset`, { body: {} })
        ).body;
        if (json) printJson(res);
        else console.log(chalk.green(`  Policy ${policyId} window reset.`));
        return;
      }
      await route.client.request("DELETE", `${route.basePath}/${policyId}`);
      if (json) printJson({ deleted: true, policyId: Number(policyId) });
      else console.log(chalk.green(`  Policy ${policyId} deleted.`));
      return;
    }

    usageError("Usage: floe policy <list|set|delete|reset> [--agent <id>|--team] [--json]", json);
  });
}
