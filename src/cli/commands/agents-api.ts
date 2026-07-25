import chalk from "chalk";
import {
  DevApiClient,
  requireDevAuth,
  runWithErrorHandling,
} from "../devApiClient.js";
import {
  DASHBOARD_URL,
  hasFlag,
  isInteractive,
  parseFlag,
  positionals,
  printJson,
  usageError,
  usdToRawArg,
} from "../shared.js";

/**
 * `floe agents create|list|get|pause|resume|close` — the dev-key-backed
 * lifecycle commands against /v1/developer/agents. Unlike `floe register`
 * (wallet-signature flow that also mints a key and writes the local
 * registry), these are thin API calls an agent can run headlessly with
 * only FLOE_API_KEY set. Key minting lives in `floe agents keys …`.
 */
export async function runAgentsApiCommand(verb: string, args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  // Usage errors beat auth errors: validate the invocation before resolving
  // credentials so a malformed call exits 2 with or without a key set.
  const name = parseFlag(args, "name") ?? positionals(args)[0];
  if (verb === "create" && !name) {
    usageError("Usage: floe agents create --name <name> [--borrow-limit <usd>] [--json]", json);
  }
  const agentId = positionals(args)[0];
  if (["get", "pause", "resume", "close"].includes(verb) && !agentId) {
    usageError(`Usage: floe agents ${verb} <agentId> [--json]`, json);
  }
  await runWithErrorHandling(json, async () => {
    const auth = await requireDevAuth(json);
    const client = new DevApiClient(auth);

    if (verb === "create") {
      const body: Record<string, unknown> = {
        name,
        // Server defaults: omitted borrowLimitRaw → wallet-funded (PAYG).
        maxRateBps: Number(parseFlag(args, "max-rate-bps") ?? 1500),
        expirySeconds: Number(parseFlag(args, "expiry-days") ?? 90) * 86400,
      };
      const borrowLimit = parseFlag(args, "borrow-limit");
      if (borrowLimit) body.borrowLimitRaw = usdToRawArg(borrowLimit, "--borrow-limit", json);

      const spinner = await maybeSpinner(json, `Creating agent "${name}"...`);
      let created: {
        agentId?: number;
        privyWalletAddress?: string;
        status?: string;
        welcomeCreditTxHash?: string;
      };
      try {
        created = (await client.request("POST", "/v1/developer/agents", { body })).body as typeof created;
        spinner?.succeed(`Agent "${name}" created (id=${created.agentId}, status=${created.status})`);
      } catch (err) {
        spinner?.fail("Agent creation failed");
        throw err;
      }
      if (json) {
        printJson(created);
        return;
      }
      console.log("");
      console.log(`  ${chalk.bold("Agent ID:")}         ${created.agentId}`);
      console.log(`  ${chalk.bold("Deposit address:")}  ${created.privyWalletAddress}`);
      console.log("");
      // The welcome-credit amount lives in the API (and has already moved
      // once), so state the fact, not a number the CLI can't verify;
      // `floe balance` prints the amount that actually landed.
      if (created.welcomeCreditTxHash) {
        console.log(
          chalk.dim("  A welcome credit was auto-disbursed — it is immediately spendable."),
        );
      }
      console.log(chalk.dim(`  Mint a runtime key next: floe agents keys create ${created.agentId} --budget 5`));
      console.log(chalk.dim(`  Fund beyond the welcome credit at ${DASHBOARD_URL} (USDC on Base, chain 8453).`));
      console.log("");
      return;
    }

    if (verb === "list") {
      const res = (await client.request("GET", "/v1/developer/agents")).body as
        | { agents?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>;
      const agents = Array.isArray(res) ? res : (res.agents ?? []);
      if (json) {
        printJson(res);
        return;
      }
      if (agents.length === 0) {
        console.log(chalk.dim("No agents. Create one with `floe agents create --name <name>`."));
        return;
      }
      console.log("");
      for (const a of agents) {
        const id = a.id ?? a.agentId;
        console.log(
          `  ${chalk.bold(String(a.name ?? "(unnamed)"))}  ${chalk.dim(`(id=${id}, status=${a.status})`)}`,
        );
        if (a.privyWalletAddress) {
          console.log(`    ${chalk.dim(`deposit: ${a.privyWalletAddress}`)}`);
        }
      }
      console.log("");
      return;
    }

    // get | pause | resume | close all address one agent by id.
    if (verb === "get") {
      const res = (await client.request("GET", `/v1/developer/agents/${agentId}`)).body;
      printJson(res); // detail is deeply nested — JSON is the readable form either way
      return;
    }
    if (verb === "pause" || verb === "resume") {
      const status = verb === "pause" ? "suspended" : "active";
      const res = (
        await client.request("PATCH", `/v1/developer/agents/${agentId}/status`, {
          body: { status },
        })
      ).body as { id?: number; status?: string };
      if (json) printJson(res);
      else console.log(chalk.green(`  Agent ${agentId} is now ${res.status}.`));
      return;
    }
    if (verb === "close") {
      const res = (await client.request("POST", `/v1/developer/agents/${agentId}/close`)).body;
      if (json) printJson(res);
      else console.log(chalk.green(`  Agent ${agentId} closed: ${JSON.stringify(res)}`));
      return;
    }
    usageError("Usage: floe agents <create|list|get|pause|resume|close|keys> …", json);
  });
}

/** Ora spinner in interactive human mode only — never under --json / pipes. */
async function maybeSpinner(json: boolean, text: string) {
  if (json || !isInteractive()) return null;
  const { default: ora } = await import("ora");
  return ora(text).start();
}
