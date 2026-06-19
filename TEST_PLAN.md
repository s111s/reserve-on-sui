# Agentic Booking — Test Plan

> **Purpose:** Guide testers through the full QA process — automated API smoke tests first,
> then manual checks for anything that requires a real browser, wallet, or blockchain.
>
> **Coverage split:**
> - Automated (T01–T35) — all server-side logic, data integrity, API contracts
> - Manual (M01–M26) — UI rendering, wallet interaction, OAuth flow, on-chain verification,
>   UX behaviour (animations, copy feedback, toast notifications), and cross-service callbacks

---

## Part 1 — Automated API Tests

### 1.1 Prerequisites

| Requirement | How to verify |
|---|---|
| Node.js 20+ | `node --version` |
| Dependencies installed | `npm install` |
| `.env` file populated | `cp .env.example .env` then fill all values |
| Port 3001 free | `lsof -i :3001` (should be empty) |

> **Note:** The automated suite uses `TEST_MODE=true`, which bypasses on-chain lookups and
> the Shinami gas sponsorship path. Tests run entirely against in-memory state — no testnet
> connection is required.

---

### 1.2 Running the suite

**Option A — two terminals (recommended, cleaner logs)**

```bash
# Terminal 1
npm run server:test

# Terminal 2 (wait until "Server listening on port 3001" appears in Terminal 1)
npm run test:api
```

**Option B — single command (requires `concurrently`)**

```bash
npm install --save-dev concurrently wait-on   # one-time install
npm run test:all
```

Expected output on success:

```
━━━ Agentic Booking — API Test Suite ━━━

Health
  ✅  T01  GET /api/health → status ok

Reservation Webhook
  ✅  T02  ...
  ...

━━━ Results ━━━
  ✅ 34 passed   0 failed   ⏭ 1 skipped

  All tests passed 🎉
```

The one skip (T32 — faucet rate limit) is intentional: rate limiters are disabled in TEST_MODE.

---

### 1.3 What the automated tests cover

| Group | Tests | What is verified |
|---|---|---|
| Health | T01 | Server is up, responds `{ status: "ok" }` |
| Reservation webhook | T02–T05 | Incoming booking creates a token; valid/invalid token lookup |
| Tier | T06–T07 | Fresh address = tier 0; thresholds object present |
| Points / confirm-booking | T08–T13 | Earn on paid ($10 → 100 pts) and free (1 pt) bookings; no earn on failed; dedup prevention; running balance |
| Points discount flow | T14–T18 | Reserve points → get token; reject over-balance; reject below minimum; release restores; finalize keeps deduction |
| Rewards catalog | T19–T20 | Array returned; each item has `id`, `points_cost`, `required_tier` |
| Reward redemption | T22–T24 | Valid redeem issues voucher; insufficient points rejected; unknown reward 404 |
| Vouchers CRUD | T25–T28 | List by address; required fields present; mark used; double-use rejected |
| Faucets | T29–T31 | USDC/USDT/SuiUSD mint endpoints return `ok: true` |
| Admin | T33–T35 | Config read; rewards catalog read; reward CRUD (create / patch / delete) |

---

### 1.4 Interpreting failures

| Symptom | Likely cause |
|---|---|
| All tests fail — `ECONNREFUSED` | Server not started, or `.env` missing causing crash |
| T09/T10 earn 0 pts | Server was started without `TEST_MODE=true` — restart with `npm run server:test` |
| T29–T31 faucet fail | `SUI_SPONSOR_PRIVATE_KEY` not set, or sponsor wallet has no SUI — fund via `sui client faucet` |
| T22 mode=unknown | `VITE_PACKAGE_ID` set but server not in `TEST_MODE` — see above |
| Single test flaky | Re-run; T29–T31 have a 3-second sleep between faucet calls to avoid nonce collisions |

---

## Part 2 — Manual Tests

### Why manual tests are necessary

The automated suite tests the **API contract in isolation**. The following categories cannot be covered by scripts:

