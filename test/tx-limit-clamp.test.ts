// Regression tests for the tx-limit clamp in x402ActionProvider.
// Commits 40cc356 / b4bcb3c clamp the client-supplied limit to <=100.
// Source: src/x402ActionProvider.ts:574-575
//   const parsed = parseInt(args.limit, 10);
//   const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;

import { describe, it, expect, vi, beforeEach } from "vitest";
import { X402ActionProvider } from "../src/x402ActionProvider.js";

function installFetchStub() {
  const fetchStub = vi.fn(async (_url: string) => {
    return new Response(JSON.stringify({ transactions: [], hasMore: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  (globalThis as any).fetch = fetchStub;
  return fetchStub;
}

function makeWalletProvider() {
  return {
    getAddress: vi.fn().mockResolvedValue("0x1111111111111111111111111111111111111111"),
    signMessage: vi.fn().mockResolvedValue("0xsig"),
  } as any;
}

function lastUrl(fetchStub: ReturnType<typeof installFetchStub>): string {
  const calls = fetchStub.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as string;
}

describe("x402ActionProvider — tx limit clamp", () => {
  let provider: X402ActionProvider;
  let fetchStub: ReturnType<typeof installFetchStub>;

  beforeEach(() => {
    provider = new X402ActionProvider({
      matcherAddress: "0x17946cD3e180f82e632805e5549EC913330Bb175",
      facilitatorUrl: "https://x402.floe.xyz",
    });
    fetchStub = installFetchStub();
  });

  it("clamps limit=150 down to 100", async () => {
    await provider.x402GetTransactions(makeWalletProvider(), { limit: "150" } as any);
    expect(lastUrl(fetchStub)).toMatch(/limit=100($|&)/);
  });

  it("clamps limit=10000 down to 100", async () => {
    await provider.x402GetTransactions(makeWalletProvider(), { limit: "10000" } as any);
    expect(lastUrl(fetchStub)).toMatch(/limit=100($|&)/);
  });

  it("passes through limit=50 unchanged", async () => {
    await provider.x402GetTransactions(makeWalletProvider(), { limit: "50" } as any);
    expect(lastUrl(fetchStub)).toMatch(/limit=50($|&)/);
  });

  it("falls back to default limit=20 for non-numeric input", async () => {
    await provider.x402GetTransactions(makeWalletProvider(), { limit: "abc" } as any);
    expect(lastUrl(fetchStub)).toMatch(/limit=20($|&)/);
  });

  it("falls back to default limit=20 for negative input", async () => {
    await provider.x402GetTransactions(makeWalletProvider(), { limit: "-5" } as any);
    expect(lastUrl(fetchStub)).toMatch(/limit=20($|&)/);
  });

  it("falls back to default limit=20 for zero input", async () => {
    await provider.x402GetTransactions(makeWalletProvider(), { limit: "0" } as any);
    expect(lastUrl(fetchStub)).toMatch(/limit=20($|&)/);
  });
});
