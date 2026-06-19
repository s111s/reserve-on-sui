import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toB64, fromB64 } from "@mysten/sui/utils";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Rate limiters ─────────────────────────────────────────────────
// Set TEST_MODE=true in env to bypass all rate limiters (for automated tests)
const TEST_MODE = process.env.TEST_MODE === "true";

const faucetLimiter = TEST_MODE ? ((_r: unknown, _s: unknown, next: () => void) => next()) : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => (req.body as { address?: string }).address ?? "unknown",
  validate: { xForwardedForHeader: false },
  message: { error: "Too many faucet requests — try again in 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

const confirmLimiter = TEST_MODE ? ((_r: unknown, _s: unknown, next: () => void) => next()) : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many booking attempts — try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const redeemLimiter = TEST_MODE ? ((_r: unknown, _s: unknown, next: () => void) => next()) : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Too many redemption requests — try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Health check ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Incoming reservation webhook (from teammate's system) ─────────
// Teammate POSTs reservation details here → we return a payment URL
// they redirect the user to.
//
// Flow:
//   Google Maps "Reserve" → teammate server → POST /api/reservation/incoming
//   → { payment_url } → teammate redirects user → /payment?token=xxx
//   → user pays on Sui → POST /api/confirm-booking → teammate's callback

interface IncomingReservation {
  // Aappoint identifiers (used when teammate pulls from aappoint)
  shop_id?: number | string;
  event_id?: number | string;
  order_no?: string;

  // Merchant info (fallback if not using aappoint IDs)
  merchant_name?: string;
  merchant_address?: string;
  merchant_type?: string;
  merchant_image?: string;
  merchant_rating?: number;

  // Slot details
  date: string;          // "YYYY-MM-DD"
  time: string;          // "HH:MM"
  party_size?: number;

  // Fee
  fee_amount?: number;   // 0 or omit = free booking
  fee_currency?: string; // "USDC" | "USDT" | "SuiUSD"
  fee_label?: string;
  fee_refundable?: boolean;

  // Contact info (collected on our booking page, forwarded to Aappoint on confirm)
  contact?: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    special_request?: string;
  };

  // Zone/room selection from availability API
  zone_id?: string;
  zone_name?: string;

  // Callback — where to send PaymentStatus after payment completes
  // If omitted, uses CALLBACK_URL from .env
  callback_url?: string;
}

// In-memory store: token → { booking, callbackUrl, contact, createdAt }
const reservationStore = new Map<string, {
  booking: Record<string, unknown>;
  callbackUrl: string;
  contact?: IncomingReservation["contact"];
  zone?: { zone_id: string; zone_name: string };
  createdAt: number;
}>();

// Clean up tokens older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [token, entry] of reservationStore) {
    if (entry.createdAt < cutoff) reservationStore.delete(token);
  }
}, 30 * 60 * 1000);

app.post("/api/reservation/incoming", (req, res) => {
  const data = req.body as IncomingReservation;

  if (!data.date || !data.time) {
    res.status(400).json({ error: "missing required fields: date, time" });
    return;
  }

  // Build BookingData from incoming payload
  const booking = {
    booking_id: data.order_no ?? `rsv-${Date.now()}`,
    merchant: {
      id: String(data.shop_id ?? ""),
      name: data.merchant_name ?? "Partner Restaurant",
      address: data.merchant_address,
      image: data.merchant_image ?? "",
      rating: data.merchant_rating,
      type: data.merchant_type ?? "restaurant",
    },
    slot: {
      date: data.date,
      time: data.time,
      party_size: data.party_size ?? 1,
    },
    fee: {
      has_fee: (data.fee_amount ?? 0) > 0,
      amount_usdc: data.fee_amount ?? 0,
      label: data.fee_label ?? "Reservation fee",
      refundable: data.fee_refundable ?? false,
      currency: data.fee_currency ?? "USDC",
    },
    // Pass aappoint IDs through so payment page can pull full details
    ...(data.shop_id && data.event_id ? { _aappoint: { shop_id: data.shop_id, event_id: data.event_id } } : {}),
  };

  // Generate a short-lived token
  const token = `rsv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const callbackUrl = data.callback_url ?? process.env.CALLBACK_URL ?? "";

  const zone = data.zone_id ? { zone_id: data.zone_id, zone_name: data.zone_name ?? data.zone_id } : undefined;
  reservationStore.set(token, { booking, callbackUrl, contact: data.contact, zone, createdAt: Date.now() });

  const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:5173`;

  // If aappoint IDs provided, use ?shop=&event=&po_id= so payment page can poll payment-result
  const paymentPath = data.shop_id && data.event_id
    ? `/payment?shop=${data.shop_id}&event=${data.event_id}${data.order_no ? `&po_id=${data.order_no}` : ""}&token=${token}`
    : `/payment?token=${token}`;

  res.json({
    ok: true,
    token,
    payment_url: `${baseUrl}${paymentPath}`,
    expires_in: "2 hours",
  });
});

// GET /api/reservation/:token — payment page fetches booking data by token
app.get("/api/reservation/:token", (req, res) => {
  const entry = reservationStore.get(req.params.token);
  if (!entry) {
    res.status(404).json({ error: "Reservation token not found or expired" });
    return;
  }
  res.json({ ok: true, booking: entry.booking, contact: entry.contact ?? null, zone: entry.zone ?? null });
});

// ── Persistence ───────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const REWARDS_FILE  = path.join(DATA_DIR, "rewards.json");
const CONFIG_FILE   = path.join(DATA_DIR, "config.json");
const POINTS_FILE   = path.join(DATA_DIR, "points.json");
const VOUCHERS_FILE = path.join(DATA_DIR, "vouchers.json");

interface PersistedVoucher {
  code: string;
  address: string;
  reward_id: string;
  reward_name: string;
  reward_restaurant: string;
  reward_image: string;
  points_cost: number;
  used: boolean;
  pending: boolean;
  created_at: string;
}
const redeemedVouchers = new Map<string, { address: string; reward_id: string; used: boolean; pending?: boolean; created_at: string }>();

function loadVouchers(): PersistedVoucher[] {
  try { return JSON.parse(fs.readFileSync(VOUCHERS_FILE, "utf8")) as PersistedVoucher[]; }
  catch { return []; }
}
function saveVouchers() {
  const entries: PersistedVoucher[] = [];
  redeemedVouchers.forEach((v, code) => {
    const reward = rewardCatalog.find((r) => r.id === v.reward_id);
    entries.push({
      code, address: v.address, reward_id: v.reward_id,
      reward_name: reward?.name ?? v.reward_id,
      reward_restaurant: reward?.restaurant ?? "",
      reward_image: reward?.image ?? "",
      points_cost: reward?.points_cost ?? 0,
      used: v.used, pending: v.pending ?? false,
      created_at: v.created_at,
    });
  });
  fs.writeFileSync(VOUCHERS_FILE, JSON.stringify(entries, null, 2));
}
// Load persisted vouchers into memory on startup
loadVouchers().forEach((v) => redeemedVouchers.set(v.code, { address: v.address, reward_id: v.reward_id, used: v.used, pending: v.pending ?? false, created_at: v.created_at }));

