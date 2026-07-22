// The "Next checkup" read — the athlete-facing composition over the doctor-loop.
//
// Cairn already runs a per-marker recheck-cadence engine (attention.ts +
// doctor-loop.ts) and a propagation engine that links supplements/directives to the
// markers they touch. Nobody sees it. This module folds those deterministic pieces
// into one calm read of what's coming: rechecks whose window is open or opening,
// visible follow-through on the interventions already in motion ("started psyllium
// for ApoB → recheck due → trending your way"), and a deterministic prep list of
// what's worth bringing and asking.
//
// Constitution: informational-not-medical, suggestion-never-a-gate, NO numeric
// scores/grades anywhere, pull-never-push. Every read composes from existing
// deterministic state; null-safe and calm on an empty DB.

import { db, todayISO } from "../db.js";
import {
  listAttentionSchedule,
  listDueAttention,
  type AttentionScheduleEntry,
} from "./attention.js";
import { markerSignalKey, recommendedPanel, refreshDoctorLoopAttention } from "./doctor-loop.js";
import { getLatestHealthReview, getMarkerHistory } from "./health.js";
import { listDirectives } from "./coach.js";
import { listSupplements } from "./supplements.js";
import { canonicalMarker } from "./marker-canon.js";
import { followupLabel, markerSlugFromSignalKey } from "./attention-labels.js";
import { dexaRescanWhenText, dexaRescanWindow, latestDexaDate } from "./dexa-window.js";

export type CheckupItemKind = "lab" | "dexa" | "review" | "add";

export interface CheckupItem {
  signal_key: string;
  label: string;
  kind: CheckupItemKind;
  next_due: string | null; // YYYY-MM-DD, or null for an add-on suggestion
  when_text: string | null; // plain language: "window is open" / "opens in about three weeks"
  why: string; // plain-language rationale (never a score)
}

export type FollowThroughStatus = "moving_your_way" | "not_yet" | "awaiting_recheck";
export type FollowThroughRecheck = "due" | "upcoming" | "none";

export interface FollowThroughItem {
  marker: string; // display name
  marker_key: string;
  via: string[]; // the interventions pointing at this marker (supplement names, "your … plan")
  status: FollowThroughStatus;
  status_text: string;
  latest_value: string | null; // e.g. "78 mg/dL"
  latest_date: string | null; // ISO — the client renders relative age
  trend_dir: "rising" | "falling" | "stable" | null;
  trend_text: string | null; // e.g. "falling over about 14 weeks"
  recheck: FollowThroughRecheck;
  recheck_next_due: string | null;
  recheck_text: string; // e.g. "recheck window is open" / "recheck opens in about three weeks"
}

export interface OrderedLab {
  label: string;
  detail: string | null;
  source: "review" | "visit_note";
}

export interface CheckupPrep {
  ordered_labs: OrderedLab[];
  bring: string[];
  questions: string[];
}

export interface NextCheckupRead {
  lede: string;
  due_now: CheckupItem[];
  upcoming: CheckupItem[];
  follow_through: FollowThroughItem[];
  prep: CheckupPrep;
  has_content: boolean;
  frame: string;
}

interface MarkerLike {
  key?: string | null;
  name?: string | null;
  unit?: string | null;
  latest?: { value?: unknown; flag?: unknown; date?: unknown; kind?: unknown } | null;
  trend?: { dir?: unknown; span_days?: unknown; n?: unknown } | null;
  forecast?: { direction?: unknown } | null;
}

const FRAME =
  "Informational, not medical advice. These are calm suggestions for your next visit — Cairn prepares what's worth checking and asking; you and your clinician decide.";

// An upcoming recheck within this window (and any ordered labs) is enough to raise
// the quiet Stand tile. Beyond it, the read still exists — it just doesn't surface
// itself (pull, never push; no urgency).
const SOON_DAYS = 45;
// How far out a dated recheck stays worth listing as "upcoming".
const UPCOMING_HORIZON_DAYS = 180;

