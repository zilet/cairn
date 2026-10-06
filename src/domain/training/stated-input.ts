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
import { recordDecision, saveBrainRollback } from "../../repo/brain-decisions.js";
import { invalidateDayRead } from "../../repo/day-read-cache.js";
import {
  type EnduranceSchedule,
  type EnduranceScheduleQuality,
  WEEKDAY_NAMES,
  getEnduranceSchedule,
  setProfile,
} from "../../repo/profile.js";
import { localDateISO } from "../../repo/shared.js";

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
    quality: schedule.quality
      ? {
          type: schedule.quality.type,
          ...(schedule.quality.work_km != null ? { work_km: schedule.quality.work_km } : {}),
          ...(schedule.quality.warm_up_km != null ? { warm_up_km: schedule.quality.warm_up_km } : {}),
          ...(schedule.quality.cool_down_km != null ? { cool_down_km: schedule.quality.cool_down_km } : {}),
        }
      : null,
  };
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
  const after = getEnduranceSchedule();
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
  const p = payload as RunWeekRollback | null;
  if (!p || p.version !== 1) throw new Error("rollback snapshot unavailable");
  const stored = getEnduranceSchedule();
  if (!same(canonical(stored), p.applied))
    throw new Error("your run week has changed since — your newer word stands");
  if (p.applied_words !== undefined && !same(ownedWords(stored), p.applied_words))
    throw new Error("your run week's note has changed since — your newer word stands");
  const prev = p.previous;
  if (!prev) {
    setProfile({ endurance_schedule: null });
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
