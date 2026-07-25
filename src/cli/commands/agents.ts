import chalk from "chalk";
import { loadConfig, listAgents } from "../config.js";
import { getAgentKey } from "../keychain.js";
import { printJson } from "../shared.js";

/**
 * Local-registry listing (`floe agents` with no subcommand): what's in
 * .floe-agent.json plus key presence. Server-side inventory lives under
 * `floe agents list`.
 */
export async function runListCommand(json = false): Promise<void> {
  const config = loadConfig();
  if (!config) {
    if (json) {
      printJson({ agents: [], activeAgent: null });
    } else {
      console.log(chalk.dim("No config found. Run `floe-agent register --name <name>` first."));
    }
    return;
  }
  const agents = listAgents(config);
  if (agents.length === 0) {
    if (json) {
      printJson({ agents: [], activeAgent: config.activeAgent ?? null });
    } else {
      console.log(chalk.dim("No agents registered."));
    }
    return;
  }

  const active = config.activeAgent;
  if (json) {
    const rows = [];
    for (const a of agents) {
      const key = await getAgentKey(a.name, a.facilitatorUrl);
      rows.push({ ...a, keyPresent: Boolean(key) });
    }
    printJson({ agents: rows, activeAgent: active ?? null });
    return;
  }
  console.log("");
  console.log(chalk.bold("  Registered Floe agents:"));
  console.log("");
  for (const a of agents) {
    const key = await getAgentKey(a.name, a.facilitatorUrl);
    const keyStatus = a.revoked
      ? chalk.dim("revoked")
      : key
        ? chalk.green("key present")
        : chalk.yellow("key MISSING");
    const marker = a.name === active ? chalk.green("● ") : "  ";
    console.log(
      `${marker}${chalk.bold(a.name)}  ${chalk.dim(`(id=${a.agentId}, ${a.keyPrefix}…)`)}  ${keyStatus}`,
    );
    console.log(`    ${chalk.dim(`privy: ${a.privyWalletAddress}`)}`);
    console.log(`    ${chalk.dim(`facilitator: ${a.facilitatorUrl}`)}`);
  }
  console.log("");
}
