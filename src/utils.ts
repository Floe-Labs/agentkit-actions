import type { EvmWalletProvider } from "@coinbase/agentkit";
import { KNOWN_TOKENS, ERC20_ABI, ORACLE_PRICE_SCALE, BASIS_POINTS } from "./constants.js";
import type { Address } from "./types.js";

export function formatBps(bps: bigint): string {
  const percent = Number(bps) / 100;
  return `${percent.toFixed(2)}%`;
}

export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  symbol?: string,
): string {
  const divisor = 10 ** decimals;
  const value = Number(amount) / divisor;
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.min(decimals, 8),
  });
  return symbol ? `${formatted} ${symbol}` : formatted;
}

export function formatDuration(seconds: bigint): string {
  const s = Number(seconds);
  if (s < 60) return `${s} seconds`;
  if (s < 3600) return `${Math.floor(s / 60)} minutes`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours`;
  const days = Math.floor(s / 86400);
  return days === 1 ? "1 day" : `${days} days`;
}

export function formatTimestamp(ts: bigint): string {
  if (ts === 0n) return "N/A";
  return new Date(Number(ts) * 1000).toUTCString();
}

export function formatAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatPrice(price: bigint, scale: bigint = ORACLE_PRICE_SCALE): string {
  const value = Number(price) / Number(scale);
  if (value >= 1) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }
  return value.toFixed(8);
}

export async function resolveTokenMeta(
  address: Address,
  walletProvider: EvmWalletProvider,
): Promise<{ symbol: string; decimals: number }> {
  const lower = address.toLowerCase();
  const known = KNOWN_TOKENS[lower] ?? KNOWN_TOKENS[address];
  if (known) return known;

  try {
    const [symbol, decimals] = await Promise.all([
      walletProvider.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "symbol",
        args: [],
      }) as Promise<string>,
      walletProvider.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "decimals",
        args: [],
      }) as Promise<number>,
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return { symbol: formatAddress(address), decimals: 18 };
  }
}

export function computeHealthPercent(
  currentLtvBps: bigint,
  liquidationLtvBps: bigint,
): string {
  if (liquidationLtvBps === 0n) return "N/A";
  const health = Number(liquidationLtvBps - currentLtvBps) / Number(liquidationLtvBps) * 100;
  return `${health.toFixed(1)}%`;
}
