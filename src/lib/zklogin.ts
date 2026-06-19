import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  parseZkLoginSignature,
  genAddressSeed,
  decodeJwt,
  computeZkLoginAddressFromSeed,
  toPaddedBigEndianBytes,
} from "@mysten/sui/zklogin";
import { fromB64, toB64 } from "@mysten/sui/utils";
import { blake2b } from "@noble/hashes/blake2b";
import { getSuiClient } from "./sui-client";
import { CONFIG } from "./config";

/**
 * Compute zkLogin address WITHOUT normalizing the ISS string.
 * The SDK's computeZkLoginAddressFromSeed always maps "accounts.google.com" →
 * "https://accounts.google.com" before hashing, but the Sui on-chain verifier
 * uses the RAW ISS bytes extracted from issBase64Details. This function bypasses
 * that normalization so our computed address matches what the chain verifies.
 */
function computeZkLoginAddressRaw(addressSeed: bigint, rawIss: string): string {
  const issBytes = new TextEncoder().encode(rawIss);
  const seedBytes = toPaddedBigEndianBytes(addressSeed, 32);
  const preimage = new Uint8Array(2 + issBytes.length + 32);
  preimage[0] = 0x05; // ZkLogin scheme flag
  preimage[1] = issBytes.length;
  preimage.set(issBytes, 2);
  preimage.set(seedBytes, 2 + issBytes.length);
  const hash = blake2b(preimage, { dkLen: 32 });
  return "0x" + Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Session types ────────────────────────────────────────────────

export interface ZkProof {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
}

export interface ZkLoginSession {
  ephemeralSeed: string;  // toB64(32-byte seed)
  randomness: string;
  maxEpoch: number;
  nonce: string;
  expiresAt: number;      // Date.now() + TTL ms
  // Filled in AuthCallback after Google redirects back
  jwt?: string;
  salt?: string;
  address?: string;
  proof?: ZkProof;
  sub?: string;
  aud?: string;
  // The addressSeed as computed by the prover circuit (decimal string).
  // May differ from genAddressSeed() due to circuit version differences.
  // When present, this is the authoritative value to use for address derivation and signing.
  proverAddressSeed?: string;
}

export type ReadySession = ZkLoginSession &
  Required<Pick<ZkLoginSession, "jwt" | "salt" | "address" | "proof" | "sub" | "aud">> & { proverAddressSeed?: string };

// ── Session storage ──────────────────────────────────────────────

// Bump this when the session schema or address derivation logic changes.
// Any stored session without a matching version is discarded and the user re-logs in.
const SESSION_VERSION = 10;

const SESSION_KEY = "zklogin_session";
const RETURN_KEY = "zklogin_return_params";

export function saveSession(s: ZkLoginSession) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, _v: SESSION_VERSION }));
}

export function loadSession(): ZkLoginSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ZkLoginSession & { _v?: number };
    if (parsed._v !== SESSION_VERSION) {
      sessionStorage.removeItem(SESSION_KEY);
      console.warn("[zklogin] session version mismatch — cleared, please re-login");
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(RETURN_KEY);
}

// ── Last-used auth method preference ────────────────────────────
// Written when the user explicitly connects; read on auto-connect
// so the page doesn't flip to Slush just because dapp-kit auto-restored it.
const AUTH_PREF_KEY = "sui_last_auth";
export type AuthPref = "slush" | "zklogin";

export function setAuthPref(method: AuthPref) {
  localStorage.setItem(AUTH_PREF_KEY, method);
}

export function getAuthPref(): AuthPref | null {
  const v = localStorage.getItem(AUTH_PREF_KEY);
  return v === "slush" || v === "zklogin" ? v : null;
}

export function clearAuthPref() {
  localStorage.removeItem(AUTH_PREF_KEY);
}

export function isReady(s: ZkLoginSession | null): s is ReadySession {
  if (!s?.proof || !s?.address || !s?.salt || !s?.sub || !s?.aud || s.expiresAt <= Date.now()) return false;
  return true;
}

/**
 * Derive the Sui address that matches what the on-chain zkLogin verifier computes.
 * session.address is already the canonical address (set by finalizeLogin using raw ISS).
 */
