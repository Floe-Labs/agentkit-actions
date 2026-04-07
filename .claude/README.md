# Floe Ecosystem — Shared Agent Team

This directory defines a **shared agent team** used across all 7 Floe repositories under `/Users/ajc/floe/`.

## How the sharing works

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (set in `~/.claude/settings.json`) enables Claude Code's experimental cross-repo agent teams feature. Under this flag, every `.claude/agents/*.md` file under the project root is **hardlinked to a single inode**, so editing any repo's copy propagates the change to all repos instantly.

## Agents

| Agent | Real work repo(s) | Purpose |
|---|---|---|
| `orchestrator` | All 7 | Task decomposition + delegation. Knows which specialist to invoke per repo context. |
| `backend-dev` | floe-monorepo, agentkit-actions, agentkit-actions-py, floe-mcp-server, floe-backend | Server-side code across TS + Python |
| `frontend-dev` | floe-monorepo (apps/web, apps/monitor-dashboard, apps/base-mini-app), floe-labs-docs | Next.js 15 + React 19 + markdown authoring |
| `db-dev` | floe-monorepo (apps/x402-facilitator/src/db, indexer schemas), floe-backend | Drizzle schema + indexes + migrations |
| `devops` | All 7 | CI/CD, Dockerfiles, deployment runbooks, env config templates |
| `smart-contract-dev` | modular-lending ONLY | Solidity 0.8.30 + Foundry |
| `smart-contract-security` | modular-lending ONLY | Contract audits (read-only, writes to `audit/`) |
| `qa` | All 7 | Test/lint/build validation (read-only, writes to `qa/`) |

Every agent exists in every repo because they're hardlinked. Agents that aren't relevant to a given repo are no-ops there — they just don't get invoked by the orchestrator in that context.

## Repositories

| Repo | Stack | Primary branch |
|---|---|---|
| `floe-monorepo` | Turborepo + pnpm + TypeScript | `x402-credit` (x402 work) or `main` (prod) |
| `modular-lending` | Foundry + Solidity 0.8.30 | `x402` (x402 work) or `main` (prod) |
| `agentkit-actions` | TypeScript npm package | `x402` or `main` |
| `agentkit-actions-py` | Python pip package | `x402` or `main` |
| `floe-labs-docs` | Markdown (GitBook) | `x402` or `main` |
| `floe-mcp-server` | Python MCP server | `main` |
| `floe-backend` | Python FastAPI | `main` |

## Operating rules (IMPORTANT)

### 🚨 Never `rm` agent files

Under the shared-team model, `rm` decrements the link count. Once every repo's path has been `rm`'d, the underlying file content is freed and is gone from ALL repos. If you want to modify an agent, use **Edit** or **Write**, never `rm`.

### Edits propagate instantly

A change to `floe-monorepo/.claude/agents/backend-dev.md` appears in all 7 repos simultaneously. Plan accordingly — there is no per-repo customization.

### Each agent's scope must cover all relevant repos

Because agents are shared, `backend-dev`'s scope lists paths across floe-monorepo, agentkit-actions, agentkit-actions-py, floe-mcp-server, and floe-backend. The agent checks its current working directory to know which repo it's in and applies the correct conventions.

### Per-repo git commits

The agent files are committed to EACH repo's git history independently. Hardlinks are a filesystem-level feature; git stores file content as blobs per repo. If you clone a fresh copy of any repo, the agent files come down as regular files (not hardlinks). To restore the hardlink topology on a fresh clone, run `scripts/sync-agents.sh` (see below).

## Fresh-clone setup (for new team members)

If you clone any of the floe repos fresh, the `.claude/agents/` files will be regular committed files. To re-establish the shared-team hardlink topology:

```bash
# From /Users/<you>/floe (or wherever you cloned the repos side-by-side):
bash scripts/sync-agents.sh
```

The script picks `floe-monorepo` as the canonical source and hardlinks its `.claude/agents/*.md` into every other repo. Overwrites any existing files. Safe to re-run.

## What if the experimental flag goes away?

If Anthropic removes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in a future Claude Code release:

1. The hardlink behavior will stop being automatic (writes won't propagate)
2. But the files themselves remain in each repo (they're committed to git)
3. Run `scripts/sync-agents.sh` after any agent edit to manually re-sync
4. Or migrate to per-repo customization: delete unneeded agents per repo, then each repo has its own independent set

## Troubleshooting

**Problem: I edited an agent in one repo but the change isn't visible in another.**
Check `stat -f "%i" /path/to/agent.md` in both repos. If the inodes differ, the hardlink broke (rare — usually caused by tools that unlink-and-create instead of in-place edit). Run `scripts/sync-agents.sh` to restore.

**Problem: Agent files disappeared.**
You (or a tool) probably `rm`'d them across repos and decremented the link count to zero. Recover from git: `git restore .claude/agents/` in any repo where they were committed, then run `scripts/sync-agents.sh`.

**Problem: An agent complains about file permissions when trying to modify sibling repos.**
Sub-agents inherit the primary working directory of the parent Claude session. If you launched from `/Users/ajc/floe`, they can see all repos but may hit per-agent scope rules. Launch Claude from inside the specific repo when you want per-repo sandboxing.

## Related config

- `~/.claude/settings.json` — contains `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- `/Users/ajc/floe/.claude/settings.local.json` — per-project Claude permissions
- `/Users/ajc/floe/scripts/sync-agents.sh` — manual hardlink sync fallback
