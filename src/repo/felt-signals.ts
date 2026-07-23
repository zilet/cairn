// FELT SIGNALS — the brain learns from what the athlete SAYS they feel.
//
// Four subjective signals are collected across the app but were structurally
// forgotten: they colored a single prompt and never entered longitudinal
// learning. This module turns three of them into bounded, deterministic,
// null-safe patterns the day-read and coach context can speak to (the fourth —
// insight thumbs-down — feeds the insight dedup corpus in coach.ts):
//
//   1) override_rhythm  — the athlete keeps steering the Brief the same way on
//      the same weekday (e.g. Mondays keep ending up rest days). The day read may
//      PRE-ACKNOWLEDGE this on the matching weekday — never gate on it.
//   2) checkin_signal   — a persistent subjective read (energy running low most
//      mornings, sleep_feel consistently poor) → one calm context line.
//   3) fueling_response — after a nutrition-target change, the follow-through
//      energy/hunger reads become evidence for a softer (or steady) next step.
//
// CONSTITUTION (binding): calm, no numeric scores, pull-never-push, adherence-
// NEUTRAL (a felt signal is information, never blame), a SUGGESTION never a gate.
// Learned claims use humble framing ("has often ended up", "tends to"). Sparse
// data produces NOTHING — a thin week can never manufacture a negative claim.
//
// Deterministic + agent-free + null-safe: every builder is wrapped so one bad
// query can never sink the model, and absent signals yield zero output.

import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { localDateISO } from "./shared.js";

export interface FeltSignalPattern {
  id: string;
  kind: "override_rhythm" | "checkin_signal" | "fueling_response";
  statement: string;
  confidence: "tentative" | "observed";
  evidence_n: number;
  domains: string[];
  // 0-6 (Sun..Sat) when the pattern is anchored to a weekday (override_rhythm);
  // null otherwise. The day read only PRE-ACKNOWLEDGES a weekday pattern when
  // today's weekday matches — a Monday tendency stays quiet the rest of the week.
  weekday: number | null;
  // INTERNAL only — counts/fractions the builder reasoned with. NEVER surfaced as
  // a number/grade (the constitution bans scores); stripped by feltSignalsForCoach.
  params?: Record<string, number>;
}

const FELT_SIGNALS_VERSION = 1;

// ---- deterministic thresholds (named, so the gates are auditable) -----------

// 1) override rhythm
const OVERRIDE_WINDOW_DAYS = 90; // how far back a steer is still "lately"
const OVERRIDE_MIN_RECUR = 3; // >=3 same-weekday (or same-steer) overrides to speak
const OVERRIDE_RECENT_OCCURRENCES = 6; // look at each weekday's last <=6 recorded days
const OVERRIDE_RECUR_FRACTION = 0.5; // and the steers must DOMINATE them (> half, strict)

// 2) check-in signals
const CHECKIN_WINDOW_DAYS = 21;
const CHECKIN_MIN_SAMPLES = 4; // need >=4 real check-ins before saying anything
const CHECKIN_LOW_MAX = 2; // energy/sleep_feel <=2 (of 1-5) reads as "low/poor"
const CHECKIN_PERSIST_FRACTION = 0.6; // >=60% of samples low to call it persistent

// 3) fueling response
const FUELING_WINDOW_DAYS = 30;
const FUELING_MIN_SAMPLES = 2; // a follow-through window is short; 2 reads is realistic
const FUELING_PERSIST_FRACTION = 0.6;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---- small local helpers ----------------------------------------------------

function isoDaysAgo(dateISO: string, n: number): string {
  const base = Date.parse(dateISO + "T00:00:00Z");
  return new Date(base - n * 864e5).toISOString().slice(0, 10);
}

