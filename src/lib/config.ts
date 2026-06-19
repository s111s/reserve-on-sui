export const CONFIG = {
  SUI_NETWORK: (import.meta.env.VITE_SUI_NETWORK || "testnet") as
    | "devnet"
    | "testnet"
    | "mainnet",

  PACKAGE_ID: import.meta.env.VITE_PACKAGE_ID || "",

  // Original (v1) package ID — coin types are permanently pinned to the package that first defined them
  COIN_PACKAGE_ID: import.meta.env.VITE_COIN_PACKAGE_ID || import.meta.env.VITE_PACKAGE_ID || "",

  // Shared PointsLedger object ID — set after republishing with points.move
  POINTS_LEDGER_ID: import.meta.env.VITE_POINTS_LEDGER_ID || "",

  // Shared TierRegistry object ID — set after republishing with tier.move
  TIER_REGISTRY_ID: import.meta.env.VITE_TIER_REGISTRY_ID || "",

  // Shared TierConfig object ID — admin-configurable thresholds
  TIER_CONFIG_ID: import.meta.env.VITE_TIER_CONFIG_ID || "",

  // Platform-level fee receiver — used when merchant.wallet_address is not set
  FEE_RECEIVER_ADDRESS: import.meta.env.VITE_FEE_RECEIVER_ADDRESS || "",

  // zkLogin via Shinami
  GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID || "",

  get USDC_COIN_TYPE(): string {
    return this.COIN_PACKAGE_ID ? `${this.COIN_PACKAGE_ID}::mock_usdc::MOCK_USDC` : "";
  },
  get USDT_COIN_TYPE(): string {
    return this.COIN_PACKAGE_ID ? `${this.COIN_PACKAGE_ID}::mock_usdt::MOCK_USDT` : "";
  },
  get SUIUSD_COIN_TYPE(): string {
    return this.COIN_PACKAGE_ID ? `${this.COIN_PACKAGE_ID}::mock_suiusd::MOCK_SUIUSD` : "";
  },

  SUI_FULLNODE_URLS: {
    devnet: "https://fullnode.devnet.sui.io:443",
    testnet: "https://fullnode.testnet.sui.io:443",
    mainnet: "https://fullnode.mainnet.sui.io:443",
  } as const,

  get SUI_FULLNODE() {
    return this.SUI_FULLNODE_URLS[this.SUI_NETWORK];
  },
};
