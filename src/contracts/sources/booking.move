module agentic_booking::booking {
    use std::string::String;
    use agentic_booking::points::{Self, PointsLedger};
    use agentic_booking::tier::{Self, TierRegistry};

    /// On-chain proof of a reservation.
    /// Privacy-safe: no raw booking ID or merchant name stored.
    /// commitment = SHA-256(booking_id + ":" + userAddress) — verifiable off-chain.
    public struct BookingReceipt has key, store {
        id: UID,
        commitment: String,   // SHA-256(booking_id + userAddress)
        store_type: String,   // "restaurant" | "hotel" | "cafe" | "spa" | "bar" | "activity" | "other"
        slot_date: String,    // "YYYY-MM-DD" only — no time-of-day
        party_size: u8,
        amount_micro: u64,    // fee paid in smallest token unit (1 token = 1_000_000), 0 if free
        currency: String,     // "USDC" | "USDT" | "SuiUSD"
        fee_label: String,    // "Reservation fee" | "Free" | promo label
        created_at: u64,      // epoch number
    }

    public struct BookingCreated has copy, drop {
        commitment: String,
        store_type: String,
        user: address,
        amount_micro: u64,
        currency: String,
    }

    public fun mint_receipt(
        commitment: String,
        store_type: String,
        slot_date: String,
        party_size: u8,
        amount_micro: u64,
        currency: String,
        fee_label: String,
        ledger: &mut PointsLedger,
        tier_registry: &mut TierRegistry,
        ctx: &mut TxContext,
    ): BookingReceipt {
        let user = tx_context::sender(ctx);

        points::earn(ledger, user, amount_micro, ctx);
        tier::record_booking(tier_registry, user);

        let receipt = BookingReceipt {
            id: object::new(ctx),
            commitment,
            store_type,
            slot_date,
            party_size,
            amount_micro,
            currency,
            fee_label,
            created_at: tx_context::epoch(ctx),
        };

        sui::event::emit(BookingCreated {
            commitment: receipt.commitment,
            store_type: receipt.store_type,
            user,
            amount_micro,
            currency: receipt.currency,
        });

        receipt
    }

    public fun commitment(r: &BookingReceipt): &String { &r.commitment }
    public fun store_type(r: &BookingReceipt): &String { &r.store_type }
    public fun amount_micro(r: &BookingReceipt): u64 { r.amount_micro }
    public fun currency(r: &BookingReceipt): &String { &r.currency }

    public fun burn(receipt: BookingReceipt) {
        let BookingReceipt { id, commitment: _, store_type: _, slot_date: _, party_size: _, amount_micro: _, currency: _, fee_label: _, created_at: _ } = receipt;
        object::delete(id);
    }
}
