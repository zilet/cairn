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
import { listAttentionSchedule, type AttentionScheduleEntry } from "./attention.js";
import {
  doctorLoopItems,
  markerSignalKey,
  recommendedPanel,
  refreshDoctorLoopAttention,
  spokenLoopReason,
  type DoctorLoopItem,
} from "./doctor-loop.js";
import { followThroughQuestion, recheckQuestion, spokenMarkerName, workupQuestion } from "./loop-speech.js";
import { getLatestHealthReview, getMarkerHistory } from "./health.js";
import { listDirectives } from "./directives.js";
import { listSupplements } from "./supplements.js";
import { canonicalMarker } from "./marker-canon.js";
import { dexaRescanWhenText, dexaRescanWindow, latestDexaDate, shortDate } from "./dexa-window.js";
import { withDerivedReadings } from "./doctor-loop-derived.js";
import { matchOptimalZone, optimalDistance } from "./propagation-data.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { addDaysISO, daysBetweenISO } from "./shared.js";
import { getEnduranceGoal, getProfile } from "./profile.js";
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { presentMarkerRow } from "./lab-display.js";
import type { LabUnitSystem } from "./lab-units.js";
import { labUnitSystem } from "./settings.js";

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

// One visit the open and opening rechecks fold into (see composeVisit).
export type CheckupVisitLabState = "past_window" | "opens_in_window";

export interface CheckupVisitLab {
  label: string;
  last_date: string | null; // the newest reading behind this follow-up, when known
  state: CheckupVisitLabState; // past_window: already open today; opens_in_window: opens by the visit
}

export interface CheckupVisitAdd {
  label: string;
  why: string;
}

export interface CheckupVisitDexa {
  last_date: string | null;
  last_weight_lb: number | null;
  current_weight_lb: number | null;
  why: string;
}

export interface CheckupVisit {
  window_start: string; // YYYY-MM-DD
  window_end: string; // YYYY-MM-DD
  why: string;
  labs: CheckupVisitLab[];
  add: CheckupVisitAdd[];
  dexa: CheckupVisitDexa | null;
  prep: string[];
}

