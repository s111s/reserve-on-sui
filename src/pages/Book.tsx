import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

const NETWORK = (import.meta.env.VITE_SUI_NETWORK as string) || "testnet";
const THB_TO_USD = 35; // approximate exchange rate for fee conversion

// ── Known test merchants (for service info lookup) ─────────────────
const MERCHANT_NAMES: Record<number, { name: string; type: string; currency: "USDC" }> = {
  263: { name: "Premium Dining", type: "restaurant", currency: "USDC" },
};

// ── Types ─────────────────────────────────────────────────────────
interface AvailableZone { zone_id: string; zone_name: string; available_seats: number; service_id: number }
interface Slot { start_sec: number; duration_sec: number; available_zones: AvailableZone[] }
interface DaySlots { date: string; slots: Slot[] }
interface Service { id: number; name_en: string; price: string; pricing_model: string; duration: number }
interface ContactForm { display_name: string; email: string; phone: string; special_request: string }
interface ShopDetail {
  shop: { name_en: string; banner: string; logo: string; rating: number; address: string; payment_policy: string; is_michelin_guide: boolean; table_plan?: string }
  service: { name_en: string; duration: number; price: string }
  products: { id: number; name_en: string; type: string; price: string; deposit: string; pricing_model: string; display: string }[]
  tables: { id: string; name: string; seats: number; deposit: string }[]
  total_deposit: string
  total_price: string
}

const EMPTY_CONTACT: ContactForm = { display_name: "", email: "", phone: "", special_request: "" };

// ── Helpers ───────────────────────────────────────────────────────
function formatTime(sec: number) {
  return new Date(sec * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" });
}
function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function todayISO() { return new Date().toISOString().split("T")[0]; }
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().split("T")[0];
}

