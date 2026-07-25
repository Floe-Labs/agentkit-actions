import { spawn } from "child_process";
import chalk from "chalk";
import { runWithErrorHandling } from "../devApiClient.js";
import {
  EXIT_ERROR,
  REMOTE_MCP_URL,
  hasFlag,
  positionals,
  printJson,
  usageError,
} from "../shared.js";

/**
 * `floe mcp install` — hand off to the universal installer
 * (`npx -y add-mcp <url>`), which detects Claude Code / Cursor / VS Code /
 * Codex configs and writes the entry. If the installer is unavailable or
 * fails, print the manual remote-MCP config + the `claude mcp add`
 * one-liner so the agent can finish by hand. Configs carry the URL only —
 * never a key; the Authorization header is supplied by the client at
 * connect time.
 */
const MANUAL_CONFIG = {
  mcpServers: {
    floe: {
      type: "http",
      url: REMOTE_MCP_URL,
      headers: { Authorization: "Bearer YOUR_FLOE_KEY" },
    },
  },
};

const CLAUDE_ONE_LINER = `claude mcp add --transport http floe ${REMOTE_MCP_URL} --header "Authorization: Bearer YOUR_FLOE_KEY"`;

export async function runMcpCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const verb = positionals(args)[0];
  if (verb !== "install") {
    usageError("Usage: floe mcp install [--json]", json);
  }
  await runWithErrorHandling(json, async () => {
    const exitCode = await runAddMcp(json);
    if (exitCode === 0) {
      if (json) printJson({ installed: true, via: "add-mcp", url: REMOTE_MCP_URL });
      else console.log(chalk.green(`  MCP server installed (${REMOTE_MCP_URL}).`));
      return;
    }
    // Fallback: manual instructions, then a non-zero exit so callers know
    // the automated path did not complete.
    if (json) {
      printJson({
        installed: false,
        via: "add-mcp",
        exitCode,
        manualConfig: MANUAL_CONFIG,
        claudeOneLiner: CLAUDE_ONE_LINER,
      });
    } else {
      console.error(chalk.yellow("\n  add-mcp failed — install manually instead:\n"));
      console.error(chalk.bold("  MCP JSON config (Cursor / VS Code / any MCP client):"));
      console.error(`${JSON.stringify(MANUAL_CONFIG, null, 2)}\n`);
      console.error(chalk.bold("  Claude Code one-liner:"));
      console.error(`  ${CLAUDE_ONE_LINER}\n`);
      console.error(chalk.dim("  Replace YOUR_FLOE_KEY with your floe_live_ or floe_ key."));
    }
    process.exit(EXIT_ERROR);
  });
}

/** Headless installs get a hard deadline — nothing is streamed, so a hung
 * npx would otherwise wedge the CLI invisibly. Interactive runs stream the
 * installer's output (and may legitimately prompt), so Ctrl-C stays the
 * escape hatch there. */
const ADD_MCP_TIMEOUT_MS = 300_000;

/** Spawn `npx -y add-mcp <url>`; resolve with its exit code (1 on spawn error). */
function runAddMcp(json: boolean): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };
    const child = spawn("npx", ["-y", "add-mcp", REMOTE_MCP_URL], {
      // In --json mode swallow the installer's output so stdout stays
      // machine-readable; interactively, stream it through.
      stdio: json ? "ignore" : "inherit",
      shell: process.platform === "win32",
    });
    if (json) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        settle(1);
      }, ADD_MCP_TIMEOUT_MS);
    }
    child.on("error", () => settle(1));
    child.on("exit", (code) => settle(code ?? 1));
  });
}
