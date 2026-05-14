import chalk from "chalk";
import ora from "ora";
import { input, password } from "@inquirer/prompts";
import { createWallet, type WalletConfig } from "../walletFactory.js";
import { FloeApiClient } from "../floeApiClient.js";
import { setAgentKey, envVarNameFor } from "../keychain.js";
import {
  loadConfig,
  saveConfig,
  upsertAgent,
  getAgent,
  type FloeAgentConfig,
} from "../config.js";

async function resolveWalletConfig(
  existing: FloeAgentConfig,
): Promise<WalletConfig> {
  if (existing.walletType === "private-key") {
    const pk =
      process.env.PRIVATE_KEY ||
      (await password({ message: "Private key (0x...):" }));
    return { type: "private-key", privateKey: pk, rpcUrl: existing.rpcUrl };
  }
  const name =
    process.env.CDP_API_KEY_NAME ||
    (await input({ message: "CDP API Key Name:" }));
  const key =
    process.env.CDP_API_KEY_PRIVATE_KEY ||
    (await password({ message: "CDP API Key Private Key:" }));
  return { type: "cdp", apiKeyName: name, apiKeyPrivateKey: key };
}

export async function runRotateCommand(name: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error(chalk.red("No config found."));
    process.exit(1);
  }
  const agent = getAgent(config, name);
  if (!agent) {
    console.error(chalk.red(`Unknown agent "${name}".`));
    process.exit(1);
  }

  const walletConfig = await resolveWalletConfig(config);
  const walletProvider = await createWallet(walletConfig);
  const client = new FloeApiClient(agent.facilitatorUrl, walletProvider);

  const spinner = ora("Rotating API key...").start();
  let newKey: string;
  let newPrefix: string;
  try {
    const keys = await client.listAgentKeys(agent.agentId);
    // Prefer the key matching the locally tracked prefix. Falling back
    // to keys[0] keeps the cap-of-1 case working even if local state
    // drifted (e.g., user rotated through the dashboard and lost the
    // local registry).
    const current =
      (agent.keyPrefix
        ? keys.find((k) => k.keyPrefix === agent.keyPrefix)
        : undefined) ?? keys[0];
    if (!current) {
      spinner.fail("No active key to rotate. Use `floe-agent register` instead.");
      process.exit(1);
    }
    const rotated = await client.rotateAgentKey(agent.agentId, current.id);
    newKey = rotated.key;
    newPrefix = rotated.keyPrefix;
    spinner.succeed(`Rotated key (old: ${current.keyPrefix}, new: ${newPrefix})`);
  } catch (err) {
    spinner.fail(`Rotate failed: ${(err as Error).message}`);
    process.exit(1);
  }

  upsertAgent(config, { ...agent, keyPrefix: newPrefix, revoked: false });
  saveConfig(config);

  let storedInKeychain = true;
  try {
    await setAgentKey(name, agent.facilitatorUrl, newKey);
  } catch (err) {
    storedInKeychain = false;
    console.warn(
      chalk.yellow(
        `  Keychain write failed: ${(err as Error).message}. ` +
          `Capture the key shown below — it won't be regenerated.`,
      ),
    );
  }

  console.log("");
  console.log(`  ${chalk.bold("New API Key:")} ${chalk.yellow(newKey)}  ${chalk.dim("(shown ONCE)")}`);
  if (storedInKeychain) {
    console.log(chalk.dim("  Stored in OS keychain (or env-var fallback)."));
  } else {
    const envName = envVarNameFor(name, agent.facilitatorUrl);
    console.log(chalk.dim(`  Export ${envName} to load this key on next \`floe-agent run\`.`));
  }
  console.log("");
}
