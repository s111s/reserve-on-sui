import { Transaction } from "@mysten/sui/transactions";
import { CONFIG } from "./config";

/** Build a PTB that calls tier::claim_tier. User must sign and execute it. */
export function buildClaimTierTx(userAddress: string): Transaction {
  if (!CONFIG.PACKAGE_ID || !CONFIG.TIER_REGISTRY_ID || !CONFIG.TIER_CONFIG_ID) {
    throw new Error("VITE_PACKAGE_ID, VITE_TIER_REGISTRY_ID, VITE_TIER_CONFIG_ID must be set");
  }
  const tx = new Transaction();
  tx.setSender(userAddress);
  tx.moveCall({
    target: `${CONFIG.PACKAGE_ID}::tier::claim_tier`,
    arguments: [
      tx.object(CONFIG.TIER_REGISTRY_ID),
      tx.object(CONFIG.TIER_CONFIG_ID),
    ],
  });
  return tx;
}
