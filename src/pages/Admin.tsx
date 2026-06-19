import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

// ── Shared types ──────────────────────────────────────────────────────────────
const TIERS = [
  { level: 1, name: "Quartz",        color: "#b0aec8", icon: "◇" },
  { level: 2, name: "Sapphire",      color: "#4a90e2", icon: "⬡" },
  { level: 3, name: "Emerald",       color: "#2ecc71", icon: "✦" },
  { level: 4, name: "Black Diamond", color: "#d4a843", icon: "◆" },
] as const;
const TIER_COLOR: Record<number, string> = { 1: "#b0aec8", 2: "#4a90e2", 3: "#2ecc71", 4: "#d4a843" };
const TIER_ICON: Record<number, string>  = { 1: "◇", 2: "⬡", 3: "✦", 4: "◆" };
const CATEGORIES = ["food", "drink", "experience", "special"] as const;
const RESTAURANT_TYPES = ["restaurant", "bar", "spa", "hotel", "cafe", "activity", "any"] as const;

interface Reward {
  id: string; name: string; description: string; restaurant: string; restaurant_type: string;
  image: string; points_cost: number; required_tier: 1|2|3|4;
  category: "food"|"drink"|"experience"|"special"; active: boolean; is_base: boolean; created_at: string;
}
interface PointsConfig {
  points_per_dollar_nonrefundable: number;
  points_per_free_booking: number;
  refundable_earns_points: boolean;
  points_per_dollar_refundable: number;
}
interface Invitation { address: string; tier: number; tier_name: string; note: string; tx_hash: string; granted_at: string }

function shortAddr(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontWeight: 600, display: "block", marginBottom: "0.3rem" }}>{children}</label>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column" }}><Label>{label}</Label>{children}</div>;
}
const inputStyle: React.CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
  padding: "0.55rem 0.75rem", color: "var(--text)", fontSize: "0.82rem", outline: "none", width: "100%", boxSizing: "border-box",
};
const TABS = ["Rewards", "Points", "Tiers", "Invitations"] as const;
type Tab = typeof TABS[number];

