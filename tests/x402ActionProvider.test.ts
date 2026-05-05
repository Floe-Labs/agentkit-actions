// Regression tests for X402ActionProvider collateral approval.
//
// Mirrors agentkit-actions-py/tests/test_x402_collateral_approval.py — the
// two SDKs must enforce the same approval contract:
//
//   unsafeInfiniteApproval=true → MAX_UINT256 (preserves pre-fix behavior)
//   collateralApproval=<raw>    → exact bounded amount
//   neither set                 → no approve tx; warning surfaced in result
//   both set                    → handler-level error, no side effects
//
// Mutual exclusion is enforced in the handler (not the schema) so existing
// callers don't get a framework-level validation error from omitting a field.
//
// This is the first vitest test in the repo.

import { describe, expect, test, vi, beforeEach } from "vitest";

// `@CreateAction` runs at class-evaluation time and uses
// `Reflect.getMetadata("design:paramtypes", ...)` to validate handler
// arguments. Vitest's default esbuild transformer doesn't emit
// `emitDecoratorMetadata` (esbuild limitation), so the validation throws
// at import. We replace the decorator with a no-op for the test runtime —
// this is fine because we're exercising the handler method body directly,
// not the agentkit action registry path.
vi.mock("@coinbase/agentkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@coinbase/agentkit")>();
  return {
    ...actual,
    CreateAction: () => () => undefined,
  };
});

const {
  GrantCreditDelegationSchema,
  X402ActionProvider,
} = await import("../src/x402ActionProvider.js");

const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
const MATCHER_ADDRESS = "0x17946cD3e180f82e632805e5549EC913330Bb175";
const COLLATERAL_TOKEN = "0x4200000000000000000000000000000000000006"; // WETH on Base

const APPROVE_SELECTOR = "0x095ea7b3"; // keccak256("approve(address,uint256)")[:4]

interface SentTx {
  to: string;
  data: string;
}

class SpyWallet {
  public sent: SentTx[] = [];
  private currentAllowance: bigint;

  constructor(currentAllowance: bigint = 0n) {
    this.currentAllowance = currentAllowance;
  }

  async getAddress(): Promise<string> {
    return "0x1111111111111111111111111111111111111111";
  }

  async signMessage(_msg: string): Promise<string> {
    return "0x" + "ab".repeat(65);
  }

  async sendTransaction(tx: { to: string; data: string }): Promise<string> {
    this.sent.push({ to: tx.to, data: tx.data });
    return "0x" + "cd".repeat(32);
  }

  async readContract(req: { functionName: string }): Promise<bigint> {
    if (req.functionName === "allowance") return this.currentAllowance;
    throw new Error(`Unexpected readContract: ${req.functionName}`);
  }

  getNetwork(): { chainId: string } {
    return { chainId: "8453" };
  }

  async waitForTransactionReceipt(): Promise<unknown> {
    return { status: 1 };
  }
}

function approveTxs(wallet: SpyWallet): SentTx[] {
  return wallet.sent.filter((tx) => tx.to.toLowerCase() === COLLATERAL_TOKEN.toLowerCase());
}

function decodeApprove(data: string): { spender: string; amount: bigint } {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  expect(hex.slice(0, 8).toLowerCase()).toBe(APPROVE_SELECTOR.slice(2));
  // 32-byte padded address (skip 12 bytes of left-padding) + 32-byte uint256
  const spender = "0x" + hex.slice(8 + 24, 8 + 64);
  const amount = BigInt("0x" + hex.slice(8 + 64, 8 + 128));
  return { spender, amount };
}

const BASE_ARGS = {
  facilitatorAddress: "0x3333333333333333333333333333333333333333",
  facilitatorUrl: "https://x402.floe.xyz",
  borrowLimit: "10000",
  maxRateBps: "1500",
  expiryDays: "90",
  collateralToken: COLLATERAL_TOKEN,
};