export function deriveZkLoginAddress(session: ReadySession): string {
  return session.address;
}

export function saveReturnParams(search: string) {
  sessionStorage.setItem(RETURN_KEY, search);
}

export function popReturnParams(): string | null {
  const v = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return v;
}

// ── Login flow — Step 1: redirect to Google ──────────────────────

export async function buildGoogleAuthUrl(currentSearch: string): Promise<string> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  const randomness = generateRandomness();

  const systemState = await getSuiClient().getLatestSuiSystemState();
  const maxEpoch = Number(systemState.epoch) + 2; // ~2 days on testnet

  const nonce = generateNonce(keypair.getPublicKey(), maxEpoch, randomness);

  saveReturnParams(currentSearch);
  saveSession({ ephemeralSeed: toB64(seed), randomness, maxEpoch, nonce, expiresAt: Date.now() + 48 * 3600_000 });

  const params = new URLSearchParams({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    redirect_uri: `${window.location.origin}/auth/callback`,
    response_type: "id_token",
    scope: "openid email",
    nonce,
  });

  // Use the OIDC v2 endpoint — it issues tokens with "iss":"https://accounts.google.com"
  // (raw, without normalization). The legacy /auth endpoint uses "accounts.google.com"
  // which does not match the Sui on-chain JWK table (stored under "https://...").
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Login flow — Step 2: called from AuthCallback ────────────────
// Fetches salt + proof from our backend (which proxies to Shinami).

