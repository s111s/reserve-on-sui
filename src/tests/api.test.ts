/**
 * Automated API test suite — runs against local server on port 3001.
 *
 * IMPORTANT: The server MUST be started with TEST_MODE=true, otherwise
 * points tests will fail (awardPointsFallback is skipped when VITE_PACKAGE_ID
 * is set and TEST_MODE is not true).
 *
 * Usage:
 *   Terminal 1:  npm run server:test   ← starts server with TEST_MODE=true
 *   Terminal 2:  npm run test:api
 */

const BASE = "http://localhost:3001";
const IS_TEST_MODE = process.env.TEST_MODE === "true";

// Unique per run so in-memory state is always fresh
const RUN_ID = Date.now().toString(16).padStart(12, "0");
const TEST_ADDRESS    = `0x${RUN_ID}${"ab".repeat(13)}`.slice(0, 66);
const FAUCET_ADDRESS  = `0x${RUN_ID}${"cd".repeat(13)}`.slice(0, 66);
const REWARD_ADDRESS  = `0x${RUN_ID}${"ef".repeat(13)}`.slice(0, 66);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state: Record<string, string | number> = {};

// ── Colors ────────────────────────────────────────────────────────
const c = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ── Test runner ───────────────────────────────────────────────────
interface TestResult { id: string; name: string; passed: boolean; detail: string; skipped?: boolean }
const results: TestResult[] = [];

