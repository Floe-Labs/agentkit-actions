# @floe/agentkit-actions

Coinbase AgentKit ActionProvider for the [Floe](https://floelabs.xyz) DeFi lending protocol on Base.

Provides **30+ actions** for AI agents: DeFi lending, instant credit facilities, flash loan arbitrage, and x402 API payments. Works with any framework: Vercel AI SDK, LangChain, OpenAI Agents SDK, or as an MCP server for Claude Desktop / Cursor.

Also ships a **standalone CLI** (`floe-agent`) for interactive testing without any framework integration.

## Installation

```bash
npm install floe-agent @coinbase/agentkit viem zod
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Agent Developer's App                      │
│                                                             │
│  ┌─────────────┐    ┌──────────┐    ┌────────────────────┐ │
│  │     LLM     │───>│ AgentKit │───>│ FloeActionProvider │ │
│  │ (GPT/Claude)│    │          │    │   (30+ actions)     │ │
│  └─────────────┘    └────┬─────┘    └────────┬───────────┘ │
│                          │                   │             │
│                          v                   │             │
│                  ┌──────────────┐             │             │
│                  │WalletProvider│<────────────┘             │
│                  └──────┬───────┘  signs & sends txs       │
│                         │                                   │
│  ┌──────────────────────┼──────────────────────────────┐   │
│  │ Choose one:          │                              │   │
│  │ - CdpV2WalletProvider│ (prod — MPC server wallet)   │   │
│  │ - CdpSmartWallet     │ (AA — gasless on Base)       │   │
│  │ - ViemWalletProvider │ (dev — raw private key)      │   │
│  │ - PrivyWalletProvider│ (embedded/delegated wallets) │   │
│  └──────────────────────┼──────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────┘
                          │ RPC calls + signed transactions
                          v
┌─────────────────────────────────────────────────────────────┐
│                    Base Mainnet (8453)                       │
│                                                             │
│  LendingIntentMatcher  0x17946...Bb175   <── write actions │
│  LendingViews          0x9101...5003     <── read actions  │
│  PriceOracle           0xEA05...10Cc     <── readiness     │
│  Aerodrome SwapRouter  0xBE6D...18a5     <── flash arb     │
│  ERC-20 Tokens (WETH, USDC, DAI, ...)   <── approvals     │
└─────────────────────────────────────────────────────────────┘
```

**Flow:** User speaks to LLM -> LLM picks a Floe tool -> AgentKit calls FloeActionProvider -> provider uses WalletProvider to read chain / sign txs -> transaction hits Floe contracts on Base.

## Quick Start

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { floeActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider: myWalletProvider,
  actionProviders: [
    floeActionProvider({
      // Optional: defaults to Base Mainnet addresses
      knownMarketIds: [
        "0x...", // WETH/USDC market
      ],
    }),
  ],
});
```

## Actions (36 total: 30 lending + 6 x402)

### Read Actions (8)

| Action | Description |
|--------|-------------|
| `get_markets` | Get info about Floe lending markets (rates, LTV bounds, pause status) |
| `get_loan` | Get detailed loan information (participants, health, time remaining) |
| `get_my_loans` | Get all loans for the connected wallet (as lender or borrower) |
| `check_loan_health` | Check loan health — current LTV vs liquidation threshold, buffer % |
| `get_price` | Get oracle price for a collateral/loan token pair (Chainlink + Pyth) |
| `get_accrued_interest` | Get interest accrued on a loan (amount, time elapsed, rate) |
| `get_liquidation_quote` | Get profit/loss breakdown for liquidating an unhealthy loan |
| `get_intent_book` | Look up an on-chain lend or borrow intent by hash |

### Write Actions (7)

| Action | Description |
|--------|-------------|
| `post_lend_intent` | Post a fixed-rate lending offer (auto-approves loan token) |
| `post_borrow_intent` | Post a borrow request with collateral (auto-approves collateral) |
| `match_intents` | Match a lend + borrow intent to create a loan |
| `repay_loan` | Repay a loan fully or partially (with slippage protection) |
| `add_collateral` | Add collateral to improve loan health |
| `withdraw_collateral` | Withdraw excess collateral (enforces safety buffer) |
| `liquidate_loan` | Liquidate an unhealthy loan (currentLTV >= threshold or overdue) |

All write actions **auto-approve** tokens to the LendingIntentMatcher with a 1% buffer before submitting. Repay and liquidate actions include configurable slippage protection (default 5%).

### Flash Loan Actions (5)

| Action | Description |
|--------|-------------|
| `get_flash_loan_fee` | Get the protocol's flash loan fee (in bps) |
| `estimate_flash_arb_profit` | Simulate a multi-leg arb route via Aerodrome QuoterV2 |
| `flash_loan` | Execute a raw flash loan (receiver must implement `IFlashloanReceiver`) |
| `flash_arb` | Execute a flash arb via a deployed FlashArbReceiver |
| `get_flash_arb_balance` | Check accumulated profit in a FlashArbReceiver |

> **`flash_loan` vs `flash_arb`:** `flash_loan` sends tokens to `msg.sender` and calls `receiveFlashLoan()` — your connected wallet must be a smart contract. EOA wallets will revert. Use `flash_arb` instead, which routes through a pre-deployed FlashArbReceiver contract that handles repayment automatically.

### Credit Facility Actions (5)

| Action | Description |
|--------|-------------|
| `instant_borrow` | Borrow USDC instantly — auto-selects best lender, handles approval + register + match in one call |
| `repay_and_reborrow` | Repay an existing loan and instantly borrow again. If reborrow fails, repayment still succeeds |
| `check_credit_status` | Loan health, balance, accrued interest, time to expiry, early repayment terms |
| `request_credit` | Browse available credit offers — rates, amounts, durations |
| `manual_match_credit` | Match with a specific lend intent (register + match) |

> **`instant_borrow` vs `manual_match_credit`:** Use `instant_borrow` for one-call capital. Use `request_credit` + `manual_match_credit` if you want to pick a specific lender.

### Deploy / Verify / Readiness Actions (3)

| Action | Description |
|--------|-------------|
| `deploy_flash_arb_receiver` | Deploy a new FlashArbReceiver with pre-flight checks |
| `check_flash_arb_readiness` | Check environment readiness (fee, liquidity, oracle, router) |
| `verify_flash_arb_receiver` | Verify a receiver's owner and immutable config |

### Session State

When you deploy via `deploy_flash_arb_receiver`, the contract address is stored on the provider instance. Subsequent calls to `flash_arb`, `get_flash_arb_balance`, and `verify_flash_arb_receiver` auto-use it — no need to pass the address again. You can always override by passing `receiverAddress` explicitly.

### Flash Arb Flow

```
1. deploy_flash_arb_receiver  →  Deploys FlashArbReceiver (stores address)
2. check_flash_arb_readiness  →  Validates fee, liquidity, circuit breaker, router
3. estimate_flash_arb_profit  →  Simulates arb route via Aerodrome QuoterV2
4. flash_arb                  →  Borrows tokens → swaps via Aerodrome → repays + keeps profit
5. get_flash_arb_balance      →  Check accumulated profit in receiver
```

Pre-flight checks on deploy: flash loan fee readable, WETH liquidity > 0, circuit breaker not active, SwapRouter has code.

## Framework Integrations

### Vercel AI SDK

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { getVercelAITools } from "@coinbase/agentkit-vercel-ai-sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { floeActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [floeActionProvider()],
});

const tools = await getVercelAITools(agentkit);

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools,
  maxSteps: 10,
  prompt: "Check the health of loan #42",
});
```

