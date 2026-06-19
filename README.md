# Reserve on Sui — Privacy-First Restaurant Booking on Sui

> **Sui Overflow 2026 Hackathon** · Reserve on Sui

Book a restaurant through Google Maps. Pay the deposit in stablecoin. Your wallet is never linked to your name.

---

## The Problem

When you reserve a table online today, you hand over three things at once: your **identity** (name, phone, email), your **payment details**, and your **location history** — all tied together in one record. Booking platforms and restaurants accumulate a permanent, linkable profile of where you eat, when, and with how many people.

Worse, if you use a crypto wallet to pay, your public address is also added to that profile — and wallet addresses are traceable across every transaction you've ever made.

**Nobody should have to choose between a convenient reservation and their privacy.**

---

## What Reserve on Sui Does

Reserve on Sui connects the Google Maps "Reserve" button to a privacy-preserving payment flow on the Sui blockchain. It splits your identity from your payment:

- The **restaurant** receives your name, phone and email — they need it to seat you.
- The **blockchain** records an on-chain proof that *someone* paid — but not *who*.
- Your **wallet address** is mathematically unlinked from your personal details.

You also earn loyalty points for every booking, tracked on-chain so they're truly yours.

---

## How It Works (User Story)

```
1. You search for a restaurant on Google Maps
2. Click "Reserve" — redirected to Reserve on Sui
3. Pick a time slot, enter your contact info
4. Sign in with Google  ← no wallet app needed
5. Your Sui address is derived from your Google identity (zkLogin)
6. Gas is sponsored — you pay zero SUI
7. Pay the reservation deposit in USDC / USDT / SuiUSD
8. Receive a BookingReceipt NFT as tamper-proof confirmation
9. Earn loyalty points, redeem rewards
```

**No wallet installation. No gas fees. No private key management.**
Just "Sign in with Google" — and you're on-chain.

---

## Current Stage — Public Testing

> **Google Maps integration is in a restricted sandbox.** Google's Reserve-with-Google program is invite-only for partner restaurants. Our backend is integrated and approved for sandbox testing with real restaurant data from the Aappoint booking system.

**For public testing**, we provide a `/book` page with real participating restaurants — same API, same payment flow, same on-chain receipt. You can try the complete experience right now:

