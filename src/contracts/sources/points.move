module agentic_booking::points {
    use sui::table::{Self, Table};
    use sui::event;
    use std::string::String;

    // ── Constants ──────────────────────────────────────────────────
    const POINTS_PER_MICRO: u64 = 10;        // 10 pts per 1 token (1_000_000 micro)
    const MICRO_PER_TOKEN: u64 = 1_000_000;
    const FREE_BOOKING_POINTS: u64 = 1;
    const POINTS_PER_DISCOUNT: u64 = 100;    // 100 pts = 1 token discount

    // ── Errors ─────────────────────────────────────────────────────
    const EInsufficientPoints: u64 = 1;
    const EBelowMinimum: u64 = 2;

    // ── Shared ledger — one object for the whole platform ──────────
    public struct PointsLedger has key {
        id: UID,
        balances: Table<address, u64>,
        total_issued: u64,
        total_redeemed: u64,
    }

    // ── Operator capability — held by deployer/server to spend on behalf of users ──
    public struct OperatorCap has key, store {
        id: UID,
    }

    // ── Voucher: proof of redemption, burned on use ────────────────
    public struct PointsVoucher has key, store {
        id: UID,
        owner: address,
        points: u64,
        discount_micro: u64,   // token units saved (points / POINTS_PER_DISCOUNT * MICRO_PER_TOKEN)
    }

    // ── Events ─────────────────────────────────────────────────────
    public struct PointsEarned has copy, drop {
        user: address,
        points: u64,
        new_balance: u64,
    }

    public struct PointsRedeemed has copy, drop {
        user: address,
        points: u64,
        discount_micro: u64,
    }

    public struct RewardRedeemed has copy, drop {
        user: address,
        points_spent: u64,
        reward_id: String,
        new_balance: u64,
    }

    // ── Init: create shared PointsLedger + transfer OperatorCap to deployer ──
    fun init(ctx: &mut TxContext) {
        let ledger = PointsLedger {
            id: object::new(ctx),
            balances: table::new(ctx),
            total_issued: 0,
            total_redeemed: 0,
        };
        transfer::share_object(ledger);
        transfer::transfer(OperatorCap { id: object::new(ctx) }, tx_context::sender(ctx));
    }

    // ── Earn: called by booking::mint_receipt ──────────────────────
    // amount_micro = 0 means free booking → awards FREE_BOOKING_POINTS
    public fun earn(
        ledger: &mut PointsLedger,
        user: address,
        amount_micro: u64,
        ctx: &TxContext,
    ) {
        let _ = ctx;
        let pts = if (amount_micro == 0) {
            FREE_BOOKING_POINTS
        } else {
            (amount_micro / MICRO_PER_TOKEN) * POINTS_PER_MICRO
        };

        if (!table::contains(&ledger.balances, user)) {
            table::add(&mut ledger.balances, user, pts);
        } else {
            let bal = table::borrow_mut(&mut ledger.balances, user);
            *bal = *bal + pts;
        };

        ledger.total_issued = ledger.total_issued + pts;

        let new_balance = *table::borrow(&ledger.balances, user);
        event::emit(PointsEarned { user, points: pts, new_balance });
    }

    // ── Redeem: deduct points, return a PointsVoucher ─────────────
    public fun redeem(
        ledger: &mut PointsLedger,
        points: u64,
        ctx: &mut TxContext,
    ): PointsVoucher {
        assert!(points >= POINTS_PER_DISCOUNT, EBelowMinimum);

        let user = tx_context::sender(ctx);
        assert!(table::contains(&ledger.balances, user), EInsufficientPoints);

        let bal = table::borrow_mut(&mut ledger.balances, user);
        assert!(*bal >= points, EInsufficientPoints);
        *bal = *bal - points;

        ledger.total_redeemed = ledger.total_redeemed + points;

        let discount_micro = (points / POINTS_PER_DISCOUNT) * MICRO_PER_TOKEN;
        event::emit(PointsRedeemed { user, points, discount_micro });

        PointsVoucher {
            id: object::new(ctx),
            owner: user,
            points,
            discount_micro,
        }
    }

    // ── Burn voucher after applying discount ───────────────────────
    public fun burn_voucher(voucher: PointsVoucher) {
        let PointsVoucher { id, owner: _, points: _, discount_micro: _ } = voucher;
        object::delete(id);
    }

    // ── User self-service redemption: user deducts their own points for a catalog reward ──
    // User is the tx sender — gas sponsored by server via Shinami.
    public entry fun user_redeem_reward(
        ledger: &mut PointsLedger,
        points: u64,
        reward_id: String,
        ctx: &mut TxContext,
    ) {
        let user = tx_context::sender(ctx);
        assert!(table::contains(&ledger.balances, user), EInsufficientPoints);
        let bal = table::borrow_mut(&mut ledger.balances, user);
        assert!(*bal >= points, EInsufficientPoints);
        *bal = *bal - points;
        ledger.total_redeemed = ledger.total_redeemed + points;
        let new_balance = *bal;
        event::emit(RewardRedeemed { user, points_spent: points, reward_id, new_balance });
    }

    // ── One-time setup: create OperatorCap and transfer to caller (deployer) ──
    // Called once after upgrade since init() doesn't re-run on upgrade.
    public entry fun create_operator_cap(ctx: &mut TxContext) {
        transfer::transfer(OperatorCap { id: object::new(ctx) }, tx_context::sender(ctx));
    }

    // ── Operator spend: server deducts points for catalog reward redemption ──
    // Requires OperatorCap so only the deployer/server can call this.
    public fun operator_spend_for_reward(
        _cap: &OperatorCap,
        ledger: &mut PointsLedger,
        user: address,
        points: u64,
        reward_id: String,
        _ctx: &mut TxContext,
    ) {
        assert!(table::contains(&ledger.balances, user), EInsufficientPoints);
        let bal = table::borrow_mut(&mut ledger.balances, user);
        assert!(*bal >= points, EInsufficientPoints);
        *bal = *bal - points;
        ledger.total_redeemed = ledger.total_redeemed + points;
        let new_balance = *bal;
        event::emit(RewardRedeemed { user, points_spent: points, reward_id, new_balance });
    }

    // ── Read helpers ───────────────────────────────────────────────
    public fun balance(ledger: &PointsLedger, user: address): u64 {
        if (table::contains(&ledger.balances, user)) {
            *table::borrow(&ledger.balances, user)
        } else {
            0
        }
    }

    public fun voucher_discount_micro(v: &PointsVoucher): u64 { v.discount_micro }
    public fun voucher_points(v: &PointsVoucher): u64 { v.points }
    public fun total_issued(ledger: &PointsLedger): u64 { ledger.total_issued }
    public fun total_redeemed(ledger: &PointsLedger): u64 { ledger.total_redeemed }
}