- **Wallet interaction** — requires a real browser extension (Slush wallet) or Google OAuth flow; no headless equivalent exists for Sui wallet signing
- **zkLogin OAuth** — depends on Google's OAuth consent screen, redirect handling, and real JWT verification; cannot be mocked without breaking the actual auth guarantee
- **On-chain verification** — confirming that a `BookingReceipt` NFT was actually minted and appears in Sui Explorer requires a live testnet transaction; the automated suite uses fake tx hashes
- **UI/UX behaviour** — CSS animations (countdown bar, toast slide-in), copy-to-clipboard feedback, tab switching, pagination, and modal timing are browser-only concerns
- **Inter-service callback** — the `PaymentStatus` callback to the teammate's server requires both services running simultaneously; not reproducible in a single-server test
- **Stablecoin balance display** — showing the user's actual USDC/USDT/SuiUSD balance reads from the correct on-chain coin type object, which requires a funded real wallet

---

### 2.1 Setup for manual testing

1. Start both services:
   ```bash
   npm run server   # Terminal 1 — API on port 3001 (no TEST_MODE)
   npm run dev      # Terminal 2 — Frontend on port 5173
   ```
2. Open `http://localhost:5173` in Chrome or Firefox.
3. Have a funded Sui testnet wallet (Slush extension) with at least 1 SUI and some USDC.
   - Use `/mock` page then the faucet button to mint USDC if needed.
4. Have a Google account ready for zkLogin tests.

---

### 2.2 Manual test checklist

Mark each item with one of: `✅ Pass` · `❌ Fail` · `⚠️ Partial` · `⏭ Skip`

---

#### M01–M04 · Mock Booking Creation (`/mock`)

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M01 | Open `/mock` — form renders with all fields (store type, date, party size, fee) | UI rendering; form field logic depends on React state not testable via API | | |
| M02 | Submit free booking (fee = 0) → redirects to `/payment?token=…` with correct booking data pre-filled | URL parameter passing and redirect behaviour is browser navigation | | |
| M03 | Submit paid booking (fee = 5.00 USDC) → redirects with correct amount shown on Payment page | Same as above; also verifies fee field serialisation | | |
| M04 | Network badge in top-right shows correct network colour (testnet = yellow, mainnet = red) | CSS/visual; cannot assert colour values via API | | |

---

#### M05–M10 · Payment Page — Slush Wallet Flow (`/payment`)

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M05 | "Connect Wallet" button opens Slush wallet popup | Browser extension interaction; requires real wallet extension | | |
| M06 | After connecting, wallet address appears truncated in UI | DOM state bound to wallet provider context | | |
| M07 | For a **free booking** — click "Confirm Booking" → spinner shows → success modal appears | On-chain `mint_receipt` call; success depends on real sponsored tx | | |
| M08 | For a **paid booking** — click "Confirm Booking" → wallet prompts for approval → USDC balance decreases by correct amount | Wallet signing prompt and stablecoin transfer require real wallet | | |
| M09 | After paid booking — success modal shows tx hash and BookingReceipt object ID | Verifies PTB result parsing from real chain response | | |
| M10 | After confirming — Sui Explorer shows `BookingReceipt` NFT in wallet with correct `commitment`, `store_type`, `slot_date` | On-chain verification; Explorer is external | | |

---

#### M11–M15 · Payment Page — zkLogin Flow (Google OAuth)

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M11 | Click "Sign in with Google" → Google OAuth consent screen opens in same tab | Real OAuth redirect; requires valid `VITE_GOOGLE_CLIENT_ID` | | |
| M12 | After Google sign-in → redirected back to `/auth/callback` → then to `/payment` with session restored | OAuth redirect and JWT parsing cannot be simulated | | |
| M13 | ZK proof request succeeds (Shinami Wallet Service) → derived Sui address shown | Depends on Shinami API being reachable and `SHINAMI_WALLET_KEY` valid | | |
| M14 | Free booking with zkLogin → minted on-chain with gas sponsored (user pays 0 SUI) | Shinami gas sponsorship; verifiable only via Explorer showing sponsor paid gas | | |
| M15 | After zkLogin booking — refresh page → wallet session persists (ephemeral key still valid) | Session storage persistence is browser-level state | | |

---

