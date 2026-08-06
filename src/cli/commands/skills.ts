import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import { runWithErrorHandling } from "../devApiClient.js";
import { hasFlag, positionals, printJson, usageError } from "../shared.js";

/**
 * `floe-agent skills install` — fetch the Floe Claude Skill (canonical
 * source: the Floe-Labs/agent-skills repo, served raw from GitHub) and
 * drop it where agent runtimes look for skills:
 *
 *   <cwd>/.claude/skills/floe/…   (Claude Code, per-project)
 *   ~/.agents/skills/floe/…       (cross-tool convention)
 *
 * The skill is SKILL.md plus the references/ files it links to — all are
 * installed so the references resolve. Idempotent: identical content
 * reports "unchanged" instead of rewriting.
 */
const SKILL_BASE_URL =
  "https://raw.githubusercontent.com/Floe-Labs/agent-skills/main/skills/floe/";
const SKILL_FILES = [
  "SKILL.md",
  "references/frameworks.md",
  "references/runtime-budget.md",
  "references/spend-policies.md",
  "references/telephony.md",
  "references/vendors.md",
];
const SKILL_DIR = path.join("skills", "floe");

export async function runSkillsCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const verb = positionals(args)[0];
  if (verb !== "install") {
    usageError("Usage: floe-agent skills install [--json]", json);
  }
  await runWithErrorHandling(json, async () => {
    const roots = [
      path.join(process.cwd(), ".claude", SKILL_DIR),
      path.join(os.homedir(), ".agents", SKILL_DIR),
    ];
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const file of SKILL_FILES) {
      const url = SKILL_BASE_URL + file;
      // AbortSignal.timeout bounds the whole round-trip — headers AND body.
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      }
      const content = await res.text();
      for (const root of roots) {
        const target = path.join(root, file);
        if (fs.existsSync(target) && fs.readFileSync(target, "utf-8") === content) {
          unchanged.push(target);
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        written.push(target);
      }
    }

    if (json) {
      printJson({ skill: "floe", source: SKILL_BASE_URL, written, unchanged });
      return;
    }
    for (const t of written) console.log(chalk.green(`  Installed ${t}`));
    for (const t of unchanged) console.log(chalk.dim(`  Unchanged ${t}`));
    console.log("");
  });
}
