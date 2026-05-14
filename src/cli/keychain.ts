/**
 * OS keychain wrapper for Floe agent API keys.
 *
 * Uses @napi-rs/keyring (native bindings to macOS Keychain, Windows
 * Credential Manager, Linux Secret Service). Falls back to env vars
 * when the keyring backend is unavailable — e.g. headless CI without a
 * session keyring. A one-time warning is printed on first fallback so
 * the user knows their secret isn't persisted in the OS store.
 *
 * Keychain account format: `<agentName>@<facilitatorUrl>` — the URL is
 * included so the same agent name against staging vs prod doesn't collide.
 *
 * Env-var fallback name:
 *   - Primary:  `FLOE_AGENT_KEY_<NAME>__<HOST>` (scoped per facilitator)
 *   - Fallback: `FLOE_AGENT_KEY_<NAME>`        (legacy, pre-v0.4.1)
 *
 * `getAgentKey` reads the scoped name first and falls back to the legacy
 * name so users with `FLOE_AGENT_KEY_ALPHA` already exported keep working.
 * The same agent name across two facilitators (staging vs prod) can now
 * carry distinct credentials without collision via the host suffix.
 */
import chalk from "chalk";

const SERVICE = "floe-agent";

let warnedFallback = false;

function normalizeForEnv(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function legacyEnvVarName(agentName: string): string {
  return `FLOE_AGENT_KEY_${normalizeForEnv(agentName)}`;
}

function scopedEnvVarName(agentName: string, facilitatorUrl: string): string {
  let host: string | null = null;
  try {
    host = new URL(facilitatorUrl).host;
  } catch {
    // Bad URL — fall back to legacy unscoped form so we don't generate
    // garbage env var names. getAgentKey/setAgentKey will still work; it
    // just degrades to the pre-scoping behavior.
  }
  if (!host) return legacyEnvVarName(agentName);
  return `FLOE_AGENT_KEY_${normalizeForEnv(agentName)}__${normalizeForEnv(host)}`;
}

function buildAccount(agentName: string, facilitatorUrl: string): string {
  return `${agentName}@${facilitatorUrl}`;
}

interface EntryLike {
  getPassword(): string | null;
  setPassword(p: string): void;
  deletePassword(): boolean;
}

// Lazy import keeps the module loadable in environments where the
// native binding fails to resolve (we'll surface the fallback path).
async function tryLoadKeyring(): Promise<((s: string, a: string) => EntryLike) | null> {
  try {
    const mod = await import("@napi-rs/keyring");
    // The package exports `Entry` as a class with (service, account)
    // constructor. Wrap so callers don't have to know the shape.
    return (service: string, account: string) =>
      new (mod as unknown as { Entry: new (s: string, a: string) => EntryLike }).Entry(service, account);
  } catch (err) {
    if (!warnedFallback) {
      console.warn(
        chalk.yellow(
          "  Warning: @napi-rs/keyring native binding unavailable; falling back to env vars.\n" +
            `    Set ${scopedEnvVarName("<name>", "https://<facilitator>")} to provide the API key for each agent.`,
        ),
      );
      console.warn(chalk.dim(`    (${(err as Error).message?.slice(0, 120)})`));
      warnedFallback = true;
    }
    return null;
  }
}

export async function setAgentKey(
  agentName: string,
  facilitatorUrl: string,
  apiKey: string,
): Promise<{ stored: "keychain" | "env-fallback" }> {
  const make = await tryLoadKeyring();
  if (!make) {
    // Don't print the raw API key here — the caller (register / rotate)
    // is responsible for showing it once on stdout. Including the key in
    // a copy-pasteable `export …=<key>` line lands it in shell history
    // and CI logs, which violates the "shown once, captured manually"
    // contract. Instead, point the user at the env var with a placeholder
    // and reference the key already printed by the caller.
    const envName = scopedEnvVarName(agentName, facilitatorUrl);
    console.warn(
      chalk.yellow(
        `  Keyring unavailable. To load this agent on next run, export:\n` +
          `    export ${envName}="<paste the API key shown above>"\n` +
          `  (The key is printed once by the register/rotate command — capture it from there.)`,
      ),
    );
    return { stored: "env-fallback" };
  }
  const entry = make(SERVICE, buildAccount(agentName, facilitatorUrl));
  entry.setPassword(apiKey);
  return { stored: "keychain" };
}

export async function getAgentKey(
  agentName: string,
  facilitatorUrl: string,
): Promise<string | null> {
  // Try the scoped env var first (FLOE_AGENT_KEY_<NAME>__<HOST>), then
  // fall back to the legacy unscoped name (FLOE_AGENT_KEY_<NAME>) so
  // pre-v0.4.1 exports keep working.
  const scoped = process.env[scopedEnvVarName(agentName, facilitatorUrl)];
  if (scoped && scoped.trim().length > 0) return scoped.trim();
  const legacy = process.env[legacyEnvVarName(agentName)];
  if (legacy && legacy.trim().length > 0) return legacy.trim();

  const make = await tryLoadKeyring();
  if (!make) return null;
  try {
    return make(SERVICE, buildAccount(agentName, facilitatorUrl)).getPassword();
  } catch {
    return null;
  }
}

export async function deleteAgentKey(
  agentName: string,
  facilitatorUrl: string,
): Promise<boolean> {
  const make = await tryLoadKeyring();
  if (!make) return false;
  try {
    return make(SERVICE, buildAccount(agentName, facilitatorUrl)).deletePassword();
  } catch {
    return false;
  }
}

/**
 * Returns the env-var name the CLI would use as a keychain fallback for
 * this agent. Exported so commands (register, rotate) can surface it in
 * user-facing instructions when the keychain write actually fails.
 */
export function envVarNameFor(agentName: string, facilitatorUrl: string): string {
  return scopedEnvVarName(agentName, facilitatorUrl);
}