export async function finalizeLogin(jwt: string): Promise<ReadySession> {
  const session = loadSession();
  if (!session) throw new Error("No zkLogin session found — restart login");

  const keypair = Ed25519Keypair.fromSecretKey(fromB64(session.ephemeralSeed));
  const extendedPublicKey = getExtendedEphemeralPublicKey(keypair.getPublicKey());

  // 1. Parse JWT claims (needed for address derivation)
  const claims = decodeJwt(jwt);
  const sub = claims.sub as string;
  const iss = claims.iss as string;
  const aud = Array.isArray(claims.aud) ? (claims.aud[0] as string) : (claims.aud as string);

  // 2. Get salt + canonical address from Shinami wallet service.
  //    Shinami manages the salt and returns the address derived with the correct circuit version.
  const walletRes = await fetch("/api/zklogin/wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
  });
  if (!walletRes.ok) throw new Error(`Salt service failed: ${await walletRes.text()}`);
  const { salt, address: shinamiAddress } = await walletRes.json() as { salt: string; address?: string };

  // Log Shinami's address for diagnostics (not used for transaction sender).
  if (shinamiAddress) {
    console.log("[zklogin] finalizeLogin — Shinami address:", shinamiAddress, "(not used — raw-ISS address used instead)");
  }

  // 4. Get ZK proof from Shinami prover (via our server)
  const proofRes = await fetch("/api/zklogin/proof", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jwt,
      maxEpoch: session.maxEpoch,
      extendedEphemeralPublicKey: extendedPublicKey,
      jwtRandomness: session.randomness,
      salt,
    }),
  });
  if (!proofRes.ok) throw new Error(`Proof service failed: ${await proofRes.text()}`);
  const { proof, addressSeed: proverAddressSeed } = await proofRes.json() as { proof: ZkProof; addressSeed?: string | null };
  const proverSeedStr = proverAddressSeed ? String(proverAddressSeed) : null;

  // Extract the ISS the on-chain verifier will actually use (from proof's issBase64Details).
  // The chain calls extractClaimValue(issBase64Details, "iss") which reads the raw ISS
  // from the JWT base64 substring — this may differ from decodeJwt(jwt).iss which normalizes.
  let issFromProof: string = iss;
  try {
    // Minimal re-implementation of extractClaimValue + decodeBase64URL
    const { value, indexMod4 } = proof.issBase64Details;
    const b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bits: number[] = [];
    for (const c of value) {
      const idx = b64chars.indexOf(c);
      bits = bits.concat(Array.from(idx.toString(2).padStart(6, "0")).map(Number));
    }
    // strip leading bits based on indexMod4
    const strip = [0, 2, 4][indexMod4] ?? 0;
    bits = bits.slice(strip);
    // strip trailing bits to multiple of 8
    const trailing = bits.length % 8;
    if (trailing) bits = bits.slice(0, bits.length - trailing);
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bytes.length; i++) bits.slice(i * 8, i * 8 + 8).forEach((b, j) => { bytes[i] |= b << (7 - j); });
    const decoded = new TextDecoder().decode(bytes);
    // decoded = `"iss":"...value...",` — extract the value
    const match = decoded.match(/"iss"\s*:\s*"([^"]+)"/);
    if (match) issFromProof = match[1];
    console.log("[zklogin] finalizeLogin — raw issBase64Details:", JSON.stringify(proof.issBase64Details));
    console.log("[zklogin] finalizeLogin — issFromProof:", issFromProof, "vs decodeJwt.iss:", iss);
  } catch (e) {
    console.warn("[zklogin] finalizeLogin — failed to extract iss from proof:", e);
  }

  // Compute canonical address using the PROOF's RAW ISS (same as on-chain verifier).
  // We bypass computeZkLoginAddressFromSeed because it normalizes "accounts.google.com"
  // → "https://accounts.google.com" before hashing, but the chain uses the raw bytes.
  const sdkSeed = genAddressSeed(BigInt(salt), "sub", sub, aud);
  const canonicalSeedBig = proverSeedStr ? BigInt(proverSeedStr) : sdkSeed;
  const canonicalAddress = computeZkLoginAddressRaw(canonicalSeedBig, issFromProof);
  const sdkAddress = computeZkLoginAddressFromSeed(canonicalSeedBig, issFromProof, false);
  console.log("[zklogin] finalizeLogin v9 — proverAddressSeed:", proverSeedStr ?? "(none)");
  console.log("[zklogin] finalizeLogin v9 — issFromProof:", issFromProof);
  console.log("[zklogin] finalizeLogin v9 — canonicalAddress (raw ISS):", canonicalAddress);
  console.log("[zklogin] finalizeLogin v9 — sdkAddress (normalized ISS):", sdkAddress, "<-- old/wrong");
  if (canonicalAddress !== sdkAddress) {
    console.log("[zklogin] finalizeLogin v9 — ISS normalization caused different address — using raw ISS address");
  }

  const ready: ReadySession = {
    ...session, jwt, salt, address: canonicalAddress, proof, sub, aud,
    ...(proverSeedStr ? { proverAddressSeed: proverSeedStr } : {}),
  };
  saveSession(ready);
  console.log("[zklogin] finalizeLogin — session saved, address:", canonicalAddress);
  return ready;
}

// ── Transaction signing with zkLogin ────────────────────────────

export async function signTxWithZkLogin(
  txBytes: Uint8Array,
  session: ReadySession,
): Promise<string> {
  const keypair = Ed25519Keypair.fromSecretKey(fromB64(session.ephemeralSeed));
  const { signature: ephemeralSig } = await keypair.signTransaction(txBytes);

  const addressSeedBig = session.proverAddressSeed
    ? BigInt(session.proverAddressSeed)
    : genAddressSeed(BigInt(session.salt), "sub", session.sub, session.aud);
  const addressSeed = addressSeedBig.toString();
  console.log("[zklogin] signTx v9 — addressSeed:", addressSeed);
  console.log("[zklogin] signTx v9 — session.address:", session.address);
  console.log("[zklogin] signTx v9 — proof.issBase64Details:", JSON.stringify(session.proof.issBase64Details));
  console.log("[zklogin] signTx v9 — session.salt:", session.salt, "sub:", session.sub?.slice(0,8));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zkSig = getZkLoginSignature({
    inputs: { ...session.proof, addressSeed } as any,
    maxEpoch: session.maxEpoch,
    userSignature: ephemeralSig,
  });

  // Parse the signature back to verify what addressSeed and address it resolves to
  console.log("[zklogin] signTx v9 — zkSig produced, session.address should match on-chain:", session.address);

  return zkSig;
}
