import { useState, useEffect } from "react";

const NETWORK = (import.meta.env.VITE_SUI_NETWORK as string) || "testnet";
const PASSES_KEY = "sui_booking_passes";
const MAX_PASSES = 50;

export interface BookingPassData {
  bookingId: string;
  merchantName: string;
  date: string;
  time: string;
  objectId?: string;
  txHash?: string;
  savedAt: number;
  usedAt?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────
function todayISO() { return new Date().toISOString().split("T")[0]; }

function suivisionBase() {
  return NETWORK === "mainnet" ? "https://suivision.xyz" : `https://${NETWORK}.suivision.xyz`;
}
function explorerObjectUrl(id: string) { return `${suivisionBase()}/object/${id}`; }

// ── Storage ───────────────────────────────────────────────────────────
export function saveBookingPass(data: Omit<BookingPassData, "savedAt" | "usedAt">) {
  const all = _loadRaw();
  const deduped = all.filter((p) => p.bookingId !== data.bookingId);
  localStorage.setItem(PASSES_KEY, JSON.stringify([{ ...data, savedAt: Date.now() }, ...deduped].slice(0, MAX_PASSES)));
}

export function markPassAsUsed(bookingId: string) {
  localStorage.setItem(PASSES_KEY, JSON.stringify(
    _loadRaw().map((p) => p.bookingId === bookingId ? { ...p, usedAt: Date.now() } : p)
  ));
}

function _loadRaw(): BookingPassData[] {
  try { return JSON.parse(localStorage.getItem(PASSES_KEY) ?? "[]") as BookingPassData[]; }
  catch { return []; }
}

// ── Bucketing ─────────────────────────────────────────────────────────
// "expired" = past date, never marked used — shown in Used tab with amber style
export type PassBucket = "today" | "upcoming" | "used";
type InternalBucket = PassBucket | "expired";

function internalBucket(p: BookingPassData): InternalBucket {
  if (p.usedAt) return "used";
  const today = todayISO();
  if (p.date === today) return "today";
  if (p.date > today) return "upcoming";
  return "expired";
}

export function loadPassesByBucket(bucket: PassBucket): BookingPassData[] {
  // "used" tab shows both manually-used and expired, expired first so user notices them
  const filter = (p: BookingPassData) =>
    bucket === "used" ? (internalBucket(p) === "used" || internalBucket(p) === "expired") : internalBucket(p) === bucket;

  return _loadRaw().filter(filter).sort((a, b) => {
    if (bucket === "today")    return a.time.localeCompare(b.time);
    if (bucket === "upcoming") return a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date);
    // used tab: expired first (by date desc), then used (by usedAt desc)
    const ia = internalBucket(a), ib = internalBucket(b);
    if (ia === "expired" && ib !== "expired") return -1;
    if (ia !== "expired" && ib === "expired") return 1;
    return (b.usedAt ?? 0) - (a.usedAt ?? 0);
  });
}

export function loadPassCounts(): Record<PassBucket, number> {
  const all = _loadRaw();
  const count = (b: InternalBucket) => all.filter((p) => internalBucket(p) === b).length;
  return {
    today: count("today"),
    upcoming: count("upcoming"),
    used: count("used") + count("expired"),   // badge on Used tab = used + expired
  };
}

// kept for Payment.tsx compatibility
export function loadAllBookingPasses(): BookingPassData[] {
  return [...loadPassesByBucket("today"), ...loadPassesByBucket("upcoming")];
}

// ── Card variant ──────────────────────────────────────────────────────
// "active"  → Today / Upcoming: show Show-QR toggle + Mark-as-used with confirmation
// "used"    → manually marked: show "✓ Used" badge, Show-QR only
// "expired" → missed booking: show "⏰ Expired" badge, Show-QR only

function resolveVariant(p: BookingPassData): "active" | "used" | "expired" {
  const b = internalBucket(p);
  if (b === "used") return "used";
  if (b === "expired") return "expired";
  return "active";
}