// ─────────────────────────────────────────────────────────────────────────────
// REWARDS TAB
// ─────────────────────────────────────────────────────────────────────────────
function RewardsTab({ adminSecret }: { adminSecret: string }) {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", restaurant: "", restaurant_type: "restaurant", image: "", points_cost: "", required_tier: 1 as 1|2|3|4, category: "food" as Reward["category"] });

  const load = () => fetch("/api/admin/rewards").then((r) => r.json() as Promise<{ rewards: Reward[] }>).then((d) => setRewards(d.rewards ?? [])).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function addReward(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/admin/rewards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, points_cost: Number(form.points_cost), admin_secret: adminSecret }) });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error);
      setShowAdd(false); setForm({ name: "", description: "", restaurant: "", restaurant_type: "restaurant", image: "", points_cost: "", required_tier: 1, category: "food" });
      load();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed"); }
    finally { setSaving(false); }
  }

  async function toggle(r: Reward) {
    await fetch(`/api/admin/rewards/${r.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !r.active, admin_secret: adminSecret }) });
    load();
  }

  async function remove(r: Reward) {
    if (!confirm(`Delete "${r.name}"?`)) return;
    await fetch(`/api/admin/rewards/${r.id}?admin_secret=${adminSecret}`, { method: "DELETE", headers: { "x-admin-secret": adminSecret } });
    load();
  }

  if (loading) return <div style={{ color: "var(--text-dim)", padding: "2rem", textAlign: "center" }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>{rewards.length} rewards · {rewards.filter(r => r.active).length} active</span>
        <button onClick={() => setShowAdd(!showAdd)} style={{ padding: "0.4rem 0.9rem", borderRadius: 8, border: "1px solid var(--accent)", background: showAdd ? "var(--accent)" : "transparent", color: showAdd ? "#06090f" : "var(--accent)", fontSize: "0.8rem", fontWeight: 700, cursor: "pointer" }}>
          {showAdd ? "✕ Cancel" : "+ Add Reward"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={addReward} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--text-bright)" }}>New Reward</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <Field label="Reward Name *"><input style={inputStyle} required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Free Appetizer" /></Field>
            <Field label="Restaurant / Venue *"><input style={inputStyle} required value={form.restaurant} onChange={e => setForm(f => ({ ...f, restaurant: e.target.value }))} placeholder="e.g. Partner Restaurants" /></Field>
          </div>
          <Field label="Description *">
            <textarea style={{ ...inputStyle, resize: "vertical", minHeight: 60 }} required value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Short description shown to users" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <Field label="Venue Type">
              <select style={inputStyle} value={form.restaurant_type} onChange={e => setForm(f => ({ ...f, restaurant_type: e.target.value }))}>
                {RESTAURANT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select style={inputStyle} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as Reward["category"] }))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <Field label="Points Cost *"><input style={inputStyle} type="number" min={1} required value={form.points_cost} onChange={e => setForm(f => ({ ...f, points_cost: e.target.value }))} placeholder="e.g. 500" /></Field>
            <Field label="Required Tier *">
              <select style={inputStyle} value={form.required_tier} onChange={e => setForm(f => ({ ...f, required_tier: Number(e.target.value) as 1|2|3|4 }))}>
                {TIERS.map(t => <option key={t.level} value={t.level}>{t.icon} {t.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Image URL"><input style={inputStyle} value={form.image} onChange={e => setForm(f => ({ ...f, image: e.target.value }))} placeholder="https://…" /></Field>
          {error && <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>}
          <button type="submit" disabled={saving} style={{ padding: "0.65rem", borderRadius: 10, border: "none", background: "var(--accent)", color: "#06090f", fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", fontSize: "0.88rem" }}>
            {saving ? "Saving…" : "Add Reward"}
          </button>
        </form>
      )}

      {/* Reward list grouped by tier */}
      {([1,2,3,4] as const).map(tierLevel => {
        const tierRewards = rewards.filter(r => r.required_tier === tierLevel);
        if (!tierRewards.length) return null;
        const tc = TIER_COLOR[tierLevel];
        return (
          <div key={tierLevel}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.5rem" }}>
              <span style={{ color: tc }}>{TIER_ICON[tierLevel]}</span>
              <span style={{ fontSize: "0.7rem", fontWeight: 700, color: tc, textTransform: "uppercase", letterSpacing: "0.08em" }}>{TIERS[tierLevel-1].name}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {tierRewards.map(r => (
                <div key={r.id} style={{ background: "var(--card)", border: `1px solid ${r.active ? tc + "33" : "var(--border)"}`, borderRadius: 12, padding: "0.75rem 1rem", display: "flex", gap: "0.75rem", alignItems: "center", opacity: r.active ? 1 : 0.5 }}>
                  {r.image && <img src={r.image} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-bright)", display: "flex", gap: "0.4rem", alignItems: "center" }}>
                      {r.name}
                      {r.is_base && <span style={{ fontSize: "0.6rem", background: "var(--border)", color: "var(--text-dim)", borderRadius: 4, padding: "0.1rem 0.35rem" }}>built-in</span>}
                      {!r.active && <span style={{ fontSize: "0.6rem", background: "rgba(248,81,73,0.15)", color: "var(--red)", borderRadius: 4, padding: "0.1rem 0.35rem" }}>disabled</span>}
                    </div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginTop: "0.1rem" }}>{r.restaurant} · {r.points_cost} pts</div>
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
                    <button onClick={() => toggle(r)} style={{ padding: "0.3rem 0.65rem", borderRadius: 6, border: `1px solid ${r.active ? "var(--red)" : "var(--accent)"}`, background: "transparent", color: r.active ? "var(--red)" : "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}>
                      {r.active ? "Disable" : "Enable"}
                    </button>
                    {!r.is_base && <button onClick={() => remove(r)} style={{ padding: "0.3rem 0.65rem", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", fontSize: "0.7rem", cursor: "pointer" }}>Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POINTS CONFIG TAB
// ─────────────────────────────────────────────────────────────────────────────
function PointsTab({ adminSecret }: { adminSecret: string }) {
  const [config, setConfig] = useState<PointsConfig | null>(null);
  const [draft, setDraft] = useState<PointsConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/config").then(r => r.json() as Promise<{ config: PointsConfig }>).then(d => { setConfig(d.config); setDraft(d.config); });
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch("/api/admin/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, admin_secret: adminSecret }) });
      const data = await res.json() as { ok?: boolean; config?: PointsConfig; error?: string };
      if (!res.ok) throw new Error(data.error);
      setConfig(data.config!); setDraft(data.config!); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed"); }
    finally { setSaving(false); }
  }

  if (!draft) return <div style={{ color: "var(--text-dim)", padding: "2rem", textAlign: "center" }}>Loading…</div>;

  const changed = JSON.stringify(draft) !== JSON.stringify(config);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>

      {/* Non-refundable */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--text-bright)" }}>Non-refundable Bookings</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>Paid reservations where the fee is <strong style={{ color: "var(--text)" }}>not</strong> returned on cancellation — full points awarded.</div>
        </div>
        <Field label="Points per $1 paid">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input style={{ ...inputStyle, width: 100 }} type="number" min={0} value={draft.points_per_dollar_nonrefundable} onChange={e => setDraft(d => d && ({ ...d, points_per_dollar_nonrefundable: Number(e.target.value) }))} />
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>pts / $1 → a $5 booking = {5 * draft.points_per_dollar_nonrefundable} pts</span>
          </div>
        </Field>
      </div>

      {/* Refundable */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--text-bright)" }}>Refundable Bookings</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>Paid reservations where the fee <strong style={{ color: "var(--text)" }}>can be refunded</strong>. Usually no points to avoid gaming (pay → earn pts → cancel → refund).</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <div
            onClick={() => setDraft(d => d && ({ ...d, refundable_earns_points: !d.refundable_earns_points }))}
            style={{ width: 40, height: 22, borderRadius: 11, background: draft.refundable_earns_points ? "var(--accent)" : "var(--border)", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0 }}
          >
            <div style={{ position: "absolute", top: 3, left: draft.refundable_earns_points ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
          </div>
          <span style={{ fontSize: "0.8rem", color: "var(--text)" }}>
            {draft.refundable_earns_points ? "Refundable bookings earn points" : "Refundable bookings earn 0 points (recommended)"}
          </span>
        </div>
        {draft.refundable_earns_points && (
          <Field label="Points per $1 paid (refundable)">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input style={{ ...inputStyle, width: 100 }} type="number" min={0} value={draft.points_per_dollar_refundable} onChange={e => setDraft(d => d && ({ ...d, points_per_dollar_refundable: Number(e.target.value) }))} />
              <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>pts / $1</span>
            </div>
          </Field>
        )}
      </div>

      {/* Free bookings */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--text-bright)" }}>Free / Promo Bookings</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>Reservations with no fee — flat points to still reward loyalty.</div>
        </div>
        <Field label="Points per free booking">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input style={{ ...inputStyle, width: 100 }} type="number" min={0} value={draft.points_per_free_booking} onChange={e => setDraft(d => d && ({ ...d, points_per_free_booking: Number(e.target.value) }))} />
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>pts (flat, regardless of value)</span>
          </div>
        </Field>
      </div>

      {error && <div style={{ fontSize: "0.8rem", color: "var(--red)", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.2)", borderRadius: 8, padding: "0.6rem 0.8rem" }}>{error}</div>}
      <button onClick={save} disabled={saving || !changed} style={{ padding: "0.7rem", borderRadius: 10, border: "none", background: saved ? "#2ecc71" : changed ? "var(--accent)" : "var(--border)", color: changed || saved ? "#06090f" : "var(--text-dim)", fontWeight: 700, fontSize: "0.9rem", cursor: saving || !changed ? "not-allowed" : "pointer", transition: "background 0.2s" }}>
        {saving ? "Saving…" : saved ? "✓ Saved" : "Save Points Config"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TIERS CONFIG TAB
// ─────────────────────────────────────────────────────────────────────────────
function TiersTab({ adminSecret }: { adminSecret: string }) {
  const [thresholds, setThresholds] = useState<Record<string, number>>({ quartz: 1, sapphire: 5, emerald: 15, black_diamond: 30 });
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tier/0x0000000000000000000000000000000000000000000000000000000000000000")
      .then(r => r.json() as Promise<{ thresholds?: Record<string, number> }>)
      .then(d => {
        if (d.thresholds) { setThresholds(d.thresholds); setDraft(d.thresholds); }
      }).catch(() => setDraft({ quartz: 1, sapphire: 5, emerald: 15, black_diamond: 30 }));
  }, []);

  const TIER_KEYS = [
    { key: "quartz", level: 1 }, { key: "sapphire", level: 2 },
    { key: "emerald", level: 3 }, { key: "black_diamond", level: 4 },
  ];

  async function saveTier(level: number, value: number) {
    setSaving(level); setError(null);
    try {
      const res = await fetch("/api/admin/tier/threshold", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: level, new_value: value, admin_secret: adminSecret }) });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error);
      setSaved(level); setTimeout(() => setSaved(null), 2000);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed"); }
    finally { setSaving(null); }
  }

  if (!draft) return <div style={{ color: "var(--text-dim)", padding: "2rem", textAlign: "center" }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", lineHeight: 1.5 }}>
        These thresholds are written on-chain via the <strong>AdminCap</strong>. Changes take effect immediately for all users.
      </div>
      {TIER_KEYS.map(({ key, level }) => {
        const tc = TIER_COLOR[level];
        const val = draft[key] ?? thresholds[key] ?? 0;
        const changed = val !== thresholds[key];
        return (
          <div key={key} style={{ background: "var(--card)", border: `1px solid ${tc}33`, borderRadius: 14, padding: "1rem 1.25rem", display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ fontSize: "1.4rem", color: tc, flexShrink: 0 }}>{TIER_ICON[level]}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: "0.88rem", color: tc }}>{TIERS[level-1].name}</div>
              <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginTop: "0.15rem" }}>Minimum bookings to reach this tier</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="number" min={0} value={val}
                onChange={e => setDraft(d => d && ({ ...d, [key]: Number(e.target.value) }))}
                style={{ ...inputStyle, width: 70, textAlign: "center", fontWeight: 700, fontSize: "0.9rem", color: tc }}
              />
              <span style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>bookings</span>
              <button
                onClick={() => saveTier(level, val)} disabled={!changed || saving === level}
                style={{ padding: "0.35rem 0.7rem", borderRadius: 7, border: `1px solid ${changed ? tc : "var(--border)"}`, background: saved === level ? tc : "transparent", color: saved === level ? "#06090f" : changed ? tc : "var(--text-dim)", fontSize: "0.72rem", fontWeight: 700, cursor: !changed || saving === level ? "not-allowed" : "pointer", minWidth: 60 }}
              >
                {saving === level ? "…" : saved === level ? "✓" : "Save"}
              </button>
            </div>
          </div>
        );
      })}
      {error && <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INVITATIONS TAB
// ─────────────────────────────────────────────────────────────────────────────
function InvitationsTab({ adminSecret }: { adminSecret: string }) {
  const [address, setAddress] = useState("");
  const [tier, setTier] = useState<1|2|3|4>(4);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Invitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<Invitation[]>([]);

  const loadLog = () => fetch("/api/admin/invitations").then(r => r.json() as Promise<{ invitations: Invitation[] }>).then(d => setLog(d.invitations ?? [])).catch(() => {});
  useEffect(() => { loadLog(); }, [result]);

  async function send(e: React.FormEvent) {
    e.preventDefault(); setSending(true); setError(null); setResult(null);
    try {
      const res = await fetch("/api/admin/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: address.trim(), tier, note, admin_secret: adminSecret }) });
      const data = await res.json() as Invitation & { error?: string };
      if (!res.ok) throw new Error(data.error);
      setResult(data); setAddress(""); setNote("");
    } catch (err) { setError(err instanceof Error ? err.message : "Failed"); }
    finally { setSending(false); }
  }

  const selectedTier = TIERS[tier - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <form onSubmit={send} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--text-bright)" }}>Grant Tier Directly</div>
        <Field label="Sui Address *"><input style={inputStyle} required value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" /></Field>
        <Field label="Grant Tier">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "0.4rem" }}>
            {TIERS.map(t => (
              <button key={t.level} type="button" onClick={() => setTier(t.level)} style={{ padding: "0.55rem 0.3rem", borderRadius: 9, border: `1.5px solid ${tier === t.level ? t.color : "var(--border)"}`, background: tier === t.level ? `${t.color}18` : "var(--bg)", color: tier === t.level ? t.color : "var(--text-dim)", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.15rem" }}>
                <span style={{ fontSize: "1rem" }}>{t.icon}</span>
                <span style={{ fontSize: "0.6rem", fontWeight: 700, textAlign: "center", lineHeight: 1.2 }}>{t.name}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Note (optional)"><input style={inputStyle} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. VIP Partner — Michelin Group" /></Field>
        {error && <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>}
        <button type="submit" disabled={sending || !address.trim()} style={{ padding: "0.65rem", borderRadius: 10, border: `1.5px solid ${selectedTier.color}`, background: `${selectedTier.color}18`, color: selectedTier.color, fontWeight: 700, fontSize: "0.88rem", cursor: sending || !address.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
          {sending ? <><span style={{ display: "inline-block", width: 12, height: 12, border: `2px solid ${selectedTier.color}44`, borderTopColor: selectedTier.color, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /> Granting…</> : <>{selectedTier.icon} Grant {selectedTier.name}</>}
        </button>
      </form>

      {result && (
        <div style={{ background: `${TIER_COLOR[result.tier]}10`, border: `1px solid ${TIER_COLOR[result.tier]}44`, borderRadius: 12, padding: "1rem 1.25rem" }}>
          <div style={{ fontWeight: 700, color: TIER_COLOR[result.tier] }}>{TIER_ICON[result.tier]} {result.tier_name} granted!</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "monospace", marginTop: "0.3rem", wordBreak: "break-all" }}>{result.address}</div>
          {result.note && <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "0.15rem" }}>"{result.note}"</div>}
          <a href={`https://suiscan.xyz/testnet/tx/${result.tx_hash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.7rem", color: "var(--accent)", textDecoration: "none", display: "block", marginTop: "0.35rem" }}>View tx ↗</a>
        </div>
      )}

      {log.length > 0 && (
        <>
          <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Recent Invitations</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {log.map((inv, i) => (
              <div key={i} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "0.65rem 1rem", display: "flex", alignItems: "center", gap: "0.65rem" }}>
                <span style={{ color: TIER_COLOR[inv.tier], flexShrink: 0 }}>{TIER_ICON[inv.tier]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <span style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--text-bright)" }}>{shortAddr(inv.address)}</span>
                    <span style={{ fontSize: "0.6rem", fontWeight: 700, color: TIER_COLOR[inv.tier], background: `${TIER_COLOR[inv.tier]}18`, borderRadius: 4, padding: "0.1rem 0.35rem" }}>{inv.tier_name}</span>
                  </div>
                  {inv.note && <div style={{ fontSize: "0.68rem", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inv.note}</div>}
                </div>
                <a href={`https://suiscan.xyz/testnet/tx/${inv.tx_hash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.65rem", color: "var(--accent)", textDecoration: "none", flexShrink: 0 }}>tx ↗</a>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("Rewards");
  const [adminSecret, setAdminSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "inherit" }}>
      <div style={{ background: "var(--card)", borderBottom: "1px solid var(--border)", padding: "0.9rem 1.25rem", display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "1.1rem", padding: "0.2rem" }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: "1rem", color: "var(--text-bright)" }}>Admin Panel</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>Manage rewards, points policy, tier thresholds, and invitations</div>
        </div>
        {/* Admin secret inline */}
        <div style={{ position: "relative" }}>
          <input
            type={showSecret ? "text" : "password"}
            value={adminSecret}
            onChange={e => setAdminSecret(e.target.value)}
            placeholder="Admin secret"
            style={{ ...inputStyle, width: 140, fontSize: "0.75rem", padding: "0.4rem 0.65rem" }}
          />
          <button onClick={() => setShowSecret(s => !s)} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "0.7rem", padding: 0 }}>
            {showSecret ? "hide" : "show"}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background: "var(--card)", borderBottom: "1px solid var(--border)", display: "flex", gap: 0 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "0.65rem", border: "none", borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent", background: "transparent", color: tab === t ? "var(--accent)" : "var(--text-dim)", fontWeight: tab === t ? 700 : 400, fontSize: "0.8rem", cursor: "pointer", transition: "color 0.15s" }}>
            {t}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "1.25rem 1rem 4rem" }}>
        {tab === "Rewards"     && <RewardsTab adminSecret={adminSecret} />}
        {tab === "Points"      && <PointsTab  adminSecret={adminSecret} />}
        {tab === "Tiers"       && <TiersTab   adminSecret={adminSecret} />}
        {tab === "Invitations" && <InvitationsTab adminSecret={adminSecret} />}
      </div>
    </div>
  );
}
