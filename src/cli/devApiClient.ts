/**
 * Credential resolution + HTTP client for the platform CLI commands.
 *
 * Two credential planes, resolved independently:
 *
 * Management (`/v1/developer/*`) — resolveDevAuth(), in order:
 *   1. `FLOE_API_KEY` env, but only when it holds a `floe_live_` developer
 *      key. A `floe_` agent key in that variable is a RUNTIME credential:
 *      the API 403s it on the whole /v1/developer surface, so it is routed
 *      to the payment plane below instead of producing a confusing 403.
 *   2. The dev key stored in the OS keychain by `floe auth set-key`.
 *   3. EIP-191 wallet-signature headers when `PRIVATE_KEY` is set — the
 *      key-less bootstrap path (same message format as signatureAuth.ts,
 *      but signed directly with viem so no AgentKit wallet provider is
 *      loaded for management commands).
 *   None of the above → exit 4 with a pointer to the dashboard.
 *
 * Payment (`/v1/agents/*`, `/v1/proxy/*`, `/v1/x402/*`) — resolveAgentAuth():
 *   1. `FLOE_AGENT_KEY` env.
 *   2. The active agent's keychain key (`.floe-agent.json` registry).
 *   3. `FLOE_API_KEY` when it is a `floe_` agent key (not `floe_live_`).
 *
 * Every request carries `User-Agent: floe-cli/<version>` — the server uses
 * it to detect AI-tool-driven onboarding.
 */
import chalk from "chalk";
import { getVersion } from "./version.js";
import { getDevKey, getAgentKey } from "./keychain.js";
import { loadConfig, getAgent, listAgents, type AgentRecord } from "./config.js";
import {
  apiBaseUrl,
  DASHBOARD_URL,
  EXIT_AUTH_REQUIRED,
  EXIT_ERROR,
  exitForStatus,
  printJson,
} from "./shared.js";

const MESSAGE_PREFIX = "Floe Credit API\nTimestamp: ";
const FETCH_TIMEOUT_MS = 30_000;

export type AuthSource =
  | "env" // FLOE_API_KEY
  | "keychain" // dev key stored by `floe auth set-key`
  | "wallet" // PRIVATE_KEY wallet-signature headers
  | "agent-env" // FLOE_AGENT_KEY
  | "agent-keychain"; // active agent's key from the OS keychain

export interface ResolvedAuth {
  source: AuthSource;
  /** Display-safe key prefix (never the full key); undefined for wallet sig. */
  keyPrefix?: string;
  /** Fresh headers per request — wallet signatures embed a timestamp. */
  headers(): Promise<Record<string, string>>;
}

export function classifyKey(key: string): "developer" | "agent" | null {
  if (key.startsWith("floe_live_")) return "developer";
  if (key.startsWith("floe_")) return "agent";
  return null;
}

function displayPrefix(key: string): string {
  return `${key.slice(0, key.startsWith("floe_live_") ? 14 : 9)}…`;
}

function bearerAuth(key: string, source: AuthSource): ResolvedAuth {
  return {
    source,
    keyPrefix: displayPrefix(key),
    headers: async () => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    }),
  };
}

function walletAuth(privateKey: string): ResolvedAuth {
  return {
    source: "wallet",
    headers: async () => {
      // Lazy viem import — only the wallet-signature fallback pays for it.
      const { privateKeyToAccount } = await import("viem/accounts");
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = await account.signMessage({
        message: `${MESSAGE_PREFIX}${timestamp}`,
      });
      return {
        "X-Wallet-Address": account.address,
        "X-Signature": signature,
        "X-Timestamp": timestamp,
        "Content-Type": "application/json",
      };
    },
  };
}

export async function resolveDevAuth(): Promise<ResolvedAuth | null> {
  const envKey = process.env.FLOE_API_KEY?.trim();
  if (envKey && classifyKey(envKey) === "developer") return bearerAuth(envKey, "env");
  const stored = await getDevKey(apiBaseUrl());
  if (stored && classifyKey(stored) === "developer") return bearerAuth(stored, "keychain");
  const pk = process.env.PRIVATE_KEY?.trim();
  if (pk) return walletAuth(pk);
  return null;
}

/** The local registry record payment commands should default to. */
export function activeAgentRecord(): AgentRecord | undefined {
  const config = loadConfig();
  if (!config?.agents) return undefined;
  if (config.activeAgent) return getAgent(config, config.activeAgent);
  const all = listAgents(config);
  return all.length === 1 ? all[0] : undefined;
}

