/**
 * zkLogin Flow Diagnostic Test
 *
 * Runs every step of the zkLogin flow with real config values.
 * Each step is labelled PASS / FAIL / WARN / INFO.
 * Steps 1-7 are fully automated (no JWT needed).
 * Steps 8-12 need a real JWT — run with: npx tsx scripts/test-zklogin.ts <JWT>
 *
 * Usage:
 *   npx tsx scripts/test-zklogin.ts
 *   npx tsx scripts/test-zklogin.ts <google_id_token>
 */

import "dotenv/config";
import crypto from "crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import {
  Ed25519Keypair,
} from "@mysten/sui/keypairs/ed25519";
import {
  computeZkLoginAddressFromSeed,
  genAddressSeed,
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  decodeJwt,
} from "@mysten/sui/zklogin";
import { bcs as suiBcs } from "@mysten/bcs";
import { toB64, fromB64 } from "@mysten/sui/utils";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let warned = 0;

function pass(step: string, detail = "") {
  console.log(`  ✅ PASS  [${step}]${detail ? " — " + detail : ""}`);
  passed++;
}
function fail(step: string, detail = "") {
  console.log(`  ❌ FAIL  [${step}]${detail ? " — " + detail : ""}`);
  failed++;
}
function warn(step: string, detail = "") {
  console.log(`  ⚠️  WARN  [${step}]${detail ? " — " + detail : ""}`);
  warned++;
}
function info(detail: string) {
  console.log(`  ℹ️  INFO  ${detail}`);
}
function header(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}`);
}

// ── Known test fixtures (from data/salts.json + .env) ────────────────────────

const KNOWN_SUB = "116966358067368061998";
const KNOWN_AUD = "848097966981-l6pm32vad8t0mcs8ajjiljanas9mmk4g.apps.googleusercontent.com";
const KNOWN_ISS = "https://accounts.google.com";
const KNOWN_SALT = "250556927248768582859985094604209663787";
const EXPECTED_ADDRESS_PREFIX = "0x107b"; // what SDK computes

const SHINAMI_KEY = process.env.SHINAMI_WALLET_KEY ?? "";
const SALT_SECRET = process.env.SALT_SECRET ?? "";
const GOOGLE_CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID ?? "";
const SUI_NETWORK = (process.env.VITE_SUI_NETWORK ?? "testnet") as "testnet" | "devnet" | "mainnet";

// ── Step 1: Config check ─────────────────────────────────────────────────────

header("STEP 1 — Environment / Config");

if (SHINAMI_KEY) pass("shinami_key_set", SHINAMI_KEY.slice(0, 20) + "…");
else fail("shinami_key_set", "SHINAMI_WALLET_KEY not in .env");

if (SALT_SECRET) pass("salt_secret_set", SALT_SECRET.slice(0, 8) + "…");
else fail("salt_secret_set", "SALT_SECRET not in .env — server uses random key each restart");

if (GOOGLE_CLIENT_ID) pass("google_client_id_set", GOOGLE_CLIENT_ID.slice(0, 20) + "…");
else fail("google_client_id_set", "VITE_GOOGLE_CLIENT_ID not in .env");

info(`Network: ${SUI_NETWORK}`);

// ── Step 2: Salt derivation (self-hosted HMAC) ───────────────────────────────

header("STEP 2 — Salt Derivation (self-hosted HMAC)");

function deriveSalt(sub: string, aud: string): string {
  const key = `${sub}:${aud}`;
  const hmac = crypto.createHmac("sha256", SALT_SECRET).update(key).digest();
  return BigInt("0x" + hmac.slice(0, 16).toString("hex")).toString();
}

const computedSalt = deriveSalt(KNOWN_SUB, KNOWN_AUD);
info(`sub:   ${KNOWN_SUB}`);
info(`aud:   ${KNOWN_AUD.slice(0, 30)}…`);
info(`salt from .env secret: ${computedSalt}`);
info(`salt in data/salts.json: ${KNOWN_SALT}`);

if (computedSalt === KNOWN_SALT) {
  pass("salt_matches_stored", computedSalt);
} else {
  fail("salt_matches_stored",
    `SALT_SECRET in .env gives ${computedSalt} but salts.json has ${KNOWN_SALT}. ` +
    `Server uses salts.json cache — they might differ if SALT_SECRET changed since first login.`);
}

// ── Step 3: addressSeed computation (SDK genAddressSeed) ─────────────────────

header("STEP 3 — addressSeed Computation (SDK genAddressSeed)");

const storedSalt = KNOWN_SALT; // always use the persisted value
const sdkSeed = genAddressSeed(BigInt(storedSalt), "sub", KNOWN_SUB, KNOWN_AUD);
info(`addressSeed (dec): ${sdkSeed.toString()}`);
info(`addressSeed (hex): ${sdkSeed.toString(16)}`);
info(`addressSeed bytes: ${sdkSeed.toString(16).length / 2} bytes`);

if (sdkSeed.toString(16).length <= 64) {
  pass("seed_is_valid_field_element", sdkSeed.toString(16).slice(0, 16) + "…");
} else {
  fail("seed_is_valid_field_element", "seed > 32 bytes — unexpected");
}

// ── Step 4: Address computation (SDK computeZkLoginAddressFromSeed) ───────────

header("STEP 4 — Address Computation (SDK)");

const addrLegacyFalse = computeZkLoginAddressFromSeed(sdkSeed, KNOWN_ISS, false);
const addrLegacyTrue  = computeZkLoginAddressFromSeed(sdkSeed, KNOWN_ISS, true);
info(`address (legacy=false): ${addrLegacyFalse}`);
info(`address (legacy=true):  ${addrLegacyTrue}`);

if (addrLegacyFalse === addrLegacyTrue) {
  pass("legacy_flag_does_not_matter", "both give same address (seed has no leading zeros)");
} else {
  warn("legacy_flag_differs",
    `legacy=false: ${addrLegacyFalse}  legacy=true: ${addrLegacyTrue} — seed has leading zeros!`);
}

if (addrLegacyFalse.startsWith(EXPECTED_ADDRESS_PREFIX)) {
  pass("sdk_address_matches_expected", addrLegacyFalse);
} else {
  warn("sdk_address_different_from_expected",
    `SDK gives ${addrLegacyFalse} but on-chain verifier gives ${EXPECTED_ADDRESS_PREFIX}… (known mismatch)`);
}

// ── Step 5: Manual blake2b address derivation (verify SDK formula) ────────────

header("STEP 5 — Manual blake2b Verification (matches SDK formula)");

const seedBytes32 = hexToBytes(sdkSeed.toString(16).padStart(64, "0"));
const issBytes = new TextEncoder().encode(KNOWN_ISS);

const preimage = new Uint8Array(2 + issBytes.length + seedBytes32.length);
preimage[0] = 0x05; // ZkLogin scheme flag
preimage[1] = issBytes.length;
preimage.set(issBytes, 2);
preimage.set(seedBytes32, 2 + issBytes.length);

const hash = blake2b(preimage, { dkLen: 32 });
const manualAddr = "0x" + bytesToHex(hash);

info(`manual blake2b result: ${manualAddr}`);
if (manualAddr.startsWith(addrLegacyFalse)) {
  pass("manual_blake2b_matches_sdk", manualAddr.slice(0, 20) + "…");
} else {
  fail("manual_blake2b_matches_sdk",
    `Expected ${addrLegacyFalse} but got ${manualAddr} — SDK/manual formula mismatch`);
}

// ── Step 6: BCS round-trip — addressSeed survives serialize → parse ───────────

header("STEP 6 — BCS Round-trip (getZkLoginSignature → parseZkLoginSignature)");

// Create a real ephemeral keypair and sign fake bytes
const seed32 = crypto.getRandomValues(new Uint8Array(32));
const keypair = Ed25519Keypair.fromSecretKey(seed32);
const fakeTxBytes = crypto.getRandomValues(new Uint8Array(64));
const { signature: ephemeralSig } = await keypair.signTransaction(fakeTxBytes);

// Build a minimal fake proof using realistic-length field element strings
// Real Groth16 BN254 field elements are 77-78 digit decimal numbers
const FAKE_FIELD = "15988872694983317230063574448781660918184635207503670487030995421819464185557";
const fakeProof = {
  proofPoints: {
    a: [FAKE_FIELD, FAKE_FIELD],
    b: [[FAKE_FIELD, FAKE_FIELD], [FAKE_FIELD, FAKE_FIELD]],
    c: [FAKE_FIELD, FAKE_FIELD],
  },
  issBase64Details: { value: "aXNz", indexMod4: 0 },
  headerBase64: "eyJhbGciOiJSUzI1NiJ9",
  addressSeed: sdkSeed.toString(),
};

// NOTE: parseZkLoginSignature in the SDK does NOT strip the ZkLogin flag byte (0x05)
// before BCS-parsing — parsing the full sig (including flag) misreads lengths and fails.
// We use a local BCS struct that mirrors the SDK's layout and parse bytes.slice(1).
const zkLoginSignatureBcs = suiBcs.struct("ZkLoginSignature", {
  inputs: suiBcs.struct("ZkLoginSignatureInputs", {
    proofPoints: suiBcs.struct("ZkLoginSignatureInputsProofPoints", {
      a: suiBcs.vector(suiBcs.string()),
      b: suiBcs.vector(suiBcs.vector(suiBcs.string())),
      c: suiBcs.vector(suiBcs.string()),
    }),
    issBase64Details: suiBcs.struct("ZkLoginSignatureInputsClaim", {
      value: suiBcs.string(),
      indexMod4: suiBcs.u8(),
    }),
    headerBase64: suiBcs.string(),
    addressSeed: suiBcs.string(),
  }),
  maxEpoch: suiBcs.u64(),
  userSignature: suiBcs.byteVector(),
});

let parsedSeed: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zkSig = getZkLoginSignature({
    inputs: fakeProof as any,
    maxEpoch: 999,
    userSignature: ephemeralSig,
  });

  // Decode base64, skip flag byte (byte 0), parse BCS from byte 1
  const zkSigBytes = fromB64(zkSig);
  info(`zkSig flag byte: ${zkSigBytes[0]} (expected 5 = ZkLogin scheme)`);
  if (zkSigBytes[0] !== 5) {
    fail("bcs_roundtrip_flag_byte", `Expected 5, got ${zkSigBytes[0]}`);
  } else {
    pass("bcs_roundtrip_flag_byte");
  }

  const parsed = zkLoginSignatureBcs.parse(zkSigBytes.slice(1));
  parsedSeed = parsed.inputs.addressSeed;

  if (parsedSeed === sdkSeed.toString()) {
    pass("addressSeed_survives_bcs_roundtrip", parsedSeed.slice(0, 20) + "…");
  } else {
    fail("addressSeed_survives_bcs_roundtrip",
      `Input:  ${sdkSeed.toString().slice(0, 20)}…\nParsed: ${parsedSeed.slice(0, 20)}…`);
  }

  // Also check the issBase64Details survived
  if (JSON.stringify(parsed.inputs.issBase64Details) === JSON.stringify(fakeProof.issBase64Details)) {
    pass("issBase64Details_survives_bcs_roundtrip");
  } else {
    fail("issBase64Details_survives_bcs_roundtrip",
      `Input:  ${JSON.stringify(fakeProof.issBase64Details)}\nParsed: ${JSON.stringify(parsed.inputs.issBase64Details)}`);
  }
} catch (e) {
  fail("bcs_roundtrip", String(e));
}

// ── Step 7: Address from parsed addressSeed matches SDK ───────────────────────

header("STEP 7 — Address Derivation from Parsed Signature");

info("NOTE: SDK's parseZkLoginSignature has a bug — it does not strip the ZkLogin flag byte");
info("      (0x05) before BCS-parsing. We use a local re-implementation in step 6 instead.");

if (parsedSeed) {
  const addrFromParsed = computeZkLoginAddressFromSeed(BigInt(parsedSeed), KNOWN_ISS, false);
  info(`address from parsed sig: ${addrFromParsed}`);
  if (addrFromParsed === addrLegacyFalse) {
    pass("parsed_sig_resolves_to_same_address", addrFromParsed);
  } else {
    fail("parsed_sig_resolves_to_same_address",
      `SDK address: ${addrLegacyFalse}\nParsed-sig address: ${addrFromParsed}`);
  }
} else {
  fail("parsed_sig_resolves_to_same_address", "could not parse signature in step 6");
}

// ── Step 8: Sui RPC connectivity ──────────────────────────────────────────────

header("STEP 8 — Sui RPC Connectivity");

try {
  const client = new SuiClient({ url: getFullnodeUrl(SUI_NETWORK) });
  const state = await client.getLatestSuiSystemState();
  pass("sui_rpc_connected", `epoch=${state.epoch} network=${SUI_NETWORK}`);

  const maxEpoch = Number(state.epoch) + 2;
  info(`current epoch: ${state.epoch}  maxEpoch for new proof: ${maxEpoch}`);
} catch (e) {
  fail("sui_rpc_connected", String(e));
}

// ── Step 9: Shinami prover connectivity (no JWT needed) ───────────────────────

header("STEP 9 — Shinami Prover Connectivity");

if (!SHINAMI_KEY) {
  fail("shinami_prover_connectivity", "SHINAMI_WALLET_KEY not set");
} else {
  try {
    // Send deliberately malformed request — expect a JSON-RPC error, not a network error
    const r = await fetch("https://api.us1.shinami.com/sui/zkprover/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": SHINAMI_KEY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shinami_zkp_createZkLoginProof", params: [] }),
    });
    const body = await r.text();
    info(`HTTP status: ${r.status}`);
    info(`Response: ${body.slice(0, 200)}`);

    if (r.status === 401 || r.status === 403) {
      fail("shinami_prover_connectivity", `Auth error ${r.status} — check SHINAMI_WALLET_KEY`);
    } else if (r.status === 200 || r.status === 400) {
      // 400 = malformed params (expected), 200 = response with JSON-RPC error
      pass("shinami_prover_connectivity", `Reachable, HTTP ${r.status}`);
      const data = JSON.parse(body) as { error?: { code: number; message: string } };
      if (data.error) {
        info(`JSON-RPC error (expected for empty params): ${data.error.message}`);
      }
    } else {
      warn("shinami_prover_connectivity", `Unexpected HTTP ${r.status}`);
    }
  } catch (e) {
    fail("shinami_prover_connectivity", `Network error: ${String(e)}`);
  }
}

// ── Step 10: Shinami gas station connectivity ─────────────────────────────────

header("STEP 10 — Shinami Gas Station Connectivity");

const GAS_KEY = process.env.SHINAMI_GAS_KEY ?? SHINAMI_KEY;
if (!GAS_KEY) {
  fail("shinami_gas_connectivity", "SHINAMI_GAS_KEY not set");
} else {
  try {
    const r = await fetch("https://api.us1.shinami.com/sui/gas/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": GAS_KEY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gas_sponsorTransactionBlock", params: [] }),
    });
    const body = await r.text();
    info(`HTTP status: ${r.status}`);
    info(`Response: ${body.slice(0, 200)}`);

    if (r.status === 401 || r.status === 403) {
      fail("shinami_gas_connectivity", `Auth error ${r.status}`);
    } else {
      pass("shinami_gas_connectivity", `Reachable, HTTP ${r.status}`);
    }
  } catch (e) {
    fail("shinami_gas_connectivity", `Network error: ${String(e)}`);
  }
}

// ── Steps 11-15 require a real session ───────────────────────────────────────
//
// Pass the full zklogin_session JSON (NOT just the JWT).
// The Shinami prover validates that extendedEphemeralPublicKey + randomness + maxEpoch
// reproduce the nonce embedded in the JWT — so we must use the same ephemeral key
// that was used when the JWT was obtained.
//
// How to get the session JSON:
//   1. Open the app and sign in with Google
//   2. DevTools → Application → Session Storage → zklogin_session
//   3. Copy the entire JSON value
//   4. npx tsx scripts/test-zklogin.ts '<paste-session-json-here>'

interface StoredSession {
  ephemeralSeed: string;
  randomness: string;
  maxEpoch: number;
  nonce: string;
  jwt?: string;
  salt?: string;
  address?: string;
  sub?: string;
  aud?: string;
}

const rawArg = process.argv[2];
let sessionArg: StoredSession | null = null;
let jwtArg: string | null = null;

if (rawArg) {
  // Accept either a JSON session object or a bare JWT string
  if (rawArg.trim().startsWith("{")) {
    try {
      sessionArg = JSON.parse(rawArg) as StoredSession;
      jwtArg = sessionArg.jwt ?? null;
    } catch (e) {
      console.error("Could not parse argument as JSON:", e);
      process.exit(1);
    }
  } else {
    // Bare JWT — can only run steps 11-12 (no proof call)
    jwtArg = rawArg;
  }
}

header("STEPS 11-15 — Real Session Required");

if (!jwtArg) {
  info("No session provided. Steps 11–15 skipped.");
  info("To run full test, copy the session from sessionStorage and pass as JSON:");
  info("  1. Sign in with Google in the app");
  info("  2. DevTools → Application → Session Storage → zklogin_session");
  info("  3. Copy the entire JSON value");
  info("  4. npx tsx scripts/test-zklogin.ts '<session-json>'");
  info("");
  printSummary();
  process.exit(failed > 0 ? 1 : 0);
}

// ── Step 11: JWT decode + claims ──────────────────────────────────────────────

header("STEP 11 — JWT Decode + Claims");

let jwtSub = "", jwtAud = "", jwtIss = "";
try {
  const claims = decodeJwt(jwtArg);
  jwtSub = claims.sub as string;
  jwtIss = claims.iss as string;
  jwtAud = (Array.isArray(claims.aud) ? claims.aud[0] : claims.aud) as string;
  const exp = claims.exp as number;
  const expDate = new Date(exp * 1000);
  const isExpired = exp * 1000 < Date.now();

  // Also decode raw JWT payload (no normalization) to see actual iss bytes
  let rawJwtIss = "(unknown)";
  try {
    const rawPayload = JSON.parse(Buffer.from(jwtArg.split(".")[1], "base64url").toString()) as Record<string, unknown>;
    rawJwtIss = rawPayload.iss as string;
    info(`iss RAW (from payload):     "${rawJwtIss}"`);
  } catch { /* ignore */ }

  info(`iss (decodeJwt normalized): "${jwtIss}"`);
  info(`sub: ${jwtSub}`);
  info(`aud: ${jwtAud.slice(0, 40)}…`);
  info(`exp: ${expDate.toISOString()} (${isExpired ? "EXPIRED ❌" : "valid ✅"})`);

  if (rawJwtIss === jwtIss) {
    pass("raw_iss_matches_normalized", rawJwtIss);
  } else {
    info(`⚠  raw iss "${rawJwtIss}" ≠ normalized "${jwtIss}" — SDK normalizes for you`);
  }

  if (isExpired) {
    warn("jwt_not_expired", "JWT is expired — proof may still be generated but test this soon after login");
  } else {
    pass("jwt_not_expired");
  }

  if (jwtAud === GOOGLE_CLIENT_ID) {
    pass("jwt_aud_matches_config");
  } else {
    warn("jwt_aud_matches_config", `aud=${jwtAud} but VITE_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}`);
  }
} catch (e) {
  fail("jwt_decode", String(e));
  printSummary();
  process.exit(1);
}

// ── Step 12: Salt for JWT user + address derivation ───────────────────────────

header("STEP 12 — Salt + Address for JWT User");

const jwtSalt = sessionArg?.salt ?? deriveSalt(jwtSub, jwtAud);
if (sessionArg?.salt) {
  info(`salt from session: ${jwtSalt}`);
  const derivedSalt = deriveSalt(jwtSub, jwtAud);
  if (derivedSalt === jwtSalt) {
    pass("session_salt_matches_derived", jwtSalt);
  } else {
    warn("session_salt_matches_derived",
      `session.salt=${jwtSalt} but HMAC derivation gives ${derivedSalt} — server may have used a different SALT_SECRET`);
  }
} else {
  info(`salt derived from HMAC: ${jwtSalt}`);
}

const jwtSeed = genAddressSeed(BigInt(jwtSalt), "sub", jwtSub, jwtAud);
const jwtAddr = computeZkLoginAddressFromSeed(jwtSeed, jwtIss, false);
info(`addressSeed (hex): 0x${jwtSeed.toString(16)}`);
info(`Sui address (SDK): ${jwtAddr}`);

if (sessionArg?.address) {
  info(`address in session: ${sessionArg.address}`);
  if (sessionArg.address === jwtAddr) {
    pass("session_address_matches_sdk", jwtAddr);
  } else {
    fail("session_address_matches_sdk",
      `session.address=${sessionArg.address} but SDK gives ${jwtAddr}\n` +
      `→ session was saved with a DIFFERENT address formula — stale session?`);
  }
}

if (jwtSub === KNOWN_SUB) {
  info("This is the known test user.");
  if (jwtSalt === KNOWN_SALT) {
    pass("salt_consistent_for_known_user");
  } else {
    fail("salt_consistent_for_known_user",
      `Expected ${KNOWN_SALT} but computed ${jwtSalt}. SALT_SECRET may have changed.`);
  }
}

// ── Step 13: Shinami prover — full proof request ──────────────────────────────

header("STEP 13 — Shinami Prover (full proof request)");

let proofAddressSeed: string | null = null;
let proofIssBase64Details: { value: string; indexMod4: number } | null = null;

if (!SHINAMI_KEY) {
  fail("shinami_proof_request", "SHINAMI_WALLET_KEY not set");
} else if (!sessionArg) {
  // Only have a bare JWT — can't call prover without ephemeral key
  warn("shinami_proof_request",
    "Skipped — need full session JSON (with ephemeralSeed/randomness/maxEpoch) to call Shinami prover. " +
    "Pass the full zklogin_session JSON instead of a bare JWT.");
} else {
  try {
    const sessionKeypair = Ed25519Keypair.fromSecretKey(fromB64(sessionArg.ephemeralSeed));
    const extPubKey = getExtendedEphemeralPublicKey(sessionKeypair.getPublicKey());
    const { maxEpoch, randomness } = sessionArg;

    // Verify the nonce in the JWT matches the session's ephemeral key
    const expectedNonce = generateNonce(sessionKeypair.getPublicKey(), maxEpoch, randomness);
    info(`session.maxEpoch: ${maxEpoch}  session.randomness: ${randomness.slice(0, 10)}…`);
    info(`extPubKey (from session): ${extPubKey.slice(0, 30)}…`);
    info(`expected nonce: ${expectedNonce}`);
    info(`session.nonce:  ${sessionArg.nonce}`);

    if (expectedNonce === sessionArg.nonce) {
      pass("nonce_matches_session", expectedNonce.slice(0, 20) + "…");
    } else {
      fail("nonce_matches_session",
        `Recomputed nonce ${expectedNonce} does not match session.nonce ${sessionArg.nonce}. ` +
        `Session data may be corrupted.`);
    }

    info(`Sending proof request to Shinami with salt=${jwtSalt}…`);

    const r = await fetch("https://api.us1.shinami.com/sui/zkprover/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": SHINAMI_KEY },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "shinami_zkp_createZkLoginProof",
        params: [jwtArg, String(maxEpoch), extPubKey, randomness, jwtSalt],
      }),
    });


    const raw = await r.text();
    info(`HTTP status: ${r.status}`);
    info(`Response (first 500 chars): ${raw.slice(0, 500)}`);

    if (!r.ok) {
      fail("shinami_proof_request", `HTTP ${r.status}: ${raw.slice(0, 200)}`);
    } else {
      const data = JSON.parse(raw) as {
        result?: Record<string, unknown>;
        error?: { code: number; message: string; data?: unknown };
      };

      if (data.error) {
        fail("shinami_proof_request", `JSON-RPC error: ${JSON.stringify(data.error)}`);
      } else if (data.result) {
        pass("shinami_proof_request", "Got proof response");
        info(`result keys: ${Object.keys(data.result).join(", ")}`);

        const zkProof = (data.result.zkProof ?? data.result) as Record<string, unknown>;
        info(`zkProof keys: ${Object.keys(zkProof).join(", ")}`);

        proofAddressSeed = zkProof.addressSeed != null ? String(zkProof.addressSeed) : null;

        if (proofAddressSeed) {
          pass("shinami_returns_addressSeed", proofAddressSeed.slice(0, 20) + "…");
          const proofAddr = computeZkLoginAddressFromSeed(BigInt(proofAddressSeed), jwtIss, false);
          info(`address from Shinami's addressSeed: ${proofAddr}`);
          if (proofAddr === jwtAddr) {
            pass("shinami_addressSeed_matches_sdk", proofAddr);
          } else {
            fail("shinami_addressSeed_matches_sdk",
              `SDK: ${jwtAddr}\nShinami: ${proofAddr}\n→ THIS IS THE ROOT CAUSE OF THE SIGNATURE ERROR`);
          }
        } else {
          warn("shinami_returns_addressSeed", "addressSeed not in Shinami response — using SDK's genAddressSeed");
        }

        const issDetails = zkProof.issBase64Details as { value: string; indexMod4: number } | undefined;
        if (issDetails) {
          proofIssBase64Details = issDetails;
          info(`issBase64Details: ${JSON.stringify(issDetails)}`);
        }
      }
    }
  } catch (e) {
    fail("shinami_proof_request", String(e));
  }
}

