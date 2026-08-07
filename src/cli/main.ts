/**
 * CLI entrypoint + subcommand dispatcher. Deliberately lightweight: every
 * command module — and above all the REPL, which drags in @coinbase/agentkit
 * and the ai SDK — is loaded through dynamic import() at its dispatch site,
 * so `floe-agent status` / `--help` under npx never pay the REPL's startup cost.
 *
 * Installed as `floe-agent`. The bare `floe` bin belongs to the standalone
 * platform CLI, @floelabs/cli — this package released the name in 0.6.1.
 *
 * Conventions: `--json` on every command; exit codes 0 ok / 1 error /
 * 2 usage / 4 auth required / 5 payment required; no prompts when stdout
 * is not a TTY; NO_COLOR respected.
 */
import { getVersion } from "./version.js";
import { DEFAULT_API_URL, hasFlag, parseFlag, usageError } from "./shared.js";

function printRootHelp(): void {
  console.log("Usage: floe-agent <command> [options]\n");
  console.log("The Floe AgentKit-companion CLI — agent unified billing, x402 payments, spend policy.\n");
  console.log("Setup & status:");
  console.log("  status              Auth check + capabilities + balance snapshot");
  console.log("  auth status|set-key Manage the developer key (env FLOE_API_KEY or OS keychain)");
  console.log("  mcp install         Install the Floe MCP server into your AI tools");
  console.log("  skills install      Install the Floe skill (.claude/skills + ~/.agents/skills)");
  console.log("");
  console.log("Agents & keys (developer key):");
  console.log("  agents create|list|get|pause|resume|close   Agent lifecycle (API)");
  console.log("  agents keys create|rotate|revoke [--budget <usd>]   Runtime keys");
  console.log("  agents              Local registry from .floe-agent.json (alias: list)");
  console.log("  keys create|list|rotate|revoke              Developer (floe_live_) keys");
  console.log("  fund <agentId>      Print deposit address + funding instructions");
  console.log("");
  console.log("Guardrails:");
  console.log("  policy list|set|delete|reset [--agent <id>|--team]");
  console.log("  limit get|set|clear [--agent <id>]          Session spend cap");
  console.log("  allowlist mode|add|remove|list [--agent <id>]");
  console.log("");
  console.log("Spending (agent key):");
  console.log("  pay <url>           x402 call via the paid proxy (exit 5 = payment required)");
  console.log("  estimate <url>      Price one call before paying");
  console.log("  forecast <url>…     Batch cost + policy preflight");
  console.log("  balance             Developer rollup (dev key) or agent balance (agent key)");
  console.log("");
  console.log("Observability:");
  console.log("  models              Inference gateway catalog");
  console.log("  usage               Analytics summary");
  console.log("  activity [--limit n] Unified activity feed");
  console.log("  webhooks create|list|test|rotate-secret|deliveries");
  console.log("");
  console.log("Lending REPL & wallet flows:");
  console.log("  run                 Interactive REPL (default; needs a wallet + AI key)");
  console.log("  register            Wallet-signature agent registration + key mint");
  console.log("  use <name>          Set the active agent");
  console.log("  rotate|revoke <name>  Key rotation (dev key if set, else wallet flow)");
  console.log("  open-credit-line    Open the USDC/USDC credit line for a funded agent");
  console.log("");
  console.log("Common options:");
  console.log("  --json              Raw API JSON on stdout (every command)");
  console.log("  --help, -h          Show help");
  console.log("  --version, -v       Show version");
  console.log("");
  console.log("Environment variables:");
  console.log("  FLOE_API_KEY        floe_live_ dev key (management) or floe_ agent key (payments)");
  console.log("  FLOE_AGENT_KEY      floe_ agent key override for payment commands");
  console.log(`  FLOE_API_URL        Credit API base URL (default ${DEFAULT_API_URL})`);
  console.log("  PRIVATE_KEY         Wallet key — signature auth fallback + REPL/register");
  console.log("  FLOE_FACILITATOR_URL             Default facilitator URL for `register`");
  console.log("  FLOE_AGENT_KEY_<NAME>__<HOST>    Per-agent key (keychain fallback)");
  console.log("  OPENAI_API_KEY / ANTHROPIC_API_KEY / BASE_RPC_URL   REPL only");
  console.log("");
  console.log("Exit codes: 0 ok · 1 error · 2 usage · 4 auth required · 5 payment required (402)");
}

