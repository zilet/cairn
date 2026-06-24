import { localDateISO } from "./shared.js";
import { listContextEvents } from "./health.js";

// ============================================================================
// THE ACTIVE-CONTEXT EFFECT — a one-mention life event shapes the day, then fades.
//
// An athlete says it once ("late loud concert last night", "travelling this week",
// "fighting a cold", "brutal week at work") as a context_event, and the system
// understands what that MEANS for the day and the labs WITHOUT being told again:
// expect worse sleep, treat an acute inflammation marker as transient (don't cap
// training on it), pull load back, know fueling is disrupted. Then it FADES — a
// late night is gone in a couple of days, a transient-inflammation window aligns
// to the acute-marker horizon, so a stale event never keeps shaping the day forever.
//
// DETERMINISTIC + PURE + null-safe: no agent calls, never throws, returns an empty
// shape when there's nothing to say. Word-bounded regexes (an `isAcuteMarker`-style
// floor) — never a score, only plain words + booleans the higher layers voice calmly.
// ============================================================================

// Decay defaults (days) when an event carries no explicit end_date. A late night
// is a 1-2 day thing; acute stress / a passing illness, several days; a
// transient-inflammation tail aligns to the acute-marker horizon (~14d) so a CRP
// drawn in the window reads informational, not a daily training cap.
const DECAY_LATE_NIGHT_DAYS = 2;
const DECAY_STRESS_DAYS = 5;
const DECAY_ILLNESS_DAYS = 5;
const DECAY_TRANSIENT_INFLAMMATION_DAYS = 14;

// Word-bounded classifiers. A late LOUD night (concert/party/show) wrecks sleep AND
// is a brief inflammatory load (alcohol, sleep debt, late food) → both flags.
const LATE_NIGHT_RE = /\b(late night|late-night|stayed? up late|up late|concert|gig|festival|show|party|partied|club|clubbing|rave|loud|wedding|bar crawl|night out|out late|red[- ]?eye|jet ?lag)\b/i;
// Plain acute stress / a poor night → expect worse sleep (no inflammation claim).
const STRESS_RE = /\b(stress(ed|ful)?|burn(ed|t)? ?out|overwhelmed|anxious|anxiety|deadline|crunch|hard week|brutal week|rough week|tough week|work(ing)? late|poor sleep|bad sleep|short sleep|barely slept|couldn'?t sleep|no sleep|restless|insomnia)\b/i;
// Illness — a generalization of the intelligence.ts expenditureDisruptedNow regex,
// broadened with the everyday words an athlete uses ("under the weather", "run down",
// "sore throat", "congested"). Word-bounded so e.g. "bug" in "debug" never matches.
const ILLNESS_RE = /\b(ill|illness|sick|sickness|flu|fever|cold|covid|infection|food ?poison|stomach|gastro|bug|virus|unwell|under the weather|run[- ]?down|sore throat|cough|congest(ed|ion)|sinus|migraine)\b/i;
// Travel / a trip → fueling is disrupted (restaurants, schedule, no scale).
const TRAVEL_RE = /\b(travel(l)?(ing|ed)?|trip|flight|flying|abroad|vacation|holiday|away|on the road|hotel|conference|business trip)\b/i;

export interface ActiveContextItem {
  title: string;
  kind: string;
  expect_worse_sleep: boolean;
  transient_inflammation: boolean;
  reduce_load: boolean;
  fueling_disrupted: boolean;
  decays_on: string | null;          // YYYY-MM-DD the effect fades on (inclusive end), or null = open-ended
  reason: string;                    // one plain-words line — never a score
}

export interface ContextEffect {
  active: ActiveContextItem[];
  expect_worse_sleep: boolean;
  transient_inflammation: boolean;
  reduce_load: boolean;
  fueling_disrupted: boolean;
  any: boolean;
}

// The searchable text of a context_event: kind + title + detail + meta.impact.
// meta may arrive parsed (hydrateContextEvent) or as a raw JSON string.
function eventText(ev: any): string {
  let meta: any = ev?.meta;
  if (meta == null && ev?.meta_json) { try { meta = JSON.parse(ev.meta_json); } catch { meta = null; } }
  const impact = meta && typeof meta === "object" ? meta.impact : null;
  return `${ev?.kind ?? ""} ${ev?.title ?? ""} ${ev?.detail ?? ""} ${impact ?? ""}`.trim();
}

// Add N days to a YYYY-MM-DD string → a YYYY-MM-DD string (UTC, DST-safe for a
// plain day count). Returns null on an unparseable date.
function addDaysISO(iso: string, days: number): string | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 864e5).toISOString().slice(0, 10);
}