export function RestaurantPassCard({
  bookingId, merchantName, date, time, objectId, txHash, usedAt,
  expanded, onToggleQR, onMarkUsed,
}: Omit<BookingPassData, "savedAt"> & {
  expanded: boolean;
  onToggleQR: () => void;
  onMarkUsed: () => void;
}) {
  const variant = resolveVariant({ bookingId, merchantName, date, time, objectId, txHash, savedAt: 0, usedAt });
  const qrData  = objectId ? explorerObjectUrl(objectId) : bookingId;
  const qrUrl   = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrData)}&bgcolor=ffffff&color=000000&margin=8`;

  // ── Inline confirmation state ────────────────────────────────────
  const [confirming, setConfirming] = useState(false);
  const [hoverMark,  setHoverMark]  = useState(false);
  const [hoverConfirm, setHoverConfirm] = useState(false);
  const [hoverCancel,  setHoverCancel]  = useState(false);

  // Auto-cancel confirmation after 5 s to prevent accidental lingering
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  // ── Visual config by variant ─────────────────────────────────────
  const borderColor =
    variant === "active"   ? "var(--accent)"  :
    variant === "expired"  ? "#d29922"         : "var(--border)";
  const headerBg =
    variant === "active"   ? "var(--accent)"  :
    variant === "expired"  ? "#d2992220"       : "var(--bg)";
  const headerText =
    variant === "active"   ? "#06090f"        : "var(--text-dim)";
  const headerLabel =
    variant === "active"   ? "🎟 Show at restaurant" :
    variant === "expired"  ? "⏰ Expired — booking missed" :
    `✓ Used · ${usedAt ? new Date(usedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}`;

  return (
    <div style={{ border: `1.5px solid ${borderColor}`, borderRadius: 14, overflow: "hidden", opacity: variant === "used" ? 0.65 : 1, transition: "opacity 0.2s" }}>

      {/* Header */}
      <div style={{ background: headerBg, padding: "0.45rem 0.85rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.75rem", fontWeight: 700, color: headerText }}>{headerLabel}</span>
        {objectId && (
          <a href={explorerObjectUrl(objectId)} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: "0.63rem", fontWeight: 600, color: headerText, textDecoration: "none", opacity: 0.7 }}>
            View NFT ↗
          </a>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: "0.8rem 0.9rem", background: "var(--card)", display: "flex", flexDirection: "column", gap: "0.28rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.92rem" }}>{merchantName}</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>{date} · {time}</div>
        {objectId ? (
          <>
            <div style={{ fontSize: "0.59rem", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: "0.1rem" }}>NFT Receipt</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.67rem", fontWeight: 700, color: "var(--accent)", wordBreak: "break-all", lineHeight: 1.4 }}>{objectId}</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: "0.59rem", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: "0.1rem" }}>Booking reference</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.71rem", fontWeight: 700, color: "var(--accent)", wordBreak: "break-all", lineHeight: 1.4 }}>{bookingId}</div>
          </>
        )}
        {txHash && (
          <a href={`${suivisionBase()}/txblock/${txHash}`} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: "0.61rem", color: "var(--text-dim)", textDecoration: "none", marginTop: "0.04rem" }}>
            Tx: {txHash.slice(0, 8)}…{txHash.slice(-6)} ↗
          </a>
        )}
      </div>

      {/* QR panel */}
      {expanded && (
        <div style={{ padding: "0.75rem", background: "var(--bg)", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
          <img src={qrUrl} alt="Booking QR" width={160} height={160} style={{ borderRadius: 8, background: "#fff", border: "1px solid var(--border)" }} />
          <div style={{ fontSize: "0.61rem", color: "var(--text-dim)", textAlign: "center", lineHeight: 1.5 }}>
            {objectId ? "Scan to verify NFT on SuiVision" : "Scan or show booking reference to staff"}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", borderTop: "1px solid var(--border)", background: "var(--card)" }}>
        {/* Show/Hide QR — always available */}
        <button
          onClick={onToggleQR}
          style={{ flex: 1, padding: "0.55rem", fontSize: "0.77rem", fontWeight: 600, color: "var(--accent)", background: "none", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", transition: "background 0.15s" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(57,210,192,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        >
          {expanded ? "Hide QR ▲" : "Show QR ▼"}
        </button>

        {/* Mark as used — only for active passes; shows inline confirmation */}
        {variant === "active" && !confirming && (
          <button
            onClick={() => setConfirming(true)}
            onMouseEnter={(e) => { setHoverMark(true);  e.currentTarget.style.background = "rgba(220,53,69,0.08)";  e.currentTarget.style.color = "#dc3545"; }}
            onMouseLeave={(e) => { setHoverMark(false); e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
            style={{ flex: 1, padding: "0.55rem", fontSize: "0.77rem", fontWeight: hoverMark ? 700 : 400, color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer", transition: "background 0.15s, color 0.15s, font-weight 0.1s" }}
          >
            ✓ Mark as used
          </button>
        )}

        {/* Inline confirmation split */}
        {variant === "active" && confirming && (
          <>
            <button
              onClick={() => setConfirming(false)}
              onMouseEnter={(e) => { setHoverCancel(true);  e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={(e) => { setHoverCancel(false); e.currentTarget.style.background = "none"; }}
              style={{ flex: 1, padding: "0.55rem", fontSize: "0.75rem", fontWeight: hoverCancel ? 600 : 400, color: "var(--text-dim)", background: "none", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", transition: "background 0.12s" }}
            >
              Cancel
            </button>
            <button
              onClick={() => { setConfirming(false); onMarkUsed(); }}
              onMouseEnter={(e) => { setHoverConfirm(true);  e.currentTarget.style.background = "rgba(220,53,69,0.18)"; }}
              onMouseLeave={(e) => { setHoverConfirm(false); e.currentTarget.style.background = "rgba(220,53,69,0.08)"; }}
              style={{ flex: 1, padding: "0.55rem", fontSize: "0.75rem", fontWeight: 700, color: "#dc3545", background: "rgba(220,53,69,0.08)", border: "none", cursor: "pointer", transition: "background 0.12s", animation: "pulse-red 0.25s ease" }}
            >
              {hoverConfirm ? "✓ Confirm" : "⚠ Used?"}
            </button>
          </>
        )}

        {/* Used / Expired — no action, show status chip */}
        {variant !== "active" && (
          <div style={{ flex: 1, padding: "0.55rem", fontSize: "0.73rem", fontWeight: 500, color: "var(--text-dim)", display: "flex", alignItems: "center", justifyContent: "center", userSelect: "none" }}>
            {variant === "expired" ? "⏰ Expired" : "✓ Done"}
          </div>
        )}
      </div>
    </div>
  );
}
