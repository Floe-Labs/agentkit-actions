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
  rawToUsd,
  usageError,
  usdToRawArg,
} from "../shared.js";

/**
 * `floe-agent limit get|set|clear` — the session spend cap. Same dual-surface
 * routing as `floe-agent policy`: an agent key edits its own cap via
 * /v1/agents/spend-limit; a dev key needs --agent <id> and goes through
 * /v1/developer/agents/:id/spend-limit. PUT restarts the session window.
 */
async function resolveRoute(args: string[], json: boolean): Promise<{ client: DevApiClient; basePath: string }> {
  const agentId = parseFlag(args, "agent");
  if (agentId) {
    if (!/^\d+$/.test(agentId)) usageError("--agent must be a numeric agentId.", json);
    const auth = await requireDevAuth(json);
    return { client: new DevApiClient(auth), basePath: `/v1/developer/agents/${agentId}/spend-limit` };
  }
  const agentAuth = await resolveAgentAuth();
  if (agentAuth) {
    return { client: new DevApiClient(agentAuth.auth, agentAuth.baseUrl), basePath: "/v1/agents/spend-limit" };
  }
  if (await resolveDevAuth()) {
    usageError("Developer credentials need a target: pass --agent <id>.", json);
  }
  authRequired(json, "agent");
}

export async function runLimitCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const pos = positionals(args);
  const verb = pos[0];
  await runWithErrorHandling(json, async () => {
    if (verb === "get") {
      const route = await resolveRoute(args, json);
      const res = (await route.client.request("GET", route.basePath)).body as {
        active: boolean;
        limitRaw: string | null;
        sessionSpentRaw?: string;
      };
      if (json) {
        printJson(res);
        return;
      }
      if (!res.active) {
        console.log(chalk.dim("No session spend limit set."));
        return;
      }
      console.log(
        `  Limit ${rawToUsd(res.limitRaw)}${res.sessionSpentRaw !== undefined ? `, spent ${rawToUsd(res.sessionSpentRaw)}` : ""}`,
      );
      return;
    }
    if (verb === "set") {
      const usd = pos[1] ?? parseFlag(args, "limit");
      if (!usd) usageError("Usage: floe-agent limit set <usd> [--agent <id>] [--json]", json);
      const limitRaw = usdToRawArg(usd, "limit set", json);
      const route = await resolveRoute(args, json);
      const res = (await route.client.request("PUT", route.basePath, { body: { limitRaw } })).body;
      if (json) printJson(res);
      else console.log(chalk.green(`  Session spend limit set to ${rawToUsd(limitRaw)} (window restarted).`));
      return;
    }
    if (verb === "clear") {
      const route = await resolveRoute(args, json);
      const res = (await route.client.request("DELETE", route.basePath)).body;
      if (json) printJson(res);
      else console.log(chalk.green("  Session spend limit cleared."));
      return;
    }
    usageError("Usage: floe-agent limit <get|set|clear> [<usd>] [--agent <id>] [--json]", json);
  });
}