// ── Points config (persisted) ─────────────────────────────────────
interface PointsConfig {
  points_per_dollar_nonrefundable: number; // pts per $1 for non-refundable paid bookings
  points_per_free_booking: number;         // flat pts for free/promo bookings
  refundable_earns_points: boolean;        // false = refundable bookings earn 0 fee-based pts
  points_per_dollar_refundable: number;    // only used when refundable_earns_points=true
}
const DEFAULT_POINTS_CONFIG: PointsConfig = {
  points_per_dollar_nonrefundable: 10,
  points_per_free_booking: 1,
  refundable_earns_points: false,
  points_per_dollar_refundable: 0,
};
function loadPointsConfig(): PointsConfig {
  try { return { ...DEFAULT_POINTS_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; }
  catch { return { ...DEFAULT_POINTS_CONFIG }; }
}
function savePointsConfig(cfg: PointsConfig) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
let pointsConfig = loadPointsConfig();

// ── Rewards catalog ───────────────────────────────────────────────
interface Reward {
  id: string;
  name: string;
  description: string;
  restaurant: string;
  restaurant_type: string;
  image: string;
  points_cost: number;
  required_tier: 1 | 2 | 3 | 4; // 1=Quartz 2=Sapphire 3=Emerald 4=Black Diamond
  category: "food" | "drink" | "experience" | "special";
  active: boolean;
  is_base: boolean;   // true = seeded from code (shown as "built-in" in UI)
  created_at: string;
}

// Tier thresholds (bookings completed) — in-memory fallback defaults
const TIER_THRESHOLDS = { quartz: 1, sapphire: 5, emerald: 15, black_diamond: 30 };
const TIER_NAMES = ["None", "Quartz", "Sapphire", "Emerald", "Black Diamond"] as const;

// In-memory booking count fallback (when chain not configured)
const bookingCounts = new Map<string, number>();
function getBookingCount(address: string): number { return bookingCounts.get(address) ?? 0; }
function getTier(address: string): number {
  const c = getBookingCount(address);
  if (c >= TIER_THRESHOLDS.black_diamond) return 4;
  if (c >= TIER_THRESHOLDS.emerald)       return 3;
  if (c >= TIER_THRESHOLDS.sapphire)      return 2;
  if (c >= TIER_THRESHOLDS.quartz)        return 1;
  return 0;
}

const BASE_REWARDS: Reward[] = [
  { id: "welcome_drink",  name: "Welcome Drink",           description: "A complimentary drink of your choice on arrival — start your visit the right way.", restaurant: "All Partner Venues",           restaurant_type: "any",        image: "https://images.unsplash.com/photo-1544145945-f90425340c7e?w=400", points_cost: 100,  required_tier: 1, category: "drink",      active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "free_dessert",   name: "Free Dessert",            description: "Chef's dessert of the day, compliments of the house.",                               restaurant: "All Partner Restaurants",     restaurant_type: "restaurant", image: "https://images.unsplash.com/photo-1488477181946-6428a0291777?w=400", points_cost: 150,  required_tier: 1, category: "food",       active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "main_dish",      name: "Signature Main Dish",     description: "One complimentary signature main dish from the chef's selection.",                   restaurant: "All Partner Restaurants",     restaurant_type: "restaurant", image: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400", points_cost: 400,  required_tier: 2, category: "food",       active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "spa_treatment",  name: "Premium Spa Treatment",   description: "60-minute aromatherapy or deep tissue massage at partner spas.",                     restaurant: "Partner Spa Venues",          restaurant_type: "spa",        image: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=400", points_cost: 600,  required_tier: 2, category: "experience", active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "special_menu",   name: "Chef's Special Menu",     description: "Full multi-course tasting menu curated by the head chef.",                           restaurant: "Flagship Partner Restaurants", restaurant_type: "restaurant", image: "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=400", points_cost: 1000, required_tier: 3, category: "special",    active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "vip_experience", name: "VIP Table Experience",    description: "Private table with priority seating, dedicated service, and a personalised welcome gift.", restaurant: "Select Emerald Partners", restaurant_type: "any",        image: "https://images.unsplash.com/photo-1559329007-40df8a9345d8?w=400", points_cost: 1500, required_tier: 3, category: "special",    active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "private_dining", name: "Private Dining Room",     description: "Exclusive use of a private dining room for up to 6 guests with a personalised menu crafted by the executive chef.", restaurant: "Black Diamond Partner Venues", restaurant_type: "restaurant", image: "https://images.unsplash.com/photo-1424847651672-bf20a4b0982b?w=400", points_cost: 3000, required_tier: 4, category: "special",    active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "luxury_stay",    name: "Complimentary Suite Night", description: "One night in a luxury suite at a partner hotel, including breakfast and late checkout.", restaurant: "Luxury Hotel Partners",  restaurant_type: "hotel",      image: "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=400", points_cost: 5000, required_tier: 4, category: "experience", active: true, is_base: true, created_at: "2026-01-01T00:00:00.000Z" },
];

function loadRewards(): Reward[] {
  try { return JSON.parse(fs.readFileSync(REWARDS_FILE, "utf8")) as Reward[]; }
  catch { saveRewards(BASE_REWARDS); return [...BASE_REWARDS]; }
}
function saveRewards(rewards: Reward[]) { fs.writeFileSync(REWARDS_FILE, JSON.stringify(rewards, null, 2)); }
let rewardCatalog = loadRewards();

// ── Tier helpers ──────────────────────────────────────────────────
async function readTableU64(client: SuiClient, tableId: string, address: string): Promise<number> {
  try {
    const entry = await client.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "address", value: address },
    });
    const c = entry.data?.content;
    return c && c.dataType === "moveObject" ? Number((c.fields as { value: string }).value ?? 0) : 0;
  } catch { return 0; }
}

async function readTableU8(client: SuiClient, tableId: string, address: string): Promise<number> {
  try {
    const entry = await client.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "address", value: address },
    });
    const c = entry.data?.content;
    return c && c.dataType === "moveObject" ? Number((c.fields as { value: string }).value ?? 0) : 0;
  } catch { return 0; }
}

function tierFromCount(count: number, quartz: number, sapphire: number, emerald: number, blackDiamond: number): number {
  if (count >= blackDiamond && blackDiamond > 0) return 4;
  if (count >= emerald      && emerald      > 0) return 3;
  if (count >= sapphire     && sapphire     > 0) return 2;
  if (count >= quartz       && quartz       > 0) return 1;
  return 0;
}

// ── Tier endpoint ──
app.get("/api/tier/:address", async (req, res) => {
  const address = req.params.address;
  const registryId = process.env.VITE_TIER_REGISTRY_ID;
  const configId   = process.env.VITE_TIER_CONFIG_ID;
  const packageId  = process.env.VITE_PACKAGE_ID;
  const network = (process.env.VITE_SUI_NETWORK as "devnet" | "testnet" | "mainnet") || "testnet";

  if (registryId && configId && packageId) {
    try {
      const client = new SuiClient({ url: getFullnodeUrl(network) });

      // Read TierRegistry: get booking_counts table ID and claimed_tiers table ID
      const [regObj, cfgObj] = await Promise.all([
        client.getObject({ id: registryId, options: { showContent: true } }),
        client.getObject({ id: configId,   options: { showContent: true } }),
      ]);

      const regContent = regObj.data?.content;
      const cfgContent = cfgObj.data?.content;

      if (regContent?.dataType === "moveObject" && cfgContent?.dataType === "moveObject") {
        const regFields = regContent.fields as Record<string, { fields: { id: { id: string } } }>;
        const cfgFields = cfgContent.fields as Record<string, string>;

        const bookingTableId = regFields.booking_counts.fields.id.id;
        const claimedTableId = regFields.claimed_tiers.fields.id.id;

        const quartz      = Number(cfgFields.quartz_threshold        ?? 1);
        const sapphire    = Number(cfgFields.sapphire_threshold      ?? 5);
        const emerald     = Number(cfgFields.emerald_threshold       ?? 15);
        const blackDiamond = Number(cfgFields.black_diamond_threshold ?? 30);

        const [count, highestClaimed] = await Promise.all([
          readTableU64(client, bookingTableId, address),
          readTableU8(client, claimedTableId, address),
        ]);

        const tier = tierFromCount(count, quartz, sapphire, emerald, blackDiamond);
        const unclaimed = tier > highestClaimed ? highestClaimed + 1 : 0;

        res.json({
          address,
          booking_count: count,
          tier,
          tier_name: TIER_NAMES[tier],
          highest_claimed: highestClaimed,
          unclaimed_tier: unclaimed,
          thresholds: { quartz, sapphire, emerald, black_diamond: blackDiamond },
          source: "on-chain",
        });
        return;
      }
    } catch { /* fall through to in-memory */ }
  }

  const count = getBookingCount(address);
  const tier  = getTier(address);
  res.json({
    address,
    booking_count: count,
    tier,
    tier_name: TIER_NAMES[tier],
    highest_claimed: 0,
    unclaimed_tier: tier > 0 ? tier : 0,
    thresholds: { quartz: TIER_THRESHOLDS.quartz, sapphire: TIER_THRESHOLDS.sapphire, emerald: TIER_THRESHOLDS.emerald, black_diamond: TIER_THRESHOLDS.black_diamond },
    source: "in-memory",
  });
});

