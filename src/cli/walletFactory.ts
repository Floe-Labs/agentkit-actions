import { ViemWalletProvider } from "@coinbase/agentkit";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export type WalletType = "private-key" | "cdp";

export interface PrivateKeyWalletConfig {
  type: "private-key";
  privateKey: string;
  rpcUrl?: string;
}

export interface CdpWalletConfig {
  type: "cdp";
  apiKeyName: string;
  apiKeyPrivateKey: string;
}

export type WalletConfig = PrivateKeyWalletConfig | CdpWalletConfig;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createWallet(config: WalletConfig): Promise<any> {
  switch (config.type) {
    case "private-key":
      return createPrivateKeyWallet(config.privateKey, config.rpcUrl);
    case "cdp":
      return createCdpWallet(config.apiKeyName, config.apiKeyPrivateKey);
  }
}

/**
 * ViemWalletProvider hardcodes `http()` (no URL) for its internal publicClient,
 * which always hits the chain's default public RPC. This subclass overrides
 * readContract to use the custom RPC URL the user provided.
 */
class CustomViemWalletProvider extends ViemWalletProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private customPublicClient: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(walletClient: any, rpcUrl?: string) {
    super(walletClient);
    this.customPublicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async readContract(params: any): Promise<any> {
    return this.customPublicClient.readContract(params);
  }
}

async function createPrivateKeyWallet(privateKey: string, rpcUrl?: string) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });
  return new CustomViemWalletProvider(walletClient, rpcUrl);
}

async function createCdpWallet(apiKeyName: string, apiKeyPrivateKey: string) {
  const { CdpWalletProvider } = await import("@coinbase/agentkit");
  const fs = await import("fs");
  const path = await import("path");

  const walletDataFile = path.resolve(process.cwd(), ".wallet-data.json");
  const savedWalletData = fs.existsSync(walletDataFile)
    ? fs.readFileSync(walletDataFile, "utf-8")
    : undefined;

  const walletProvider = await CdpWalletProvider.configureWithWallet({
    apiKeyName,
    apiKeyPrivateKey,
    networkId: "base-mainnet",
    cdpWalletData: savedWalletData,
  });

  // Persist wallet data for reuse
  const walletData = await walletProvider.exportWallet();
  fs.writeFileSync(walletDataFile, JSON.stringify(walletData));

  return walletProvider;
}
