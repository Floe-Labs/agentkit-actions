import type { EvmWalletProvider } from "@coinbase/agentkit";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { CreditClient } from "@floe/credit-sdk";
import type { CreditWallet } from "@floe/credit-sdk";

/**
 * Adapts AgentKit's EvmWalletProvider to the CreditWallet interface.
 */
function walletProviderToCreditWallet(walletProvider: EvmWalletProvider): CreditWallet {
  return {
    getAddress(): Address {
      return walletProvider.getAddress() as Address;
    },
    async sendTransaction(params: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
      const txHash = await walletProvider.sendTransaction({
        to: params.to,
        data: params.data,
        value: params.value,
      });
      await walletProvider.waitForTransactionReceipt(txHash);
      return txHash as Hex;
    },
  };
}

/**
 * Creates a CreditClient from AgentKit wallet provider and config.
 * Uses `any` for publicClient to avoid viem version mismatch between
 * agentkit-actions' viem and credit-sdk's viem (structurally identical).
 */
export function createCreditClient(
  walletProvider: EvmWalletProvider,
  config: {
    rpcUrl?: string;
    envioEndpoint?: string;
    envioApiToken?: string;
    contractAddress?: Address;
  },
): CreditClient {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(config.rpcUrl ?? "https://mainnet.base.org"),
  });

  return new CreditClient({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: publicClient as any,
    wallet: walletProviderToCreditWallet(walletProvider),
    envioEndpoint: config.envioEndpoint,
    envioApiToken: config.envioApiToken,
    contractAddress: config.contractAddress,
  });
}