// ── Admin: update tier threshold on-chain ─────────────────────────
app.post("/api/admin/tier/threshold", async (req, res) => {
  const { tier, new_value, admin_secret } = req.body as { tier?: number; new_value?: number; admin_secret?: string };

  const secret = process.env.ADMIN_SECRET;
  if (secret && admin_secret !== secret) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (!tier || tier < 1 || tier > 4 || new_value == null || new_value < 0) {
    res.status(400).json({ error: "tier (1-4) and new_value (>=0) required" }); return;
  }

  const packageId  = process.env.VITE_PACKAGE_ID;
  const configId   = process.env.VITE_TIER_CONFIG_ID;
  const adminCapId = process.env.ADMIN_CAP_ID;
  const privateKey = process.env.ADMIN_PRIVATE_KEY ?? process.env.SUI_SPONSOR_PRIVATE_KEY;
  const network    = (process.env.VITE_SUI_NETWORK as "devnet" | "testnet" | "mainnet") || "testnet";

  if (!packageId || !configId || !adminCapId || !privateKey) {
    res.status(503).json({ error: "VITE_PACKAGE_ID, VITE_TIER_CONFIG_ID, ADMIN_CAP_ID, SUI_SPONSOR_PRIVATE_KEY must be set" });
    return;
  }

  try {
    const client = new SuiClient({ url: getFullnodeUrl(network) });
    const keypair = privateKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(privateKey)
      : Ed25519Keypair.fromSecretKey(Buffer.from(privateKey.replace(/^0x/, ""), "hex"));

    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::tier::set_threshold`,
      arguments: [
        tx.object(adminCapId),
        tx.object(configId),
        tx.pure.u8(tier),
        tx.pure.u64(new_value),
      ],
    });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    if (result.effects?.status?.status !== "success") {
      res.status(500).json({ error: "Transaction failed", detail: result.effects?.status?.error });
      return;
    }

    await client.waitForTransaction({ digest: result.digest });

    const tierName = TIER_NAMES[tier as 1 | 2 | 3 | 4];
    console.log(`[admin] ${tierName} threshold updated to ${new_value} — tx: ${result.digest}`);
    res.json({ ok: true, tier, tier_name: tierName, new_value, tx_hash: result.digest });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Admin transaction failed" });
  }
});

// ── Admin: invitation — grant tier directly to an address ────────────────────
const invitationLog: Array<{ address: string; tier: number; tier_name: string; note: string; tx_hash: string; granted_at: string }> = [];

app.post("/api/admin/invite", async (req, res) => {
  const { address, tier, note = "", admin_secret } = req.body as { address?: string; tier?: number; note?: string; admin_secret?: string };

  const secret = process.env.ADMIN_SECRET;
  if (secret && admin_secret !== secret) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (!address || !tier || tier < 1 || tier > 4) {
    res.status(400).json({ error: "address and tier (1–4) required" }); return;
  }

  const packageId  = process.env.VITE_PACKAGE_ID;
  const registryId = process.env.VITE_TIER_REGISTRY_ID;
  const configId   = process.env.VITE_TIER_CONFIG_ID;
  const adminCapId = process.env.ADMIN_CAP_ID;
  const privateKey = process.env.ADMIN_PRIVATE_KEY ?? process.env.SUI_SPONSOR_PRIVATE_KEY;
  const network    = (process.env.VITE_SUI_NETWORK as "devnet" | "testnet" | "mainnet") || "testnet";

  if (!packageId || !registryId || !configId || !adminCapId || !privateKey) {
    res.status(503).json({ error: "Missing env: VITE_PACKAGE_ID, VITE_TIER_REGISTRY_ID, VITE_TIER_CONFIG_ID, ADMIN_CAP_ID, SUI_SPONSOR_PRIVATE_KEY" });
    return;
  }

  try {
    const client = new SuiClient({ url: getFullnodeUrl(network) });
    const keypair = privateKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(privateKey)
      : Ed25519Keypair.fromSecretKey(Buffer.from(privateKey.replace(/^0x/, ""), "hex"));

    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::tier::admin_grant_tier`,
      arguments: [
        tx.object(adminCapId),
        tx.object(registryId),
        tx.object(configId),
        tx.pure.address(address),
        tx.pure.u8(tier),
      ],
    });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    if (result.effects?.status?.status !== "success") {
      res.status(500).json({ error: "Transaction failed", detail: result.effects?.status?.error });
      return;
    }

    await client.waitForTransaction({ digest: result.digest });

    const tierName = TIER_NAMES[tier as 1 | 2 | 3 | 4];
    const entry = { address, tier, tier_name: tierName, note, tx_hash: result.digest, granted_at: new Date().toISOString() };
    invitationLog.unshift(entry);
    if (invitationLog.length > 100) invitationLog.pop();

    console.log(`[admin] Invited ${address} → ${tierName} — tx: ${result.digest}`);
    res.json({ ok: true, ...entry });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Invite transaction failed" });
  }
});

app.get("/api/admin/invitations", (_req, res) => {
  res.json({ invitations: invitationLog });
});

// ── Admin: points config read/write ──────────────────────────────────────────
app.get("/api/admin/config", (_req, res) => {
  res.json({ config: pointsConfig });
});

app.post("/api/admin/config", (req, res) => {
  const { admin_secret, ...updates } = req.body as Partial<PointsConfig> & { admin_secret?: string };
  const secret = process.env.ADMIN_SECRET;
  if (secret && admin_secret !== secret) { res.status(403).json({ error: "Forbidden" }); return; }
  pointsConfig = { ...pointsConfig, ...updates };
  savePointsConfig(pointsConfig);
  console.log("[admin] Points config updated:", pointsConfig);
  res.json({ ok: true, config: pointsConfig });
});

// ── Admin: reward catalog CRUD ────────────────────────────────────────────────
app.get("/api/admin/rewards", (_req, res) => {
  res.json({ rewards: rewardCatalog });
});

