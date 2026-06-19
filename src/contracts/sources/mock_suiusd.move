/// Mock SuiUSD for Sui testnet development.
/// Identical structure to mock_usdc — shared TreasuryCap for open faucet access.
module agentic_booking::mock_suiusd {
    use sui::coin::{Self, TreasuryCap};

    public struct MOCK_SUIUSD has drop {}

    fun init(witness: MOCK_SUIUSD, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            6,
            b"SuiUSD",
            b"Sui USD",
            b"Mock SuiUSD for Sui testnet development",
            option::none(),
            ctx,
        );
        transfer::public_share_object(treasury_cap);
        transfer::public_freeze_object(metadata);
    }

    /// Mint mock SuiUSD to any address. `amount` is in micro-SuiUSD (1 SuiUSD = 1_000_000).
    public entry fun faucet(
        treasury_cap: &mut TreasuryCap<MOCK_SUIUSD>,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        coin::mint_and_transfer(treasury_cap, amount, recipient, ctx);
    }
}
