import chalk from "chalk";
import {
  DevApiClient,
  requireDevAuth,
  resolveDevAuth,
  resolveAgentAuth,
  runWithErrorHandling,
  type ResolvedAuth,
} from "../devApiClient.js";
import { apiBaseUrl, hasFlag, printJson, rawToUsd } from "../shared.js";

/**
 * `floe status` — the one-shot health probe an agent runs after setup:
 * (1) does my credential authenticate, (2) which gateway/proxy features are
 * live on this deployment, (3) what money is there to spend.
 *
 * Prefers the developer plane; falls back to the agent plane so a runtime
 * key alone still gets a meaningful answer. `/v1/capabilities` may not be
 * deployed yet — a 404 there reports `capabilities: null`, never a failure.
 */
export async function runStatusCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  await runWithErrorHandling(json, async () => {
    const dev = await resolveDevAuth();
    if (dev) {
      await devStatus(dev, json);
      return;
    }
    const agentAuth = await resolveAgentAuth();
    if (agentAuth) {
      await agentStatus(agentAuth.auth, agentAuth.baseUrl, json);
      return;
    }
    // Neither plane has credentials → the standard exit-4 path.
    await requireDevAuth(json);
  });
}

async function fetchCapabilities(client: DevApiClient): Promise<unknown | null> {
  // Graceful degradation: older API deployments have no /v1/capabilities.
  try {
    const res = await client.request("GET", "/v1/capabilities", { expectError: true });
    return res.status === 200 ? res.body : null;
  } catch {
    return null; // network-level failure on the probe is also non-fatal
  }
}

async function devStatus(auth: ResolvedAuth, json: boolean): Promise<void> {
  const client = new DevApiClient(auth);
  const profile = (await client.request("GET", "/v1/developer/profile")).body as {
    walletAddress?: string;
    displayName?: string | null;
    aiToolConnectedAt?: string | null;
    agents?: unknown[];
  };
  const capabilities = await fetchCapabilities(client);
  let balances: unknown | null = null;
  try {
    balances = (await client.request("GET", "/v1/developer/balances")).body;
  } catch {
    balances = null; // balances are a snapshot, not a gate
  }

  if (json) {
    printJson({
      auth: { plane: "developer", source: auth.source, keyPrefix: auth.keyPrefix ?? null },
      apiUrl: apiBaseUrl(),
      profile,
      capabilities,
      balances,
    });
    return;
  }

  console.log("");
  console.log(chalk.bold("  Floe status"));
  console.log("");
  console.log(`  ${chalk.bold("Auth:")}       developer (${auth.source}${auth.keyPrefix ? `, ${auth.keyPrefix}` : ""})`);
  console.log(`  ${chalk.bold("API:")}        ${apiBaseUrl()}`);
  if (profile.walletAddress) {
    console.log(`  ${chalk.bold("Wallet:")}     ${profile.walletAddress}`);
  }
  if (profile.displayName) {
    console.log(`  ${chalk.bold("Name:")}       ${profile.displayName}`);
  }
  console.log(`  ${chalk.bold("Agents:")}     ${Array.isArray(profile.agents) ? profile.agents.length : 0}`);
  console.log(
    `  ${chalk.bold("Features:")}   ${capabilities ? JSON.stringify(capabilities) : chalk.dim("unknown (/v1/capabilities not deployed)")}`,
  );
  if (balances && typeof balances === "object") {
    const b = balances as { totalUsdc?: string; total?: { usdcRaw?: string } };
    const totalRaw = b.total?.usdcRaw ?? b.totalUsdc;
    if (totalRaw) {
      console.log(`  ${chalk.bold("Balances:")}   ${rawToUsd(totalRaw)} USDC total`);
    } else {
      console.log(`  ${chalk.bold("Balances:")}   ${chalk.dim("see `floe balance --json`")}`);
    }
  }
  console.log("");
}

async function agentStatus(auth: ResolvedAuth, baseUrl: string, json: boolean): Promise<void> {
  const client = new DevApiClient(auth, baseUrl);
  const balance = (await client.request("GET", "/v1/agents/balance")).body;
  const capabilities = await fetchCapabilities(client);
  let creditRemaining: unknown | null = null;
  try {
    creditRemaining = (await client.request("GET", "/v1/agents/credit-remaining")).body;
  } catch {
    creditRemaining = null;
  }

  if (json) {
    printJson({
      auth: { plane: "agent", source: auth.source, keyPrefix: auth.keyPrefix ?? null },
      apiUrl: baseUrl,
      capabilities,
      balance,
      creditRemaining,
    });
    return;
  }

  console.log("");
  console.log(chalk.bold("  Floe status"));
  console.log("");
  console.log(`  ${chalk.bold("Auth:")}       agent (${auth.source}${auth.keyPrefix ? `, ${auth.keyPrefix}` : ""})`);
  console.log(`  ${chalk.bold("API:")}        ${baseUrl}`);
  console.log(
    `  ${chalk.bold("Features:")}   ${capabilities ? JSON.stringify(capabilities) : chalk.dim("unknown (/v1/capabilities not deployed)")}`,
  );
  console.log(`  ${chalk.bold("Balance:")}    ${JSON.stringify(balance)}`);
  if (creditRemaining) {
    console.log(`  ${chalk.bold("Credit:")}     ${JSON.stringify(creditRemaining)}`);
  }
  console.log("");
}