app.post("/api/admin/rewards", (req, res) => {
  const { admin_secret, ...body } = req.body as Partial<Reward> & { admin_secret?: string };
  const secret = process.env.ADMIN_SECRET;
  if (secret && admin_secret !== secret) { res.status(403).json({ error: "Forbidden" }); return; }
  const { name, description, restaurant, restaurant_type, image, points_cost, required_tier, category } = body;
  if (!name || !description || !restaurant || !restaurant_type || !points_cost || !required_tier || !category) {
    res.status(400).json({ error: "Missing required fields" }); return;
  }
  const id = `reward_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const newReward: Reward = {
    id, name, description, restaurant, restaurant_type: restaurant_type ?? "any",
    image: image ?? "", points_cost: Number(points_cost),
    required_tier: required_tier as 1|2|3|4, category: category as Reward["category"],
    active: true, is_base: false, created_at: new Date().toISOString(),
  };
  rewardCatalog.push(newReward);
  saveRewards(rewardCatalog);
  console.log(`[admin] Reward added: "${name}" (tier ${required_tier}, ${points_cost} pts)`);
  res.json({ ok: true, reward: newReward });
});

app.patch("/api/admin/rewards/:id", (req, res) => {
  const { admin_secret, ...updates } = req.body as Partial<Reward> & { admin_secret?: string };
  const secret = process.env.ADMIN_SECRET;
  if (secret && admin_secret !== secret) { res.status(403).json({ error: "Forbidden" }); return; }
  const idx = rewardCatalog.findIndex((r) => r.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "Reward not found" }); return; }
  rewardCatalog[idx] = { ...rewardCatalog[idx], ...updates };
  saveRewards(rewardCatalog);
  console.log(`[admin] Reward updated: ${req.params.id}`);
  res.json({ ok: true, reward: rewardCatalog[idx] });
});

app.delete("/api/admin/rewards/:id", (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  const admin_secret = (req.headers["x-admin-secret"] as string) ?? (req.query.admin_secret as string);
  if (secret && admin_secret !== secret) { res.status(403).json({ error: "Forbidden" }); return; }
  const idx = rewardCatalog.findIndex((r) => r.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "Reward not found" }); return; }
  const [removed] = rewardCatalog.splice(idx, 1);
  saveRewards(rewardCatalog);
  console.log(`[admin] Reward deleted: ${removed.name}`);
  res.json({ ok: true });
});

app.get("/api/rewards", (_req, res) => {
  res.json({ rewards: rewardCatalog.filter((r) => r.active) });
});

// Phase 1: validate + build sponsored tx → return bytes for user to sign
app.post("/api/rewards/redeem", redeemLimiter, async (req, res) => {
  const { address, reward_id } = req.body as { address?: string; reward_id?: string };
  if (!address || !reward_id) { res.status(400).json({ error: "missing address or reward_id" }); return; }

  const reward = rewardCatalog.find((r) => r.id === reward_id && r.active);
  if (!reward) { res.status(404).json({ error: "Reward not found" }); return; }

  const userTier = process.env.TEST_MODE === "true"
    ? getTier(address)
    : await fetch(`http://localhost:${process.env.PORT ?? 3001}/api/tier/${address}`).then((r) => r.json() as Promise<{ tier: number }>).then((r) => r.tier).catch(() => getTier(address));
  if (userTier < reward.required_tier) {
    res.status(403).json({ error: `This reward requires ${TIER_NAMES[reward.required_tier]} tier or above` }); return;
  }

  const balance = await getEffectivePoints(address);
  if (balance < reward.points_cost) {
    res.status(400).json({ error: `Insufficient points — need ${reward.points_cost}, have ${balance}` }); return;
  }

  const packageId = process.env.VITE_PACKAGE_ID;
  const ledgerId  = process.env.VITE_POINTS_LEDGER_ID;
  const rawKey    = process.env.SUI_SPONSOR_PRIVATE_KEY ?? "";

  // Pre-generate voucher code stored as "pending" — activated in /finalize after tx confirms
  const code = `${reward_id.slice(0, 4).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  if (packageId && ledgerId && rawKey && process.env.TEST_MODE !== "true") {
    try {
      const sponsorKeypair = rawKey.startsWith("suiprivkey")
        ? Ed25519Keypair.fromSecretKey(rawKey)
        : Ed25519Keypair.fromSecretKey(Buffer.from(rawKey.replace(/^0x/, ""), "hex"));
      const sponsorAddress = sponsorKeypair.getPublicKey().toSuiAddress();
      const network = (process.env.VITE_SUI_NETWORK as "testnet" | "devnet" | "mainnet") ?? "testnet";
      const suiClient = new SuiClient({ url: getFullnodeUrl(network) });

      const coins = await suiClient.getCoins({ owner: sponsorAddress, coinType: "0x2::sui::SUI" });
      if (coins.data.length === 0) throw new Error("Sponsor has no SUI for gas");

      const rgp = await suiClient.getReferenceGasPrice();
      const tx = new Transaction();
      tx.setSender(address);
      tx.setGasOwner(sponsorAddress);
      tx.setGasPayment(coins.data.slice(0, 1).map((c) => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));
      tx.setGasPrice(rgp);
      tx.setGasBudget(10_000_000n);
      tx.moveCall({
        target: `${packageId}::points::user_redeem_reward`,
        arguments: [tx.object(ledgerId), tx.pure.u64(reward.points_cost), tx.pure.string(reward_id)],
      });

      const builtBytes = await tx.build({ client: suiClient });
      const { signature: sponsorSig } = await sponsorKeypair.signTransaction(builtBytes);

      // Store pending voucher — confirmed in /finalize
      redeemedVouchers.set(code, { address, reward_id, used: false, pending: true, created_at: new Date().toISOString() });
      console.log(`[rewards] prepared redeem tx for ${address} → pending voucher ${code}`);
      res.json({ txBytes: toB64(builtBytes), sponsorSig, voucher_code: code, reward });
    } catch (err) {
      console.error("[rewards] redeem prepare error:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to build tx" }); return;
    }
  } else {
    // Fallback: no contract — server-side deduction, issue voucher immediately
    pointsDeductions.set(address, (pointsDeductions.get(address) ?? 0) + reward.points_cost);
    savePointsStore();
    redeemedVouchers.set(code, { address, reward_id: reward.id, used: false, pending: false, created_at: new Date().toISOString() });
    saveVouchers();
    const remaining = await getEffectivePoints(address);
    console.log(`[rewards] ${address} redeemed "${reward.name}" (fallback) → ${code}`);
    res.json({ ok: true, voucher_code: code, reward, remaining_points: remaining });
  }
});

// Phase 2: user signed + executed → confirm voucher is active
app.post("/api/rewards/finalize", async (req, res) => {
  const { voucher_code, tx_digest } = req.body as { voucher_code?: string; tx_digest?: string };
  if (!voucher_code || !tx_digest) { res.status(400).json({ error: "missing voucher_code or tx_digest" }); return; }

  const voucher = redeemedVouchers.get(voucher_code);
  if (!voucher) { res.status(404).json({ error: "Voucher not found" }); return; }

  // Activate the voucher
  redeemedVouchers.set(voucher_code, { ...voucher, pending: false });
  saveVouchers();

  const reward = rewardCatalog.find((r) => r.id === voucher.reward_id);
  const remaining = await getEffectivePoints(voucher.address);
  console.log(`[rewards] finalized ${voucher_code} tx=${tx_digest} remaining=${remaining} pts`);
  res.json({ ok: true, voucher_code, reward, remaining_points: remaining });
});

// List active (non-pending, non-used) vouchers for a wallet address
app.get("/api/vouchers/:address", (req, res) => {
  const { address } = req.params;
  const all = loadVouchers().filter((v) => v.address === address && !v.pending);
  res.json({ vouchers: all });
});

// Mark a voucher as used (staff scans / user confirms at store)
app.post("/api/vouchers/:code/use", async (req, res) => {
  const { code } = req.params;
  const voucher = redeemedVouchers.get(code);
  if (!voucher) { res.status(404).json({ error: "Voucher not found" }); return; }
  if (voucher.used) { res.status(400).json({ error: "Voucher already used" }); return; }
  if (voucher.pending) { res.status(400).json({ error: "Voucher not yet confirmed" }); return; }
  redeemedVouchers.set(code, { ...voucher, used: true });
  saveVouchers();
  console.log(`[vouchers] ${code} marked as used by ${voucher.address}`);
  res.json({ ok: true, code, used: true });
});

// Deduplication: track booking_ids that have already been awarded points.
// This prevents double-awards caused by React strict-mode double-fires or retries.
const confirmedBookings = new Set<string>();

// ── Receive PaymentStatus from frontend ──
app.post("/api/confirm-booking", confirmLimiter, async (req, res) => {
  const paymentStatus = req.body;
  const ts = new Date().toISOString();

  console.log(`\n[${ts}] Received PaymentStatus:`);
  console.log(`  booking_id : ${paymentStatus.booking_id}`);
  console.log(`  status     : ${paymentStatus.status}`);
  console.log(`  message    : ${paymentStatus.message}`);

  if (paymentStatus.payment) {
    console.log(`  tx_hash    : ${paymentStatus.payment.tx_hash}`);
    console.log(`  amount     : ${paymentStatus.payment.amount_usdc} ${paymentStatus.payment.token}`);
  }
  if (paymentStatus.receipt) {
    console.log(`  receipt    : ${paymentStatus.receipt.object_id}`);
  }
  if (paymentStatus.points) {
    console.log(`  points     : +${paymentStatus.points.earned} (balance: ${paymentStatus.points.balance})`);
  }
  if (paymentStatus.error_code) {
    console.log(`  error_code : ${paymentStatus.error_code}`);
  }

  // Award points + increment booking count on success/free/promo
  // Deduplicate: if this booking_id was already processed, return cached result without re-awarding.
  let pointsResult: { earned: number; balance: number } | null = null;
  const userAddress = paymentStatus.user_address as string | undefined;
  const bookingId = paymentStatus.booking_id as string | undefined;
  const dedupKey = bookingId ? `${bookingId}:${userAddress ?? ""}` : null;

  if (userAddress && (paymentStatus.status === "success" || paymentStatus.status === "free" || paymentStatus.status === "promo")) {
    if (dedupKey && confirmedBookings.has(dedupKey)) {
      console.log(`  [dedup] booking ${bookingId} already processed — skipping point award`);
      pointsResult = { earned: 0, balance: await getEffectivePoints(userAddress) };
    } else {
      if (dedupKey) confirmedBookings.add(dedupKey);
      const amountPaid = paymentStatus.payment?.amount_usdc ?? 0;
      const isFree = paymentStatus.status !== "success";
      const isRefundable = paymentStatus.payment?.refundable === true;
      const earned = awardPointsFallback(userAddress, amountPaid, isFree, isRefundable);
      const effectiveBalance = await getEffectivePoints(userAddress);
      pointsResult = { earned, balance: effectiveBalance };
      bookingCounts.set(userAddress, (bookingCounts.get(userAddress) ?? 0) + 1);
      savePointsStore();
      console.log(`  points     : +${earned} pts (balance: ${pointsResult.balance})`);
      console.log(`  bookings   : ${bookingCounts.get(userAddress)} (tier: ${TIER_NAMES[getTier(userAddress)]})`);
    }
  }

  // Finalize redemption token if present
  if (paymentStatus.redemption_token) {
    redemptionReserve.delete(paymentStatus.redemption_token as string);
  }

  // Forward to external callback if configured
  const callbackUrl = process.env.CALLBACK_URL;
  if (callbackUrl) {
    try {
      const callbackRes = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(paymentStatus),
      });
      console.log(`  → forwarded to ${callbackUrl}: ${callbackRes.status}`);
    } catch (err: unknown) {
      console.error(`  → forward failed:`, err instanceof Error ? err.message : err);
    }
  }

  res.json({ received: true, booking_id: paymentStatus.booking_id, status: paymentStatus.status, timestamp: ts, points: pointsResult });
});

// ── Mock stablecoin faucets ──
// Generic helper — mints any of the three mock tokens.
async function mintStablecoin(
  token: "usdc" | "usdt" | "suiusd",
  address: string,
  amount: number,
  res: import("express").Response,
) {
  const capEnvKey = `${token.toUpperCase()}_TREASURY_CAP_ID`;
  const packageId = process.env.VITE_PACKAGE_ID;
  const treasuryCapId = process.env[capEnvKey];
  const privateKey = process.env.SUI_SPONSOR_PRIVATE_KEY;
  const network = (process.env.VITE_SUI_NETWORK as "devnet" | "testnet" | "mainnet") || "testnet";
  const symbol = token === "suiusd" ? "SuiUSD" : token.toUpperCase();

  if (!packageId || !treasuryCapId || !privateKey) {
    res.status(503).json({ error: `Faucet not configured — set VITE_PACKAGE_ID, ${capEnvKey}, SUI_SPONSOR_PRIVATE_KEY in .env` });
    return;
  }

  try {
    const client = new SuiClient({ url: getFullnodeUrl(network) });
    const keypair = privateKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(privateKey)
      : Ed25519Keypair.fromSecretKey(Buffer.from(privateKey.replace(/^0x/, ""), "hex"));

    const amountMicro = Math.round(Math.min(amount, 10_000) * 1_000_000); // cap at 10,000

    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::mock_${token}::faucet`,
      arguments: [
        tx.object(treasuryCapId),
        tx.pure.u64(amountMicro),
        tx.pure.address(address),
      ],
    });

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    if (result.effects?.status?.status !== "success") {
      res.status(500).json({ error: "Faucet transaction failed", detail: result.effects?.status?.error });
      return;
    }

    // Wait for the node to index the new coin before responding,
    // so the client's refreshBalance() call sees the updated balance immediately.
    await client.waitForTransaction({ digest: result.digest });

    console.log(`[faucet] Minted ${amount} ${symbol} to ${address} — tx: ${result.digest}`);
    res.json({ ok: true, tx_hash: result.digest, amount, address, token: symbol });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "faucet error" });
  }
}