### LangChain

```typescript
import { getLangChainTools } from "@coinbase/agentkit-langchain";

const tools = await getLangChainTools(agentkit);
// Pass tools to a LangChain agent
```

### MCP Server (Claude Desktop / Cursor)

Expose all 23 Floe actions as MCP tools using the AgentKit MCP extension:

```bash
npm install @coinbase/agentkit-model-context-protocol @modelcontextprotocol/sdk
```

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { getMcpTools } from "@coinbase/agentkit-model-context-protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { floeActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [floeActionProvider()],
});

const mcpTools = await getMcpTools(agentkit);
const server = new McpServer({ name: "floe-lending", version: "1.0.0" });

// Register tools and connect
const transport = new StdioServerTransport();
await server.connect(transport);
```

Configure in Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "floe-lending": {
      "command": "node",
      "args": ["path/to/floe-mcp-server.js"],
      "env": {
        "PRIVATE_KEY": "0x...",
        "BASE_RPC_URL": "https://mainnet.base.org"
      }
    }
  }
}
```

This exposes all 30+ actions as tools in Claude Desktop, Cursor, or any MCP-compatible client.

### OpenAI Agents SDK

AgentKit provides launch-day integration with OpenAI's Agents SDK. Use the `create-onchain-agent` scaffold:

