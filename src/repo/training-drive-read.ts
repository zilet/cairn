/**
 * The training drive as ONE UI-ready read: what the athlete asked for, what that opens,
 * what nothing ever overrides, and — on a push day — the honest "why not more": what is
 * actually holding today back, in plain words, read off the same deterministic envelope
 * the session is composed from (daily-decision.ts) and the same day read the Brief is.
 *
 * It decides nothing. Every hold it names was decided elsewhere; this only says it, so
 * an athlete who asked to be pushed is never left reading a calm card without knowing
 * which signal (or which lift's own log) is the reason. Served as `push` on the Brief
 * (attachDayReadContext) and the conductor (getCoachingFocus), and by
 * GET /api/training-drive / MCP get_training_drive. Contract: src/contracts/training-drive.ts.
 */
import type {
  ClientPushStance,
  ClientTrainingDriveHold,
  ClientTrainingDriveRead,
  ClientTrainingDriveToday,
} from "../contracts/training-drive.js";
import type { CoachTrainingDrive } from "../brain/coach-context-contract.js";
import { harmEvidenceOnDay } from "./brain/read-adherence.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { type DailyDecisionEnvelope, decideDailySession, getLatestDailySessionDecision } from "./daily-decision.js";
import { type DayRead, dayPlanningSignalState, dayRead } from "./day-read.js";
import { plainGroupWords } from "./exercise-canon.js";
import { freshDecidingBrakeFields } from "./signal-state.js";
import { getProgramState } from "./program-state.js";
import {
  type PushOfferBlocker,
  clinicalTrainingHold,
  morningBrakes,
  openSymptomCount,
  pushOfferView,
} from "./push-offer.js";
import { activeRecoveryWeek } from "./recovery-week.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { PUSH_STANCE_CONSEC_CEILING, type PushStance, stanceDaysLeft, trainingDriveState } from "./training-drive.js";

// ---- the words ----

/** What the STANDING push opens (settings.training_drive = 'push'). */
export const STANDING_PUSH_LICENSES: readonly string[] = [
  "On a run of training days, a targeted session for what's due when your recovery reads green",
  "One heavier top set on a lift that's moving, when the morning backs it",
  "A strong top set at the top of the range can earn the next load",
  "A scheduled deload waits until your loaded weeks actually call for it",
];

/** What a DATED stance adds on top, while it covers the day and the last three days were clean. */
export const PUSH_STANCE_LICENSES: readonly string[] = [
  "Up to two heavier top sets, on different lifts that are moving",
  "Your own week, clean for three days, is enough to back the heavier look",
  "Longevity-first ordering no longer holds the load on a stacked day",
  `Up to ${PUSH_STANCE_CONSEC_CEILING} days in a row before a run of days reads easy`,
  "A top set at the top of the range with one rep in hand earns the step",
  "A main lift still recovering no longer parks the day's reach — the next moving lift can take it",
];

/** What no drive and no stance ever overrides. */
export const PUSH_NEVER_OVERRIDES: readonly string[] = [
  "A rest-grade readiness reading",
  "A day that cost you — a hard next morning, a new longest run, a session that came in under par",
  "Any symptom or injury you've reported",
  "Anything a health finding or your doctor governs",
  "A recovery week, or a deload your loaded weeks earned",
  "A fueling hold that's protecting you",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : iso;
}

const STANCE_LINE: ReadonlyArray<(until: string, since: string) => string> = [
  (until, since) => `Pushing through ${until}, as you asked on ${since}.`,
  (until, since) => `You asked on ${since} to be pushed — that runs through ${until}.`,
  (until, since) => `Your push stands through ${until} (your call on ${since}).`,
];

const STANCE_ENDED_LINE: ReadonlyArray<(until: string) => string> = [
  (until) => `Your push ran through ${until}; the drive is back where it was. Say the word to start another.`,
  (until) => `The push you asked for ended on ${until}. Ask again any time.`,
];

// The "why not more" sentence: the stance named, then the most decisive hold.
const WHY_NOT_MORE: ReadonlyArray<(hold: string) => string> = [
  (hold) => `You asked to push, and the room is there — what's holding today back: ${hold}.`,
  (hold) => `Push is on. Today it gives way to one thing: ${hold}.`,
  (hold) => `You want more, and that stands — today, ${hold}.`,
];