function daysBetween(a: string, b: string): number | null {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

// Days → a calm plain-language horizon. Never a precise count past ~10 days, so it
// reads like a coach ("about three weeks"), never a countdown.
function humanHorizon(days: number): string {
  if (days <= 0) return "now";
  if (days <= 10) return `about ${days} day${days === 1 ? "" : "s"}`;
  const weeks = Math.round(days / 7);
  if (weeks <= 8) return `about ${weeks} week${weeks === 1 ? "" : "s"}`;
  const months = Math.max(1, Math.round(days / 30));
  return `about ${months} month${months === 1 ? "" : "s"}`;
}

// Days elapsed → a calm span phrase for a trend ("over about 14 weeks").
function humanSpan(days: number): string {
  if (days <= 0) return "";
  if (days < 14) return `over about ${days} days`;
  const weeks = Math.round(days / 7);
  if (weeks <= 10) return `over about ${weeks} weeks`;
  const months = Math.max(1, Math.round(days / 30));
  return `over about ${months} month${months === 1 ? "" : "s"}`;
}

function dueWhenText(nextDue: string | null, asOf: string): string | null {
  if (!nextDue) return null;
  const days = daysBetween(asOf, nextDue);
  if (days == null) return null;
  if (days <= 0) return "window is open";
  return `opens in ${humanHorizon(days)}`;
}

function titleFromSlug(slug: string): string {
  return String(slug || "")
    .replace(/[-:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Resolve an attention signal_key to a human label + kind. Marker rechecks join
// back to the real marker (so we show its clean display name); DEXA and review
// follow-ups get calm generic labels.
function describeSignal(
  entry: AttentionScheduleEntry,
  markerBySignal: Map<string, MarkerLike>
): { label: string; kind: CheckupItemKind } {
  const key = entry.signal_key;
  if (key.startsWith("marker:")) {
    const m = markerBySignal.get(key);
    return { label: m?.name ? String(m.name) : titleFromSlug(key.slice(7)), kind: "lab" };
  }
  // A directive-sourced recheck joins back to its marker (same slug as the periodic
  // cadence). Falls to a clean title from the slug for markers with no cadence policy
  // (e.g. "Testosterone"), which reads well on its own.
  if (key.startsWith("directive-recheck:")) {
    const slug = key.slice("directive-recheck:".length);
    const m = markerBySignal.get(`marker:${slug}`);
    return { label: m?.name ? String(m.name) : titleFromSlug(slug), kind: "lab" };
  }
  if (key.startsWith("dexa:")) return { label: "Body composition (DEXA)", kind: "dexa" };
  // Speak each review follow-up as its own action ("Recheck hs-CRP") instead of one
  // generic "Lab follow-up" line that renders identically for every different follow-up.
  if (key.startsWith("review-followup:"))
    return { label: followupLabel(entry.reason) ?? "Lab follow-up from your last review", kind: "review" };
  return { label: titleFromSlug(key), kind: "lab" };
}

function toCheckupItem(
  entry: AttentionScheduleEntry,
  asOf: string,
  markerBySignal: Map<string, MarkerLike>,
  dexaWhenText: string | null
): CheckupItem {
  const { label, kind } = describeSignal(entry, markerBySignal);
  // The DEXA re-scan reads as a soft window ("worth considering around …"), matching
  // Train's forward timeline — never a bare due date, though attention's next_due stays
  // the scheduling key. Falls back to the calm horizon phrasing if no window is known.
  const when_text =
    kind === "dexa" && dexaWhenText ? dexaWhenText : dueWhenText(entry.next_due, asOf);
  return {
    signal_key: entry.signal_key,
    label,
    kind,
    next_due: entry.next_due,
    when_text,
    why: entry.reason,
  };
}

function markerValueText(m: MarkerLike): string | null {
  const v = m.latest?.value;
  if (v == null || v === "") return null;
  const num = typeof v === "number" ? v : Number(v);
  const shown = Number.isFinite(num) ? String(Math.round(num * 100) / 100) : String(v);
  return m.unit ? `${shown} ${String(m.unit)}` : shown;
}

function markerDate(m: MarkerLike): string | null {
  const d = String(m.latest?.date ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function trendText(m: MarkerLike): string | null {
  const dir = m.trend?.dir;
  if (dir !== "rising" && dir !== "falling" && dir !== "stable") return null;
  const span = Number(m.trend?.span_days);
  if (dir === "stable") return Number.isFinite(span) && span > 0 ? `holding ${humanSpan(span)}` : "holding steady";
  const word = dir === "rising" ? "rising" : "falling";
  return Number.isFinite(span) && span > 0 ? `${word} ${humanSpan(span)}` : word;
}

// The intervention → marker follow-through status. `forecast.direction` is already
// computed against the OPTIMAL band ("improving" = toward optimal), so it carries
// the whole verdict — no score, no re-derivation.
function followStatus(m: MarkerLike): FollowThroughStatus {
  const n = Number(m.trend?.n);
  if (!Number.isFinite(n) || n < 2) return "awaiting_recheck";
  const dir = m.forecast?.direction;
  if (dir === "improving") return "moving_your_way";
  return "not_yet";
}

const STATUS_TEXT: Record<FollowThroughStatus, string> = {
  moving_your_way: "moving your way",
  not_yet: "not yet — the recheck will tell",
  awaiting_recheck: "awaiting the first recheck",
};

function recheckReadFor(
  m: MarkerLike,
  attentionBySignal: Map<string, AttentionScheduleEntry>,
  asOf: string
): { recheck: FollowThroughRecheck; next_due: string | null; text: string } {
  const key = markerSignalKey(m as any);
  const entry = key ? attentionBySignal.get(key) : null;
  if (!entry || !entry.next_due) return { recheck: "none", next_due: null, text: "no recheck scheduled yet" };
  const days = daysBetween(asOf, entry.next_due);
  if (days != null && days <= 0) return { recheck: "due", next_due: entry.next_due, text: "recheck window is open" };
  return {
    recheck: "upcoming",
    next_due: entry.next_due,
    text: `recheck opens in ${humanHorizon(days ?? 0)}`,
  };
}

// ---- ordered-labs scan (deterministic, conservative) --------------------------
// Panel/marker names Cairn recognizes well enough to surface as "ordered" when a
// visit note clearly lists them alongside an order-context word. Kept to canonical
// names + a few common panel labels so we never guess from prose.
const ORDERABLE_PANELS: Array<{ label: string; needles: string[] }> = [
  { label: "Lipid panel", needles: ["lipid panel", "lipid profile", "cholesterol panel"] },
  { label: "ApoB", needles: ["apob", "apo b", "apolipoprotein b"] },
  { label: "Lp(a)", needles: ["lp(a)", "lipoprotein (a)", "lipoprotein a"] },
  { label: "hs-CRP", needles: ["hs-crp", "hscrp", "high-sensitivity c-reactive"] },
  { label: "HbA1c", needles: ["hba1c", "hemoglobin a1c", "a1c"] },
  { label: "Fasting glucose", needles: ["fasting glucose"] },
  { label: "Fasting insulin", needles: ["fasting insulin"] },
  { label: "CBC", needles: ["cbc", "complete blood count"] },
  { label: "Comprehensive metabolic panel", needles: ["cmp", "comprehensive metabolic", "metabolic panel"] },
  { label: "Ferritin", needles: ["ferritin"] },
  { label: "Iron studies", needles: ["iron studies", "iron panel"] },
  { label: "Thyroid panel", needles: ["tsh", "thyroid panel", "free t4", "free t3"] },
  { label: "Vitamin D", needles: ["vitamin d", "25-oh", "25 hydroxy"] },
  { label: "Kidney function", needles: ["egfr", "creatinine", "renal panel"] },
  // NB: bare "alt"/"ast" are deliberately excluded — even whole-word they are too
  // easily an abbreviation for something else; require an unambiguous phrase.
  { label: "Liver function", needles: ["liver panel", "hepatic panel", "liver function", "alt (sgpt)", "ast (sgot)"] },
];

const ORDER_CONTEXT = /\b(order(?:ed|s)?|will\s+(?:obtain|order|draw|repeat)|to\s+(?:obtain|draw|repeat)|future\s+labs?|labs?\s+(?:ordered|pending|to\s+draw)|recheck|repeat|pending\s+labs?|draw\s+(?:labs?|in))\b/i;

function visitNoteText(row: { summary?: unknown; parsed_json?: unknown }): string {
  const parts: string[] = [String(row.summary ?? "")];
  try {
    const parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
    const facts = Array.isArray(parsed?.clinical_facts) ? parsed.clinical_facts : [];
    for (const f of facts) parts.push(String(f?.kind ?? ""), String(f?.name ?? ""), String(f?.detail ?? ""), String(f?.status ?? ""));
    if (typeof parsed?.summary === "string") parts.push(parsed.summary);
    if (Array.isArray(parsed?.orders)) for (const o of parsed.orders) parts.push(typeof o === "string" ? o : String(o?.name ?? o?.label ?? ""));
  } catch {
    /* unparseable parsed_json — the summary alone still scans */
  }
  return parts.join(" \n ").toLowerCase();
}

// Split a note into sentence/clause units. We split on sentence terminators and
// hard breaks ONLY — never commas or colons — so an "ordered: lipid panel, Lp(a),
// ApoB" list stays attached to its order lead-in, while a separate "Reviewed X.
// Plan: repeat Y" can never attribute X's mention to Y's order.
function splitClauses(text: string): string[] {
  return text
    .split(/[.;!?\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Whole-token needle match: the needle must sit on word boundaries, so a short
// abbreviation ("cbc", "a1c") never matches inside a larger word and a stray
// substring ("alt" in "salt", "ast" in "fasting") can't phantom-order a panel.
function needleInClause(clause: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(clause);
}

function scanOrderedLabs(): OrderedLab[] {
  const out: OrderedLab[] = [];
  const seen = new Set<string>();
  const push = (label: string, detail: string | null, source: OrderedLab["source"]) => {
    const key = label.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ label, detail, source });
  };

  // (1) Structured review follow-ups — already parsed into {what, when}.
  const review = getLatestHealthReview() as any;
  const followups = Array.isArray(review?.parsed?.followups) ? review.parsed.followups : [];
  for (const f of followups) {
    const what = String(f?.what ?? "").replace(/\s+/g, " ").trim();
    if (!what || !/\b(retest|recheck|repeat|draw|labs?|panel|dexa|scan)\b/i.test(what)) continue;
    const when = String(f?.when ?? "").replace(/\s+/g, " ").trim();
    push(what.slice(0, 90), when ? `from your last review — ${when}` : "from your last review", "review");
  }

  // (2) Conservative scan of recent visit notes / after-visit summaries — only
  //     canon panel names that appear alongside an order-context word.
  const docs = db
    .prepare(
      `SELECT summary, parsed_json FROM health_documents
       WHERE kind IN ('visit_note', 'after_visit_summary')
       ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)) DESC, id DESC
       LIMIT 5`
    )
    .all() as Array<{ summary?: unknown; parsed_json?: unknown }>;
  for (const row of docs) {
    // Proximity, not document-level co-occurrence: a panel is only "ordered" when
    // it sits in the SAME clause as an order-context word — so "Reviewed lipid
    // panel … Plan: repeat DEXA" never attributes the lipid panel to the repeat.
    for (const clause of splitClauses(visitNoteText(row))) {
      if (!ORDER_CONTEXT.test(clause)) continue;
      for (const panel of ORDERABLE_PANELS) {
        if (panel.needles.some((n) => needleInClause(clause, n))) push(panel.label, "ordered at your last visit", "visit_note");
      }
    }
  }
  return out.slice(0, 8);
}

// ---- follow-through -----------------------------------------------------------
function composeFollowThrough(
  markerByKey: Map<string, MarkerLike>,
  attentionBySignal: Map<string, AttentionScheduleEntry>,
  asOf: string
): FollowThroughItem[] {
  // key -> { marker, via[] }. Both a supplement and a directive can point at the
  // same marker; merge their "via" phrases into one follow-through row.
  const acc = new Map<string, { marker: MarkerLike; via: string[]; hasDirective: boolean }>();
  const add = (rawMarker: string, phrase: string, isDirective: boolean) => {
    const canon = canonicalMarker(rawMarker);
    const key = canon.key || rawMarker.toLowerCase();
    const marker = markerByKey.get(key);
    if (!marker) return; // only track markers actually on file (we need a reading to speak to)
    const entry = acc.get(key) ?? { marker, via: [], hasDirective: false };
    if (phrase && !entry.via.includes(phrase)) entry.via.push(phrase);
    entry.hasDirective = entry.hasDirective || isDirective;
    acc.set(key, entry);
  };

  for (const supp of listSupplements({ activeOnly: true }) as any[]) {
    const name = String(supp?.name ?? "").trim();
    const related = Array.isArray(supp?.related_markers) ? supp.related_markers : [];
    for (const rm of related) if (name && rm) add(String(rm), name, false);
  }
  for (const d of listDirectives() as any[]) {
    const m = d?.marker ? String(d.marker) : "";
    if (m) add(m, `your ${canonicalMarker(m).name} plan`, true);
  }

  const items: FollowThroughItem[] = [];
  for (const [key, { marker, via }] of acc) {
    const status = followStatus(marker);
    const rc = recheckReadFor(marker, attentionBySignal, asOf);
    items.push({
      marker: String(marker.name ?? key),
      marker_key: key,
      via,
      status,
      status_text: STATUS_TEXT[status],
      latest_value: markerValueText(marker),
      latest_date: markerDate(marker),
      trend_dir: (["rising", "falling", "stable"] as const).includes(marker.trend?.dir as any)
        ? (marker.trend?.dir as any)
        : null,
      trend_text: trendText(marker),
      recheck: rc.recheck,
      recheck_next_due: rc.next_due,
      recheck_text: rc.text,
    });
  }
  // Recheck-due first, then markers still moving, then the rest — a calm priority,
  // never a score.
  const rank = (i: FollowThroughItem) => (i.recheck === "due" ? 0 : i.recheck === "upcoming" ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || a.marker.localeCompare(b.marker));
  return items.slice(0, 8);
}

// ---- prep ---------------------------------------------------------------------
function composePrep(
  dueNow: CheckupItem[],
  addOns: CheckupItem[],
  followThrough: FollowThroughItem[],
  orderedLabs: OrderedLab[]
): CheckupPrep {
  const bring: string[] = [];
  const hasDocs = (db.prepare(`SELECT 1 FROM health_documents LIMIT 1`).get() as unknown) != null;
  if (hasDocs) bring.push("Your recent lab reports and scans — Cairn can print a doctor-ready summary from Share.");
  const supps = (listSupplements({ activeOnly: true }) as any[]).map((s) => String(s?.name ?? "")).filter(Boolean);
  if (supps.length) {
    const shown = supps.slice(0, 3).join(", ");
    bring.push(`Your current supplement list${supps.length > 3 ? ` (${shown} and more)` : ` (${shown})`}.`);
  }
  if (orderedLabs.some((o) => o.source === "visit_note")) bring.push("The lab order from your last visit.");

  const questions: string[] = [];
  const seenQ = new Set<string>();
  const pushQ = (q: string) => {
    const key = q.toLowerCase();
    if (q && !seenQ.has(key) && questions.length < 5) {
      seenQ.add(key);
      questions.push(q);
    }
  };
  for (const item of dueNow) if (item.kind === "lab" || item.kind === "review") pushQ(`Is it time to recheck ${item.label}?`);
  for (const item of addOns.slice(0, 2)) pushQ(`Worth adding ${item.label} to the next draw?`);
  // Interventions in motion whose target marker has no recheck on the calendar yet.
  for (const ft of followThrough) if (ft.recheck === "none") pushQ(`How's my ${ft.marker} tracking — worth a recheck?`);

  return { ordered_labs: orderedLabs, bring, questions };
}

// ---- lede ---------------------------------------------------------------------
function composeLede(
  dueNow: CheckupItem[],
  upcomingDated: CheckupItem[],
  orderedLabs: OrderedLab[],
  followThrough: FollowThroughItem[]
): string {
  if (dueNow.length) {
    const extra = dueNow.length > 1 ? `, plus ${dueNow.length - 1} more` : "";
    return `Your ${dueNow[0].label} recheck window is open${extra}.`;
  }
  const soonest = upcomingDated[0];
  if (soonest && soonest.when_text) return `Your ${soonest.label} recheck ${soonest.when_text}.`;
  if (orderedLabs.length) return "Your last visit left labs to bring in — nothing's due to recheck on Cairn's side yet.";
  if (followThrough.length) return "No rechecks are due — a few things you're doing are still working; here's where they stand.";
  return "Nothing's due for a recheck right now. Your markers are quiet — Cairn will flag the next window when it opens.";
}

// The whole read. `refresh` re-runs the deterministic attention pass first (the
// REST route passes true so an open reflects the newest data even between nightly
// scheduler passes); the scheduler op keeps it warm on a cadence regardless.
export function nextCheckupRead(opts: { refresh?: boolean; asOf?: string } = {}): NextCheckupRead {
  if (opts.refresh) {
    try {
      refreshDoctorLoopAttention();
    } catch {
      /* keep the last persisted attention state on any refresh hiccup */
    }
  }
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf ?? "")) ? String(opts.asOf) : todayISO();

  const { markers } = getMarkerHistory() as { markers: MarkerLike[] };
  const markerByKey = new Map<string, MarkerLike>();
  const markerBySignal = new Map<string, MarkerLike>();
  for (const m of markers) {
    const key = String(m.key ?? m.name ?? "").toLowerCase();
    if (key && !markerByKey.has(key)) markerByKey.set(key, m);
    const sig = markerSignalKey(m as any);
    if (sig && !markerBySignal.has(sig)) markerBySignal.set(sig, m);
  }
  // The DEXA re-scan window is derived once from the baseline scan and shared with
  // Train's timeline, so both surfaces frame the re-scan as the same suggestion window.
  // A current/future window reads as a dated suggestion ("worth considering around …");
  // an OVERDUE window (its end already past asOf) reads as due/overdue instead of a
  // nonsensical past date range — matching Train's timeline, which drops a stale window.
  const dexaWindow = dexaRescanWindow(latestDexaDate(markers as any[]));
  const dexaWhenText =
    dexaWindow == null
      ? null
      : dexaWindow.end < asOf
        ? "window is open — worth scheduling"
        : dexaRescanWhenText(dexaWindow);

  const schedule = [
    ...listAttentionSchedule({ domain: "health", limit: 80 }),
    ...listAttentionSchedule({ domain: "body", limit: 20 }),
  ];
  const attentionBySignal = new Map<string, AttentionScheduleEntry>();
  for (const e of schedule) if (!attentionBySignal.has(e.signal_key)) attentionBySignal.set(e.signal_key, e);

  const due = [
    ...listDueAttention(asOf, { domain: "health", limit: 50 }),
    ...listDueAttention(asOf, { domain: "body", limit: 20 }),
  ];
  // Dedupe at the MARKER level, not the raw signal_key: a marker's periodic cadence
  // recheck (`marker:hs-crp`) and a review follow-up on that same marker
  // (`review-followup:hs-crp:…`) are one story — surface the sooner one only. Non-marker
  // signals (dexa, add-ons) keep keying on their own signal_key.
  const dedupeKey = (signalKey: string): string => markerSlugFromSignalKey(signalKey) ?? signalKey;
  const dueSeen = new Set<string>();
  const dueNow: CheckupItem[] = [];
  for (const e of due.sort((a, b) => String(a.next_due).localeCompare(String(b.next_due)))) {
    const k = dedupeKey(e.signal_key);
    if (dueSeen.has(k)) continue;
    dueSeen.add(k);
    dueNow.push(toCheckupItem(e, asOf, markerBySignal, dexaWhenText));
  }

  // Upcoming = dated entries not yet due, within the horizon.
  const upcomingDated: CheckupItem[] = [];
  const upSeen = new Set<string>();
  for (const e of schedule) {
    const k = dedupeKey(e.signal_key);
    if (!e.next_due || dueSeen.has(k) || upSeen.has(k)) continue;
    const days = daysBetween(asOf, e.next_due);
    if (days == null || days <= 0 || days > UPCOMING_HORIZON_DAYS) continue;
    upSeen.add(k);
    upcomingDated.push(toCheckupItem(e, asOf, markerBySignal, dexaWhenText));
  }
  upcomingDated.sort((a, b) => String(a.next_due).localeCompare(String(b.next_due)));

  // Missing high-value workups → calm "worth adding" suggestions (no date).
  const addOns: CheckupItem[] = (recommendedPanel() as any[]).map((item) => ({
    signal_key: `add:${String(item.key)}`,
    label: String(item.label),
    kind: "add" as const,
    next_due: null,
    when_text: null,
    why: `${String(item.reason)} ${String(item.cadence_note)}`.trim(),
  }));

  const upcoming = [...upcomingDated.slice(0, 8), ...addOns.slice(0, 6)];

  const followThrough = composeFollowThrough(markerByKey, attentionBySignal, asOf);
  const orderedLabs = scanOrderedLabs();
  const prep = composePrep(dueNow, addOns, followThrough, orderedLabs);
  const lede = composeLede(dueNow, upcomingDated, orderedLabs, followThrough);

  const upcomingSoon = upcomingDated.some((e) => {
    const d = daysBetween(asOf, e.next_due || "");
    return d != null && d <= SOON_DAYS;
  });
  const has_content = dueNow.length > 0 || upcomingSoon || orderedLabs.length > 0;

  return { lede, due_now: dueNow, upcoming, follow_through: followThrough, prep, has_content, frame: FRAME };
}
