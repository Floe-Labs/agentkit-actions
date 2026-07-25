/**
 * Shared plumbing for the platform CLI subcommands.
 *
 * Conventions (the gh/parallel playbook, applied to every command):
 *   - `--json` prints raw API JSON to stdout — no spinner, no chalk.
 *   - Exit codes: 0 ok · 1 error · 2 usage · 4 auth required ·
 *     5 payment required (402).
 *   - Non-interactive when stdout is not a TTY: missing required input
 *     exits 2 with usage instead of prompting.
 *   - NO_COLOR is respected (chalk 5 honors it natively).
 */
import chalk from "chalk";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH_REQUIRED = 4;
export const EXIT_PAYMENT_REQUIRED = 5;

export const DASHBOARD_URL = "https://dev-dashboard.floelabs.xyz";
export const DEFAULT_API_URL = "https://credit-api.floelabs.xyz";
export const REMOTE_MCP_URL = "https://mcp.floelabs.xyz/mcp";

/** Base URL for the Credit API — `FLOE_API_URL` overrides the default. */
export function apiBaseUrl(): string {
  return (process.env.FLOE_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`) || args.some((a) => a.startsWith(`--${name}=`));
}

/** Collect every occurrence of a repeatable flag (e.g. `--header` on `pay`). */
export function collectFlags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${name}` && i + 1 < args.length) {
      values.push(args[i + 1]);
      i++;
    } else if (a.startsWith(`--${name}=`)) {
      values.push(a.slice(name.length + 3));
    }
  }
  return values;
}

/**
 * Positional (non-flag) arguments, skipping each flag's value. Flags in
 * `booleanFlags` take no value, so the token after them is positional.
 */
export function positionals(args: string[], booleanFlags: string[] = []): string[] {
  const bools = new Set(["json", "team", "help", "include-revoked", ...booleanFlags]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2).split("=")[0];
      if (!a.includes("=") && !bools.has(name)) i++; // skip the flag's value
      continue;
    }
    out.push(a);
  }
  return out;
}

/** True when both stdin and stdout are TTYs — the only case we may prompt. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Usage error: machine-readable in --json mode, red text otherwise. Exit 2. */
export function usageError(usage: string, json: boolean): never {
  if (json) {
    printJson({ error: "usage", message: usage });
  } else {
    console.error(chalk.red(usage));
  }
  process.exit(EXIT_USAGE);
}

/** Map an HTTP status to the CLI exit-code contract. */
export function exitForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT_AUTH_REQUIRED;
  if (status === 402) return EXIT_PAYMENT_REQUIRED;
  return EXIT_ERROR;
}

const USDC_DECIMALS = 6;

/**
 * "5" → "5000000" (raw USDC, 6 decimals). Mirrors the register /
 * open-credit-line converters: rejects zero, non-numeric, and inputs with
 * more precision than USDC supports.
 */
export function usdToRaw(usdAmount: string): string {
  if (!/^\d+(\.\d+)?$/.test(usdAmount)) {
    throw new Error(`Invalid USD amount: ${usdAmount}`);
  }
  const [whole, frac = ""] = usdAmount.split(".");
  if (frac.length > USDC_DECIMALS) {
    throw new Error(
      `USD amount '${usdAmount}' has more precision than ${USDC_DECIMALS} decimals supports.`,
    );
  }
  const padded = frac + "0".repeat(USDC_DECIMALS - frac.length);
  const raw = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  if (raw === "" || raw === "0" || /^0+$/.test(raw)) {
    throw new Error(`USD amount must be positive, got '${usdAmount}'.`);
  }
  return raw;
}

/**
 * usdToRaw for a value that came off the command line: a malformed amount is
 * a usage error (exit 2), not a runtime failure (exit 1).
 */
export function usdToRawArg(usdAmount: string, flag: string, json: boolean): string {
  try {
    return usdToRaw(usdAmount);
  } catch (err) {
    usageError(`${flag}: ${(err as Error).message}`, json);
  }
}

/** "5000000" → "$5.00". Display-quality only — keeps 2..6 decimals as needed. */
export function rawToUsd(raw: string | null | undefined): string {
  if (!raw || !/^\d+$/.test(raw)) return "$0.00";
  const padded = raw.padStart(USDC_DECIMALS + 1, "0");
  const whole = padded.slice(0, -USDC_DECIMALS);
  const frac = padded.slice(-USDC_DECIMALS).replace(/0+$/, "");
  const cents = frac.length < 2 ? frac.padEnd(2, "0") : frac;
  return `$${whole}.${cents}`;
}
