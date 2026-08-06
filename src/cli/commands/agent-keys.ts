import chalk from "chalk";
import {
  DevApiClient,
  requireDevAuth,
  resolveDevAuth,
  authRequired,
  runWithErrorHandling,
} from "../devApiClient.js";
import { loadConfig, saveConfig, getAgent, listAgents, upsertAgent, type AgentRecord } from "../config.js";
import { setAgentKey, deleteAgentKey, envVarNameFor } from "../keychain.js";
import {
  apiBaseUrl,
  hasFlag,
  isInteractive,
  parseFlag,
  positionals,
  positiveIntArg,
  printJson,
  usageError,
  usdToRawArg,
} from "../shared.js";

/**
 * `floe-agent agents keys create|rotate|revoke <agent>` — the generalized,
 * dev-key-first version of the wallet-signature `rotate`/`revoke` flow.
 * <agent> is a numeric agentId or a local-registry name; when a local
 * record matches we keep it (and the OS keychain) in sync exactly like
 * the legacy commands did.
 *
 * Top-level `floe-agent rotate|revoke <name>` route here when headless
 * credentials exist, and fall back to the interactive wallet flow
 * (commands/rotate.ts / revoke.ts) otherwise — see main.ts.
 */

interface KeyRow {
  id: number;
  keyPrefix: string;
  label: string | null;
}

interface TargetAgent {
  agentId: number;
  record?: AgentRecord;
}

function resolveTarget(nameOrId: string): TargetAgent {
  const config = loadConfig();
  if (/^\d+$/.test(nameOrId)) {
    const agentId = Number(nameOrId);
    const record = config
      ? listAgents(config).find((a) => a.agentId === agentId)
      : undefined;
    return { agentId, record };
  }
  const record = config ? getAgent(config, nameOrId) : undefined;
  if (!record) {
    throw new Error(
      `Unknown agent "${nameOrId}". Pass a numeric agentId (see \`floe-agent agents list\`) ` +
        `or a name from the local registry (\`floe-agent agents\`).`,
    );
  }
  return { agentId: record.agentId, record };
}

/**
 * Persist a freshly minted key: local registry + keychain when we track the
 * agent. Returns whether the key landed in the keychain, so the caller can
 * fall back to the env-var instruction exactly like the legacy flow does.
 */
async function storeMintedKey(
  target: TargetAgent,
  key: string,
  keyPrefix: string,
  json: boolean,
): Promise<boolean> {
  if (!target.record) return false;
  const config = loadConfig();
  if (config) {
    upsertAgent(config, { ...target.record, keyPrefix, revoked: false });
    saveConfig(config);
  }
  try {
    await setAgentKey(target.record.name, target.record.facilitatorUrl, key);
    return true;
  } catch (err) {
    if (!json) {
      console.warn(
        chalk.yellow(
          `  Keychain write failed: ${(err as Error).message}. ` +
            `Capture the key shown below — it won't be regenerated.`,
        ),
      );
    }
    return false;
  }
}

/** "stored in the keychain" vs. "export this env var instead" — legacy parity. */
function printKeyStorageNote(target: TargetAgent, storedInKeychain: boolean): void {
  if (!target.record) return;
  if (storedInKeychain) {
    console.log(chalk.dim("  Stored in the OS keychain for this agent."));
    return;
  }
  console.log(
    chalk.dim(
      `  Export ${envVarNameFor(target.record.name, target.record.facilitatorUrl)} to load this key on next run.`,
    ),
  );
}

async function findCurrentKey(
  client: DevApiClient,
  target: TargetAgent,
  keyIdFlag: string | undefined,
): Promise<KeyRow> {
  if (keyIdFlag) {
    if (!/^\d+$/.test(keyIdFlag)) throw new Error("--key-id must be numeric.");
    return { id: Number(keyIdFlag), keyPrefix: "", label: null };
  }
  const res = (await client.request("GET", `/v1/developer/agents/${target.agentId}/keys`)).body as {
    keys: KeyRow[];
  };
  const keys = res.keys ?? [];
  // Prefer the key matching the locally tracked prefix; fall back to keys[0]
  // so the cap-of-1 case works even when local state drifted (same rule as
  // the legacy rotate/revoke flow).
  const current =
    (target.record?.keyPrefix
      ? keys.find((k) => k.keyPrefix === target.record?.keyPrefix)
      : undefined) ?? keys[0];
  if (!current) {
    throw new Error("No active key found for this agent. Mint one with `floe-agent agents keys create`.");
  }
  return current;
}

