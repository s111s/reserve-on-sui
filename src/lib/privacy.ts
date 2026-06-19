import type { BookingData } from "./types";

/**
 * Derive a privacy-safe commitment for on-chain storage.
 *
 * Goal: prove "user X made a reservation of type Y on date Z" without
 * revealing the exact merchant, booking ID, or time-of-day.
 *
 * commitment = SHA-256( booking_id + ":" + userAddress )
 * - Links this NFT to the off-chain record (verifiable by the dApp)
 * - Unlinkable by observers — they can't reverse the hash to get booking_id
 */
export async function buildBookingCommitment(
  bookingId: string,
  userAddress: string
): Promise<string> {
  const raw = new TextEncoder().encode(`${bookingId}:${userAddress}`);
  const buf = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fields stored on-chain (privacy-reduced subset of BookingData).
 * - No merchant name/ID (only category)
 * - No time-of-day (only date)
 * - No party size details beyond the number
 * - booking_id replaced by commitment hash
 */
export interface OnChainBookingFields {
  commitment: string;     // hash(booking_id + userAddress)
  store_type: string;     // "restaurant" | "hotel" | ...
  slot_date: string;      // "YYYY-MM-DD" only
  party_size: number;
  amount_usdc: number;    // 0 for free
  fee_label: string;
}

export async function buildOnChainFields(
  booking: BookingData,
  userAddress: string
): Promise<OnChainBookingFields> {
  const commitment = await buildBookingCommitment(booking.booking_id, userAddress);
  return {
    commitment,
    store_type: booking.merchant.type,
    slot_date: booking.slot.date,
    party_size: booking.slot.party_size,
    amount_usdc: booking.fee.has_fee ? booking.fee.amount_usdc : 0,
    fee_label: booking.fee.has_fee ? booking.fee.label : "free",
  };
}