// Plain words for the fresh deciding brakes a day read may cite.
const BRAKE_WORDS: Record<string, string> = {
  training_readiness: "this morning's readiness reading",
  readiness: "this morning's readiness reading",
  hrv: "last night's HRV, outside your usual band",
  resting_hr: "your resting heart rate, up past your usual band",
  sleep: "a short night",
  sleep_min: "a short night",
  sleep_trend: "a run of short nights",
  felt_energy: "the low energy you tapped in",
  felt_fatigue: "the fatigue you reported",
  felt_soreness: "the soreness you reported",
  sleep_feel: "the rough night you tapped in",
  session_quality: "how the last session came in",
  hybrid_fuel: "fueling around the endurance work",
  hybrid_interference: "the endurance work already in your legs",
  health_constraints: "a health finding",
  health_constraint: "a health finding",
  health_directive: "a health finding",
  injury: "an injury you're working around",
  illness: "feeling unwell",
  schedule_pressure: "a tight day on the calendar",
  life_capacity: "a full day on the calendar",
  routine_disruption: "a disrupted routine",
  training_load_tolerance: "how the recent load has landed",
  recovery_capacity: "how recovery is reading",
};

function brakeWords(field: string): string {
  return BRAKE_WORDS[field] ?? `a fresh ${field.replace(/_/g, " ")} signal`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const HARM_WORDS: Record<string, string> = {
  rated_poorly: "a recent session came in under par",
  hard_cardio: "a recent hard cardio day still counts against the extra room",
  longest_run: "a new longest run in the last few days",
  readiness_rest_grade: "a rest-grade morning in the last few days",
  physiology_brake: "a recent morning read past your usual band",
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function stanceView(stance: PushStance, date: string): ClientPushStance {
  return {
    since: stance.since,
    until: stance.until,
    scope: stance.scope,
    words: stance.words,
    days_left: stanceDaysLeft(stance, date) ?? 0,
    decision_id: stance.decision_id,
    line: pickDayVariant(
      STANCE_LINE,
      date,
      "training_drive:stance_line"
    )(dayWords(stance.until), dayWords(stance.since)),
  };
}

function stanceHarm(date: string): string | null {
  for (const back of [1, 2, 3]) {
    const iso = addDaysISO(date, -back);
    if (!iso) continue;
    const harm = safe(() => harmEvidenceOnDay(iso), null as ReturnType<typeof harmEvidenceOnDay>);
    if (harm) return HARM_WORDS[harm.kind] ?? "a recent day that cost you something";
  }
  return null;
}

const COMPOUND_GROUPS = new Set(["chest", "back", "shoulders", "quads", "hamstrings", "glutes"]);

/**
 * What holds TODAY back, most decisive first. Pure over its inputs (the envelope, the
 * day read and the brake fields), so tests can pin every arm without a database.
 */
export function pushHolds(input: {
  envelope: DailyDecisionEnvelope | null;
  read: Pick<DayRead, "kind" | "why" | "decision"> | null;
  brakeFields: string[];
  stanceActive: boolean;
  stanceHarm: string | null;
  consecutive: number | null;
}): ClientTrainingDriveHold[] {
  const out: ClientTrainingDriveHold[] = [];
  const push = (hold: ClientTrainingDriveHold) => {
    if (!out.some((h) => h.code === hold.code && h.words === hold.words)) out.push(hold);
  };
  const { envelope, read } = input;
  if (read && (read.kind === "rest" || read.kind === "easy")) {
    const reason = String(read.decision?.reason ?? "").trim() || String(read.why ?? "").trim();
    if (reason) push({ code: "quiet_day", words: reason.replace(/\.$/, "") });
  }
  if (input.stanceActive && input.stanceHarm) push({ code: "stance_harm", words: input.stanceHarm });
  if (input.stanceActive && input.consecutive != null && input.consecutive >= PUSH_STANCE_CONSEC_CEILING)
    push({ code: "stack_ceiling", words: `${input.consecutive} loading days in a row is past the push's own ceiling` });
  if (envelope) {
    const codes = new Set<string>([...envelope.precedence, ...envelope.soft_preferences.map((s) => s.code)]);
    for (const hard of envelope.hard_constraints) {
      if (hard.code === "injury_exclusion") push({ code: "injury", words: hard.detail });
    }
    if (input.brakeFields.length)
      push({ code: "signal", words: joinWords(input.brakeFields.slice(0, 2).map(brakeWords)) });
    if (envelope.kind === "train") {
      if (envelope.caps.intensity === "deload") {
        push({
          code: codes.has("repeated_underperformance") ? "underpowered" : "deload",
          words: codes.has("repeated_underperformance")
            ? "two sessions in a row came in underpowered, so the load eases until one lands"
            : "this is a lighter week the evidence earned",
        });
      }
      if (envelope.caps.intensity === "hold") {
        if (codes.has("low_recovery_easy"))
          push({ code: "recovery_low", words: "recovery is reading low this morning" });
        if (codes.has("high_soreness")) push({ code: "soreness", words: "the soreness you reported" });
        if (codes.has("recent_underperformance"))
          push({ code: "underpowered", words: "the last session felt underpowered" });
        if (codes.has("training_intent") && !codes.has("push_stance"))
          push({ code: "preference", words: "longevity leads your priorities, and today stacks hard on hard" });
      }
      if (codes.has("reach_trimmed_by_fueling"))
        push({ code: "fueling", words: "fueling has been light, so the reach stays in the working sets" });
      if (envelope.reach.level !== "push" && !input.brakeFields.length) {
        const deep = new Set((envelope.muscles.deep ?? []).map((g) => String(g).toLowerCase()));
        const mainGroup = String(envelope.muscles.required[0] ?? "").toLowerCase();
        if (mainGroup && deep.has(mainGroup) && !input.stanceActive) {
          const words = plainGroupWords([mainGroup], 1) ?? mainGroup;
          push({ code: "recovering_group", words: `${words} is still deeply recovering, so the heavier look waits` });
        } else if (envelope.reach.level == null && !codes.has("reach_trimmed_by_fueling")) {
          push({
            code: "not_vouched",
            words:
              "nothing has vouched for a heavier look yet — no strong rated session, no full recovery read, no clean run of your own week",
          });
        }
      }
      // The lifts themselves: a compound holding its load says why in its own words.
      const holds = envelope.candidates.filter(
        (c) =>
          (c.action === "hold" || c.action === "deload") &&
          !!c.progression_evidence?.why &&
          COMPOUND_GROUPS.has(String(c.muscle_group ?? "").toLowerCase())
      );
      for (const c of holds.slice(0, 2)) {
        push({ code: "lift_hold", words: `${c.exercise}: ${String(c.progression_evidence?.why).replace(/\.$/, "")}` });
      }
    }
  }
  return out.slice(0, 4);
}

export function trainingDriveRead(
  date?: string | null,
  opts: { read?: DayRead | null; envelope?: DailyDecisionEnvelope | null; withToday?: boolean } = {}
): ClientTrainingDriveRead {
  const d = String(date || localDateISO()).slice(0, 10);
  const state = trainingDriveState(d);
  const stance = state.stance ? stanceView(state.stance, d) : null;
  const ended =
    !state.stance && state.expired_stance
      ? {
          until: state.expired_stance.until,
          line: pickDayVariant(STANCE_ENDED_LINE, d, "training_drive:ended")(dayWords(state.expired_stance.until)),
        }
      : null;
  const licenses =
    state.drive === "push" ? [...STANDING_PUSH_LICENSES, ...(state.stance ? PUSH_STANCE_LICENSES : [])] : [];
  let today: ClientTrainingDriveToday | null = null;
  const live = d >= localDateISO();
  if (state.drive === "push" && live && opts.withToday !== false) {
    today = safe(() => todayAnswer(d, !!state.stance, opts), null);
  }
  // The coach's open "want to open the throttle?" — only while the drive is steady and
  // only on a live day (a past day has nothing to ask about).
  const offer = state.drive === "steady" && live ? safe(() => pushOfferView(d), null) : null;
  return {
    date: d,
    drive: state.drive,
    standing: state.standing,
    stance,
    ended,
    licenses,
    never_overrides: [...PUSH_NEVER_OVERRIDES],
    today,
    offer,
  };
}

/**
 * The compact prompt view (getCoachContext `training_drive`): the stance and its words,
 * never today's envelope — the coach context is shared by every prompt and must not
 * compose the day's session to build itself.
 */
export function trainingDriveForCoach(date?: string | null): CoachTrainingDrive {
  const d = String(date || localDateISO()).slice(0, 10);
  const state = trainingDriveState(d);
  return {
    drive: state.drive,
    standing: state.standing,
    stance: state.stance
      ? {
          since: state.stance.since,
          until: state.stance.until,
          scope: state.stance.scope,
          words: state.stance.words,
          days_left: stanceDaysLeft(state.stance, d) ?? 0,
        }
      : null,
    ended_until: !state.stance && state.expired_stance ? state.expired_stance.until : null,
    licenses: state.drive === "push" ? [...STANDING_PUSH_LICENSES, ...(state.stance ? PUSH_STANCE_LICENSES : [])] : [],
    never_overrides: [...PUSH_NEVER_OVERRIDES],
    held_by: state.drive === "push" ? safe(() => stanceHeldBy(d), [] as string[]) : [],
    offer:
      state.drive === "steady"
        ? safe(() => {
            const view = pushOfferView(d);
            return view ? { offered_on: view.offered_on, evidence: view.evidence, until: view.until } : null;
          }, null)
        : null,
  };
}

const HELD_WORDS: Partial<Record<PushOfferBlocker, string>> = {
  symptom: "a symptom you reported is still open",
  clinical: "a health finding governs your training right now",
  recovery_week: "this is a recovery week",
  deload: "your loaded weeks have earned a deload",
};

/**
 * What the floors hold against a push RIGHT NOW, in the athlete's terms — the honest
 * half of "your word stands, and here is what still outranks it". Reads the same facts
 * the push offer's floors read (pushOfferFacts), restricted to the ones a stance can
 * never override: a day in the last three that cost something, a fresh deciding brake,
 * an open symptom, an act-now finding that governs training, a recovery week or an
 * EARNED deload. Pure words; decides nothing.
 */
export function stanceHeldBy(date?: string | null): string[] {
  const d = String(date || localDateISO()).slice(0, 10);
  const out: string[] = [];
  const recentHarm = stanceHarm(d);
  if (recentHarm) out.push(recentHarm);
  const { brakes } = morningBrakes(d);
  if (brakes.length) out.push(joinWords(brakes.slice(0, 2).map(brakeWords)));
  if (openSymptomCount(d) > 0) out.push(HELD_WORDS.symptom as string);
  if (clinicalTrainingHold()) out.push(HELD_WORDS.clinical as string);
  if (safe(() => activeRecoveryWeek(d) != null, false)) out.push(HELD_WORDS.recovery_week as string);
  // Only an EARNED deload outranks a push; a scheduled one is what the push sets aside.
  if (safe(() => getProgramState(d).mesocycle?.deload_evidence === true, false)) out.push(HELD_WORDS.deload as string);
  return out.slice(0, 4);
}

function todayAnswer(
  d: string,
  stanceActive: boolean,
  opts: { read?: DayRead | null; envelope?: DailyDecisionEnvelope | null }
): ClientTrainingDriveToday {
  const read = opts.read ?? safe(() => dayRead(d), null);
  // A finished day has nothing left to hold back — and no envelope worth composing.
  if (read?.kind === "done") return { date: d, reaching: false, reach_hosts: 0, holding: [], line: null };
  // The composed envelope when one was persisted for the same inputs — it carries what
  // composition could actually seat (a reach with no room says so) — else the fresh one.
  const envelope =
    opts.envelope ??
    safe(() => {
      const fresh = decideDailySession(d).envelope;
      const stored = getLatestDailySessionDecision(d);
      return stored && stored.input_fingerprint === fresh.input_fingerprint ? stored : fresh;
    }, null);
  const brakeFields = safe(() => freshDecidingBrakeFields(dayPlanningSignalState(d).dimensions), [] as string[]);
  const consecutive = Number((read?.signals as any)?.consecutive_training_days);
  const holding = pushHolds({
    envelope,
    read,
    brakeFields,
    stanceActive,
    stanceHarm: stanceActive ? stanceHarm(d) : null,
    consecutive: Number.isFinite(consecutive) ? consecutive : null,
  });
  const noRoom = !!envelope?.soft_preferences.some((s) => s.code === "reach_no_room");
  const reaching =
    envelope?.kind === "train" &&
    envelope.reach.level === "push" &&
    !noRoom &&
    !holding.some((h) => h.code === "fueling");
  const reachHosts = envelope?.reach.level === "push" ? Math.max(1, Number(envelope.reach.hosts) || 1) : 0;
  return {
    date: d,
    reaching,
    reach_hosts: reachHosts,
    holding,
    line: holding.length ? pickDayVariant(WHY_NOT_MORE, d, "training_drive:why_not_more")(holding[0].words) : null,
  };
}
