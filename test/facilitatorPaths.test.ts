/**
 * Guard test: every facilitator path in X402ActionProvider must be /v1-prefixed.
 *
 * The backend serves only /v1/* — an unversioned path (e.g. /agents/credit-remaining)
 * 404s in production. A prod incident traced to exactly this: the provider was
 * calling bare /agents, /proxy and /x402 paths. The provider itself can't be
 * instantiated under vitest/esbuild (the @CreateAction decorators need
 * tsc-emitted parameter metadata), so we guard statically by scanning the source
 * for every facilitatorFetch("…") / facilitatorFetch(`…`) call and asserting the
 * path starts with /v1/. This catches the whole class of bug, including paths
 * added later.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/x402ActionProvider.ts", import.meta.url));

// Capture the leading path literal of every facilitatorFetch(...) call. \s*
// (which matches newlines) handles the multiline call style where the path is
// on the next line. The character class stops at the closing quote/backtick, so
// template interpolations later in the path don't matter — we only need the
// prefix.
const CALL_RE = /facilitatorFetch\(\s*["'`](\/[^"'`]*)/g;

describe("X402ActionProvider facilitator paths", () => {
  const src = readFileSync(SRC, "utf8");
  const paths = [...src.matchAll(CALL_RE)].map((m) => m[1]);

  it("finds the expected facilitatorFetch call sites", () => {
    // Sanity floor so a refactor that changes the call style can't silently
    // make this guard vacuous.
    expect(paths.length).toBeGreaterThanOrEqual(20);
  });

  it("prefixes every path with /v1/ (backend serves /v1/* only)", () => {
    const unversioned = paths.filter((p) => !p.startsWith("/v1/"));
    expect(unversioned).toEqual([]);
  });
});
