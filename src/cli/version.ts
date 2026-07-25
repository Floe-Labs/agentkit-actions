import * as fs from "fs";

/**
 * Resolve the package version from package.json at runtime instead of a
 * hardcoded constant (the old `VERSION = "0.4.0"` in main.ts drifted two
 * releases behind). Works from both dist/cli/ (published) and src/cli/
 * (tsx dev runs): each is exactly two levels below the package root.
 */
let cached: string | null = null;

export function getVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
