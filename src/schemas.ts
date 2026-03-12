import { z } from "zod";

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const bytes32Pattern = /^0x[a-fA-F0-9]{64}$/;

const AddressSchema = z
  .string()
  .regex(addressPattern, "Must be a valid Ethereum address (0x + 40 hex chars)");

const Bytes32Schema = z
  .string()
  .regex(bytes32Pattern, "Must be a valid bytes32 (0x + 64 hex chars)");

// ── Read Action Schemas ─────────────────────────────────────────────────────

export const GetMarketsSchema = z.object({
  marketIds: z
    .array(Bytes32Schema)
    .optional()
    .describe(
      "Optional list of market IDs to query. If omitted, uses the provider's configured known market IDs. Each market represents a unique loan token + collateral token pair.",
    ),
});

export const GetLoanSchema = z.object({
  loanId: z
    .string()
    .describe(
      "The numeric ID of the loan to query. Floe loans are fixed-rate, fixed-term positions created when a lend intent and borrow intent are matched.",
    ),
});

export const GetMyLoansSchema = z.object({});

export const CheckLoanHealthSchema = z.object({
  loanId: z
    .string()
    .describe(
      "The numeric ID of the loan to check. Returns current LTV, health status, accrued interest, and distance to liquidation threshold.",
    ),
});

export const GetPriceSchema = z.object({
  collateralToken: AddressSchema.describe(
    "The collateral token address. Floe uses Chainlink + Pyth oracles for pricing.",
  ),
  loanToken: AddressSchema.describe("The loan token address."),
});

export const GetAccruedInterestSchema = z.object({
  loanId: z
    .string()
    .describe(
      "The numeric ID of the loan. Returns the interest accrued since origination and time elapsed.",
    ),
});

export const GetLiquidationQuoteSchema = z.object({
  loanId: z
    .string()
    .describe("The numeric ID of the loan to get a liquidation quote for."),
  repayAmount: z
    .string()
    .describe(
      "The amount of loan token principal to repay (in raw token units, e.g. '1000000' for 1 USDC). For full liquidation, use the loan's full principal.",
    ),
});

export const GetIntentBookSchema = z.object({
  intentHash: Bytes32Schema.describe(
    "The on-chain hash of the intent to look up.",
  ),
  intentType: z
    .enum(["lend", "borrow"])
    .describe("Whether this is a lend intent or borrow intent."),
});

// ── Write Action Schemas ────────────────────────────────────────────────────

export const PostLendIntentSchema = z.object({
  amount: z
    .string()
    .describe(
      "Total amount to lend in raw token units (e.g. '1000000000' for 1000 USDC with 6 decimals). Unlike Aave/Compound pools, this creates a fixed-rate offer that gets matched to a specific borrower.",
    ),
  minFillAmount: z
    .string()
    .describe(
      "Minimum amount per match in raw token units. Set equal to amount to require full fill.",
    ),
  minInterestRateBps: z
    .string()
    .describe(
      "Minimum acceptable annual interest rate in basis points (e.g. '500' = 5.00%). This is your floor rate — the matched loan will use at least this rate.",
    ),
  maxLtvBps: z
    .string()
    .describe(
      "Maximum LTV ratio in basis points (e.g. '8000' = 80%). This becomes the liquidation threshold on the resulting loan. Higher = more risk for the lender but more attractive to borrowers.",
    ),
  minDuration: z
    .string()
    .describe("Minimum loan duration in seconds (e.g. '86400' = 1 day)."),
  maxDuration: z
    .string()
    .describe("Maximum loan duration in seconds (e.g. '2592000' = 30 days)."),
  marketId: Bytes32Schema.describe(
    "The market ID (identifies the loan token + collateral token pair).",
  ),
  allowPartialFill: z
    .boolean()
    .default(true)
    .describe(
      "Whether the intent can be partially filled. If true, a borrower can borrow less than the full amount.",
    ),
  expirySeconds: z
    .string()
    .default("86400")
    .describe(
      "How long the intent remains valid, in seconds from now (default: 86400 = 24 hours).",
    ),
  gracePeriod: z
    .string()
    .default("86400")
    .describe(
      "Grace period in seconds after loan duration expires before overdue liquidation (default: 86400 = 24 hours). Set to '0' to use protocol default.",
    ),
  minInterestBps: z
    .string()
    .default("0")
    .describe(
      "Minimum interest as basis points of full-term interest, enforced on early repayment (0 = no minimum, 10000 = full-term interest required).",
    ),
});

