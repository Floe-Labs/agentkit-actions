// Smoke test: the combined action count across FloeActionProvider and
// X402ActionProvider must match the documented "36 actions" claim.
// If this number changes, the docs at floe-labs-docs must be updated
// in lockstep OR this test must be updated intentionally.

import { describe, it, expect } from "vitest";
import { FloeActionProvider } from "../src/floeActionProvider.js";
import { X402ActionProvider } from "../src/x402ActionProvider.js";

// Minimal EvmWalletProvider stub; getActions() only needs the shape, not
// real network calls.
const wallet = {
  getAddress: async () => "0x1111111111111111111111111111111111111111",
  getNetwork: () => ({ chainId: "8453" }),
} as any;

describe("Exported action count", () => {
  it("FloeActionProvider exports 30 actions", () => {
    const floe = new FloeActionProvider({} as any);
    const actions = floe.getActions(wallet);
    expect(actions.length).toBe(30);
  });

  it("X402ActionProvider exports 6 actions", () => {
    const x402 = new X402ActionProvider({
      matcherAddress: "0x17946cD3e180f82e632805e5549EC913330Bb175",
      facilitatorUrl: "https://x402.floe.xyz",
    });
    const actions = x402.getActions(wallet);
    expect(actions.length).toBe(6);
  });

  it("total action count is 36 (matches docs claim)", () => {
    const floe = new FloeActionProvider({} as any);
    const x402 = new X402ActionProvider({
      matcherAddress: "0x17946cD3e180f82e632805e5549EC913330Bb175",
      facilitatorUrl: "https://x402.floe.xyz",
    });
    const total = floe.getActions(wallet).length + x402.getActions(wallet).length;
    expect(total).toBe(36);
  });
});
