import chalk from "chalk";
import { DevApiClient, requireAgentAuth, runWithErrorHandling } from "../devApiClient.js";
import { hasFlag, parseFlag, positionals, positiveIntArg, printJson, usageError } from "../shared.js";

/**
 * `floe estimate <url>` / `floe forecast <url…>` — x402 cost preflight
 * (agent key). estimate prices one call; forecast batches up to 50 URLs
 * through the policy preflight so an agent can budget a whole task before
 * spending a cent.
 */
export async function runEstimateCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const url = positionals(args)[0];
  if (!url) usageError("Usage: floe estimate <url> [--method <M>] [--json]", json);
  await runWithErrorHandling(json, async () => {
    const { auth, baseUrl } = await requireAgentAuth(json);
    const body: Record<string, unknown> = { url };
    const method = parseFlag(args, "method");
    if (method) body.method = method.toUpperCase();
    const res = (await new DevApiClient(auth, baseUrl).request("POST", "/v1/x402/estimate", { body }))
      .body;
    if (json) printJson(res);
    else console.log(`  ${chalk.bold("Estimate:")} ${JSON.stringify(res)}`);
  });
}

export async function runForecastCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const urls = positionals(args);
  if (urls.length === 0) {
    usageError(
      "Usage: floe forecast <url> [<url>…] [--count <n per url>] [--task-id <id>] [--json]",
      json,
    );
  }
  await runWithErrorHandling(json, async () => {
    const { auth, baseUrl } = await requireAgentAuth(json);
    const countFlag = parseFlag(args, "count");
    const count = countFlag ? positiveIntArg(countFlag, "--count", json) : undefined;
    const taskId = parseFlag(args, "task-id");
    const items = urls.map((url) => ({
      url,
      ...(count !== undefined ? { count } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    }));
    const res = (
      await new DevApiClient(auth, baseUrl).request("POST", "/v1/x402/forecast", { body: { items } })
    ).body;
    printJson(res); // the forecast table is structured — raw JSON either way
  });
}
