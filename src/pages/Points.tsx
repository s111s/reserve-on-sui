import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { RestaurantPassCard, loadPassesByBucket, loadPassCounts, markPassAsUsed } from "@/components/RestaurantPassCard";
import type { PassBucket } from "@/components/RestaurantPassCard";
import { useCurrentAccount, useCurrentWallet, useSignAndExecuteTransaction as useDappSignAndExec, useSignTransaction, useWallets, useConnectWallet, useDisconnectWallet } from "@mysten/dapp-kit";
import { fromBase64 } from "@mysten/sui/utils";
import { loadSession, isReady, signTxWithZkLogin, buildGoogleAuthUrl, clearSession, getAuthPref, setAuthPref, clearAuthPref } from "@/lib/zklogin";
import { getSuiClient } from "@/lib/sui-client";
import { buildClaimTierTx } from "@/lib/tier-claim";
import { CONFIG } from "@/lib/config";

const NETWORK = (import.meta.env.VITE_SUI_NETWORK as string) ?? "testnet";
const NETWORK_COLOR: Record<string, string> = { mainnet: "#f85149", testnet: "#d29922", devnet: "#3fb950" };

// ── Tier config ──────────────────────────────────────────────────────────────
const TIERS = [
  { level: 0, name: "No Tier",      color: "#555",    bg: "#55555518", min: 0,  next: 1  },
  { level: 1, name: "Quartz",       color: "#b0aec8", bg: "#b0aec818", min: 1,  next: 5  },
  { level: 2, name: "Sapphire",     color: "#4a90e2", bg: "#4a90e218", min: 5,  next: 15 },
  { level: 3, name: "Emerald",      color: "#2ecc71", bg: "#2ecc7118", min: 15, next: 30 },
  { level: 4, name: "Black Diamond",color: "#d4a843", bg: "#d4a84312", min: 30, next: null },
] as const;

const TIER_ICON = ["○", "◇", "⬡", "✦", "◆"] as const;

interface Reward {
  id: string;
  name: string;
  description: string;
  restaurant: string;
  restaurant_type: string;
  image: string;
  points_cost: number;
  required_tier: 1 | 2 | 3 | 4;
  category: "food" | "drink" | "experience" | "special";
}

const CATEGORY_COLOR: Record<string, string> = {
  food: "#f0a050", drink: "#a78bfa", experience: "#60a5fa", special: "#f5c842",
};
const STORE_EMOJI: Record<string, string> = {
  restaurant: "🍽️", bar: "🍸", spa: "💆", hotel: "🏨",
  cafe: "☕", activity: "🎯", any: "🌟",
};

interface TierData { booking_count: number; tier: number; tier_name: string; highest_claimed: number; unclaimed_tier: number }