// Calendar weekday (0=Sun..6=Sat) of a local date key. Uses UTC getters over the
// date's own midnight so the weekday is a pure function of the Y/M/D string,
// independent of the process timezone.
function weekdayOf(dateISO: string): number | null {
  const t = Date.parse(dateISO + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCDay();
}

function normSteer(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function kindWord(kind: unknown): string | null {
  const k = String(kind ?? "").toLowerCase();
  if (k === "rest") return "rest";
  if (k === "easy") return "easy";
  if (k === "train" || k === "done") return "training";
  return null;
}

// ---------------------------------------------------------------------------
// 1) override_rhythm — the athlete keeps steering the Brief the same way. Reads
//    the recorded day_read SUGGESTIONS (canonical reads carry override:null; a
//    steered read carries the steer text), grouped by weekday. Gate: a weekday
//    whose last <=6 recorded days were steered on >=3 of them AND >=half.
// ---------------------------------------------------------------------------
function overrideRhythm(refDate: string): FeltSignalPattern | null {
  const since = isoDaysAgo(refDate, OVERRIDE_WINDOW_DAYS);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, payload_json FROM suggestions
          WHERE kind = 'day_read' AND date IS NOT NULL AND date >= ? AND date <= ?
          ORDER BY date ASC, id ASC`
      )
      .all(since, refDate) as any[];
  } catch {
    return null;
  }
  if (!rows.length) return null;

  // Collapse to one record per date: a date is "steered" if ANY row for it carried
  // a non-null override; keep that steer text + the resulting read kind.
  const byDate = new Map<string, { steered: boolean; steer: string; kind: string }>();
  for (const r of rows) {
    const date = String(r.date ?? "").slice(0, 10);
    if (!date) continue;
    let payload: any = null;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      payload = null;
    }
    const override = payload && payload.override != null ? normSteer(payload.override) : "";
    const cur = byDate.get(date) ?? { steered: false, steer: "", kind: "" };
    if (override) {
      cur.steered = true;
      cur.steer = override;
      cur.kind = String(payload?.kind ?? cur.kind ?? "");
    } else if (!cur.kind) {
      cur.kind = String(payload?.kind ?? "");
    }
    byDate.set(date, cur);
  }
  if (![...byDate.values()].some((v) => v.steered)) return null;

  // Group recorded dates by weekday, most-recent first.
  const byWeekday = new Map<number, Array<{ date: string; steered: boolean; steer: string; kind: string }>>();
  for (const [date, v] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const wd = weekdayOf(date);
    if (wd == null) continue;
    const arr = byWeekday.get(wd) ?? [];
    arr.push({ date, ...v });
    byWeekday.set(wd, arr);
  }

  let best: {
    weekday: number;
    steeredN: number;
    recentTotal: number;
    kind: string | null;
    last: string;
  } | null = null;
  for (const [wd, days] of byWeekday) {
    const recent = days.slice(0, OVERRIDE_RECENT_OCCURRENCES);
    const steered = recent.filter((d) => d.steered);
    if (steered.length < OVERRIDE_MIN_RECUR) continue;
    if (steered.length / recent.length <= OVERRIDE_RECUR_FRACTION) continue;
    // Dominant resulting kind across the steered days on this weekday.
    const kindCount = new Map<string, number>();
    for (const d of steered) {
      const kw = kindWord(d.kind);
      if (kw) kindCount.set(kw, (kindCount.get(kw) ?? 0) + 1);
    }
    const domKind = [...kindCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!best || steered.length > best.steeredN) {
      best = { weekday: wd, steeredN: steered.length, recentTotal: recent.length, kind: domKind, last: steered[0].date };
    }
  }
  if (!best) return null;

  const wdName = WEEKDAY_NAMES[best.weekday] ?? "That day";
  const kindClause = best.kind ? ` ended up ${best.kind} days` : " been steered off the default";
  const statement = `${wdName}s have often${kindClause} lately — today's read can honor that if it fits, but you still drive.`;
  return {
    id: "override_rhythm",
    kind: "override_rhythm",
    statement,
    confidence: best.steeredN >= 5 ? "observed" : "tentative",
    evidence_n: best.steeredN,
    domains: ["training", "recovery"],
    weekday: best.weekday,
    params: { steered_n: best.steeredN, recent_total: best.recentTotal },
  };
}

// ---------------------------------------------------------------------------
// 2) checkin_signal — a persistent subjective read across recent morning
//    check-ins. Energy running low, or sleep_feel consistently poor. Emits the
//    single strongest signal. Gate: >=4 samples AND >=60% of them low. Sparse
//    data yields NOTHING (adherence-neutral: thin logging never earns a claim).
// ---------------------------------------------------------------------------
function checkinSignal(refDate: string): FeltSignalPattern | null {
  const since = isoDaysAgo(refDate, CHECKIN_WINDOW_DAYS);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, energy, sleep_feel FROM checkins
          WHERE date >= ? AND date <= ?
          ORDER BY date DESC, id DESC`
      )
      .all(since, refDate) as any[];
  } catch {
    return null;
  }
  if (!rows.length) return null;

  const analyze = (col: "energy" | "sleep_feel") => {
    const vals = rows.map((r) => Number(r[col])).filter((v) => Number.isFinite(v) && v >= 1 && v <= 5);
    if (vals.length < CHECKIN_MIN_SAMPLES) return null;
    const low = vals.filter((v) => v <= CHECKIN_LOW_MAX).length;
    const frac = low / vals.length;
    if (frac < CHECKIN_PERSIST_FRACTION) return null;
    return { samples: vals.length, low, frac };
  };

  const candidates: Array<{ col: "energy" | "sleep_feel"; samples: number; low: number; frac: number }> = [];
  for (const col of ["energy", "sleep_feel"] as const) {
    const a = analyze(col);
    if (a) candidates.push({ col, ...a });
  }
  if (!candidates.length) return null;
  // The strongest = the higher low-fraction, then more samples.
  candidates.sort((a, b) => b.frac - a.frac || b.samples - a.samples);
  const top = candidates[0];

  const statement =
    top.col === "energy"
      ? "You've been reading low on energy most check-ins lately — no judgement, just worth protecting recovery and not forcing the hard days."
      : "You've been reporting rough sleep most check-ins lately — worth planning lighter mornings after the roughest nights.";
  return {
    id: `checkin_${top.col}`,
    kind: "checkin_signal",
    statement,
    confidence: top.samples >= 8 ? "observed" : "tentative",
    evidence_n: top.samples,
    domains: top.col === "energy" ? ["recovery", "training"] : ["recovery"],
    weekday: null,
    params: { samples: top.samples, low: top.low },
  };
}

// ---------------------------------------------------------------------------
// 3) fueling_response — after a nutrition-target change, the one-tap follow-
//    through reads (energy 1-3 running-low..plenty; hunger 1-3) become evidence
//    for the next step. Persistent running-low energy / high hunger → a gentler
//    step may sit better; steady/plenty → it's landing well. Adherence-neutral,
//    never blaming. Gate: >=2 linked reads on the most recent changed target.
// ---------------------------------------------------------------------------
function fuelingResponse(refDate: string): FeltSignalPattern | null {
  const since = isoDaysAgo(refDate, FUELING_WINDOW_DAYS);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, energy, hunger, decision_id FROM fueling_feedback
          WHERE decision_id IS NOT NULL AND date >= ? AND date <= ?
          ORDER BY date DESC, id DESC`
      )
      .all(since, refDate) as any[];
  } catch {
    return null;
  }
  if (!rows.length) return null;

  // Focus on the most recent changed target (largest decision_id present).
  const latestDecision = Math.max(...rows.map((r) => Number(r.decision_id)).filter(Number.isFinite));
  if (!Number.isFinite(latestDecision)) return null;
  const linked = rows.filter((r) => Number(r.decision_id) === latestDecision);
  if (linked.length < FUELING_MIN_SAMPLES) return null;

  const energies = linked.map((r) => Number(r.energy)).filter((v) => Number.isFinite(v) && v >= 1 && v <= 3);
  const hungers = linked.map((r) => Number(r.hunger)).filter((v) => Number.isFinite(v) && v >= 1 && v <= 3);
  const lowEnergy = energies.filter((v) => v === 1).length;
  const highHunger = hungers.filter((v) => v === 3).length;
  const energyStrained = energies.length >= FUELING_MIN_SAMPLES && lowEnergy / energies.length >= FUELING_PERSIST_FRACTION;
  const hungerStrained = hungers.length >= FUELING_MIN_SAMPLES && highHunger / hungers.length >= FUELING_PERSIST_FRACTION;

  // A comfortably-landing read: enough steady/plenty energy reads and no strain.
  const easyEnergy = energies.filter((v) => v >= 2).length;
  const landingWell =
    energies.length >= FUELING_MIN_SAMPLES && easyEnergy / energies.length >= FUELING_PERSIST_FRACTION && !hungerStrained;

  const samples = Math.max(energies.length, hungers.length);
  let statement: string | null = null;
  let params: Record<string, number> = { samples };
  if (energyStrained || hungerStrained) {
    const bits: string[] = [];
    if (energyStrained) bits.push("energy's been running low");
    if (hungerStrained) bits.push("hunger's been high");
    statement = `Since the last nutrition-target change, ${bits.join(" and ")} on most days you've checked — a gentler next step may sit better than pushing further. No blame; it's just how it's felt.`;
    params = { samples, low_energy: lowEnergy, high_hunger: highHunger };
  } else if (landingWell) {
    statement = "Since the last nutrition-target change, energy's held steady on most days you've checked — it seems to be landing well.";
    params = { samples, easy_energy: easyEnergy };
  }
  if (!statement) return null;
  return {
    id: "fueling_response",
    kind: "fueling_response",
    statement,
    confidence: samples >= 4 ? "observed" : "tentative",
    evidence_n: samples,
    domains: ["nutrition"],
    weekday: null,
    params,
  };
}

