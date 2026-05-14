import chalk from "chalk";
import { loadConfig, saveConfig, getAgent } from "../config.js";

export function runUseCommand(name: string): void {
  const config = loadConfig();
  if (!config) {
    console.error(chalk.red("No config found. Register an agent first."));
    process.exit(1);
  }
  if (!getAgent(config, name)) {
    console.error(chalk.red(`Unknown agent "${name}". Run \`floe-agent agents\` to list.`));
    process.exit(1);
  }
  config.activeAgent = name;
  saveConfig(config);
  console.log(chalk.green(`  Active agent set to "${name}".`));
}
