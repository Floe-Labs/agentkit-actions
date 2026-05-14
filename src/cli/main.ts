import * as readline from "readline";
import chalk from "chalk";
import ora from "ora";
import { AgentKit } from "@coinbase/agentkit";
import { streamText, tool, stepCountIs, type ToolSet } from "ai";
import { floeActionProvider, x402ActionProvider } from "../index.js";
import {
  BASE_MAINNET_MATCHER,
  LENDING_MATCHER_ABI,
} from "../constants.js";
import { createWallet } from "./walletFactory.js";
import { createAIModel } from "./aiFactory.js";
import { runSetupFlow, promptReuseSavedConfig } from "./prompts.js";
import {
  loadConfig,
  saveConfig,
  getAgent,
  listAgents,
  type AgentRecord,
  type FloeAgentConfig,
} from "./config.js";
import { getAgentKey } from "./keychain.js";
import { printBanner, printSessionInfo, printHelp } from "./display.js";
import { runRegisterCommand } from "./commands/register.js";
import { runListCommand } from "./commands/agents.js";
import { runUseCommand } from "./commands/use.js";
import { runRevokeCommand } from "./commands/revoke.js";
import { runRotateCommand } from "./commands/rotate.js";
import { runOpenCreditLineCommand } from "./commands/open-credit-line.js";

const VERSION = "0.4.0";

function printRootHelp(): void {
  console.log("Usage: floe-agent [command] [options]\n");
  console.log("Floe DeFi agent for the Base Mainnet lending protocol.\n");
  console.log("Commands:");
  console.log("  run                 Interactive REPL (default)");
  console.log("  register            Register a new agent and mint an API key");
  console.log("  agents              List registered agents");
  console.log("  use <name>          Set the active agent");
  console.log("  rotate <name>       Atomically rotate the agent's API key");
  console.log("  revoke <name>       Revoke the agent's API key");
  console.log("  open-credit-line    Open the USDC/USDC credit line for a funded agent");
  console.log("");
  console.log("Common options:");
  console.log("  --help, -h          Show help");
  console.log("  --version, -v       Show version");
  console.log("  --agent <name>      Select agent for `run` (overrides activeAgent)");
  console.log("  --facilitator-url   Facilitator base URL (for register/revoke)");
  console.log("");
  console.log("Environment variables:");
  console.log("  PRIVATE_KEY                     Wallet private key");
  console.log("  CDP_API_KEY_NAME / *_PRIVATE_KEY  Coinbase CDP credentials");
  console.log("  OPENAI_API_KEY / ANTHROPIC_API_KEY  AI provider keys");
  console.log("  BASE_RPC_URL                    Custom Base RPC");
  console.log("  FLOE_FACILITATOR_URL            Default facilitator URL");
  console.log("  FLOE_AGENT_KEY_<NAME>           Per-agent API key (keychain fallback)");
}

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export async function main(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printRootHelp();
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  // Dispatch subcommands. The first arg, if it's a known verb, decides.
  // Everything else falls through to the interactive REPL (default).
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === "register") {
    const name = parseFlag(rest, "name");
    if (!name) {
      console.error(chalk.red("`register` requires --name <name>."));
      process.exit(1);
    }
    const facilitatorUrl =
      parseFlag(rest, "facilitator-url") ||
      process.env.FLOE_FACILITATOR_URL ||
      "https://x402.floe.xyz";
    await runRegisterCommand({
      name,
      facilitatorUrl,
      borrowLimitUsdc: parseFlag(rest, "borrow-limit"),
      maxRateBps: parseFlag(rest, "max-rate-bps")
        ? Number(parseFlag(rest, "max-rate-bps"))
        : undefined,
      expiryDays: parseFlag(rest, "expiry-days")
        ? Number(parseFlag(rest, "expiry-days"))
        : undefined,
      label: parseFlag(rest, "label"),
    });
    return;
  }
  if (sub === "agents" || sub === "list") {
    await runListCommand();
    return;
  }
  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      console.error(chalk.red("`use` requires an agent name."));
      process.exit(1);
    }
    runUseCommand(name);
    return;
  }
  if (sub === "rotate") {
    const name = rest[0];
    if (!name) {
      console.error(chalk.red("`rotate` requires an agent name."));
      process.exit(1);
    }
    await runRotateCommand(name);
    return;
  }
  if (sub === "revoke") {
    const name = rest[0];
    if (!name) {
      console.error(chalk.red("`revoke` requires an agent name."));
      process.exit(1);
    }
    // The agent's persisted `facilitatorUrl` is the authoritative source;
    // `--facilitator-url` is only an opt-in override for recovery flows
    // where the local record's URL is wrong. runRevokeCommand re-reads
    // the agent from config and prefers its stored URL.
    await runRevokeCommand(name, parseFlag(rest, "facilitator-url"));
    return;
  }
  if (sub === "open-credit-line") {
    const name = parseFlag(rest, "name") ?? rest[0];
    if (!name) {
      console.error(chalk.red("`open-credit-line` requires --name <name>."));
      process.exit(1);
    }
    const rawLtv = parseFlag(rest, "max-ltv-bps");
    const rawRate = parseFlag(rest, "max-rate-bps");
    await runOpenCreditLineCommand({
      name,
      depositUsdc: parseFlag(rest, "deposit"),
      maxLtvBps: rawLtv ? Number(rawLtv) : undefined,
      maxRateBps: rawRate ? Number(rawRate) : undefined,
    });
    return;
  }

  // Default: interactive REPL. Treat `run` as an explicit alias.
  const runArgs = sub === "run" ? rest : args;
  const explicitAgent = parseFlag(runArgs, "agent");
  await runInteractive(explicitAgent);
}