export const PostBorrowIntentSchema = z.object({
  borrowAmount: z
    .string()
    .describe(
      "Amount to borrow in raw token units (e.g. '1000000' for 1 USDC). You'll need to provide collateral according to the LTV ratio.",
    ),
  collateralAmount: z
    .string()
    .describe(
      "Amount of collateral to lock in raw token units. Must satisfy the market's minimum LTV requirements. You need to approve the collateral token to the matcher contract before this intent can be matched.",
    ),
  minFillAmount: z
    .string()
    .describe(
      "Minimum borrow amount per match in raw token units. Set equal to borrowAmount to require full fill.",
    ),
  maxInterestRateBps: z
    .string()
    .describe(
      "Maximum acceptable annual interest rate in basis points (e.g. '1000' = 10.00%). This is your ceiling rate — you won't pay more than this.",
    ),
  minLtvBps: z
    .string()
    .describe(
      "Minimum LTV ratio in basis points for the actual loan (e.g. '5000' = 50%). Must be at least 800 bps (8%) below the lender's maxLtvBps.",
    ),
  minDuration: z
    .string()
    .describe("Minimum loan duration in seconds."),
  maxDuration: z
    .string()
    .describe("Maximum loan duration in seconds."),
  marketId: Bytes32Schema.describe(
    "The market ID (identifies the loan token + collateral token pair).",
  ),
  allowPartialFill: z
    .boolean()
    .default(false)
    .describe("Whether the intent can be partially filled."),
  matcherCommissionBps: z
    .string()
    .default("50")
    .describe(
      "Commission paid to the solver/matcher bot in basis points (default: 50 = 0.50%).",
    ),
  expirySeconds: z
    .string()
    .default("86400")
    .describe(
      "How long the intent remains valid, in seconds from now (default: 86400 = 24 hours).",
    ),
});

export const MatchIntentsSchema = z.object({
  lendIntentHash: Bytes32Schema.describe(
    "The on-chain hash of the lend intent to match.",
  ),
  borrowIntentHash: Bytes32Schema.describe(
    "The on-chain hash of the borrow intent to match.",
  ),
  marketId: Bytes32Schema.describe(
    "The market ID both intents must belong to.",
  ),
});

export const RepayLoanSchema = z.object({
  loanId: z
    .string()
    .describe("The numeric ID of the loan to repay."),
  repayAmount: z
    .string()
    .describe(
      "The principal amount to repay in raw token units. Use the loan's full principal for full repayment. You need to approve the loan token to the matcher contract first.",
    ),
  slippageBps: z
    .string()
    .default("500")
    .describe(
      "Slippage tolerance in basis points for maxTotalRepayment calculation (default: 500 = 5%). Accounts for interest accruing between submission and execution.",
    ),
});

export const AddCollateralSchema = z.object({
  loanId: z
    .string()
    .describe("The numeric ID of the loan to add collateral to."),
  amount: z
    .string()
    .describe(
      "Amount of collateral token to add in raw token units. You need to approve the collateral token to the matcher contract first.",
    ),
});

export const WithdrawCollateralSchema = z.object({
  loanId: z
    .string()
    .describe(
      "The numeric ID of the loan to withdraw collateral from. Only the borrower can call this.",
    ),
  amount: z
    .string()
    .describe(
      "Amount of collateral token to withdraw in raw token units. The resulting LTV must stay below the liquidation threshold minus a 3% buffer.",
    ),
});

export const LiquidateLoanSchema = z.object({
  loanId: z
    .string()
    .describe(
      "The numeric ID of the loan to liquidate. The loan must be unhealthy (currentLTV >= liquidationLTV or overdue) for liquidation to succeed.",
    ),
  repayAmount: z
    .string()
    .describe(
      "The principal amount to repay for the liquidation in raw token units. For underwater loans, full liquidation is required.",
    ),
  slippageBps: z
    .string()
    .default("500")
    .describe(
      "Slippage tolerance in basis points for maxTotalRepayment calculation (default: 500 = 5%).",
    ),
});
