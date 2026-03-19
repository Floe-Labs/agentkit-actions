import * as fs from "fs";
import * as path from "path";

export interface FloeAgentConfig {
  walletType: "private-key" | "cdp";
  aiProvider: "openai" | "claude" | "ollama";
  aiModel?: string;
  ollamaBaseUrl?: string;
  rpcUrl?: string;
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
