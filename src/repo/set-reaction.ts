// The coach answering a logged set: ONE short, calm line right after the set, or
// silence. The morning read decides the day; this is the session listening while the
// athlete logs — a set that reached the top of the range, a load taken above the
// card, a best-ever, a card finished as written.
//
// Deterministic and offline: no agent, no network beyond the set write that already
// happened. `setReaction` is the pure read over this session's sets for one lift and
// today's card for it; `setReactionForLoggedSet` gathers those from the store for the
// POST /api/sets and log_set answers. Silence is the default — a line only when the
// set carries a real signal, and never the same signal twice in a session.
//
// Encodings honoured: a negative load is assistance (less assist is harder), null is
// bodyweight, a timed lift is judged by seconds, and RIR is optional — an unrated set
// is never read as weak, it simply never claims reps in hand.

import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { sameLiftName } from "./exercise-canon.js";
import { RIR_IN_RESERVE, nextPrescription } from "./progression.js";
import { getActiveDailySession, getActiveDailySessionForSession } from "./adaptive-session.js";
import { plausibleRir } from "../lib/numbers.js";

export type SetReactionCode = "range_cleared" | "top_of_range" | "above_card" | "best_ever" | "card_complete";

export interface SetReaction {
  code: SetReactionCode;
  line: string;
}

export interface ReactionSet {
  weight: number | null;
  reps: number | null;
  rir: number | null;
  duration_sec: number | null;
}

// Today's card for the lift (a daily-session composition item).
export interface ReactionPrescription {
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  target_seconds: number | null;
}

export interface SetReactionInput {
  date: string;
  exercise: string;
  mode: "reps" | "timed";
  // The lift's muscle group, for the earned step's plate grid (compound vs isolation).
  group: string | null;
  // This session's sets for this lift in log order; the LAST is the set just logged.
  sets: ReactionSet[];
  prescription: ReactionPrescription | null;
  // The just-logged set beat every earlier set of this lift (the same PR rule the set
  // write uses) AND the lift has history from an earlier day — a first-ever session
  // has nothing to beat, so it never earns "best-ever".
  best_ever: boolean;
  // What the progression engine would take for this lift's NEXT session, as the step
  // words a line names (a load increment, an assist, "bodyweight"), or null when the
  // engine would not step. Asked only when a line is about to name a step; absent
  // (a pure read, a test) means no number is named.
  engine_step?: (latest: ReactionSet) => string | null;
}

const LOAD_EPS = 0.1;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameLoad(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= LOAD_EPS;
}

// Harder-or-equal in every regime: loaded (+) beats bodyweight (null) beats assisted
// (−), and inside a regime the larger signed value is harder (−25 is less assist than
// −30). Mirrors loadAtOrAbove (outcome-comparability.ts), widened to bodyweight.
function rank(load: number | null): number {
  if (load == null || load === 0) return 0;
  return load > 0 ? 1 : -1;
}

function atOrAbove(load: number | null, target: number | null): boolean {
  const a = load === 0 ? null : load;
  const t = target === 0 ? null : target;
  if (rank(a) !== rank(t)) return rank(a) > rank(t);
  if (a == null || t == null) return true;
  return a + LOAD_EPS >= t;
}