async function runInteractive(explicitAgent?: string): Promise<void> {
  // Validate --agent BEFORE the banner + setup prompts. If the name is a
  // typo, force-failing here saves the user a wallet prompt + AI prompt
  // chain just to be told the agent doesn't exist.
  if (explicitAgent) {
    const preflightConfig = loadConfig();
    if (!preflightConfig?.agents || !getAgent(preflightConfig, explicitAgent)) {
      console.error(
        chalk.red(
          `Unknown agent "${explicitAgent}". Run \`floe-agent agents\` to list available agents, ` +
            `or register one with \`floe-agent register --name ${explicitAgent}\`.`,
        ),
      );
      process.exit(1);
    }
  }

  printBanner();

  const savedConfig = loadConfig();
  if (
    savedConfig &&
    savedConfig.agents === undefined &&
    process.env.FLOE_AGENT_KEY
  ) {
    console.log(
      chalk.yellow(
        "  Notice: FLOE_AGENT_KEY env var detected on a pre-multi-agent config.\n" +
          "  Run `floe-agent register --name <name>` to migrate to the new flow,\n" +
          "  or set FLOE_AGENT_KEY_<UPPER_NAME> for the active agent.",
      ),
    );
  }

  let setupResult;
  if (savedConfig) {
    const reuse = await promptReuseSavedConfig(savedConfig);
    setupResult = await runSetupFlow(reuse ? savedConfig : undefined);
  } else {
    setupResult = await runSetupFlow();
  }

  const { walletConfig, aiConfig } = setupResult;

  const agentContext = resolveAgentContext(savedConfig, explicitAgent);

  const spinner = ora("Creating wallet...").start();
  let walletProvider;
  try {
    walletProvider = await createWallet(walletConfig);
    spinner.succeed("Wallet connected");
  } catch (err: unknown) {
    spinner.fail(`Wallet creation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  spinner.start("Connecting to AI provider...");
  let model;
  try {
    model = await createAIModel(aiConfig);
    spinner.succeed("AI provider connected");
  } catch (err: unknown) {
    spinner.fail(`AI connection failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  spinner.start("Discovering markets...");
  const knownMarketIds = await discoverMarketIds(walletProvider);
  spinner.succeed(`Found ${knownMarketIds.length} markets`);

  spinner.start("Loading per-agent key...");
  let facilitatorApiKey: string | undefined;
  if (agentContext) {
    const key = await getAgentKey(agentContext.name, agentContext.facilitatorUrl);
    if (key) {
      facilitatorApiKey = key;
      spinner.succeed(
        `Loaded API key for "${agentContext.name}" (${agentContext.keyPrefix}…)`,
      );
    } else {
      spinner.warn(
        `No API key found for "${agentContext.name}". Run \`floe-agent rotate ${agentContext.name}\` or set ` +
          `FLOE_AGENT_KEY_${agentContext.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}.`,
      );
    }
  } else {
    spinner.stop();
    console.log(
      chalk.dim(
        "  No active agent. Register one with `floe-agent register --name <name>` to enable agent-aware actions.",
      ),
    );
  }

  spinner.start("Initializing Floe actions...");
  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      floeActionProvider({ knownMarketIds }),
      x402ActionProvider({
        facilitatorUrl: agentContext?.facilitatorUrl,
        facilitatorApiKey,
        agentName: agentContext?.name,
      }),
    ],
  });

  const actions = agentkit.getActions();
  const tools: ToolSet = {};
  for (const action of actions) {
    tools[action.name] = tool({
      description: action.description,
      inputSchema: action.schema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async (args: any) => action.invoke(args ?? {}),
    });
  }
  spinner.succeed(`${actions.length} Floe actions loaded`);

  const address = await walletProvider.getAddress();
  printSessionInfo({
    address,
    walletType: walletConfig.type === "cdp" ? "CDP (MPC)" : "Private Key",
    aiProvider: aiConfig.provider,
    aiModel: aiConfig.model || getDefaultModel(aiConfig.provider),
    toolCount: actions.length,
  });

  if (agentContext) {
    console.log(chalk.dim(`  Active agent: ${agentContext.name} (id=${agentContext.agentId})`));
  }
  console.log(chalk.dim('  Type "help" for commands or start chatting.\n'));

  const systemPrompt = buildSystemPrompt(address, Object.keys(tools), agentContext?.name);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  process.on("SIGINT", () => {
    console.log(chalk.dim("\n\nGoodbye!"));
    rl.close();
    process.exit(0);
  });

  const currentConfig: FloeAgentConfig = {
    walletType: walletConfig.type,
    aiProvider: aiConfig.provider,
    aiModel: aiConfig.model,
    ollamaBaseUrl: aiConfig.ollamaBaseUrl,
    rpcUrl: setupResult.rpcUrl,
    agents: savedConfig?.agents,
    activeAgent: savedConfig?.activeAgent,
  };

  while (true) {
    const userInput = await question(chalk.cyan("You: "));
    const trimmed = userInput.trim();
    if (!trimmed) continue;

    const cmd = trimmed.toLowerCase();
    if (cmd === "exit" || cmd === "quit") {
      console.log(chalk.dim("Goodbye!"));
      rl.close();
      break;
    }
    if (cmd === "help") {
      printHelp();
      continue;
    }
    if (cmd === "wallet") {
      console.log(`\n  ${chalk.bold("Address:")} ${address}`);
      console.log(`  ${chalk.bold("Network:")} Base Mainnet\n`);
      continue;
    }
    if (cmd === "agents") {
      const all = listAgents(currentConfig);
      if (all.length === 0) {
        console.log(chalk.dim("  No registered agents.\n"));
      } else {
        console.log("");
        for (const a of all) {
          const marker = a.name === currentConfig.activeAgent ? chalk.green("● ") : "  ";
          console.log(`${marker}${chalk.bold(a.name)} ${chalk.dim(`(id=${a.agentId})`)}`);
        }
        console.log("");
      }
      continue;
    }
    if (cmd === "clear") {
      messages.length = 0;
      console.clear();
      printBanner();
      console.log(chalk.dim("Conversation cleared.\n"));
      continue;
    }
    if (cmd === "config") {
      console.log(`\n  ${chalk.bold("Wallet:")} ${currentConfig.walletType}`);
      console.log(
        `  ${chalk.bold("AI:")} ${currentConfig.aiProvider} (${currentConfig.aiModel || getDefaultModel(currentConfig.aiProvider)})`,
      );
      if (currentConfig.ollamaBaseUrl) {
        console.log(`  ${chalk.bold("Ollama URL:")} ${currentConfig.ollamaBaseUrl}`);
      }
      if (agentContext) {
        console.log(`  ${chalk.bold("Active agent:")} ${agentContext.name}`);
      }
      console.log();
      continue;
    }
    if (cmd === "save") {
      saveConfig(currentConfig);
      console.log(chalk.green("  Config saved to .floe-agent.json\n"));
      continue;
    }

    messages.push({ role: "user", content: trimmed });

    try {
      let responseText = "";
      let hasStartedText = false;
      const result = streamText({
        model,
        tools,
        stopWhen: stepCountIs(10),
        system: systemPrompt,
        messages,
      });

      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          if (!hasStartedText) {
            process.stdout.write(chalk.green("\nAssistant: "));
            hasStartedText = true;
          }
          process.stdout.write(part.text);
          responseText += part.text;
        } else if (part.type === "tool-call") {
          if (hasStartedText) process.stdout.write("\n");
          process.stdout.write(chalk.dim(`  [Calling ${part.toolName}...]\n`));
        } else if (part.type === "tool-result") {
          const resultStr =
            typeof part.output === "string" ? part.output : JSON.stringify(part.output);
          const preview = resultStr.slice(0, 150);
          process.stdout.write(
            chalk.dim(
              `  [${part.toolName} done] ${preview}${resultStr.length > 150 ? "..." : ""}\n`,
            ),
          );
        }
      }

      if (!responseText) {
        process.stdout.write(chalk.green("\nAssistant: ") + "(action completed)\n");
        responseText = "(action completed)";
      }

      process.stdout.write("\n\n");
      messages.push({ role: "assistant", content: responseText });
    } catch (err: unknown) {
      console.error(
        chalk.red(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`),
      );
      messages.pop();
    }
  }
}

function resolveAgentContext(
  config: FloeAgentConfig | null,
  explicit?: string,
): AgentRecord | undefined {
  if (explicit) {
    // Hard-fail on an unknown explicit --agent. Silently dropping back
    // to "no agent" mode masks a typo and confuses users when paid
    // /proxy/fetch calls then 401 with no obvious reason.
    const resolved = config?.agents ? getAgent(config, explicit) : undefined;
    if (!resolved) {
      console.error(
        chalk.red(
          `Unknown agent "${explicit}". Run \`floe-agent agents\` to list available agents, ` +
            `or register one with \`floe-agent register --name ${explicit}\`.`,
        ),
      );
      process.exit(1);
    }
    return resolved;
  }
  if (!config?.agents) return undefined;
  if (config.activeAgent) return getAgent(config, config.activeAgent);
  const all = listAgents(config);
  if (all.length === 1) return all[0];
  return undefined;
}