// ── Slot picker ───────────────────────────────────────────────────
function SlotPicker({ shopId, serviceId, startDate, endDate, onSelect, onTimeSelect }: {
  shopId: number; serviceId: number; startDate: string; endDate: string;
  onSelect: (date: string, slot: Slot, zone: AvailableZone) => void;
  onTimeSelect?: (start_sec: number) => void;
}) {
  const [weekStart, setWeekStart] = useState(startDate);
  const [days, setDays] = useState<DaySlots[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [selectedZone, setSelectedZone] = useState<AvailableZone | null>(null);

  const weekEnd = addDays(weekStart, 6);

  useEffect(() => {
    setLoading(true); setError(null); setSelectedDate(null); setSelectedSlot(null); setSelectedZone(null);
    fetch(`/api/aappoint/availability?shop_id=${shopId}&service_id=${serviceId}&start_date=${weekStart}&end_date=${weekEnd}`)
      .then((r) => r.json() as Promise<{ available_slots?: DaySlots[]; code?: string; message?: string }>)
      .then((d) => { if (d.code) throw new Error(d.message ?? d.code); setDays(d.available_slots ?? []); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load slots"))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, shopId, serviceId]);

  const activeDays = days.filter((d) => d.slots.length > 0);
  const selectedDaySlots = days.find((d) => d.date === selectedDate)?.slots ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} disabled={weekStart <= todayISO()} style={navBtn(weekStart <= todayISO())}>← Prev</button>
        <span style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>{weekStart} — {weekEnd}</span>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))} style={navBtn(false)}>Next →</button>
      </div>

      {loading && <p style={{ color: "var(--text-dim)", fontSize: "0.85rem", textAlign: "center" }}>Loading slots…</p>}
      {error   && <p style={{ color: "var(--red)",      fontSize: "0.85rem" }}>⚠ {error}</p>}
      {!loading && !error && activeDays.length === 0 && (
        <p style={{ color: "var(--text-dim)", fontSize: "0.85rem", textAlign: "center" }}>No availability this week.</p>
      )}

      {!loading && activeDays.length > 0 && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {activeDays.map((day) => (
            <button key={day.date} onClick={() => { setSelectedDate(day.date); setSelectedSlot(null); setSelectedZone(null); }} style={{ ...tabBtn(selectedDate === day.date), display: "flex", flexDirection: "column", alignItems: "center", gap: "0.15rem", lineHeight: 1.2 }}>
              <span>{formatDate(day.date)}</span>
              <span style={{ fontSize: "0.65rem", opacity: 0.65, fontWeight: 400 }}>{day.slots.length} times</span>
            </button>
          ))}
        </div>
      )}

      {selectedDate && (
        <>
          <div style={sectionLabel}>Time</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {selectedDaySlots.map((slot) => (
              <button key={slot.start_sec} onClick={() => { setSelectedSlot(slot); setSelectedZone(null); onTimeSelect?.(slot.start_sec); }} style={timeBtn(selectedSlot?.start_sec === slot.start_sec)}>
                {formatTime(slot.start_sec)}
              </button>
            ))}
          </div>
        </>
      )}

      {selectedSlot && selectedSlot.available_zones.length > 0 && (
        <>
          <div style={sectionLabel}>Zone</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {selectedSlot.available_zones.map((z, i) => (
              <button key={`${z.zone_id}-${i}`} onClick={() => { setSelectedZone(z); onSelect(selectedDate!, selectedSlot, z); }}
                style={{ ...timeBtn(selectedZone === z), minWidth: 80 }}>
                <span style={{ fontWeight: 600 }}>{z.zone_name}</span>
                <span style={{ fontSize: "0.65rem", opacity: 0.6, marginLeft: "0.3rem" }}>{z.available_seats} seats</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Manual date/time picker (no availability API) ─────────────────
function ManualPicker({ onSelect }: { onSelect: (date: string, time: string) => void }) {
  const [date, setDate] = useState(addDays(todayISO(), 1));
  const [time, setTime] = useState("12:00");
  return (
    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
      <label style={labelStyle}>Date<input type="date" value={date} min={addDays(todayISO(), 1)} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></label>
      <label style={labelStyle}>Time<input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle} /></label>
      <button onClick={() => onSelect(date, time)} style={accentBtn}>Choose slot</button>
    </div>
  );
}

// ── Shop header (banner + logo + name) ───────────────────────────
function ShopHeader({ detail }: { detail: ShopDetail | null }) {
  if (!detail) return null;
  const { shop } = detail;
  return (
    <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)", marginBottom: "1rem" }}>
      {/* Banner */}
      <div style={{ position: "relative", height: 140 }}>
        <img src={shop.banner} alt={shop.name_en} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 30%, rgba(0,0,0,0.65))" }} />
        <div style={{ position: "absolute", bottom: 10, left: 12, display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <img src={shop.logo} alt="" style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover", border: "2px solid rgba(255,255,255,0.3)" }} />
          <div>
            <div style={{ fontWeight: 700, color: "#fff", fontSize: "0.95rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
              {shop.name_en}
              {shop.is_michelin_guide && <span title="Michelin Guide" style={{ fontSize: "0.85rem" }}>⭐</span>}
            </div>
            <div style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.75)" }}>{shop.address}</div>
          </div>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.2rem", fontSize: "0.78rem", color: "#f5c842", fontWeight: 700 }}><span>★</span><span>{shop.rating}</span></span>
        </div>
      </div>
      {/* Service info strip */}
      <div style={{ background: "var(--card)", padding: "0.55rem 1rem", display: "flex", gap: "1.25rem", fontSize: "0.78rem", color: "var(--text-dim)", flexWrap: "wrap" }}>
        <span>🍽 {detail.service.name_en}</span>
        <span>⏱ {detail.service.duration / 3600}h</span>
        {(() => { const ph = (detail.products ?? []).filter((p) => p.type === "mandatory").reduce((s, p) => s + (Number(p.deposit) || 0), 0); return ph > 0 ? <span style={{ color: "var(--accent)", fontWeight: 600 }}>฿{ph.toLocaleString()} / head</span> : null; })()}
      </div>
      {/* Table plan */}
      {shop.table_plan ? (
        <div style={{ background: "var(--bg)", borderTop: "1px solid var(--border)", padding: "0.65rem 1rem" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.45rem" }}>Table Map</div>
          <img src={shop.table_plan} alt="Table map"
            style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)", objectFit: "contain", maxHeight: 240 }}
            onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }} />
        </div>
      ) : (
        <div style={{ background: "var(--bg)", borderTop: "1px solid var(--border)", padding: "0.55rem 1rem", fontSize: "0.75rem", color: "var(--text-dim)" }}>
          No table map provided for this venue.
        </div>
      )}
    </div>
  );
}

// ── Contact form ──────────────────────────────────────────────────
function ContactFields({ value, onChange, errors }: { value: ContactForm; onChange: (v: ContactForm) => void; errors?: Partial<Record<keyof ContactForm, string>> }) {
  function set(f: keyof ContactForm) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [f]: e.target.value });
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      {/* Privacy notice */}
      <div style={{ background: "#4a90e210", border: "1px solid #4a90e230", borderRadius: 8, padding: "0.65rem 0.85rem", fontSize: "0.78rem", color: "var(--text-dim)", lineHeight: 1.6 }}>
        🔒 You can use a non-primary email or phone number to keep your real identity private.
      </div>

      <label style={labelStyle}>
        <span>What should we call you? <Req /></span>
        <input placeholder="e.g. Alex, or any name you prefer" value={value.display_name} onChange={set("display_name")}
          style={{ ...inputStyle, borderColor: errors?.display_name ? "var(--red)" : undefined }} />
        {errors?.display_name && <span style={{ fontSize: "0.72rem", color: "var(--red)" }}>{errors.display_name}</span>}
      </label>

      <label style={labelStyle}>
        <span>Email for confirmation <Req /></span>
        <input type="email" placeholder="Any email you're comfortable sharing" value={value.email} onChange={set("email")}
          style={{ ...inputStyle, borderColor: errors?.email ? "var(--red)" : undefined }} />
        {errors?.email
          ? <span style={{ fontSize: "0.72rem", color: "var(--red)" }}>{errors.email}</span>
          : <span style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>A burner or alias email works fine.</span>}
      </label>

      <label style={labelStyle}>
        <span>Phone for notification <Req /></span>
        <input type="tel" placeholder="e.g. +1 234 567 8900" value={value.phone} onChange={set("phone")}
          style={{ ...inputStyle, borderColor: errors?.phone ? "var(--red)" : undefined }} />
        {errors?.phone && <span style={{ fontSize: "0.72rem", color: "var(--red)" }}>{errors.phone}</span>}
      </label>

      <label style={labelStyle}>
        <span>Special requests <Opt /></span>
        <textarea placeholder="Please enter any special requests (note that these cannot be guaranteed)"
          value={value.special_request} onChange={set("special_request")} rows={3}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
      </label>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────
export default function BookPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const shopIdParam  = Number(searchParams.get("shop_id"))    || null;
  const svcIdParam   = Number(searchParams.get("service_id")) || null;
  const startDate    = searchParams.get("start_date") || todayISO();
  const endDate      = searchParams.get("end_date")   || addDays(todayISO(), 7);

  const merchant = shopIdParam ? (MERCHANT_NAMES[shopIdParam] ?? { name: `Shop ${shopIdParam}`, type: "restaurant", currency: "USDC" as const }) : null;
  const hasAvailability = true;

  const [slot, setSlot]         = useState<{ date: string; time: string; zone?: AvailableZone; start_sec?: number; duration_sec?: number } | null>(null);
  const [pendingStartSec, setPendingStartSec] = useState<number | null>(null);
  const [shopDetail, setShopDetail] = useState<ShopDetail | null>(null);
  const [partySize, setPartySize]   = useState(2);
  const [contact, setContact]   = useState<ContactForm>(EMPTY_CONTACT);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ContactForm, string>>>({});

  // Fetch shop detail as soon as a time slot is clicked (before zone selection) so table map is visible
  useEffect(() => {
    if (!pendingStartSec || !shopIdParam || !svcIdParam) return;
    setShopDetail(null);
    const qs = new URLSearchParams({ shop_id: String(shopIdParam), service_id: String(svcIdParam), start_sec: String(pendingStartSec), party_size: String(partySize) });
    fetch(`/api/aappoint/shop-detail?${qs}`)
      .then((r) => r.json() as Promise<ShopDetail & { code?: string }>)
      .then((d) => { if (!d.code) setShopDetail(d); })
      .catch(() => {/* non-critical */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStartSec, shopIdParam, svcIdParam, partySize]);

  // Redirect to /mock if no shop_id in URL
  useEffect(() => {
    if (!shopIdParam || !svcIdParam) navigate("/mock", { replace: true });
  }, [shopIdParam, svcIdParam, navigate]);

  if (!shopIdParam || !svcIdParam || !merchant) return null;

  const m = merchant; // non-null after guard above
  const maxSeats = slot?.zone?.available_seats ?? 10;

  // Per-head deposit from mandatory products; multiply by party size for total
  const depositPerHeadTHB = shopDetail
    ? (shopDetail.products ?? []).filter((p) => p.type === "mandatory").reduce((s, p) => s + (Number(p.deposit) || 0), 0)
    : 0;
  const depositTHB = depositPerHeadTHB * partySize;
  const feeUSD = depositTHB > 0 ? Math.round((depositTHB / THB_TO_USD) * 100) / 100 : 0;
  const hasFee = feeUSD > 0;

  async function handleReserve() {
    if (!slot || !slot.start_sec) return;
    setSubmitError(null);

    // Validate required fields
    const errs: Partial<Record<keyof ContactForm, string>> = {};
    if (!contact.display_name.trim()) errs.display_name = "Please enter a name so the restaurant knows who to expect.";
    if (!contact.email.trim())        errs.email        = "Email is required for booking confirmation.";
    if (!contact.phone.trim())        errs.phone        = "Phone number is required for booking notification.";
    if (Object.keys(errs).length > 0) { setFieldErrors(errs); return; }
    setFieldErrors({});
    setSubmitting(true);

    // Split display_name into first/last for Aappoint checkout
    const nameParts = contact.display_name.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(" ") || "-";

    // Mandatory products from shop detail
    const mandatoryProducts = (shopDetail?.products ?? [])
      .filter((p) => p.type === "mandatory")
      .map((p) => ({ shop_product_id: p.id, amount: 1 }));

    try {
      // Step 1: Confirm slot is still in the availability feed before holding it
      const availRes = await fetch(
        `/api/aappoint/availability?shop_id=${shopIdParam}&service_id=${svcIdParam}&start_date=${slot.date}&end_date=${slot.date}`
      ).then((r) => r.json() as Promise<{ available_slots?: DaySlots[]; code?: string }>);
      const stillAvailable = availRes.available_slots
        ?.find((d) => d.date === slot.date)
        ?.slots.some((s) => s.start_sec === slot.start_sec);
      if (!stillAvailable) {
        throw new Error("This slot is no longer available — please pick another time.");
      }

      // Step 2: Hold the slot via Aappoint checkout
      const checkoutRes = await fetch("/api/aappoint/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: shopIdParam,
          service_id: svcIdParam,
          start_sec: slot.start_sec,
          duration_sec: slot.duration_sec,
          party_size: partySize,
          first_name: firstName,
          last_name: lastName,
          email: contact.email.trim(),
          phone: contact.phone.trim(),
          note: contact.special_request.trim(),
          zone: slot.zone?.zone_id,
          payment_method: "web3",
          result_url: `${window.location.origin}/payment`,
          accept_late_time: true,
          accept_no_refund: true,
          accept_news: false,
          accept_notification: !!(contact.email.trim() || contact.phone.trim()),
          selected_products: mandatoryProducts,
        }),
      });
      const checkout = await checkoutRes.json() as {
        event?: { id: number; status: string };
        purchase_order?: { id: number; status: string; deposit_grand_total: string };
        error?: string; code?: string; message?: string;
      };
      if (!checkoutRes.ok || checkout.error || checkout.code) {
        throw new Error(checkout.message ?? checkout.error ?? "Checkout failed");
      }
      const eventId = checkout.event?.id;
      const orderId = checkout.purchase_order?.id;

      // Step 2: Create our internal reservation token (for payment page)
      const res = await fetch("/api/reservation/incoming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: shopIdParam,
          event_id: eventId,
          order_no: orderId ? String(orderId) : undefined,
          merchant_name: shopDetail?.shop.name_en ?? m.name,
          merchant_type: m.type,
          merchant_image: shopDetail?.shop.banner,
          merchant_address: shopDetail?.shop.address,
          merchant_rating: shopDetail?.shop.rating,
          date: slot.date,
          time: slot.time,
          party_size: partySize,
          fee_amount: feeUSD,
          fee_currency: m.currency,
          fee_label: hasFee ? `Dining reservation fee (฿${depositTHB} ≈ $${feeUSD.toFixed(2)})` : "",
          fee_refundable: false,
          zone_id: slot.zone?.zone_id,
          zone_name: slot.zone?.zone_name,
          contact: {
            first_name: firstName,
            last_name: lastName,
            email: contact.email.trim() || undefined,
            phone: contact.phone.trim() || undefined,
            special_request: contact.special_request.trim() || undefined,
          },
        }),
      });
      const data = await res.json() as { ok: boolean; payment_url: string; error?: string };
      if (!data.ok) throw new Error(data.error ?? "Failed to create reservation");
      const url = new URL(data.payment_url);
      navigate(`/payment${url.search}`);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Failed to create reservation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font)", padding: "1.5rem 1rem" }}>
      {NETWORK !== "mainnet" && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000, background: "#d2992218", borderBottom: "1px solid #d2992240", padding: "0.3rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#d29922", display: "inline-block" }} />
          <span style={{ fontSize: "0.72rem", color: "#d29922", fontWeight: 600 }}>Testnet Beta — Sui {NETWORK}. Tokens have no real value.</span>
        </div>
      )}

      <div style={{ maxWidth: 560, margin: "0 auto", paddingTop: NETWORK !== "mainnet" ? "2.5rem" : 0 }}>
        {/* Header */}
        <div style={{ marginBottom: "1.25rem" }}>
          <button onClick={() => navigate("/mock")} style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: "0.8rem", cursor: "pointer", padding: 0, marginBottom: "0.75rem" }}>← Back</button>
          <h1 style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0 0 0.2rem" }}>{m.name}</h1>
          <p style={{ color: "var(--text-dim)", fontSize: "0.82rem", margin: 0 }}>Reserve with Privacy · Sui {NETWORK}</p>
        </div>

        <ShopHeader detail={shopDetail} />

        {/* Step 1: Date / Time / Zone */}
        <Section label="1. Choose date, time &amp; zone">
          {hasAvailability
            ? <SlotPicker shopId={shopIdParam} serviceId={svcIdParam} startDate={startDate} endDate={endDate}
                onTimeSelect={(start_sec) => { setPendingStartSec(start_sec); setSlot(null); }}
                onSelect={(date, s, zone) => { setSlot({ date, time: formatTime(s.start_sec), zone, start_sec: s.start_sec, duration_sec: s.duration_sec }); }} />
            : <ManualPicker onSelect={(date, time) => setSlot({ date, time })} />}
        </Section>

        {/* Step 2: Party size */}
        {slot && (
          <Section label="2. Number of guests">
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {Array.from({ length: Math.min(maxSeats, 10) }, (_, i) => i + 1).map((n) => (
                <button key={n} onClick={() => setPartySize(n)} style={tabBtn(partySize === n)}>{n}</button>
              ))}
            </div>
          </Section>
        )}

        {/* Step 3: Contact */}
        {slot && (
          <Section label="3. Contact">
            <ContactFields value={contact} onChange={(v) => { setContact(v); setFieldErrors({}); }} errors={fieldErrors} />
          </Section>
        )}

        {/* Summary + reserve */}
        {slot && (
          <>
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "0.85rem 1rem", marginBottom: "1rem", display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.83rem" }}>
              <Row label="Date"   value={slot.date} />
              <Row label="Time"   value={slot.time} />
              {slot.zone && <Row label="Zone"  value={`${slot.zone.zone_name} (${slot.zone.zone_id})`} />}
              <Row label="Guests" value={String(partySize)} />
              <Row label="Reservation deposit" value={hasFee ? `$${feeUSD.toFixed(2)} USD (฿${depositPerHeadTHB.toLocaleString()}/head × ${partySize})` : shopDetail ? "Free" : "Loading…"} />
            </div>

            {submitError && <p style={{ color: "var(--red)", fontSize: "0.82rem", marginBottom: "0.75rem" }}>⚠ {submitError}</p>}

            <button onClick={handleReserve} disabled={submitting}
              style={{ width: "100%", padding: "0.9rem", borderRadius: 10, border: "none", background: submitting ? "var(--border)" : "var(--accent)", color: "#fff", fontWeight: 700, fontSize: "0.95rem", cursor: submitting ? "not-allowed" : "pointer", marginBottom: "0.5rem" }}>
              {submitting ? "Creating reservation…" : "🔒 Reserve with Privacy →"}
            </button>
            <p style={{ fontSize: "0.72rem", color: "var(--text-dim)", textAlign: "center", lineHeight: 1.5, margin: 0 }}>
              Your booking is stored on Sui as a commitment hash — no name, email, or merchant ID on-chain.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: "1.25rem", marginBottom: "0.25rem" }}>
      <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>{label}</div>
      {children}
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
function Opt() {
  return <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontStyle: "italic", fontWeight: 400, marginLeft: "0.25rem" }}>(optional)</span>;
}
function Req() {
  return <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontStyle: "italic", fontWeight: 400, marginLeft: "0.25rem" }}>(required)</span>;
}

