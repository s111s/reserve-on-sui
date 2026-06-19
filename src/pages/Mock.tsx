import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

const NETWORK = (import.meta.env.VITE_SUI_NETWORK as string) || "testnet";
const NETWORK_COLOR: Record<string, string> = { mainnet: "#f85149", testnet: "#d29922", devnet: "#3fb950" };
const THB_TO_USD = 35;

interface ShopMeta { name: string; banner: string | null; logo: string | null; rating: number; address: string; depositTHB: number }

const EXPERIENCES = [
  // { shop_id: 182, service_id: 338, fallback: { name: "Free Dining Experience", description: "Try our privacy-first reservation — no payment required.", banner: null, logo: null, rating: 0, address: "" }, emoji: "🍽️", fee: null, tags: ["Free", "Instant confirm"] },
  {
    shop_id: 194, service_id: 347,
    fallback: { name: "Premium Dining", description: "Reserve a table with a stablecoin deposit on Sui.", banner: null, logo: null, rating: 5, address: "" },
    emoji: "🥂", fee: "5 USDC", tags: ["Paid", "On-chain receipt"],
  },
];

function addDays(n: number): string {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split("T")[0];
}

export default function MockPage() {
  const navigate = useNavigate();
  const color = NETWORK_COLOR[NETWORK] ?? "#d29922";
  const [shopMeta, setShopMeta] = useState<Record<number, ShopMeta>>({});

  // Two-step fetch: availability → real start_sec → shop-detail (so total_deposit is computed for a real slot)
  useEffect(() => {
    EXPERIENCES.forEach(async (exp) => {
      try {
        const today = new Date().toISOString().split("T")[0];
        const nextWeek = addDays(7);

        // Step 1: get any real available slot's start_sec
        const avail = await fetch(`/api/aappoint/availability?shop_id=${exp.shop_id}&service_id=${exp.service_id}&start_date=${today}&end_date=${nextWeek}`)
          .then((r) => r.json() as Promise<{ available_slots?: { date: string; slots: { start_sec: number }[] }[]; code?: string }>);

        let startSec = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
        if (!avail.code && avail.available_slots) {
          for (const day of avail.available_slots) {
            if (day.slots.length > 0) { startSec = day.slots[0].start_sec; break; }
          }
        }

        // Step 2: shop-detail with the real slot's start_sec so total_deposit is accurate
        const detail = await fetch(`/api/aappoint/shop-detail?shop_id=${exp.shop_id}&service_id=${exp.service_id}&start_sec=${startSec}`)
          .then((r) => r.json() as Promise<{ shop?: { name_en: string; banner: string; logo: string; rating: number; address: string }; products?: { type: string; deposit: string }[]; code?: string }>);
        if (detail.code || !detail.shop) return;
        const depositPerHead = (detail.products ?? [])
          .filter((p) => p.type === "mandatory")
          .reduce((sum, p) => sum + (Number(p.deposit) || 0), 0);
        setShopMeta((prev) => ({
          ...prev,
          [exp.shop_id]: { name: detail.shop!.name_en, banner: detail.shop!.banner, logo: detail.shop!.logo, rating: detail.shop!.rating, address: detail.shop!.address, depositTHB: depositPerHead },
        }));
      } catch { /* fallback to hardcoded */ }
    });
  }, []);

  function goToBook(exp: typeof EXPERIENCES[number]) {
    const params = new URLSearchParams({
      shop_id: String(exp.shop_id),
      service_id: String(exp.service_id),
      start_date: addDays(0),
      end_date: addDays(7),
    });
    navigate(`/book?${params}`);
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font)", padding: "1.5rem 1rem" }}>
      {NETWORK !== "mainnet" && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000, background: `${color}18`, borderBottom: `1px solid ${color}40`, padding: "0.3rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block" }} />
          <span style={{ fontSize: "0.72rem", color, fontWeight: 600 }}>
            Testnet Beta — Sui {NETWORK}. Tokens have no real value.
          </span>
        </div>
      )}

      <div style={{ maxWidth: 480, margin: "0 auto", paddingTop: "3.5rem" }}>
        {/* Header — simulates "Reserve" button entry from Google Maps */}
        <div style={{ marginBottom: "2rem", textAlign: "center" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.5rem" }}>
            Demo — simulates Google Maps "Reserve" entry
          </div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, margin: "0 0 0.4rem" }}>Choose an Experience</h1>
          <p style={{ color: "var(--text-dim)", fontSize: "0.85rem", margin: 0, lineHeight: 1.6 }}>
            Select a service to book with on-chain privacy via Sui.
          </p>
        </div>

        {/* Google Maps Production Test Store CTA */}
        <a
          href="https://maps.app.goo.gl/mBRfwLzthj4HbvSL6"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem",
            borderRadius: 12, padding: "0.85rem 1rem", marginBottom: "1.5rem",
            background: "rgba(66,133,244,0.1)", border: "1px solid rgba(66,133,244,0.35)",
            textDecoration: "none", color: "var(--text)", transition: "border-color 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(66,133,244,0.7)")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(66,133,244,0.35)")}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0 }}>
            <span style={{ fontSize: "1.15rem", flexShrink: 0 }}>📍</span>
            <div>
              <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#4285F4" }}>Live on Google Maps</div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", lineHeight: 1.4 }}>
                Try it live on a Google Maps Platform Production Test Store
              </div>
            </div>
          </div>
          <span style={{
            flexShrink: 0, fontSize: "0.75rem", fontWeight: 700, color: "#fff",
            background: "#4285F4", borderRadius: 7, padding: "0.3rem 0.7rem", whiteSpace: "nowrap",
          }}>Open Maps →</span>
        </a>

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {EXPERIENCES.map((exp) => {
            const meta = shopMeta[exp.shop_id];
            const name = meta?.name ?? exp.fallback.name;
            const banner = meta?.banner ?? exp.fallback.banner;
            const logo = meta?.logo ?? exp.fallback.logo;
            const rating = meta?.rating ?? exp.fallback.rating;
            const address = meta?.address ?? exp.fallback.address;
            const depositTHB = meta?.depositTHB ?? 0;
            const feeUSD = depositTHB > 0 ? Math.round((depositTHB / THB_TO_USD) * 100) / 100 : 0;
            const feeLabel = meta
              ? (feeUSD > 0 ? `$${feeUSD.toFixed(2)} (฿${depositTHB.toLocaleString()}) / seat` : "Free")
              : (exp.fee ?? "—");

            return (
              <button
                key={exp.shop_id}
                onClick={() => goToBook(exp)}
                style={{
                  display: "flex", flexDirection: "column", gap: 0,
                  borderRadius: 14, textAlign: "left", overflow: "hidden",
                  border: "1px solid var(--border)", background: "var(--card)",
                  cursor: "pointer", color: "var(--text)", width: "100%",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              >
                {/* Banner */}
                {banner ? (
                  <div style={{ width: "100%", height: 120, overflow: "hidden", position: "relative" }}>
                    <img src={banner} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 40%, rgba(0,0,0,0.55))" }} />
                    <span style={{ position: "absolute", top: 10, right: 10, fontWeight: 700, color: "#fff", fontSize: "0.85rem", background: feeUSD > 0 ? "rgba(74,144,226,0.85)" : "rgba(46,204,113,0.85)", borderRadius: 8, padding: "0.2rem 0.65rem", backdropFilter: "blur(4px)" }}>{feeLabel}</span>
                  </div>
                ) : (
                  <div style={{ width: "100%", height: 72, background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "2.2rem" }}>{exp.emoji}</div>
                )}

                {/* Info */}
                <div style={{ padding: "0.9rem 1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    {logo && <img src={logo} alt="" style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)" }} />}
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "0.97rem" }}>{name}</div>
                      {address && <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "0.05rem" }}>{address}</div>}
                    </div>
                    {rating > 0 && (
                      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.2rem", fontSize: "0.78rem", color: "#f5c842", fontWeight: 700 }}><span>★</span><span>{rating}</span></span>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    {exp.tags.map((tag) => (
                      <span key={tag} style={{ fontSize: "0.68rem", fontWeight: 600, padding: "0.18rem 0.5rem", borderRadius: 5, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-dim)" }}>{tag}</span>
                    ))}
                    <span style={{ fontSize: "0.68rem", fontWeight: 600, padding: "0.18rem 0.5rem", borderRadius: 5, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-dim)" }}>🔒 Privacy-first</span>
                  </div>

                  <div style={{ fontSize: "0.78rem", color: "var(--accent)", fontWeight: 600 }}>Reserve with Privacy →</div>
                </div>
              </button>
            );
          })}
        </div>

        <p style={{ textAlign: "center", fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "1.75rem", lineHeight: 1.6 }}>
          In production, users arrive here from the Google Maps "Reserve" button.<br />
          shop_id &amp; service_id are passed from the merchant listing.
        </p>
      </div>
    </div>
  );
}
