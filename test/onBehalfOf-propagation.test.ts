// Regression tests: commit b69b483 threaded `onBehalfOf` through
// instant_borrow and repay_and_reborrow actions. This test mocks the
// credit client and asserts the value flows from action args to the
// underlying SDK call unchanged.
//
// Source references:
// - src/floeActionProvider.ts:2552 instant_borrow → client.instantBorrow({ onBehalfOf })
// - src/floeActionProvider.ts:2599 repay_and_reborrow → client.renewCreditLine({ onBehalfOf })

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock creditClientAdapter BEFORE importing the provider so the
// decorator-registered methods resolve the mock at call time.
const instantBorrowMock = vi.fn();
const renewCreditLineMock = vi.fn();

vi.mock("../src/creditClientAdapter.js", () => ({
  createCreditClient: () => ({
    instantBorrow: instantBorrowMock,
    renewCreditLine: renewCreditLineMock,
  }),
  walletProviderToCreditWallet: () => ({}),
}));

// Dynamic import AFTER the mock is registered.
const { FloeActionProvider } = await import("../src/floeActionProvider.js");

const wallet = {
  getAddress: async () => "0x1111111111111111111111111111111111111111",
  getNetwork: () => ({ chainId: "8453" }),
} as any;

describe("onBehalfOf propagation (commit b69b483)", () => {
  beforeEach(() => {
    instantBorrowMock.mockReset();
    renewCreditLineMock.mockReset();
    instantBorrowMock.mockResolvedValue({
      loanId: "1",
      interestRateBps: 500n,
      duration: 86400n,
      registerBorrowTxHash: "0xreg",
      matchTxHash: "0xmatch",
      lendIntentHash: "0xhash",
      approvalTxHash: null,
    });
    renewCreditLineMock.mockResolvedValue({
      repay: { repayTxHash: "0xrepay", approvalTxHash: null },
      newLoan: null,
    });
  });

  it("instant_borrow forwards onBehalfOf to client.instantBorrow", async () => {
    const provider = new FloeActionProvider({} as any);
    const onBehalfOf = "0x9999999999999999999999999999999999999999";
    await provider.instantBorrow(wallet, {
      marketId: "0xfe92656527bae8e6d37a9e0bb785383fbb33f1f0c7e29fdd733f5af7390c2930",
      borrowAmount: "1000000000",
      collateralAmount: "1000000000000000000",
      maxInterestRateBps: "1500",
      duration: "2592000",
      minLtvBps: "5000",
      onBehalfOf,
    } as any);

    expect(instantBorrowMock).toHaveBeenCalledTimes(1);
    const calledWith = instantBorrowMock.mock.calls[0]![0];
    expect(calledWith.onBehalfOf).toBe(onBehalfOf);
  });

  it("instant_borrow forwards onBehalfOf=undefined when arg omitted", async () => {
    const provider = new FloeActionProvider({} as any);
    await provider.instantBorrow(wallet, {
      marketId: "0xfe92656527bae8e6d37a9e0bb785383fbb33f1f0c7e29fdd733f5af7390c2930",
      borrowAmount: "1000000000",
      collateralAmount: "1000000000000000000",
      maxInterestRateBps: "1500",
      duration: "2592000",
      minLtvBps: "5000",
    } as any);

    expect(instantBorrowMock).toHaveBeenCalledTimes(1);
    const calledWith = instantBorrowMock.mock.calls[0]![0];
    expect(calledWith.onBehalfOf).toBeUndefined();
  });

  it("repay_and_reborrow forwards onBehalfOf to client.renewCreditLine", async () => {
    const provider = new FloeActionProvider({} as any);
    const onBehalfOf = "0x8888888888888888888888888888888888888888";
    await provider.repayAndReborrow(wallet, {
      loanId: "1",
      slippageBps: "100",
      onBehalfOf,
    } as any);

    expect(renewCreditLineMock).toHaveBeenCalledTimes(1);
    const calledWith = renewCreditLineMock.mock.calls[0]![0];
    expect(calledWith.onBehalfOf).toBe(onBehalfOf);
  });
});