export async function main(args: string[]): Promise<void> {
  if (args.includes("--version") || args.includes("-v")) {
    console.log(getVersion());
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    printRootHelp();
    process.exit(0);
  }

  // Dispatch subcommands. The first arg, if it's a known verb, decides.
  // Everything else falls through to the interactive REPL (default).
  const sub = args[0];
  const rest = args.slice(1);
  const json = hasFlag(args, "json");

  // ── Platform commands (dev-key / agent-key HTTP, all lazy-loaded) ──────
  if (sub === "status") {
    const { runStatusCommand } = await import("./commands/status.js");
    await runStatusCommand(rest);
    return;
  }
  if (sub === "auth") {
    const { runAuthCommand } = await import("./commands/auth.js");
    await runAuthCommand(rest);
    return;
  }
  if (sub === "keys") {
    const { runDevKeysCommand } = await import("./commands/dev-keys.js");
    await runDevKeysCommand(rest);
    return;
  }
  if (sub === "policy") {
    const { runPolicyCommand } = await import("./commands/policy.js");
    await runPolicyCommand(rest);
    return;
  }
  if (sub === "limit") {
    const { runLimitCommand } = await import("./commands/limit.js");
    await runLimitCommand(rest);
    return;
  }
  if (sub === "allowlist") {
    const { runAllowlistCommand } = await import("./commands/allowlist.js");
    await runAllowlistCommand(rest);
    return;
  }
  if (sub === "balance") {
    const { runBalanceCommand } = await import("./commands/balance.js");
    await runBalanceCommand(rest);
    return;
  }
  if (sub === "fund") {
    const { runFundCommand } = await import("./commands/fund.js");
    await runFundCommand(rest);
    return;
  }
  if (sub === "estimate") {
    const { runEstimateCommand } = await import("./commands/x402.js");
    await runEstimateCommand(rest);
    return;
  }
  if (sub === "forecast") {
    const { runForecastCommand } = await import("./commands/x402.js");
    await runForecastCommand(rest);
    return;
  }
  if (sub === "pay") {
    const { runPayCommand } = await import("./commands/pay.js");
    await runPayCommand(rest);
    return;
  }
  if (sub === "models") {
    const { runModelsCommand } = await import("./commands/info.js");
    await runModelsCommand(rest);
    return;
  }
  if (sub === "usage") {
    const { runUsageCommand } = await import("./commands/info.js");
    await runUsageCommand(rest);
    return;
  }
  if (sub === "activity") {
    const { runActivityCommand } = await import("./commands/info.js");
    await runActivityCommand(rest);
    return;
  }
  if (sub === "webhooks") {
    const { runWebhooksCommand } = await import("./commands/webhooks.js");
    await runWebhooksCommand(rest);
    return;
  }
  if (sub === "skills") {
    const { runSkillsCommand } = await import("./commands/skills.js");
    await runSkillsCommand(rest);
    return;
  }
  if (sub === "mcp") {
    const { runMcpCommand } = await import("./commands/mcp.js");
    await runMcpCommand(rest);
    return;
  }

  // ── Agents: API lifecycle verbs vs. the legacy local-registry list ─────
  if (sub === "agents" || sub === "list") {
    const verb = sub === "agents" ? rest[0] : undefined;
    if (verb === "keys") {
      const { runAgentKeysCommand } = await import("./commands/agent-keys.js");
      await runAgentKeysCommand(rest.slice(1));
      return;
    }
    if (verb && ["create", "list", "get", "pause", "resume", "close"].includes(verb)) {
      const { runAgentsApiCommand } = await import("./commands/agents-api.js");
      await runAgentsApiCommand(verb, rest.slice(1));
      return;
    }
    const { runListCommand } = await import("./commands/agents.js");
    await runListCommand(json);
    return;
  }

  // ── Wallet-signature flows (unchanged legacy commands) ─────────────────
  if (sub === "register") {
    const name = parseFlag(rest, "name");
    if (!name) {
      usageError("Usage: floe-agent register --name <name> [--borrow-limit <usd>] [--label <l>]", json);
    }
    const facilitatorUrl =
      parseFlag(rest, "facilitator-url") ||
      process.env.FLOE_FACILITATOR_URL ||
      DEFAULT_API_URL;
    const { runRegisterCommand } = await import("./commands/register.js");
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
  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      usageError("Usage: floe-agent use <agent name>", json);
    }
    const { runUseCommand } = await import("./commands/use.js");
    runUseCommand(name);
    return;
  }
  if (sub === "rotate" || sub === "revoke") {
    const name = rest[0];
    if (!name || name.startsWith("--")) {
      usageError(`Usage: floe-agent ${sub} <agentId|name> [--json]`, json);
    }
    // Dev-key path when headless credentials exist; interactive wallet flow
    // otherwise. (`--facilitator-url` remains an opt-in override for the
    // legacy revoke recovery flow.)
    const { runKeyAlias } = await import("./commands/agent-keys.js");
    await runKeyAlias(sub, name, rest.slice(1));
    return;
  }
  if (sub === "open-credit-line") {
    const name = parseFlag(rest, "name") ?? rest[0];
    if (!name) {
      usageError("Usage: floe-agent open-credit-line --name <name> --deposit <usdc>", json);
    }
    const rawLtv = parseFlag(rest, "max-ltv-bps");
    const rawRate = parseFlag(rest, "max-rate-bps");
    const { runOpenCreditLineCommand } = await import("./commands/open-credit-line.js");
    await runOpenCreditLineCommand({
      name,
      depositUsdc: parseFlag(rest, "deposit"),
      maxLtvBps: rawLtv ? Number(rawLtv) : undefined,
      maxRateBps: rawRate ? Number(rawRate) : undefined,
    });
    return;
  }

  // A stray word is a typo, not a REPL request: an agent that mistypes a
  // verb gets exit 2 and the command list, never an interactive prompt it
  // cannot answer. Bare `floe-agent` and `floe-agent --agent x` still open the REPL.
  if (sub !== undefined && sub !== "run" && !sub.startsWith("-")) {
    usageError(`Unknown command: ${sub}. Run \`floe-agent --help\` for the command list.`, json);
  }

  // Default: interactive REPL. Treat `run` as an explicit alias. The REPL
  // module is where all the heavy deps live — never import it statically.
  const runArgs = sub === "run" ? rest : args;
  const explicitAgent = parseFlag(runArgs, "agent");
  const { runInteractive } = await import("./repl.js");
  await runInteractive(explicitAgent);
}