// ── Styles ────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = { padding: "0.45rem 0.75rem", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", fontSize: "0.85rem", width: "100%", boxSizing: "border-box" };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.82rem", color: "var(--text-dim)", flex: 1 };
const accentBtn: React.CSSProperties = { padding: "0.5rem 1.2rem", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: "0.85rem" };
const sectionLabel: React.CSSProperties = { fontSize: "0.72rem", color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em" };
function navBtn(disabled: boolean): React.CSSProperties { return { padding: "0.3rem 0.7rem", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: disabled ? "var(--text-dim)" : "var(--text)", fontSize: "0.8rem", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }; }
function tabBtn(active: boolean): React.CSSProperties { return { padding: "0.4rem 0.85rem", borderRadius: 8, border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`, background: active ? "var(--accent)" : "transparent", color: active ? "#fff" : "var(--text)", fontSize: "0.8rem", fontWeight: active ? 700 : 400, cursor: "pointer" }; }
function timeBtn(active: boolean): React.CSSProperties { return { padding: "0.45rem 0.9rem", borderRadius: 8, border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`, background: active ? "#4a90e222" : "var(--card)", color: active ? "var(--accent)" : "var(--text)", fontSize: "0.82rem", fontWeight: active ? 700 : 400, cursor: "pointer" }; }
