import chalk from "chalk";
import ora from "ora";
import { input, password, select } from "@inquirer/prompts";
import { createWallet, type WalletConfig } from "../walletFactory.js";
import { FloeApiClient } from "../floeApiClient.js";
import { setAgentKey } from "../keychain.js";
import {
  loadConfig,
  saveConfig,
  upsertAgent,
  type FloeAgentConfig,
} from "../config.js";

export interface RegisterArgs {
  name: string;
  facilitatorUrl: string;
  borrowLimitUsdc?: string;
  maxRateBps?: number;
  expiryDays?: number;
  label?: string;
}

const USDC_DECIMALS = 6;

function usdcToRaw(usdcAmount: string): string {
  // "10000" → "10000000000" (10K USDC, 6 decimals).
  // Mirrors the Python implementation: rejects zero, non-numeric input,
  // and fractional inputs with more precision than USDC supports.
  if (!/^\d+(\.\d+)?$/.test(usdcAmount)) {
    throw new Error(`Invalid USDC amount: ${usdcAmount}`);
  }
  const [whole, frac = ""] = usdcAmount.split(".");
  if (frac.length > USDC_DECIMALS) {
    throw new Error(
      `USDC amount '${usdcAmount}' has more precision than ${USDC_DECIMALS} decimals supports.`,
    );
  }
  const padded = frac + "0".repeat(USDC_DECIMALS - frac.length);
  const raw = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  if (raw === "" || raw === "0" || /^0+$/.test(raw)) {
    throw new Error(`USDC amount must be positive, got '${usdcAmount}'.`);
  }
  return raw;
}

async function resolveWalletConfig(
  existing: FloeAgentConfig | null,
): Promise<WalletConfig> {
  const walletType =
    existing?.walletType ??
    (await select({
      message: "Select wallet provider for signing API auth:",
      choices: [
        { name: "Private Key", value: "private-key" as const },
        { name: "CDP Wallet (MPC)", value: "cdp" as const },
      ],
    }));

  if (walletType === "private-key") {
    const pk =
      process.env.PRIVATE_KEY ||
      (await password({ message: "Private key (0x...):" }));
    return { type: "private-key", privateKey: pk, rpcUrl: existing?.rpcUrl };
  }
  const name =
    process.env.CDP_API_KEY_NAME ||
    (await input({ message: "CDP API Key Name:" }));
  const key =
    process.env.CDP_API_KEY_PRIVATE_KEY ||
    (await password({ message: "CDP API Key Private Key:" }));
  return { type: "cdp", apiKeyName: name, apiKeyPrivateKey: key };
}

export async function runRegisterCommand(args: RegisterArgs): Promise<void> {
  const existing = loadConfig();
  const config: FloeAgentConfig = existing ?? {
    walletType: "private-key",
    aiProvider: "openai",
  };

  if (config.agents?.[args.name]) {
    console.error(
      chalk.red(
        `An agent named "${args.name}" already exists in local config. ` +
          `Delete it from .floe-agent.json or pick a different name.`,
      ),
    );
    process.exit(1);
  }

  const borrowLimitUsdc =
    args.borrowLimitUsdc ??
    (await input({
      message: "Borrow limit (USDC, e.g. 10000):",
      default: "10000",
    }));
  const maxRateBps =
    args.maxRateBps ??
    Number(
      await input({
        message: "Max interest rate (basis points, e.g. 1500 = 15%):",
        default: "1500",
      }),
    );
  const expiryDays =
    args.expiryDays ??
    Number(
      await input({
        message: "Delegation expiry (days):",
        default: "90",
      }),
    );

  if (!Number.isInteger(maxRateBps) || maxRateBps < 1 || maxRateBps > 10000) {
    throw new Error("maxRateBps must be an integer between 1 and 10000");
  }
  if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650) {
    throw new Error("expiryDays must be an integer between 1 and 3650");
  }

  const walletConfig = await resolveWalletConfig(existing);
  // Persist the wallet type the user actually picked. Without this, a
  // first-time `register` initializes `config.walletType` to its default
  // ("private-key") and `walletConfig.type === "cdp"` was never written
  // back, so later `run`/`rotate`/`revoke` calls would silently prompt
  // for the wrong wallet kind.
  config.walletType = walletConfig.type;
  const walletProvider = await createWallet(walletConfig);
  const client = new FloeApiClient(args.facilitatorUrl, walletProvider);

  const spinner = ora(`Registering agent "${args.name}"...`).start();
  let agentId: number;
  let privyWalletAddress: string;
  try {
    const created = await client.createAgent({
      name: args.name,
      borrowLimitRaw: usdcToRaw(borrowLimitUsdc),
      maxRateBps,
      expirySeconds: expiryDays * 86400,
    });
    agentId = created.agentId;
    privyWalletAddress = created.privyWalletAddress;
    spinner.succeed(
      `Agent "${args.name}" created (id=${agentId}, status=${created.status})`,
    );
  } catch (err) {
    spinner.fail(`Registration failed: ${(err as Error).message}`);
    process.exit(1);
  }

  spinner.start("Minting API key...");
  let key: string;
  let keyPrefix: string;
  let createdAt: string;
  try {
    const k = await client.createAgentKey(agentId, args.label ?? args.name);
    key = k.key;
    keyPrefix = k.keyPrefix;
    // Prefer the server-issued timestamp over the local clock — matches
    // the Python SDK and avoids client-clock drift in the registry.
    createdAt = k.createdAt;
    spinner.succeed("API key minted");
  } catch (err) {
    spinner.fail(`Key minting failed: ${(err as Error).message}`);
    upsertAgent(config, {
      agentId,
      name: args.name,
      facilitatorUrl: args.facilitatorUrl,
      privyWalletAddress,
      keyPrefix: "",
      createdAt: new Date().toISOString(),
    });
    config.activeAgent = args.name;
    saveConfig(config);
    console.error(
      chalk.yellow(
        `  The agent was created (id=${agentId}) and saved to .floe-agent.json. ` +
          `Run \`floe-agent rotate ${args.name}\` or mint a key via the dashboard to recover.`,
      ),
    );
    process.exit(1);
  }

  // Persist the agent record + remember the key in the keychain.
  upsertAgent(config, {
    agentId,
    name: args.name,
    facilitatorUrl: args.facilitatorUrl,
    privyWalletAddress,
    keyPrefix,
    createdAt,
  });
  config.activeAgent = args.name;
  saveConfig(config);

  let stored: { stored: "keychain" | "env-fallback" };
  try {
    stored = await setAgentKey(args.name, args.facilitatorUrl, key);
  } catch (err) {
    console.warn(
      chalk.yellow(
        `  Keychain write failed: ${(err as Error).message}. ` +
          `Capture the key shown below — it won't be regenerated.`,
      ),
    );
    stored = { stored: "env-fallback" };
  }

  console.log("");
  console.log(chalk.bold(`  Agent "${args.name}" is ready.`));
  console.log("");
  console.log(
    `  ${chalk.bold("API Key:")} ${chalk.yellow(key)}  ${chalk.dim("(shown ONCE)")}`,
  );
  if (stored.stored === "keychain") {
    console.log(
      chalk.dim(`  Saved to OS keychain — load it via \`floe-agent run --agent ${args.name}\`.`),
    );
  } else {
    console.log(
      chalk.yellow(
        `  OS keychain unavailable. Set FLOE_AGENT_KEY_${args.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")} to use this key later.`,
      ),
    );
  }
  console.log("");
}