📍 **[Try it live on a Google Maps Platform Production Test Store](https://maps.app.goo.gl/mBRfwLzthj4HbvSL6)** — click "Reserve" on a real Google Maps listing connected to our backend.

🔗 **[Try it → `/book?shop_id=194&service_id=347`](https://dev-sui-booking-point-collect-hd3yycn2oq-as.a.run.app/book?shop_id=194&service_id=347)** — direct booking page if you prefer to skip Google Maps.

| What you can test now | What goes live at launch |
|---|---|
| Browse real restaurant slots (Aappoint data) | Click "Reserve" on any Google Maps listing |
| Pay deposit with USDC/USDT/SuiUSD on testnet | Same flow, Sui mainnet, real stablecoins |
| Receive BookingReceipt NFT on Sui testnet | NFT on Sui mainnet |
| Sign in with Google (zkLogin) — zero gas | Same — Sui's native gas-free transfers on mainnet |
| Earn loyalty points + redeem rewards | Same |

---

## The Privacy Solution

### What goes on-chain

```
BookingReceipt NFT {
  commitment:   SHA-256(booking_id + "::" + wallet_address)
  store_type:   "restaurant"
  slot_date:    "2026-06-20"      ← date only, no time
  party_size:   2
  amount_micro: 5_000_000         ← 5 USDC
  currency:     "USDC"
}
```

Your name, phone, and email are **never stored on-chain**. The `commitment` field is a one-way hash — it proves that *this wallet* paid for *this booking* without revealing either piece in isolation. An observer seeing the NFT cannot derive your identity, and an observer seeing your contact info cannot find your wallet.

### What zkLogin adds

zkLogin derives your Sui wallet address from your Google identity using a zero-knowledge proof. Your Google `sub` claim (unique user ID) is **never revealed on-chain** — only a cryptographic commitment to it. Different apps using zkLogin produce different addresses for the same Google account, so your bookings on "Reserve on Sui" cannot be correlated with your activity on other Sui apps.

---

## User Acquisition

The go-to-market is embedded in Google Maps itself:

1. **Any restaurant** that enables the "Reserve with Google" button becomes a potential entry point.
2. Users who click "Reserve" on Google Maps are already high-intent — they want to book right now.
3. The first booking requires only a Google account — the same account they already used to find the restaurant.
4. After one booking, users have an on-chain wallet, loyalty points, and a reason to return.

Thailand alone has over 400,000 registered restaurants. Google Maps is the dominant discovery tool. The funnel requires zero crypto knowledge from the end user.

---

## Sui Stack

| Feature | How We Use It |
|---|---|
| **zkLogin** | Sign in with Google → deterministic Sui address. No wallet app, no private key, no seed phrase. ZK proof hides the Google sub on-chain. |
| **Shinami Gas Station** | Sponsors all gas fees for zkLogin users. Users pay zero SUI — the deposit stablecoin is all they need. |
| **Move Smart Contracts** | `BookingReceipt` NFT, `PointsLedger`, `TierRegistry` — all deployed on Sui testnet. |
| **Programmable Transaction Blocks (PTB)** | Payment transfer + NFT mint execute atomically in a single transaction. Either both succeed or neither does. |
| **Stablecoins (USDC / USDT / SuiUSD)** | Deposits paid in price-stable tokens — no crypto volatility risk for users or restaurants. |
| **Gas-free stablecoin transfers (mainnet)** | Sui's native sponsored transaction feature will allow mainnet stablecoin payments with zero SUI needed — removing the sponsorship dependency entirely. |
| **On-chain Loyalty** | `PointsLedger` tracks earned points per address. `TierRegistry` counts bookings for Quartz → Sapphire → Emerald → Black Diamond progression. |

### Deployed Contracts (Sui Testnet)

| Contract | Object ID |
|---|---|
| **Package** | [`0x26f407255981f625b8fd931c3b422a1ccd9a2e452cce6a7dd5579b44a3cdddf2`](https://suiscan.xyz/testnet/object/0x26f407255981f625b8fd931c3b422a1ccd9a2e452cce6a7dd5579b44a3cdddf2) |
| PointsLedger | `0x7da00d0e09e5d5adfbfca66ee0694cc49cd6fa8cae03fdd22318ebaed67486b5` |
| TierRegistry | `0xed98f89b6895004c6ce4acd09baa3cc25f94e9f64e1316a87d14b6dadb1eb21c` |
| TierConfig | `0x43b8bcde6c239162f01d80977f0e3a3f9364c4c76e4d95fd2e956ba69e6f03c3` |

**Modules:** `booking` · `points` · `tier` · `mock_usdc` · `mock_usdt` · `mock_suiusd`

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + TypeScript + Tailwind CSS 4 |
| Auth | Sui zkLogin via Google OAuth (Shinami Key + Proof services) |
| Blockchain | Sui Testnet → Mainnet · Move smart contracts |
| Payment | USDC / USDT / SuiUSD stablecoins · PTB |
| Gas Sponsorship | Shinami Gas Station (testnet) · Native gas-free (mainnet) |
| Backend | Express.js + TypeScript |
| Booking Data | Aappoint (Reserve-with-Google partner) |

---

## Testnet → Mainnet Roadmap

### Now (Testnet)
- Full payment flow with mock stablecoins
- zkLogin with Google — gasless via Shinami sponsorship
- Real restaurant slot data via Aappoint sandbox
- BookingReceipt NFT + loyalty points on Sui testnet

### Next (Mainnet launch)
- Live Google Maps "Reserve" button integration
- Real USDC/USDT payments on Sui mainnet
- Gas-free stablecoin transfers — no SUI balance required at all
- Contact info encrypted with restaurant's public key before leaving the user's device
- Optional: ephemeral wallet per booking (stealth addresses) so even your Sui address rotates

### Privacy Roadmap
- **Phase 1 (now):** Commitment hash hides booking_id + address from on-chain observers
- **Phase 2:** Encrypted contact info — restaurants decrypt, our servers never store in plaintext
- **Phase 3:** Ephemeral address per booking — on-chain transactions can't be linked across bookings
- **Phase 4:** ZK proof of payment — prove you paid without revealing which transaction

---

## Running Locally

```bash
# 1. Clone and install
git clone https://github.com/s111s/reserve-on-sui
cd reserve-on-sui
npm install

# 2. Configure environment
cp .env.example .env
# Fill in: VITE_GOOGLE_CLIENT_ID, VITE_PACKAGE_ID, SALT_SECRET,
#          SUI_SPONSOR_PRIVATE_KEY, SHINAMI_GAS_KEY, SHINAMI_WALLET_KEY

# 3. Start
npm run server   # Terminal 1 — API on port 3001
npm run dev      # Terminal 2 — Frontend on port 5173

# 4. Open
open http://localhost:5173/book?shop_id=194&service_id=347
```

See [README-DEV.md](README-DEV.md) for full developer setup including contract deployment.

---

## Project Structure

```
src/
├── pages/
│   ├── Book.tsx          # Slot picker → contact form → checkout
│   ├── Payment.tsx       # Pay with wallet or Google → BookingReceipt NFT
│   └── Points.tsx        # Loyalty points & rewards dashboard
├── hooks/
│   └── useBookingFlow.ts # Payment state machine (zkLogin + Slush)
├── lib/
│   ├── zklogin.ts        # zkLogin: ephemeral key + Shinami ZK proof
│   ├── payment.ts        # PTB: stablecoin transfer + NFT mint
│   └── sui-client.ts     # Sui RPC helpers
├── contracts/sources/
│   ├── booking.move      # BookingReceipt NFT (privacy-safe commitment)
│   ├── points.move       # PointsLedger + earn/spend
│   └── tier.move         # TierRegistry (Quartz → Sapphire → Emerald → Black Diamond)
└── server/
    └── index.ts          # Express API: reservation proxy, points, rewards
```

---

## License

MIT · Built at Sui Overflow 2026 by Shabuzz Lab