export async function runAgentKeysCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const pos = positionals(args);
  const verb = pos[0];
  const nameOrId = pos[1];
  if (!verb || !["create", "rotate", "revoke"].includes(verb) || !nameOrId) {
    usageError(
      "Usage: floe-agent agents keys <create|rotate|revoke> <agentId|name> [--budget <usd>] [--label <l>] [--key-id <id>] [--json]",
      json,
    );
  }
  await runWithErrorHandling(json, async () => {
    const auth = await requireDevAuth(json);
    const target = resolveTarget(nameOrId);
    // Like the legacy rotate/revoke flow, a locally tracked agent's
    // persisted facilitatorUrl is the authoritative API host — the key
    // only exists on the facilitator it was minted on. FLOE_API_URL
    // remains an explicit override; untracked numeric ids use the default.
    const baseUrl = process.env.FLOE_API_URL?.trim()
      ? apiBaseUrl()
      : (target.record?.facilitatorUrl.replace(/\/+$/, "") ?? apiBaseUrl());
    const client = new DevApiClient(auth, baseUrl);

    if (verb === "create") {
      const body: Record<string, unknown> = {
        label: parseFlag(args, "label") ?? target.record?.name ?? `key-${Date.now()}`,
      };
      const budget = parseFlag(args, "budget");
      if (budget) body.budgetRaw = usdToRawArg(budget, "--budget", json);
      if (hasFlag(args, "window-seconds")) {
        body.windowSeconds = positiveIntArg(
          parseFlag(args, "window-seconds") ?? "",
          "--window-seconds",
          json,
        );
      }

      const minted = (
        await client.request("POST", `/v1/developer/agents/${target.agentId}/keys`, { body })
      ).body as { key: string; keyPrefix: string; id: number };
      const mintedStored = await storeMintedKey(target, minted.key, minted.keyPrefix, json);
      if (json) {
        printJson(minted);
        return;
      }
      console.log("");
      console.log(
        `  ${chalk.bold("API Key:")} ${chalk.yellow(minted.key)}  ${chalk.dim("(shown ONCE)")}`,
      );
      if (budget) console.log(chalk.dim(`  Per-key budget: $${budget}`));
      printKeyStorageNote(target, mintedStored);
      console.log("");
      return;
    }

    if (verb === "rotate") {
      const current = await findCurrentKey(client, target, parseFlag(args, "key-id"));
      const rotated = (
        await client.request(
          "POST",
          `/v1/developer/agents/${target.agentId}/keys/${current.id}/rotate`,
          { body: {} },
        )
      ).body as { key: string; keyPrefix: string; id: number };
      const rotatedStored = await storeMintedKey(target, rotated.key, rotated.keyPrefix, json);
      if (json) {
        printJson(rotated);
        return;
      }
      console.log("");
      console.log(
        `  ${chalk.bold("New API Key:")} ${chalk.yellow(rotated.key)}  ${chalk.dim("(shown ONCE)")}`,
      );
      console.log(
        chalk.dim(`  Rotated (old: ${current.keyPrefix || "?"}, new: ${rotated.keyPrefix}).`),
      );
      printKeyStorageNote(target, rotatedStored);
      console.log("");
      return;
    }

    // revoke
    const current = await findCurrentKey(client, target, parseFlag(args, "key-id"));
    await client.request("DELETE", `/v1/developer/agents/${target.agentId}/keys/${current.id}`);
    if (target.record) {
      await deleteAgentKey(target.record.name, target.record.facilitatorUrl);
      const config = loadConfig();
      if (config) {
        const rec = getAgent(config, target.record.name);
        if (rec) {
          rec.revoked = true;
          saveConfig(config);
        }
      }
    }
    if (json) {
      printJson({ revoked: true, agentId: target.agentId, keyId: current.id });
    } else {
      console.log(chalk.green(`  Revoked key ${current.keyPrefix || current.id} for agent ${target.agentId}.`));
    }
  });
}

/**
 * Top-level `floe-agent rotate|revoke <name>` alias: dev-key/PRIVATE_KEY path when
 * headless credentials exist, interactive wallet flow otherwise (unchanged
 * legacy behavior — prompts for the wallet and signs the management call).
 */
export async function runKeyAlias(verb: "rotate" | "revoke", name: string, args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const auth = await resolveDevAuth();
  if (auth) {
    // Preserve the legacy revoke confirmation at this entrypoint: revoking
    // is irreversible, and pre-0.6.0 `floe-agent revoke` always asked.
    // Headless (non-TTY / --json) invocations stay prompt-free per contract.
    if (verb === "revoke" && isInteractive() && !json) {
      const { confirm } = await import("@inquirer/prompts");
      const ok = await confirm({
        message: `Revoke API key for "${name}"? This cannot be undone.`,
        default: false,
      });
      if (!ok) {
        console.log(chalk.dim("Aborted."));
        return;
      }
    }
    await runAgentKeysCommand([verb, name, ...args]);
    return;
  }
  if (isInteractive() && !json) {
    if (verb === "rotate") {
      const { runRotateCommand } = await import("./rotate.js");
      await runRotateCommand(name);
    } else {
      const { runRevokeCommand } = await import("./revoke.js");
      await runRevokeCommand(name, parseFlag(args, "facilitator-url"));
    }
    return;
  }
  authRequired(json, "developer");
}
