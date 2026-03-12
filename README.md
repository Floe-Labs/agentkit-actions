# @floe/agentkit-actions

Coinbase AgentKit ActionProvider for the [Floe](https://floelabs.xyz) DeFi lending protocol on Base.

Provides 15 actions that let AI agents (LangChain, OpenAI Agents SDK, CrewAI) interact with Floe's intent-based lending protocol — making Floe a first-class verb alongside "transfer" and "swap" in any AgentKit agent.

## Installation

```bash
npm install @floe/agentkit-actions @coinbase/agentkit viem zod
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Agent Developer's App                      │
│                                                             │
│  ┌─────────────┐    ┌──────────┐    ┌────────────────────┐ │
│  │     LLM     │───▶│ AgentKit │───▶│ FloeActionProvider │ │
│  │ (GPT/Claude)│    │          │    │   (15 actions)     │ │
│  └─────────────┘    └────┬─────┘    └────────┬───────────┘ │
│                          │                   │             │
│                          ▼                   │             │
│                  ┌──────────────┐             │             │
│                  │WalletProvider│◀────────────┘             │
│                  └──────┬───────┘  signs & sends txs       │
│                         │                                   │
│  ┌──────────────────────┼──────────────────────────┐       │
│  │ Choose one:          │                          │       │
│  │ • CdpWalletProvider  │ (prod — MPC managed keys)│       │
│  │ • SmartWallet        │ (AA — session keys)      │       │
│  │ • ViemWalletProvider │ (dev — raw private key)  │       │
│  └──────────────────────┼──────────────────────────┘       │
└─────────────────────────┼───────────────────────────────────┘
                          │ RPC calls + signed transactions
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Base Mainnet (8453)                       │
│                                                             │
│  LendingIntentMatcher  0x17946...Bb175   ◀── write actions │
│  LendingViews          0x9101...5003     ◀── read actions  │
│  ERC-20 Tokens (WETH, USDC, DAI, ...)   ◀── approvals     │
└─────────────────────────────────────────────────────────────┘
```

**Flow:** User speaks to LLM → LLM picks a Floe tool → AgentKit calls FloeActionProvider → provider uses WalletProvider to read chain / sign txs → transaction hits Floe contracts on Base.

## Quick Start

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { floeActionProvider } from "@floe/agentkit-actions";

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

## Actions

### Read Actions
| Action | Description |
|--------|-------------|
| `get_markets` | Get info about Floe lending markets |
| `get_loan` | Get detailed loan information |
| `get_my_loans` | Get all loans for the connected wallet |
| `check_loan_health` | Check loan health and liquidation risk |
| `get_price` | Get oracle price for a token pair |
| `get_accrued_interest` | Get interest accrued on a loan |
| `get_liquidation_quote` | Get profit/loss breakdown for a liquidation |
| `get_intent_book` | Look up an on-chain intent by hash |

### Write Actions
| Action | Description |
|--------|-------------|
| `post_lend_intent` | Post a fixed-rate lending offer |
| `post_borrow_intent` | Post a borrow request with collateral |
| `match_intents` | Match a lend + borrow intent to create a loan |
| `repay_loan` | Repay a loan (fully or partially) |
| `add_collateral` | Add collateral to improve loan health |
| `withdraw_collateral` | Withdraw excess collateral |
| `liquidate_loan` | Liquidate an unhealthy loan |

## Wallet Providers

| Provider | Use Case | Key Management | Setup |
|----------|----------|----------------|-------|
| `CdpWalletProvider` | **Production agents** | MPC-managed keys via Coinbase Developer Platform | `CDP_API_KEY_NAME` + `CDP_API_KEY_PRIVATE_KEY` |
| `SmartWallet` | **Account abstraction** | Session keys, gas sponsorship | ERC-4337 smart account |
| `ViemWalletProvider` | **Development / scripting** | Raw private key in memory | `PRIVATE_KEY` env var |

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
import { floeActionProvider } from "@floe/agentkit-actions";

const walletProvider = await CdpWalletProvider.configureWithWallet({
  apiKeyName: process.env.CDP_API_KEY_NAME,
  apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY,
  networkId: "base-mainnet",
});

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [floeActionProvider()], // defaults to Base Mainnet
});

// Convert AgentKit actions → Vercel AI SDK tools
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
import { FloeActionProvider } from "@floe/agentkit-actions";

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

## How Floe Differs from Aave/Compound

| Feature | Aave/Compound | Floe |
|---------|--------------|------|
| Model | Pool-based, variable rate | Intent-based, fixed rate |
| Rate | Algorithmic, changes per block | Fixed at match time |
| Term | Open-ended | Fixed duration |
| Matching | Automatic (pool) | Solver bots match offers |
| Liquidation | Pool absorbs bad debt | Per-loan, with incentive |
