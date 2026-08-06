import {
  DevApiClient,
  requireDevAuth,
  resolveAgentAuth,
  resolveDevAuth,
  authRequired,
  runWithErrorHandling,
} from "../devApiClient.js";
import { hasFlag, parseFlag, printJson } from "../shared.js";

/**
 * Read-only observability commands. All three print raw API JSON in both
 * modes — the payloads are tables an agent (or jq) consumes directly.
 *
 *   floe-agent models    → GET /v1/models                        (any credential)
 *   floe-agent usage     → GET /v1/developer/analytics/summary   (dev key)
 *   floe-agent activity  → GET /v1/developer/activity            (dev key)
 */
export async function runModelsCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  await runWithErrorHandling(json, async () => {
    // /v1/models sits behind the generic /v1 auth wall but accepts any
    // principal — use whichever credential resolves.
    const dev = await resolveDevAuth();
    if (dev) {
      printJson((await new DevApiClient(dev).request("GET", "/v1/models")).body);
      return;
    }
    const agentAuth = await resolveAgentAuth();
    if (agentAuth) {
      printJson(
        (await new DevApiClient(agentAuth.auth, agentAuth.baseUrl).request("GET", "/v1/models")).body,
      );
      return;
    }
    authRequired(json, "developer");
  });
}

export async function runUsageCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  await runWithErrorHandling(json, async () => {
    const auth = await requireDevAuth(json);
    printJson((await new DevApiClient(auth).request("GET", "/v1/developer/analytics/summary")).body);
  });
}

export async function runActivityCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  await runWithErrorHandling(json, async () => {
    const auth = await requireDevAuth(json);
    const limit = parseFlag(args, "limit");
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    printJson((await new DevApiClient(auth).request("GET", `/v1/developer/activity${query}`)).body);
  });
}