#### M16–M20 · Points & Rewards Dashboard (`/points`)

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M16 | `/points` page shows correct balance after completing a paid booking from M08 | On-chain points balance read; requires real prior tx | | |
| M17 | Tier badge updates correctly after completing enough bookings (5 for Quartz, 15 for Crystal) | Tier progression threshold is cumulative booking count, verified against real data | | |
| M18 | Click "Redeem" on a reward → success modal appears with 30-second countdown bar that visually drains | CSS `@keyframes voucher-drain` animation; purely visual | | |
| M19 | Success modal closes after 30 seconds without clicking "Got it" | setTimeout auto-dismiss; timing accuracy only observable in browser | | |
| M20 | After modal closes → My Vouchers tab updates with new voucher; Unused tab count increments | Deferred refresh triggered by `dismissVoucher()`; requires observing DOM update | | |

---

#### M21–M23 · My Vouchers UX

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M21 | Voucher code hidden by default; clicking eye icon reveals it; clicking again hides it | Toggle state is React `Set<string>` — functional only in a rendered component | | |
| M22 | "Copy" button on a voucher code → "Copied!" feedback appears for ~2 seconds, then reverts to "Copy" | `navigator.clipboard.writeText` requires browser security context (HTTPS or localhost); clipboard API not available in Node | | |
| M23 | Unused / Used / Expired tabs correctly separate vouchers; filter input narrows results; pagination works when >5 vouchers exist | UI state machines (tab + filter + page) require browser interaction to verify | | |

---

#### M24 · Toast Notifications

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M24 | Trigger an error (e.g. redeem reward with insufficient points from UI) → toast notification slides up in bottom-right, auto-dismisses after 5 seconds | CSS `@keyframes toast-in` animation and setTimeout dismiss are browser-only; error triggering path also requires wallet connection | | |

---

#### M25 · Inter-service Callback

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M25 | Complete a full paid booking → verify teammate's server at `CALLBACK_URL` receives the `PaymentStatus` payload with `status: "success"`, correct `tx_hash`, `booking_id`, and `points.earned` | Requires both services running simultaneously; callback is a live HTTP POST to external server | | |

---

#### M27–M35 · Aappoint Booking Flow (`/book` → `/payment`)

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M27 | Open `/book?shop_id=194&service_id=347` → slot picker loads dates with available-count badges | Requires live Aappoint availability API; date rendering is browser-only | | |
| M28 | Select a time slot → shop header (banner + logo + name) appears above zone picker | Triggers `GET /api/aappoint/shop-detail`; DOM update order requires browser | | |
| M29 | Select a zone with table map → table plan image shows below service strip | `shop.table_plan` URL rendered in `<img>`; visual only | | |
| M30 | Click "Reserve with Privacy" with name/email/phone empty → per-field "(required)" errors shown | React `fieldErrors` state validation; requires browser form interaction | | |
| M31 | Fill contact info + click "Reserve" → availability API called, then checkout called → navigates to `/payment` with countdown banner | Full checkout flow: `/api/aappoint/availability` pre-check → `POST /api/aappoint/checkout` → redirect | | |
| M32 | On `/payment` → slot expiry ring timer counts down; starts near 10 min; turns yellow at ≤2 min, red at ≤1 min with pulse | CSS animation + SVG `stroke-dashoffset`; timing observable only in browser | | |
| M33 | Refresh `/payment` page → countdown continues from same position (sessionStorage persists expiry) | `sessionStorage.getItem` on init; requires real page reload | | |
| M34 | Complete payment → countdown banner disappears, sessionStorage key cleared | `paid = true` hides banner; `sessionStorage.removeItem` fires in `useEffect` | | |
| M35 | Let slot expire (or get expired status from poll) → "⏰ Slot Released" screen shown; "← Pick a new time" navigates back | `slotExpired` state set by payment-result poll returning `expired` status | | |

---

#### M26 · Admin Page (`/admin`)

| ID | Test | Why manual | Status | Notes |
|---|---|---|---|---|
| M26 | Open `/admin` → rewards catalog renders; edit a reward's `points_cost` → change persists after page reload | Admin UI CRUD wires to `/api/admin/rewards` — API is tested (T33–T35) but form UX and persistence feedback require browser | | |

