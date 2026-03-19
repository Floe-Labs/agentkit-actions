import { select, password, input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { WalletConfig } from "./walletFactory.js";
import type { AIConfig, AIProviderType } from "./aiFactory.js";
import { validateOllamaConnection } from "./aiFactory.js";
import type { FloeAgentConfig } from "./config.js";

export interface SetupResult {
  walletConfig: WalletConfig;
  aiConfig: AIConfig;
  rpcUrl?: string;
}

export async function runSetupFlow(
  savedConfig?: FloeAgentConfig
): Promise<SetupResult> {
  // Step 1: Wallet type
  const walletType =
    savedConfig?.walletType || (await promptWalletType());

  // Step 2: Wallet credentials (always prompt for secrets - never cached)
  let walletConfig: WalletConfig;
  if (walletType === "private-key") {
    const pk = process.env.PRIVATE_KEY;
    if (pk) {
      console.log(chalk.dim("  Using PRIVATE_KEY from environment"));
      walletConfig = { type: "private-key", privateKey: pk };
    } else {
      const key = await password({ message: "Private key (0x...):" });
      walletConfig = { type: "private-key", privateKey: key };
    }
  } else {
    const name = process.env.CDP_API_KEY_NAME;
    const key = process.env.CDP_API_KEY_PRIVATE_KEY;
    if (name && key) {
      console.log(chalk.dim("  Using CDP credentials from environment"));
      walletConfig = { type: "cdp", apiKeyName: name, apiKeyPrivateKey: key };
    } else {
      const apiKeyName =
        name || (await input({ message: "CDP API Key Name:" }));
      const apiKeyPrivateKey =
        key || (await password({ message: "CDP API Key Private Key:" }));
      walletConfig = { type: "cdp", apiKeyName, apiKeyPrivateKey };
    }
  }

  // Step 3: RPC URL
  let rpcUrl: string | undefined;
  const envRpc = process.env.BASE_RPC_URL;
  if (envRpc) {
    console.log(chalk.dim("  Using BASE_RPC_URL from environment"));
    rpcUrl = envRpc;
  } else if (savedConfig?.rpcUrl) {
    rpcUrl = savedConfig.rpcUrl;
  } else {
    rpcUrl = await input({
      message: "Base Mainnet RPC URL (leave blank for public):",
      default: "",
    });
    if (!rpcUrl) rpcUrl = undefined;
  }

  // Attach RPC URL to private key wallet config
  if (walletConfig.type === "private-key" && rpcUrl) {
    walletConfig = { ...walletConfig, rpcUrl };
  }

  // Step 4: AI provider
  const aiProvider =
    savedConfig?.aiProvider || (await promptAIProvider());

  // Step 4: API key (always prompt for secrets - never cached)
  let apiKey: string | undefined;
  if (aiProvider === "openai") {
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) {
      console.log(chalk.dim("  Using OPENAI_API_KEY from environment"));
      apiKey = envKey;
    } else {
      apiKey = await password({ message: "OpenAI API Key:" });
    }
  } else if (aiProvider === "claude") {
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      console.log(chalk.dim("  Using ANTHROPIC_API_KEY from environment"));
      apiKey = envKey;
    } else {
      apiKey = await password({ message: "Anthropic API Key:" });
    }
  }

  // Step 5: Ollama-specific config
  let ollamaBaseUrl: string | undefined;
  let aiModel = savedConfig?.aiModel;
  if (aiProvider === "ollama") {
    ollamaBaseUrl =
      savedConfig?.ollamaBaseUrl ||
      (await input({
        message: "Ollama base URL:",
        default: "http://localhost:11434/api",
      }));
    aiModel =
      aiModel ||
      (await input({ message: "Model name:", default: "llama3.1" }));

    const connected = await validateOllamaConnection(ollamaBaseUrl);
    if (!connected) {
      console.log(
        chalk.yellow(
          `\n  Warning: Cannot connect to Ollama at ${ollamaBaseUrl}`
        )
      );
      console.log(
        chalk.yellow("  Make sure Ollama is running: ollama serve\n")
      );
    }
    console.log(
      chalk.yellow(
        "  Note: Local models may struggle with complex multi-step tool chains.\n"
      )
    );
  }

  return {
    walletConfig,
    aiConfig: { provider: aiProvider, apiKey, model: aiModel, ollamaBaseUrl },
    rpcUrl,
  };
}

export async function promptReuseSavedConfig(
  config: FloeAgentConfig
): Promise<boolean> {
  console.log(chalk.dim(`  Found saved config: ${config.walletType} wallet + ${config.aiProvider}`));
  return confirm({ message: "Use saved configuration?", default: true });
}

async function promptWalletType(): Promise<"private-key" | "cdp"> {
  return select({
    message: "Select wallet provider:",
    choices: [
      {
        name: "Private Key (direct key - you pay gas)",
        value: "private-key" as const,
      },
      {
        name: "CDP Wallet (Coinbase MPC - no raw key exposure)",
        value: "cdp" as const,
      },
    ],
  });
}

async function promptAIProvider(): Promise<AIProviderType> {
  return select({
    message: "Select AI provider:",
    choices: [
      { name: "OpenAI (GPT-4o)", value: "openai" as const },
      { name: "Claude (Anthropic)", value: "claude" as const },
      {
        name: "Ollama (Local - free, requires ollama running)",
        value: "ollama" as const,
      },
    ],
  });
}
