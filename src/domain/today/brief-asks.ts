// THE BRIEF'S QUIET QUESTIONS — one read, one answer path (contract:
// src/contracts/brief-asks.ts). Pull, never push: a question waits on the Brief, and
// each is asked at most once.
//
//   - TRIP EVE. The evening before a planned lift day that falls inside a trip (a `trip`
//     context event, src/repo/travel-days.ts), the Brief asks "Lifting on the trip?".
//     The answers write through paths that already exist:
//       yes    → nothing changes; the answer is remembered so it is never asked again;
//       skip   → the day is held as rest the way a rest trade holds one (a context event
//                carrying `meta.claims_day` on that date — signal-state's own claim), the
//                plan's ring untouched;
//       easier → a ONE-DAY plan adaptation (a draft whose changes carry `until` = that
//                date and `layer: 'trip'`, landed through applyProposal): each lift with
//                a bodyweight twin becomes it (in a bodyweight rep range), the rest stay
//                a set lighter, and the day after the plan goes back by itself
//                (plan-adaptations.ts). A LAYER: it lies over whatever the slot holds —
//                a race adaptation stays in force beneath it, and is what comes back.
//     Every answer is remembered on the trip, per day (`meta.lift_answers`).
//   - AN ASKED RETURN, ONCE. A race adaptation made around pain whose return went
//     unanswered comes back on the one day the daily pass stamped it for
//     (src/repo/plan-adaptation-asks.ts) — "bring it back" applies the held draft,
//     "keep it" discards it; unanswered, it settles to keeping the adaptation.
//
// Never a gate: the day goes on as planned with no answer at all.
import type {
  BriefAsk,
  BriefAskAnswer,
  BriefAskAnswerKey,
  BriefAskAnswerResult,
  BriefAsks,
} from "../../contracts/brief-asks.js";
import { addDaysISO, isoDate, isoDay } from "../../lib/dates.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { invalidateDayRead } from "../../repo/day-read-cache.js";
import { addContextEvent, listContextEvents } from "../../repo/health.js";
import {
  askedAdaptationGroups,
  resurfacedAdaptationAsks,
  settleAskedAdaptations,
} from "../../repo/plan-adaptation-asks.js";
import { listWords } from "../../repo/plan-adaptations.js";
import { getPlan } from "../../repo/plan.js";
import { isoDow, WEEKDAY_NAMES } from "../../repo/profile.js";
import { applyProposal, createProposal, proposalStatus, setProposalStatus } from "../../repo/proposals.js";
import { localDateISO, nowContext } from "../../repo/shared.js";
import { recordTripLiftAnswer, tripEventOn, type TripEvent } from "../../repo/travel-days.js";
import { applyAnsweredProposal } from "../brain/autonomy-service.js";
import { lookAheadWeekAsOf } from "../training/plan-look-ahead.js";
import { planWeek, type PlanWeekPlanDay } from "../training/plan-week.js";

/** From this local hour the Brief reads as the evening before tomorrow. */
export const TRIP_EVE_HOUR = 16;

