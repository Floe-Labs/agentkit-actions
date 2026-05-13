import chalk from "chalk";
import { loadConfig, listAgents } from "../config.js";
import { getAgentKey } from "../keychain.js";

export async function runListCommand(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.dim("No config found. Run `floe-agent register --name <name>` first."));
    return;
  }
  const agents = listAgents(config);
  if (agents.length === 0) {
    console.log(chalk.dim("No agents registered."));
    return;
  }

  const active = config.activeAgent;
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