export interface NextCheckupRead {
  lede: string;
  due_now: CheckupItem[];
  upcoming: CheckupItem[];
  follow_through: FollowThroughItem[];
  prep: CheckupPrep;
  // The one visit the rechecks fold into; null when nothing is due or opening soon.
  visit: CheckupVisit | null;
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

// WHICH MISSING WORKUP A FLAGGED MARKER ACTUALLY WARRANTS (owner ruling R3).
//
// recommendedPanel() already knows what has never been measured, but the tile only
// raised itself for DATED rechecks and ordered labs — so an athlete whose lipids came
// back worse on a minimal panel, with ApoB and Lp(a) simply not drawn, saw nothing at
// all. The add-on is worth surfacing on its own when a marker it would explain is
// currently off-optimal or lab-flagged; otherwise it stays exactly as quiet as today.
//
// Keys are recommendedPanel() item keys; values are the optimal-zone labels / marker
// names whose flag makes that add-on worth asking for. Deliberately narrow — an add-on
// with no clinical neighbour on file stays a calm, undated suggestion.
const ADDON_WARRANTED_BY: Record<string, string[]> = {
  apob: ["LDL-C", "Total Cholesterol", "Non-HDL-C", "Triglycerides", "HDL-C"],
  lpa: ["LDL-C", "Total Cholesterol", "Non-HDL-C", "ApoB"],
  "hs-crp": ["LDL-C", "Total Cholesterol", "Non-HDL-C", "Triglycerides", "Homocysteine"],
  hba1c: ["Fasting Glucose", "Glucose", "Triglycerides"],
  "fasting-insulin": ["Fasting Glucose", "Glucose", "HbA1c", "Triglycerides"],
  ferritin: ["Hemoglobin", "Hematocrit", "MCV", "Iron"],
  "vitamin-d": ["Calcium", "Alkaline Phosphatase"],
  "urine-acr": ["Creatinine", "eGFR"],
};

// An add-on plus whether a currently-off marker warrants it. `warranted` is internal
// ordering/gating state and is stripped before the item reaches the client contract.
interface WarrantedCheckupItem extends CheckupItem {
  warranted: boolean;
}

// Athlete-facing, informational, never medical advice — and a set, never one literal,
// so the same missing workup does not print the same sentence every morning.
const ADDON_WARRANTED_LINES = [
  "Something it helps explain is off right now, and this has never been measured.",
  "A related marker is flagged at the moment, and this one isn't on file.",
  "This would add context to a marker that's currently out of your optimal range.",
  "Worth asking about — a neighbouring marker is off and this has never been drawn.",
];

const ADDON_LEDE_LINES = [
  "Nothing's due to recheck — but a couple of things worth adding to the next draw would fill in a marker that's off right now.",
  "No rechecks are open. There are a few workups that have never been done and would explain a flagged marker.",
  "Nothing's on the calendar to recheck. A short list of never-measured add-ons would round out the picture on a marker that's off.",
];

// Is this marker something a clinician would look at right now: lab-flagged, or sitting
// outside its evidence-anchored optimal band. NO score is computed or surfaced — this is
// a boolean about whether the marker is off, nothing more.
function markerIsOff(m: MarkerLike | undefined): boolean {
  if (!m) return false;
  const flag = String(m.latest?.flag ?? "").toLowerCase();
  if (flag === "high" || flag === "low") return true;
  const zone = matchOptimalZone(String(m.name ?? m.key ?? ""));
  const value = Number(m.latest?.value);
  if (!zone || !Number.isFinite(value)) return false;
  return optimalDistance(value, zone) > 0;
}

// The add-on keys a currently-off marker warrants. Pure over the marker index so the
// rule is testable without a DB shape.
export function warrantedAddOnKeys(markerByKey: Map<string, MarkerLike>): Set<string> {
  const off = new Set<string>();
  for (const m of markerByKey.values()) {
    if (!markerIsOff(m)) continue;
    for (const name of [m.name, m.key, matchOptimalZone(String(m.name ?? m.key ?? ""))?.label]) {
      const n = String(name ?? "").toLowerCase();
      if (n) off.add(n);
      const canon = name ? canonicalMarker(String(name)) : null;
      if (canon?.name) off.add(canon.name.toLowerCase());
      if (canon?.key) off.add(canon.key.toLowerCase());
    }
  }
  const out = new Set<string>();
  if (!off.size) return out;
  for (const [addOn, triggers] of Object.entries(ADDON_WARRANTED_BY)) {
    const hit = triggers.some((label) => {
      const canon = canonicalMarker(label);
      return off.has(label.toLowerCase()) || off.has(canon.name.toLowerCase()) || off.has(canon.key.toLowerCase());
    });
    if (hit) out.add(addOn);
  }
  return out;
}
// How far out a dated recheck stays worth listing as "upcoming".
const UPCOMING_HORIZON_DAYS = 180;

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
  const days = daysBetweenISO(nextDue, asOf);
  if (days == null) return null;
  if (days <= 0) return "window is open";
  return `opens in ${humanHorizon(days)}`;
}

// One collapsed doctor-loop follow-up → a checkup line. The item already carries its
// readable label, kind and earliest open due date (doctor-loop-items.ts). The `why` is
// the loop spoken to a person (spokenLoopReason): the lab's range and the optimal band
// as separate facts, never the stored reason's merged "optimal/lab range" clause.
function toCheckupItem(
  item: DoctorLoopItem,
  asOf: string,
  dexaWhenText: string | null,
  markers: MarkerLike[] = []
): CheckupItem {
  // The DEXA re-scan reads as a soft window ("worth considering around …"), matching
  // Train's forward timeline — never a bare due date, though attention's next_due stays
  // the scheduling key. Falls back to the calm horizon phrasing if no window is known.
  const when_text =
    item.kind === "dexa" && dexaWhenText ? dexaWhenText : dueWhenText(item.next_due, asOf);
  return {
    signal_key: item.signal_key,
    label: item.label,
    kind: item.kind,
    next_due: item.next_due,
    when_text,
    why: spokenLoopReason(item, { markers: markers as any[], asOf }),
  };
}