app.post("/api/faucet/usdc", faucetLimiter, async (req, res) => {
  const { address, amount = 100 } = req.body as { address?: string; amount?: number };
  if (!address) { res.status(400).json({ error: "missing address" }); return; }
  await mintStablecoin("usdc", address, amount, res);
});

app.post("/api/faucet/usdt", faucetLimiter, async (req, res) => {
  const { address, amount = 100 } = req.body as { address?: string; amount?: number };
  if (!address) { res.status(400).json({ error: "missing address" }); return; }
  await mintStablecoin("usdt", address, amount, res);
});

app.post("/api/faucet/suiusd", faucetLimiter, async (req, res) => {
  const { address, amount = 100 } = req.body as { address?: string; amount?: number };
  if (!address) { res.status(400).json({ error: "missing address" }); return; }
  await mintStablecoin("suiusd", address, amount, res);
});

// ── Shinami connectivity test ──
app.get("/api/zklogin/test", async (_req, res) => {
  const walletKey = process.env.SHINAMI_WALLET_KEY;
  const gasKey = process.env.SHINAMI_GAS_KEY;
  const keyInfo = {
    wallet_key_set: !!walletKey,
    wallet_key_prefix: walletKey ? walletKey.slice(0, 20) + "..." : "MISSING",
    gas_key_set: !!gasKey,
    gas_key_prefix: gasKey ? gasKey.slice(0, 20) + "..." : "MISSING",
  };
  try {
    const r = await fetch("https://api.us1.shinami.com/sui/zkwallet/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": walletKey ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shinami_zkw_getOrCreateZkLoginWallet", params: ["test", "sub", 0] }),
    });
    const body = await r.text();
    res.json({ keys: keyInfo, shinami_status: r.status, shinami_body: body.slice(0, 300) });
  } catch (err: unknown) {
    res.json({ keys: keyInfo, shinami_error: String(err) });
  }
});

// ── zkLogin: self-hosted salt service ──────────────────────────────────────────
// Derives a stable deterministic salt per user from SALT_SECRET + sub + aud.
// Pure HMAC — no caching needed since same inputs always produce the same output.
// Shinami's wallet service doesn't accept Google JWTs without prior registration,
// so we keep our own salt and only use Shinami for ZK proof generation.
const SALT_SECRET = process.env.SALT_SECRET ?? crypto.randomBytes(32).toString("hex");