function strictlyAbove(load: number | null, target: number | null): boolean {
  return atOrAbove(load, target) && !sameLoad(load === 0 ? null : load, target === 0 ? null : target);
}

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function loadWords(load: number | null): string {
  if (load == null || load === 0) return "bodyweight";
  if (load < 0) return `an assist of ${fmtNumber(Math.abs(load))}`;
  return fmtNumber(load);
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// The step the progression engine would take next, or null when it would not step
// (block pacing, a hold for cut pressure or an untested slot, a rep step with the load
// held). Read as forNextSession does: no autoregulation or acute brake from today, which
// are re-checked when that session starts. Loaded work names the increment from the load
// just taken; assisted work names the assist it steps to. Bodyweight has no step to name.
function engineStepWords(exercise: string, date: string, latest: ReactionSet): string | null {
  const load = latest.weight;
  if (load == null || load === 0) return null;
  const rx = nextPrescription(exercise, undefined, { date, autoreg: null, acute: null });
  const to = rx?.action === "overload" ? num(rx.suggested?.weight) : null;
  if (!rx || rx.mode !== "reps" || to == null || to <= load + LOAD_EPS) return null;
  return load > 0 ? fmtNumber(to - load) : loadWords(to);
}

// Reserve the hold asked for: RIR ≥ 2 when rated. Unrated is not weakness — it
// passes, it just never claims reps in hand.
function reserveOk(set: ReactionSet): boolean {
  return set.rir == null || set.rir >= RIR_IN_RESERVE;
}

function capsRange(set: ReactionSet, rx: ReactionPrescription): boolean {
  return rx.rep_high != null && set.reps != null && set.reps >= rx.rep_high && reserveOk(set);
}

// ---------- the voice: a small variant set per case, rotated by day ----------

interface LineParts {
  load: string;
  reps: string;
  high: string;
  next: string | null;
  reserve: string;
  setsWord: string;
}

type Template = (p: LineParts) => string;

export const SET_REACTION_VARIANTS: Record<string, readonly Template[]> = {
  range_cleared: [
    (p) =>
      `Every set at ${p.load} reached ${p.high}${p.reserve} — the range is cleared, and the next step is ${p.next}.`,
    (p) => `${p.high} on every set at ${p.load}${p.reserve}. That clears the range; the next step is ${p.next}.`,
    (p) => `The range is yours at ${p.load}: every set at ${p.high}${p.reserve}. The next step is ${p.next}.`,
  ],
  range_cleared_no_step: [
    (p) => `Every set at ${p.load} reached ${p.high}${p.reserve} — the range is cleared.`,
    (p) => `${p.high} on every set at ${p.load}${p.reserve}. That clears the range.`,
    (p) => `The range is yours at ${p.load}: every set at ${p.high}${p.reserve}.`,
  ],
  top_of_range_no_step: [
    (p) => `${p.reps} at ${p.load}${p.reserve} reaches the top of the range.`,
    (p) => `That set capped the range at ${p.load}${p.reserve}.`,
    (p) => `Top of the range at ${p.load}${p.reserve} — bring every set to ${p.high} from here.`,
  ],
  above_card: [
    (p) => `${p.load} for ${p.reps}, past the card and inside the range — the log carries that as your working weight.`,
    (p) => `Above the card at ${p.load} for ${p.reps}. That is the working weight the log builds from now.`,
    (p) =>
      `${p.reps} at ${p.load} goes past the written load inside the range — the log keeps it as the working weight.`,
  ],
  best_ever: [
    () => "That's the strongest set you've logged on this lift.",
    () => "Nothing in your log on this lift beats that set.",
    () => "A new best for this lift — the log has nothing stronger.",
  ],
  best_ever_timed: [
    () => "That's the most you've put into this hold.",
    () => "Nothing in your log on this hold beats that one.",
    () => "A new best on this hold — the log has nothing longer.",
  ],
  card_complete: [
    (p) => `That's ${p.setsWord} the card asked for — this one is done.`,
    () => "Every set the card asked for is in.",
    (p) => `The card is complete: ${p.setsWord} in.`,
  ],
};

// ---------- the cases ----------

interface Candidate {
  code: SetReactionCode;
  // Same code + same key earlier in the session ⇒ already said; stay quiet.
  key: string;
  variant: keyof typeof SET_REACTION_VARIANTS;
  parts: LineParts;
}

function baseParts(input: SetReactionInput, set: ReactionSet): LineParts {
  const rx = input.prescription;
  const n = rx?.sets ?? 0;
  return {
    load: loadWords(set.weight),
    reps: set.reps == null ? "" : String(set.reps),
    high: rx?.rep_high == null ? "" : String(rx.rep_high),
    next: null,
    reserve: set.rir != null && set.rir >= RIR_IN_RESERVE ? " with reps in hand" : "",
    setsWord: n === 1 ? "the one set" : `all ${n} sets`,
  };
}

// The prescription-driven cases, judged over `sets` as if its last set were the one
// just logged. Priority order; every case that holds is returned.
function prescribedCandidates(input: SetReactionInput, sets: ReactionSet[]): Candidate[] {
  const rx = input.prescription;
  const latest = sets[sets.length - 1];
  if (!rx || !latest) return [];
  const out: Candidate[] = [];
  const target = rx.target_weight;
  const loadKey = latest.weight == null ? "bw" : fmtNumber(latest.weight);

  if (input.mode === "reps" && latest.reps != null && latest.reps > 0) {
    // 1. The top of the range at or above the card's load, with the reserve asked for.
    if (capsRange(latest, rx) && atOrAbove(latest.weight, target)) {
      const atLoad = sets.filter((s) => s.reps != null && sameLoad(s.weight ?? null, latest.weight ?? null));
      const prescribedSets = rx.sets ?? 0;
      const everySet = prescribedSets > 0 && atLoad.length >= prescribedSets && atLoad.every((s) => capsRange(s, rx));
      const parts = baseParts(input, latest);
      if (everySet) {
        const allRated = atLoad.every((s) => s.rir != null && s.rir >= RIR_IN_RESERVE);
        out.push({
          code: "range_cleared",
          key: loadKey,
          variant: "range_cleared",
          parts: { ...parts, reserve: allRated ? " with reps in hand" : "" },
        });
      }
      // No number here: the engine steps on a COMPLETE dose, and this is one set of it.
      out.push({ code: "top_of_range", key: loadKey, variant: "top_of_range_no_step", parts });
    }
    // 2. A load above the card, taken for reps inside the range: the log is the truth.
    const inRange =
      (rx.rep_low == null || latest.reps >= rx.rep_low) && (rx.rep_high == null || latest.reps <= rx.rep_high);
    const hasCardLoad = target != null && target !== 0;
    if (inRange && (hasCardLoad || (latest.weight ?? 0) > 0) && strictlyAbove(latest.weight, target)) {
      out.push({ code: "above_card", key: loadKey, variant: "above_card", parts: baseParts(input, latest) });
    }
  }

  // 4. Every prescribed set in at the card's dose.
  const prescribedSets = rx.sets ?? 0;
  if (prescribedSets > 0) {
    const done = sets.filter((s) => {
      if (!atOrAbove(s.weight, target)) return false;
      if (input.mode === "timed") {
        const secs = s.duration_sec ?? 0;
        return rx.target_seconds != null ? secs >= rx.target_seconds : secs > 0;
      }
      const reps = s.reps ?? 0;
      return rx.rep_low != null ? reps >= rx.rep_low : reps > 0;
    }).length;
    if (done >= prescribedSets) {
      out.push({ code: "card_complete", key: "", variant: "card_complete", parts: baseParts(input, latest) });
    }
  }
  return out;
}

function said(input: SetReactionInput, candidate: Candidate): boolean {
  for (let k = 1; k < input.sets.length; k++) {
    const earlier = prescribedCandidates(input, input.sets.slice(0, k));
    if (earlier.some((c) => c.code === candidate.code && c.key === candidate.key)) return true;
  }
  return false;
}

/**
 * The one reaction to the set just logged (the last of `input.sets`), or null.
 * Priority: range cleared on every set › this set at the top of the range › a load
 * above the card › a best-ever › the card complete. A case this session already
 * answered (same case, same load) is skipped, so the athlete hears each signal once.
 */
export function setReaction(input: SetReactionInput): SetReaction | null {
  const latest = input.sets[input.sets.length - 1];
  if (!latest) return null;
  const candidates = prescribedCandidates(input, input.sets);
  const ordered: Candidate[] = [
    ...candidates.filter((c) => c.code !== "card_complete"),
    ...(input.best_ever
      ? [
          {
            code: "best_ever" as const,
            key: `#${input.sets.length}`,
            variant: input.mode === "timed" ? "best_ever_timed" : "best_ever",
            parts: baseParts(input, latest),
          },
        ]
      : []),
    ...candidates.filter((c) => c.code === "card_complete"),
  ];
  for (const candidate of ordered) {
    if (candidate.code !== "best_ever" && said(input, candidate)) continue;
    if (candidate.code === "range_cleared") {
      // Name a step only when the engine would take it; otherwise the no-step wording.
      candidate.parts.next = input.engine_step?.(latest) ?? null;
      if (!candidate.parts.next) candidate.variant = "range_cleared_no_step";
    }
    const variants = SET_REACTION_VARIANTS[candidate.variant];
    const template = pickDayVariant(variants, input.date, `${candidate.code}:${input.exercise}:${input.sets.length}`);
    const line = capitalize(template(candidate.parts));
    return { code: candidate.code, line };
  }
  return null;
}

// ---------- gathering the inputs for a set that was just written ----------

function cardFor(sessionId: number, date: string, exercise: string): ReactionPrescription | null {
  const composition =
    (getActiveDailySessionForSession(sessionId) as { items?: unknown[]; date?: string } | null) ??
    (getActiveDailySession(date) as { items?: unknown[]; date?: string } | null);
  if (!composition || !Array.isArray(composition.items)) return null;
  const matches = composition.items.filter((raw) => {
    const item = raw as Record<string, unknown>;
    return item && item.kind !== "cardio" && typeof item.exercise === "string" && sameLiftName(item.exercise, exercise);
  }) as Record<string, unknown>[];
  // One lift on two cards (a top single plus a back-off block) has no single dose to
  // judge against — stay with the prescription-free cases.
  if (matches.length !== 1) return null;
  const item = matches[0];
  return {
    sets: num(item.sets),
    rep_low: num(item.rep_low),
    rep_high: num(item.rep_high),
    target_weight: num(item.target_weight),
    target_seconds: num(item.target_seconds),
  };
}

interface LiftRow {
  id: number;
  name: string;
  muscle_group: string | null;
  mode: string | null;
}

function toReactionSet(row: Record<string, unknown>): ReactionSet {
  return {
    weight: num(row.weight),
    reps: num(row.reps),
    rir: plausibleRir(row.rir),
    duration_sec: num(row.duration_sec),
  };
}

// The reaction to the set `setId` of `ex` in this session: this session's sets for the
// lift up to it, today's card, and whether it beat everything before it.
function reactionAtSet(
  ex: LiftRow,
  sessionId: number,
  date: string,
  setId: number,
  isBest: boolean,
  card: ReactionPrescription | null
): SetReaction | null {
  const rows = db
    .prepare(
      `SELECT id, weight, reps, rir, duration_sec FROM logged_sets
        WHERE session_id = ? AND exercise_id = ? AND id <= ?
        ORDER BY id`
    )
    .all(sessionId, ex.id, setId) as Array<Record<string, unknown>>;
  if (!rows.length || num(rows[rows.length - 1].id) !== setId) return null;
  const earlierDay =
    isBest &&
    db
      .prepare(
        `SELECT 1 FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE ls.exercise_id = ? AND s.date < ? LIMIT 1`
      )
      .get(ex.id, date) != null;
  return setReaction({
    date,
    exercise: ex.name,
    mode: ex.mode === "timed" ? "timed" : "reps",
    group: ex.muscle_group ?? null,
    sets: rows.map(toReactionSet),
    prescription: card,
    best_ever: isBest && earlierDay,
    engine_step: (latest) => engineStepWords(ex.name, date, latest),
  });
}

/**
 * The reaction for a set `logSetByName` just wrote, read from the store. Never throws:
 * a reaction is a courtesy on top of a saved set, so any failure is silence.
 */
export function setReactionForLoggedSet(result: {
  id?: unknown;
  session_id?: unknown;
  date?: unknown;
  exercise?: unknown;
  mode?: unknown;
  pr?: unknown;
}): SetReaction | null {
  try {
    const setId = num(result?.id);
    const sessionId = num(result?.session_id);
    const date = typeof result?.date === "string" ? result.date : null;
    const exercise = typeof result?.exercise === "string" ? result.exercise : null;
    if (setId == null || sessionId == null || !date || !exercise) return null;
    const ex = db.prepare(`SELECT id, name, muscle_group, mode FROM exercises WHERE name = ?`).get(exercise) as
      | LiftRow
      | undefined;
    if (!ex) return null;
    return reactionAtSet(
      { ...ex, mode: String(result.mode ?? ex.mode) },
      sessionId,
      date,
      setId,
      result.pr === true,
      cardFor(sessionId, date, exercise)
    );
  } catch {
    return null;
  }
}

/** The set write's answer with its reaction attached (absent when there is none). */
export function withSetReaction<T extends Record<string, unknown>>(result: T): T & { reaction?: SetReaction } {
  const reaction = setReactionForLoggedSet(result);
  return reaction ? { ...result, reaction } : result;
}

/** Whether a set beat every earlier set of its lift: the set write's own PR rule. */
export type SetBeatsPrior = (
  mode: "reps" | "timed",
  set: { weight: number | null; reps: number | null; duration_sec: number | null },
  prior: Array<{ weight: any; reps: any; duration_sec: any }>
) => boolean;

/**
 * The reaction each lift in a session still stands on, for the session read: the line
 * the athlete was last given on that card, which is what the card keeps showing until a
 * newer one replaces it. Re-runs the pure read over the logged sets, newest set first,
 * so it is the very line POST /sets answered for the latest set that earned one, and a
 * deleted set simply stops yielding it. Keyed by the id of the lift's LAST set in the
 * session (the row the card hangs it on). Silence is the empty map. Never throws.
 */
export function standingSetReactions(
  sessionId: number,
  date: string,
  beatsPrior: SetBeatsPrior
): Map<number, SetReaction> {
  const out = new Map<number, SetReaction>();
  try {
    const rows = db
      .prepare(
        `SELECT ls.id, ls.exercise_id, ls.weight, ls.reps, ls.duration_sec,
                e.name, e.muscle_group, e.mode
           FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
          WHERE ls.session_id = ? ORDER BY ls.id`
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    const byLift = new Map<number, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const list = byLift.get(Number(row.exercise_id)) ?? [];
      list.push(row);
      byLift.set(Number(row.exercise_id), list);
    }
    for (const [exerciseId, sets] of byLift) {
      const first = sets[0];
      const ex: LiftRow = {
        id: exerciseId,
        name: String(first.name),
        muscle_group: (first.muscle_group as string | null) ?? null,
        mode: (first.mode as string | null) ?? null,
      };
      const card = cardFor(sessionId, date, ex.name);
      const mode = ex.mode === "timed" ? "timed" : "reps";
      for (let k = sets.length - 1; k >= 0; k--) {
        const setId = Number(sets[k].id);
        const prior = db
          .prepare(`SELECT weight, reps, duration_sec FROM logged_sets WHERE exercise_id = ? AND id < ?`)
          .all(exerciseId, setId) as Array<{ weight: any; reps: any; duration_sec: any }>;
        const best = beatsPrior(mode, toReactionSet(sets[k]), prior);
        const reaction = reactionAtSet(ex, sessionId, date, setId, best, card);
        if (reaction) {
          out.set(Number(sets[sets.length - 1].id), reaction);
          break;
        }
      }
    }
  } catch {
    // A courtesy on top of the read: silence.
  }
  return out;
}
