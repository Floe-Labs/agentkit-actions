import chalk from "chalk";
import ora from "ora";
import { input, password, select, confirm } from "@inquirer/prompts";
import { createWallet, type WalletConfig } from "../walletFactory.js";
import { FloeApiClient } from "../floeApiClient.js";
import { deleteAgentKey } from "../keychain.js";
import {
  loadConfig,
  saveConfig,
  getAgent,
  type FloeAgentConfig,
} from "../config.js";

async function resolveWalletConfig(
  existing: FloeAgentConfig,
): Promise<WalletConfig> {
  const walletType = existing.walletType;
  if (walletType === "private-key") {
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

export async function runRevokeCommand(
  name: string,
  facilitatorUrl: string,
): Promise<void> {
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

  const ok = await confirm({
    message: `Revoke API key for "${name}" (id=${agent.agentId})? This cannot be undone.`,
    default: false,
  });
  if (!ok) {
    console.log(chalk.dim("Aborted."));
    return;
  }

  const walletConfig = await resolveWalletConfig(config);
  const walletProvider = await createWallet(walletConfig);
  const client = new FloeApiClient(facilitatorUrl, walletProvider);

  const spinner = ora("Looking up active key...").start();
  try {
    const keys = await client.listAgentKeys(agent.agentId);
    const active = keys[0];
    if (!active) {
      spinner.warn("No active keys found server-side. Clearing local entry.");
    } else {
      await client.revokeAgentKey(agent.agentId, active.id);
      spinner.succeed(`Revoked key ${active.keyPrefix}`);
    }
  } catch (err) {
    spinner.fail(`Revoke failed: ${(err as Error).message}`);
    process.exit(1);
  }

  await deleteAgentKey(name, agent.facilitatorUrl);
  agent.revoked = true;
  saveConfig(config);
  console.log(chalk.green(`  Local keychain entry for "${name}" removed.`));
}
