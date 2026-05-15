# floe-agent

[![npm version](https://img.shields.io/npm/v/floe-agent)](https://www.npmjs.com/package/floe-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Base Mainnet](https://img.shields.io/badge/Base-Mainnet-0052FF)](https://basescan.org/address/0x17946cD3e180f82e632805e5549EC913330Bb175)

**The Financial OS for AI Agents — TypeScript SDK.**

Wallet, fiat on/off-ramp, working capital, x402 payments, and portable credit. One SDK. Works with Coinbase AgentKit, LangChain, Vercel AI SDK, Claude/Cursor (via MCP), and any framework that speaks HTTP.

`floe-agent` is the official TypeScript SDK and ships **two AgentKit `ActionProvider`s** that together expose 45 actions across the full Floe stack:

- **`floeActionProvider()`** — 30 lending actions (markets, intents, loans, collateral, flash loans, credit-facility helpers)
- **`x402ActionProvider()`** — 15 actions (6 x402 credit-delegation + 9 agent-awareness)

Register **both** in `actionProviders: [...]` if you want the full 45-action surface. Python parity ships as [`floe-agentkit-actions`](https://github.com/floe-labs/agentkit-actions-py).

> **Proof points:** 3,000+ secured working capital lines issued · zero defaults · 13,000+ x402 APIs reachable via the Floe proxy.

---

## The Floe Stack (what this SDK covers)

| # | Component | Status | Backed by |
|---|---|---|---|
| 01 | **Agent Wallet** | `GA` | Any `WalletProvider` (CDP, Privy, Viem, Smart Wallet) + ERC-8004 identity |
| 02 | **Fiat on-ramp** | `GA` (dashboard-driven) | Coinbase onramp via the [Floe dashboard](https://dev-dashboard.floelabs.xyz). Fiat off-ramp `Preview`. |
| 03 | **Secured working capital** | `GA` | `instant_borrow`, `repay_and_reborrow`, `check_credit_status`, `request_credit`, `manual_match_credit` + 15 lending primitives (in `floeActionProvider`) |
| 04 | **Unsecured working capital** | `Preview` | Receivables + chain-of-thought underwriting — email [hello@floelabs.xyz](mailto:hello@floelabs.xyz) for the design partner program |
| 05 | **x402 payment facilitator** | `GA` | `grant_credit_delegation`, `revoke_credit_delegation`, `check_credit_delegation`, `x402_fetch`, `x402_get_balance`, `x402_get_transactions` (in `x402ActionProvider`) |
| 06 | **Credit & trust bureau** | Reader `Beta` · Writer `Preview` | `list_credit_thresholds`, `register_credit_threshold`, `delete_credit_threshold` today (in `x402ActionProvider`). Portable ERC-8004 read API in Beta. |

---

## Framework support

| Framework | Status | How |
|---|---|---|
| Coinbase AgentKit | `GA` | Native — `floeActionProvider()` + `x402ActionProvider()` |
| LangChain | `GA` | Via `getLangChainTools(agentkit)` from `@coinbase/agentkit-langchain` |
| Vercel AI SDK | `GA` | Via `getVercelAITools(agentkit)` from `@coinbase/agentkit-vercel-ai-sdk` |
| Claude Desktop / Claude Code / Cursor | `GA` | Via [floe-mcp-server](https://github.com/Floe-Labs/floe-mcp-server) |
| CrewAI | `Beta` | Via MCP server |
| OpenAI Agents SDK | `Preview` | Native adapter on the way; MCP fallback today |
| ElizaOS | `Preview` | MCP fallback today |
| Plain HTTP / REST | `GA` | Any framework — call the [REST API](https://floe-labs.gitbook.io/docs/developers/credit-api) |

---

## Installation

```bash
npm install floe-agent @coinbase/agentkit viem zod
```

> **Fund with fiat:** Agents (or their operators) can fund wallets with USDC via Coinbase — credit card, bank transfer, Apple Pay, Google Pay — directly from the [Floe dashboard](https://dev-dashboard.floelabs.xyz). No crypto on-ramp needed.

### 30-second example

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { floeActionProvider, x402ActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider,
  // Register BOTH providers to expose all 45 actions.
  actionProviders: [
    floeActionProvider(),
    x402ActionProvider({ facilitatorApiKey: process.env.FLOE_FACILITATOR_API_KEY }),
  ],
});

// Borrow against on-chain collateral. `marketId` is required — fetch it via
// `get_markets` (see the action reference below) or hard-code a known one.
await agentkit.run("instant_borrow", {
  marketId: "0x...",                // bytes32 market id
  borrowAmount: "9500000000",
  collateralAmount: "10000000000",
  maxInterestRateBps: "800",
  duration: "1209600",
});

// Pay any x402 API through the Floe facilitator (provided by x402ActionProvider)
await agentkit.run("x402_fetch", {
  url: "https://api.example.com/premium",
  method: "POST",
  body: { prompt: "..." },
});

// Check health, then repay. `repay_loan` requires `repayAmount` (raw units of
// principal) per the schema; `slippageBps` is optional (defaults to 5%).
await agentkit.run("check_credit_status", { loanId: "42" });
await agentkit.run("repay_loan", {
  loanId: "42",
  repayAmount: "9500000000",
  slippageBps: "500",
});

// Or roll the position
await agentkit.run("repay_and_reborrow", { loanId: "42" });
```

---

## Architecture

```
Your app
  └─ AgentKit (45 actions exposed when both providers are registered)
        ├─ floeActionProvider()   → 30 lending actions
        │                          (markets, intents, loans, collateral,
        │                           flash loans, credit-facility helpers)
        └─ x402ActionProvider()   → 15 actions
                                   (6 x402 credit delegation +
                                    9 agent-awareness primitives)
              │
              │ each provider uses your WalletProvider to read chain
              │ and sign transactions:
              │
              ├─ CdpV2WalletProvider     (production — MPC server wallet)
              ├─ CdpSmartWalletProvider  (gasless on Base via AA)
              ├─ ViemWalletProvider      (dev / scripting — raw private key)
              └─ PrivyWalletProvider     (embedded / delegated wallets)
                    │
                    ▼  RPC calls + signed transactions
              Base Mainnet (8453)
                ├─ LendingIntentMatcher  0x17946...Bb175   write actions
                ├─ LendingViews          0x9101...5003     read actions
                ├─ PriceOracle           0xEA05...10Cc     readiness
                ├─ x402 Facilitator      0x58ED...31f1     x402 payments
                ├─ Aerodrome SwapRouter  0xBE6D...18a5     flash arb
                └─ ERC-20 Tokens (WETH, USDC, USDT, cbBTC, ...)
```

**Flow:** User speaks to LLM → LLM picks a Floe tool → AgentKit dispatches to either `FloeActionProvider` (lending) or `X402ActionProvider` (x402 + agent-awareness) → the matching provider uses `WalletProvider` to read chain / sign txs → transaction hits Floe contracts on Base.

---

## Quick Start

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { floeActionProvider, x402ActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider: myWalletProvider,
  actionProviders: [
    floeActionProvider({
      // Optional: defaults to Base Mainnet addresses
      knownMarketIds: [
        "0x...", // USDC/USDC market (primary — working capital)
        "0x...", // WETH/USDC market (volatile collateral)
      ],
    }),
    x402ActionProvider({
      facilitatorApiKey: process.env.FLOE_FACILITATOR_API_KEY, // required for x402 + agent-awareness
    }),
  ],
});
```

> **Skip `x402ActionProvider` only if your agent never makes x402 payments and never queries credit / spend-limit / threshold state.** You will lose 15 actions including `x402_fetch`, `estimate_x402_cost`, `get_credit_remaining`, `set_spend_limit`, and `register_credit_threshold`.

---

## Actions (45 total)

**Provider split:** `floeActionProvider` exposes 30 lending actions (everything in this section through *Credit Facility Actions*). `x402ActionProvider` exposes 15 actions (*x402 Credit Delegation* + *Agent Awareness*). Register both for the full surface.

### Read Actions (8) — `floeActionProvider`

| Action | Description |
|--------|-------------|
| `get_markets` | Get info about Floe lending markets (rates, LTV bounds, pause status). **Use this to obtain `marketId` for `instant_borrow` and friends.** |
| `get_loan` | Get detailed loan information (participants, health, time remaining) |
| `get_my_loans` | Get all loans for the connected wallet (as lender or borrower) |
| `check_loan_health` | Check loan health — current LTV vs liquidation threshold, buffer % |
| `get_price` | Get oracle price for a collateral/loan token pair (Chainlink + Pyth) |
| `get_accrued_interest` | Get interest accrued on a loan (amount, time elapsed, rate) |
| `get_liquidation_quote` | Get profit/loss breakdown for liquidating an unhealthy loan |
| `get_intent_book` | Look up an on-chain lend or borrow intent by hash |

### Write Actions (7) — `floeActionProvider`

| Action | Description |
|--------|-------------|
| `post_lend_intent` | Post a fixed-rate lending offer (auto-approves loan token) |
| `post_borrow_intent` | Post a borrow request with collateral (auto-approves collateral) |
| `match_intents` | Match a lend + borrow intent to create a loan |
| `repay_loan` | Repay a loan fully or partially. **Required:** `loanId`, `repayAmount` (raw principal units). **Optional:** `slippageBps` (default 5%). Collateral auto-returns in the same tx. |
| `add_collateral` | Add collateral to improve loan health |
| `withdraw_collateral` | Withdraw excess collateral (enforces safety buffer) |
| `liquidate_loan` | Liquidate an unhealthy loan (currentLTV >= threshold or overdue) |

All write actions **auto-approve** tokens to the LendingIntentMatcher with a 1% buffer before submitting. Repay and liquidate actions include configurable slippage protection (default 5%).

### Flash Loan Actions (5) — `floeActionProvider`

| Action | Description |
|--------|-------------|
| `get_flash_loan_fee` | Get the protocol's flash loan fee (in bps) |
| `estimate_flash_arb_profit` | Simulate a multi-leg arb route via Aerodrome QuoterV2 |
| `flash_loan` | Execute a raw flash loan (receiver must implement `IFlashloanReceiver`) |
| `flash_arb` | Execute a flash arb via a deployed FlashArbReceiver |
| `get_flash_arb_balance` | Check accumulated profit in a FlashArbReceiver |

> **`flash_loan` vs `flash_arb`:** `flash_loan` sends tokens to `msg.sender` and calls `receiveFlashLoan()` — your connected wallet must be a smart contract. EOA wallets will revert. Use `flash_arb` instead, which routes through a pre-deployed FlashArbReceiver contract that handles repayment automatically.

### Credit Facility Actions (5) — `floeActionProvider`

| Action | Description |
|--------|-------------|
| `instant_borrow` | Borrow USDC instantly. **Required:** `marketId` (bytes32; obtain via `get_markets`), `borrowAmount`, `collateralAmount`, `maxInterestRateBps`, `duration`. Auto-selects best lender, handles approval + register + match in one call. |
| `repay_and_reborrow` | Repay an existing loan and instantly borrow again. If reborrow fails, repayment still succeeds |
| `check_credit_status` | Loan health, balance, accrued interest, time to expiry, early repayment terms |
| `request_credit` | Browse available credit offers — rates, amounts, durations |
| `manual_match_credit` | Match with a specific lend intent (register + match) |

> **`instant_borrow` vs `manual_match_credit`:** Use `instant_borrow` for one-call capital. Use `request_credit` + `manual_match_credit` if you want to pick a specific lender.

### Deploy / Verify / Readiness Actions (3) — `floeActionProvider`

| Action | Description |
|--------|-------------|
| `deploy_flash_arb_receiver` | Deploy a new FlashArbReceiver with pre-flight checks |
| `check_flash_arb_readiness` | Check environment readiness (fee, liquidity, oracle, router) |
| `verify_flash_arb_receiver` | Verify a receiver's owner and immutable config |

### x402 Credit Delegation Actions (6) — `x402ActionProvider`

| Action | Description |
|--------|-------------|
| `grant_credit_delegation` | Delegate borrowing authority to a facilitator (sets operator + collateral approval) |
| `revoke_credit_delegation` | Revoke a facilitator's borrowing authority |
| `check_credit_delegation` | Check delegation status (approved, limits, borrowed, expiry) |
| `x402_fetch` | Fetch a URL with automatic x402 payment handling |
| `x402_get_balance` | Check x402 credit balance |
| `x402_get_transactions` | List recent x402 payment transactions |

### Agent Awareness Actions (9) — `x402ActionProvider`

Lets an agent answer "do I have credit?", "is this call worth it?", and "where am I in the loan lifecycle?" before committing capital. All require `facilitatorApiKey` to be configured on `x402ActionProvider`.

| Action | Description |
|--------|-------------|
| `get_credit_remaining` | Available USDC, headroom to auto-borrow, utilization in bps, session-cap state |
| `get_loan_state` | Coarse state machine: `idle` \| `borrowing` \| `at_limit` \| `repaying` |
| `get_spend_limit` | Currently active session spend cap, if any |
| `set_spend_limit` | Set a session-level USDC ceiling (resets the session window) |
| `clear_spend_limit` | Remove the session spend cap |
| `list_credit_thresholds` | List registered credit-utilization webhook triggers |
| `register_credit_threshold` | Register a webhook trigger at a utilization threshold (cap: 20 per agent) |
| `delete_credit_threshold` | Remove a registered threshold |
| `estimate_x402_cost` | Preflight an x402 URL — returns cost + reflection against your credit (no payment) |

> **Decision-loop pattern:** call `estimate_x402_cost` → check `willExceedAvailable` / `willExceedSpendLimit` → conditionally `x402_fetch`. This is the "answer the 3 rational-agent questions in one round-trip" workflow.

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

---

## Framework Integrations

### Vercel AI SDK

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { getVercelAITools } from "@coinbase/agentkit-vercel-ai-sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { floeActionProvider, x402ActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    floeActionProvider(),
    x402ActionProvider({ facilitatorApiKey: process.env.FLOE_FACILITATOR_API_KEY }),
  ],
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

### MCP (Claude Desktop / Claude Code / Cursor)

Zero-install via the hosted Floe MCP endpoint:

```json
{
  "mcpServers": {
    "floe": {
      "url": "https://mcp.floelabs.xyz/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Or run a local MCP server that wraps this SDK — see [floe-mcp-server](https://github.com/Floe-Labs/floe-mcp-server).

### OpenAI Agents SDK (Preview)

A native OpenAI Agents adapter is on the roadmap. Today, use the MCP server endpoint or the AgentKit `create-onchain-agent` scaffold:

```bash
npx create-onchain-agent@latest
# Select "OpenAI Agents SDK" as framework
```

Then register `floeActionProvider()` and `x402ActionProvider()` alongside the built-in action providers.

---

## CLI: `floe-agent`

Interactive conversational agent for testing all 45 actions without writing any framework code. Both providers are registered automatically.

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
| `FLOE_FACILITATOR_API_KEY` | Required for x402 + agent-awareness actions |

### Example session

```
You: Check flash arb readiness
  → Shows fee, WETH liquidity, circuit breaker, SwapRouter status

You: Deploy a FlashArbReceiver for me
  → Pre-flight checks, deploys contract, stores address in session

You: Verify my FlashArbReceiver
  → Validates owner/LENDING_PROTOCOL/SWAP_ROUTER (no address needed)

You: Check the WETH balance in my FlashArbReceiver
  → Shows 0 WETH (auto-uses session address)

You: Execute a flash arb: borrow 0.01 WETH, swap WETH -> USDC tick spacing 100, then USDC -> WETH tick spacing 100, min profit 0
  → Submits the flash arb transaction
```

---

## Wallet Providers

| Provider | Use Case | Key Management | Setup |
|----------|----------|----------------|-------|
| `CdpV2WalletProvider` | **Production agents** (recommended) | MPC server wallet via CDP API | `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` + `CDP_WALLET_SECRET` |
| `CdpSmartWalletProvider` | **Gasless on Base** | Smart contract wallet, gas sponsorship | CDP Smart Wallet API |
| `ViemWalletProvider` | **Development / scripting** | Raw private key in memory | `PRIVATE_KEY` env var |
| `PrivyWalletProvider` | **Embedded wallets** | Privy delegated/embedded wallets | Privy app credentials |

> **Note on Coinbase Agentic Wallet:** Coinbase's [Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/docs/welcome) (CLI/MPC-based, send/trade only) is a **different product** and is NOT compatible with AgentKit ActionProviders. Floe actions require a full `WalletProvider` that can sign arbitrary contract calls — use one of the providers above.

---

## Configuration

```typescript
floeActionProvider({
  // Base Mainnet (default)
  lendingIntentMatcherAddress: "0x17946cD3e180f82e632805e5549EC913330Bb175",
  lendingViewsAddress: "0x9101027166bE205105a9E0c68d6F14f21f6c5003",

  // Pre-configured market IDs for get_markets without arguments
  knownMarketIds: ["0x..."],
});

x402ActionProvider({
  // Required for x402 + agent-awareness actions
  facilitatorApiKey: process.env.FLOE_FACILITATOR_API_KEY,
});
```

---

## Networks

- **Base Mainnet** (8453) — production
- **Base Sepolia** (84532) — testnet

## Contract Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| LendingIntentMatcher | `0x17946cD3e180f82e632805e5549EC913330Bb175` |
| LendingViews | `0x9101027166bE205105a9E0c68d6F14f21f6c5003` |
| PriceOracle | `0xEA058a06b54dce078567f9aa4dBBE82a100210Cc` |
| x402 Facilitator | `0x58EDdE022FFDAD3Fb0Fb0E7D51eb05AaF66a31f1` |
| Aerodrome SwapRouter | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` |
| Aerodrome QuoterV2 | `0x254cF9E1E6e233aa1AC962CB9B05b2cFeAAe15b0` |
| WETH | `0x4200000000000000000000000000000000000006` |

---

## Examples

See the [`examples/`](./examples) directory for runnable scripts, and [floe-examples](https://github.com/Floe-Labs/floe-examples) for end-to-end multi-framework agents — including the canonical `financial-os-loop` example that wires every GA component in one flow.

### Chatbot (Vercel AI SDK + CdpWalletProvider)

Full conversational agent on Base Mainnet with production MPC-managed keys:

```bash
cd examples
cp .env.example .env  # fill in CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY, OPENAI_API_KEY
npx tsx chatbot.ts
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

---

## Local Development & Testing

Three ways to test `floe-agent` without publishing to npm:

### 1. `npm link` (live symlink)

```bash
# In agentkit-actions/
npm run build
npm link

# In your consumer project
npm link floe-agent
```

Changes to the source are picked up after `npm run build`. Unlink with `npm unlink floe-agent`.

### 2. `file:` protocol (package.json reference)

In your consumer project's `package.json`:

```json
{
  "dependencies": {
    "floe-agent": "file:../agentkit-actions"
  }
}
```

Then `npm install`. Simple but doesn't simulate a real publish.

### 3. `npm pack` (simulates real publish)

```bash
# In agentkit-actions/
npm run build
npm pack
# Creates floe-agent-<version>.tgz (e.g. floe-agent-0.4.0.tgz)

# In your consumer project — substitute the actual tarball name printed
# by `npm pack` above; it tracks the `version` field in package.json.
npm install ../agentkit-actions/floe-agent-0.4.0.tgz
```

This is the safest way to validate what consumers will actually get. Verify contents first:

```bash
npm pack --dry-run
# Should only include: dist/, README.md, package.json
```

---

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

---

## Project Structure

```
src/
  index.ts                 # Package entry point, exports both providers
  floeActionProvider.ts    # 30 lending actions (FloeActionProvider)
  x402ActionProvider.ts    # 15 actions (6 x402 credit delegation + 9 agent-awareness)
  schemas.ts               # Zod schemas for action inputs (e.g. InstantBorrowSchema, RepayLoanSchema)
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

---

## Links

- [Website](https://floelabs.xyz)
- [Documentation](https://floe-labs.gitbook.io/docs)
- [Python counterpart (`floe-agentkit-actions`)](https://github.com/Floe-Labs/agentkit-actions-py)
- [MCP server (`@floelabs/mcp-server`)](https://github.com/Floe-Labs/floe-mcp-server)
- [End-to-end examples](https://github.com/Floe-Labs/floe-examples)

## License

MIT
