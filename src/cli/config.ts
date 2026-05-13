import * as fs from "fs";
import * as path from "path";

// .floe-agent.json uses camelCase keys (the same on-disk format as
// the Python SDK after its translation layer), so a single config
// file is interchangeable between agentkit-actions (TS) and
// agentkit-actions-py. JSON.parse/JSON.stringify preserve unknown
// keys verbatim, which keeps forward-compat fields safe across
// CLI versions.

/**
 * Registered agent metadata. The API key itself lives in the OS
 * keychain (or env-var fallback), never in this file.
 */
export interface AgentRecord {
  agentId: number;
  name: string;
  facilitatorUrl: string;
  privyWalletAddress: string;
  keyPrefix: string;
  createdAt: string;
  revoked?: boolean;
}

export interface FloeAgentConfig {
  walletType: "private-key" | "cdp";
  aiProvider: "openai" | "claude" | "ollama";
  aiModel?: string;
  ollamaBaseUrl?: string;
  rpcUrl?: string;
  /** v0.4: per-developer agent registry. Keyed by `name`. */
  agents?: Record<string, AgentRecord>;
  /** v0.4: name of the agent loaded by default when `floe-agent run` runs without --agent. */
  activeAgent?: string;
}

const CONFIG_FILE = ".floe-agent.json";

function getConfigPath(): string {
  return path.resolve(process.cwd(), CONFIG_FILE);
}

export function loadConfig(): FloeAgentConfig | null {
  const configPath = getConfigPath();
  try {
    if (!fs.existsSync(configPath)) return null;
    const data = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(data) as FloeAgentConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: FloeAgentConfig): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function hasConfig(): boolean {
  return fs.existsSync(getConfigPath());
}

export function getConfigFilePath(): string {
  return getConfigPath();
}

/**
 * Idempotently insert or replace an agent record. Mutates `config` and
 * returns the same reference for chaining.
 */
export function upsertAgent(
  config: FloeAgentConfig,
  record: AgentRecord,
): FloeAgentConfig {
  if (!config.agents) config.agents = {};
  config.agents[record.name] = record;
  return config;
}

export function getAgent(
  config: FloeAgentConfig,
  name: string,
): AgentRecord | undefined {
  return config.agents?.[name];
}

export function listAgents(config: FloeAgentConfig): AgentRecord[] {
  return Object.values(config.agents ?? {});
}

export function removeAgent(config: FloeAgentConfig, name: string): boolean {
  if (!config.agents || !(name in config.agents)) return false;
  delete config.agents[name];
  if (config.activeAgent === name) config.activeAgent = undefined;
  return true;
}
