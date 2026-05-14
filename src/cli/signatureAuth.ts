/**
 * Wallet-signature auth headers for the Floe Developer API.
 *
 * The Floe API accepts three credential types on /v1/developer/agents
 * and related routes: dashboard JWT cookie, JWT header, or a wallet
 * message signature. The SDK uses the signature path so users don't
 * have to obtain a developer (`floe_live_*`) key first — their wallet
 * private key is sufficient.
 *
 * Message format MUST match middleware/auth.ts:47 in the API:
 *   "Floe Credit API\nTimestamp: <unix-seconds>"
 * The 5-minute drift tolerance is enforced server-side.
 */
import type { EvmWalletProvider } from "@coinbase/agentkit";

const MESSAGE_PREFIX = "Floe Credit API\nTimestamp: ";

export async function buildAuthHeaders(
  walletProvider: EvmWalletProvider,
): Promise<Record<string, string>> {
  const address = await walletProvider.getAddress();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${MESSAGE_PREFIX}${timestamp}`;
  const signature = await walletProvider.signMessage(message);
  return {
    "X-Wallet-Address": address,
    "X-Signature": signature,
    "X-Timestamp": timestamp,
    "Content-Type": "application/json",
  };
}
