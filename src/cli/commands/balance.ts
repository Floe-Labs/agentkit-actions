import {
  DevApiClient,
  resolveAgentAuth,
  resolveDevAuth,
  authRequired,
  runWithErrorHandling,
} from "../devApiClient.js";
import { hasFlag, printJson } from "../shared.js";

/**
 * `floe-agent balance` — a dev key gets the account-wide rollup
 * (/v1/developer/balances: developer wallet + agent wallets + API
 * credits); an agent key gets its own view (/v1/agents/balance).
 */
export async function runBalanceCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  await runWithErrorHandling(json, async () => {
    const dev = await resolveDevAuth();
    if (dev) {
      const res = (await new DevApiClient(dev).request("GET", "/v1/developer/balances")).body;
      printJson(res);
      return;
    }
    const agentAuth = await resolveAgentAuth();
    if (agentAuth) {
      const res = (
        await new DevApiClient(agentAuth.auth, agentAuth.baseUrl).request("GET", "/v1/agents/balance")
      ).body;
      printJson(res);
      return;
    }
    authRequired(json, "developer");
  });
}