---

## Part 3 — Manual Test Result Template

Copy this block and fill it in after each manual test session. Attach to your PR or share with the team.

```
━━━ Manual Test Session ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Date        :
Tester      :
Branch      :
Commit hash :
Network     : testnet / devnet / mainnet
Browser     : Chrome ___ / Firefox ___ / Safari ___
Wallet      : Slush v___  /  zkLogin (Google)
Server URL  : http://localhost:5173  /  https://___

━━━ Mock Booking ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M01  Form renders with all fields            [ Pass / Fail / Skip ]
     Notes:
M02  Free booking redirect with token        [ Pass / Fail / Skip ]
     Notes:
M03  Paid booking redirect with amount       [ Pass / Fail / Skip ]
     Notes:
M04  Network badge correct colour            [ Pass / Fail / Skip ]
     Notes:

━━━ Payment — Slush Wallet ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M05  Connect Wallet popup opens              [ Pass / Fail / Skip ]
     Notes:
M06  Address shown truncated                 [ Pass / Fail / Skip ]
     Notes:
M07  Free booking → success modal            [ Pass / Fail / Skip ]
     Tx hash:
M08  Paid booking → USDC deducted            [ Pass / Fail / Skip ]
     Tx hash:         Amount deducted:
M09  Success modal shows tx hash + object ID [ Pass / Fail / Skip ]
     Object ID:
M10  BookingReceipt visible in Sui Explorer  [ Pass / Fail / Skip ]
     Explorer link:

━━━ Payment — zkLogin ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M11  Google OAuth consent screen opens       [ Pass / Fail / Skip ]
     Notes:
M12  Redirect back to /payment after login   [ Pass / Fail / Skip ]
     Notes:
M13  ZK proof + Sui address derived          [ Pass / Fail / Skip ]
     Derived address:
M14  Free booking gasless (sponsor paid gas) [ Pass / Fail / Skip ]
     Tx hash:         Gas payer (Explorer):
M15  Session persists on refresh             [ Pass / Fail / Skip ]
     Notes:

━━━ Points & Rewards Dashboard ━━━━━━━━━━━━━━━━━━━━━━━━━━
M16  Balance correct after booking           [ Pass / Fail / Skip ]
     Expected pts:    Shown pts:
M17  Tier badge updates after bookings       [ Pass / Fail / Skip ]
     Booking count:   Tier shown:
M18  Redemption modal + countdown animation  [ Pass / Fail / Skip ]
     Notes:
M19  Modal auto-closes at 30s                [ Pass / Fail / Skip ]
     Notes:
M20  My Vouchers tab refreshes after dismiss [ Pass / Fail / Skip ]
     Notes:

━━━ My Vouchers UX ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M21  Hide/show voucher code toggle           [ Pass / Fail / Skip ]
     Notes:
M22  Copy button → "Copied!" feedback        [ Pass / Fail / Skip ]
     Notes:
M23  Tabs / filter / pagination              [ Pass / Fail / Skip ]
     Notes:

━━━ Toast Notification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M24  Error toast slides in, auto-dismisses   [ Pass / Fail / Skip ]
     Trigger used:

━━━ Inter-service Callback ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M25  PaymentStatus received by teammate      [ Pass / Fail / Skip ]
     Callback URL tested:
     Payload received (paste or attach):

━━━ Admin Page ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
M26  Admin rewards CRUD via UI               [ Pass / Fail / Skip ]
     Notes:

━━━ Aappoint Booking Flow (/book → /payment) ━━━━━━━━━━━
M27  /book slot picker loads with badges     [ Pass / Fail / Skip ]
     Notes:
M28  Shop header on time select              [ Pass / Fail / Skip ]
     Notes:
M29  Table plan image on zone select         [ Pass / Fail / Skip ]
     Notes:
M30  Contact form required field errors      [ Pass / Fail / Skip ]
     Notes:
M31  Full checkout → /payment with countdown [ Pass / Fail / Skip ]
     Notes:
M32  Expiry ring colour transitions          [ Pass / Fail / Skip ]
     Notes:
M33  Countdown persists on refresh           [ Pass / Fail / Skip ]
     Notes:
M34  Banner gone after payment               [ Pass / Fail / Skip ]
     Notes:
M35  Slot expired screen shown               [ Pass / Fail / Skip ]
     Notes:

━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total manual items : 35
Pass  :     Fail  :     Skip  :
Blockers / notes for follow-up:

```

