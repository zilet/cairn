/**
 * STATED INPUT → the ledger. When the athlete SAYS how their run week goes ("Thursday is
 * a hard threshold 5k with a few km around it", "I run Tue/Thu/Sun"), the setter writes
 * the profile and the run engine reads it at once — but until now nothing recorded that
 * the athlete said it, so the Changes feed could not show "You said X → the brain changed
 * Y" and there was no one-tap way back to the week before.
 *
 * `recordStatedRunWeek` closes that, for every door that writes a stated run week (chat's
 * set_endurance_schedule action, MCP set_endurance_schedule): one `observe`-tier,
 * reversible `training_structure` decision — the athlete decided, Cairn recorded, the
 * same posture as a push stance — with `context.stated_by_athlete`, their words, an
 * athlete-register `action.title` / `action.user_explanation`, and a rollback snapshot
 * (kind `endurance_schedule`) that Undo restores ONLY while the stored week is still the
 * one this statement wrote (a newer statement wins, and Undo says so).
 *
 * It records nothing when nothing changed, and it never decides anything: whether the
 * stated quality runs in a given week stays the run engine's call (run-progression.ts).
 */
import { UNDO_UNAVAILABLE, UndoRefusal } from "../brain/undo-refusal.js";
import { recordDecision, saveBrainRollback } from "../../repo/brain-decisions.js";
import { invalidateDayRead } from "../../repo/day-read-cache.js";
import {
  type EnduranceSchedule,
  type EnduranceScheduleQuality,
  type EnduranceScheduleWeekMove,
  WEEKDAY_NAMES,
  getStandingEnduranceSchedule,
  getWeekMove,
  getWeekMoves,
  runDayWords,
  setProfile,
} from "../../repo/profile.js";
import { localDateISO } from "../../repo/shared.js";
import { mondayOf } from "../../lib/dates.js";

export type StatedInputVia = "chat" | "mcp" | "athlete";

interface RunWeekRollback {
  version: 1;
  applied: CanonicalRunWeek | null;
  /**
   * The words this statement left on the stored week (the schedule's note and the stated
   * session's note). `applied` is the structure only — a statement is RECORDED only when
   * the structure changes — but the Undo's ownership check must also see a newer note,
   * or it overwrote what the athlete wrote since. Absent on snapshots written before
   * (2026-10-06): those keep the structure-only check.
   */
  applied_words?: OwnedWords | null;
  previous: EnduranceSchedule | null;
}

interface OwnedWords {
  note: string | null;
  quality_note: string | null;
}

function ownedWords(schedule: EnduranceSchedule | null | undefined): OwnedWords | null {
  if (!schedule) return null;
  return {
    note: typeof schedule.note === "string" && schedule.note.trim() ? schedule.note : null,
    quality_note:
      typeof schedule.quality?.note === "string" && schedule.quality.note.trim() ? schedule.quality.note : null,
  };
}

interface CanonicalRunWeek {
  days: Array<{ dow: number; kind: string }>;
  cross: Array<{ dow: number; sport: string }>;
  quality: EnduranceScheduleQuality | null;
}

function canonical(schedule: EnduranceSchedule | null | undefined): CanonicalRunWeek | null {
  if (!schedule) return null;
  return {
    days: [...(schedule.days ?? [])]
      .map((d) => ({ dow: Number(d.dow), kind: String(d.kind) }))
      .sort((a, b) => a.dow - b.dow),
    cross: [...(schedule.cross_training ?? [])]
      .map((c) => ({ dow: Number(c.dow), sport: String(c.sport) }))
      .sort((a, b) => a.dow - b.dow),
    quality: canonicalQuality(schedule.quality),
  };
}

