/// Mock USDC for Sui testnet development.
/// There is no official USDC faucet on testnet — this is a stand-in.
/// TreasuryCap is shared so anyone can call faucet() directly,
/// and the server-side /api/faucet/usdc endpoint uses it too.
module agentic_booking::mock_usdc {
    use sui::coin::{Self, TreasuryCap};

    public struct MOCK_USDC has drop {}

    fun init(witness: MOCK_USDC, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            6,                          // decimals — same as real USDC
            b"USDC",
            b"USD Coin",
            b"Mock USDC for Sui testnet development",
            option::none(),
            ctx,
        );
        // Share so the faucet function is callable by anyone (testnet only pattern)
        transfer::public_share_object(treasury_cap);
        transfer::public_freeze_object(metadata);
    }

    /// Mint mock USDC to any address. `amount` is in micro-USDC (1 USDC = 1_000_000).
    public entry fun faucet(
        treasury_cap: &mut TreasuryCap<MOCK_USDC>,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        coin::mint_and_transfer(treasury_cap, amount, recipient, ctx);
    }
}