function deriveSalt(sub: string, aud: string): string {
  const hmac = crypto.createHmac("sha256", SALT_SECRET).update(`${sub}:${aud}`).digest();
  return BigInt("0x" + hmac.slice(0, 16).toString("hex")).toString();
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT format");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

app.post("/api/zklogin/wallet", (req, res) => {
  const { jwt } = req.body as { jwt?: string };
  if (!jwt) { res.status(400).json({ error: "missing jwt" }); return; }
  try {
    const claims = parseJwtPayload(jwt);
    const sub = claims.sub as string;
    const aud = Array.isArray(claims.aud) ? (claims.aud[0] as string) : (claims.aud as string);
    if (!sub || !aud) { res.status(400).json({ error: "JWT missing sub or aud" }); return; }
    const salt = deriveSalt(sub, aud);
    console.log(`[zklogin/wallet] salt for sub=${sub.slice(0, 8)}…`);
    res.json({ salt });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[zklogin/wallet] caught:", msg);
    res.status(500).json({ error: msg });
  }
});

// ── zkLogin: Shinami ZK prover ─────────────────────────────────────────────────
// Shinami's prover uses the same circuit version as the current testnet verifier.
app.post("/api/zklogin/proof", async (req, res) => {
  const { jwt, maxEpoch, extendedEphemeralPublicKey, jwtRandomness, salt } =
    req.body as { jwt?: string; maxEpoch?: number; extendedEphemeralPublicKey?: string; jwtRandomness?: string; salt?: string };

  if (!jwt || maxEpoch == null || !extendedEphemeralPublicKey || !jwtRandomness || !salt) {
    res.status(400).json({ error: "missing required fields" }); return;
  }

  const key = process.env.SHINAMI_WALLET_KEY;
  if (!key) { res.status(503).json({ error: "SHINAMI_WALLET_KEY not configured" }); return; }

  try {
    const response = await fetch("https://api.us1.shinami.com/sui/zkprover/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": key },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "shinami_zkp_createZkLoginProof",
        params: [jwt, String(maxEpoch), extendedEphemeralPublicKey, jwtRandomness, salt],
      }),
    });
    const raw = await response.text();
    console.log(`[zklogin/proof] Shinami status=${response.status} body=${raw.slice(0, 600)}`);
    if (!response.ok) { res.status(400).json({ error: `Shinami prover ${response.status}: ${raw.slice(0, 200)}` }); return; }
    const data = JSON.parse(raw) as { result?: Record<string, unknown>; error?: unknown };
    if (data.error || !data.result) {
      res.status(400).json({ error: data.error ?? "no result from Shinami" }); return;
    }
    console.log(`[zklogin/proof] result keys: ${Object.keys(data.result).join(", ")}`);
    const zkProof = (data.result.zkProof ?? data.result) as Record<string, unknown>;
    console.log(`[zklogin/proof] zkProof keys: ${Object.keys(zkProof).join(", ")}`);
    const { addressSeed: proverAddressSeed, ...proof } = zkProof;
    console.log(`[zklogin/proof] proverAddressSeed=${String(proverAddressSeed ?? "none")}`);
    if (!proof.proofPoints) {
      res.status(400).json({ error: "no zkProof from Shinami", result_keys: Object.keys(data.result) }); return;
    }
    res.json({ proof, addressSeed: proverAddressSeed ?? null });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "proof service error" });
  }
});

// ── Gas sponsorship — generic (Shinami), used by booking payment flow ────────
// Client sends TransactionKind bytes (onlyTransactionKind:true) + sender.
app.post("/api/sponsor/transaction", async (req, res) => {
  const { txBytes, sender } = req.body as { txBytes?: string; sender?: string };
  if (!txBytes || !sender) { res.status(400).json({ error: "missing txBytes or sender" }); return; }

  const key = process.env.SHINAMI_GAS_KEY;
  if (!key) { res.status(503).json({ error: "SHINAMI_GAS_KEY not configured" }); return; }

  try {
    const response = await fetch("https://api.us1.shinami.com/sui/gas/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": key },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "gas_sponsorTransactionBlock",
        params: [txBytes, sender],
      }),
    });
    const data = await response.json() as { result?: { txBytes: string; signature: string }; error?: unknown };
    if (data.error) { res.status(400).json({ error: data.error }); return; }
    res.json({ txBytes: data.result!.txBytes, signature: data.result!.signature });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "gas station error" });
  }
});

// ── Gas sponsorship — self-hosted, for claim_tier specifically ────────────────
// Server builds the claim_tier tx with itself as gas owner, signs as sponsor.
// Client counter-signs with zkLogin as sender and executes.
app.post("/api/sponsor/claim-tier", async (req, res) => {
  const { sender } = req.body as { sender?: string };
  if (!sender) { res.status(400).json({ error: "missing sender" }); return; }

  const rawKey     = process.env.SUI_SPONSOR_PRIVATE_KEY;
  const packageId  = process.env.VITE_PACKAGE_ID;
  const registryId = process.env.VITE_TIER_REGISTRY_ID;
  const configId   = process.env.VITE_TIER_CONFIG_ID;

  if (!rawKey || !packageId || !registryId || !configId) {
    res.status(503).json({ error: "Missing env: SUI_SPONSOR_PRIVATE_KEY, VITE_PACKAGE_ID, VITE_TIER_REGISTRY_ID, VITE_TIER_CONFIG_ID" }); return;
  }

  try {
    const sponsorKeypair = rawKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(rawKey)
      : Ed25519Keypair.fromSecretKey(Buffer.from(rawKey.replace(/^0x/, ""), "hex"));
    const sponsorAddress = sponsorKeypair.getPublicKey().toSuiAddress();
    const network = (process.env.VITE_SUI_NETWORK as "testnet" | "devnet" | "mainnet") ?? "testnet";
    const suiClient = new SuiClient({ url: getFullnodeUrl(network) });

    const coins = await suiClient.getCoins({ owner: sponsorAddress, coinType: "0x2::sui::SUI" });
    if (coins.data.length === 0) throw new Error("Sponsor has no SUI for gas — faucet the sponsor address first");

    const rgp = await suiClient.getReferenceGasPrice();

    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasOwner(sponsorAddress);
    tx.setGasPayment(coins.data.slice(0, 1).map((c) => ({
      objectId: c.coinObjectId,
      version: c.version,
      digest: c.digest,
    })));
    tx.setGasPrice(rgp);
    tx.setGasBudget(10_000_000n);
    tx.moveCall({
      target: `${packageId}::tier::claim_tier`,
      arguments: [tx.object(registryId), tx.object(configId)],
    });

    const builtBytes = await tx.build({ client: suiClient });
    const { signature: sponsorSig } = await sponsorKeypair.signTransaction(builtBytes);

    console.log(`[sponsor/claim-tier] built for sender=${sender}`);
    res.json({ txBytes: toB64(builtBytes), signature: sponsorSig });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "sponsorship error";
    console.error("[sponsor/claim-tier]", msg);
    res.status(500).json({ error: msg });
  }
});

// ── Coupon validation (stub — implement when coupon system is ready) ──
app.post("/api/coupon/validate", (req, res) => {
  const { code, merchant_id } = req.body as { code?: string; merchant_id?: string };
  if (!code) { res.status(400).json({ valid: false, error: "missing code" }); return; }

  // TODO: implement coupon lookup against database
  // For now return a stub response so frontend integration can be developed
  res.status(501).json({ valid: false, error: "Coupon system not yet implemented", code, merchant_id });
});

// ── Points system ─────────────────────────────────────────────────
//
// Architecture: on-chain PointsLedger is the ONLY source of earned points.
// The server tracks only two things:
//   deductions  — points spent on server-side rewards (reward catalog redemptions)
//   fallback    — earned points when no contract is configured (local dev / no-chain mode)
//
// Effective balance = on-chain earned − deductions   (contract mode)
//                   = fallback earned − deductions   (no-contract mode)
//
interface PointsStore {
  deductions: Record<string, number>;
  fallback:   Record<string, number>;
  bookings:   Record<string, number>;
}
function loadPointsStore(): PointsStore {
  try {
    const raw = JSON.parse(fs.readFileSync(POINTS_FILE, "utf8")) as Record<string, Record<string, number>>;
    return {
      deductions: raw.deductions ?? {},
      fallback:   raw.fallback   ?? raw.ledger ?? {},  // migrate old "ledger" key
      bookings:   raw.bookings   ?? {},
    };
  } catch { return { deductions: {}, fallback: {}, bookings: {} }; }
}
function savePointsStore() {
  const store: PointsStore = {
    deductions: Object.fromEntries(pointsDeductions),
    fallback:   Object.fromEntries(pointsFallback),
    bookings:   Object.fromEntries(bookingCounts),
  };
  fs.writeFileSync(POINTS_FILE, JSON.stringify(store, null, 2));
}
const _pointsInit = loadPointsStore();
// pointsDeductions: how many points each address has already spent on rewards
const pointsDeductions = new Map<string, number>(Object.entries(_pointsInit.deductions).map(([k, v]) => [k, Number(v)]));
// pointsFallback: earned points when chain is not configured
const pointsFallback   = new Map<string, number>(Object.entries(_pointsInit.fallback).map(([k, v]) => [k, Number(v)]));
// bookingCounts is declared above; seed from file
for (const [k, v] of Object.entries(_pointsInit.bookings)) bookingCounts.set(k, Number(v));