export interface AgentAuth {
  auth: ResolvedAuth;
  /** Where the credential is valid — the agent's facilitator for keychain keys. */
  baseUrl: string;
}

export async function resolveAgentAuth(): Promise<AgentAuth | null> {
  const override = process.env.FLOE_AGENT_KEY?.trim();
  if (override && classifyKey(override) === "agent") {
    return { auth: bearerAuth(override, "agent-env"), baseUrl: apiBaseUrl() };
  }
  const record = activeAgentRecord();
  if (record && !record.revoked) {
    const key = await getAgentKey(record.name, record.facilitatorUrl);
    if (key) {
      // FLOE_API_URL still wins as an explicit override; otherwise the key
      // is only valid against the facilitator it was minted on.
      const baseUrl = process.env.FLOE_API_URL?.trim()
        ? apiBaseUrl()
        : record.facilitatorUrl.replace(/\/+$/, "");
      return { auth: bearerAuth(key, "agent-keychain"), baseUrl };
    }
  }
  const envKey = process.env.FLOE_API_KEY?.trim();
  if (envKey && classifyKey(envKey) === "agent") {
    return { auth: bearerAuth(envKey, "env"), baseUrl: apiBaseUrl() };
  }
  return null;
}

/** Print the exit-4 "auth required" message and exit. */
export function authRequired(json: boolean, kind: "developer" | "agent"): never {
  // A `floe_` key in FLOE_API_KEY is the common near-miss on the developer
  // plane — name it instead of claiming nothing was set.
  const envIsAgentKey =
    classifyKey(process.env.FLOE_API_KEY?.trim() ?? "") === "agent";
  const message =
    kind === "developer"
      ? (envIsAgentKey
          ? "FLOE_API_KEY holds an agent key (floe_…), which cannot call developer routes. "
          : "No developer credentials found. ") +
        "Set FLOE_API_KEY to a floe_live_… developer key, run `floe auth set-key`, " +
        "or set PRIVATE_KEY for wallet-signature auth."
      : "No agent credentials found. Set FLOE_AGENT_KEY (floe_… agent key), " +
        "mint one with `floe agents keys create <agent>`, or set FLOE_API_KEY " +
        "to a floe_ agent key.";
  const hint = `Get a developer key at ${DASHBOARD_URL}`;
  if (json) {
    printJson({ error: "auth_required", message, hint });
  } else {
    console.error(chalk.red(message));
    console.error(chalk.dim(`  ${hint}`));
  }
  process.exit(EXIT_AUTH_REQUIRED);
}

export async function requireDevAuth(json: boolean): Promise<ResolvedAuth> {
  const auth = await resolveDevAuth();
  if (!auth) authRequired(json, "developer");
  return auth;
}

export async function requireAgentAuth(json: boolean): Promise<AgentAuth> {
  const auth = await resolveAgentAuth();
  if (!auth) authRequired(json, "agent");
  return auth;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as { detail?: string; message?: string; error?: string };
  return b.detail || b.message || b.error;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export class DevApiClient {
  constructor(
    private readonly auth: ResolvedAuth,
    private readonly baseUrl: string = apiBaseUrl(),
  ) {}

  /**
   * One HTTP round-trip. Non-2xx throws ApiError unless `expectError` is
   * set (callers that branch on status — capability probes, 402 handling —
   * opt in to inspecting the response themselves).
   */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      expectError?: boolean;
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      ...(await this.auth.headers()),
      "User-Agent": `floe-cli/${getVersion()}`,
      ...(opts.headers ?? {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok && !opts.expectError) {
      throw new ApiError(res.status, extractMessage(parsed) ?? res.statusText, parsed);
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }
}

/**
 * Uniform error boundary for the new subcommands: ApiError maps onto the
 * exit-code contract (401/403 → 4, 402 → 5, else 1) and is machine-readable
 * under --json; everything else is a plain exit-1 error.
 */
export async function runWithErrorHandling(
  json: boolean,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      if (json) {
        printJson({ error: "api_error", status: err.status, message: err.message, body: err.body });
      } else {
        console.error(chalk.red(`API error ${err.status}: ${err.message}`));
      }
      process.exit(exitForStatus(err.status));
    }
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      printJson({ error: "error", message });
    } else {
      console.error(chalk.red(message));
    }
    process.exit(EXIT_ERROR);
  }
}