---

## Quick Reference — All Test IDs

| ID | Description | Type |
|---|---|---|
| T01 | Health check | Auto |
| T02 | Incoming reservation — free | Auto |
| T03 | Incoming reservation — paid | Auto |
| T04 | Fetch reservation by token | Auto |
| T05 | Invalid token → 404 | Auto |
| T06 | Tier — fresh address = 0 | Auto |
| T07 | Tier — thresholds object | Auto |
| T08 | Points — fresh address = 0 | Auto |
| T09 | Confirm paid $10 → +100 pts | Auto |
| T10 | Confirm free booking → +1 pt | Auto |
| T11 | Confirm failed → no points | Auto |
| T12 | Duplicate booking_id ignored | Auto |
| T13 | Running balance = 101 | Auto |
| T14 | Reserve 100 pts → token | Auto |
| T15 | Reserve exceeds balance → 400 | Auto |
| T16 | Reserve below minimum → 400 | Auto |
| T17 | Release reserved pts | Auto |
| T18 | Finalize keeps deduction | Auto |
| T19 | Rewards list returned | Auto |
| T20 | Reward has required fields | Auto |
| T22 | Redeem valid reward → voucher | Auto |
| T23 | Redeem insufficient pts → 400 | Auto |
| T24 | Redeem unknown reward → 404 | Auto |
| T25 | Voucher list by address | Auto |
| T26 | Voucher has required fields | Auto |
| T27 | Mark voucher used | Auto |
| T28 | Double-use → 400 | Auto |
| T29 | Faucet USDC | Auto |
| T30 | Faucet USDT | Auto |
| T31 | Faucet SuiUSD | Auto |
| T32 | Faucet rate limit (skipped in TEST_MODE) | Auto |
| T33 | Admin config read | Auto |
| T34 | Admin rewards list | Auto |
| T35 | Admin reward CRUD | Auto |
| M01 | Mock page renders | Manual |
| M02 | Free booking redirect | Manual |
| M03 | Paid booking redirect | Manual |
| M04 | Network badge colour | Manual |
| M05 | Slush wallet popup | Manual |
| M06 | Address shown in UI | Manual |
| M07 | Free booking on-chain | Manual |
| M08 | Paid booking + USDC deduction | Manual |
| M09 | Success modal data | Manual |
| M10 | Explorer BookingReceipt NFT | Manual |
| M11 | Google OAuth consent screen | Manual |
| M12 | OAuth redirect back | Manual |
| M13 | ZK proof + address derived | Manual |
| M14 | Gasless tx (Shinami sponsored) | Manual |
| M15 | Session persists on refresh | Manual |
| M16 | Points balance after booking | Manual |
| M17 | Tier badge progression | Manual |
| M18 | Redemption modal + animation | Manual |
| M19 | Modal 30s auto-close | Manual |
| M20 | Vouchers refresh after dismiss | Manual |
| M21 | Hide/show code toggle | Manual |
| M22 | Copy button feedback | Manual |
| M23 | Tabs / filter / pagination | Manual |
| M24 | Toast error notification | Manual |
| M25 | Inter-service callback | Manual |
| M26 | Admin page CRUD via UI | Manual |
| M27 | `/book` slot picker loads with badges | Manual |
| M28 | Shop header appears on time select | Manual |
| M29 | Table plan image shows on zone select | Manual |
| M30 | Required field validation in contact form | Manual |
| M31 | Full checkout → navigate to `/payment` | Manual |
| M32 | Expiry ring timer colour transitions | Manual |
| M33 | Countdown persists across refresh | Manual |
| M34 | Banner disappears after payment | Manual |
| M35 | Slot expired screen shown | Manual |
