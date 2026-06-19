module agentic_booking::tier {
    use sui::table::{Self, Table};
    use sui::event;

    const ENotEligible: u64 = 1;
    const EInvalidTier: u64 = 3;

    public struct AdminCap has key, store { id: UID }

    public struct TierConfig has key {
        id: UID,
        quartz_threshold:       u64,
        sapphire_threshold:     u64,
        emerald_threshold:      u64,
        black_diamond_threshold: u64,
    }

    public struct TierRegistry has key {
        id: UID,
        booking_counts: Table<address, u64>,
        claimed_tiers:  Table<address, u8>,
    }

    /// Soul-bound badge (key only, no store = non-transferable outside this module)
    public struct TierClaim has key {
        id: UID,
        owner: address,
        tier: u8,
        booking_count_at_claim: u64,
        claimed_at: u64,
    }

    public struct BookingRecorded  has copy, drop { user: address, booking_count: u64 }
    public struct TierClaimMinted  has copy, drop { user: address, tier: u8, object_id: ID, booking_count: u64 }
    public struct ThresholdUpdated has copy, drop { tier: u8, old_value: u64, new_value: u64, updated_by: address }
    public struct TierGranted      has copy, drop { user: address, tier: u8, granted_by: address }

    fun init(ctx: &mut TxContext) {
        let deployer = ctx.sender();
        transfer::transfer(AdminCap { id: object::new(ctx) }, deployer);
        transfer::share_object(TierConfig {
            id: object::new(ctx),
            quartz_threshold:        1,
            sapphire_threshold:      5,
            emerald_threshold:       15,
            black_diamond_threshold: 30,
        });
        transfer::share_object(TierRegistry {
            id: object::new(ctx),
            booking_counts: table::new(ctx),
            claimed_tiers:  table::new(ctx),
        });
    }

    public fun set_threshold(_cap: &AdminCap, config: &mut TierConfig, tier: u8, new_value: u64, ctx: &TxContext) {
        assert!(tier >= 1 && tier <= 4, EInvalidTier);
        let old_value = if (tier == 1) {
            let old = config.quartz_threshold; config.quartz_threshold = new_value; old
        } else if (tier == 2) {
            let old = config.sapphire_threshold; config.sapphire_threshold = new_value; old
        } else if (tier == 3) {
            let old = config.emerald_threshold; config.emerald_threshold = new_value; old
        } else {
            let old = config.black_diamond_threshold; config.black_diamond_threshold = new_value; old
        };
        event::emit(ThresholdUpdated { tier, old_value, new_value, updated_by: ctx.sender() });
    }

    public fun record_booking(registry: &mut TierRegistry, user: address) {
        let count = if (table::contains(&registry.booking_counts, user)) {
            let c = table::borrow_mut(&mut registry.booking_counts, user);
            *c = *c + 1; *c
        } else {
            table::add(&mut registry.booking_counts, user, 1); 1
        };
        event::emit(BookingRecorded { user, booking_count: count });
    }

    /// Claims tiers in order: Quartz → Sapphire → Emerald → Black Diamond.
    public fun claim_tier(registry: &mut TierRegistry, config: &TierConfig, ctx: &mut TxContext) {
        let user = ctx.sender();
        let count = booking_count(registry, user);
        let current_tier = tier_from_count(count, config);
        let highest_claimed = highest_claimed_tier(registry, user);
        let next = highest_claimed + 1;
        assert!(next >= 1 && next <= 4, EInvalidTier);
        assert!(next <= current_tier, ENotEligible);
        if (table::contains(&registry.claimed_tiers, user)) {
            *table::borrow_mut(&mut registry.claimed_tiers, user) = next;
        } else {
            table::add(&mut registry.claimed_tiers, user, next);
        };
        let claim_id = object::new(ctx);
        let oid = object::uid_to_inner(&claim_id);
        transfer::transfer(
            TierClaim { id: claim_id, owner: user, tier: next, booking_count_at_claim: count, claimed_at: ctx.epoch() },
            user,
        );
        event::emit(TierClaimMinted { user, tier: next, object_id: oid, booking_count: count });
    }

    /// Admin: directly grant a tier to any address (invitation / partner fast-track).
    /// Sets booking_count to the tier's minimum threshold (if currently lower) so
    /// the on-chain state is fully consistent, then marks claimed_tiers = tier.
    /// Only promotes — never downgrades an existing higher tier.
    public fun admin_grant_tier(
        _cap: &AdminCap,
        registry: &mut TierRegistry,
        config: &TierConfig,
        user: address,
        tier: u8,
        ctx: &TxContext,
    ) {
        assert!(tier >= 1 && tier <= 4, EInvalidTier);

        let threshold = if (tier == 1)      { config.quartz_threshold }
            else if (tier == 2) { config.sapphire_threshold }
            else if (tier == 3) { config.emerald_threshold }
            else                { config.black_diamond_threshold };

        // Bump booking count to threshold if below it
        if (table::contains(&registry.booking_counts, user)) {
            let c = table::borrow_mut(&mut registry.booking_counts, user);
            if (*c < threshold) { *c = threshold; };
        } else {
            table::add(&mut registry.booking_counts, user, threshold);
        };

        // Grant tier (only if higher than current)
        if (table::contains(&registry.claimed_tiers, user)) {
            let current = *table::borrow(&registry.claimed_tiers, user);
            if (tier > current) {
                *table::borrow_mut(&mut registry.claimed_tiers, user) = tier;
            };
        } else {
            table::add(&mut registry.claimed_tiers, user, tier);
        };

        event::emit(TierGranted { user, tier, granted_by: ctx.sender() });
    }

    public fun booking_count(registry: &TierRegistry, user: address): u64 {
        if (table::contains(&registry.booking_counts, user)) { *table::borrow(&registry.booking_counts, user) } else { 0 }
    }
    public fun highest_claimed_tier(registry: &TierRegistry, user: address): u8 {
        if (table::contains(&registry.claimed_tiers, user)) { *table::borrow(&registry.claimed_tiers, user) } else { 0 }
    }
    public fun tier_of(registry: &TierRegistry, config: &TierConfig, user: address): u8 {
        tier_from_count(booking_count(registry, user), config)
    }
    public fun unclaimed_tier(registry: &TierRegistry, config: &TierConfig, user: address): u8 {
        let current = tier_from_count(booking_count(registry, user), config);
        let claimed = highest_claimed_tier(registry, user);
        if (current > claimed) { claimed + 1 } else { 0 }
    }

    public fun quartz_threshold(config: &TierConfig): u64       { config.quartz_threshold }
    public fun sapphire_threshold(config: &TierConfig): u64     { config.sapphire_threshold }
    public fun emerald_threshold(config: &TierConfig): u64      { config.emerald_threshold }
    public fun black_diamond_threshold(config: &TierConfig): u64 { config.black_diamond_threshold }
    public fun claim_tier_level(c: &TierClaim): u8              { c.tier }
    public fun claim_owner(c: &TierClaim): address              { c.owner }

    fun tier_from_count(count: u64, config: &TierConfig): u8 {
        if      (config.black_diamond_threshold > 0 && count >= config.black_diamond_threshold) { 4 }
        else if (config.emerald_threshold       > 0 && count >= config.emerald_threshold)       { 3 }
        else if (config.sapphire_threshold      > 0 && count >= config.sapphire_threshold)      { 2 }
        else if (config.quartz_threshold        > 0 && count >= config.quartz_threshold)        { 1 }
        else { 0 }
    }
}
