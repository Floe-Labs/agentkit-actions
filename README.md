# floe-agent

[![npm version](https://img.shields.io/npm/v/floe-agent)](https://www.npmjs.com/package/floe-agent) · [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) · [![Base Mainnet](https://img.shields.io/badge/Base-Mainnet-0052FF)](https://basescan.org/address/0x17946cD3e180f82e632805e5549EC913330Bb175)

**The spend layer for AI agents — TypeScript SDK.** Pay any of 2,000+ vendor API
services through one endpoint, with budgets your agent can reason about.
Walletless. No crypto required.

[Website](https://floelabs.xyz) · [Docs](https://floe-labs.gitbook.io/docs) · [Dashboard](https://dev-dashboard.floelabs.xyz) · [Python SDK](https://github.com/Floe-Labs/agentkit-actions-py)

---

## Start building with Floe

One key for your agent's whole vendor bill — LLM, voice, telephony, search, data — metered per call and budget-capped. Let your coding agent set it up, or wire it yourself:

| Path | One line |
|---|---|
| **Agent** — Claude Code / Cursor does the setup | paste: `Read https://dev-dashboard.floelabs.xyz/agents.md and set up Floe for this project.` |
| **Skill** — install the Floe agent skill | `npx skills add floe-labs/agent-skills` |
| **MCP** — hosted MCP server (65 tools) | `npx -y add-mcp https://mcp.floelabs.xyz/mcp` |
| **CLI** — mint a key + print the base-URL swap | `npx @floelabs/cli init` |
| **NPM** — the SDK + `floe-agent` CLI | `npm i -g floe-agent` |

New accounts get a **$3 Welcome Credit (300 API credits)** — no card. [Set up with your AI tools →](https://floe-labs.gitbook.io/docs/getting-started/setup-with-ai-tools) · [Get a key →](https://dev-dashboard.floelabs.xyz)

## What it does

Your agent calls paid APIs — LLMs, voice, search, data. Floe is the spend layer
in front of those calls:

- **One endpoint, many vendors.** Pay any x402 API through the Floe facilitator. No per-vendor accounts or keys.
- **Budgets the agent can reason about.** Ask "do I have budget? is this call worth it?" *before* paying.
- **Programmable spend controls.** Per-call caps, daily limits, allowed destinations, session ceilings — enforced server-side, before money moves.
- **Walletless.** Email + a funding source. Floe provisions wallets in the background — no MetaMask, no seed phrase, no gas. The stablecoin rails are invisible.
- **Real-time visibility.** Every call is a typed receipt: target, amount, status, time.

Two layers in one package:

| Layer | What it is | For |
|---|---|---|
| **`FloeAgent`** ⭐ | High-level runtime client. No wallet, no chain knowledge. Dollars in, dollars out. | Most agent developers |
| **`floeActionProvider()` + `x402ActionProvider()`** | 54 AgentKit actions for self-custody, lending, and framework integrations. Python parity ships as `floe-agentkit-actions`. | Self-custody / on-chain use cases |

## Install

`FloeAgent` (the runtime client) can be used standalone:

```bash
npm install floe-agent
```

The AgentKit action providers need `@coinbase/agentkit` and its peers:

```bash
npm install floe-agent @coinbase/agentkit viem zod
```

## 30-second example

No wallet, no chain. Your agent pays for an API and stays inside its budget.

```typescript
import { FloeAgent } from "floe-agent";

const agent = new FloeAgent({ apiKey: process.env.FLOE_API_KEY });

// Check budget before spending. `balance()` returns a plain number.
const available = await agent.balance();   // dollars available to spend
// For active loans, pending settlements, and raw units, use:
//   const detail = await agent.balanceDetails(); // BalanceResult

// Pay any x402 API. The agent never touches the payment layer.
const res = await agent.fetch({
  url: "https://api.exa.ai/search",
  method: "POST",
  body: JSON.stringify({ query: "AI agent frameworks" }),
});
// res is a FetchResult: res.body (string), res.cost (USDC dollars), res.status
```

**Fund with fiat:** operators fund the wallet with USDC via Coinbase — card,
bank transfer, Apple Pay, Google Pay — directly from the dashboard. No crypto
on-ramp.

Get an agent key: [dashboard](https://dev-dashboard.floelabs.xyz) → connect →
**Create an agent** → copy the `floe_<hex>` key (shown once).

## The decision loop (what makes this different)

Most SDKs let an agent *spend*. Floe lets an agent reason about spend **before it
commits**, then stops it before it overruns.

```typescript
// 1. Preflight the cost against your balance — no payment is made.
const estimate = await agent.estimateCost("https://api.example.com/premium");
// estimate => { cost: number; canAfford: boolean; isPaid: boolean }

// 2. Only pay if the agent can afford it.
if (estimate.canAfford) {
  await agent.fetch({
    url: "https://api.example.com/premium",
    method: "POST",
    body: JSON.stringify({ prompt: "..." }),
  });
}
```

This is the "answer the three rational-agent questions in one round-trip"
workflow: *Do I have budget? Is this call worth it? Where am I in my spend?*

> The lower-level `x402ActionProvider` action `estimate_x402_cost` is a separate
> API that returns a richer reflection (`willExceedAvailable` /
> `willExceedSpendLimit`) for AgentKit tool calls — see the Advanced section.

## Framework support

| Framework | Status | How |
|---|---|---|
| Coinbase AgentKit | GA | Native — `floeActionProvider()` + `x402ActionProvider()` |
| Vercel AI SDK | GA | `getVercelAITools(agentkit)` from `@coinbase/agentkit-vercel-ai-sdk` |
| LangChain | GA | `getLangChainTools(agentkit)` from `@coinbase/agentkit-langchain` |
| Claude / Cursor | GA | via [floe-mcp-server](https://github.com/Floe-Labs/floe-mcp-server) |
| CrewAI | Beta | via MCP server |
| OpenAI Agents SDK | Preview | native adapter on the way; MCP fallback today |
| ElizaOS | Preview | MCP fallback today |
| Plain HTTP / REST | GA | any framework |

```typescript
// Vercel AI SDK (requires: npm install floe-agent @coinbase/agentkit viem zod)
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
  prompt: "What did my agent spend today?",
});
```

```jsonc
// MCP (Claude Desktop / Claude Code / Cursor) — zero install
{ "mcpServers": { "floe": {
  "url": "https://mcp.floelabs.xyz/mcp",
  "transport": "streamable-http"
} } }
```

---

<details>
<summary><b>Advanced: self-custody, lending & flash-loan actions (54 total)</b></summary>

> These actions are for **self-custody and on-chain use cases** (managing your
> own wallet, lending against deposits, MEV/arb). If you're building a standard
> agent that just needs to pay for APIs, use `FloeAgent` above — you don't need
> this section.

`floeActionProvider()` exposes 30 lending actions; `x402ActionProvider()`
exposes 24 (6 x402 credit-delegation + 9 agent-awareness + 5 merchant-allowlist
+ 2 credit-facility helpers + 2 Floe Inference). Register both for the full 54-action surface.

### Install

```bash
npm install floe-agent @coinbase/agentkit viem zod
```

### Self-custody example

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { floeActionProvider, x402ActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    floeActionProvider({ knownMarketIds: ["0x..."] }),
    x402ActionProvider({ facilitatorApiKey: process.env.FLOE_FACILITATOR_API_KEY }),
  ],
});

// Borrow against on-chain collateral. marketId is required — fetch via get_markets.
await agentkit.run("instant_borrow", {
  marketId: "0x...",
  borrowAmount: "9500000000",
  collateralAmount: "10000000000",
  maxInterestRateBps: "800",
  duration: "1209600",
});
```

> Skip `x402ActionProvider` only if your agent never makes x402 payments and
> never queries credit / spend-limit / threshold state. You lose `x402_fetch`,
> `estimate_x402_cost`, `get_credit_remaining`, `set_spend_limit`, and
> `register_credit_threshold`.

## `floeActionProvider()` — 30 lending actions

### Read actions (8)

| Action | Description |
|---|---|
| `get_markets` | Lending markets — rates, LTV bounds, pause status. Source of `marketId`. |
| `get_loan` | Loan detail — participants, health, time remaining |
| `get_my_loans` | All loans for the connected wallet |
| `check_loan_health` | LTV vs liquidation threshold, buffer % |
| `get_price` | Oracle price for a pair (Chainlink + Pyth) |
| `get_accrued_interest` | Interest accrued — amount, time, rate |
| `get_liquidation_quote` | P/L for liquidating an unhealthy loan |
| `get_intent_book` | Look up an on-chain intent by hash |

### Write actions (7) — submit on-chain transactions (signed by your wallet provider)

| Action | Description |
|---|---|
| `post_lend_intent` | Post a fixed-rate lending offer (auto-approves loan token) |
| `post_borrow_intent` | Post a borrow request with collateral |
| `match_intents` | Match a lend + borrow intent to create a loan |
| `repay_loan` | Repay fully/partially. Required: `loanId`, `repayAmount` (raw principal). Optional: `slippageBps` (default 5%). Collateral auto-returns same tx. |
| `add_collateral` | Add collateral to improve loan health |
| `withdraw_collateral` | Withdraw excess collateral (enforces safety buffer) |
| `liquidate_loan` | Liquidate an unhealthy loan (LTV ≥ threshold or overdue) |

Write actions auto-approve tokens to `LendingIntentMatcher` with a 1% buffer,
then submit the transaction through your configured `WalletProvider` and return
a formatted result including the tx hash.

### Credit facility actions (7)

| Action | Description |
|---|---|
| `instant_borrow` | Borrow USDC. Required: `marketId` (via `get_markets`), `borrowAmount`, `collateralAmount`, `maxInterestRateBps`, `duration`. Auto-selects lender, approval + register + match in one call. |
| `repay_and_reborrow` | Repay then reborrow; if reborrow fails, repayment still succeeds |
| `repay_credit` | Fully repay an open credit line (principal + accrued interest) |
| `renew_credit_line` | Roll an existing credit line into a fresh term |
| `check_credit_status` | Health, balance, accrued interest, expiry, early-repayment terms |
| `request_credit` / `manual_match_credit` | Browse offers / match a specific lender |

### Flash-loan actions (5) — crypto-native / MEV

| Action | Description |
|---|---|
| `get_flash_loan_fee` | Protocol flash-loan fee (bps) |
| `estimate_flash_arb_profit` | Simulate a multi-leg arb via Aerodrome QuoterV2 |
| `flash_loan` | Raw flash loan (receiver implements `IFlashloanReceiver`; EOA wallets revert) |
| `flash_arb` | Flash arb via a deployed `FlashArbReceiver` (handles repayment) |
| `get_flash_arb_balance` | Accumulated profit in a receiver |

### Deploy / verify / readiness (3)

`deploy_flash_arb_receiver` · `check_flash_arb_readiness` · `verify_flash_arb_receiver`

**Flash-arb flow:** deploy → check readiness → estimate profit → `flash_arb` →
check balance. The deployed receiver address is stored on the provider instance
and auto-reused; override with `receiverAddress`.

## `x402ActionProvider()` — 24 actions

All x402 + agent-awareness + allowlist actions require `facilitatorApiKey`
configured on `x402ActionProvider`.

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { floeActionProvider, x402ActionProvider } from "floe-agent";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    floeActionProvider(),
    x402ActionProvider({ facilitatorApiKey: process.env.FLOE_FACILITATOR_API_KEY }),
  ],
});
```

### x402 payment & delegation (6)

| Action | Description |
|---|---|
| `grant_credit_delegation` | Delegate borrowing authority to a facilitator (operator + collateral approval) |
| `revoke_credit_delegation` | Revoke a facilitator's borrowing authority |
| `check_credit_delegation` | Check delegation status (approved, limits, borrowed, expiry) |
| `x402_fetch` | Fetch a URL with automatic x402 payment handling |
| `x402_get_balance` | Check x402 credit balance |
| `x402_get_transactions` | List recent x402 payment transactions |

### Agent-awareness (9)

| Action | Description |
|---|---|
| `get_credit_remaining` | Available USDC, headroom, utilization (bps), session-cap state |
| `get_loan_state` | Coarse state: `idle` / `borrowing` / `at_limit` / `repaying` |
| `get_spend_limit` / `set_spend_limit` / `clear_spend_limit` | Read / set / remove a session USDC ceiling |
| `list_credit_thresholds` / `register_credit_threshold` / `delete_credit_threshold` | Webhook triggers on utilization (cap: 20 per agent) |
| `estimate_x402_cost` | Preflight an x402 URL — cost + reflection (`willExceedAvailable` / `willExceedSpendLimit`) against credit, no payment |

> **Decision-loop pattern (AgentKit):** `estimate_x402_cost` → check
> `willExceedAvailable` / `willExceedSpendLimit` → conditionally `x402_fetch`.
> (The `FloeAgent.estimateCost` method above is the runtime-client equivalent;
> it gates on `canAfford`.)

### Merchant allowlist (5)

Opt-in, default-deny restriction on **which destinations** an agent may pay. An
allowlist entry is a capped policy row that doubles as "allowed AND capped".
Default mode `off` = allow any vendor.

| Action | Description |
|---|---|
| `set_allowlist_mode` | Set enforcement: `off` \| `host` (block unlisted hosts pre-fetch) \| `vendor` (block unlisted payees pre-sign) \| `both` |
| `get_allowlist_mode` | Read the agent's current enforcement mode |
| `add_allowlist_entry` | Add an allowed-AND-capped entry — `kind='api'` (host) or `kind='vendor'` (payee), with a `limitRaw` spend cap |
| `remove_allowlist_entry` | Revoke an allowlist entry by policy id (from `list_allowlist`) |
| `list_allowlist` | List host (`api`) and payee (`vendor`) allowlist entries with their caps |

### Credit-facility helpers (2)

| Action | Description |
|---|---|
| `open_credit_line` | Open a USDC/USDC credit line for the delegated agent |
| `x402_await_settlement` | Poll a pending x402 reservation until it settles |

### Wallet providers

| Provider | Use case | Keys |
|---|---|---|
| `CdpV2WalletProvider` | Production (MPC) | See the env-var table below (`CDP_API_KEY_NAME` + `CDP_API_KEY_PRIVATE_KEY`) |
| `CdpSmartWalletProvider` | Gasless on Base (AA) | CDP Smart Wallet API |
| `ViemWalletProvider` | Dev / scripting | `PRIVATE_KEY` |
| `PrivyWalletProvider` | Embedded / delegated | Privy credentials |

> **Coinbase Agentic Wallet** (CLI/MPC, send/trade only) is a *different product*
> and is NOT compatible with AgentKit ActionProviders — Floe actions need a
> WalletProvider that can sign arbitrary contract calls.

### Contract addresses (Base Mainnet)

| Contract | Address |
|---|---|
| LendingIntentMatcher | `0x17946cD3e180f82e632805e5549EC913330Bb175` |
| LendingViews | `0x9101027166bE205105a9E0c68d6F14f21f6c5003` |
| PriceOracle | `0xEA058a06b54dce078567f9aa4dBBE82a100210Cc` |
| x402 Facilitator | `0x58EDdE022FFDAD3Fb0Fb0E7D51eb05AaF66a31f1` |
| Aerodrome SwapRouter | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` |
| Aerodrome QuoterV2 | `0x254cF9E1E6e233aa1AC962CB9B05b2cFeAAe15b0` |
| WETH | `0x4200000000000000000000000000000000000006` |

Networks: Base Mainnet (8453) · Base Sepolia (84532).

</details>

## CLI

```bash
npm i -g floe-agent          # installs the `floe-agent` bin
floe-agent status --json     # auth check + capabilities + balance snapshot
```

> The `floe` bin name now belongs to the standalone platform CLI,
> [`@floelabs/cli`](https://github.com/Floe-Labs/floe-cli) (`npx @floelabs/cli init`).
> This package's CLI is invoked as `floe-agent`; the commands below are otherwise
> unchanged. The interactive lending REPL (`floe-agent run`, the historical
> default) is lazy-loaded — management commands never pay its startup cost
> under `npx`.

### Command tree

```text
floe-agent status                          auth + capabilities probe + balances
floe-agent auth status|set-key             dev key via FLOE_API_KEY env or OS keychain
floe-agent agents create|list|get|pause|resume|close    agent lifecycle (dev key)
floe-agent agents keys create|rotate|revoke [--budget <usd>]   runtime floe_ keys
floe-agent keys create|list|rotate|revoke  developer floe_live_ keys
floe-agent policy list|set|delete|reset [--agent <id>|--team]  spend policies
floe-agent limit get|set|clear [--agent <id>]                  session spend cap
floe-agent allowlist mode|add|remove|list [--agent <id>]       merchant allowlist
floe-agent balance                         developer rollup / agent balance
floe-agent fund <agentId>                  deposit address + funding instructions
floe-agent estimate <url> | floe-agent forecast <url>…   x402 cost preflight (agent key)
floe-agent pay <url> [--method --body --header]    paid x402 call via /v1/proxy/fetch
floe-agent models | floe-agent usage | floe-agent activity     catalog / analytics / feed
floe-agent webhooks create|list|test|rotate-secret|deliveries
floe-agent skills install                  Floe skill (Floe-Labs/agent-skills) → .claude/skills + ~/.agents/skills
floe-agent mcp install                     npx -y add-mcp https://mcp.floelabs.xyz/mcp
floe-agent run | register | use | rotate | revoke | open-credit-line   legacy wallet flows
```

### Conventions

- `--json` on **every** command: raw API JSON on stdout, no spinner/color.
- Exit codes: `0` ok · `1` error · `2` usage · `4` auth required ·
  `5` payment required (402).
- Non-interactive when stdout is not a TTY (missing input → exit 2, never a
  prompt); `NO_COLOR` respected.
- All HTTP calls send `User-Agent: floe-cli/<version>`.
- Keys are printed exactly once at mint/rotate time and stored in the OS
  keychain; the CLI never echoes a key it didn't just mint.

### Auth

Management commands (`agents`, `keys`, `policy`, …) resolve, in order:
`FLOE_API_KEY` when it holds a `floe_live_` developer key → the key stored by
`floe-agent auth set-key` → EIP-191 wallet-signature headers when `PRIVATE_KEY` is
set. If none of the above is present, the command exits `4` with a pointer to
[dev-dashboard.floelabs.xyz](https://dev-dashboard.floelabs.xyz). Payment
commands (`pay`, `estimate`, `forecast`) prefer `FLOE_AGENT_KEY`, then the
active agent's keychain key, then `FLOE_API_KEY` when it is a `floe_` agent
key. So `FLOE_API_KEY` accepts either key type — the key's own prefix decides
which plane it drives (the API refuses agent keys on `/v1/developer/*`).

### Environment variables (CLI / examples)

| Variable | Description |
|---|---|
| `FLOE_API_KEY` | CLI credential: `floe_live_` drives management commands, `floe_` drives payment commands; also the agent key for `FloeAgent` |
| `FLOE_AGENT_KEY` | `floe_` agent-key override for payment commands |
| `FLOE_API_URL` | Credit API base URL (default `https://credit-api.floelabs.xyz`) |
| `FLOE_FACILITATOR_URL` | Default facilitator URL for `floe-agent register` |
| `FLOE_FACILITATOR_API_KEY` | Required for x402 + agent-awareness actions |
| `PRIVATE_KEY` | Wallet private key (self-custody + signature-auth fallback) |
| `CDP_API_KEY_NAME` | Coinbase CDP API key name |
| `CDP_API_KEY_PRIVATE_KEY` | Coinbase CDP API private key |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | CLI conversational agent |
| `BASE_RPC_URL` | Custom Base RPC (recommended) |

## Examples

See [`floe-cookbook`](https://github.com/Floe-Labs/floe-cookbook) for end-to-end
multi-framework agents. The `examples/` directory here has a Vercel AI SDK
chatbot (`chatbot.ts`) and a no-framework standalone script (`standalone.ts`).

<details>
<summary>Local development & testing</summary>

```bash
# npm link (live symlink)
npm run build && npm link        # then `npm link floe-agent` in your project

# npm pack (simulates a real publish — safest validation)
npm run build && npm pack        # creates floe-agent-<version>.tgz
npm pack --dry-run               # should include only dist/, README.md, package.json
```

Project entry points: `src/index.ts` (exports both providers),
`floeActionProvider.ts` (lending), `x402ActionProvider.ts` (x402 +
agent-awareness), `schemas.ts` (Zod input schemas), `cli/` (interactive REPL).

</details>

## Roadmap

Floe ships the spend layer first and builds credit on top of it.

- **Working capital / credit lines** — *in development.*
- **Unsecured / receivables-backed credit** — *in development.* Email hello@floelabs.xyz for the design-partner program.
- **Portable ERC-8004 credit record** — *in development.*

## Links

[Website](https://floelabs.xyz) · [Docs](https://floe-labs.gitbook.io/docs) · [Python SDK](https://github.com/Floe-Labs/agentkit-actions-py) · [MCP server](https://github.com/Floe-Labs/floe-mcp-server) · [Examples](https://github.com/Floe-Labs/floe-cookbook)

## License

MIT
