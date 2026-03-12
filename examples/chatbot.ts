/**
 * Floe AgentKit Chatbot Example
 *
 * A conversational AI agent that can interact with the Floe lending protocol
 * using Vercel AI SDK + OpenAI. Uses CdpWalletProvider for production-grade
 * MPC-managed keys (no raw private keys).
 *
 * Prerequisites:
 *   npm install @coinbase/agentkit ai @ai-sdk/openai
 *
 * Usage:
 *   cp .env.example .env   # fill in your keys
 *   npx tsx examples/chatbot.ts
 */

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(import.meta.dirname, ".env") });

import { AgentKit, CdpWalletProvider } from "@coinbase/agentkit";
import { tool } from "ai";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { floeActionProvider } from "../dist/index.js";
import * as readline from "readline";
import * as fs from "fs";

// ── Config ──────────────────────────────────────────────────────────────────

const CDP_API_KEY_NAME = process.env.CDP_API_KEY_NAME;
const CDP_API_KEY_PRIVATE_KEY = process.env.CDP_API_KEY_PRIVATE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!CDP_API_KEY_NAME || !CDP_API_KEY_PRIVATE_KEY || !OPENAI_API_KEY) {
  console.error(
    "Missing CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY, or OPENAI_API_KEY in environment."
  );
  console.error("Copy .env.example to .env and fill in your keys.");
  process.exit(1);
}

const WALLET_DATA_FILE = path.resolve(import.meta.dirname, ".wallet-data.json");

// ── Setup ───────────────────────────────────────────────────────────────────

async function main() {
  // 1. Create (or reuse) a CDP wallet provider on Base Mainnet
  const savedWalletData = fs.existsSync(WALLET_DATA_FILE)
    ? fs.readFileSync(WALLET_DATA_FILE, "utf-8")
    : undefined;

  const walletProvider = await CdpWalletProvider.configureWithWallet({
    apiKeyName: CDP_API_KEY_NAME,
    apiKeyPrivateKey: CDP_API_KEY_PRIVATE_KEY,
    networkId: "base-mainnet",
    cdpWalletData: savedWalletData,
  });

  // Persist wallet data so we reuse the same wallet next time
  const walletData = await walletProvider.exportWallet();
  fs.writeFileSync(WALLET_DATA_FILE, JSON.stringify(walletData));

  // 2. Create AgentKit with the Floe action provider
  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [floeActionProvider()], // defaults to Base Mainnet
  });

  // 3. Convert AgentKit actions to Vercel AI SDK tools
  const actions = agentkit.getActions();
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const action of actions) {
    tools[action.name] = tool({
      description: action.description,
      parameters: action.schema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (args: any) => action.invoke(args),
    });
  }

  const address = await walletProvider.getAddress();
  console.log(`\nFloe Chatbot ready! Wallet: ${address} (Base Mainnet)`);
  console.log(`Available tools: ${Object.keys(tools).join(", ")}`);
  console.log('Type "exit" to quit.\n');

  // 4. Chat loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: { role: "user" | "assistant"; content: string }[] = [];

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (trimmed.toLowerCase() === "exit") {
        rl.close();
        return;
      }

      messages.push({ role: "user", content: trimmed });

      try {
        const result = await generateText({
          model: openai("gpt-4o"),
          tools,
          maxSteps: 10,
          system: `You are a DeFi assistant that helps users interact with the Floe lending protocol on Base. You can check markets, loan health, prices, post intents, and more. Always confirm before executing write operations.`,
          messages,
        });

        const response = result.text || "(action completed, no text response)";
        console.log(`\nAssistant: ${response}\n`);
        messages.push({ role: "assistant", content: response });
      } catch (err) {
        console.error("Error:", err);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
