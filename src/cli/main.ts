import * as readline from "readline";
import chalk from "chalk";
import ora from "ora";
import { AgentKit } from "@coinbase/agentkit";
import { streamText, tool, stepCountIs, type ToolSet } from "ai";
import { floeActionProvider } from "../index.js";
import {
  BASE_MAINNET_MATCHER,
  LENDING_MATCHER_ABI,
  KNOWN_TOKENS,
} from "../constants.js";
import { createWallet } from "./walletFactory.js";
import { createAIModel } from "./aiFactory.js";
import { runSetupFlow, promptReuseSavedConfig } from "./prompts.js";
import { loadConfig, saveConfig, type FloeAgentConfig } from "./config.js";
import { printBanner, printSessionInfo, printHelp } from "./display.js";

const VERSION = "0.1.0";

export async function main(args: string[]): Promise<void> {
  // CLI flags
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: floe-agent [options]\n");
    console.log("Interactive DeFi agent for the Floe lending protocol on Base Mainnet.\n");
    console.log("Options:");
    console.log("  --help, -h       Show this help message");
    console.log("  --version, -v    Show version");
    console.log("\nEnvironment variables:");
    console.log("  PRIVATE_KEY              Wallet private key (0x...)");
    console.log("  CDP_API_KEY_NAME         Coinbase CDP API key name");
    console.log("  CDP_API_KEY_PRIVATE_KEY  Coinbase CDP API private key");
    console.log("  OPENAI_API_KEY           OpenAI API key");
    console.log("  ANTHROPIC_API_KEY        Anthropic API key");
    console.log("  BASE_RPC_URL             Custom Base Mainnet RPC (recommended)");
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  printBanner();

  // Check for saved config
  const savedConfig = loadConfig();
  let setupResult;

  if (savedConfig) {
    const reuse = await promptReuseSavedConfig(savedConfig);
    setupResult = await runSetupFlow(reuse ? savedConfig : undefined);
  } else {
    setupResult = await runSetupFlow();
  }

  const { walletConfig, aiConfig } = setupResult;

  // Create wallet
  const spinner = ora("Creating wallet...").start();
  let walletProvider;
  try {
    walletProvider = await createWallet(walletConfig);
    spinner.succeed("Wallet connected");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    spinner.fail(`Wallet creation failed: ${msg}`);
    process.exit(1);
  }

  // Create AI model
  spinner.start("Connecting to AI provider...");
  let model;
  try {
    model = await createAIModel(aiConfig);
    spinner.succeed("AI provider connected");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    spinner.fail(`AI connection failed: ${msg}`);
    process.exit(1);
  }

  // Discover markets from known token pairs
  spinner.start("Discovering markets...");
  const knownMarketIds = await discoverMarketIds(walletProvider);
  spinner.succeed(`Found ${knownMarketIds.length} markets`);

  // Initialize AgentKit with Floe actions
  spinner.start("Initializing Floe actions...");
  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [floeActionProvider({ knownMarketIds })],
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

  // Display session info
  const address = await walletProvider.getAddress();
  printSessionInfo({
    address,
    walletType: walletConfig.type === "cdp" ? "CDP (MPC)" : "Private Key",
    aiProvider: aiConfig.provider,
    aiModel: aiConfig.model || getDefaultModel(aiConfig.provider),
    toolCount: actions.length,
  });

  console.log(chalk.dim('Type "help" for commands or start chatting.\n'));

  // Build system prompt
  const systemPrompt = buildSystemPrompt(address, Object.keys(tools));

  // Chat loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: { role: "user" | "assistant"; content: string }[] = [];

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log(chalk.dim("\n\nGoodbye!"));
    rl.close();
    process.exit(0);
  });

  // Track current config for save command
  const currentConfig: FloeAgentConfig = {
    walletType: walletConfig.type,
    aiProvider: aiConfig.provider,
    aiModel: aiConfig.model,
    ollamaBaseUrl: aiConfig.ollamaBaseUrl,
    rpcUrl: setupResult.rpcUrl,
  };

  // Main loop
  while (true) {
    const userInput = await question(chalk.cyan("You: "));
    const trimmed = userInput.trim();

    if (!trimmed) continue;

    // Handle special commands
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
    if (cmd === "clear") {
      messages.length = 0;
      console.clear();
      printBanner();
      console.log(chalk.dim("Conversation cleared.\n"));
      continue;
    }
    if (cmd === "config") {
      console.log(
        `\n  ${chalk.bold("Wallet:")} ${currentConfig.walletType}`
      );
      console.log(
        `  ${chalk.bold("AI:")} ${currentConfig.aiProvider} (${currentConfig.aiModel || getDefaultModel(currentConfig.aiProvider)})`
      );
      if (currentConfig.ollamaBaseUrl) {
        console.log(
          `  ${chalk.bold("Ollama URL:")} ${currentConfig.ollamaBaseUrl}`
        );
      }
      console.log();
      continue;
    }
    if (cmd === "save") {
      saveConfig(currentConfig);
      console.log(chalk.green("  Config saved to .floe-agent.json\n"));
      continue;
    }

    // Send to AI
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
          const resultStr = typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output);
          const preview = resultStr.slice(0, 150);
          process.stdout.write(
            chalk.dim(`  [${part.toolName} done] ${preview}${resultStr.length > 150 ? "..." : ""}\n`)
          );
        }
      }

      if (!responseText) {
        process.stdout.write(
          chalk.green("\nAssistant: ") + "(action completed)\n"
        );
        responseText = "(action completed)";
      }

      process.stdout.write("\n\n");
      messages.push({ role: "assistant", content: responseText });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${msg}\n`));
      messages.pop(); // Remove the failed user message
    }
  }
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

function buildSystemPrompt(address: string, toolNames: string[]): string {
  return `You are a DeFi assistant for the Floe lending protocol on Base Mainnet.

Connected wallet: ${address}
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

// Known market pairs on Base Mainnet
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
          chalk.dim(`  Warning: Failed to resolve ${label}: ${(err as Error).message?.slice(0, 80)}`)
        );
        return null;
      }
    })
  );

  return ids.filter((id): id is `0x${string}` => id !== null);
}