function getDefaultModel(provider: string): string {
  switch (provider) {
    case "openai":
      return "gpt-4o";
    case "claude":
      return "claude-sonnet-4-5-20250514";
    case "ollama":
      return "llama3.1";
    default:
      return "unknown";
  }
}

function buildSystemPrompt(
  address: string,
  toolNames: string[],
  agentName?: string,
): string {
  const agentLine = agentName ? `\nActive Floe agent: ${agentName}` : "";
  return `You are a DeFi assistant for the Floe lending protocol on Base Mainnet.

Connected wallet: ${address}${agentLine}
Network: Base Mainnet (chain ID 8453)

You help users with:
- Checking lending markets, loan details, health factors, and oracle prices
- Posting lend and borrow intents
- Matching intents, repaying loans, managing collateral
- Liquidating unhealthy positions

Available tools: ${toolNames.join(", ")}

IMPORTANT: Always confirm with the user before executing write operations (posting intents, repaying, liquidating, etc.). Explain what the transaction will do and its parameters before proceeding.

When displaying transaction hashes, include the BaseScan link: https://basescan.org/tx/<hash>`;
}

const MARKET_PAIRS: { loan: `0x${string}`; collateral: `0x${string}`; label: string }[] = [
  {
    loan: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",       // USDC
    collateral: "0x4200000000000000000000000000000000000006",   // WETH
    label: "USDC/WETH",
  },
  {
    loan: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",       // USDC
    collateral: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",  // cbBTC
    label: "USDC/cbBTC",
  },
  {
    loan: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",       // USDT
    collateral: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",  // cbBTC
    label: "USDT/cbBTC",
  },
  {
    loan: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",       // USDC
    collateral: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // USDC (same-token market)
    label: "USDC/USDC",
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function discoverMarketIds(walletProvider: any): Promise<`0x${string}`[]> {
  const ids = await Promise.all(
    MARKET_PAIRS.map(async ({ loan, collateral, label }) => {
      try {
        const marketId = (await walletProvider.readContract({
          address: BASE_MAINNET_MATCHER,
          abi: LENDING_MATCHER_ABI,
          functionName: "getMarketId",
          args: [loan, collateral],
        })) as `0x${string}`;
        return marketId;
      } catch (err) {
        console.error(
          chalk.dim(`  Warning: Failed to resolve ${label}: ${(err as Error).message?.slice(0, 80)}`),
        );
        return null;
      }
    }),
  );

  return ids.filter((id): id is `0x${string}` => id !== null);
}
