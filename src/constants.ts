import type { Address } from "./types.js";

// ── Contract Addresses ──────────────────────────────────────────────────────

export const BASE_MAINNET_MATCHER: Address =
  "0x17946cD3e180f82e632805e5549EC913330Bb175";
export const BASE_MAINNET_VIEWS: Address =
  "0x9101027166bE205105a9E0c68d6F14f21f6c5003";
export const BASE_SEPOLIA_MATCHER: Address =
  "0xF351eDF229ded7E2e2b23E44c70e9964CbA91B2E";

// ── Protocol Constants ──────────────────────────────────────────────────────

export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const BASIS_POINTS = 10000n;

// ── Known Tokens (Base Mainnet) ─────────────────────────────────────────────

export const KNOWN_TOKENS: Record<
  string,
  { symbol: string; decimals: number }
> = {
  "0x4200000000000000000000000000000000000006": {
    symbol: "WETH",
    decimals: 18,
  },
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": {
    symbol: "USDC",
    decimals: 6,
  },
  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb": {
    symbol: "DAI",
    decimals: 18,
  },
  "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22": {
    symbol: "cbETH",
    decimals: 18,
  },
  "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452": {
    symbol: "wstETH",
    decimals: 18,
  },
  "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA": {
    symbol: "USDbC",
    decimals: 6,
  },
};

// ── Shared ABI Fragments ────────────────────────────────────────────────────

const ConditionComponents = [
  { name: "target", type: "address" },
  { name: "callData", type: "bytes" },
  { name: "applyToAllPartialFills", type: "bool" },
] as const;

const HookComponents = [
  { name: "target", type: "address" },
  { name: "callData", type: "bytes" },
  { name: "gasLimit", type: "uint256" },
  { name: "expiry", type: "uint256" },
  { name: "allowFailure", type: "bool" },
  { name: "applyToAllPartialFills", type: "bool" },
] as const;

const LendIntentComponents = [
  { name: "lender", type: "address" },
  { name: "onBehalfOf", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "minFillAmount", type: "uint256" },
  { name: "filledAmount", type: "uint256" },
  { name: "minInterestRateBps", type: "uint256" },
  { name: "maxLtvBps", type: "uint256" },
  { name: "minDuration", type: "uint256" },
  { name: "maxDuration", type: "uint256" },
  { name: "allowPartialFill", type: "bool" },
  { name: "validFromTimestamp", type: "uint256" },
  { name: "expiry", type: "uint256" },
  { name: "marketId", type: "bytes32" },
  { name: "salt", type: "bytes32" },
  { name: "gracePeriod", type: "uint256" },
  { name: "minInterestBps", type: "uint256" },
  {
    name: "conditions",
    type: "tuple[]",
    components: ConditionComponents,
  },
  { name: "preHooks", type: "tuple[]", components: HookComponents },
  { name: "postHooks", type: "tuple[]", components: HookComponents },
] as const;

const BorrowIntentComponents = [
  { name: "borrower", type: "address" },
  { name: "onBehalfOf", type: "address" },
  { name: "borrowAmount", type: "uint256" },
  { name: "collateralAmount", type: "uint256" },
  { name: "minFillAmount", type: "uint256" },
  { name: "maxInterestRateBps", type: "uint256" },
  { name: "minLtvBps", type: "uint256" },
  { name: "minDuration", type: "uint256" },
  { name: "maxDuration", type: "uint256" },
  { name: "allowPartialFill", type: "bool" },
  { name: "validFromTimestamp", type: "uint256" },
  { name: "matcherCommissionBps", type: "uint256" },
  { name: "expiry", type: "uint256" },
  { name: "marketId", type: "bytes32" },
  { name: "salt", type: "bytes32" },
  {
    name: "conditions",
    type: "tuple[]",
    components: ConditionComponents,
  },
  { name: "preHooks", type: "tuple[]", components: HookComponents },
  { name: "postHooks", type: "tuple[]", components: HookComponents },
] as const;

// ── LendingIntentMatcher ABI ────────────────────────────────────────────────