```bash
npx create-onchain-agent@latest
# Select "OpenAI Agents SDK" as framework
```

Then register `floeActionProvider()` alongside the built-in action providers.

## CLI: `floe-agent`

Interactive conversational agent for testing all 30+ actions without writing any framework code.

### Run directly

```bash
cd agentkit-actions
npm run build
npx tsx src/cli/bin.ts
```

### Or install globally

```bash
npm run build
npm link
floe-agent
```

### Setup flow

The CLI prompts for:

1. **Wallet provider** — Private Key (direct) or CDP Wallet (MPC managed)
2. **AI provider** — OpenAI (GPT-4o), Anthropic (Claude), or Ollama (local)
3. **RPC URL** — Custom Base Mainnet RPC (recommended for reliability)

Configuration is saved to `.floe-agent.json` in the working directory and reused on subsequent runs. API keys are never cached.

### CLI Commands

| Command | Description |
|---------|-------------|
| `help` | Show available commands |
| `wallet` | Display current wallet address |
| `config` | Show current configuration |
| `save` | Save current config to `.floe-agent.json` |
| `clear` | Clear conversation history |
| `exit` | Exit the CLI |

### Environment variables

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Wallet private key (0x...) |
| `CDP_API_KEY_NAME` | Coinbase CDP API key name |
| `CDP_API_KEY_PRIVATE_KEY` | Coinbase CDP API private key |
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `BASE_RPC_URL` | Custom Base Mainnet RPC URL |

### Example session

```
You: Check flash arb readiness
  -> Shows fee, WETH liquidity, circuit breaker, SwapRouter status

You: Deploy a FlashArbReceiver for me
  -> Pre-flight checks, deploys contract, stores address in session

You: Verify my FlashArbReceiver
  -> Validates owner/LENDING_PROTOCOL/SWAP_ROUTER (no address needed)

You: Check the WETH balance in my FlashArbReceiver
  -> Shows 0 WETH (auto-uses session address)

You: Execute a flash arb: borrow 0.01 WETH, swap WETH -> USDC tick spacing 100, then USDC -> WETH tick spacing 100, min profit 0
  -> Submits the flash arb transaction
```

## Wallet Providers

| Provider | Use Case | Key Management | Setup |
|----------|----------|----------------|-------|
| `CdpV2WalletProvider` | **Production agents** (recommended) | MPC server wallet via CDP API | `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` + `CDP_WALLET_SECRET` |
| `CdpSmartWalletProvider` | **Gasless on Base** | Smart contract wallet, gas sponsorship | CDP Smart Wallet API |
| `ViemWalletProvider` | **Development / scripting** | Raw private key in memory | `PRIVATE_KEY` env var |
| `PrivyWalletProvider` | **Embedded wallets** | Privy delegated/embedded wallets | Privy app credentials |

> **Note on Coinbase Agentic Wallet:** Coinbase's [Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/docs/welcome) (CLI/MPC-based, send/trade only) is a **different product** and is NOT compatible with AgentKit ActionProviders. Floe actions require a full `WalletProvider` that can sign arbitrary contract calls — use one of the providers above.

## Configuration

```typescript
floeActionProvider({
  // Base Mainnet (default)
  lendingIntentMatcherAddress: "0x17946cD3e180f82e632805e5549EC913330Bb175",
  lendingViewsAddress: "0x9101027166bE205105a9E0c68d6F14f21f6c5003",

  // Pre-configured market IDs for get_markets without arguments
  knownMarketIds: ["0x..."],
});
```

## Networks

- **Base Mainnet** (8453) — production
- **Base Sepolia** (84532) — testnet

## Contract Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| LendingIntentMatcher | `0x17946cD3e180f82e632805e5549EC913330Bb175` |
| LendingViews | `0x9101027166bE205105a9E0c68d6F14f21f6c5003` |
| PriceOracle | `0xEA058a06b54dce078567f9aa4dBBE82a100210Cc` |
| Aerodrome SwapRouter | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` |
| Aerodrome QuoterV2 | `0x254cF9E1E6e233aa1AC962CB9B05b2cFeAAe15b0` |
| WETH | `0x4200000000000000000000000000000000000006` |

## Examples

See the [`examples/`](./examples) directory for runnable scripts:

### Chatbot (Vercel AI SDK + CdpWalletProvider)

Full conversational agent on Base Mainnet with production MPC-managed keys:

```bash
cd examples
cp .env.example .env  # fill in CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY, OPENAI_API_KEY
npx tsx chatbot.ts
```

```typescript
import { AgentKit, CdpWalletProvider } from "@coinbase/agentkit";
import { tool } from "ai";
import { floeActionProvider } from "floe-agent";

