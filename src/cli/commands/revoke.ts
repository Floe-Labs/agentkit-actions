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
  // Optional override for the facilitator URL. Normally the agent's
  // persisted `facilitatorUrl` is the authoritative source (it's the
  // environment the agent was registered against) — overriding it from
  // the CLI risks revoking in the wrong environment. Kept for advanced
  // recovery flows where the local record's URL is stale.
  facilitatorUrlOverride?: string,
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
  // Prefer the agent's persisted facilitator URL — overriding from the
  // caller is opt-in and rare; the agent was registered against exactly
  // one facilitator and that's the only place revocation makes sense.
  const facilitatorUrl = agent.facilitatorUrl ?? facilitatorUrlOverride;
  if (!facilitatorUrl) {
    console.error(
      chalk.red(`No facilitator URL recorded for "${name}"; pass --facilitator-url to override.`),
    );
    process.exit(1);
  }
  if (facilitatorUrlOverride && facilitatorUrlOverride !== agent.facilitatorUrl) {
    console.warn(
      chalk.yellow(
        `  Note: --facilitator-url (${facilitatorUrlOverride}) differs from the agent's persisted ` +
          `URL (${agent.facilitatorUrl}). Using the agent's URL.`,
      ),
    );
  }
  const client = new FloeApiClient(facilitatorUrl, walletProvider);

  const spinner = ora("Looking up active key...").start();
  try {
    const keys = await client.listAgentKeys(agent.agentId);
    // Prefer the key whose prefix matches what we recorded locally — the
    // server returns the per-agent active list and the local registry's
    // `keyPrefix` is the canonical identifier of the credential this CLI
    // last minted. Falling back to keys[0] keeps the cap-of-1 case
    // working even if local state drifts.
    const active =
      (agent.keyPrefix
        ? keys.find((k) => k.keyPrefix === agent.keyPrefix)
        : undefined) ?? keys[0];
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
