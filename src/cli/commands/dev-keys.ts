import chalk from "chalk";
import { DevApiClient, requireDevAuth, runWithErrorHandling } from "../devApiClient.js";
import { hasFlag, isInteractive, parseFlag, positionals, printJson, usageError } from "../shared.js";

/**
 * `floe-agent keys create|list|rotate|revoke` — developer (`floe_live_*`) keys via
 * /v1/developer/keys. Max 5 per account, plaintext shown once, admin-role
 * routes (a bare dev key resolves to owner, so key-only auth passes).
 */
export async function runDevKeysCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const pos = positionals(args);
  const verb = pos[0];
  // Usage errors beat auth errors: validate the invocation before resolving
  // credentials so `floe-agent keys frobnicate` exits 2 with or without a key set.
  if (!verb || !["create", "list", "rotate", "revoke"].includes(verb)) {
    usageError("Usage: floe-agent keys <create|list|rotate|revoke> [keyId] [--label <l>] [--json]", json);
  }
  const keyId = pos[1];
  if ((verb === "rotate" || verb === "revoke") && (!keyId || !/^\d+$/.test(keyId))) {
    usageError(`Usage: floe-agent keys ${verb} <keyId> [--json] (find ids via \`floe-agent keys list\`)`, json);
  }
  await runWithErrorHandling(json, async () => {
    const auth = await requireDevAuth(json);
    const client = new DevApiClient(auth);

    if (verb === "create") {
      const body: Record<string, unknown> = {};
      const label = parseFlag(args, "label");
      if (label) body.label = label;
      const permissions = parseFlag(args, "permissions");
      if (permissions) body.permissions = permissions;
      const minted = (await client.request("POST", "/v1/developer/keys", { body })).body as {
        key: string;
        keyPrefix: string;
        id: number;
      };
      if (json) {
        printJson(minted);
        return;
      }
      console.log("");
      console.log(
        `  ${chalk.bold("Developer Key:")} ${chalk.yellow(minted.key)}  ${chalk.dim("(shown ONCE)")}`,
      );
      console.log(chalk.dim("  Save it with `floe-agent auth set-key <key>` or export FLOE_API_KEY."));
      if (permissions === "read") {
        // The API enforces this now (403 read_only_key on any write verb).
        console.log(chalk.dim("  Read-only key: GET/HEAD/OPTIONS only — writes are refused."));
      }
      console.log("");
      return;
    }

    if (verb === "list") {
      const res = (await client.request("GET", "/v1/developer/keys")).body as {
        keys?: Array<{ id: number; keyPrefix: string; label: string | null; lastUsedAt: string | null }>;
      };
      if (json) {
        printJson(res);
        return;
      }
      const keys = res.keys ?? [];
      if (keys.length === 0) {
        console.log(chalk.dim("No developer keys. Mint one with `floe-agent keys create`."));
        return;
      }
      console.log("");
      for (const k of keys) {
        console.log(
          `  ${chalk.bold(k.keyPrefix)}…  ${chalk.dim(`(id=${k.id}${k.label ? `, ${k.label}` : ""}, last used ${k.lastUsedAt ?? "never"})`)}`,
        );
      }
      console.log("");
      return;
    }

    if (verb === "rotate" || verb === "revoke") {
      if (verb === "rotate") {
        const rotated = (
          await client.request("POST", `/v1/developer/keys/${keyId}/rotate`, { body: {} })
        ).body as { key: string; keyPrefix: string };
        if (json) {
          printJson(rotated);
          return;
        }
        console.log("");
        console.log(
          `  ${chalk.bold("New Developer Key:")} ${chalk.yellow(rotated.key)}  ${chalk.dim("(shown ONCE)")}`,
        );
        console.log("");
        return;
      }
      // Revoking a developer key is irreversible (and revoking your only one
      // locks you out) — confirm interactively, like the agent-key flow.
      if (isInteractive() && !json) {
        const { confirm } = await import("@inquirer/prompts");
        const ok = await confirm({
          message: `Revoke developer key ${keyId}? This cannot be undone.`,
          default: false,
        });
        if (!ok) {
          console.log(chalk.dim("Aborted."));
          return;
        }
      }
      await client.request("DELETE", `/v1/developer/keys/${keyId}`);
      if (json) printJson({ revoked: true, keyId: Number(keyId) });
      else console.log(chalk.green(`  Developer key ${keyId} revoked.`));
    }
  });
}
