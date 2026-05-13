/**
 * OS keychain wrapper for Floe agent API keys.
 *
 * Uses @napi-rs/keyring (native bindings to macOS Keychain, Windows
 * Credential Manager, Linux Secret Service). Falls back to an env var
 * (FLOE_AGENT_KEY_<UPPER_NAME>) when the keyring backend is unavailable
 * — e.g. headless CI without a session keyring. A one-time warning is
 * printed on first fallback so the user knows their secret isn't
 * persisted in the OS store.
 *
 * Account format: `<agentName>@<facilitatorUrl>` — the URL is included
 * so the same agent name against staging vs prod doesn't collide.
 */
import chalk from "chalk";

const SERVICE = "floe-agent";

let warnedFallback = false;

function envVarName(agentName: string): string {
  return `FLOE_AGENT_KEY_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
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
            `    Set ${envVarName("<name>")} to provide the API key for each agent.`,
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
    // We can't write to env vars from here — but we WILL be able to read
    // from FLOE_AGENT_KEY_<NAME>. Tell the user what to do.
    console.warn(
      chalk.yellow(
        `  Keyring unavailable. To use this agent later, export:\n` +
          `    ${envVarName(agentName)}=${apiKey}\n` +
          `  This key will not be shown again.`,
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
  const fromEnv = process.env[envVarName(agentName)];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
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