// Return type intentionally inferred. The dynamic `await import(...)` above
// is required to hoist below the `vi.mock` decorator no-op, but it makes
// `X402ActionProvider` a runtime value at this scope — using it as an
// instance-type annotation here trips TS2749 in the IDE.
function makeProvider() {
  return new X402ActionProvider({
    matcherAddress: MATCHER_ADDRESS,
    facilitatorUrl: "https://x402.floe.xyz",
    facilitatorApiKey: "test-key",
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFacilitator() {
  // Handles the two endpoints grant_credit_delegation hits.
  const fn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/agents/pre-register")) {
      return jsonResponse(200, {
        privyWalletAddress: "0x2222222222222222222222222222222222222222",
      });
    }
    if (url.includes("/agents/register")) {
      return jsonResponse(200, {
        privyWalletAddress: "0x2222222222222222222222222222222222222222",
        creditLimit: "10000000000",
        apiKey: "test-api-key",
        agentId: "agent-test",
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ────────────────────────────────────────────────────────────────────────────
// Schema layer: permissive on approval fields by design.
// ────────────────────────────────────────────────────────────────────────────

describe("GrantCreditDelegationSchema", () => {
  test.each([
    ["neither", {}],
    ["collateralApproval only", { collateralApproval: "1000" }],
    ["unsafeInfiniteApproval only", { unsafeInfiniteApproval: true }],
    ["both", { collateralApproval: "1000", unsafeInfiniteApproval: true }],
  ])("accepts %s", (_label, extra) => {
    expect(() =>
      GrantCreditDelegationSchema.parse({ ...BASE_ARGS, ...extra }),
    ).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Handler: enforces the approval contract.
// ────────────────────────────────────────────────────────────────────────────

describe("grantCreditDelegation handler", () => {
  test("rejects both flags set without any side effects", async () => {
    const provider = makeProvider();
    const wallet = new SpyWallet();
    const fetchSpy = stubFacilitator();

    const args = GrantCreditDelegationSchema.parse({
      ...BASE_ARGS,
      collateralApproval: "42",
      unsafeInfiniteApproval: true,
    });
    const result = await provider.grantCreditDelegation(wallet as never, args);

    expect(result.toLowerCase()).toContain("pick one");
    expect(wallet.sent).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("default (neither flag) skips approve and surfaces NOT SET warning", async () => {
    const provider = makeProvider();
    const wallet = new SpyWallet(0n);
    stubFacilitator();

    const args = GrantCreditDelegationSchema.parse({ ...BASE_ARGS });
    const result = await provider.grantCreditDelegation(wallet as never, args);

    expect(result).not.toContain("Error");
    // No approve() targeting the collateral token.
    expect(approveTxs(wallet)).toHaveLength(0);
    // The result must call out the no-approval state.
    expect(result).toContain("NOT SET");
  });

  test("unsafeInfiniteApproval=true grants MAX_UINT256", async () => {
    const provider = makeProvider();
    const wallet = new SpyWallet(0n);
    stubFacilitator();

    const args = GrantCreditDelegationSchema.parse({
      ...BASE_ARGS,
      unsafeInfiniteApproval: true,
    });
    const result = await provider.grantCreditDelegation(wallet as never, args);
    expect(result).not.toContain("Error");

    const approves = approveTxs(wallet);
    expect(approves).toHaveLength(1);

    const { spender, amount } = decodeApprove(approves[0].data);
    expect(spender.toLowerCase()).toBe(MATCHER_ADDRESS.toLowerCase());

    // CRITICAL: must be the literal MAX_UINT256. Pre-fix wrong-units bug
    // would put `borrow_limit * 10` here instead — guard against regression.
    expect(amount).toBe(MAX_UINT256);
    expect(amount).not.toBe(BigInt(BASE_ARGS.borrowLimit) * 10n);
  });

  test("collateralApproval=<raw> grants exactly that amount, not MAX_UINT256", async () => {
    const provider = makeProvider();
    const wallet = new SpyWallet(0n);
    stubFacilitator();

    const bounded = "123456789";
    const args = GrantCreditDelegationSchema.parse({
      ...BASE_ARGS,
      collateralApproval: bounded,
    });
    const result = await provider.grantCreditDelegation(wallet as never, args);
    expect(result).not.toContain("Error");

    const approves = approveTxs(wallet);
    expect(approves).toHaveLength(1);

    const { spender, amount } = decodeApprove(approves[0].data);
    expect(spender.toLowerCase()).toBe(MATCHER_ADDRESS.toLowerCase());
    expect(amount).toBe(BigInt(bounded));
    expect(amount).not.toBe(MAX_UINT256);
  });

  test("unsafeInfiniteApproval skips approve tx when allowance is already MAX_UINT256", async () => {
    // The unsafe-infinite path keeps at-least semantics — there is no
    // value in re-approving MAX when the wallet is already at MAX.
    const provider = makeProvider();
    const wallet = new SpyWallet(MAX_UINT256);
    stubFacilitator();

    const args = GrantCreditDelegationSchema.parse({
      ...BASE_ARGS,
      unsafeInfiniteApproval: true,
    });
    await provider.grantCreditDelegation(wallet as never, args);

    expect(approveTxs(wallet)).toHaveLength(0);
  });

  test("collateralApproval force-sets DOWN when current allowance exceeds requested bound", async () => {
    // The migration scenario flagged in PR review: a wallet that previously
    // received the old MAX_UINT256 default re-runs grant_credit_delegation
    // with collateralApproval=<raw>. The bounded path MUST issue an
    // approve(requested) to actually reduce the allowance — otherwise the
    // caller walks away with the old infinite allowance still active and a
    // false sense of bounded exposure (this is the bug Copilot caught on
    // PR #17).
    const provider = makeProvider();
    const wallet = new SpyWallet(MAX_UINT256); // legacy infinite allowance
    stubFacilitator();

    const bounded = "1000";
    const args = GrantCreditDelegationSchema.parse({
      ...BASE_ARGS,
      collateralApproval: bounded,
    });
    await provider.grantCreditDelegation(wallet as never, args);

    const approves = approveTxs(wallet);
    expect(approves).toHaveLength(1);
    const { spender, amount } = decodeApprove(approves[0].data);
    expect(spender.toLowerCase()).toBe(MATCHER_ADDRESS.toLowerCase());
    // Force-set down to the exact requested cap, not the existing MAX.
    expect(amount).toBe(BigInt(bounded));
    expect(amount).not.toBe(MAX_UINT256);
  });

  test("collateralApproval skips approve tx only when current allowance already equals the requested bound", async () => {
    // Gas-saving short-circuit on the bounded path: when current allowance
    // is already exactly the requested amount, no tx is needed.
    const provider = makeProvider();
    const bounded = 1000n;
    const wallet = new SpyWallet(bounded);
    stubFacilitator();

    const args = GrantCreditDelegationSchema.parse({
      ...BASE_ARGS,
      collateralApproval: bounded.toString(),
    });
    await provider.grantCreditDelegation(wallet as never, args);

    expect(approveTxs(wallet)).toHaveLength(0);
  });
});
