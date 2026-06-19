export type PaymentStatusType = "success" | "failed" | "free" | "promo";

export type Currency = "USDC" | "USDT" | "SuiUSD";

export const CURRENCIES: Currency[] = ["USDC", "USDT", "SuiUSD"];

export interface PaymentInfo {
  tx_hash: string;
  amount_usdc: number;  // amount in token's human-readable units (kept for back-compat)
  token: Currency | "SUI" | string;
  chain: string;
  protocol: "s402" | "x402" | string;
  refundable: boolean;
}

export interface ReceiptInfo {
  object_id: string;
  tx_hash: string;
}

// ── Points earned from a booking ──────────────────────────────
export interface PointsInfo {
  earned: number;           // points earned from this booking
  balance: number;          // user's total balance after earning
  object_id?: string;       // on-chain PointsLedger object ID (once contract exists)
}

// ── Coupon applied to a booking ───────────────────────────────
export interface CouponData {
  code: string;
  discount_type: "percentage" | "fixed_sui" | "free";
  discount_value: number;   // percentage (0–100) or SUI amount
  label?: string;           // e.g. "20% off reservation fee"
  valid_until?: string;     // ISO date string
  merchant_id?: string | null; // null = valid at any merchant
}

export interface PaymentStatus {
  status: PaymentStatusType;
  booking_id: string;
  payment: PaymentInfo | null;
  receipt: ReceiptInfo | null;
  message: string;
  error_code: string | null;
  metadata: Record<string, unknown> | null;
  // ── future features ──
  points: PointsInfo | null;
}

export const ERROR_CODES = {
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  USER_REJECTED: "USER_REJECTED",
  TX_FAILED: "TX_FAILED",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  NETWORK_ERROR: "NETWORK_ERROR",
  WALLET_NOT_CONNECTED: "WALLET_NOT_CONNECTED",
  COUPON_INVALID: "COUPON_INVALID",
  COUPON_EXPIRED: "COUPON_EXPIRED",
} as const;

export type StoreType =
  | "restaurant"
  | "hotel"
  | "cafe"
  | "spa"
  | "bar"
  | "activity"
  | "other";

export interface BookingData {
  booking_id: string;
  merchant: {
    id: string;
    name: string;
    nameLocal?: string;
    address?: string;
    image: string;
    rating?: number;
    type: StoreType;
    wallet_address?: string;  // Sui address that receives the fee
  };
  slot: {
    date: string;
    time: string;
    duration_min?: number;
    party_size: number;
  };
  fee: {
    has_fee: boolean;
    amount_usdc: number;          // original amount before coupon (in token units)
    amount_after_coupon?: number; // final amount after discount applied
    currency?: Currency;          // which stablecoin to pay with (default: USDC)
    points_redeemed?: number;     // points spent for discount
    redemption_token?: string;    // server-issued single-use token
    label: string;
    sublabel?: string;
    refundable: boolean;
    coupon?: CouponData | null;
  };
}

export interface WalletState {
  connected: boolean;
  address: string | null;
  balance_sui: string | null;
}
