import { FloeActionProvider } from "./floeActionProvider.js";
import type { FloeConfig } from "./types.js";

export const floeActionProvider = (config?: Partial<FloeConfig>) =>
  new FloeActionProvider(config);

export { FloeActionProvider } from "./floeActionProvider.js";
export { X402ActionProvider, x402ActionProvider } from "./x402ActionProvider.js";
export type { FloeConfig } from "./types.js";
export type { X402Config } from "./x402ActionProvider.js";
export * from "./schemas.js";