export default function PointsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentAccount = useCurrentAccount();
  const { connectionStatus } = useCurrentWallet();

  const [address, setAddress] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<"slush" | "zklogin" | null>(null);
  const [pageTab, setPageTab] = useState<"rewards" | "pass">(searchParams.get("tab") === "pass" ? "pass" : "rewards");
  const [passBucket, setPassBucket] = useState<PassBucket>("today");
  const [passCounts, setPassCounts] = useState(() => loadPassCounts());
  const [bookingPasses, setBookingPasses] = useState(() => loadPassesByBucket("today"));
  const [expandedPassIds, setExpandedPassIds] = useState<Set<string>>(new Set());

  function switchBucket(bucket: PassBucket) {
    setPassBucket(bucket);
    setBookingPasses(loadPassesByBucket(bucket));
    setPassCounts(loadPassCounts());
  }

  function toggleQR(bookingId: string) {
    setExpandedPassIds((prev) => {
      const next = new Set(prev);
      next.has(bookingId) ? next.delete(bookingId) : next.add(bookingId);
      return next;
    });
  }

  function handleMarkAsUsed(bookingId: string) {
    markPassAsUsed(bookingId);
    setExpandedPassIds((prev) => { const next = new Set(prev); next.delete(bookingId); return next; });
    switchBucket(passBucket);
  }

  // On page entry, disconnect Slush unless the user explicitly chose it last time.
  // Prevents dapp-kit autoConnect from conflicting with zkLogin sessions.
  useEffect(() => {
    if (getAuthPref() !== "slush") disconnectWallet.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (connectionStatus === "connecting") return;
    const pref = getAuthPref();
    const slushAddress = currentAccount?.address;
    const s = loadSession();
    const zkAddress = isReady(s) ? s.address : null;

    // Honour the user's last explicit choice when both are available
    if (pref === "zklogin" && zkAddress) { setAddress(zkAddress); setAuthMethod("zklogin"); return; }
    if (pref === "slush" && slushAddress) { setAddress(slushAddress); setAuthMethod("slush"); return; }

    // No preference — fall back to whichever is available
    if (slushAddress) { setAddress(slushAddress); setAuthMethod("slush"); return; }
    if (zkAddress) { setAddress(zkAddress); setAuthMethod("zklogin"); return; }
    setAddress(null);
    setAuthMethod(null);
  }, [currentAccount?.address, connectionStatus]);

  const [points, setPoints] = useState<number | null>(null);
  const [tierData, setTierData] = useState<TierData | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [rewardsError, setRewardsError] = useState<string | null>(null);
  const [loadingRewards, setLoadingRewards] = useState(true);
  const [voucher, setVoucher] = useState<{ code: string; reward: Reward; remaining: number } | null>(null);
  const voucherRef = useRef<typeof voucher>(null);
  voucherRef.current = voucher;
  const voucherDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirming, setConfirming] = useState<Reward | null>(null);
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "error" | "info" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  interface MyVoucher { code: string; reward_name: string; reward_restaurant: string; reward_image: string; points_cost: number; used: boolean; created_at: string }
  const [myVouchers, setMyVouchers] = useState<MyVoucher[]>([]);
  const [markingUsed, setMarkingUsed] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [revealedCodes, setRevealedCodes] = useState<Set<string>>(new Set());
  const [voucherTab, setVoucherTab] = useState<"unused" | "used" | "expired">("unused");
  const [voucherFilter, setVoucherFilter] = useState("");
  const [voucherPage, setVoucherPage] = useState(1);
  const VOUCHER_PAGE_SIZE = 5;
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState<number | null>(null);

  const signAndExecTx = useDappSignAndExec();
  const signTx = useSignTransaction();
  const signAndExecTxRef = useRef(signAndExecTx);
  const signTxRef = useRef(signTx);
  useEffect(() => { signAndExecTxRef.current = signAndExecTx; signTxRef.current = signTx; }, [signAndExecTx, signTx]);

  const suiWallets = useWallets();
  const connectWallet = useConnectWallet();
  const disconnectWallet = useDisconnectWallet();
  const [connectingWallet, setConnectingWallet] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function handleConnectSlush() {
    const target = suiWallets.find((w) => w.name === "Slush") ?? suiWallets[0];
    if (!target) { setConnectError("No Sui wallet found. Install Slush."); return; }
    setConnectingWallet(true);
    setConnectError(null);
    try {
      await connectWallet.mutateAsync({ wallet: target });
      setAuthPref("slush");
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : "Wallet connection failed");
    } finally {
      setConnectingWallet(false);
    }
  }

  async function handleGoogleLogin() {
    if (!CONFIG.GOOGLE_CLIENT_ID) { setConnectError("Google login not configured."); return; }
    setConnectError(null);
    try {
      setAuthPref("zklogin");
      const url = await buildGoogleAuthUrl("?redirect=/points");
      window.location.href = url;
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : "Failed to start Google login");
    }
  }

  function handleDisconnect() {
    if (authMethod === "slush") disconnectWallet.mutate();
    else if (authMethod === "zklogin") clearSession();
    clearAuthPref();
    setAddress(null);
    setAuthMethod(null);
    setPoints(null);
    setTierData(null);
    setMyVouchers([]);
  }

  function refreshPoints(addr: string) {
    return fetch(`/api/points/${addr}`).then((r) => r.json() as Promise<{ balance: number }>).then((p) => setPoints(p.balance));
  }
  function refreshVouchers(addr: string) {
    return fetch(`/api/vouchers/${addr}`).then((r) => r.json() as Promise<{ vouchers: MyVoucher[] }>).then((d) => setMyVouchers(d.vouchers ?? []));
  }

  useEffect(() => {
    if (!address) {
      // Don't wipe data while the success modal is open — wallet may be transiently reconnecting
      if (!voucherRef.current) { setPoints(null); setTierData(null); setMyVouchers([]); }
      return;
    }
    setDataError(null);
    Promise.all([
      fetch(`/api/points/${address}`).then((r) => r.json() as Promise<{ balance: number }>),
      fetch(`/api/tier/${address}`).then((r) => r.json() as Promise<TierData>),
      fetch(`/api/vouchers/${address}`).then((r) => r.json() as Promise<{ vouchers: MyVoucher[] }>),
    ])
      .then(([p, t, v]) => { setPoints(p.balance); setTierData(t); setMyVouchers(v.vouchers ?? []); })
      .catch((e: unknown) => setDataError(e instanceof Error ? e.message : "Failed to load"));
  }, [address]);

  useEffect(() => {
    setLoadingRewards(true);
    fetch("/api/rewards")
      .then((r) => r.json() as Promise<{ rewards: Reward[] }>)
      .then((d) => setRewards(d.rewards ?? []))
      .catch((e: unknown) => setRewardsError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoadingRewards(false));
  }, []);

  // Ref always holds the latest dismissVoucher so the 30s timer never has a stale address closure
  const dismissVoucherRef = useRef<() => void>(() => {});
  const dismissVoucher = useCallback(async () => {
    setVoucher(null);
    if (address) await Promise.all([refreshPoints(address), refreshVouchers(address)]);
  }, [address]); // eslint-disable-line react-hooks/exhaustive-deps
  dismissVoucherRef.current = dismissVoucher;

  useEffect(() => {
    if (voucher) {
      voucherDismissTimer.current = setTimeout(() => dismissVoucherRef.current(), 30_000);
    } else {
      if (voucherDismissTimer.current) clearTimeout(voucherDismissTimer.current);
    }
    return () => { if (voucherDismissTimer.current) clearTimeout(voucherDismissTimer.current); };
  }, [voucher]);

  async function redeem(reward: Reward) {
    if (!address) return;
    setRedeeming(reward.id);
    setRedeemError(null);
    try {
      // Phase 1: server validates + builds sponsored tx
      const res = await fetch("/api/rewards/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, reward_id: reward.id }),
      });
      const data = await res.json() as {
        ok?: boolean;
        txBytes?: string; sponsorSig?: string; voucher_code?: string; reward?: Reward;
        remaining_points?: number; error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Redemption failed");

      // Fallback mode (no contract): server already deducted, done
      if (data.ok && !data.txBytes) {
        setConfirming(null);
        setPoints(data.remaining_points!);
        setVoucher({ code: data.voucher_code!, reward: data.reward!, remaining: data.remaining_points! });
        return;
      }

      // Phase 2: user signs the sponsored tx
      const { txBytes, sponsorSig, voucher_code } = data;
      if (!txBytes || !sponsorSig || !voucher_code) throw new Error("Invalid response from server");

      const client = getSuiClient();
      let digest: string;

      if (authMethod === "zklogin") {
        const session = loadSession();
        if (!isReady(session)) throw new Error("Session expired — please sign in again");
        const userSig = await signTxWithZkLogin(fromBase64(txBytes), session);
        const result = await client.executeTransactionBlock({
          transactionBlock: txBytes,
          signature: [userSig, sponsorSig],
          options: { showEffects: true },
        });
        if (result.effects?.status?.status !== "success") throw new Error(result.effects?.status?.error ?? "Transaction failed");
        digest = result.digest;
      } else {
        // Slush wallet — sponsored tx needs sign-only then execute with both sigs
        const { signature: userSig } = await signTxRef.current.mutateAsync({
          transaction: txBytes as unknown as Parameters<typeof signTxRef.current.mutateAsync>[0]["transaction"],
        });
        const result = await getSuiClient().executeTransactionBlock({
          transactionBlock: txBytes,
          signature: [userSig, sponsorSig],
          options: { showEffects: true },
        });
        if (result.effects?.status?.status !== "success") throw new Error(result.effects?.status?.error ?? "Transaction failed");
        digest = result.digest;
      }

      // Phase 3: tell server tx confirmed → activate voucher
      const finalRes = await fetch("/api/rewards/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucher_code, tx_digest: digest }),
      });
      const finalData = await finalRes.json() as { ok?: boolean; reward?: Reward; remaining_points?: number; error?: string };
      if (!finalRes.ok) throw new Error(finalData.error ?? "Finalization failed");

      setConfirming(null);
      setPoints(finalData.remaining_points!);
      setVoucher({ code: voucher_code, reward: finalData.reward!, remaining: finalData.remaining_points! });
    } catch (e) {
      setConfirming(null);
      showToast(e instanceof Error ? e.message : "Redemption failed");
    } finally {
      setRedeeming(null);
    }
  }

  function showToast(msg: string, type: "error" | "info" = "error") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }

  function formatDate(iso: string) {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  }
  function expiryDate(iso: string) {
    const d = new Date(iso);
    d.setDate(d.getDate() + 30);
    return d.toISOString();
  }
  function isExpired(iso: string) {
    return new Date(expiryDate(iso)) < new Date();
  }

  function copyCode(code: string) {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }

  async function markUsed(code: string) {
    setMarkingUsed(code);
    try {
      const res = await fetch(`/api/vouchers/${code}/use`, { method: "POST" });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setMyVouchers((prev) => prev.map((v) => v.code === code ? { ...v, used: true } : v));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to mark voucher");
    } finally {
      setMarkingUsed(null);
    }
  }

  async function claimTier() {
    if (!address) return;
    setClaiming(true);
    setClaimError(null);
    setClaimSuccess(null);
    try {
      const session = loadSession();
      let digest: string;

      if (currentAccount?.address) {
        // Slush wallet
        const tx = buildClaimTierTx(address);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await signAndExecTxRef.current.mutateAsync({ transaction: tx as any });
        digest = result.digest;
      } else if (isReady(session)) {
        const zkAddress = session.address;
        // zkLogin — server builds tx with itself as gas owner, user counter-signs
        const sponsorRes = await fetch("/api/sponsor/claim-tier", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: zkAddress }),
        });
        if (!sponsorRes.ok) {
          const err = await sponsorRes.json() as { error?: string };
          throw new Error(err.error ?? "Gas sponsorship failed");
        }
        const { txBytes: sponsoredB64, signature: sponsorSig } = await sponsorRes.json() as { txBytes: string; signature: string };
        const sponsoredBytes = fromBase64(sponsoredB64);
        const zkSig = await signTxWithZkLogin(sponsoredBytes, session);
        const suiClient = getSuiClient();
        const res = await suiClient.executeTransactionBlock({
          transactionBlock: sponsoredB64,
          signature: [zkSig, sponsorSig],
          options: { showEffects: true },
        }) as { digest: string };
        digest = res.digest;
      } else {
        throw new Error("No wallet connected");
      }

      await getSuiClient().waitForTransaction({ digest });
      const t = await fetch(`/api/tier/${address}`).then((r) => r.json() as Promise<TierData>);
      setTierData(t);
      setClaimSuccess(t.highest_claimed);
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setClaiming(false);
    }
  }

  const currentTier = TIERS[Math.min(tierData?.tier ?? 0, 4)];
  const nextTier = currentTier.next != null ? TIERS[currentTier.level + 1] : null;
  const bookings = tierData?.booking_count ?? 0;
  const progressPct = nextTier
    ? Math.min(100, ((bookings - currentTier.min) / (nextTier.min - currentTier.min)) * 100)
    : 100;

  const netColor = NETWORK_COLOR[NETWORK] ?? "#888";
  const walletConnected = !!address;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "inherit" }}>

      {NETWORK !== "mainnet" && (
        <div style={{ background: `${netColor}22`, borderBottom: `1px solid ${netColor}55`, padding: "0.28rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: netColor, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontSize: "0.7rem", color: netColor, fontWeight: 600 }}>
            {NETWORK === "testnet" ? "Testnet Beta" : "Dev"} — Tokens have no real value
          </span>
        </div>
      )}

      <div style={{ background: "var(--card)", borderBottom: "1px solid var(--border)", padding: "0.9rem 1.25rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1, padding: "0.2rem" }}>←</button>
          <div>
            <div style={{ fontWeight: 700, fontSize: "1rem", color: "var(--text-bright)" }}>Rewards & Tier</div>
            <div style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>Earn points, reach new tiers, unlock exclusive rewards</div>
          </div>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.7rem", fontWeight: 600, color: netColor, background: `${netColor}18`, border: `1px solid ${netColor}40`, borderRadius: 6, padding: "0.15rem 0.5rem" }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: netColor, display: "inline-block" }} />
          {NETWORK}
        </span>
      </div>

      {/* Tab switcher */}
      <div style={{ background: "var(--card)", borderBottom: "1px solid var(--border)", padding: "0 1.25rem", display: "flex", gap: 0 }}>
        {(["rewards", "pass"] as const).map((tab) => {
          const active = pageTab === tab;
          const label = tab === "rewards" ? "◆ Points & Rewards" : "🎟 My Pass";
          return (
            <button key={tab} onClick={() => setPageTab(tab)} style={{ flex: 1, padding: "0.65rem 0.5rem", fontSize: "0.82rem", fontWeight: active ? 700 : 400, color: active ? "var(--accent)" : "var(--text-dim)", background: "none", border: "none", borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`, cursor: "pointer", transition: "color 0.15s, border-color 0.15s" }}>
              {label}
            </button>
          );
        })}
      </div>

      <div style={{ maxWidth: 520, margin: "0 auto", padding: "1.25rem 1rem 4rem", display: "flex", flexDirection: "column", gap: "1rem" }}>

        {/* My Pass tab */}
        {pageTab === "pass" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {/* Pass bucket tabs */}
            {(() => {
              const BUCKETS: { key: PassBucket; label: string; emoji: string }[] = [
                { key: "today",    label: "Today",    emoji: "🎟" },
                { key: "upcoming", label: "Upcoming", emoji: "📅" },
                { key: "used",     label: "Used",     emoji: "✓"  },
              ];
              return (
                <div style={{ display: "flex", gap: "0.45rem" }}>
                  {BUCKETS.map(({ key, label, emoji }) => {
                    const active = passBucket === key;
                    const count = passCounts[key];
                    return (
                      <button key={key} onClick={() => switchBucket(key)} style={{ flex: 1, padding: "0.5rem 0.35rem", borderRadius: 9, border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`, background: active ? "var(--accent)" : "var(--card)", color: active ? "#06090f" : "var(--text-dim)", fontSize: "0.76rem", fontWeight: active ? 700 : 400, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.1rem", transition: "all 0.15s" }}>
                        <span>{emoji}</span>
                        <span>{label}</span>
                        {count > 0 && <span style={{ fontSize: "0.65rem", fontWeight: 700, background: active ? "rgba(0,0,0,0.15)" : "var(--bg)", borderRadius: 10, padding: "0 0.35rem" }}>{count}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {/* Pass list */}
            {bookingPasses.length > 0 ? (
              <>
                {bookingPasses.map((pass) => (
                  <RestaurantPassCard
                    key={pass.bookingId}
                    bookingId={pass.bookingId}
                    merchantName={pass.merchantName}
                    date={pass.date}
                    time={pass.time}
                    objectId={pass.objectId}
                    txHash={pass.txHash}
                    usedAt={pass.usedAt}
                    expanded={expandedPassIds.has(pass.bookingId)}
                    onToggleQR={() => toggleQR(pass.bookingId)}
                    onMarkUsed={() => handleMarkAsUsed(pass.bookingId)}
                  />
                ))}
                <p style={{ textAlign: "center", fontSize: "0.68rem", color: "var(--text-dim)", margin: 0, lineHeight: 1.6 }}>
                  {passBucket === "today" && "Show QR to restaurant staff. Mark as used when done."}
                  {passBucket === "upcoming" && "These passes activate on the booking date."}
                  {passBucket === "used" && "Past and manually marked passes are kept here for reference."}
                </p>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "2.5rem 1rem", color: "var(--text-dim)" }}>
                <div style={{ fontSize: "2rem", marginBottom: "0.6rem" }}>
                  {passBucket === "today" ? "🎟" : passBucket === "upcoming" ? "📅" : "✓"}
                </div>
                <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--text)", marginBottom: "0.35rem" }}>
                  {passBucket === "today" ? "No passes for today" : passBucket === "upcoming" ? "No upcoming passes" : "No used passes"}
                </div>
                <div style={{ fontSize: "0.78rem", lineHeight: 1.6 }}>
                  {passBucket === "used" ? "Passes you mark as used will appear here." : "Complete a booking to get your restaurant pass."}
                </div>
                {passBucket !== "used" && (
                  <button onClick={() => navigate("/mock")} style={{ marginTop: "1.1rem", padding: "0.5rem 1.1rem", borderRadius: 10, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent)", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer" }}>
                    Browse Experiences →
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Rewards tab */}
        {pageTab === "rewards" && <>

        {/* Tier badge card */}
        {!walletConnected ? (
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, padding: "1.75rem 1.5rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem" }}>
            <div style={{ fontSize: "2rem", lineHeight: 1 }}>◆</div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-bright)", marginBottom: "0.3rem" }}>Connect your wallet</div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>Connect to see your tier, points balance, and available rewards</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", width: "100%" }}>
              <button
                onClick={handleGoogleLogin}
                style={{ width: "100%", padding: "0.7rem", borderRadius: 10, border: "none", background: "var(--accent)", color: "#06090f", fontWeight: 700, fontSize: "0.88rem", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}
              >
                <span>🔑</span> Sign in with Google (zkLogin)
              </button>
              <button
                onClick={handleConnectSlush}
                disabled={connectingWallet}
                style={{ width: "100%", padding: "0.7rem", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontWeight: 600, fontSize: "0.88rem", cursor: connectingWallet ? "default" : "pointer", opacity: connectingWallet ? 0.6 : 1 }}
              >
                {connectingWallet ? "Connecting…" : "Connect Slush Wallet"}
              </button>
            </div>
            {connectError && (
              <div style={{ fontSize: "0.78rem", color: "var(--red)", textAlign: "center" }}>{connectError}</div>
            )}
          </div>
        ) : dataError ? (
          <div style={{ background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 12, padding: "1rem", fontSize: "0.82rem", color: "var(--red)" }}>
            Could not load data — make sure the server is running (<code>npm run server</code>)
          </div>
        ) : currentTier.level === 4 ? (
          /* ── Black Diamond — premium card ── */
          <div style={{ position: "relative", animation: "bd-fade-in 0.6s ease both" }}>
            {/* Animated gradient border ring */}
            <div style={{
              position: "absolute", inset: -1, borderRadius: 18, zIndex: 0,
              background: "conic-gradient(from 0deg, #d4a843, #f5d060, #fff8e0, #d4a843, #8b6410, #d4a843, #f5d060, #d4a843)",
              animation: "bd-border-spin 6s linear infinite",
              opacity: 0.7,
            }} />
            {/* Glow halo behind the card */}
            <div style={{
              position: "absolute", inset: -8, borderRadius: 24, zIndex: -1,
              background: "radial-gradient(ellipse at 50% 40%, #d4a84318 0%, transparent 70%)",
              animation: "bd-glow 3s ease-in-out infinite",
            }} />
            {/* Card body */}
            <div style={{
              position: "relative", zIndex: 1, borderRadius: 17,
              background: "radial-gradient(ellipse at 25% 20%, #1c1200 0%, #0a0800 40%, #000 100%)",
              padding: "1.5rem", overflow: "hidden",
            }}>
              {/* Corner ornaments */}
              {[
                { top: 8, left: 8, borderTop: "1px solid #d4a84388", borderLeft: "1px solid #d4a84388" },
                { top: 8, right: 8, borderTop: "1px solid #d4a84388", borderRight: "1px solid #d4a84388" },
                { bottom: 8, left: 8, borderBottom: "1px solid #d4a84388", borderLeft: "1px solid #d4a84388" },
                { bottom: 8, right: 8, borderBottom: "1px solid #d4a84388", borderRight: "1px solid #d4a84388" },
              ].map((s, i) => (
                <div key={i} style={{ position: "absolute", width: 14, height: 14, ...s }} />
              ))}

              {/* Tier header */}
              <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.1rem" }}>
                {/* Diamond icon */}
                <div style={{ position: "relative", flexShrink: 0 }}>
                  {/* Outer glow ring */}
                  <div style={{
                    position: "absolute", inset: -6, borderRadius: "50%",
                    background: "radial-gradient(ellipse, #d4a84322 0%, transparent 70%)",
                    animation: "bd-icon-pulse 2.4s ease-in-out infinite",
                  }} />
                  <div style={{
                    position: "relative",
                    width: 70, height: 70, borderRadius: "50%",
                    background: "radial-gradient(ellipse at 35% 30%, #2a1e00, #000)",
                    border: "1px solid #d4a84399",
                    boxShadow: "0 0 0 3px #d4a84318, inset 0 1px 0 #f5d06033",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "2.1rem",
                    animation: "bd-float 3.5s ease-in-out infinite, bd-icon-pulse 2.4s ease-in-out infinite",
                  }}>
                    ◆
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Title row */}
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.1rem" }}>
                    <span style={{
                      fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.15em",
                      background: "linear-gradient(90deg, #8b6410, #d4a843, #f5d060, #fff8d4, #f5d060, #d4a843, #8b6410)",
                      backgroundSize: "300% auto",
                      WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                      animation: "bd-shimmer 4s linear infinite",
                    }}>
                      Black Diamond Member
                    </span>
                    <span style={{
                      fontSize: "0.55rem", fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase",
                      background: "#000",
                      color: "#d4a843",
                      border: "1px solid #d4a84366",
                      borderRadius: 3, padding: "0.12rem 0.45rem",
                      boxShadow: "0 0 8px #d4a84330",
                    }}>
                      EXCLUSIVE
                    </span>
                  </div>
                  <div style={{ fontSize: "1.6rem", fontWeight: 800, lineHeight: 1.1,
                    background: "linear-gradient(135deg, #f5d060, #d4a843)",
                    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                  }}>
                    {points ?? "…"} <span style={{ fontSize: "0.9rem", fontWeight: 500, WebkitTextFillColor: "#8b949e" }}>pts</span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#8b6f3a", marginTop: "0.1rem" }}>
                    {bookings} reservation{bookings !== 1 ? "s" : ""} completed
                  </div>
                  {address && (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "0.65rem", color: "#6a5028", fontFamily: "monospace" }}>
                        {address.slice(0, 6)}…{address.slice(-4)}
                      </span>
                      <span style={{
                        fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.06em",
                        background: authMethod === "zklogin" ? "#4a90e222" : "#2ecc7122",
                        color: authMethod === "zklogin" ? "#4a90e2" : "#2ecc71",
                        border: `1px solid ${authMethod === "zklogin" ? "#4a90e244" : "#2ecc7144"}`,
                        borderRadius: 4, padding: "0.1rem 0.35rem",
                      }}>
                        {authMethod === "zklogin" ? "Google (zkLogin)" : "Slush Wallet"}
                      </span>
                      <button
                        onClick={handleDisconnect}
                        style={{ fontSize: "0.6rem", color: "#6a5028", background: "none", border: "none", cursor: "pointer", padding: "0.1rem 0.2rem", opacity: 0.7, textDecoration: "underline" }}
                      >
                        Switch
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* "All unlocked" strip */}
              <div style={{
                background: "linear-gradient(90deg, transparent, #d4a84314, #d4a84320, #d4a84314, transparent)",
                border: "none", borderTop: "1px solid #d4a84322", borderBottom: "1px solid #d4a84322",
                padding: "0.5rem 0.25rem", marginBottom: "1rem",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "0.6rem",
              }}>
                <span style={{ fontSize: "0.65rem", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700,
                  background: "linear-gradient(90deg, #8b6410, #d4a843, #f5d060, #d4a843, #8b6410)",
                  backgroundSize: "200% auto", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                  animation: "bd-shimmer 5s linear infinite",
                }}>
                  ◆ &nbsp; The highest tier — all rewards unlocked &nbsp; ◆
                </span>
              </div>

              {/* Tier ladder */}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {TIERS.slice(1).map((t) => (
                  <div key={t.level} style={{ flex: 1, textAlign: "center" }}>
                    <div style={{
                      fontSize: t.level === 4 ? "1.2rem" : "1rem",
                      color: t.color,
                      animation: t.level === 4 ? "bd-float 3.5s ease-in-out infinite" : undefined,
                      filter: t.level === 4 ? "drop-shadow(0 0 6px #d4a84388)" : undefined,
                    }}>{TIER_ICON[t.level]}</div>
                    <div style={{ fontSize: "0.65rem", color: t.color, fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: "0.6rem", color: t.level === 4 ? "#6a5028" : "var(--text-dim)" }}>{t.min}+ trips</div>
                  </div>
                ))}
              </div>

              <div style={{ height: 1, background: "linear-gradient(90deg, transparent, #d4a84330, transparent)", margin: "0.75rem 0 0.6rem" }} />
              <div style={{ display: "flex", gap: "1.25rem", fontSize: "0.72rem", color: "#6a5028" }}>
                <span>🎯 Earn <strong style={{ color: "#d4a843" }}>10 pts</strong> per $1 paid</span>
                <span>✨ Free bookings = <strong style={{ color: "#d4a843" }}>1 pt</strong></span>
              </div>

              {/* Claim badge — Black Diamond styling */}
              {tierData && tierData.unclaimed_tier > 0 && (() => {
                const claimTierInfo = TIERS[tierData.unclaimed_tier];
                return (
                  <div style={{ marginTop: "0.9rem" }}>
                    <div style={{ height: 1, background: "linear-gradient(90deg, transparent, #d4a84330, transparent)", marginBottom: "0.9rem" }} />
                    {claimSuccess === tierData.unclaimed_tier ? (
                      <div style={{ textAlign: "center", fontSize: "0.85rem", fontWeight: 700,
                        background: "linear-gradient(90deg, #d4a843, #f5d060, #d4a843)",
                        WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                      }}>
                        ◆ Black Diamond Badge claimed!
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: "0.72rem", color: "#6a5028", marginBottom: "0.5rem", lineHeight: 1.4 }}>
                          Claim your <strong style={{ color: "#d4a843" }}>Black Diamond</strong> soul-bound badge NFT — a permanent mark of prestige on-chain.
                        </div>
                        <button
                          onClick={claimTier}
                          disabled={claiming}
                          style={{
                            width: "100%", padding: "0.7rem", borderRadius: 10,
                            border: "1px solid #d4a84388",
                            background: claiming ? "transparent" : "linear-gradient(135deg, #1a1000, #2a1e00)",
                            color: "#d4a843", fontSize: "0.88rem", fontWeight: 700,
                            cursor: claiming ? "not-allowed" : "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem",
                            boxShadow: claiming ? "none" : "0 0 12px #d4a84330, inset 0 1px 0 #f5d06022",
                            transition: "box-shadow 0.2s",
                          }}
                        >
                          {claiming
                            ? <><span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #d4a84344", borderTopColor: "#d4a843", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /> Claiming…</>
                            : <>◆ Claim Black Diamond Badge</>
                          }
                        </button>
                        {claimError && (
                          <div style={{ marginTop: "0.4rem", fontSize: "0.72rem", color: "var(--red)" }}>{claimError}</div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <div style={{
            background: `linear-gradient(135deg, ${currentTier.bg} 0%, rgba(0,0,0,0) 100%)`,
            border: `1px solid ${currentTier.color}44`,
            borderRadius: 16, padding: "1.5rem",
          }}>
            {/* Tier header */}
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.1rem" }}>
              <div style={{
                width: 56, height: 56, borderRadius: "50%",
                background: `${currentTier.color}22`,
                border: `2px solid ${currentTier.color}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "1.6rem", flexShrink: 0,
              }}>
                {TIER_ICON[currentTier.level]}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <div style={{ fontSize: "0.7rem", color: currentTier.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    {currentTier.level === 0 ? "No tier yet" : `${currentTier.name} Member`}
                  </div>
                </div>
                <div style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--text-bright)", lineHeight: 1.1 }}>
                  {points ?? "…"} <span style={{ fontSize: "0.9rem", fontWeight: 500, color: "var(--text-dim)" }}>pts</span>
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.1rem" }}>
                  {bookings} reservation{bookings !== 1 ? "s" : ""} completed
                </div>
                {address && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.65rem", color: "var(--text-dim)", fontFamily: "monospace" }}>
                      {address.slice(0, 6)}…{address.slice(-4)}
                    </span>
                    <span style={{
                      fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.06em",
                      background: authMethod === "zklogin" ? "#4a90e222" : "#2ecc7122",
                      color: authMethod === "zklogin" ? "#4a90e2" : "#2ecc71",
                      border: `1px solid ${authMethod === "zklogin" ? "#4a90e244" : "#2ecc7144"}`,
                      borderRadius: 4, padding: "0.1rem 0.35rem",
                    }}>
                      {authMethod === "zklogin" ? "Google (zkLogin)" : "Slush Wallet"}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Progress to next tier */}
            {nextTier ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-dim)", marginBottom: "0.35rem" }}>
                  <span>{currentTier.level === 0 ? "Start booking to earn Bronze" : `Progress to ${nextTier.name}`}</span>
                  <span style={{ color: nextTier.color, fontWeight: 600 }}>{bookings}/{nextTier.min}</span>
                </div>
                <div style={{ height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${progressPct}%`, background: `linear-gradient(90deg, ${currentTier.color}, ${nextTier.color})`, borderRadius: 3, transition: "width 0.4s ease" }} />
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginTop: "0.35rem" }}>
                  {nextTier.min - bookings > 0 ? `${nextTier.min - bookings} more booking${nextTier.min - bookings !== 1 ? "s" : ""} to reach ${nextTier.name}` : `${nextTier.name} unlocked!`}
                </div>
              </div>
            ) : null}

            <div style={{ height: 1, background: "var(--border)", margin: "1rem 0 0.75rem" }} />

            {/* Tier ladder */}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {TIERS.slice(1).map((t) => (
                <div key={t.level} style={{ flex: 1, textAlign: "center", opacity: currentTier.level >= t.level ? 1 : 0.35 }}>
                  <div style={{ fontSize: "1rem", color: t.color }}>{TIER_ICON[t.level]}</div>
                  <div style={{ fontSize: "0.65rem", color: t.color, fontWeight: 600 }}>{t.name}</div>
                  <div style={{ fontSize: "0.6rem", color: "var(--text-dim)" }}>{t.min}+ trips</div>
                </div>
              ))}
            </div>

            <div style={{ height: 1, background: "var(--border)", margin: "0.75rem 0 0.6rem" }} />
            <div style={{ display: "flex", gap: "1.25rem", fontSize: "0.72rem", color: "var(--text-dim)" }}>
              <span>🎯 Earn <strong style={{ color: "var(--text)" }}>10 pts</strong> per $1 paid</span>
              <span>✨ Free bookings = <strong style={{ color: "var(--text)" }}>1 pt</strong></span>
            </div>

            {/* Claim badge button */}
            {tierData && tierData.unclaimed_tier > 0 && (() => {
              const claimTierInfo = TIERS[tierData.unclaimed_tier];
              return (
                <div style={{ marginTop: "0.9rem" }}>
                  <div style={{ height: 1, background: "var(--border)", marginBottom: "0.9rem" }} />
                  {claimSuccess === tierData.unclaimed_tier ? (
                    <div style={{ textAlign: "center", fontSize: "0.82rem", color: claimTierInfo.color, fontWeight: 600 }}>
                      {TIER_ICON[tierData.unclaimed_tier]} {claimTierInfo.name} Badge claimed!
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginBottom: "0.5rem", lineHeight: 1.4 }}>
                        You've reached <strong style={{ color: claimTierInfo.color }}>{claimTierInfo.name}</strong> tier — claim your soul-bound badge NFT on-chain.
                      </div>
                      <button
                        onClick={claimTier}
                        disabled={claiming}
                        style={{
                          width: "100%", padding: "0.65rem", borderRadius: 10, border: `1.5px solid ${claimTierInfo.color}`,
                          background: claiming ? "transparent" : `${claimTierInfo.color}22`,
                          color: claimTierInfo.color, fontSize: "0.85rem", fontWeight: 700, cursor: claiming ? "not-allowed" : "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", transition: "background 0.2s",
                        }}
                      >
                        {claiming
                          ? <><span style={{ display: "inline-block", width: 12, height: 12, border: `2px solid ${claimTierInfo.color}44`, borderTopColor: claimTierInfo.color, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /> Claiming…</>
                          : <>{TIER_ICON[tierData.unclaimed_tier]} Claim {claimTierInfo.name} Badge</>
                        }
                      </button>
                      {claimError && (
                        <div style={{ marginTop: "0.4rem", fontSize: "0.72rem", color: "var(--red)" }}>{claimError}</div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        )}


        {/* My Vouchers */}
        {myVouchers.length > 0 && (() => {
          const unusedVouchers = myVouchers.filter((v) => !v.used && !isExpired(v.created_at));
          const usedVouchers = myVouchers.filter((v) => v.used && !isExpired(v.created_at));
          const expiredVouchers = myVouchers.filter((v) => isExpired(v.created_at));
          const TAB_META: { key: "unused" | "used" | "expired"; label: string; count: number; accentColor: string }[] = [
            { key: "unused",  label: "Unused",  count: unusedVouchers.length,  accentColor: "var(--accent)" },
            { key: "used",    label: "Used",    count: usedVouchers.length,    accentColor: "var(--text-dim)" },
            { key: "expired", label: "Expired", count: expiredVouchers.length, accentColor: "var(--red)" },
          ];
          const tabMap = { unused: unusedVouchers, used: usedVouchers, expired: expiredVouchers };
          const tabList = tabMap[voucherTab];
          const filterQ = voucherFilter.toLowerCase();
          const filtered = filterQ
            ? tabList.filter((v) => v.reward_name.toLowerCase().includes(filterQ) || v.reward_restaurant.toLowerCase().includes(filterQ))
            : tabList;
          const pageSlice = filtered.slice(0, voucherPage * VOUCHER_PAGE_SIZE);
          const hasMore = filtered.length > pageSlice.length;

          return (
            <>
              <div style={{ fontSize: "0.7rem", color: "var(--accent)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                My Vouchers
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {TAB_META.filter((t) => t.key !== "expired" || expiredVouchers.length > 0).map(({ key, label, count, accentColor }) => {
                  const active = voucherTab === key;
                  return (
                    <button key={key} onClick={() => { setVoucherTab(key); setVoucherFilter(""); setVoucherPage(1); }}
                      style={{ padding: "0.35rem 0.75rem", borderRadius: 8, border: active ? `1px solid ${accentColor}` : "1px solid var(--border)", background: active ? (key === "expired" ? "rgba(248,81,73,0.1)" : key === "used" ? "rgba(100,100,100,0.1)" : "rgba(57,210,192,0.12)") : "transparent", color: active ? accentColor : "var(--text-dim)", fontSize: "0.78rem", fontWeight: active ? 700 : 400, cursor: "pointer", transition: "all 0.15s" }}>
                      {label}{count > 0 && <span style={{ marginLeft: "0.35rem", background: active ? accentColor : "var(--border)", color: active ? (key === "expired" ? "#fff" : "#06090f") : "var(--text-dim)", borderRadius: 10, padding: "0.05rem 0.4rem", fontSize: "0.68rem", fontWeight: 700 }}>{count}</span>}
                    </button>
                  );
                })}
              </div>

              {/* Search filter */}
              {tabList.length > VOUCHER_PAGE_SIZE && (
                <input
                  value={voucherFilter}
                  onChange={(e) => { setVoucherFilter(e.target.value); setVoucherPage(1); }}
                  placeholder="Search by reward name or restaurant…"
                  style={{ width: "100%", padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: "0.82rem", outline: "none", boxSizing: "border-box" }}
                />
              )}

              {/* Count summary */}
              {filtered.length > 0 && (
                <div style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>
                  Showing {pageSlice.length} of {filtered.length}{filterQ ? " matching" : ""} voucher{filtered.length !== 1 ? "s" : ""}
                </div>
              )}

              {/* Voucher list */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                {filtered.length === 0 && (
                  <div style={{ textAlign: "center", color: "var(--text-dim)", fontSize: "0.82rem", padding: "1.5rem 0" }}>
                    {filterQ ? "No matching vouchers." : voucherTab === "unused" ? "No active vouchers." : voucherTab === "used" ? "No used vouchers yet." : "No expired vouchers."}
                  </div>
                )}
                {pageSlice.map((v) => {
                  const expired = isExpired(v.created_at);
                  const dimmed = v.used || expired;
                  const revealed = revealedCodes.has(v.code);
                  return (
                    <div key={v.code} style={{ background: dimmed ? "var(--bg)" : "var(--card)", border: `1px solid ${expired ? "rgba(248,81,73,0.2)" : dimmed ? "var(--border)" : "rgba(57,210,192,0.28)"}`, borderRadius: 14, padding: "0.85rem 1rem", opacity: dimmed ? 0.65 : 1 }}>
                      {/* Top row */}
                      <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
                        {v.reward_image && <img src={v.reward_image} alt="" style={{ width: 42, height: 42, borderRadius: 8, objectFit: "cover", flexShrink: 0, filter: dimmed ? "grayscale(1)" : "none" }} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: "0.85rem", color: dimmed ? "var(--text-dim)" : "var(--text-bright)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.reward_name}</div>
                          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginBottom: "0.25rem" }}>{v.reward_restaurant}</div>
                          <div style={{ fontSize: "0.65rem", color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                            <span>Redeemed: {formatDate(v.created_at)}</span>
                            <span style={{ color: expired ? "var(--red)" : "var(--text-dim)" }}>
                              {expired ? "Expired: " : "Expires: "}{formatDate(expiryDate(v.created_at))}
                            </span>
                          </div>
                        </div>
                        <div style={{ flexShrink: 0 }}>
                          {v.used ? (
                            <span style={{ fontSize: "0.65rem", color: "var(--text-dim)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "0.15rem 0.45rem" }}>Used</span>
                          ) : expired ? (
                            <span style={{ fontSize: "0.65rem", color: "var(--red)", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.25)", borderRadius: 6, padding: "0.15rem 0.45rem" }}>Expired</span>
                          ) : null}
                        </div>
                      </div>

                      {/* Code row */}
                      <div style={{ marginTop: "0.65rem", display: "flex", alignItems: "center", gap: "0.4rem", background: "var(--bg)", borderRadius: 8, padding: "0.45rem 0.65rem" }}>
                        <div style={{ flex: 1, fontFamily: "monospace", fontSize: "0.82rem", color: dimmed ? "var(--text-dim)" : "var(--accent)", letterSpacing: "0.08em" }}>
                          {revealed ? v.code : "•".repeat(Math.min(v.code.length, 12))}
                        </div>
                        <button
                          onClick={() => setRevealedCodes((prev) => { const s = new Set(prev); s.has(v.code) ? s.delete(v.code) : s.add(v.code); return s; })}
                          style={{ fontSize: "0.65rem", color: "var(--text-dim)", background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "0.15rem 0.4rem", cursor: "pointer" }}>
                          {revealed ? "Hide" : "Show"}
                        </button>
                        {!dimmed && (
                          <button onClick={() => copyCode(v.code)}
                            style={{ fontSize: "0.65rem", color: copiedCode === v.code ? "#3fb950" : "var(--text-dim)", background: copiedCode === v.code ? "rgba(63,185,80,0.1)" : "none", border: `1px solid ${copiedCode === v.code ? "#3fb950" : "var(--border)"}`, borderRadius: 6, padding: "0.15rem 0.4rem", cursor: "pointer", transition: "all 0.2s" }}>
                            {copiedCode === v.code ? "Copied!" : "Copy"}
                          </button>
                        )}
                        {!v.used && !expired && (
                          <button onClick={() => markUsed(v.code)} disabled={markingUsed === v.code}
                            style={{ fontSize: "0.65rem", color: "#f85149", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.3)", borderRadius: 6, padding: "0.15rem 0.4rem", cursor: "pointer", opacity: markingUsed === v.code ? 0.5 : 1 }}>
                            {markingUsed === v.code ? "…" : "Mark Used"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Load more */}
                {hasMore && (
                  <button onClick={() => setVoucherPage((p) => p + 1)}
                    style={{ width: "100%", padding: "0.6rem", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", fontSize: "0.82rem", cursor: "pointer" }}>
                    Show {Math.min(VOUCHER_PAGE_SIZE, filtered.length - pageSlice.length)} more ({filtered.length - pageSlice.length} remaining)
                  </button>
                )}
              </div>
            </>
          );
        })()}

        {/* Rewards catalog */}
        <div style={{ fontSize: "0.7rem", color: "var(--accent)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Rewards Catalog
        </div>

        {loadingRewards && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--text-dim)", fontSize: "0.85rem", padding: "2rem", justifyContent: "center" }}>
            <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            Loading rewards…
          </div>
        )}

        {!loadingRewards && rewardsError && (
          <div style={{ background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 12, padding: "1.25rem", textAlign: "center", color: "var(--text-dim)", fontSize: "0.85rem" }}>
            <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>⚠️</div>
            <div style={{ color: "var(--red)", fontWeight: 600, marginBottom: "0.35rem" }}>Could not load rewards</div>
            <code style={{ color: "var(--accent)" }}>npm run server</code>
          </div>
        )}

        {!loadingRewards && !rewardsError && rewards.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {/* Group by tier */}
            {([1, 2, 3, 4] as const).map((tierLevel) => {
              const tierInfo = TIERS[tierLevel];
              const tierRewards = rewards.filter((r) => r.required_tier === tierLevel);
              const tierUnlocked = (tierData?.tier ?? 0) >= tierLevel;
              if (!tierRewards.length) return null;
              return (
                <div key={tierLevel}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <span style={{
                      fontSize: "0.85rem", color: tierInfo.color,
                      filter: tierLevel === 4 ? "drop-shadow(0 0 4px #d4a84366)" : undefined,
                      animation: tierLevel === 4 ? "bd-float 3.5s ease-in-out infinite" : undefined,
                    }}>{TIER_ICON[tierLevel]}</span>
                    <span style={{
                      fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
                      ...(tierLevel === 4 ? {
                        background: "linear-gradient(90deg, #8b6410, #d4a843, #f5d060, #d4a843, #8b6410)",
                        backgroundSize: "200% auto",
                        WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                        animation: "bd-shimmer 5s linear infinite",
                      } : { color: tierInfo.color }),
                    }}>
                      {tierInfo.name} Rewards
                    </span>
                    {!tierUnlocked && (
                      <span style={{ fontSize: "0.65rem", color: "var(--text-dim)", background: "var(--border)", borderRadius: 4, padding: "0.1rem 0.4rem" }}>
                        Reach {tierInfo.min} bookings to unlock
                      </span>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem" }}>
                    {tierRewards.map((r) => {
                      const canAfford = walletConnected && tierUnlocked && (points ?? 0) >= r.points_cost;
                      const locked = !tierUnlocked;
                      const isBlackDiamond = tierLevel === 4;
                      return (
                        <div key={r.id} style={{
                          background: isBlackDiamond && !locked
                            ? "radial-gradient(ellipse at 30% 20%, #1a1200, #060400 60%, #000)"
                            : "var(--card)",
                          border: locked ? "1px solid var(--border)" : isBlackDiamond ? `1px solid #d4a84355` : `1px solid ${tierInfo.color}33`,
                          boxShadow: isBlackDiamond && !locked ? "0 0 20px #d4a84328, 0 0 50px #d4a84312, inset 0 1px 0 #f5d06018" : "none",
                          borderRadius: 14, overflow: "hidden", display: "flex", flexDirection: "column",
                          opacity: locked ? 0.45 : 1, transition: "opacity 0.2s", position: "relative",
                        }}>
                          {locked && (
                            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,9,15,0.55)", zIndex: 1, borderRadius: 14 }}>
                              <div style={{ textAlign: "center" }}>
                                <div style={{ fontSize: "1.5rem" }}>🔒</div>
                                <div style={{ fontSize: "0.65rem", color: tierInfo.color, fontWeight: 700, marginTop: "0.25rem" }}>{tierInfo.name} only</div>
                              </div>
                            </div>
                          )}
                          <div style={{ position: "relative" }}>
                            <img src={r.image} alt={r.name}
                              style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }}
                              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            <span style={{
                              position: "absolute", top: 6, right: 6,
                              background: isBlackDiamond ? "#000" : tierInfo.color,
                              color: isBlackDiamond ? "#d4a843" : "#06090f",
                              border: isBlackDiamond ? "1px solid #d4a84388" : "none",
                              fontSize: "0.6rem", fontWeight: 700, borderRadius: 4, padding: "0.15rem 0.45rem",
                            }}>
                              {tierInfo.name}
                            </span>
                          </div>
                          <div style={{ padding: "0.65rem", flex: 1, display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                            <div style={{ fontWeight: 700, fontSize: "0.82rem", lineHeight: 1.3,
                              color: isBlackDiamond && !locked ? "#f0e6c8" : "var(--text-bright)",
                            }}>{r.name}</div>
                            <div style={{ fontSize: "0.68rem", lineHeight: 1.4, flex: 1,
                              color: isBlackDiamond && !locked ? "#8a7550" : "var(--text-dim)",
                            }}>{r.description}</div>
                            <div style={{ fontSize: "0.65rem", marginTop: "0.1rem",
                              color: isBlackDiamond && !locked ? "#6a5028" : "var(--text-dim)",
                            }}>
                              {STORE_EMOJI[r.restaurant_type] ?? "📍"} {r.restaurant}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "0.4rem" }}>
                              <span style={{ fontSize: "0.8rem", fontWeight: 700,
                                color: isBlackDiamond && !locked ? "#d4a843" : tierInfo.color,
                              }}>{r.points_cost} pts</span>
                              <button
                                onClick={() => { setRedeemError(null); setConfirming(r); }}
                                disabled={!canAfford || redeeming === r.id || locked}
                                style={{
                                  padding: "0.28rem 0.65rem", borderRadius: 7, fontSize: "0.72rem", fontWeight: 700,
                                  cursor: canAfford ? "pointer" : "not-allowed",
                                  opacity: redeeming === r.id ? 0.6 : 1,
                                  ...(canAfford
                                    ? {
                                        border: "none",
                                        background: isBlackDiamond ? "linear-gradient(135deg, #c8961e, #d4a843)" : tierInfo.color,
                                        color: "#06090f",
                                        boxShadow: isBlackDiamond ? "0 0 8px #d4a84344" : "none",
                                      }
                                    : {
                                        border: isBlackDiamond && !locked ? "1px solid #3a2a0a" : `1px solid ${tierInfo.color}22`,
                                        background: "transparent",
                                        color: isBlackDiamond && !locked ? "#4a3510" : `${tierInfo.color}88`,
                                      }
                                  ),
                                }}
                              >
                                {redeeming === r.id ? "…" : !walletConnected ? "Connect" : !tierUnlocked ? "Locked" : canAfford ? "Redeem" : "Need more"}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        </>}
      </div>

      {/* Redemption confirmation modal */}
      {confirming && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem" }}
          onClick={() => setConfirming(null)}>
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20, padding: "1.5rem", width: "100%", maxWidth: 400, display: "flex", flexDirection: "column", gap: "1rem" }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: "1rem", color: "var(--text-bright)" }}>Confirm Redemption</div>
            <div style={{ background: "var(--bg)", borderRadius: 10, padding: "0.9rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
              <img src={confirming.image} alt={confirming.name}
                style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", flexShrink: 0 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--text-bright)" }}>{confirming.name}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{confirming.restaurant}</div>
                <div style={{ fontSize: "0.8rem", color: CATEGORY_COLOR[confirming.category], fontWeight: 700, marginTop: "0.2rem" }}>{confirming.points_cost} pts</div>
              </div>
            </div>
            <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", lineHeight: 1.5 }}>
              You have <strong style={{ color: "var(--text)" }}>{points} pts</strong>. After redemption: <strong style={{ color: "var(--text)" }}>{(points ?? 0) - confirming.points_cost} pts</strong>
            </div>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button onClick={() => setConfirming(null)} disabled={redeeming === confirming.id}
                style={{ flex: 1, padding: "0.7rem", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", fontSize: "0.88rem", cursor: redeeming === confirming.id ? "not-allowed" : "pointer", opacity: redeeming === confirming.id ? 0.4 : 1 }}>
                Cancel
              </button>
              <button onClick={() => redeem(confirming)}
                disabled={!!redeeming}
                style={{ flex: 2, padding: "0.7rem", borderRadius: 10, border: "none", background: "var(--accent)", color: "#06090f", fontSize: "0.88rem", fontWeight: 700, cursor: redeeming ? "not-allowed" : "pointer", opacity: redeeming ? 0.8 : 1 }}>
                {redeeming === confirming.id ? "Processing…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Voucher modal */}
      {voucher && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem" }}>
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20, padding: "2rem 1.5rem", maxWidth: 340, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem", textAlign: "center" }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: "2.8rem", lineHeight: 1 }}>🎉</div>
            <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--text-bright)" }}>Reward Redeemed!</div>
            <div style={{ background: "var(--bg)", borderRadius: 12, padding: "0.9rem 1rem", width: "100%", display: "flex", gap: "0.75rem", alignItems: "center" }}>
              {voucher.reward.image && (
                <img src={voucher.reward.image} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover", flexShrink: 0 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              )}
              <div style={{ textAlign: "left" }}>
                <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--text-bright)" }}>{voucher.reward.name}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{voucher.reward.restaurant}</div>
              </div>
            </div>
            <div style={{ background: "rgba(57,210,192,0.08)", border: "1px solid rgba(57,210,192,0.25)", borderRadius: 10, padding: "0.75rem 1rem", width: "100%", fontSize: "0.82rem", color: "var(--text-dim)", lineHeight: 1.6, textAlign: "left" }}>
              Your voucher has been saved to <strong style={{ color: "var(--accent)" }}>My Vouchers</strong> below. Tap <em>Show</em> on your voucher to reveal the code and present it to staff when you visit.
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
              Points remaining: <strong style={{ color: "var(--text)" }}>{voucher.remaining} pts</strong>
            </div>
            <div style={{ width: "100%", position: "relative" }}>
              <button onClick={() => dismissVoucher()}
                style={{ width: "100%", padding: "0.7rem", borderRadius: 10, border: "none", background: "var(--accent)", color: "#06090f", fontSize: "0.88rem", fontWeight: 700, cursor: "pointer" }}>
                Got it
              </button>
              <div style={{ marginTop: "0.4rem", height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ height: "100%", background: "var(--accent)", borderRadius: 2, transformOrigin: "left", animation: "voucher-drain 30s linear forwards" }} />
              </div>
              <div style={{ textAlign: "center", fontSize: "0.68rem", color: "var(--text-dim)", marginTop: "0.25rem" }}>Auto-closes in 30s</div>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div style={{ position: "fixed", bottom: "1.5rem", right: "1.5rem", zIndex: 2000, maxWidth: 340, animation: "toast-in 0.2s ease" }}>
          <div style={{ background: toast.type === "error" ? "#1a0a0a" : "#0a1a12", border: `1px solid ${toast.type === "error" ? "rgba(248,81,73,0.5)" : "rgba(57,210,192,0.4)"}`, borderRadius: 12, padding: "0.85rem 1rem", display: "flex", alignItems: "flex-start", gap: "0.65rem", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
            <span style={{ fontSize: "1rem", flexShrink: 0, lineHeight: 1.4 }}>{toast.type === "error" ? "⚠️" : "ℹ️"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "0.82rem", color: toast.type === "error" ? "#f85149" : "var(--accent)", lineHeight: 1.5 }}>{toast.msg}</div>
            </div>
            <button onClick={() => setToast(null)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "1rem", lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}
