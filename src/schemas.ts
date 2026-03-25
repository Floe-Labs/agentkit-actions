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

// ── Flash Loan Action Schemas ─────────────────────────────────────────────

export const GetFlashLoanFeeSchema = z.object({});

export const EstimateFlashArbProfitSchema = z.object({
  token: AddressSchema.describe(
    "The token to flash-borrow. This is the token you start and end with (e.g. USDC address for a USDC-based arb).",
  ),
  amount: z
    .string()
    .describe(
      "The amount to flash-borrow in raw token units (e.g. '1000000000' for 1000 USDC with 6 decimals).",
    ),
  legs: z
    .array(
      z.object({
        tokenIn: AddressSchema.describe("Input token address for this swap leg."),
        tokenOut: AddressSchema.describe("Output token address for this swap leg."),
        tickSpacing: z
          .number()
          .describe(
            "Aerodrome pool tick spacing (e.g. 1, 100, 200). Ignored for multi-hop legs.",
          ),
        amountOutMin: z
          .string()
          .default("0")
          .describe(
            "Minimum output for this leg in raw units. Use '0' to skip slippage check on estimates.",
          ),
      }),
    )
    .min(1)
    .describe(
      "Ordered array of swap legs. Each leg swaps tokenIn -> tokenOut via Aerodrome Slipstream. The output of each leg feeds into the next.",
    ),
});

export const FlashLoanSchema = z.object({
  token: AddressSchema.describe(
    "The token to flash-borrow from Floe's lending pool.",
  ),
  amount: z
    .string()
    .describe("The amount to flash-borrow in raw token units."),
  callbackData: z
    .string()
    .describe(
      "ABI-encoded bytes to pass to the receiver's receiveFlashLoan callback. The receiver contract interprets this data to execute its strategy.",
    ),
});

export const FlashArbSchema = z.object({
  token: AddressSchema.describe(
    "The token to flash-borrow for the arbitrage (e.g. USDC, WETH).",
  ),
  amount: z
    .string()
    .describe("The amount to flash-borrow in raw token units."),
  receiverAddress: AddressSchema.optional().describe(
    "The deployed FlashArbReceiver contract address. If omitted, uses the address from the most recent deploy_flash_arb_receiver call in this session.",
  ),
  legs: z
    .array(
      z.object({
        tokenIn: AddressSchema.describe("Input token for this swap leg."),
        tokenOut: AddressSchema.describe("Output token for this swap leg."),
        tickSpacing: z
          .number()
          .describe(
            "Aerodrome pool tick spacing (e.g. 1, 100, 200). Use 0 for multi-hop legs.",
          ),
        amountIn: z
          .string()
          .default("0")
          .describe(
            "Amount of tokenIn to swap. Use '0' to swap entire balance held by the receiver (useful for legs after the first).",
          ),
        minAmountOut: z
          .string()
          .default("0")
          .describe(
            "Minimum acceptable output (slippage protection). Use '0' with caution.",
          ),
        isMultiHop: z
          .boolean()
          .default(false)
          .describe(
            "If true, uses multi-hop routing with the encoded path.",
          ),
        path: z
          .string()
          .default("0x")
          .describe(
            "ABI-encoded multi-hop path for Aerodrome exactInput. Only used when isMultiHop is true.",
          ),
      }),
    )
    .min(1)
    .describe(
      "Ordered array of swap legs for the arbitrage route. The output of each leg feeds into the next. Final leg must output the flash-borrowed token.",
    ),
  minProfit: z
    .string()
    .default("0")
    .describe(
      "Minimum profit in raw token units after repaying the flash loan + fee. Transaction reverts if not met. Use '0' for no minimum (not recommended for production).",
    ),
  deadline: z
    .string()
    .optional()
    .describe(
      "Unix timestamp after which the swap transactions revert. Defaults to 5 minutes from now.",
    ),
});

