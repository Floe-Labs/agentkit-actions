// Regression test for commit 142ae79: x402ActionProvider must approve
// collateral with MAX_UINT256, NOT `borrow_limit * 10` (wrong-units bug).
//
// This locks down src/x402ActionProvider.ts:301-302 so a future refactor
// cannot silently reintroduce the unit-conversion bug. The pre-fix code
// computed `BigInt(args.borrowLimit) * 10n` and passed it as a raw
// collateral amount — orders of magnitude wrong for WETH/cbBTC decimals.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { X402ActionProvider, GrantCreditDelegationSchema } from "../src/x402ActionProvider.js";

const MAX_UINT256 = 2n ** 256n - 1n;

// Minimal EvmWalletProvider stub: captures every sendTransaction call so
// we can inspect the approve() args.
function makeWalletProvider(opts: { currentAllowance?: bigint } = {}) {
  const sentTxs: Array<{ to: string; data: string }> = [];
  return {
    sentTxs,
    getAddress: vi.fn().mockResolvedValue("0x1111111111111111111111111111111111111111"),
    signMessage: vi.fn().mockResolvedValue("0xsig"),
    readContract: vi.fn().mockResolvedValue(opts.currentAllowance ?? 0n),
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
      sentTxs.push(tx);
      return "0xtxhash";
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
  } as any;
}

// Minimal fetch stub that returns the shapes grantCreditDelegation expects.
function installFetchStub() {
  const fetchStub = vi.fn(async (url: string) => {
    if (url.includes("/agents/pre-register")) {
      return new Response(
        JSON.stringify({ privyWalletAddress: "0x2222222222222222222222222222222222222222" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/agents/register")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });
  (globalThis as any).fetch = fetchStub;
  return fetchStub;
}

describe("x402ActionProvider — collateral approval regression (commit 142ae79)", () => {
  let provider: X402ActionProvider;

  beforeEach(() => {
    provider = new X402ActionProvider({
      matcherAddress: "0x17946cD3e180f82e632805e5549EC913330Bb175",
      facilitatorUrl: "https://x402.floe.xyz",
    });
    installFetchStub();
  });

  it("approves collateral with MAX_UINT256 when collateralApproval is omitted", async () => {
    const wallet = makeWalletProvider({ currentAllowance: 0n });
    const args = GrantCreditDelegationSchema.parse({
      facilitatorAddress: "0x3333333333333333333333333333333333333333",
      facilitatorUrl: "https://x402.floe.xyz",
      borrowLimit: "10000", // 10k USDC
      collateralToken: "0x4200000000000000000000000000000000000006", // WETH
      // collateralApproval intentionally omitted — defaults to MAX_UINT256
    });

    await provider.grantCreditDelegation(wallet, args);

    // Find the approve() call among sent txs. It targets the collateral
    // token (not the matcher) and encodes approve(spender, amount).
    const approveTx = wallet.sentTxs.find(
      (tx: { to: string; data: string }) =>
        tx.to.toLowerCase() === args.collateralToken.toLowerCase(),
    );
    expect(approveTx, "no approve() tx was sent").toBeDefined();

    const decoded = decodeFunctionData({ abi: erc20Abi, data: approveTx!.data as `0x${string}` });
    expect(decoded.functionName).toBe("approve");
    const [spender, amount] = decoded.args as [string, bigint];

    // Spender must be the Floe matcher.
    expect(spender.toLowerCase()).toBe("0x17946cD3e180f82e632805e5549EC913330Bb175".toLowerCase());

    // CRITICAL: amount must be MAX_UINT256, not `borrow_limit * 10`.
    expect(amount).toBe(MAX_UINT256);

    // Explicit guardrail against the pre-fix bug pattern. If someone ever
    // reintroduces `BigInt(borrowLimit) * 10n` as the approval amount,
    // this assertion makes the regression loud.
    const preFixBuggyAmount = BigInt(args.borrowLimit) * 10n;
    expect(amount).not.toBe(preFixBuggyAmount);
  });

  it("honors a bounded collateralApproval override when provided", async () => {
    const wallet = makeWalletProvider({ currentAllowance: 0n });
    const args = GrantCreditDelegationSchema.parse({
      facilitatorAddress: "0x3333333333333333333333333333333333333333",
      facilitatorUrl: "https://x402.floe.xyz",
      borrowLimit: "10000",
      collateralToken: "0x4200000000000000000000000000000000000006",
      collateralApproval: "5000000000000000000", // 5 WETH, raw units
    });

    await provider.grantCreditDelegation(wallet, args);

    const approveTx = wallet.sentTxs.find(
      (tx: { to: string; data: string }) =>
        tx.to.toLowerCase() === args.collateralToken.toLowerCase(),
    );
    expect(approveTx).toBeDefined();

    const decoded = decodeFunctionData({ abi: erc20Abi, data: approveTx!.data as `0x${string}` });
    const [, amount] = decoded.args as [string, bigint];
    expect(amount).toBe(5_000_000_000_000_000_000n);
    expect(amount).not.toBe(MAX_UINT256);
  });

  it("skips approve when current allowance already covers MAX_UINT256 request", async () => {
    // Defensive: if for some reason the existing allowance is already at
    // MAX_UINT256 (possible if the user has previously granted it), the
    // provider should NOT send a redundant approve tx.
    const wallet = makeWalletProvider({ currentAllowance: MAX_UINT256 });
    const args = GrantCreditDelegationSchema.parse({
      facilitatorAddress: "0x3333333333333333333333333333333333333333",
      facilitatorUrl: "https://x402.floe.xyz",
      borrowLimit: "10000",
      collateralToken: "0x4200000000000000000000000000000000000006",
    });

    await provider.grantCreditDelegation(wallet, args);

    const approveTx = wallet.sentTxs.find(
      (tx: { to: string; data: string }) =>
        tx.to.toLowerCase() === args.collateralToken.toLowerCase(),
    );
    expect(approveTx, "approve tx should not have been sent").toBeUndefined();
  });
});