const redemptionReserve = new Map<string, { address: string; amount: number; booking_id: string }>();

// Read on-chain PointsLedger balance for an address. Returns null if chain not configured or read fails.
async function getOnChainPoints(address: string): Promise<number | null> {
  const ledgerId = process.env.VITE_POINTS_LEDGER_ID;
  const packageId = process.env.VITE_PACKAGE_ID;
  if (!ledgerId || !packageId) return null;
  try {
    const network = (process.env.VITE_SUI_NETWORK as "testnet" | "devnet" | "mainnet") || "testnet";
    const client = new SuiClient({ url: getFullnodeUrl(network) });
    const obj = await client.getObject({ id: ledgerId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== "moveObject") return null;
    const tableId = ((content.fields as Record<string, unknown>).balances as { fields: { id: { id: string } } }).fields.id.id;
    try {
      const entry = await client.getDynamicFieldObject({ parentId: tableId, name: { type: "address", value: address } });
      const ef = entry.data?.content;
      if (ef && ef.dataType === "moveObject") return parseInt((ef.fields as { value: string }).value, 10);
      return 0;
    } catch { return 0; } // address not in table yet
  } catch (e) {
    console.error("[points] on-chain read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

// Effective balance: on-chain earned minus server-tracked deductions.
// Falls back to fallback ledger when chain is not configured.
async function getEffectivePoints(address: string): Promise<number> {
  const deducted = pointsDeductions.get(address) ?? 0;
  if (process.env.TEST_MODE !== "true") {
    const onChain = await getOnChainPoints(address);
    if (onChain !== null) {
      return Math.max(0, onChain - deducted);
    }
  }
  // No-contract fallback (always used in TEST_MODE)
  const earned = pointsFallback.get(address) ?? 0;
  return Math.max(0, earned - deducted);
}

// Award points in fallback mode only (chain not configured).
// When contract IS configured, mint_receipt handles point awarding on-chain.
function awardPointsFallback(address: string, amountPaid: number, isFree: boolean, isRefundable: boolean): number {
  if (process.env.VITE_PACKAGE_ID && process.env.TEST_MODE !== "true") return 0; // chain handles it (skip in TEST_MODE)
  let earned = 0;
  if (isFree) {
    earned = pointsConfig.points_per_free_booking;
  } else if (isRefundable) {
    earned = pointsConfig.refundable_earns_points
      ? Math.floor(amountPaid * pointsConfig.points_per_dollar_refundable)
      : 0;
  } else {
    earned = Math.floor(amountPaid * pointsConfig.points_per_dollar_nonrefundable);
  }
  if (earned <= 0) return 0;
  pointsFallback.set(address, (pointsFallback.get(address) ?? 0) + earned);
  return earned;
}

app.get("/api/points/:address", async (req, res) => {
  const { address } = req.params;
  if (process.env.TEST_MODE !== "true") {
    const onChain = await getOnChainPoints(address);
    if (onChain !== null) {
      const deducted = pointsDeductions.get(address) ?? 0;
      const balance = Math.max(0, onChain - deducted);
      res.json({ address, balance, discount_value: parseFloat((balance / 100).toFixed(2)), source: "on-chain" });
      return;
    }
  }
  const balance = (pointsFallback.get(address) ?? 0) - (pointsDeductions.get(address) ?? 0);
  res.json({ address, balance: Math.max(0, balance), discount_value: parseFloat((Math.max(0, balance) / 100).toFixed(2)), source: "fallback" });
});

app.post("/api/points/redeem", redeemLimiter, async (req, res) => {
  const { address, points, booking_id } =
    req.body as { address?: string; points?: number; booking_id?: string };
  if (!address || !points || !booking_id) {
    res.status(400).json({ error: "missing address, points, or booking_id" }); return;
  }
  if (points < 100) {
    res.status(400).json({ error: "Minimum redemption is 100 points" }); return;
  }
  const balance = await getEffectivePoints(address);
  if (balance < points) {
    res.status(400).json({ error: `Insufficient points — have ${balance}, need ${points}` }); return;
  }
  pointsDeductions.set(address, (pointsDeductions.get(address) ?? 0) + points);
  savePointsStore();
  const token = `rdm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  redemptionReserve.set(token, { address, amount: points, booking_id });
  const discount = parseFloat((points / 100).toFixed(2));
  console.log(`[points] ${address} reserved ${points} pts for discount (token: ${token}, discount: $${discount})`);
  res.json({ ok: true, token, points, discount_value: discount });
});

app.post("/api/points/release", async (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) { res.status(400).json({ error: "missing token" }); return; }
  const reservation = redemptionReserve.get(token);
  if (!reservation) { res.json({ ok: true, note: "token not found or already finalized" }); return; }
  const cur = pointsDeductions.get(reservation.address) ?? 0;
  pointsDeductions.set(reservation.address, Math.max(0, cur - reservation.amount));
  redemptionReserve.delete(token);
  savePointsStore();
  console.log(`[points] released ${reservation.amount} pts back to ${reservation.address}`);
  res.json({ ok: true });
});

app.post("/api/points/finalize", (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) { res.status(400).json({ error: "missing token" }); return; }
  redemptionReserve.delete(token); // deduction already recorded in pointsDeductions
  res.json({ ok: true });
});

// ── Aappoint API integration ──────────────────────────────────────
const AAPPOINT_BASE = process.env.AAPPOINT_BASE_URL ?? "https://dev.aappoint.me";
const AAPPOINT_TOKEN = process.env.AAPPOINT_API_TOKEN ?? ""; // leave empty for unauthenticated GET

interface AappointShop {
  id: number;
  name_en: string;
  name_th: string;
  address: string;
  logo: string;
  banner: string;
  rating: number;
  service_type: string;
  google_map_url: string;
}

interface AappointPurchaseOrder {
  deposit_grand_total: string;
  deposit_amount: string;
  currency: string;
  title: string;
  status: string;
  order_no: string;
}

interface AappointEvent {
  id: number;
  name: string;
  note: string;
  start_at: string;
  end_at: string;
  status: string;
  shop_id: number;
  shop: AappointShop;
  event_purchase_order?: AappointPurchaseOrder;
}

function mapEventToBookingData(event: AappointEvent) {
  const startDate = new Date(event.start_at);
  const depositTotal = parseFloat(event.event_purchase_order?.deposit_grand_total ?? "0");
  const hasFee = depositTotal > 0;

  // Map aappoint service_type to our StoreType
  const typeMap: Record<string, string> = {
    restaurant: "restaurant", hotel: "hotel", cafe: "cafe",
    spa: "spa", bar: "bar", activity: "activity",
  };
  const storeType = typeMap[event.shop.service_type?.toLowerCase()] ?? "other";

  return {
    booking_id: String(event.id),
    merchant: {
      id: String(event.shop.id),
      name: event.shop.name_en || event.shop.name_th,
      nameLocal: event.shop.name_th,
      address: event.shop.address,
      image: event.shop.logo || event.shop.banner,
      rating: event.shop.rating,
      type: storeType,
    },
    slot: {
      date: startDate.toISOString().split("T")[0],
      time: startDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      party_size: 1,
    },
    fee: {
      has_fee: hasFee,
      amount_usdc: depositTotal,
      label: event.event_purchase_order?.title ?? "Reservation fee",
      refundable: false,
      currency: "USDC" as const,
    },
    // Store original aappoint order ref for push-back after payment
    aappoint: {
      shop_id: event.shop_id,
      event_id: event.id,
      order_no: event.event_purchase_order?.order_no ?? null,
      order_status: event.event_purchase_order?.status ?? null,
    },
  };
}

// GET /api/aappoint/shop/:shopId/event/:eventId
// Proxies to aappoint, maps response to BookingData shape
app.get("/api/aappoint/shop/:shopId/event/:eventId", async (req, res) => {
  const { shopId, eventId } = req.params;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (AAPPOINT_TOKEN) headers["Authorization"] = `Bearer ${AAPPOINT_TOKEN}`;

    const upstream = await fetch(
      `${AAPPOINT_BASE}/shop/${shopId}/event/${eventId}`,
      { headers }
    );

    if (!upstream.ok) {
      const text = await upstream.text();
      res.status(upstream.status).json({ error: `Aappoint API error ${upstream.status}`, detail: text });
      return;
    }

    const event = await upstream.json() as AappointEvent;
    const bookingData = mapEventToBookingData(event);
    res.json({ ok: true, booking: bookingData, raw: event });
  } catch (err) {
    console.error("[aappoint] fetch error:", err);
    res.status(502).json({ error: "Failed to reach aappoint API", detail: String(err) });
  }
});

// Safely fetch an Aappoint endpoint and parse JSON, returning raw text on parse failure.
async function aappointFetch(url: string): Promise<{ status: number; body: unknown; rawText: string }> {
  const upstream = await fetch(url);
  const rawText = await upstream.text();
  let body: unknown;
  try { body = JSON.parse(rawText); } catch { body = null; }
  return { status: upstream.status, body, rawText };
}

// GET /api/aappoint/shop-detail — proxy to GET /rwg-payment (slot-contextual shop info)
// Params: shop_id, service_id required; start_date, end_date, start_sec, party_size, zone optional
app.get("/api/aappoint/shop-detail", async (req, res) => {
  const { shop_id, service_id, start_date, end_date, start_sec, party_size, zone } = req.query as Record<string, string>;
  if (!shop_id || !service_id) {
    res.status(400).json({ error: "missing shop_id, service_id" }); return;
  }
  try {
    const qs = new URLSearchParams({ shop_id, service_id, ...(start_date && { start_date }), ...(end_date && { end_date }), ...(start_sec && { start_sec }), ...(party_size && { party_size }), ...(zone && { zone }) });
    const { status, body, rawText } = await aappointFetch(`${AAPPOINT_BASE}/rwg-payment?${qs}`);
    if (body === null) { res.status(502).json({ error: "Aappoint returned non-JSON", detail: rawText.slice(0, 500) }); return; }
    res.status(status).json(body);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Aappoint shop-detail API", detail: String(err) });
  }
});

// GET /api/aappoint/services?shop_id=X — proxy to Aappoint services API
app.get("/api/aappoint/services", async (req, res) => {
  const { shop_id } = req.query as Record<string, string>;
  if (!shop_id) { res.status(400).json({ error: "missing shop_id" }); return; }
  try {
    const { status, body, rawText } = await aappointFetch(`${AAPPOINT_BASE}/rwg-payment/services?shop_id=${shop_id}`);
    if (body === null) { res.status(502).json({ error: "Aappoint returned non-JSON", detail: rawText.slice(0, 500) }); return; }
    res.status(status).json(body);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Aappoint services API", detail: String(err) });
  }
});

// GET /api/aappoint/availability — proxy to Aappoint availability API (avoids browser CORS)
app.get("/api/aappoint/availability", async (req, res) => {
  const { shop_id, service_id, start_date, end_date } = req.query as Record<string, string>;
  if (!shop_id || !service_id || !start_date || !end_date) {
    res.status(400).json({ error: "missing shop_id, service_id, start_date, end_date" }); return;
  }
  try {
    const url = `${AAPPOINT_BASE}/rwg-payment/availability?shop_id=${shop_id}&service_id=${service_id}&start_date=${start_date}&end_date=${end_date}`;
    console.log(`[aappoint/availability] fetching: ${url}`);
    const { status, body, rawText } = await aappointFetch(url);
    if (body === null) {
      console.error(`[aappoint/availability] non-JSON response (${status}): ${rawText.slice(0, 300)}`);
      res.status(502).json({ error: "Aappoint returned non-JSON", detail: rawText.slice(0, 500) }); return;
    }
    res.status(status).json(body);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Aappoint availability API", detail: String(err) });
  }
});

// GET /api/aappoint/payment-result — check slot/payment status (used to detect expiry)
// Params: shop_id, event_id, po_id
app.get("/api/aappoint/payment-result", async (req, res) => {
  const { shop_id, event_id, po_id } = req.query as Record<string, string>;
  if (!shop_id || !event_id || !po_id) {
    res.status(400).json({ error: "missing shop_id, event_id, po_id" }); return;
  }
  try {
    const qs = new URLSearchParams({ shop_id, event_id, po_id });
    const url = `${AAPPOINT_BASE}/rwg-payment/payment-result?${qs}`;
    console.log(`[aappoint/payment-result] fetching: ${url}`);
    const { status, body, rawText } = await aappointFetch(url);
    if (body === null) {
      console.error(`[aappoint/payment-result] non-JSON (${status}): ${rawText.slice(0, 300)}`);
      res.status(502).json({ error: "Aappoint returned non-JSON", detail: rawText.slice(0, 500) }); return;
    }
    res.status(status).json(body);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Aappoint payment-result API", detail: String(err) });
  }
});

// POST /api/aappoint/checkout — hold a slot and create a purchase order
app.get("/api/aappoint/checkout", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed — use POST", method: "POST", upstream: `${AAPPOINT_BASE}/rwg-payment/checkout` });
});
app.post("/api/aappoint/checkout", async (req, res) => {
  try {
    const upstream = await fetch(`${AAPPOINT_BASE}/rwg-payment/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(AAPPOINT_TOKEN && { Authorization: `Bearer ${AAPPOINT_TOKEN}` }) },
      body: JSON.stringify(req.body),
    });
    const rawText = await upstream.text();
    let body: unknown;
    try { body = JSON.parse(rawText); } catch {
      res.status(502).json({ error: "Aappoint checkout returned non-JSON", detail: rawText.slice(0, 500) }); return;
    }
    console.log(`[aappoint/checkout] status=${upstream.status} body=${rawText.slice(0, 300)}`);
    res.status(upstream.status).json(body);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Aappoint checkout API", detail: String(err) });
  }
});

