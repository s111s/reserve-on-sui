import { useState, useEffect, useRef, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useCurrentWallet, useCurrentAccount, useDisconnectWallet } from "@mysten/dapp-kit";
import { decodeBookingData, saveBookingToSession, loadBookingFromSession } from "@/lib/booking-url";
import { loadSession, isReady, getAuthPref } from "@/lib/zklogin";
import { useBookingFlow } from "@/hooks/useBookingFlow";
import type { BookingData, Currency } from "@/lib/types";
import { CURRENCIES } from "@/lib/types";
import { saveBookingPass } from "@/components/RestaurantPassCard";

const NETWORK = (import.meta.env.VITE_SUI_NETWORK as string) || "testnet";
const NETWORK_COLOR: Record<string, string> = { mainnet: "#f85149", testnet: "#d29922", devnet: "#3fb950" };
const STAGE_LABEL: Record<string, string> = { mainnet: "Production", testnet: "Testnet Beta", devnet: "Dev" };

// ── Persistent top banner ─────────────────────────────────────────
function StageBanner() {
  const color = NETWORK_COLOR[NETWORK] ?? "#888";
  const label = STAGE_LABEL[NETWORK] ?? NETWORK;
  if (NETWORK === "mainnet") return null;
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000, background: `${color}22`, borderBottom: `1px solid ${color}55`, padding: "0.3rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
      <span style={{ fontSize: "0.72rem", color, fontWeight: 600 }}>{label} — This app is running on Sui {NETWORK}. Tokens have no real value.</span>
    </div>
  );
}

// ── Network check ─────────────────────────────────────────────────
function useWalletNetwork() {
  const { currentWallet, connectionStatus } = useCurrentWallet();
  if (!currentWallet || connectionStatus !== "connected") return { status: "ok" as const, wallet: null };
  const allChains = (currentWallet.chains ?? []) as string[];
  const expectedChain = `sui:${NETWORK}`;
  if (allChains.length > 0 && !allChains.includes(expectedChain)) {
    const onMainnet = allChains.some((c) => c === "sui:mainnet");
    if (onMainnet && NETWORK !== "mainnet") return { status: "mainnet-danger" as const, wallet: currentWallet };
    return { status: "mismatch" as const, currentChain: allChains[0] ?? null, wallet: currentWallet };
  }
  return { status: "ok" as const, wallet: currentWallet };
}

function WalletNetworkWarning() {
  const net = useWalletNetwork();
  if (net.status === "ok") return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function switchNetwork() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feature = (net as any).wallet?.features?.["sui:changeNetwork"];
      if (feature?.changeNetwork) { await feature.changeNetwork({ network: NETWORK }); return; }
    } catch { /* fall through */ }
    window.open("https://slush.app", "_blank");
  }

  if (net.status === "mainnet-danger") {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem" }}>
        <div style={{ background: "var(--card)", border: "2px solid #f85149", borderRadius: 16, padding: "2rem 1.5rem", maxWidth: 380, width: "100%", display: "flex", flexDirection: "column", gap: "1rem", textAlign: "center" }}>
          <div style={{ fontSize: "2.5rem" }}>🚫</div>
          <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "#f85149" }}>Mainnet Detected</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", lineHeight: 1.6 }}>
            Your wallet is connected to <strong style={{ color: "var(--text)" }}>Sui Mainnet</strong>.<br />
            This app runs on <strong style={{ color: "#d29922" }}>Sui {NETWORK}</strong> and uses test tokens with no real value.<br /><br />
            Switch to <strong style={{ color: "#d29922" }}>{NETWORK}</strong> to protect your real assets.
          </div>
          <button onClick={switchNetwork} style={{ padding: "0.75rem", borderRadius: 10, border: "none", background: "#d29922", color: "#06090f", fontWeight: 700, fontSize: "0.9rem", cursor: "pointer" }}>
            Switch to {NETWORK} in Slush →
          </button>
          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>Open Slush → Settings → Network → {NETWORK}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontSize: "0.82rem", background: "rgba(210,153,34,0.08)", border: "1px solid rgba(210,153,34,0.4)", borderRadius: 10, padding: "0.75rem 1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: "#d29922", fontWeight: 600 }}>⚠ Wrong network</div>
      <div style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
        Wallet is on <strong style={{ color: "var(--text)" }}>{(net.currentChain ?? "").replace("sui:", "Sui ")}</strong>, app requires <strong style={{ color: "var(--text)" }}>Sui {NETWORK}</strong>.
      </div>
      <button onClick={switchNetwork} style={{ alignSelf: "flex-start", padding: "0.35rem 0.85rem", borderRadius: 7, border: "1px solid rgba(210,153,34,0.5)", background: "rgba(210,153,34,0.12)", color: "#d29922", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer" }}>
        Switch to {NETWORK} →
      </button>
    </div>
  );
}