// Classify one event into its effect flags + a decay horizon. Returns null when
// nothing matches (a plain family commitment, an injury with no inflammation word,
// etc.) so a non-matching event stays silent.
function classifyEvent(ev: any): ActiveContextItem | null {
  const text = eventText(ev);
  if (!text) return null;

  let expect_worse_sleep = false;
  let transient_inflammation = false;
  let reduce_load = false;
  let fueling_disrupted = false;
  const reasons: string[] = [];

  // A trip context_event always disrupts fueling (kind alone is enough), and its
  // text may also name illness/late-nights while travelling.
  const isTripKind = ev?.kind === "trip";

  if (LATE_NIGHT_RE.test(text)) {
    expect_worse_sleep = true;
    transient_inflammation = true;
    reasons.push("a late night out tends to cost sleep and stir up brief inflammation");
  }
  if (STRESS_RE.test(text)) {
    expect_worse_sleep = true;
    reasons.push("a stressful stretch usually means thinner sleep");
  }
  if (ILLNESS_RE.test(text)) {
    reduce_load = true;
    transient_inflammation = true;
    fueling_disrupted = true;
    reasons.push("an illness is worth easing load for, and it can lift inflammation and disrupt eating");
  }
  if (isTripKind || TRAVEL_RE.test(text)) {
    fueling_disrupted = true;
    reasons.push("travel tends to scramble fueling and the routine");
  }

  if (!expect_worse_sleep && !transient_inflammation && !reduce_load && !fueling_disrupted) {
    return null; // nothing this engine knows how to read — stay silent
  }

  // Decay horizon: an explicit end_date wins; otherwise a tag default. When the
  // event raises transient inflammation, the window is at LEAST the acute-marker
  // horizon (so a CRP drawn during it reads informational), but a real end_date
  // still bounds it. Pick the longest applicable default among matched effects,
  // anchored to the start date (falling back to open-ended if none).
  const start = ev?.start_date && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.start_date)) ? String(ev.start_date) : null;
  const end = ev?.end_date && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.end_date)) ? String(ev.end_date) : null;
  let decays_on: string | null = null;
  if (end) {
    decays_on = end;
  } else if (start) {
    let days = 0;
    if (LATE_NIGHT_RE.test(text)) days = Math.max(days, DECAY_LATE_NIGHT_DAYS);
    if (STRESS_RE.test(text)) days = Math.max(days, DECAY_STRESS_DAYS);
    if (reduce_load) days = Math.max(days, DECAY_ILLNESS_DAYS);
    if (transient_inflammation) days = Math.max(days, DECAY_TRANSIENT_INFLAMMATION_DAYS);
    decays_on = days > 0 ? addDaysISO(start, days) : null;
  }
  // No start AND no end → open-ended (decays_on null); an active-only fetch already
  // bounds it to "not yet ended", so it simply rides until archived.

  return {
    title: String(ev?.title ?? "").trim() || "Recent event",
    kind: String(ev?.kind ?? "life_event"),
    expect_worse_sleep,
    transient_inflammation,
    reduce_load,
    fueling_disrupted,
    decays_on,
    reason: reasons.join("; "),
  };
}

// Is `date` still inside this item's active window? Started on/before `date`, and
// not yet past its decay horizon. An item with no decays_on is open-ended (active
// until archived / its end_date passes — already bounded by the active-only fetch).
function withinWindow(ev: any, item: ActiveContextItem, date: string): boolean {
  const start = ev?.start_date && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.start_date)) ? String(ev.start_date) : null;
  if (start && start > date) return false;                 // hasn't started yet
  if (item.decays_on && item.decays_on < date) return false; // faded
  return true;
}

// The headline read: the active context effect as of `date` (local today by
// default). Reads the active context_events, classifies each, keeps only those
// still inside their window, and ORs the flags across them. `events` may be passed
// in (testing / a caller that already has them) to skip the DB read.
export function activeContextEffect(date?: string, events?: any[]): ContextEffect {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDateISO();
  let rows: any[];
  if (Array.isArray(events)) {
    rows = events;
  } else {
    try { rows = listContextEvents({ activeOnly: true }) as any[]; } catch { rows = []; }
  }

  const active: ActiveContextItem[] = [];
  for (const ev of rows) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.archived) continue; // a passed-in (non-active-only) list may include archived rows
    const item = classifyEvent(ev);
    if (!item) continue;
    if (!withinWindow(ev, item, d)) continue;
    active.push(item);
  }

  const eff: ContextEffect = {
    active,
    expect_worse_sleep: active.some((a) => a.expect_worse_sleep),
    transient_inflammation: active.some((a) => a.transient_inflammation),
    reduce_load: active.some((a) => a.reduce_load),
    fueling_disrupted: active.some((a) => a.fueling_disrupted),
    any: active.length > 0,
  };
  return eff;
}

// True when an acute inflammation marker drawn on `readingDate` falls inside an
// active transient-inflammation window — so the connected brain can read that
// reading as INFORMATIONAL ("likely the concert / hard week / cold talking"),
// not as a standing training cap. Conservative: requires the effect to actually
// carry transient_inflammation AND the reading to sit between an item's start
// (when known) and its decay horizon. eff defaults to the current effect.
export function markerInTransientWindow(readingDate: string, eff?: ContextEffect): boolean {
  if (!readingDate || !/^\d{4}-\d{2}-\d{2}$/.test(readingDate)) return false;
  const e = eff ?? activeContextEffect();
  if (!e?.transient_inflammation) return false;
  for (const item of e.active) {
    if (!item.transient_inflammation) continue;
    // Inside the window: not after its decay horizon (when known). A null
    // decays_on means open-ended — any reading on/before "now" qualifies.
    if (item.decays_on && readingDate > item.decays_on) continue;
    return true;
  }
  return false;
}

// The acute-marker test — re-exported from its canonical home (propagation), the natural
// companion guard for gating `markerInTransientWindow` on the marker being acute-phase
// (hs-CRP, CK, ESR, WBC) not structural/chronic (ApoB, LDL, Lp(a)). The feared cycle
// doesn't exist (propagation does not import this module); resolving it through propagation
// keeps ONE classifier with ONE chronic-cluster guard.
export { isAcuteMarker } from "./propagation.js";
