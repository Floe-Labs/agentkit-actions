import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import { runWithErrorHandling } from "../devApiClient.js";
import { hasFlag, positionals, printJson, usageError } from "../shared.js";

/**
 * `floe skills install` — fetch the floe-budget Claude Skill (shipped
 * inside the @floelabs/mcp-server npm tarball, served by unpkg) and drop
 * it where agent runtimes look for skills:
 *
 *   <cwd>/.claude/skills/floe-budget/SKILL.md   (Claude Code, per-project)
 *   ~/.agents/skills/floe-budget/SKILL.md       (cross-tool convention)
 *
 * Idempotent: identical content reports "unchanged" instead of rewriting.
 */
const SKILL_URL = "https://unpkg.com/@floelabs/mcp-server/skills/floe-budget/SKILL.md";
const SKILL_REL_PATH = path.join("skills", "floe-budget", "SKILL.md");

export async function runSkillsCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const verb = positionals(args)[0];
  if (verb !== "install") {
    usageError("Usage: floe skills install [--json]", json);
  }
  await runWithErrorHandling(json, async () => {
    // AbortSignal.timeout bounds the whole round-trip — headers AND body.
    const res = await fetch(SKILL_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${SKILL_URL}: ${res.status} ${res.statusText}`);
    }
    const content = await res.text();

    const targets = [
      path.join(process.cwd(), ".claude", SKILL_REL_PATH),
      path.join(os.homedir(), ".agents", SKILL_REL_PATH),
    ];
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const target of targets) {
      if (fs.existsSync(target) && fs.readFileSync(target, "utf-8") === content) {
        unchanged.push(target);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      written.push(target);
    }

    if (json) {
      printJson({ skill: "floe-budget", source: SKILL_URL, written, unchanged });
      return;
    }
    for (const t of written) console.log(chalk.green(`  Installed ${t}`));
    for (const t of unchanged) console.log(chalk.dim(`  Unchanged ${t}`));
    console.log("");
  });
}