// POST /api/aappoint/shop/:shopId/event/:eventId/confirm
// Push payment confirmation back to aappoint after Sui tx succeeds
// ⚠ Placeholder — update payment_method/endpoint once web2 team shares the push API
app.post("/api/aappoint/shop/:shopId/event/:eventId/confirm", async (req, res) => {
  const { shopId, eventId } = req.params;
  const { order_no, tx_hash, currency } = req.body as {
    order_no?: string;
    tx_hash?: string;
    currency?: string;
  };

  if (!order_no || !tx_hash) {
    res.status(400).json({ error: "missing order_no or tx_hash" });
    return;
  }

  // TODO: replace with actual aappoint payment update endpoint once confirmed
  console.log(`[aappoint] payment confirmed — shop=${shopId} event=${eventId} order=${order_no} tx=${tx_hash} currency=${currency}`);
  res.json({ ok: true, message: "Logged — push endpoint pending web2 team confirmation" });
});

// ── Serve Vite build in production (Cloud Run single-container deploy) ──
const distPath = path.resolve(process.cwd(), "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distPath, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}

app.listen(PORT, () => {
  console.log(`\nBooking API server running on http://localhost:${PORT}`);
  console.log(`  POST /api/faucet/usdc       — mint mock USDC to address`);
  console.log(`  POST /api/faucet/usdt       — mint mock USDT to address`);
  console.log(`  POST /api/faucet/suiusd     — mint mock SuiUSD to address`);
  console.log(`  POST /api/confirm-booking   — receive payment status`);
  console.log(`  POST /api/coupon/validate   — validate coupon code (stub)`);
  console.log(`  GET  /api/points/:address   — get points balance`);
  console.log(`  POST /api/points/redeem     — reserve points for discount`);
  console.log(`  POST /api/points/release    — release reserved points on tx fail`);
  console.log(`  GET  /api/health            — health check`);
  console.log(`  POST /api/reservation/incoming  — receive reservation from teammate → returns payment_url`);
  console.log(`  GET  /api/reservation/:token    — payment page fetches booking by token`);
  console.log(`  GET  /api/aappoint/shop/:shopId/event/:eventId — proxy aappoint event → BookingData`);
  console.log(`  POST /api/aappoint/shop/:shopId/event/:eventId/confirm — push payment result to aappoint\n`);
});