async function test(
  id: string,
  name: string,
  fn: () => Promise<{ pass: boolean; detail: string }>,
  skip?: string,
) {
  if (skip && !state[skip]) {
    results.push({ id, name, passed: false, detail: `Skipped — requires ${skip}`, skipped: true });
    console.log(`  ${c.yellow("⏭")}  ${c.dim(id)} ${c.dim(name)} ${c.yellow("(skipped)")}`);
    return;
  }
  try {
    const { pass, detail } = await fn();
    results.push({ id, name, passed: pass, detail });
    const icon = pass ? c.green("✅") : c.red("❌");
    const label = pass ? c.green(name) : c.red(name);
    console.log(`  ${icon}  ${c.dim(id)} ${label}`);
    if (!pass) console.log(`       ${c.dim("→ " + detail)}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ id, name, passed: false, detail });
    console.log(`  ${c.red("❌")}  ${c.dim(id)} ${c.red(name)}`);
    console.log(`       ${c.dim("→ " + detail)}`);
  }
}

async function GET(path: string) {
  const r = await fetch(`${BASE}${path}`);
  const body = await r.json() as Record<string, unknown>;
  return { status: r.status, body };
}
async function POST(path: string, payload: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json() as Record<string, unknown>;
  return { status: r.status, body };
}
async function PATCH(path: string, payload: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json() as Record<string, unknown>;
  return { status: r.status, body };
}
async function DELETE(path: string) {
  const r = await fetch(`${BASE}${path}`, { method: "DELETE" });
  const body = await r.json() as Record<string, unknown>;
  return { status: r.status, body };
}

// ── Tests ─────────────────────────────────────────────────────────
async function run() {
  console.log(`\n${c.bold("━━━ Agentic Booking — API Test Suite ━━━")}`);
  console.log(c.dim(`  Server:         ${BASE}`));
  console.log(c.dim(`  TEST_MODE:      ${IS_TEST_MODE}`));
  console.log(c.dim(`  Test address:   ${TEST_ADDRESS.slice(0, 14)}…${TEST_ADDRESS.slice(-6)}`));
  console.log(c.dim(`  Reward address: ${REWARD_ADDRESS.slice(0, 14)}…${REWARD_ADDRESS.slice(-6)}\n`));

  // ── T01: Health ─────────────────────────────────────────────────
  console.log(c.cyan("Health"));

  await test("T01", "GET /api/health → status ok", async () => {
    const { status, body } = await GET("/api/health");
    return { pass: status === 200 && body.status === "ok", detail: `status=${status}` };
  });

  // ── T02–T05: Reservation Webhook ────────────────────────────────
  console.log(c.cyan("\nReservation Webhook"));

  await test("T02", "POST /api/reservation/incoming — free booking returns token", async () => {
    const { status, body } = await POST("/api/reservation/incoming", {
      shop_id: 263, event_id: 101, order_no: `ORD-FREE-${RUN_ID}`,
      merchant_name: "Test Restaurant", merchant_type: "restaurant",
      date: "2026-06-10", time: "19:00", party_size: 2, fee_amount: 0,
      callback_url: "https://webhook.site/test",
    });
    const pass = status === 200 && body.ok === true && typeof body.token === "string";
    if (pass) { state.free_token = body.token as string; state.free_order_no = `ORD-FREE-${RUN_ID}`; }
    return { pass, detail: `status=${status} token=${body.token ?? "missing"}` };
  });

  await test("T03", "POST /api/reservation/incoming — paid booking returns token", async () => {
    const { status, body } = await POST("/api/reservation/incoming", {
      shop_id: 263, event_id: 102, order_no: `ORD-PAID-${RUN_ID}`,
      merchant_name: "Test Restaurant", merchant_type: "restaurant",
      date: "2026-06-10", time: "20:00", party_size: 2,
      fee_amount: 10.00, fee_currency: "USDC", fee_label: "Reservation deposit",
      callback_url: "https://webhook.site/test",
    });
    const pass = status === 200 && body.ok === true && typeof body.token === "string";
    if (pass) { state.paid_token = body.token as string; state.paid_order_no = `ORD-PAID-${RUN_ID}`; }
    return { pass, detail: `status=${status} token=${body.token ?? "missing"}` };
  });

  await test("T04", "GET /api/reservation/:token — fetch by valid token", async () => {
    const { status, body } = await GET(`/api/reservation/${state.free_token}`);
    const booking = body.booking as Record<string, unknown>;
    const pass = status === 200 && body.ok === true && booking?.booking_id === state.free_order_no;
    return { pass, detail: `status=${status} booking_id=${booking?.booking_id ?? "missing"}` };
  }, "free_token");

  await test("T05", "GET /api/reservation/invalid_token → 404", async () => {
    const { status, body } = await GET("/api/reservation/totally_invalid_xyz");
    return { pass: status === 404 && typeof body.error === "string", detail: `status=${status}` };
  });

  // ── T06–T07: Tier Endpoint ──────────────────────────────────────
  console.log(c.cyan("\nTier"));

  await test("T06", "GET /api/tier/:address — fresh address returns tier 0", async () => {
    const { status, body } = await GET(`/api/tier/${TEST_ADDRESS}`);
    const pass = status === 200 && typeof body.tier === "number" && body.tier === 0;
    return { pass, detail: `status=${status} tier=${body.tier}` };
  });

  await test("T07", "GET /api/tier/:address — has thresholds object", async () => {
    const { status, body } = await GET(`/api/tier/${TEST_ADDRESS}`);
    const thresholds = body.thresholds as Record<string, unknown>;
    const pass = status === 200 && typeof thresholds?.quartz === "number";
    return { pass, detail: `status=${status} thresholds.quartz=${thresholds?.quartz}` };
  });

  // ── T08–T13: Points & Booking Confirmation ──────────────────────
  console.log(c.cyan("\nPoints & Booking Confirmation"));

  await test("T08", "GET /api/points — fresh address starts at 0", async () => {
    const { status, body } = await GET(`/api/points/${TEST_ADDRESS}`);
    return { pass: status === 200 && body.balance === 0, detail: `balance=${body.balance}` };
  });

  await test("T09", "POST /api/confirm-booking — paid $10 earns 100 pts", async () => {
    const { status, body } = await POST("/api/confirm-booking", {
      status: "success", booking_id: `ORD-PAID-${RUN_ID}`,
      message: "Paid 10.00 USDC", user_address: TEST_ADDRESS,
      payment: { tx_hash: "FakeTx001", amount_usdc: 10, token: "USDC", chain: "sui:testnet", protocol: "s402" },
      receipt: { object_id: "0xfakeobj001", tx_hash: "FakeTx001" },
      error_code: null, metadata: null, points: null,
    });
    const earned = (body.points as Record<string, unknown>)?.earned;
    return { pass: status === 200 && earned === 100, detail: `earned=${earned} (expected 100)` };
  });

  await test("T10", "POST /api/confirm-booking — free booking earns 1 pt", async () => {
    const { status, body } = await POST("/api/confirm-booking", {
      status: "free", booking_id: `ORD-FREE-${RUN_ID}`,
      message: "Free booking", user_address: TEST_ADDRESS,
      payment: null, receipt: null, error_code: null, metadata: null, points: null,
    });
    const earned = (body.points as Record<string, unknown>)?.earned;
    return { pass: status === 200 && earned === 1, detail: `earned=${earned} (expected 1)` };
  });

  await test("T11", "POST /api/confirm-booking — failed status does NOT award pts", async () => {
    const before = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    await POST("/api/confirm-booking", {
      status: "failed", booking_id: `ORD-FAIL-${RUN_ID}`,
      message: "Tx rejected", user_address: TEST_ADDRESS,
      payment: null, receipt: null, error_code: "USER_REJECTED", metadata: null, points: null,
    });
    const after = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    return { pass: after === before, detail: `before=${before} after=${after} (should not change)` };
  });

  await test("T12", "POST /api/confirm-booking — duplicate booking_id is ignored", async () => {
    const before = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    await POST("/api/confirm-booking", {
      status: "success", booking_id: `ORD-PAID-${RUN_ID}`, // same ID as T09
      message: "Duplicate", user_address: TEST_ADDRESS,
      payment: { tx_hash: "FakeTxDup", amount_usdc: 10, token: "USDC", chain: "sui:testnet", protocol: "s402" },
      receipt: { object_id: "0xfakedupe", tx_hash: "FakeTxDup" },
      error_code: null, metadata: null, points: null,
    });
    const after = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    return { pass: after === before, detail: `before=${before} after=${after} (duplicate should not earn)` };
  });

  await test("T13", "GET /api/points — balance = 101 after paid + free booking", async () => {
    const { status, body } = await GET(`/api/points/${TEST_ADDRESS}`);
    return { pass: status === 200 && body.balance === 101, detail: `balance=${body.balance} (expected 101)` };
  });

  // ── T14–T17: Points Reservation (discount flow) ─────────────────
  console.log(c.cyan("\nPoints Reservation (discount flow)"));

  await test("T14", "POST /api/points/redeem — reserve 100 pts", async () => {
    const { status, body } = await POST("/api/points/redeem", {
      address: TEST_ADDRESS, points: 100, booking_id: `ORD-DISCOUNT-${RUN_ID}`,
    });
    const pass = status === 200 && body.ok === true && typeof body.token === "string";
    if (pass) state.redeem_token = body.token as string;
    return { pass, detail: `status=${status} token=${body.token ?? "missing"} discount=${body.discount_value}` };
  });

  await test("T15", "POST /api/points/redeem — exceeds balance → 400", async () => {
    const { status, body } = await POST("/api/points/redeem", {
      address: TEST_ADDRESS, points: 9999, booking_id: `ORD-EXCESS-${RUN_ID}`,
    });
    return { pass: status === 400 && typeof body.error === "string", detail: `status=${status}` };
  });

  await test("T16", "POST /api/points/redeem — below 100 minimum → 400", async () => {
    const { status, body } = await POST("/api/points/redeem", {
      address: TEST_ADDRESS, points: 50, booking_id: `ORD-LOW-${RUN_ID}`,
    });
    return { pass: status === 400 && typeof body.error === "string", detail: `status=${status}` };
  });

  await test("T17", "POST /api/points/release — restores reserved pts", async () => {
    const before = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    const { status, body } = await POST("/api/points/release", { token: state.redeem_token });
    const after = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    return { pass: status === 200 && body.ok === true && after > before, detail: `balance ${before} → ${after}` };
  }, "redeem_token");

  await test("T18", "POST /api/points/finalize — confirms reservation, balance stays deducted", async () => {
    const reserveRes = await POST("/api/points/redeem", {
      address: TEST_ADDRESS, points: 100, booking_id: `ORD-FINALIZE-${RUN_ID}`,
    });
    const token = reserveRes.body.token as string;
    const beforeFinalize = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    const { status, body } = await POST("/api/points/finalize", { token });
    const afterFinalize = (await GET(`/api/points/${TEST_ADDRESS}`)).body.balance as number;
    // Deduction applied at reserve time; finalize just clears the redemption slot — balance unchanged
    return { pass: status === 200 && body.ok === true && afterFinalize === beforeFinalize, detail: `status=${status} balance ${beforeFinalize} → ${afterFinalize} (should stay same)` };
  });

  // ── T19–T21: Rewards Catalog ─────────────────────────────────────
  console.log(c.cyan("\nRewards Catalog"));

  await test("T19", "GET /api/rewards — returns active rewards array", async () => {
    const { status, body } = await GET("/api/rewards");
    const rewards = body.rewards as unknown[];
    const pass = status === 200 && Array.isArray(rewards) && rewards.length >= 1;
    if (pass) state.first_reward_id = ((rewards[0] as Record<string, unknown>).id as string);
    return { pass, detail: `status=${status} count=${rewards?.length ?? 0}` };
  });

  await test("T20", "GET /api/rewards — each reward has required fields", async () => {
    const { body } = await GET("/api/rewards");
    const rewards = (body.rewards as Record<string, unknown>[]) ?? [];
    const r = rewards[0];
    const pass = typeof r?.id === "string" && typeof r?.points_cost === "number" && typeof r?.required_tier === "number";
    return { pass, detail: `id=${r?.id} points_cost=${r?.points_cost} required_tier=${r?.required_tier}` };
  });

  // ── T22–T27: Reward Redemption & Vouchers ───────────────────────
  console.log(c.cyan("\nReward Redemption & Vouchers"));

  // Fund REWARD_ADDRESS with enough points for welcome_drink (100 pts, tier 1)
  await POST("/api/confirm-booking", {
    status: "success", booking_id: `ORD-FUND-REWARD-${RUN_ID}`,
    message: "Paid 10.00 USDC", user_address: REWARD_ADDRESS,
    payment: { tx_hash: "FakeTxFund", amount_usdc: 10, token: "USDC", chain: "sui:testnet", protocol: "s402" },
    receipt: { object_id: "0xfakefund", tx_hash: "FakeTxFund" },
    error_code: null, metadata: null, points: null,
  });

  await test("T22", "POST /api/rewards/redeem — valid reward (fallback mode, no contract)", async () => {
    const { status, body } = await POST("/api/rewards/redeem", {
      address: REWARD_ADDRESS, reward_id: "welcome_drink", // 100 pts, funded address has 100
    });
    // fallback mode: ok=true + voucher_code; contract mode: txBytes returned
    const fallback = body.ok === true && typeof body.voucher_code === "string";
    const contract = typeof body.txBytes === "string" && typeof body.voucher_code === "string";
    const pass = status === 200 && (fallback || contract);
    if (pass) state.voucher_code = body.voucher_code as string;
    return { pass, detail: `status=${status} mode=${fallback ? "fallback" : contract ? "contract" : "unknown"} voucher=${body.voucher_code ?? "missing"}` };
  });

  await test("T23", "POST /api/rewards/redeem — insufficient points → 400", async () => {
    // REWARD_ADDRESS now has 0 pts after welcome_drink (100 pts)
    const { status, body } = await POST("/api/rewards/redeem", {
      address: REWARD_ADDRESS, reward_id: "free_dessert", // costs 150 pts
    });
    return { pass: status === 400 && typeof body.error === "string", detail: `status=${status} error=${body.error ?? "missing"}` };
  });

  await test("T24", "POST /api/rewards/redeem — unknown reward_id → 404", async () => {
    const { status, body } = await POST("/api/rewards/redeem", {
      address: REWARD_ADDRESS, reward_id: "does_not_exist_xyz",
    });
    return { pass: status === 404 && typeof body.error === "string", detail: `status=${status}` };
  });

  await test("T25", "GET /api/vouchers/:address — returns voucher list", async () => {
    const { status, body } = await GET(`/api/vouchers/${REWARD_ADDRESS}`);
    const vouchers = body.vouchers as unknown[];
    const pass = status === 200 && Array.isArray(vouchers) && vouchers.length >= 1;
    return { pass, detail: `status=${status} count=${vouchers?.length ?? 0}` };
  }, "voucher_code");

  await test("T26", "GET /api/vouchers/:address — voucher has required fields", async () => {
    const { body } = await GET(`/api/vouchers/${REWARD_ADDRESS}`);
    const vouchers = (body.vouchers as Record<string, unknown>[]) ?? [];
    const v = vouchers.find((x) => (x as Record<string, unknown>).code === state.voucher_code) ?? vouchers[0];
    const pass = typeof v?.code === "string" && typeof v?.reward_name === "string" && typeof v?.created_at === "string" && v?.used === false;
    return { pass, detail: `code=${v?.code} reward_name=${v?.reward_name} used=${v?.used} created_at=${v?.created_at}` };
  }, "voucher_code");

  await test("T27", "POST /api/vouchers/:code/use — marks voucher as used", async () => {
    const { status, body } = await POST(`/api/vouchers/${state.voucher_code}/use`, {});
    const pass = status === 200 && body.ok === true;
    return { pass, detail: `status=${status} ok=${body.ok}` };
  }, "voucher_code");

  await test("T28", "POST /api/vouchers/:code/use — already used → 400", async () => {
    const { status, body } = await POST(`/api/vouchers/${state.voucher_code}/use`, {});
    return { pass: status === 400 && typeof body.error === "string", detail: `status=${status} error=${body.error}` };
  }, "voucher_code");

  // ── T29–T33: Faucets ─────────────────────────────────────────────
  console.log(c.cyan("\nFaucets"));

  await test("T29", "POST /api/faucet/usdc → ok", async () => {
    const { status, body } = await POST("/api/faucet/usdc", { address: FAUCET_ADDRESS, amount: 500 });
    return { pass: status === 200 && body.ok === true, detail: `status=${status} error=${body.error ?? "none"}` };
  });

  await sleep(3000);

  await test("T30", "POST /api/faucet/usdt → ok", async () => {
    const { status, body } = await POST("/api/faucet/usdt", { address: FAUCET_ADDRESS, amount: 500 });
    return { pass: status === 200 && body.ok === true, detail: `status=${status} error=${body.error ?? "none"}` };
  });

  await sleep(3000);

  await test("T31", "POST /api/faucet/suiusd → ok", async () => {
    const { status, body } = await POST("/api/faucet/suiusd", { address: FAUCET_ADDRESS, amount: 500 });
    return { pass: status === 200 && body.ok === true, detail: `status=${status} error=${body.error ?? "none"}` };
  });

  if (IS_TEST_MODE) {
    results.push({ id: "T32", name: "Faucet rate limit → 429 (skipped in TEST_MODE)", passed: true, detail: "Rate limiter disabled in TEST_MODE", skipped: true });
    console.log(`  ${c.yellow("⏭")}  ${c.dim("T32")} ${c.dim("Faucet rate limit")} ${c.yellow("(skipped — TEST_MODE)")}`);
  } else {
    await test("T32", "POST /api/faucet/usdc — 4th call same address → 429", async () => {
      const addr = `0x${RUN_ID}${"ee".repeat(13)}`.slice(0, 66);
      await POST("/api/faucet/usdc", { address: addr, amount: 100 });
      await POST("/api/faucet/usdc", { address: addr, amount: 100 });
      await POST("/api/faucet/usdc", { address: addr, amount: 100 });
      const { status } = await POST("/api/faucet/usdc", { address: addr, amount: 100 });
      return { pass: status === 429, detail: `4th call status=${status} (expected 429)` };
    });
  }

  // ── T33–T35: Admin Endpoints ─────────────────────────────────────
  console.log(c.cyan("\nAdmin"));

  await test("T33", "GET /api/admin/config — returns points config", async () => {
    const { status, body } = await GET("/api/admin/config");
    const config = body.config as Record<string, unknown>;
    const pass = status === 200 && typeof config?.points_per_dollar_nonrefundable === "number";
    return { pass, detail: `status=${status} pts_per_dollar=${config?.points_per_dollar_nonrefundable}` };
  });

  await test("T34", "GET /api/admin/rewards — returns full reward catalog", async () => {
    const { status, body } = await GET("/api/admin/rewards");
    const rewards = body.rewards as unknown[];
    const pass = status === 200 && Array.isArray(rewards) && rewards.length >= 1;
    return { pass, detail: `status=${status} count=${rewards?.length ?? 0}` };
  });

  await test("T35", "Admin reward CRUD — create, patch, delete", async () => {
    // Create — server generates the id, does not accept a custom one
    const create = await POST("/api/admin/rewards", {
      name: "Test Reward", description: "Automated test reward",
      restaurant: "Test Venue", restaurant_type: "any",
      points_cost: 50, required_tier: 1, category: "drink",
    });
    if (create.status !== 200) return { pass: false, detail: `create status=${create.status} error=${create.body.error}` };
    const createdId = (create.body.reward as Record<string, unknown>)?.id as string;
    if (!createdId) return { pass: false, detail: "create did not return reward.id" };

    // Patch
    const patch = await PATCH(`/api/admin/rewards/${createdId}`, { name: "Test Reward Updated" });
    if (patch.status !== 200) return { pass: false, detail: `patch status=${patch.status}` };

    // Delete
    const del = await DELETE(`/api/admin/rewards/${createdId}`);
    const pass = del.status === 200 && del.body.ok === true;
    return { pass, detail: `create=${create.status} id=${createdId} patch=${patch.status} delete=${del.status}` };
  });

  // ── Summary ───────────────────────────────────────────────────────
  const passed  = results.filter((r) => r.passed).length;
  const failed  = results.filter((r) => !r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  console.log(`\n${c.bold("━━━ Results ━━━")}`);
  console.log(`  ${c.green(`✅ ${passed} passed`)}  ${failed > 0 ? c.red(`❌ ${failed} failed`) : c.dim("0 failed")}  ${skipped > 0 ? c.yellow(`⏭ ${skipped} skipped`) : ""}`);

  if (failed > 0) {
    console.log(c.red("\n  Failed:"));
    results.filter((r) => !r.passed && !r.skipped).forEach((r) => {
      console.log(`  ${c.red("❌")} ${c.dim(r.id)} ${r.name}`);
      console.log(`       ${c.dim("→ " + r.detail)}`);
    });
  }

  const allPassed = failed === 0;
  console.log(`\n  ${allPassed ? c.green("All tests passed 🎉") : c.red(`${failed}/${results.length} tests failed`)}\n`);
  process.exit(allPassed ? 0 : 1);
}

run().catch((err) => {
  console.error(c.red("\n❌ Test runner crashed:"), err instanceof Error ? err.message : err);
  process.exit(1);
});
