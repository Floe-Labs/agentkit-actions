/**
 * Floe AgentKit Standalone Example
 *
 * Shows how to use the Floe action provider programmatically without an AI
 * framework. Useful for testing, scripting, and direct integration.
 *
 * Uses ViemWalletProvider with a raw private key — suitable for development
 * and scripting. For production agents, see chatbot.ts (CdpWalletProvider).
 *
 * Usage:
 *   cp .env.example .env   # fill in your wallet key
 *   npx tsx examples/standalone.ts
 */

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(import.meta.dirname, ".env") });

import { ViemWalletProvider } from "@coinbase/agentkit";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { FloeActionProvider } from "../dist/index.js";

// ── Config ──────────────────────────────────────────────────────────────────

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;

if (!PRIVATE_KEY) {
  console.error("Missing PRIVATE_KEY in environment.");
  console.error("Copy .env.example to .env and fill in your wallet key.");
  process.exit(1);
}

// ── Setup ───────────────────────────────────────────────────────────────────

async function main() {
  // 1. Create a viem wallet provider on Base Mainnet
  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const walletProvider = new ViemWalletProvider(walletClient, publicClient);

  console.log(`Wallet: ${account.address} (Base Mainnet)\n`);

  // 2. Create the Floe action provider directly (defaults to Base Mainnet)
  const floe = new FloeActionProvider();

  // ── Read Examples ───────────────────────────────────────────────────────

  // Get oracle price for a token pair
  console.log("--- Get Price (WETH/USDC) ---");
  try {
    const priceResult = await floe.getPrice(walletProvider, {
      collateralToken: "0x4200000000000000000000000000000000000006", // WETH
      loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    });
    console.log(priceResult);
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // Get loans for the connected wallet
  console.log("\n--- Get My Loans ---");
  try {
    const loansResult = await floe.getMyLoans(walletProvider, {});
    console.log(loansResult);
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // Check a specific loan's health
  console.log("\n--- Check Loan Health (loan #1) ---");
  try {
    const healthResult = await floe.checkLoanHealth(walletProvider, {
      loanId: "1",
    });
    console.log(healthResult);
  } catch (err: any) {
    console.log(`  (expected if loan #1 doesn't exist: ${err.message})`);
  }

  // Get accrued interest on a loan
  console.log("\n--- Get Accrued Interest (loan #1) ---");
  try {
    const interestResult = await floe.getAccruedInterest(walletProvider, {
      loanId: "1",
    });
    console.log(interestResult);
  } catch (err: any) {
    console.log(`  (expected if loan #1 doesn't exist: ${err.message})`);
  }

  console.log("\nDone! All read actions executed successfully.");
}

main().catch(console.error);