// ---- assembly ---------------------------------------------------------------

export function buildFeltSignals(refDate: string = localDateISO()): {
  version: number;
  patterns: FeltSignalPattern[];
} {
  const safe = (fn: () => FeltSignalPattern | null): FeltSignalPattern | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const patterns = [safe(() => overrideRhythm(refDate)), safe(() => checkinSignal(refDate)), safe(() => fuelingResponse(refDate))].filter(
    (p): p is FeltSignalPattern => p != null
  );
  return { version: FELT_SIGNALS_VERSION, patterns };
}

// Strip the INTERNAL params blob — a defensive guard so the surfaced read can
// NEVER leak a count/fraction even if a caller serializes it raw.
function publicPattern(p: FeltSignalPattern): FeltSignalPattern {
  const { params, ...rest } = p;
  return rest;
}

// Nightly insertion point (called alongside saveReactionModel). Caches the freshly
// built patterns into app_state so getCoachContext reads them cheaply; a fresh DB
// with no nightly run yet falls back to a live build in feltSignalsForCoach().
export function saveFeltSignals(): void {
  const model = buildFeltSignals();
  setAppState("felt_signals", JSON.stringify(model));
  setAppState("felt_signals_built_at", new Date().toISOString());
}

// The public read for getCoachContext: cached patterns (params stripped), fresh
// fallback on a cache miss. Calm + bounded — a few patterns at most.
export function feltSignalsForCoach(): { patterns: FeltSignalPattern[]; built_at: string | null } {
  let patterns: FeltSignalPattern[] = [];
  let builtAt: string | null = null;
  const cached = getAppState("felt_signals");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.patterns)) {
        patterns = parsed.patterns as FeltSignalPattern[];
        builtAt = getAppState("felt_signals_built_at");
      }
    } catch {
      /* corrupt cache → rebuild live */
    }
  }
  if (!patterns.length && !cached) patterns = buildFeltSignals().patterns;
  return { patterns: patterns.map(publicPattern), built_at: builtAt };
}

// The day-read consumption: the calm lines relevant to `date`. A weekday-anchored
// override pattern only surfaces when today's weekday matches (a pre-acknowledgement,
// never a gate); check-in / fueling patterns surface any day. Bounded to <=2 lines.
// Accepts pre-built patterns (from getCoachContext) to avoid a second build.
export function feltSignalDayLines(date: string, patterns?: FeltSignalPattern[]): string[] {
  const pats = patterns ?? feltSignalsForCoach().patterns;
  if (!Array.isArray(pats) || !pats.length) return [];
  const wd = weekdayOf(date);
  const lines: string[] = [];
  for (const p of pats) {
    if (!p || !p.statement) continue;
    if (p.weekday != null && p.weekday !== wd) continue; // weekday pattern, wrong day → quiet
    lines.push(String(p.statement).trim());
    if (lines.length >= 2) break;
  }
  return lines;
}