const walletProvider = await CdpWalletProvider.configureWithWallet({
  apiKeyName: process.env.CDP_API_KEY_NAME,
  apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY,
  networkId: "base-mainnet",
});

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [floeActionProvider()], // defaults to Base Mainnet
});

// Convert AgentKit actions -> Vercel AI SDK tools
const actions = agentkit.getActions();
const tools = Object.fromEntries(
  actions.map((a) => [a.name, tool({ description: a.description, parameters: a.schema, execute: (args) => a.invoke(args) })])
);
```

### Standalone (No AI Framework)

Call actions programmatically — useful for development and scripting. Uses `ViemWalletProvider` with a raw private key:

```bash
cd examples
cp .env.example .env  # fill in PRIVATE_KEY
npx tsx standalone.ts
```

```typescript
import { FloeActionProvider } from "floe-agent";

const floe = new FloeActionProvider(); // defaults to Base Mainnet

const result = await floe.getMyLoans(walletProvider, {});
console.log(result);
```

## Local Development & Testing

Three ways to test `@floe/agentkit-actions` without publishing to npm:

### 1. `npm link` (live symlink)

```bash
# In agentkit-actions/
npm run build
npm link

# In your consumer project
npm link @floe/agentkit-actions
```

Changes to the source are picked up after `npm run build`. Unlink with `npm unlink @floe/agentkit-actions`.

### 2. `file:` protocol (package.json reference)

In your consumer project's `package.json`:

```json
{
  "dependencies": {
    "@floe/agentkit-actions": "file:../agentkit-actions"
  }
}
```

Then `npm install`. Simple but doesn't simulate a real publish.

### 3. `npm pack` (simulates real publish)

```bash
# In agentkit-actions/
npm run build
npm pack
# Creates floe-agentkit-actions-0.1.0.tgz

# In your consumer project
npm install ../agentkit-actions/floe-agentkit-actions-0.1.0.tgz
```

This is the safest way to validate what consumers will actually get. Verify contents first:

```bash
npm pack --dry-run
# Should only include: dist/, README.md, package.json
```

## Updating FlashArbReceiver Bytecode

If the `FlashArbReceiver.sol` contract changes, regenerate the bytecode:

```bash
cd modular-lending
forge build
node -e "const f=require('./out/FlashArbReceiver.sol/FlashArbReceiver.json'); console.log(f.bytecode.object)"
```

Copy the output into `src/flashArbBytecode.ts` as the `FLASH_ARB_RECEIVER_BYTECODE` constant, then rebuild:

```bash
cd agentkit-actions
npm run build
```

## Project Structure

```
src/
  index.ts                 # Package entry point, exports both providers
  floeActionProvider.ts    # 23 lending actions (FloeActionProvider)
  x402ActionProvider.ts    # 6 x402 credit actions (X402ActionProvider)
  schemas.ts               # Zod schemas for lending action inputs
  constants.ts             # Contract addresses, ABIs, known tokens
  flashArbBytecode.ts      # Compiled FlashArbReceiver bytecode + constructor ABI
  types.ts                 # TypeScript interfaces (Market, Loan, Intent, etc.)
  utils.ts                 # Formatting helpers (bps, token amounts, addresses)
  cli/
    bin.ts                 # CLI entry point (#!/usr/bin/env node)
    main.ts                # Interactive REPL loop
    prompts.ts             # Setup flow (wallet, AI, RPC prompts)
    walletFactory.ts       # Creates wallet provider from user selection
    aiFactory.ts           # Creates AI model (OpenAI/Claude/Ollama)
    config.ts              # Saves/loads .floe-agent.json
    display.ts             # Banner, session info, help text
examples/
  chatbot.ts               # Vercel AI SDK + CdpWalletProvider
  standalone.ts            # Direct action calls, no AI framework
  .env.example             # Environment variable template
```

## How Floe Differs from Aave/Compound

| Feature | Aave/Compound | Floe |
|---------|--------------|------|
| Model | Pool-based, variable rate | Intent-based, fixed rate |
| Rate | Algorithmic, changes per block | Fixed at match time |
| Term | Open-ended | Fixed duration |
| Matching | Automatic (pool) | Solver bots match offers |
| Liquidation | Pool absorbs bad debt | Per-loan, with incentive |
| Flash loans | From pool reserves | From protocol with receiver contract |