// ── Shop banner hero ──────────────────────────────────────────────
function ShopBannerHero({ booking }: { booking: BookingData }) {
  // After checkout the slot is held and shop-detail returns slot-unavailable.
  // Use merchant data passed through from Book.tsx reservation instead.
  const banner  = booking.merchant.image ?? null;
  const logo    = booking.merchant.image ?? null;
  const name    = booking.merchant.name;
  const addr    = booking.merchant.address ?? "";
  const rating  = booking.merchant.rating ?? null;
  const michelin = false;

  if (!banner) {
    // No image at all — simple header
    return (
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "1rem 1.1rem", display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <span style={{ fontSize: "2rem" }}>{EMOJI[booking.merchant.type] ?? "📍"}</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: "1rem" }}>{name}</div>
          {addr && <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{addr}</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)" }}>
      <div style={{ position: "relative", height: 150 }}>
        <img src={banner} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 25%, rgba(0,0,0,0.7))" }} />
        {rating !== null && (
          <span style={{ position: "absolute", top: 10, right: 10, fontSize: "0.75rem", fontWeight: 700, color: "#f5c842", background: "rgba(0,0,0,0.55)", borderRadius: 7, padding: "0.2rem 0.55rem", backdropFilter: "blur(4px)" }}>
            ★ {rating}
          </span>
        )}
        <div style={{ position: "absolute", bottom: 10, left: 12, display: "flex", alignItems: "center", gap: "0.6rem" }}>
          {logo && <img src={logo} alt="" style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", border: "2px solid rgba(255,255,255,0.3)" }} />}
          <div>
            <div style={{ fontWeight: 700, color: "#fff", fontSize: "0.95rem", display: "flex", alignItems: "center", gap: "0.35rem" }}>
              {name}{michelin && <span title="Michelin Guide">⭐</span>}
            </div>
            {addr && <div style={{ fontSize: "0.68rem", color: "rgba(255,255,255,0.72)" }}>{addr}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

const EMOJI: Record<string, string> = {
  restaurant: "🍽️", hotel: "🏨", cafe: "☕", spa: "💆", bar: "🍸", activity: "🎯", other: "📍",
};

// ── Page root ─────────────────────────────────────────────────────
export default function PaymentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const disconnectWallet = useDisconnectWallet();

  useEffect(() => {
    if (getAuthPref() !== "slush") disconnectWallet.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shopId  = params.get("shop");
  const eventId = params.get("event");
  const poId    = params.get("po_id");
  const token   = params.get("token");

  const [remoteBooking, setRemoteBooking]   = useState<BookingData | null>(null);
  const [remoteCallback, setRemoteCallback] = useState<string>("");
  const [remoteLoading, setRemoteLoading]   = useState(!!(token || (shopId && eventId)));
  const [remoteError, setRemoteError]       = useState<string | null>(null);
  const [slotExpired, setSlotExpired]       = useState(false);
  const expiryKey = shopId && eventId ? `slot_expiry_${shopId}_${eventId}` : null;
  const [expiresAt, setExpiresAt]           = useState<Date | null>(() => {
    if (!shopId || !eventId || !expiryKey) return null;
    const stored = sessionStorage.getItem(expiryKey);
    if (stored) { const d = new Date(stored); if (!isNaN(d.getTime()) && d > new Date()) return d; }
    const d = new Date(Date.now() + 10 * 60 * 1000);
    sessionStorage.setItem(expiryKey, d.toISOString());
    return d;
  });
  const [expiryFromApi, setExpiryFromApi]   = useState(false);

  useEffect(() => {
    if (token) {
      setRemoteLoading(true);
      fetch(`/api/reservation/${token}`)
        .then((r) => r.json() as Promise<{ ok: boolean; booking: BookingData; callback_url: string; error?: string }>)
        .then((d) => {
          if (!d.ok) throw new Error(d.error ?? "Reservation not found or expired");
          saveBookingToSession(d.booking);
          setRemoteBooking(d.booking);
          setRemoteCallback(d.callback_url);
        })
        .catch((e: unknown) => setRemoteError(e instanceof Error ? e.message : "Failed to load reservation"))
        .finally(() => setRemoteLoading(false));
      return;
    }
    if (shopId && eventId) {
      setRemoteLoading(true);
      fetch(`/api/aappoint/shop/${shopId}/event/${eventId}`)
        .then((r) => r.json() as Promise<{ ok: boolean; booking: BookingData; error?: string }>)
        .then((d) => {
          if (!d.ok) throw new Error(d.error ?? "Failed to load event");
          saveBookingToSession(d.booking);
          setRemoteBooking(d.booking);
        })
        .catch((e: unknown) => setRemoteError(e instanceof Error ? e.message : "Failed to load event"))
        .finally(() => setRemoteLoading(false));
    }
  }, [token, shopId, eventId]);

  // Poll payment-result to detect slot expiry and extract expiry time
  useEffect(() => {
    if (!shopId || !eventId || !poId) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/aappoint/payment-result?shop_id=${shopId}&event_id=${eventId}&po_id=${poId}`);
        if (cancelled) return;
        const data = await res.json() as Record<string, unknown>;
        const po    = data.purchase_order as Record<string, unknown> | undefined;
        const evt   = data.event          as Record<string, unknown> | undefined;

        // Extract expiry timestamp — try common field names
        const rawExpiry =
          po?.expires_at ?? po?.expired_at ?? po?.expiry_at ?? po?.expiry ??
          evt?.expires_at ?? evt?.expired_at ??
          data.expires_at ?? data.expired_at;
        if (rawExpiry) {
          const d = new Date(rawExpiry as string);
          if (!isNaN(d.getTime())) {
            setExpiresAt(d);
            setExpiryFromApi(true);
            if (expiryKey) sessionStorage.setItem(expiryKey, d.toISOString());
          }
        }

        const EXPIRED = ["expired", "cancelled", "canceled", "timeout", "voided"];
        if (EXPIRED.includes((evt?.status as string) ?? "") || EXPIRED.includes((po?.status as string) ?? "")) {
          setSlotExpired(true);
        }
      } catch { /* non-critical — keep polling */ }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId, eventId, poId]);

  if (remoteLoading) {
    return (
      <div style={centerStyle}>
        <Spinner size={22} />
        <p style={{ color: "var(--text-dim)", marginTop: "0.75rem", fontSize: "0.88rem" }}>Loading reservation details…</p>
      </div>
    );
  }

  if (remoteError) {
    return (
      <div style={centerStyle}>
        <div style={{ fontSize: "2rem" }}>⚠️</div>
        <p style={{ color: "var(--red)", fontWeight: 600, margin: 0 }}>{remoteError}</p>
        <button onClick={() => navigate("/mock")} style={linkBtnStyle}>← Back to experiences</button>
      </div>
    );
  }

  const booking: BookingData | null = remoteBooking ?? (() => {
    const d = params.get("d");
    if (d) {
      const decoded = decodeBookingData(d);
      if (decoded) { saveBookingToSession(decoded); return decoded; }
    }
    return loadBookingFromSession();
  })();

  if (slotExpired) {
    return (
      <div style={centerStyle}>
        <div style={{ fontSize: "2.5rem" }}>⏰</div>
        <p style={{ fontWeight: 700, margin: "0.25rem 0 0", fontSize: "1rem" }}>Slot Released</p>
        <p style={{ color: "var(--text-dim)", margin: "0.25rem 0 0", fontSize: "0.85rem", textAlign: "center", lineHeight: 1.5 }}>
          Your reserved time slot has expired.<br />Please pick a new time.
        </p>
        <button onClick={() => navigate(-1)} style={{ ...linkBtnStyle, marginTop: "0.5rem", color: "var(--accent)", fontWeight: 600 }}>
          ← Pick a new time
        </button>
      </div>
    );
  }

  if (!booking) {
    return (
      <div style={centerStyle}>
        <div style={{ fontSize: "2rem" }}>🔍</div>
        <p style={{ color: "var(--text-dim)", margin: 0 }}>No booking data found.</p>
        <button onClick={() => navigate("/mock")} style={linkBtnStyle}>← Back to experiences</button>
      </div>
    );
  }

  const callbackUrl = "/api/confirm-booking";
  return <BookingPayment booking={booking} callbackUrl={callbackUrl} expiresAt={expiresAt} expiryExact={expiryFromApi} expiryKey={expiryKey} />;
}

// ── Auto-confirm free bookings ────────────────────────────────────
function FreeBookingRedirect({ booking, callbackUrl }: { booking: BookingData; callbackUrl: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const currentAccount = useCurrentAccount();
  const { connectSlush, loginWithGoogle } = useBookingFlow(booking, callbackUrl);

  const userAddress = currentAccount?.address ?? (() => { const s = loadSession(); return isReady(s) ? s.address : undefined; })();
  const [status, setStatus] = useState<"idle" | "confirming" | "done">("idle");
  const [earned, setEarned] = useState(0);
  const callbackFiredRef = useRef(false);

  useEffect(() => {
    if (!userAddress || callbackFiredRef.current) return;
    callbackFiredRef.current = true;
    setStatus("confirming");
    fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "free", booking_id: booking.booking_id, message: "Free reservation confirmed", payment: null, receipt: null, error_code: null, metadata: null, points: null, user_address: userAddress, timestamp: new Date().toISOString() }),
    })
      .then((r) => r.json() as Promise<{ points?: { earned: number } }>)
      .then((d) => { setEarned(d.points?.earned ?? 1); setStatus("done"); })
      .catch(() => { setStatus("done"); });
  }, [userAddress, status]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem" }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, padding: "2rem 1.5rem", maxWidth: 360, width: "100%", textAlign: "center", display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "center" }}>
        {!userAddress && (
          <>
            <div style={{ fontSize: "2rem" }}>🎫</div>
            <div style={{ fontWeight: 700, fontSize: "1rem" }}>Connect to Confirm</div>
            <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", lineHeight: 1.5 }}>
              This booking is <strong style={{ color: "var(--text)" }}>free</strong> — connect your wallet to receive your on-chain receipt and points.
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "0.6rem 0.8rem", width: "100%", boxSizing: "border-box" }}>
              {booking.merchant.name} · {booking.slot.date} {booking.slot.time}
            </div>
            <button onClick={() => loginWithGoogle(`?${params.toString()}`)} style={googleBtnStyle}>
              <GoogleIcon /> Continue with Google
            </button>
            <button onClick={connectSlush} style={slushBtnStyle}>👛 Connect Slush Wallet</button>
          </>
        )}
        {userAddress && status === "confirming" && (
          <><Spinner size={20} /><div style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>Confirming your reservation…</div></>
        )}
        {status === "done" && (
          <>
            <div style={{ fontSize: "2.5rem" }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: "1.05rem", color: "var(--green)" }}>Reservation Confirmed!</div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>{booking.merchant.name} · {booking.slot.date} {booking.slot.time}</div>
            {(() => { saveBookingPass({ bookingId: booking.booking_id, merchantName: booking.merchant.name, date: booking.slot.date, time: booking.slot.time }); return null; })()}
            <PointsCard earned={earned} total={null} onNavigate={() => navigate("/points")} />
            <button onClick={() => navigate("/points?tab=pass")} style={{ width: "100%", padding: "0.6rem", borderRadius: 10, border: "2px solid var(--accent)", background: "transparent", color: "var(--accent)", fontWeight: 700, fontSize: "0.88rem", cursor: "pointer" }}>
              🎟 View My Booking Pass →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Slot expiry countdown banner ──────────────────────────────────
function SlotExpiryBanner({ expiresAt, exact }: { expiresAt: Date; exact: boolean }) {
  const totalSecs = useRef(Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
  const [secsLeft, setSecsLeft] = useState(() => Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));

  useEffect(() => {
    const id = setInterval(() => setSecsLeft(Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const mins    = Math.floor(secsLeft / 60);
  const secs    = secsLeft % 60;
  const urgent  = secsLeft <= 60;
  const warning = secsLeft <= 120;
  const color   = urgent ? "#f85149" : warning ? "#d29922" : "#4a90e2";
  const progress = secsLeft / totalSecs.current; // 1 → 0

  // SVG ring
  const R    = 22;
  const circ = 2 * Math.PI * R;
  const offset = circ * (1 - progress);

  return (
    <div style={{
      background: `${color}10`, border: `1px solid ${color}35`, borderRadius: 12,
      padding: "0.75rem 1rem", display: "flex", alignItems: "center", gap: "1rem",
      marginBottom: "0.75rem",
      animation: urgent ? "expiry-pulse 1s ease-in-out infinite" : undefined,
    }}>
      {/* Circular ring */}
      <svg width={54} height={54} style={{ flexShrink: 0 }}>
        {/* Track */}
        <circle cx={27} cy={27} r={R} fill="none" stroke={`${color}25`} strokeWidth={3.5} />
        {/* Progress arc */}
        <circle cx={27} cy={27} r={R} fill="none" stroke={color} strokeWidth={3.5}
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 27 27)"
          style={{ transition: "stroke-dashoffset 1s linear, stroke 0.4s ease" }}
        />
        {/* Timer text */}
        <text x={27} y={26} textAnchor="middle" dominantBaseline="middle"
          style={{ fontSize: "9.5px", fontWeight: 700, fill: color, fontFamily: "monospace", letterSpacing: "-0.5px" }}>
          {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
        </text>
      </svg>

      {/* Label */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--text)", marginBottom: "0.2rem" }}>
          {urgent ? "⚠ Pay now — slot expiring!" : "⏳ Slot held for you"}
        </div>
        <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", lineHeight: 1.4 }}>
          Please confirm payment before{" "}
          <strong style={{ color }}>{expiresAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong>
        </div>
        {!exact && (
          <div style={{ fontSize: "0.68rem", color: "var(--text-dim)", marginTop: "0.2rem", opacity: 0.7 }}>
            Estimated — actual hold time may vary
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main payment UI ───────────────────────────────────────────────
function BookingPayment({ booking, callbackUrl, expiresAt, expiryExact, expiryKey }: { booking: BookingData; callbackUrl: string; expiresAt: Date | null; expiryExact: boolean; expiryKey: string | null }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [selectedCurrency, setSelectedCurrency] = useState<Currency>(booking.fee.currency ?? "USDC");
  const activeBooking = useMemo(() => ({ ...booking, fee: { ...booking.fee, currency: selectedCurrency } }), [booking, selectedCurrency]);
  const { step, wallet, currency, activeFee, authMethod, result, error, connectSlush, loginWithGoogle, confirm, disconnect, refreshBalance } = useBookingFlow(activeBooking, callbackUrl);

  const isConnected = step === "ready" || step === "paying";
  useEffect(() => { if (isConnected) { refreshBalance(); } }, [selectedCurrency]); // eslint-disable-line react-hooks/exhaustive-deps

  const paid = step === "done" || !!result;
  useEffect(() => { if (paid && expiryKey) sessionStorage.removeItem(expiryKey); }, [paid, expiryKey]);

  const fmtDate = new Date(booking.slot.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric" });
  const fmtTime = booking.slot.time;
  const isFree  = !booking.fee.has_fee;
  const feeAmt  = activeFee.amount_after_coupon ?? activeFee.amount_usdc;
  const estPts  = isFree ? 1 : Math.floor(feeAmt * 10);

  // Free bookings → simpler confirm flow
  if (isFree) return <FreeBookingRedirect booking={booking} callbackUrl={callbackUrl} />;

  return (
    <>
      <StageBanner />
      <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "inherit", paddingBottom: "3rem" }}>
        <div style={{ maxWidth: 440, margin: "0 auto", padding: `${NETWORK !== "mainnet" ? "2.5rem" : "1.5rem"} 1rem 0` }}>

          {/* Back link */}
          <button onClick={() => navigate("/mock")} style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: "0.8rem", cursor: "pointer", padding: "0 0 0.75rem", display: "block" }}>
            ← Back
          </button>

          {/* Shop banner hero */}
          <ShopBannerHero booking={booking} />

          {/* Booking ticket */}
          <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, marginTop: "0.75rem", overflow: "hidden" }}>
            {/* Slot row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: "1px solid var(--border)" }}>
              {[
                { icon: "📅", label: "Date",   value: fmtDate },
                { icon: "🕐", label: "Time",   value: fmtTime },
                { icon: "👥", label: "Guests", value: `${booking.slot.party_size} ${booking.slot.party_size === 1 ? "person" : "people"}` },
              ].map((col, i) => (
                <div key={i} style={{ padding: "0.85rem 0.75rem", borderRight: i < 2 ? "1px solid var(--border)" : "none" }}>
                  <div style={{ fontSize: "0.68rem", color: "var(--text-dim)", marginBottom: "0.25rem" }}>{col.icon} {col.label}</div>
                  <div style={{ fontSize: "0.82rem", fontWeight: 600, lineHeight: 1.3 }}>{col.value}</div>
                </div>
              ))}
            </div>
            {/* Fee row */}
            <div style={{ padding: "0.85rem 1rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: "0.82rem", color: "var(--text-dim)" }}>{booking.fee.label || "Platform fee"}</div>
                {booking.fee.refundable && <div style={{ fontSize: "0.68rem", color: "var(--green)", marginTop: "0.1rem" }}>✓ Refundable</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 700, fontSize: "1.15rem", color: "var(--accent)" }}>
                  {feeAmt.toFixed(2)} <span style={{ fontSize: "0.8rem" }}>{currency}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Slot expiry countdown — hidden once payment confirmed */}
          {expiresAt && !paid && <SlotExpiryBanner expiresAt={expiresAt} exact={expiryExact} />}

          {/* Points hint */}
          <div style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-dim)", padding: "0.5rem 0" }}>
            🎁 You'll earn <strong style={{ color: "var(--accent)" }}>{estPts} pts</strong> with this booking
          </div>

          {/* ── Step: loading / connecting ── */}
          {(step === "loading" || step === "connecting") && (
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--text-dim)", fontSize: "0.85rem" }}>
                <Spinner size={14} /> {step === "connecting" ? "Connecting wallet…" : "Loading…"}
              </div>
            </Card>
          )}

          {/* ── Step: connect ── */}
          {step === "connect" && (
            <>
              <WalletNetworkWarning />
              <Card>
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.25rem" }}>Connect to pay</div>
                <button onClick={() => loginWithGoogle(`?${params.toString()}`)} style={googleBtnStyle}>
                  <GoogleIcon /> Continue with Google
                </button>
                <Divider label="or" />
                <button onClick={connectSlush} style={slushBtnStyle}>👛 Connect Slush Wallet</button>
                {error && <ErrorMsg>{error}</ErrorMsg>}
                <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", textAlign: "center", marginTop: "0.25rem" }}>
                  🔒 Your identity is never stored on-chain
                </div>
              </Card>
            </>
          )}

          {/* ── Step: ready / paying ── */}
          {(step === "ready" || step === "paying") && wallet.address && (
            <>
              <Card>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {authMethod === "zklogin" ? "Google (zkLogin)" : "Slush Wallet"}
                  </span>
                  <button onClick={disconnect} style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: "0.75rem", cursor: "pointer", padding: 0 }}>Disconnect</button>
                </div>
                <AddressDisplay address={wallet.address} />
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.1rem" }}>
                  {wallet.balanceStable !== null && (
                    <div style={{ fontSize: "0.78rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ color: (booking.fee.has_fee && parseFloat(wallet.balanceStable ?? "0") === 0) ? "var(--red)" : "var(--text-dim)" }}>
                        {wallet.balanceStable} {currency}
                      </span>
                      <RefreshButton onRefresh={refreshBalance} />
                      <FaucetButton currency={currency} address={wallet.address!} onDone={refreshBalance} />
                    </div>
                  )}
                  {authMethod === "zklogin" ? (
                    <div style={{ fontSize: "0.72rem", display: "inline-flex", alignItems: "center", gap: "0.35rem", color: "#3fb950", background: "rgba(63,185,80,0.1)", border: "1px solid rgba(63,185,80,0.3)", borderRadius: 6, padding: "0.18rem 0.55rem", alignSelf: "flex-start" }}>
                      ⛽ Gas sponsored — no SUI needed
                    </div>
                  ) : wallet.balance !== null && (
                    <div style={{ fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ color: parseFloat(wallet.balance ?? "0") === 0 ? "var(--red)" : "var(--text-dim)" }}>
                        {wallet.balance} SUI <span style={{ opacity: 0.5 }}>(gas)</span>
                      </span>
                      {parseFloat(wallet.balance ?? "0") === 0 && (
                        <a href="https://faucet.sui.io/" target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.72rem", color: "var(--accent)" }}>Get testnet SUI ↗</a>
                      )}
                    </div>
                  )}
                </div>
              </Card>

              <WalletNetworkWarning />

              {/* Currency picker */}
              <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "0.65rem 0.85rem", marginTop: "0.25rem" }}>
                <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>Pay with</div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  {CURRENCIES.map((c) => (
                    <button key={c} onClick={() => setSelectedCurrency(c)} style={{ flex: 1, padding: "0.4rem 0.5rem", borderRadius: 8, border: `1px solid ${selectedCurrency === c ? "var(--accent)" : "var(--border)"}`, background: selectedCurrency === c ? "var(--accent)" : "transparent", color: selectedCurrency === c ? "#06090f" : "var(--text)", fontSize: "0.8rem", fontWeight: selectedCurrency === c ? 700 : 400, cursor: "pointer" }}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {(() => {
                const required     = feeAmt;
                const available    = parseFloat(wallet.balanceStable ?? "0");
                const insufficient = booking.fee.has_fee && available < required;
                const disabled     = step === "paying" || insufficient;
                return (
                  <>
                    <button onClick={confirm} disabled={disabled} style={{ ...payBtnStyle, opacity: disabled ? 0.45 : 1, cursor: disabled ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
                      {step === "paying"
                        ? <><Spinner size={16} /> Processing…</>
                        : <>🔒 Pay {feeAmt.toFixed(2)} {currency} &amp; Confirm</>}
                    </button>
                    {insufficient && (
                      <div style={{ fontSize: "0.75rem", color: "var(--red)", textAlign: "center", marginTop: "0.25rem" }}>
                        Need {required.toFixed(2)} {currency} — you have {available.toFixed(2)}. Use the faucet above.
                      </div>
                    )}
                  </>
                );
              })()}

              {error && <ErrorMsg>{error}</ErrorMsg>}
            </>
          )}

          {/* ── Step: done ── */}
          {step === "done" && result && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {result.status !== "failed" ? (
                <>
                  <div style={{ textAlign: "center", padding: "1.25rem 0 0.5rem" }}>
                    <div style={{ fontSize: "3rem", lineHeight: 1 }}>✅</div>
                    <div style={{ fontWeight: 700, fontSize: "1.2rem", color: "var(--green)", marginTop: "0.5rem" }}>Booking Confirmed!</div>
                    <div style={{ fontSize: "0.83rem", color: "var(--text-dim)", marginTop: "0.25rem" }}>
                      {booking.merchant.name} · {fmtDate} {fmtTime}
                    </div>
                  </div>

                  {(() => { saveBookingPass({ bookingId: result.booking_id, merchantName: booking.merchant.name, date: fmtDate, time: fmtTime, objectId: result.receipt?.object_id, txHash: result.receipt?.tx_hash }); return null; })()}
                  <PointsCard earned={result.points?.earned ?? estPts} total={result.points?.balance ?? null} onNavigate={() => navigate("/points")} />
                  <button onClick={() => navigate("/points?tab=pass")} style={{ width: "100%", padding: "0.6rem", borderRadius: 10, border: "2px solid var(--accent)", background: "transparent", color: "var(--accent)", fontWeight: 700, fontSize: "0.88rem", cursor: "pointer" }}>
                    🎟 View My Booking Pass →
                  </button>

                  {result.receipt && (
                    <details style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10 }}>
                      <summary style={{ padding: "0.7rem 1rem", fontSize: "0.78rem", color: "var(--text-dim)", cursor: "pointer", userSelect: "none" }}>
                        On-chain receipt ↗
                      </summary>
                      <div style={{ padding: "0 1rem 0.75rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        <ResultRow label="Booking ID"     value={result.booking_id}         mono />
                        <ResultRow label="Receipt object" value={result.receipt.object_id}  mono />
                        <ResultRow label="Transaction"    value={result.receipt.tx_hash}    mono link={`${NETWORK === "mainnet" ? "https://suivision.xyz" : `https://${NETWORK}.suivision.xyz`}/txblock/${result.receipt.tx_hash}`} />
                      </div>
                    </details>
                  )}
                </>
              ) : (
                <Card>
                  <div style={{ textAlign: "center", padding: "0.5rem 0" }}>
                    <div style={{ fontSize: "2.5rem" }}>❌</div>
                    <div style={{ fontWeight: 700, color: "var(--red)", fontSize: "1rem", marginTop: "0.4rem" }}>Booking Failed</div>
                    <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", marginTop: "0.3rem" }}>{result.message}</div>
                  </div>
                  <button onClick={() => window.location.reload()} style={{ ...payBtnStyle, background: "var(--border)", color: "var(--text)" }}>
                    Try Again
                  </button>
                </Card>
              )}
            </div>
          )}

          {/* Privacy footer */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.4rem", fontSize: "0.7rem", color: "var(--text-dim)", opacity: 0.65, padding: "1.5rem 0 0", textAlign: "center" }}>
            🔒 Booking stored on Sui as a commitment hash — no personal data on-chain
          </div>

        </div>
      </div>
    </>
  );
}

// ── Points card ───────────────────────────────────────────────────
function PointsCard({ earned, total, onNavigate }: { earned: number; total: number | null; onNavigate?: () => void }) {
  return (
    <div style={{ background: "linear-gradient(135deg, rgba(57,210,192,0.14) 0%, rgba(57,210,192,0.04) 100%)", border: "1px solid rgba(57,210,192,0.35)", borderRadius: 12, padding: "1rem 1.1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: total !== null ? "0.25rem" : 0 }}>
        <span style={{ fontWeight: 700, fontSize: "1rem", color: "var(--text)" }}>🎁 +{earned} pts earned!</span>
        {total !== null && <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>Total: <strong style={{ color: "var(--text)" }}>{total} pts</strong></span>}
      </div>
      {total !== null && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: "0.75rem" }}>
          ≈ <strong style={{ color: "var(--accent)" }}>${(total / 100).toFixed(2)}</strong> discount value ready to use
        </div>
      )}
      {onNavigate && (
        <button onClick={onNavigate} style={{ width: "100%", padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid rgba(57,210,192,0.4)", background: "rgba(57,210,192,0.1)", color: "var(--accent)", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}>
          View Points &amp; Rewards →
        </button>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "1rem 1.1rem", display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "0.75rem" }}>
      {children}
    </div>
  );
}

function Divider({ label }: { label?: string }) {
  if (!label) return <div style={{ height: 1, background: "var(--border)", margin: "0.1rem 0" }} />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.1rem 0" }}>
      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
      <span style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}

function ResultRow({ label, value, mono, link }: { label: string; value: string; mono?: boolean; link?: string }) {
  const short = value.length > 20 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.78rem" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      {link
        ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontFamily: mono ? "monospace" : "inherit" }}>{short} ↗</a>
        : <span style={{ color: "var(--text)", fontFamily: mono ? "monospace" : "inherit" }}>{short}</span>}
    </div>
  );
}

function AddressDisplay({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  function copy() { navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }
  const short = `${address.slice(0, 8)}...${address.slice(-6)}`;
  return (
    <button onClick={copy} title={address} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
      <span style={{ fontFamily: "monospace", fontSize: "0.85rem", color: copied ? "var(--green)" : "var(--text)" }}>{copied ? "Copied!" : short}</span>
    </button>
  );
}

function Spinner({ size = 14 }: { size?: number }) {
  return <span style={{ display: "inline-block", width: size, height: size, border: `${size > 16 ? 3 : 2}px solid var(--border)`, borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />;
}

function RefreshButton({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [spinning, setSpinning] = useState(false);
  async function handleClick() { if (spinning) return; setSpinning(true); await onRefresh(); setSpinning(false); }
  return (
    <button onClick={handleClick} disabled={spinning} title="Refresh balance" style={{ background: "none", border: "none", padding: 0, cursor: spinning ? "default" : "pointer", color: "var(--text-dim)", lineHeight: 1, display: "flex", alignItems: "center" }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: spinning ? "spin 0.7s linear infinite" : "none" }}>
        <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </button>
  );
}

function FaucetButton({ currency, address, onDone }: { currency: string; address: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function tap() {
    setLoading(true); setErr(null); setDone(false);
    try {
      const endpoint = currency === "SuiUSD" ? "suiusd" : currency.toLowerCase();
      const res = await fetch(`/api/faucet/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, amount: 5 }) });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Faucet error ${res.status}`;
        try { msg = (JSON.parse(text) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
        if (!text) msg = "Server not running — start it with: npm run server";
        throw new Error(msg);
      }
      await onDone(); setDone(true);
      setTimeout(() => setDone(false), 2000);
      setTimeout(() => onDone(), 1500);
      setTimeout(() => onDone(), 3500);
    } catch (e) { setErr(e instanceof Error ? e.message : "Faucet failed"); }
    finally { setLoading(false); }
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: "0.2rem" }}>
      <button onClick={tap} disabled={loading} style={{ fontSize: "0.72rem", color: done ? "#3fb950" : "var(--accent)", background: "none", border: `1px solid ${done ? "#3fb950" : "var(--accent)"}`, borderRadius: 4, padding: "0.1rem 0.4rem", cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1 }}>
        {loading ? "Minting..." : done ? "✓ Minted!" : `Get 5 test ${currency}`}
      </button>
      {err && <span style={{ fontSize: "0.68rem", color: "var(--red)" }}>{err}</span>}
    </span>
  );
}

function ErrorMsg({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "0.8rem", color: "var(--red)", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 8, padding: "0.5rem 0.75rem" }}>
      {children}
    </div>
  );
}

function GoogleIcon() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, background: "#fff", borderRadius: "50%", flexShrink: 0 }}>
      <svg width="12" height="12" viewBox="0 0 48 48">
        <path fill="#4285F4" d="M44.5 20H24v8.5h11.8C34.7 33.9 29.8 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/>
        <path fill="#34A853" d="M6.3 14.7l7 5.1C15 16.1 19.1 13 24 13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 16.3 2 9.7 7.4 6.3 14.7z"/>
        <path fill="#FBBC05" d="M24 46c5.5 0 10.5-1.9 14.3-5l-6.6-5.4C29.8 37.6 27 38.5 24 38.5c-5.8 0-10.7-3.9-12.4-9.2l-7 5.4C8.2 42 15.5 46 24 46z"/>
        <path fill="#EA4335" d="M44.5 20H24v8.5h11.8c-1 2.7-2.8 4.9-5.2 6.5l6.6 5.4c4-3.7 6.3-9.2 6.3-15.4 0-1.3-.2-2.7-.5-4z"/>
      </svg>
    </span>
  );
}

// ── Styles ────────────────────────────────────────────────────────
const centerStyle: React.CSSProperties = { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--bg)", gap: "0.75rem" };
const linkBtnStyle: React.CSSProperties = { background: "none", border: "none", color: "var(--accent)", fontSize: "0.85rem", cursor: "pointer" };
const payBtnStyle: React.CSSProperties = { width: "100%", padding: "1rem", borderRadius: 10, border: "none", background: "var(--accent)", color: "#06090f", fontSize: "0.95rem", fontWeight: 700, cursor: "pointer", marginTop: "0.75rem" };
const googleBtnStyle: React.CSSProperties = { width: "100%", padding: "0.8rem", borderRadius: 10, border: "none", background: "var(--accent)", color: "#06090f", fontSize: "0.9rem", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" };
const slushBtnStyle: React.CSSProperties = { width: "100%", padding: "0.8rem", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: "0.9rem", cursor: "pointer", marginTop: "0.25rem" };
