export type Address = `0x${string}`;
export type Bytes32 = `0x${string}`;

export interface Condition {
  target: Address;
  callData: `0x${string}`;
  applyToAllPartialFills: boolean;
}

export interface Hook {
  target: Address;
  callData: `0x${string}`;
  gasLimit: bigint;
  expiry: bigint;
  allowFailure: boolean;
  applyToAllPartialFills: boolean;
}

export interface PauseStatuses {
  isAddCollateralPaused: boolean;
  isBorrowPaused: boolean;
  isWithdrawCollateralPaused: boolean;
  isRepayPaused: boolean;
  isLiquidatePaused: boolean;
}

export interface Market {
  marketId: Bytes32;
  loanToken: Address;
  collateralToken: Address;
  interestRateBps: bigint;
  ltvBps: bigint;
  liquidationIncentiveBps: bigint;
  marketFeeBps: bigint;
  totalPrincipalOutstanding: bigint;
  totalLoans: bigint;
  lastUpdateAt: bigint;
  pauseStatuses: PauseStatuses;
}

export interface Loan {
  marketId: Bytes32;
  loanId: bigint;
  lender: Address;
  borrower: Address;
  loanToken: Address;
  collateralToken: Address;
  principal: bigint;
  interestRateBps: bigint;
  ltvBps: bigint;
  liquidationLtvBps: bigint;
  marketFeeBps: bigint;
  matcherCommissionBps: bigint;
  startTime: bigint;
  duration: bigint;
  collateralAmount: bigint;
  repaid: boolean;
  gracePeriod: bigint;
  minInterestBps: bigint;
}

export interface LendIntent {
  lender: Address;
  onBehalfOf: Address;
  amount: bigint;
  minFillAmount: bigint;
  filledAmount: bigint;
  minInterestRateBps: bigint;
  maxLtvBps: bigint;
  minDuration: bigint;
  maxDuration: bigint;
  allowPartialFill: boolean;
  validFromTimestamp: bigint;
  expiry: bigint;
  marketId: Bytes32;
  salt: Bytes32;
  gracePeriod: bigint;
  minInterestBps: bigint;
  conditions: Condition[];
  preHooks: Hook[];
  postHooks: Hook[];
}

export interface BorrowIntent {
  borrower: Address;
  onBehalfOf: Address;
  borrowAmount: bigint;
  collateralAmount: bigint;
  minFillAmount: bigint;
  maxInterestRateBps: bigint;
  minLtvBps: bigint;
  minDuration: bigint;
  maxDuration: bigint;
  allowPartialFill: boolean;
  validFromTimestamp: bigint;
  matcherCommissionBps: bigint;
  expiry: bigint;
  marketId: Bytes32;
  salt: Bytes32;
  conditions: Condition[];
  preHooks: Hook[];
  postHooks: Hook[];
}

export interface LiquidationQuote {
  loanId: bigint;
  isUnderwater: boolean;
  requiresFullLiquidation: boolean;
  repayAmount: bigint;
  interestAmount: bigint;
  totalLiquidatorPays: bigint;
  collateralToReceive: bigint;
  collateralValueReceived: bigint;
  lenderReceives: bigint;
  protocolFeeAmount: bigint;
  liquidatorProfit: bigint;
  liquidatorProfitBps: bigint;
  badDebtAmount: bigint;
}

export interface FloeConfig {
  lendingIntentMatcherAddress: Address;
  lendingViewsAddress: Address;
  knownMarketIds: Bytes32[];
  rpcUrl?: string;
}

export interface ArbLeg {
  isMultiHop: boolean;
  tickSpacing: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  path: `0x${string}`;
}

export interface ArbParams {
  legs: ArbLeg[];
  minProfit: bigint;
  deadline: bigint;
}
