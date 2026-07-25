import chalk from "chalk";
import { DevApiClient, requireDevAuth, runWithErrorHandling } from "../devApiClient.js";
import { DASHBOARD_URL, hasFlag, positionals, printJson, usageError } from "../shared.js";

/**
 * `floe fund <agentId>` — print machine-readable funding instructions and
 * stop. Funding is the human's half of the contract: the CLI hands over
 * the deposit address; the human moves USDC (dashboard onramp/transfer or
 * an external wallet).
 *
 * Prefers GET /v1/developer/agents/:id/funding; on 404 (endpoint not yet
 * deployed) falls back to the agent detail's `privyWalletAddress` — the
 * PAYG deposit address exposed by the serializer.
 */
export async function runFundCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, "json");
  const agentId = positionals(args)[0];
  if (!agentId || !/^\d+$/.test(agentId)) {
    usageError("Usage: floe fund <agentId> [--json]", json);
  }
  await runWithErrorHandling(json, async () => {
    const auth = await requireDevAuth(json);
    const client = new DevApiClient(auth);

    let instructions: Record<string, unknown> | null = null;
    const res = await client.request("GET", `/v1/developer/agents/${agentId}/funding`, {
      expectError: true,
    });
    if (res.status === 200) {
      instructions = res.body as Record<string, unknown>;
    } else if (res.status === 404) {
      // Fallback: the deposit address lives on the agent detail.
      const detail = (await client.request("GET", `/v1/developer/agents/${agentId}`)).body as {
        privyWalletAddress?: string | null;
        agent?: { privyWalletAddress?: string | null };
      };
      const depositAddress = detail.privyWalletAddress ?? detail.agent?.privyWalletAddress ?? null;
      if (!depositAddress) {
        throw new Error(`Agent ${agentId} has no deposit wallet (still provisioning?).`);
      }
      instructions = {
        agentId: Number(agentId),
        depositAddress,
        network: "base",
        chainId: 8453,
        token: "USDC",
        source: "agent_detail_fallback",
      };
    } else {
      throw new Error(
        `funding lookup failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
      );
    }

    if (json) {
      printJson(instructions);
      return;
    }
    const address =
      (instructions.depositAddress as string | undefined) ??
      (instructions.address as string | undefined) ??
      JSON.stringify(instructions);
    console.log("");
    console.log(`  ${chalk.bold("Deposit address:")} ${address}`);
    console.log(`  ${chalk.bold("Network:")}         Base (chain 8453)`);
    console.log("");
    console.log(
      chalk.yellow("  Send USDC on Base ONLY. Other tokens or networks will be lost."),
    );
    console.log(
      chalk.dim(`  Card / onramp / transfer options: ${DASHBOARD_URL} — a human completes this step.`),
    );
    console.log("");
  });
}