function canonicalQuality(q: EnduranceScheduleQuality | null | undefined): EnduranceScheduleQuality | null {
  return q
    ? {
        type: q.type,
        ...(q.work_km != null ? { work_km: q.work_km } : {}),
        ...(q.warm_up_km != null ? { warm_up_km: q.warm_up_km } : {}),
        ...(q.cool_down_km != null ? { cool_down_km: q.cool_down_km } : {}),
      }
    : null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const TYPE_WORDS: Record<string, string> = {
  threshold: "threshold",
  tempo: "tempo",
  vo2: "VO2 intervals",
  hills: "hill repeats",
};

/** "a threshold 5 km with 2 km either side" — the session as said, in words. */
export function qualityWords(q: EnduranceScheduleQuality): string {
  const type = TYPE_WORDS[q.type] ?? q.type;
  const work = q.work_km != null ? `${type} ${q.work_km} km` : `${type} session`;
  const warm = q.warm_up_km;
  const cool = q.cool_down_km;
  if (warm != null && cool != null && warm === cool && warm > 0) return `${work} with ${warm} km either side`;
  const around = [warm ? `${warm} km warm-up` : null, cool ? `${cool} km cool-down` : null].filter(Boolean);
  return around.length ? `${work} with a ${around.join(" and a ")}` : work;
}

function qualityDay(schedule: EnduranceSchedule | null): string | null {
  const day = schedule?.days?.find((d) => d.kind === "quality");
  return day ? (WEEKDAY_NAMES[day.dow] ?? null) : null;
}

function describe(
  before: CanonicalRunWeek | null,
  after: EnduranceSchedule | null
): { title: string; explanation: string } {
  const now = canonical(after);
  const weekday = qualityDay(after);
  if (now?.quality && !same(before?.quality, now.quality)) {
    const session = qualityWords(now.quality);
    return {
      title: `${weekday ? `${weekday}'s` : "Your"} quality run is now ${/^[aeiou]/i.test(session) ? "an" : "a"} ${session}`,
      explanation: `The run engine runs that session on your quality day instead of its own rotation, warm-up and cool-down included. When a week can't carry the full work yet it holds it below and says why — your stated session stays the target.`,
    };
  }
  if (before?.quality && !now?.quality) {
    return {
      title: "Your quality day is back to the coach's choice",
      explanation: "The run engine picks the quality session by the phase of your build again.",
    };
  }
  if (!now) {
    return {
      title: "Your stated run days are cleared",
      explanation: "The run engine places your runs by its own spacing again.",
    };
  }
  return {
    title: "Your run week now follows the days you named",
    explanation:
      "The run engine places easy, quality and long runs on exactly those weekdays and never suggests a run on another day.",
  };
}

/**
 * Record what the athlete SAID about their run week. Call AFTER the profile write with
 * the schedule as it stood before. Returns the decision id, or null when nothing changed
 * or the ledger write failed (the athlete's word is already in force either way).
 */
export function recordStatedRunWeek(input: {
  before: EnduranceSchedule | null;
  words?: unknown;
  via: StatedInputVia;
  today?: string;
}): number | null {
  const today = String(input.today || localDateISO()).slice(0, 10);
  const after = getStandingEnduranceSchedule();
  const was = canonical(input.before);
  const now = canonical(after);
  if (same(was, now)) return null;
  const words =
    String(input.words ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240) || null;
  const { title, explanation } = describe(was, after);
  try {
    const { decision } = recordDecision({
      effective_date: today,
      kind: "training_structure",
      domain: "training",
      summary: title,
      rationale: "Your word, recorded as said. The run engine reads it from today.",
      source: input.via === "chat" ? "chat" : input.via === "mcp" ? "mcp" : "athlete",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: { stated_by_athlete: true, stated_kind: "run_week", words },
      action: {
        kind: "stated_run_week",
        title,
        user_explanation: explanation,
        quality: now?.quality ?? null,
        stated_at: new Date().toISOString(),
      },
      specialist: null,
      applied_at: new Date().toISOString(),
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    if (decision.id) {
      const rollback: RunWeekRollback = {
        version: 1,
        applied: now,
        applied_words: ownedWords(after),
        previous: input.before ?? null,
      };
      saveBrainRollback(decision.id, "endurance_schedule", rollback);
    }
    try {
      invalidateDayRead(today);
    } catch {
      /* the fingerprint carries the schedule anyway */
    }
    return decision.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Undo a stated run week (called inside the autonomy service's revert savepoint). Acts
 * only while the stored week is still the one this statement wrote — its structure AND
 * its words (a note the athlete changed since is a newer word, and it stands). The
 * restored week moves today's Brief, so the day read is invalidated like the statement's
 * own write invalidated it.
 */
export function revertStatedRunWeek(payload: unknown, today: string = localDateISO()): void {
  const raw = payload as RunWeekRollback | RunWeekMoveRollback | null;
  if (!raw || raw.version !== 1) throw new UndoRefusal(UNDO_UNAVAILABLE);
  if ("scope" in raw && raw.scope === "this_week") {
    revertRunWeekMove(raw, today);
    return;
  }
  const p = raw as RunWeekRollback;
  const stored = getStandingEnduranceSchedule();
  if (!same(canonical(stored), p.applied))
    throw new UndoRefusal("Your run week has changed since, so your newer word stands.");
  if (p.applied_words !== undefined && !same(ownedWords(stored), p.applied_words))
    throw new UndoRefusal("Your run week's note has changed since, so your newer word stands.");
  const prev = p.previous;
  if (!prev) {
    // Back to no standing week. A stored one-week move is the athlete's separate word (and
    // a closed week's is history), so it stays: only the standing week is cleared.
    if (getWeekMoves().length)
      setProfile({ endurance_schedule: { days: [], standing_exact: true, source: stored?.source ?? "athlete" } });
    else setProfile({ endurance_schedule: null });
  } else {
    setProfile({
      endurance_schedule: {
        days: prev.days,
        cross_training: prev.cross_training ?? [],
        quality: prev.quality ?? null,
        ...(prev.note ? { note: prev.note } : {}),
        source: prev.source,
      },
    });
  }
  try {
    invalidateDayRead(String(today).slice(0, 10));
  } catch {
    /* the fingerprint carries the schedule anyway; this only skips one stale serve */
  }
}

// ---------- the ONE-WEEK move ----------
// "Skip tomorrow's run, move the quality run to Friday" said for THIS week (or, said on a
// Sunday about Monday, for NEXT week): written as that week's move only (profile.ts
// `week_moves`), so the standing week never moves and the week after is the usual one
// again by itself. It is recorded like a standing statement — the athlete's word, observe
// tier, one-tap Undo — and the Undo takes back that week's move only.

interface RunWeekMoveRollback {
  version: 1;
  scope: "this_week";
  applied: CanonicalWeekMove;
  /** The move this one replaced for the same week, when there was one; else null. */
  previous: EnduranceScheduleWeekMove | null;
}

interface CanonicalWeekMove {
  week_start: string;
  days: Array<{ dow: number; kind: string }>;
  /** The session stated for that week (absent on snapshots without one). */
  quality?: CanonicalRunWeek["quality"];
}

function canonicalMove(move: EnduranceScheduleWeekMove | null | undefined): CanonicalWeekMove | null {
  if (!move) return null;
  return {
    week_start: String(move.week_start),
    days: [...(move.days ?? [])]
      .map((d) => ({ dow: Number(d.dow), kind: String(d.kind) }))
      .sort((a, b) => a.dow - b.dow),
    ...(move.quality ? { quality: canonicalQuality(move.quality) } : {}),
  };
}

// The move `before` (a standing read, taken before the write) held for `weekStart`.
function moveBefore(before: EnduranceSchedule | null, weekStart: string): EnduranceScheduleWeekMove | null {
  for (const move of [before?.this_week, before?.next_week]) if (move?.week_start === weekStart) return move;
  return null;
}

/**
 * Record a one-week run move. Call AFTER the write with the standing schedule as it stood
 * before (getStandingEnduranceSchedule) and the Monday of the week the move is for. Returns
 * the decision id, or null when nothing changed or the ledger write failed (the move is in
 * force either way).
 */
export function recordRunWeekMove(input: {
  before: EnduranceSchedule | null;
  week_start: string;
  words?: unknown;
  via: StatedInputVia;
  today?: string;
}): number | null {
  const today = String(input.today || localDateISO()).slice(0, 10);
  const move = getWeekMove(input.week_start);
  const previous = moveBefore(input.before, String(input.week_start));
  const now = canonicalMove(move);
  if (!move || !now || same(canonicalMove(previous), now)) return null;
  const nextWeek = move.week_start > mondayOf(today);
  const words =
    String(input.words ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240) || null;
  const usual = runDayWords(getStandingEnduranceSchedule()?.days ?? []);
  // The session stated for that week, when one was, named on its day.
  const session = move.quality ? qualityWords(move.quality) : null;
  const title = `${nextWeek ? "Next" : "This"} week's runs moved: ${runDayWords(move.days, { quality: session })}`;
  const after = nextWeek ? "The week after" : "Next week";
  const explanation = usual
    ? `For ${nextWeek ? "next" : "this"} week only. ${after} goes back to your usual days (${usual}) by itself.`
    : `For ${nextWeek ? "next" : "this"} week only. ${after} the coach places your runs by its own spacing again.`;
  try {
    const { decision } = recordDecision({
      effective_date: today,
      kind: "training_structure",
      domain: "training",
      summary: title,
      rationale: `Your word, recorded as said. The run engine reads it for ${nextWeek ? "next" : "this"} week only.`,
      source: input.via === "chat" ? "chat" : input.via === "mcp" ? "mcp" : "athlete",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {
        stated_by_athlete: true,
        stated_kind: "run_week_move",
        words,
        week_start: move.week_start,
        week: nextWeek ? "next" : "this",
        restores_move: !!previous,
      },
      action: {
        kind: "stated_run_week_move",
        title,
        user_explanation: explanation,
        week_start: move.week_start,
        days: move.days,
        stated_at: new Date().toISOString(),
      },
      specialist: null,
      applied_at: new Date().toISOString(),
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    if (decision.id) {
      const rollback: RunWeekMoveRollback = { version: 1, scope: "this_week", applied: now, previous };
      saveBrainRollback(decision.id, "endurance_schedule", rollback);
    }
    try {
      invalidateDayRead(today);
    } catch {
      /* the fingerprint carries the schedule anyway */
    }
    return decision.id ?? null;
  } catch {
    return null;
  }
}

// Undo a one-week move: only while its week is not over (a closed week's days are history)
// and the stored move is still the one this statement wrote (a newer move wins). The
// standing week is never touched; the move it replaced for that week, when one did, comes
// back exactly as it was.
function revertRunWeekMove(p: RunWeekMoveRollback, today: string): void {
  const weekStart = String(p.applied?.week_start ?? "");
  if (!weekStart || weekStart < mondayOf(String(today).slice(0, 10)))
    throw new UndoRefusal("That week is over, so its runs stay as they were.");
  if (!same(canonicalMove(getWeekMove(weekStart)), p.applied))
    throw new UndoRefusal("That week's runs have changed since, so your newer word stands.");
  setProfile({
    endurance_schedule: {
      this_week: p.previous ? { ...p.previous, exact: true } : { week_start: weekStart, clear: true },
    },
  });
  try {
    invalidateDayRead(String(today).slice(0, 10));
  } catch {
    /* the fingerprint carries the schedule anyway; this only skips one stale serve */
  }
}