// ── Step 14: Decode ISS from proof's issBase64Details ────────────────────────

header("STEP 14 — ISS Extraction from proof.issBase64Details");

if (!proofIssBase64Details) {
  info("Skipped — no proof from step 13");
} else {
  try {
    const { value, indexMod4 } = proofIssBase64Details;
    const b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bits: number[] = [];
    for (const c of value) {
      const idx = b64chars.indexOf(c);
      if (idx === -1) throw new Error(`Invalid base64url char: ${c}`);
      bits = bits.concat(Array.from(idx.toString(2).padStart(6, "0")).map(Number));
    }
    const strip = [0, 2, 4][indexMod4] ?? 0;
    bits = bits.slice(strip);
    const trailing = bits.length % 8;
    if (trailing) bits = bits.slice(0, bits.length - trailing);
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      bits.slice(i * 8, i * 8 + 8).forEach((b, j) => { bytes[i] |= b << (7 - j); });
    }
    const decoded = new TextDecoder().decode(bytes);
    info(`decoded claim string: ${JSON.stringify(decoded)}`);
    const match = decoded.match(/"iss"\s*:\s*"([^"]+)"/);
    if (match) {
      const rawIss = match[1];
      info(`raw ISS from proof:       "${rawIss}"`);
      info(`ISS from decodeJwt:       "${jwtIss}"`);

      if (rawIss === jwtIss) {
        pass("iss_from_proof_matches_decodeJwt", rawIss);
      } else {
        warn("iss_from_proof_matches_decodeJwt",
          `proof.iss="${rawIss}" vs jwt.iss="${jwtIss}"`);
      }

      // On-chain Sui testnet JWK table stores Google under "https://accounts.google.com".
      // The on-chain verifier uses rawIss for JWK lookup.
      // If rawIss != stored ISS → "JWK not found" error on-chain.
      const onChainJwkIss = "https://accounts.google.com";
      if (rawIss === onChainJwkIss) {
        pass("raw_iss_matches_testnet_jwk_table", rawIss);
      } else {
        fail("raw_iss_matches_testnet_jwk_table",
          `raw proof ISS is "${rawIss}" but testnet JWK table stores Google under "${onChainJwkIss}".\n` +
          `→ On-chain JWK lookup will FAIL with "JWK not found (${rawIss})" unless the verifier normalizes.\n` +
          `→ Google's JWT uses the old ISS format. The JWT payload's raw "iss" field is "${rawIss}".`);
      }

      // Compute addresses for both ISS forms (bypass SDK normalization)
      const { blake2b: b2b } = await import("@noble/hashes/blake2b");
      const { hexToBytes: h2b } = await import("@noble/hashes/utils");
      function rawAddr(seed: bigint, iss: string): string {
        const issB = new TextEncoder().encode(iss);
        const seedB = h2b(seed.toString(16).padStart(64, "0"));
        const pre = new Uint8Array(2 + issB.length + 32);
        pre[0] = 0x05; pre[1] = issB.length;
        pre.set(issB, 2); pre.set(seedB, 2 + issB.length);
        return "0x" + Array.from(b2b(pre, { dkLen: 32 })).map(b => b.toString(16).padStart(2,"0")).join("");
      }

      const addrRaw  = rawAddr(jwtSeed, rawIss);
      const addrNorm = rawAddr(jwtSeed, onChainJwkIss);
      info(`address (raw proof ISS "${rawIss}"):            ${addrRaw}`);
      info(`address (testnet JWK ISS "${onChainJwkIss}"): ${addrNorm}`);
      info(`SDK computeZkLoginAddressFromSeed:              ${jwtAddr}`);
      info(`→ On-chain verifier address (uses raw ISS):     ${addrRaw}`);
      info(`  This is what the zkLogin sig RESOLVES TO on-chain.`);
      info(`  Set this as the transaction SENDER.`);
    } else {
      warn("iss_from_proof_parse", `Could not extract iss from: ${JSON.stringify(decoded)}`);
    }
  } catch (e) {
    fail("iss_from_proof_decode", String(e));
  }
}

