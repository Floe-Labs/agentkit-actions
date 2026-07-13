import { FloeActionProvider } from "./floeActionProvider.js";
import type { FloeConfig } from "./types.js";

export const floeActionProvider = (config?: Partial<FloeConfig>) =>
  new FloeActionProvider(config);

export { FloeActionProvider } from "./floeActionProvider.js";
export {
  X402ActionProvider,
  x402ActionProvider,
  GrantCreditDelegationSchema,
  RevokeCreditDelegationSchema,
  CheckCreditDelegationSchema,
  X402FetchSchema,
  X402GetBalanceSchema,
  X402AwaitSettlementSchema,
  X402GetTransactionsSchema,
  SetAllowlistModeSchema,
  GetAllowlistModeSchema,
  AddAllowlistEntrySchema,
  RemoveAllowlistEntrySchema,
  ListAllowlistSchema,
  ListInferenceModelsSchema,
  EstimateInferenceCostSchema,
} from "./x402ActionProvider.js";
export type { FloeConfig } from "./types.js";
export type { X402Config } from "./x402ActionProvider.js";
export * from "./schemas.js";

// High-level runtime client. No wallet, no chain knowledge — `floe_*` key only.
export {
  FloeAgent,
  FloeAgentError,
} from "./floeAgent.js";
export type {
  FloeAgentClientConfig,
  X402FetchInput,
  FetchResult,
  X402FetchResult, // deprecated alias for FetchResult
  BalanceResult,
  TransactionsResult,
} from "./floeAgent.js";