const TRIP_ASK_PREFIX = "trip_lift:";
const RETURN_ASK_PREFIX = "adaptation_return:";

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** A real day key off anything date-shaped (a timestamp's leading day), or null. */
function dayKey(value: unknown): string | null {
  return isoDate(isoDay(value));
}

function weekdayName(date: string): string {
  return WEEKDAY_NAMES[isoDow(date)] ?? "Tomorrow";
}

function tripWords(trip: TripEvent): string {
  return trip.location && !trip.title.toLowerCase().includes(trip.location.toLowerCase())
    ? `${trip.title} in ${trip.location}`
    : trip.title;
}

/** The plan strip's lift on `date` (the same cell the week strip prints), or null. */
function plannedLiftOn(date: string, today: string): PlanWeekPlanDay | null {
  const week = safe(() => planWeek(lookAheadWeekAsOf(date, today)), null);
  const cell = week?.days.find((d) => d.date === date) ?? null;
  const plan = cell?.plan_day ?? null;
  if (!plan || plan.role !== "strength" || plan.day_type === "rest" || cell?.session) return null;
  return plan;
}

/** A context event already holds `date` as rest (a rest trade, an earlier "skip it"). */
function dayAlreadyHeld(date: string): boolean {
  return safe(
    () =>
      (listContextEvents({}) as any[]).some(
        (e) =>
          e &&
          !e.archived &&
          e.meta?.claims_day === true &&
          String(e.start_date ?? "").slice(0, 10) <= date &&
          String(e.end_date ?? e.start_date ?? "").slice(0, 10) >= date
      ),
    false
  );
}

const TRIP_DETAIL: readonly ((day: string, lift: string, trip: string) => string)[] = [
  (day, lift, trip) => `${day}'s ${lift} lands on your ${trip} trip.`,
  (day, lift, trip) => `${lift} is planned for ${day}, the ${trip} trip.`,
];

const TRIP_ANSWERS: readonly BriefAskAnswer[] = [
  { key: "yes", label: "Yes, as planned" },
  { key: "easier", label: "Easier — bodyweight" },
  { key: "skip", label: "Skip it" },
];

/** The trip-eve question for tomorrow, or null (not the evening, no trip, no lift, already answered). */
export function tripEveAsk(today: string, hour: number): BriefAsk | null {
  if (!(hour >= TRIP_EVE_HOUR)) return null;
  const tomorrow = addDaysISO(today, 1);
  if (!tomorrow) return null;
  const trip = safe(() => tripEventOn(tomorrow), null);
  if (!trip || trip.lift_answers[tomorrow]) return null;
  const lift = plannedLiftOn(tomorrow, today);
  if (!lift) return null;
  if (dayAlreadyHeld(tomorrow)) return null;
  const detail = pickDayVariant(TRIP_DETAIL, today, "brief-ask:trip")(
    weekdayName(tomorrow),
    lift.name,
    tripWords(trip)
  );
  return {
    key: `${TRIP_ASK_PREFIX}${tomorrow}`,
    kind: "trip_lift",
    question: "Lifting on the trip?",
    detail,
    date: tomorrow,
    answers: [...TRIP_ANSWERS],
  };
}

const RETURN_ANSWERS: readonly BriefAskAnswer[] = [
  { key: "bring_back", label: "Bring it back" },
  { key: "keep", label: "Keep it as is" },
];

function returnAsks(today: string): BriefAsk[] {
  return safe(() => resurfacedAdaptationAsks(today), []).map((ask) => ({
    key: `${RETURN_ASK_PREFIX}${ask.proposal_id}`,
    kind: "adaptation_return" as const,
    question: ask.question,
    detail: ask.detail,
    date: today,
    answers: [...RETURN_ANSWERS],
  }));
}

/** Today's quiet questions. `now` places the evening, read in the athlete's device zone. */
export function briefAsks(opts: { date?: string; now?: Date } = {}): BriefAsks {
  const today = dayKey(opts.date) ?? localDateISO();
  // The device zone's hour (nowContext), never the host clock's: a UTC Pi must not ask a
  // Pacific athlete in their morning and stay silent all their evening.
  const hour = nowContext(opts.now ?? new Date()).hour;
  const asks: BriefAsk[] = [];
  const trip = tripEveAsk(today, hour);
  if (trip) asks.push(trip);
  asks.push(...returnAsks(today));
  return { date: today, asks };
}

// ---------- the bodyweight version of a lift ----------

interface BodyweightTwin {
  name: string;
  rep_low: number;
  rep_high: number;
}

// By movement pattern, the version a hotel room holds, in a rep range bodyweight work
// suits (never the loaded lift's 3–5). Most specific first: a calf raise is a calf raise
// whatever machine it names, and an isolation, a carry or a hold has no clean twin — it
// keeps its slot one set lighter, with a note. Whatever the slot's load (positive, null =
// bodyweight, negative = assisted), a lift with a twin takes it: an assisted chin-up
// needs the machine as much as a barbell row needs the bar.
const CALF = /\bcalf\b/i;
const NO_TWIN =
  /\b(extensions?|curls?|fly|flyes?|kickbacks?|push-?downs?|shrugs?|upright rows?|face pulls?|pull-?overs?|lateral raises?|front raises?|rear delt|skull ?crushers?|straight[- ]arm|abduct(?:ion|ors?)?|adduct(?:ion|ors?)?|carry|carries|walks?|holds?|planks?)\b/i;
const BODYWEIGHT_TWINS: readonly [RegExp, BodyweightTwin][] = [
  [/\b(split squat|lunges?|step[- ]?ups?|bulgarian)\b/i, { name: "Reverse Lunge", rep_low: 8, rep_high: 12 }],
  [/\b(squats?|leg press|hack)\b/i, { name: "Bodyweight Squat", rep_low: 12, rep_high: 20 }],
  [
    /\b(deadlifts?|rdl|romanian|good mornings?|hip thrusts?|glute bridges?|hinge)\b/i,
    { name: "Single-Leg Glute Bridge", rep_low: 10, rep_high: 15 },
  ],
  [/\b(overhead|shoulder press|military|ohp|push press|arnold|pike)\b/i, { name: "Pike Push-Up", rep_low: 6, rep_high: 10 }],
  [
    /\b(bench|chest press|floor press|incline press|dumbbell press|press-?ups?|push-?ups?|dips?)\b/i,
    { name: "Push-Up", rep_low: 8, rep_high: 15 },
  ],
  [/\b(rows?|pulldowns?|pull-?ups?|chin-?ups?|pull downs?)\b/i, { name: "Inverted Row", rep_low: 8, rep_high: 12 }],
];
const CALF_TWIN: BodyweightTwin = { name: "Single-Leg Calf Raise", rep_low: 12, rep_high: 20 };

const EASIER_NOTE = "On the trip: one set lighter, with whatever is there — bodyweight is plenty.";
const EASIER_NOTE_SAME_SETS = "On the trip: with whatever is there — bodyweight is plenty.";

export function bodyweightTwin(name: string): BodyweightTwin | null {
  if (CALF.test(name)) return CALF_TWIN;
  if (NO_TWIN.test(name)) return null;
  for (const [pattern, twin] of BODYWEIGHT_TWINS) if (pattern.test(name)) return twin;
  return null;
}

/** The one-day changes that make plan day `dayNumber` its bodyweight version on `date`. */
export function easierTripChanges(dayNumber: number, date: string): any[] {
  const day = safe(() => (getPlan() as any[]).find((d) => Number(d?.day_number) === Number(dayNumber)), null);
  const items = (Array.isArray(day?.items) ? day.items : []).filter((it: any) => String(it?.kind ?? "") !== "cardio");
  const onDay = new Set(items.map((it: any) => String(it?.exercise ?? "").toLowerCase()));
  const used = new Set<string>();
  const reason = "A lighter, bodyweight version for one day on the trip, at your answer.";
  const changes: any[] = [];
  for (const it of items) {
    const name = String(it?.exercise ?? "").trim();
    if (!name) continue;
    const twin = bodyweightTwin(name);
    const sets = Number(it?.sets);
    const lighter = Number.isFinite(sets) && sets >= 3 ? sets - 1 : null;
    const key = twin?.name.toLowerCase() ?? "";
    if (twin && key !== name.toLowerCase() && !used.has(key) && !onDay.has(key)) {
      used.add(key);
      changes.push({
        day_number: dayNumber,
        swap: { from: name, to: twin.name },
        ...(lighter ? { sets: lighter } : {}),
        rep_low: twin.rep_low,
        rep_high: twin.rep_high,
        until: date,
        layer: "trip",
        reason,
      });
      continue;
    }
    // No twin (or it is the twin already, or the twin is on the day): the lift stays,
    // a set lighter where there is room, with the note.
    changes.push({
      day_number: dayNumber,
      exercise: name,
      ...(lighter ? { sets: lighter } : {}),
      note: lighter ? EASIER_NOTE : EASIER_NOTE_SAME_SETS,
      until: date,
      layer: "trip",
      reason,
    });
  }
  return changes;
}

/** What the answer says landed: the lifts that went bodyweight by name, and what stayed. */
export function easierTripMessage(day: string, changes: readonly any[]): string {
  const swapped = changes.filter((c) => c?.swap?.from).map((c) => String(c.swap.from));
  const stayed = changes.filter((c) => !c?.swap && c?.exercise);
  const stayedNames = stayed.map((c) => String(c.exercise));
  const lighter = stayed.filter((c) => c.sets != null).length;
  const how =
    lighter === stayed.length ? "a set lighter" : lighter === 0 ? "as written" : "a set lighter where there's room";
  const verb = (names: string[], one: string, many: string) => (names.length === 1 ? one : many);
  const parts: string[] = [];
  if (swapped.length) parts.push(`${day}: ${listWords(swapped)} ${verb(swapped, "goes", "go")} bodyweight`);
  if (stayedNames.length) {
    const lead = swapped.length ? listWords(stayedNames) : `${day}: ${listWords(stayedNames)}`;
    parts.push(`${lead} ${verb(stayedNames, "stays", "stay")}, ${how}`);
  }
  return `${parts.join("; ")}. Your plan is back the day after.`;
}

// ---------- answers ----------

const ASK_GONE = "That question has already been answered, so nothing changed.";

function answerTrip(date: string, answer: BriefAskAnswerKey, today: string): BriefAskAnswerResult {
  const key = `${TRIP_ASK_PREFIX}${date}`;
  if (answer !== "yes" && answer !== "skip" && answer !== "easier") {
    return { ok: false, key, error: "That isn't one of the answers to this question." };
  }
  const trip = safe(() => tripEventOn(date), null);
  if (!trip) return { ok: false, key, error: "There's no trip on that day any more, so nothing changed." };
  if (trip.lift_answers[date]) return { ok: false, key, error: ASK_GONE };
  const lift = plannedLiftOn(date, today);
  if (answer === "yes") {
    recordTripLiftAnswer(trip.id, date, "yes");
    return { ok: true, key, answer, message: "Noted — the lift stays as planned." };
  }
  if (!lift) return { ok: false, key, error: "There's no lift planned that day any more, so nothing changed." };
  if (answer === "skip") {
    const event = addContextEvent({
      kind: "life_event",
      title: "Rest day — on the trip",
      detail: `You chose to skip ${lift.name} on the trip.`,
      start_date: date,
      end_date: date,
      meta: { claims_day: true, trip_skip: true, trip_id: trip.id },
    } as any) as any;
    recordTripLiftAnswer(trip.id, date, "skip");
    safe(() => invalidateDayRead(date), undefined);
    return {
      ok: true,
      key,
      answer,
      event_id: event?.id != null ? Number(event.id) : null,
      message: `Noted — ${weekdayName(date)} is a rest day. Nothing is owed for it.`,
    };
  }
  const changes = easierTripChanges(lift.day_number, date);
  if (!changes.length) return { ok: false, key, error: "There was nothing on that day to make lighter." };
  const proposal = createProposal("trip-ask", `A lighter ${lift.name} on the trip (${date})`, "", {
    summary: `${lift.name}, lighter on the trip — ${weekdayName(date)} only.`,
    rationale: "You asked for an easier day on the trip; the plan as it stood comes back the day after.",
    changes,
  }) as any;
  const proposalId = Number(proposal?.id);
  if (!(proposalId > 0)) return { ok: false, key, error: "The lighter day couldn't be written, so nothing changed." };
  try {
    // The ordinary apply, plus the server-owned Undo every plan change carries.
    applyAnsweredProposal(proposalId);
  } catch (error: any) {
    safe(() => setProposalStatus(proposalId, "discarded", { recordDecision: false }), null);
    return {
      ok: false,
      key,
      error: `The lighter day couldn't be written, so nothing changed. ${String(error?.message ?? "")}`.trim(),
    };
  }
  if (proposalStatus(proposalId) !== "applied") {
    safe(() => setProposalStatus(proposalId, "discarded", { recordDecision: false }), null);
    return { ok: false, key, error: "The lighter day couldn't be written, so nothing changed." };
  }
  recordTripLiftAnswer(trip.id, date, "easier");
  return {
    ok: true,
    key,
    answer,
    proposal_id: proposalId,
    message: easierTripMessage(weekdayName(date), changes),
  };
}

const RETURN_FAILED = "It couldn't be brought back just now, so nothing changed.";

function answerReturn(proposalId: number, answer: BriefAskAnswerKey): BriefAskAnswerResult {
  const key = `${RETURN_ASK_PREFIX}${proposalId}`;
  if (answer !== "bring_back" && answer !== "keep") {
    return { ok: false, key, error: "That isn't one of the answers to this question." };
  }
  // Only an asked return answers here — never any other draft by its id.
  const asked = safe(() => askedAdaptationGroups(), []).some((group) => group.proposal_id === proposalId);
  if (!asked || proposalStatus(proposalId) !== "draft") return { ok: false, key, error: ASK_GONE };
  // The asks settle on the server's own day, never the caller's.
  const today = localDateISO();
  if (answer === "keep") {
    setProposalStatus(proposalId, "discarded");
    settleAskedAdaptations(today);
    return {
      ok: true,
      key,
      answer,
      proposal_id: proposalId,
      message: "Kept as it is — ask whenever you want the regular plan back.",
    };
  }
  let applied: any = null;
  try {
    applied = applyProposal(proposalId);
  } catch (error: any) {
    return { ok: false, key, error: String(error?.message ?? "").trim() || RETURN_FAILED };
  }
  // A refusal comes back as {ok:false} with nothing saved: the ask stays as it was.
  if (applied?.ok === false || proposalStatus(proposalId) !== "applied") {
    const reason = typeof applied?.error === "string" && applied.error.trim() ? applied.error.trim() : RETURN_FAILED;
    return { ok: false, key, error: reason };
  }
  settleAskedAdaptations(today);
  return { ok: true, key, answer, proposal_id: proposalId, message: "Back to the regular plan." };
}

/** Answer one Brief question by its key. `{ok:false, error}` is the designed failure signal. */
export function answerBriefAsk(input: { key?: unknown; answer?: unknown; date?: unknown }): BriefAskAnswerResult {
  const key = String(input.key ?? "").trim();
  const answer = String(input.answer ?? "").trim() as BriefAskAnswerKey;
  const today = dayKey(input.date) ?? localDateISO();
  if (key.startsWith(TRIP_ASK_PREFIX)) {
    const date = dayKey(key.slice(TRIP_ASK_PREFIX.length));
    if (!date) return { ok: false, key, error: "That question names no day I can read." };
    return answerTrip(date, answer, today);
  }
  if (key.startsWith(RETURN_ASK_PREFIX)) {
    const id = Math.trunc(Number(key.slice(RETURN_ASK_PREFIX.length)));
    if (!(id > 0)) return { ok: false, key, error: "That question names nothing I can find." };
    return answerReturn(id, answer);
  }
  return { ok: false, key, error: "That isn't a question the Brief asked." };
}
