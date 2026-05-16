import chalk from "chalk";
import ora from "ora";
import { input, password } from "@inquirer/prompts";
import { createWallet, type WalletConfig } from "../walletFactory.js";
import { FloeApiClient } from "../floeApiClient.js";
import {
  loadConfig,
  getAgent,
  type FloeAgentConfig,
} from "../config.js";

export interface OpenCreditLineArgs {
  name: string;
  /** USDC, e.g. "10000" → 10,000 USDC. Converted to raw 6-decimal units before POST. */
  depositUsdc?: string;
  maxLtvBps?: number;
  maxRateBps?: number;
}

const USDC_DECIMALS = 6;

function usdcToRaw(usdcAmount: string): string {
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

async function resolveWalletConfig(existing: FloeAgentConfig): Promise<WalletConfig> {
  if ((existing.walletType ?? "private-key") === "private-key") {
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

export async function runOpenCreditLineCommand(args: OpenCreditLineArgs): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error(chalk.red("No config found. Register an agent first with `floe-agent register`."));
    process.exit(1);
  }
  const agent = getAgent(config, args.name);
  if (!agent) {
    console.error(chalk.red(`Unknown agent "${args.name}". Run \`floe-agent agents\` to list.`));
    process.exit(1);
  }

  const depositUsdc =
    args.depositUsdc ??
    (await input({
      message: "Deposit (USDC, will be locked as collateral, e.g. 10000):",
      default: "10000",
    }));

  let depositRaw: string;
  try {
    depositRaw = usdcToRaw(depositUsdc);
  } catch (err) {
    console.error(chalk.red(`${(err as Error).message}`));
    process.exit(1);
  }

  // Range checks alone don't catch NaN (`NaN < x` and `NaN > x` are both
  // false) or fractional values; both would serialize to garbage on the
  // wire. Enforce finite-integer explicitly before the bounds check.
  if (
    args.maxLtvBps !== undefined &&
    (!Number.isFinite(args.maxLtvBps) ||
      !Number.isInteger(args.maxLtvBps) ||
      args.maxLtvBps < 1 ||
      args.maxLtvBps > 9900)
  ) {
    console.error(
      chalk.red(
        "maxLtvBps must be an integer in 1..9900. The conservative ceiling is 9500 (95%, ~5% interest-accrual headroom). Values 9501..9900 are the aggressive USDC/USDC opt-in — only safe for credit lines you close or roll on a tight cadence.",
      ),
    );
    process.exit(1);
  }
  if (
    args.maxRateBps !== undefined &&
    (!Number.isFinite(args.maxRateBps) ||
      !Number.isInteger(args.maxRateBps) ||
      args.maxRateBps < 1 ||
      args.maxRateBps > 10000)
  ) {
    console.error(chalk.red("maxRateBps must be an integer in 1..10000."));
    process.exit(1);
  }

  const walletConfig = await resolveWalletConfig(config);
  const walletProvider = await createWallet(walletConfig);
  const client = new FloeApiClient(agent.facilitatorUrl, walletProvider);

  const spinner = ora(`Opening credit line for "${args.name}"...`).start();
  try {
    const result = await client.openCreditLine(agent.agentId, {
      depositRaw,
      maxLtvBps: args.maxLtvBps,
      maxRateBps: args.maxRateBps,
    });
    spinner.succeed(
      `Borrow intent posted (loanId=${result.loanId}, principal=${result.principalRaw} raw USDC)`,
    );

    console.log("");
    console.log(chalk.bold(`  Credit line submitted for "${args.name}".`));
    console.log("");
    if (result.approveTxHash) {
      console.log(`  ${chalk.bold("Approve tx:")} ${result.approveTxHash}`);
    }
    console.log(`  ${chalk.bold("Register tx:")} ${result.registerTxHash}`);
    console.log(`  ${chalk.bold("Deposit:")} ${depositRaw} raw USDC`);
    console.log(`  ${chalk.bold("Borrow:")} ${result.principalRaw} raw USDC`);
    console.log("");
    console.log(
      chalk.dim(
        "  Status is pending_on_chain. The reconciler advances to pending_match once the receipt confirms,\n" +
          "  then the solver matches the intent and status flips to active. At that point your agent's\n" +
          "  /proxy/fetch calls will succeed.",
      ),
    );
    console.log("");
  } catch (err) {
    spinner.fail(`Open credit line failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