export const LENDING_MATCHER_ABI = [
  {
    type: "function",
    name: "getMarket",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "marketId", type: "bytes32" },
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "interestRateBps", type: "uint256" },
          { name: "ltvBps", type: "uint256" },
          { name: "liquidationIncentiveBps", type: "uint256" },
          { name: "marketFeeBps", type: "uint256" },
          { name: "totalPrincipalOutstanding", type: "uint256" },
          { name: "totalLoans", type: "uint256" },
          { name: "lastUpdateAt", type: "uint128" },
          {
            name: "pauseStatuses",
            type: "tuple",
            components: [
              { name: "isAddCollateralPaused", type: "bool" },
              { name: "isBorrowPaused", type: "bool" },
              { name: "isWithdrawCollateralPaused", type: "bool" },
              { name: "isRepayPaused", type: "bool" },
              { name: "isLiquidatePaused", type: "bool" },
            ],
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getLoan",
    inputs: [{ name: "loanId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "marketId", type: "bytes32" },
          { name: "loanId", type: "uint256" },
          { name: "lender", type: "address" },
          { name: "borrower", type: "address" },
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "principal", type: "uint256" },
          { name: "interestRateBps", type: "uint256" },
          { name: "ltvBps", type: "uint256" },
          { name: "liquidationLtvBps", type: "uint256" },
          { name: "marketFeeBps", type: "uint256" },
          { name: "matcherCommissionBps", type: "uint256" },
          { name: "startTime", type: "uint256" },
          { name: "duration", type: "uint256" },
          { name: "collateralAmount", type: "uint256" },
          { name: "repaid", type: "bool" },
          { name: "gracePeriod", type: "uint256" },
          { name: "minInterestBps", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getLoanIdsByUser",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getCurrentLtvBps",
    inputs: [{ name: "loanId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPrice",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "loanToken", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAccruedInterest",
    inputs: [{ name: "loanId", type: "uint256" }],
    outputs: [
      { name: "interest", type: "uint256" },
      { name: "timeElapsed", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isHealthy",
    inputs: [{ name: "loanId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getMarketId",
    inputs: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "getOnChainLendIntent",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: LendIntentComponents,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getOnChainBorrowIntent",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: BorrowIntentComponents,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "registerLendIntent",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: LendIntentComponents,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "registerBorrowIntent",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: BorrowIntentComponents,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "matchLoanIntents",
    inputs: [
      {
        name: "lender",
        type: "tuple",
        components: LendIntentComponents,
      },
      { name: "lenderSig", type: "bytes" },
      {
        name: "borrower",
        type: "tuple",
        components: BorrowIntentComponents,
      },
      { name: "borrowerSig", type: "bytes" },
      { name: "marketId", type: "bytes32" },
      { name: "isLenderOnChain", type: "bool" },
      { name: "isBorrowerOnChain", type: "bool" },
    ],
    outputs: [{ name: "loanId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "repayLoan",
    inputs: [
      { name: "loanId", type: "uint256" },
      { name: "repayAmount", type: "uint256" },
      { name: "maxTotalRepayment", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "addCollateral",
    inputs: [
      { name: "loanId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawCollateral",
    inputs: [
      { name: "loanId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "liquidateLoan",
    inputs: [
      { name: "loanId", type: "uint256" },
      { name: "repayAmount", type: "uint256" },
      { name: "maxTotalRepayment", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── LendingViews ABI ────────────────────────────────────────────────────────

export const LENDING_VIEWS_ABI = [
  {
    type: "function",
    name: "getLiquidationQuote",
    inputs: [
      { name: "loanId", type: "uint256" },
      { name: "repayAmount", type: "uint256" },
    ],
    outputs: [
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "loanId", type: "uint256" },
          { name: "isUnderwater", type: "bool" },
          { name: "requiresFullLiquidation", type: "bool" },
          { name: "repayAmount", type: "uint256" },
          { name: "interestAmount", type: "uint256" },
          { name: "totalLiquidatorPays", type: "uint256" },
          { name: "collateralToReceive", type: "uint256" },
          { name: "collateralValueReceived", type: "uint256" },
          { name: "lenderReceives", type: "uint256" },
          { name: "protocolFeeAmount", type: "uint256" },
          { name: "liquidatorProfit", type: "uint256" },
          { name: "liquidatorProfitBps", type: "uint256" },
          { name: "badDebtAmount", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isLoanUnderwater",
    inputs: [{ name: "loanId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

// ── ERC20 ABI ───────────────────────────────────────────────────────────────

export const ERC20_ABI = [
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
