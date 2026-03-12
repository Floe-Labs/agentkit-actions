import { FloeActionProvider } from "./floeActionProvider.js";
import type { FloeConfig } from "./types.js";

export const floeActionProvider = (config?: Partial<FloeConfig>) =>
  new FloeActionProvider(config);

export { FloeActionProvider } from "./floeActionProvider.js";
export type { FloeConfig } from "./types.js";
export * from "./schemas.js";
