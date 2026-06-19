import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { CONFIG } from "./config";
import type { Currency } from "./types";

let _client: SuiClient | null = null;

export function getSuiClient(): SuiClient {
  if (!_client) {
    _client = new SuiClient({ url: getFullnodeUrl(CONFIG.SUI_NETWORK) });
  }
  return _client;
}

export async function getCurrentEpoch(): Promise<number> {
  const state = await getSuiClient().getLatestSuiSystemState();
  return Number(state.epoch);
}

export function getCoinType(currency: Currency): string {
  switch (currency) {
    case "USDC":   return CONFIG.USDC_COIN_TYPE;
    case "USDT":   return CONFIG.USDT_COIN_TYPE;
    case "SuiUSD": return CONFIG.SUIUSD_COIN_TYPE;
  }
}

export async function getSuiBalance(address: string): Promise<string> {
  const balance = await getSuiClient().getBalance({
    owner: address,
    coinType: "0x2::sui::SUI",
  });
  return (Number(balance.totalBalance) / 1e9).toFixed(4);
}

/** Get stablecoin balance for any supported currency. Returns human-readable string (2 dp). */
export async function getStablecoinBalance(address: string, currency: Currency): Promise<string> {
  const coinType = getCoinType(currency);
  if (!coinType) return "0.00";
  try {
    const balance = await getSuiClient().getBalance({ owner: address, coinType });
    return (Number(balance.totalBalance) / 1e6).toFixed(2);
  } catch {
    return "0.00";
  }
}

/** Fetch all coin objects for a currency owned by address, sorted largest first. */
export async function getStablecoinCoins(address: string, currency: Currency) {
  const coinType = getCoinType(currency);
  if (!coinType) return [];
  const result = await getSuiClient().getCoins({ owner: address, coinType });
  return result.data.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
}

/** Fetch balances for all three stablecoins in parallel. */
export async function getAllStablecoinBalances(address: string): Promise<Record<Currency, string>> {
  const [usdc, usdt, suiusd] = await Promise.all([
    getStablecoinBalance(address, "USDC"),
    getStablecoinBalance(address, "USDT"),
    getStablecoinBalance(address, "SuiUSD"),
  ]);
  return { USDC: usdc, USDT: usdt, SuiUSD: suiusd };
}

// Back-compat aliases
export const getUsdcBalance = (address: string) => getStablecoinBalance(address, "USDC");
export const getUsdcCoins   = (address: string) => getStablecoinCoins(address, "USDC");

export async function verifyTransaction(txHash: string): Promise<{ success: boolean }> {
  try {
    const result = await getSuiClient().getTransactionBlock({
      digest: txHash,
      options: { showEffects: true },
    });
    return { success: result.effects?.status.status === "success" };
  } catch {
    return { success: false };
  }
}