// ── Step 15: Cross-check — what the on-chain verifier will derive ─────────────

header("STEP 15 — Cross-Check: What On-Chain Verifier Derives");

// Query the on-chain JWK table to verify Google keys are present
try {
  const innerObj = await (new SuiClient({ url: getFullnodeUrl(SUI_NETWORK) })).getObject({
    id: "0xcfecb053c69314e75f36561910f3535dd466b6e2e3593708f370e80424617ae7",
    options: { showContent: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jwks = (innerObj.data?.content as any)?.fields?.value?.fields?.active_jwks ?? [];
  const googleJwks = jwks.filter((j: { fields?: { jwk_id?: { fields?: { iss?: string; kid?: string } } } }) =>
    (j.fields?.jwk_id?.fields?.iss ?? "").includes("google"));
  info(`On-chain Google JWK entries (${googleJwks.length}):`);
  for (const j of googleJwks) {
    const id = j.fields?.jwk_id?.fields;
    info(`  iss: "${id.iss}"  kid: ${id.kid}`);
  }
  if (googleJwks.length === 0) {
    fail("google_jwk_on_chain", "No Google JWKs found on-chain — zkLogin cannot work");
  }
} catch (e) {
  warn("google_jwk_on_chain", `Could not query JWK table: ${String(e)}`);
}

info(`JWT user's SDK address:    ${jwtAddr}`);
if (proofAddressSeed) {
  const proofAddr = computeZkLoginAddressFromSeed(BigInt(proofAddressSeed), jwtIss, false);
  info(`From Shinami addressSeed:  ${proofAddr}`);
  if (proofAddr !== jwtAddr) {
    fail("sender_would_match_signature",
      `SDK address = ${jwtAddr}\nShinami proof address = ${proofAddr}\n→ CHAIN WILL REJECT`);
  } else {
    pass("sender_would_match_signature", proofAddr);
  }
} else {
  info("(Shinami did not return addressSeed — using SDK-computed seed)");
  info(`Current session.address (raw-ISS formula): 0xad8d…  (our computeZkLoginAddressRaw fix)`);
  info(`Current session.address (SDK formula):     ${jwtAddr}`);
  info(`On-chain verifier uses raw ISS → address = 0xad8d… = computeZkLoginAddressRaw`);
  warn("sender_would_match_signature",
    "Step 13 skipped or no addressSeed — check step 14 'raw_iss_matches_testnet_jwk_table' result.");
}

// ── Summary ──────────────────────────────────────────────────────────────────

printSummary();
process.exit(failed > 0 ? 1 : 0);

function printSummary() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY: ${passed} passed  ${failed} failed  ${warned} warnings`);
  console.log(`${"═".repeat(60)}\n`);
}
