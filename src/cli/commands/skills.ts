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
 * installed so the references resolve. Pinned to an agent-skills release
 * tag so a later push to main can't change what an already-published
 * package version installs. Idempotent: identical content reports
 * "unchanged" instead of rewriting.
 */
const SKILL_REVISION = "v1.0.0";
const SKILL_BASE_URL = `https://raw.githubusercontent.com/Floe-Labs/agent-skills/${SKILL_REVISION}/skills/floe/`;
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
    // Fetch every file before touching disk so a failed download can never
    // leave a half-updated install (SKILL.md pointing at missing or stale
    // references) in either root.
    const fetched: Array<{ file: string; content: string }> = [];
    for (const file of SKILL_FILES) {
      const url = SKILL_BASE_URL + file;
      // AbortSignal.timeout bounds the whole round-trip — headers AND body.
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      }
      fetched.push({ file, content: await res.text() });
    }

    const roots = [
      path.join(process.cwd(), ".claude", SKILL_DIR),
      path.join(os.homedir(), ".agents", SKILL_DIR),
    ];
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const root of roots) {
      assertRealDirectory(root);
      fs.mkdirSync(root, { recursive: true });
      const refsDir = path.join(root, "references");
      assertRealDirectory(refsDir);
      fs.mkdirSync(refsDir, { recursive: true });
      for (const { file, content } of fetched) {
        const target = path.join(root, file);
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (stat && !stat.isFile()) {
          throw new Error(
            `Refusing to write ${target}: it exists but is not a regular file ` +
              `(symlinks are not followed). Remove it and re-run.`,
          );
        }
        if (stat && fs.readFileSync(target, "utf-8") === content) {
          unchanged.push(target);
          continue;
        }
        fs.writeFileSync(target, content);
        written.push(target);
      }
    }

    if (json) {
      printJson({ skill: "floe", revision: SKILL_REVISION, source: SKILL_BASE_URL, written, unchanged });
      return;
    }
    for (const t of written) console.log(chalk.green(`  Installed ${t}`));
    for (const t of unchanged) console.log(chalk.dim(`  Unchanged ${t}`));
    console.log("");
  });
}

/**
 * A symlink at or below the skill root would let a hostile workspace
 * redirect writes anywhere on disk — refuse rather than follow it.
 */
function assertRealDirectory(p: string): void {
  const stat = fs.lstatSync(p, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) {
    throw new Error(
      `Refusing to install into ${p}: it exists but is not a real directory ` +
        `(symlinks are not followed). Remove it and re-run.`,
    );
  }
}