function markerValueText(raw: MarkerLike, system: LabUnitSystem): string | null {
  // In the athlete's lab-unit system (src/repo/lab-display.ts), unit always attached.
  const m = presentMarkerRow(raw, system);
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
  const days = daysBetweenISO(entry.next_due, asOf);
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
  const labSystem = labUnitSystem(); // once for the whole pass
  for (const [key, { marker, via }] of acc) {
    const status = followStatus(marker);
    const rc = recheckReadFor(marker, attentionBySignal, asOf);
    items.push({
      marker: String(marker.name ?? key),
      marker_key: key,
      via,
      status,
      status_text: STATUS_TEXT[status],
      latest_value: markerValueText(marker, labSystem),
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
  // The same wording the packet's visit questions use (src/repo/loop-speech.ts).
  for (const item of dueNow) if (item.kind === "lab" || item.kind === "review") pushQ(recheckQuestion(item));
  for (const item of addOns.slice(0, 2)) pushQ(workupQuestion(item.label));
  // Interventions in motion whose target marker has no recheck on the calendar yet.
  for (const ft of followThrough) if (ft.recheck === "none") pushQ(followThroughQuestion(ft.marker));

  return { ordered_labs: orderedLabs, bring, questions };
}

// ---- one visit ----------------------------------------------------------------
// Each recheck opens on its own cadence, so read one by one they ask for a trip to the
// lab every few weeks. Folded, they ask for one: the earliest ~5-day window that sits
// on/after the LATEST opening among rechecks opening within ~10 weeks — so one draw
// covers the most open windows — and at least two weeks after a dated race that falls
// before it (a race can briefly raise hs-CRP and lower testosterone). A recheck whose
// window is already open folds into that same visit (`past_window`) instead of reading
// as overdue on its own. The DEXA re-scan joins when it is due by the visit; it never
// pushes the labs later. Deterministic, informational — a suggestion, never a booking.

const VISIT_HORIZON_DAYS = 70; // "opening within ~10 weeks"
const VISIT_WINDOW_DAYS = 5; // start .. start + 4
const RACE_CLEARANCE_DAYS = 14;
const MAX_VISIT_ADDS = 3;

const VISIT_LAB_PREP = [
  "A morning draw before 10 a.m., fasted overnight — water is fine.",
  "No hard training the day before; a hard session can nudge hs-CRP up and testosterone down for a day or so.",
];
const VISIT_DEXA_PREP =
  "For the DEXA scan, the same conditions as the last one — same time of day, same fasting and hydration, no training beforehand — so the two scans compare cleanly.";

function roundLb(v: number): number {
  return Math.round(v * 10) / 10;
}

// The body weight on the day of the last scan: the scan's own weight/total-mass line,
// else a logged weigh-in within a few days of it, else the scan's fat + lean + bone sum.
function dexaScanWeight(markers: MarkerLike[], scanDate: string): number | null {
  const pointOn = (m: MarkerLike | undefined, date: string, slackDays = 0): number | null => {
    const points = Array.isArray((m as any)?.points)
      ? ((m as any).points as Array<{ date?: unknown; value?: unknown }>)
      : [];
    let best: { gap: number; value: number } | null = null;
    for (const p of points) {
      const gap = Math.abs(daysBetweenISO(String(p?.date ?? "").slice(0, 10), date) ?? Number.POSITIVE_INFINITY);
      const value = Number(p?.value);
      if (gap > slackDays || !Number.isFinite(value) || value <= 0) continue;
      if (!best || gap < best.gap) best = { gap, value };
    }
    return best?.value ?? null;
  };
  const byName = (re: RegExp, dexaOnly: boolean) =>
    markers.find((m) => re.test(String(m.name ?? m.key ?? "")) && (!dexaOnly || m.latest?.kind === "dexa"));
  const lbUnit = (m: MarkerLike | undefined) => /^(lb|lbs|pounds?)$/i.test(String(m?.unit ?? "").trim());
  const scanMass = byName(/\b(total (body )?mass|body weight|weight)\b/i, true);
  if (scanMass && lbUnit(scanMass)) {
    const v = pointOn(scanMass, scanDate);
    if (v != null) return roundLb(v);
  }
  const weighIn = pointOn(byName(/^body weight$/i, false), scanDate, 3);
  if (weighIn != null) return roundLb(weighIn);
  const parts = [
    /^fat mass \(total\)$|^fat mass total$/i,
    /^lean mass \(total\)$|^lean mass total$/i,
    /bone mineral content/i,
  ]
    .map((re) => byName(re, true))
    .map((m) => (m && lbUnit(m) ? pointOn(m, scanDate) : null));
  if (parts.every((v) => v != null)) return roundLb((parts as number[]).reduce((a, b) => a + b, 0));
  return null;
}

function currentWeight(asOf: string, after: string | null): number | null {
  try {
    const w = resolvedCurrentBodyweight(getProfile(), asOf);
    // A dated scale point only, and one taken after the scan — a profile fallback or an
    // older weigh-in says nothing about the change since.
    if (!w?.date || (after && w.date <= after)) return null;
    const lb = Number(w.weight_lb);
    return Number.isFinite(lb) && lb > 0 ? roundLb(lb) : null;
  } catch {
    return null;
  }
}

function dexaVisitWhy(lastDate: string | null, lastLb: number | null, nowLb: number | null): string {
  const when = lastDate ? ` on ${shortDate(lastDate)}` : "";
  if (lastLb != null && nowLb != null) {
    const diff = roundLb(nowLb - lastLb);
    if (Math.abs(diff) >= 1) {
      return `Your last scan${when} was at ${lastLb} lb and you're about ${Math.abs(diff)} lb ${diff < 0 ? "lighter" : "heavier"} now, so a repeat shows how much of that change was fat and how much was lean mass.`;
    }
    return `Your weight is about where it was at the last scan${when}, so a repeat shows whether the mix of fat and lean mass has shifted underneath it.`;
  }
  return `A repeat a few months after the last scan${when} shows how body composition has moved.`;
}

// The newest reading behind a follow-up: its own cadence row's reading date, else the
// newest marker-cadence row it folds. Review/directive rows date a decision, not a draw.
function visitLabLastDate(item: DoctorLoopItem): string | null {
  const isDate = (d: unknown) => /^\d{4}-\d{2}-\d{2}/.test(String(d ?? ""));
  if (item.signal_key.startsWith("marker:") && isDate(item.last_checked)) return String(item.last_checked).slice(0, 10);
  let best: string | null = null;
  for (const src of item.sources ?? []) {
    if (!src.signal_key.startsWith("marker:") || !isDate(src.last_checked)) continue;
    const d = String(src.last_checked).slice(0, 10);
    if (!best || d > best) best = d;
  }
  return best;
}

function countWord(n: number): string {
  return ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
}

export function composeVisit(args: {
  loop: DoctorLoopItem[];
  asOf: string;
  markers: MarkerLike[];
  addOns?: CheckupItem[];
  race?: { date: string; event?: string | null } | null;
}): CheckupVisit | null {
  const { loop, asOf, markers } = args;
  const horizon = addDaysISO(asOf, VISIT_HORIZON_DAYS) ?? asOf;
  const dated = loop.filter((item) => !!item.next_due && String(item.next_due) <= horizon);
  const labItems = dated.filter((item) => item.kind !== "dexa");
  const dexaItem = dated.find((item) => item.kind === "dexa") ?? null;
  if (!labItems.length && !dexaItem) return null;

  // The latest opening among the labs (the DEXA scan alone sets the date only when it is
  // the whole visit); never before today.
  const openings = (labItems.length ? labItems : [dexaItem as DoctorLoopItem]).map((i) => String(i.next_due));
  let start = openings.reduce((a, b) => (b > a ? b : a), asOf);
  const race = args.race && /^\d{4}-\d{2}-\d{2}$/.test(String(args.race.date)) ? args.race : null;
  let raceShapedIt = false;
  if (labItems.length && race) {
    const clear = addDaysISO(race.date, RACE_CLEARANCE_DAYS);
    const end = addDaysISO(start, VISIT_WINDOW_DAYS - 1) ?? start;
    // A race before (or inside) the window, too close to it: the window moves to two
    // weeks after the race.
    if (clear && race.date <= end && clear > start) {
      start = clear;
      raceShapedIt = true;
    } else if (clear && race.date <= end && race.date >= (addDaysISO(asOf, -RACE_CLEARANCE_DAYS) ?? asOf)) {
      raceShapedIt = true; // already clear of it — still worth saying why the date works
    }
  }
  const end = addDaysISO(start, VISIT_WINDOW_DAYS - 1) ?? start;

  const labs: CheckupVisitLab[] = labItems
    .filter((item) => String(item.next_due) <= end)
    .map((item) => ({
      label: item.label,
      last_date: visitLabLastDate(item),
      state: String(item.next_due) <= asOf ? ("past_window" as const) : ("opens_in_window" as const),
    }));

  let dexa: CheckupVisitDexa | null = null;
  if (dexaItem && String(dexaItem.next_due) <= end) {
    const lastDate =
      latestDexaDate(markers as any[]) ??
      (/^\d{4}-\d{2}-\d{2}/.test(String(dexaItem.last_checked ?? ""))
        ? String(dexaItem.last_checked).slice(0, 10)
        : null);
    const lastLb = lastDate ? dexaScanWeight(markers, lastDate) : null;
    const nowLb = currentWeight(asOf, lastDate);
    dexa = {
      last_date: lastDate,
      last_weight_lb: lastLb,
      current_weight_lb: nowLb,
      why: dexaVisitWhy(lastDate, lastLb, nowLb),
    };
  }
  if (!labs.length && !dexa) return null;

  const covered = new Set(labs.map((l) => l.label.toLowerCase()));
  const add: CheckupVisitAdd[] = labs.length
    ? (args.addOns ?? [])
        .filter((a) => !covered.has(a.label.toLowerCase()))
        .slice(0, MAX_VISIT_ADDS)
        .map((a) => ({ label: a.label, why: a.why }))
    : [];

  const span = `between ${shortDate(start)} and ${shortDate(end)}`;
  const parts: string[] = [];
  if (labs.length) {
    const open = labs.filter((l) => l.state === "past_window").length;
    parts.push(
      labs.length === 1
        ? `One morning draw ${span} covers the recheck that's open or opening.`
        : `One morning draw ${span} covers all ${countWord(labs.length)} rechecks that are open or opening.`
    );
    if (open > 0 && open < labs.length)
      parts.push(
        `The ${open === 1 ? "one" : countWord(open)} already open ${open === 1 ? "folds" : "fold"} into the same visit rather than each needing a trip of its own.`
      );
    if (raceShapedIt && race) {
      const name = String(race.event ?? "").trim() || "your race";
      parts.push(
        `It sits at least two weeks after ${name} on ${shortDate(race.date)}, since a race can briefly raise hs-CRP and lower testosterone.`
      );
    }
    if (dexa) parts.push("The repeat DEXA scan fits the same visit.");
  } else {
    parts.push(`A repeat DEXA scan fits ${span}.`);
  }

  const prep = [...(labs.length ? VISIT_LAB_PREP : []), ...(dexa ? [VISIT_DEXA_PREP] : [])];
  return { window_start: start, window_end: end, why: parts.join(" "), labs, add, dexa, prep };
}

// ---- lede ---------------------------------------------------------------------
// One follow-up's window as a sentence: the marker list in plain speech, the DEXA scan
// by its own name, a review follow-up in its own words. `extra` rides before the stop.
function ledeLine(item: CheckupItem, extra = ""): string {
  const subject =
    item.kind === "dexa"
      ? "a repeat body-composition (DEXA) scan"
      : item.kind === "review"
        ? `"${item.label}"`
        : `a ${spokenMarkerName(item.label)} recheck`;
  const when = String(item.when_text ?? "window is open");
  if (when.startsWith("window is open")) return `The window for ${subject} is open${when.slice(14)}${extra}.`;
  if (when.startsWith("opens in")) return `The window for ${subject} ${when}${extra}.`;
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} is ${when}${extra}.`;
}

function composeLede(
  dueNow: CheckupItem[],
  upcomingDated: CheckupItem[],
  orderedLabs: OrderedLab[],
  followThrough: FollowThroughItem[],
  warrantedAddOns: CheckupItem[] = [],
  asOf: string = todayISO()
): string {
  if (dueNow.length) return ledeLine(dueNow[0], dueNow.length > 1 ? `, plus ${dueNow.length - 1} more` : "");
  const soonest = upcomingDated[0];
  if (soonest && soonest.when_text) return ledeLine(soonest);
  if (orderedLabs.length) return "Your last visit left labs to bring in — nothing's due to recheck on Cairn's side yet.";
  if (warrantedAddOns.length) return pickDayVariant(ADDON_LEDE_LINES, asOf, "next-checkup:lede:addons");
  if (followThrough.length) return "No rechecks are due — a few things you're doing are still working; here's where they stand.";
  return "Nothing's due for a recheck right now. Your markers are quiet — Cairn will flag the next window when it opens.";
}

// The dated race the visit keeps clear of: the endurance goal's race date.
function visitRace(asOf: string): { date: string; event: string | null } | null {
  try {
    const goal = getEnduranceGoal(asOf) as any;
    if (!goal?.is_race || !/^\d{4}-\d{2}-\d{2}$/.test(String(goal.date ?? ""))) return null;
    return { date: String(goal.date), event: goal.event ? String(goal.event) : null };
  } catch {
    return null;
  }
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

  // A draw that measured a derivable marker's components counts as a check of it too
  // (non-HDL-C from TC + HDL) — the same reading the doctor loop files its cadence from.
  const markers = withDerivedReadings((getMarkerHistory() as { markers: MarkerLike[] }).markers);
  const markerByKey = new Map<string, MarkerLike>();
  for (const m of markers) {
    const key = String(m.key ?? m.name ?? "").toLowerCase();
    if (key && !markerByKey.has(key)) markerByKey.set(key, m);
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

  // Per-marker cadence rows, for the follow-through recheck state.
  const schedule = [
    ...listAttentionSchedule({ domain: "health", limit: 80 }),
    ...listAttentionSchedule({ domain: "body", limit: 20 }),
  ];
  const attentionBySignal = new Map<string, AttentionScheduleEntry>();
  for (const e of schedule) if (!attentionBySignal.has(e.signal_key)) attentionBySignal.set(e.signal_key, e);

  // The doctor loop, one item per real follow-up: a panel's cadence, directive and
  // review rows are already folded into one item carrying the earliest open due date.
  const loop = doctorLoopItems({ asOf, markers: markers as any[] });
  const dueNow: CheckupItem[] = loop
    .filter((item) => item.due)
    .map((item) => toCheckupItem(item, asOf, dexaWhenText, markers as MarkerLike[]));

  // Upcoming = dated items not yet due, within the horizon.
  const upcomingDated: CheckupItem[] = loop
    .filter((item) => {
      if (!item.next_due || item.due) return false;
      const days = daysBetweenISO(item.next_due, asOf);
      return days != null && days > 0 && days <= UPCOMING_HORIZON_DAYS;
    })
    .map((item) => toCheckupItem(item, asOf, dexaWhenText, markers as MarkerLike[]));

  // Missing high-value workups → calm "worth adding" suggestions (no date). A workup a
  // currently-flagged marker actually warrants is listed FIRST and says why — and it is
  // the one kind of add-on that can raise the tile on its own (owner ruling R3).
  const warrantedKeys = warrantedAddOnKeys(markerByKey);
  const addOns: WarrantedCheckupItem[] = (recommendedPanel() as any[])
    .map((item) => {
      const warranted = warrantedKeys.has(String(item.key));
      const why = `${String(item.reason)} ${String(item.cadence_note)}`.trim();
      return {
        signal_key: `add:${String(item.key)}`,
        label: String(item.label),
        kind: "add" as const,
        next_due: null,
        when_text: null,
        why: warranted
          ? `${why} ${pickDayVariant(ADDON_WARRANTED_LINES, asOf, `next-checkup:addon:${String(item.key)}`)}`.trim()
          : why,
        warranted,
      };
    })
    .sort((a, b) => Number(b.warranted) - Number(a.warranted));
  const warrantedAddOns = addOns.filter((a) => a.warranted);

  const upcoming: CheckupItem[] = [
    ...upcomingDated.slice(0, 8),
    ...addOns.slice(0, 6).map(({ warranted: _warranted, ...item }) => item),
  ];

  const followThrough = composeFollowThrough(markerByKey, attentionBySignal, asOf);
  const orderedLabs = scanOrderedLabs();
  const prep = composePrep(dueNow, addOns, followThrough, orderedLabs);
  const lede = composeLede(dueNow, upcomingDated, orderedLabs, followThrough, warrantedAddOns, asOf);
  const visit = composeVisit({
    loop,
    asOf,
    markers: markers as MarkerLike[],
    addOns: warrantedAddOns.map(({ warranted: _warranted, ...item }) => item),
    race: visitRace(asOf),
  });


  const upcomingSoon = upcomingDated.some((e) => {
    const d = daysBetweenISO(e.next_due || "", asOf);
    return d != null && d <= SOON_DAYS;
  });
  const has_content = dueNow.length > 0 || upcomingSoon || orderedLabs.length > 0 || warrantedAddOns.length > 0;

  return { lede, due_now: dueNow, upcoming, follow_through: followThrough, prep, visit, has_content, frame: FRAME };
}