export const GetFlashArbBalanceSchema = z.object({
  token: AddressSchema.describe(
    "The ERC20 token address to check the balance of.",
  ),
  receiverAddress: AddressSchema.optional().describe(
    "The FlashArbReceiver contract address to check the balance for. If omitted, uses the address from the most recent deploy_flash_arb_receiver call in this session.",
  ),
});

// ── Deploy / Verify / Readiness Schemas ──────────────────────────────────

export const DeployFlashArbReceiverSchema = z.object({});

export const CheckFlashArbReadinessSchema = z.object({
  receiverAddress: AddressSchema.optional().describe(
    "Optional FlashArbReceiver address. If provided, also verifies the receiver's immutables and owner.",
  ),
});

export const VerifyFlashArbReceiverSchema = z.object({
  receiverAddress: AddressSchema.optional().describe(
    "The FlashArbReceiver contract address to verify. If omitted, uses the address from the most recent deploy_flash_arb_receiver call in this session.",
  ),
});

// ── Credit Facility Action Schemas ────────────────────────────────────────

export const RequestCreditSchema = z.object({
  marketId: Bytes32Schema.describe(
    "The market ID to search for available credit offers.",
  ),
  minAmount: z
    .string()
    .optional()
    .describe(
      "Minimum remaining amount in raw token units. Filters out small offers.",
    ),
  maxRateBps: z
    .string()
    .optional()
    .describe(
      "Maximum acceptable interest rate in basis points. Only shows offers at or below this rate.",
    ),
  maxResults: z
    .number()
    .default(10)
    .describe("Maximum number of offers to return (default: 10)."),
});

export const ManualMatchCreditSchema = z.object({
  lendIntentHash: Bytes32Schema.describe(
    "The on-chain hash of the lend intent to match against (from request_credit results).",
  ),
  borrowAmount: z.string().describe("Amount to borrow in raw token units."),
  collateralAmount: z
    .string()
    .describe("Collateral to post in raw token units."),
  maxInterestRateBps: z
    .string()
    .describe(
      "Maximum acceptable annual interest rate in basis points.",
    ),
  minLtvBps: z
    .string()
    .describe("Minimum LTV ratio in basis points for the loan."),
  duration: z.string().describe("Loan duration in seconds."),
  marketId: Bytes32Schema.describe("Market ID for the credit facility."),
  matcherCommissionBps: z
    .string()
    .default("50")
    .describe(
      "Commission for the matcher in basis points (default: 50 = 0.50%).",
    ),
  expirySeconds: z
    .string()
    .default("300")
    .describe(
      "Borrow intent validity in seconds (default: 300 = 5 min, short since it's immediately matched).",
    ),
});

export const CheckCreditStatusSchema = z.object({
  loanId: z
    .string()
    .describe("The loan ID of the credit facility to check."),
});

export const RepayCreditSchema = z.object({
  loanId: z
    .string()
    .describe("The loan ID of the credit facility to repay."),
  slippageBps: z
    .string()
    .default("500")
    .describe(
      "Slippage tolerance in basis points for interest accrual between submission and execution (default: 500 = 5%).",
    ),
});

export const RenewCreditLineSchema = z.object({
  loanId: z.string().describe("The existing loan ID to repay."),
  lendIntentHash: Bytes32Schema.describe(
    "The lend intent hash to match for the new credit line.",
  ),
  borrowAmount: z
    .string()
    .describe("New borrow amount in raw token units."),
  collateralAmount: z
    .string()
    .describe("New collateral amount in raw token units."),
  maxInterestRateBps: z
    .string()
    .describe("Max interest rate for the new loan in basis points."),
  minLtvBps: z
    .string()
    .describe("Min LTV for the new loan in basis points."),
  duration: z.string().describe("New loan duration in seconds."),
  marketId: Bytes32Schema.describe("Market ID for the new credit line."),
  matcherCommissionBps: z.string().default("50"),
  slippageBps: z
    .string()
    .default("500")
    .describe("Slippage for the repayment step."),
});
