import chalk from "chalk";
import {
  DevApiClient,
  resolveDevAuth,
  resolveAgentAuth,
  authRequired,
  classifyKey,
  runWithErrorHandling,
} from "../devApiClient.js";
import { setDevKey } from "../keychain.js";
import {
  apiBaseUrl,
  hasFlag,
  isInteractive,
  positionals,
  printJson,
  usageError,
  EXIT_ERROR,
} from "../shared.js";

const USAGE = "Usage: floe auth <status|set-key> [key] [--json]";

export async function runAuthCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const [verb, ...rest] = positionals(args);
  if (verb === "status") {
    await runAuthStatus(json);
    return;
  }
  if (verb === "set-key") {
    await runSetKey(rest[0], json);
    return;
  }
  usageError(USAGE, json);
}

/**
 * `floe auth status` — report which credential each plane would use and
 * verify the developer one against the API. Exit 4 when nothing resolves.
 */
async function runAuthStatus(json: boolean): Promise<void> {
  await runWithErrorHandling(json, async () => {
    const dev = await resolveDevAuth();
    const agent = await resolveAgentAuth();
    if (!dev && !agent) authRequired(json, "developer");

    let verified = false;
    let verifyError: string | null = null;
    if (dev) {
      try {
        await new DevApiClient(dev).request("GET", "/v1/developer/profile");
        verified = true;
      } catch (err) {
        verifyError = err instanceof Error ? err.message : String(err);
      }
    }

    if (json) {
      printJson({
        apiUrl: apiBaseUrl(),
        developer: dev
          ? { source: dev.source, keyPrefix: dev.keyPrefix ?? null, verified, error: verifyError }
          : null,
        agent: agent
          ? { source: agent.auth.source, keyPrefix: agent.auth.keyPrefix ?? null, baseUrl: agent.baseUrl }
          : null,
      });
      return;
    }

    console.log("");
    console.log(`  ${chalk.bold("API:")}        ${apiBaseUrl()}`);
    if (dev) {
      const check = verified ? chalk.green("verified") : chalk.red(`FAILED (${verifyError})`);
      console.log(
        `  ${chalk.bold("Developer:")}  ${dev.source}${dev.keyPrefix ? ` (${dev.keyPrefix})` : ""} — ${check}`,
      );
    } else {
      console.log(`  ${chalk.bold("Developer:")}  ${chalk.dim("none")}`);
    }
    if (agent) {
      console.log(
        `  ${chalk.bold("Agent:")}      ${agent.auth.source}${agent.auth.keyPrefix ? ` (${agent.auth.keyPrefix})` : ""}`,
      );
    } else {
      console.log(`  ${chalk.bold("Agent:")}      ${chalk.dim("none")}`);
    }
    console.log("");
    if (dev && !verified) process.exit(EXIT_ERROR);
  });
}

/**
 * `floe auth set-key [key]` — persist a developer key in the OS keychain,
 * scoped to the active API host. Prompts only in an interactive session.
 */
async function runSetKey(keyArg: string | undefined, json: boolean): Promise<void> {
  await runWithErrorHandling(json, async () => {
    let key = keyArg?.trim();
    if (!key) {
      if (!isInteractive() || json) {
        usageError("Usage: floe auth set-key <floe_live_...> (no TTY — pass the key as an argument)", json);
      }
      const { password } = await import("@inquirer/prompts");
      key = (await password({ message: "Developer API key (floe_live_...):" })).trim();
    }
    // Only a developer key belongs in this slot: the API refuses agent keys
    // on the whole /v1/developer surface, so storing one would fail on the
    // very next management command. Agent keys have their own env var.
    if (classifyKey(key) !== "developer") {
      usageError(
        "Expected a developer key (floe_live_…). Agent keys (floe_…) are runtime " +
          "credentials — export FLOE_AGENT_KEY=<key> instead.",
        json,
      );
    }

    // Verify before storing — a typo'd key caught here beats one caught on
    // the next `floe agents create`.
    const client = new DevApiClient({
      source: "keychain",
      headers: async () => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    });
    await client.request("GET", "/v1/developer/profile");

    const stored = await setDevKey(apiBaseUrl(), key);
    if (stored.stored === "unavailable") {
      throw new Error(
        "OS keychain unavailable — export FLOE_API_KEY instead (the env var takes precedence anyway).",
      );
    }
    if (json) {
      printJson({ stored: "keychain", apiUrl: apiBaseUrl() });
    } else {
      console.log(chalk.green(`  Developer key verified and saved to the OS keychain (${apiBaseUrl()}).`));
    }
  });
}
