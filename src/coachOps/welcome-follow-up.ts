// The welcome's ONE follow-up question — about running, and only when it is needed.
//
// A first message that mentions running or a race usually does not say which days the
// person runs or how much they run now. Without the days, the run engine fits the runs
// around the lifting week (and the first week once promised a Wednesday it never showed);
// without the volume, the race build starts from a guess. So Meet asks once, calmly, in
// the conversation — never a form — and only for what is still missing:
//
//   - which days they run   → the stated endurance_schedule (the existing setter);
//   - roughly how far a week → the endurance goal's weekly_km, the volume anchor the race
//     build starts from when nothing is logged yet (only when there is a goal to hold it).
//
// Already said (in the first message, or by an earlier answer) → not asked. The answer
// is read deterministically from the person's own words (src/repo/run-words.ts): weekday
// names they wrote, and a distance they said was the week's. Nothing they did not write
// is invented; what cannot be read is said back plainly, with Ask as the place to tell it
// later. When unsure, nothing is stored.
import { pickDayVariant } from "../repo/brain/day-read-rules.js";
import {
  getEnduranceGoal,
  getEnduranceSchedule,
  normalizeEnduranceGoal,
  setProfile,
  WEEKDAY_NAMES,
} from "../repo/profile.js";
import { distanceWords, kmFromMiles } from "../repo/display-words.js";
import { athleteUnits } from "../repo/settings.js";
import { localDateISO } from "../repo/shared.js";
import { mentionsRunningIntent, namedWeekdays } from "../repo/run-words.js";
import { log } from "../log.js";
import { welcomeCalendarWeek, type WelcomeWeekDay } from "./welcome-calendar.js";

export type WelcomeFollowUpAsk = "days" | "volume";

export interface WelcomeFollowUp {
  asks: WelcomeFollowUpAsk[];
  question: string;
}

// Each set carries one idea: the days, the distance, or both — one question, never two.
const ASK_BOTH: readonly string[] = [
  "One quick thing so the runs land in the right places: which days do you usually run, and roughly how far do you run in a week right now?",
  "So your runs land where you'd put them: which days do you run, and about how far is a normal week at the moment?",
  "Before the runs go in: which days do you usually run, and roughly how much running is a typical week now?",
];
const ASK_DAYS: readonly string[] = [
  "One quick thing so the runs land in the right places: which days do you usually run?",
  "So your runs land where you'd put them: which days do you usually run?",
  "Before the runs go in: which days of the week do you usually run?",
];
const ASK_VOLUME: readonly string[] = [
  "One quick thing so the build starts from the right place: roughly how far do you run in a week right now?",
  "So the build starts where you are: about how far is a normal running week for you at the moment?",
  "Before the build starts: roughly how much running is a typical week for you now?",
];
export const WELCOME_FOLLOW_UP_QUESTIONS = { both: ASK_BOTH, days: ASK_DAYS, volume: ASK_VOLUME } as const;

// What is still unsaid, read off the profile: the run days (none stated), and the weekly
// volume (only when a goal is there to hold it and it has none).
function stillUnsaid(date: string): WelcomeFollowUpAsk[] {
  const goal = getEnduranceGoal(date);
  const asks: WelcomeFollowUpAsk[] = [];
  if (!getEnduranceSchedule()?.days.length) asks.push("days");
  if (goal && !(Number(goal.weekly_km) > 0)) asks.push("volume");
  return asks;
}

/**
 * The follow-up this welcome should ask, or null. Read AFTER the first message was
 * applied, so anything it already stated (run days, a weekly volume on the goal) is
 * already on the profile and is not asked again.
 */
export function welcomeRunFollowUp(raw: string, date = localDateISO()): WelcomeFollowUp | null {
  let goal: ReturnType<typeof getEnduranceGoal> = null;
  let asks: WelcomeFollowUpAsk[] = [];
  try {
    goal = getEnduranceGoal(date);
    asks = stillUnsaid(date);
  } catch {
    return null;
  }
  // Running as something they do or want — "run a tight ship" is not running, and "I
  // don't run and have no races planned" is not intent (run-words.ts).
  if (!goal && !mentionsRunningIntent(raw)) return null;
  if (!asks.length) return null;
  const set = asks.length === 2 ? ASK_BOTH : asks[0] === "days" ? ASK_DAYS : ASK_VOLUME;
  return { asks, question: pickDayVariant(set, date, `welcome_follow_up:${asks.join("+")}`) };
}

// ---------- reading the answer ----------

type RunKind = "easy" | "quality" | "long" | "any";

function clauseKind(clause: string): RunKind {
  const kinds = new Set<RunKind>();
  if (/\blong\b/i.test(clause)) kinds.add("long");
  if (/\b(?:easy|recovery|slow|gentle|short)\b/i.test(clause)) kinds.add("easy");
  if (/\b(?:tempo|intervals?|speed|track|quality|workout|threshold|hills?|reps|fartlek)\b/i.test(clause))
    kinds.add("quality");
  return kinds.size === 1 ? [...kinds][0] : "any";
}

const DISTANCE =
  /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(km|k|kms|kilometers?|kilometres?|mi|mile|miles)\b/gi;

// A distance is the WEEK's only when the words say so right at it: "30 km a week",
// "20 miles per week", "25k/wk", "30 km weekly", "a 40k week", "weekly mileage of 30 km",
// "30 km in a normal week". "A week" elsewhere in the answer ("3x a week, 5 km each")
// does not make a distance weekly.
const PER_WEEK_AFTER =
  /^\s*(?:(?:in\s+)?total\s+|or\s+so\s+|-?ish\s+|altogether\s+)?(?:(?:a|per|each|every|\/)\s*(?:week|wk)\b|weekly\b|(?:week|wk)s?\b|in\s+an?\s+(?:(?:normal|typical|usual|average|regular|good)\s+)?(?:week|wk)\b)/i;
const PER_WEEK_BEFORE =
  /\bweekly(?:\s+(?:mileage|volume|distance|total|running|km|miles))?\s*(?:is|of|=|:|at)?\s*(?:around|about|roughly|approx(?:imately)?|~)?\s*$/i;
// A distance that is ONE run's, never the week's: the long run, a race or an event
// distance ("training for a 10k"), or a per-run amount ("5 km each").
const LONG_BEFORE = /\blong(?:est)?(?:\s+(?:run|one))?\s*(?:is|of|=|:|at|was)?\s*(?:around|about|roughly|~)?\s*$/i;
const EVENT_BEFORE = /\b(?:a|an|the|my)\s+$|\brace\s+(?:is\s+)?(?:an?\s+)?$/i;
const EVENT_AFTER = /^\s*(?:races?|run\b|pb|pr|time|event)/i;
const PER_RUN_AFTER =
  /^\s*(?:each|per\s+(?:run|session|outing)|every\s+(?:run|time)|a\s+(?:run|go|session)|each\s+time)\b/i;
// How many runs a week they said: "3x a week", "four days a week", "twice a week".
const COUNT_WORDS: Record<string, number> = {
  one: 1,
  once: 1,
  two: 2,
  twice: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};
const RUNS_PER_WEEK =
  /\b(\d{1,2}|one|two|three|four|five|six|seven|once|twice)\s*(?:x|×|times|days|runs|sessions)?\s*(?:a|per|each|every|\/)\s*(?:week|wk)\b/i;

export interface RunFollowUpAnswer {
  days: Array<{ dow: number; kind: RunKind }>;
  weekly_km: number | null;
}

/**
 * What the answer SAYS: the weekdays it names (run-words.ts — whole words only, the
 * ambiguous abbreviations only in a day context, a ruled-out day never), each with a
 * run kind when its clause says one ("long run Sunday"); and a weekly distance.
 *
 * The weekly distance is read in exactly two ways, and nothing else counts:
 *   1. a distance stated per week, at the distance ("30 km a week", "20 miles per week",
 *      "weekly mileage of 30 km") — never a long run's, a race's or a per-run one;
 *   2. a per-run distance times a stated run count, when that is the ONLY distance in
 *      the answer: "3x a week, 5 km each" is 15 km. The person said both numbers, the
 *      product is what they described, and the reply says it back, so a wrong reading
 *      is one sentence from corrected. A second distance anywhere (a long run, a race)
 *      makes the week's total unknowable, so nothing is stored.
 * A bare distance ("weekends, 30k") is not read as the week's: when unsure, null.
 */
export function parseRunFollowUpAnswer(text: unknown): RunFollowUpAnswer {
  const words = typeof text === "string" ? text.slice(0, 600) : "";
  const byDow = new Map<number, RunKind>();
  for (const mention of namedWeekdays(words).days) {
    const kind = clauseKind(mention.clause);
    const prior = byDow.get(mention.dow);
    byDow.set(mention.dow, prior && prior !== "any" ? prior : kind);
  }
  const days = [...byDow.entries()]
    .sort((a, b) => ((a[0] + 6) % 7) - ((b[0] + 6) % 7))
    .map(([dow, kind]) => ({ dow, kind }));

  const found: Array<{ km: number; weekly: boolean; perRun: boolean }> = [];
  for (const match of words.matchAll(DISTANCE)) {
    const low = Number(match[1]);
    const high = match[2] != null ? Number(match[2]) : low;
    const unit = match[3].toLowerCase();
    const raw = (low + high) / 2;
    const km = unit.startsWith("m") ? kmFromMiles(raw) : raw;
    const at = match.index ?? 0;
    // The words around a distance stop at a clause break, so one clause never
    // qualifies another clause's distance.
    const head = words.slice(Math.max(0, at - 40), at);
    const before = head.slice(head.search(/[^.;!?\n,]*$/));
    const after = words.slice(at + match[0].length, at + match[0].length + 40).split(/[.;!?\n,]/)[0];
    const long = LONG_BEFORE.test(before);
    const event = EVENT_BEFORE.test(before) || EVENT_AFTER.test(after);
    const statedWeekly = PER_WEEK_AFTER.test(after) || PER_WEEK_BEFORE.test(before);
    // "a 40k week" is a week even with the article in front of it.
    const weekNoun = /^\s*(?:week|wk)s?\b/i.test(after);
    found.push({
      km,
      weekly: !long && statedWeekly && (weekNoun || !event),
      perRun: !long && !event && PER_RUN_AFTER.test(after),
    });
  }
  let weeklyKm: number | null = found.find((d) => d.weekly)?.km ?? null;
  if (weeklyKm == null && found.length === 1 && found[0].perRun) {
    const count = RUNS_PER_WEEK.exec(words)?.[1]?.toLowerCase();
    const runs = count == null ? Number.NaN : (COUNT_WORDS[count] ?? Number(count));
    if (Number.isInteger(runs) && runs >= 1 && runs <= 14) weeklyKm = found[0].km * runs;
  }
  const weekly_km = weeklyKm != null && weeklyKm >= 1 && weeklyKm <= 400 ? Math.round(weeklyKm * 10) / 10 : null;
  return { days, weekly_km };
}

// ---------- applying it ----------

export interface WelcomeFollowUpResult {
  ok: true;
  /** The coach's answer back, in plain words. */
  reply: string;
  /** What landed: the stated run weekdays (0 = Sunday) and the weekly volume anchor. */
  applied: { run_days: number[]; weekly_km: number | null };
  /** The whole week as the calendar now holds it (null while nothing is on the plan). */
  week: WelcomeWeekDay[] | null;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The reply, about exactly what happened: what landed (and that it can change), what
 * was asked but not read (calmly, with Ask as the place to say it), and — when the run
 * days were already stated — that they stay as they are, never "I couldn't pick out
 * days".
 */
function followUpReply(input: {
  runDays: number[];
  weeklyKm: number | null;
  missing: WelcomeFollowUpAsk[];
  daysKept: boolean;
}): string {
  const landed: string[] = [];
  if (input.runDays.length) {
    const ordered = [...input.runDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    landed.push(`your runs go on ${listWords(ordered.map((dow) => WEEKDAY_NAMES[dow]))}`);
  }
  if (input.weeklyKm != null) {
    // In the athlete's own units (display-words.ts is the one formatter).
    const distance = distanceWords(input.weeklyKm, athleteUnits().distance, { whole: true });
    landed.push(`the build starts from around ${distance} a week`);
  }
  const missingWords =
    input.missing.length === 2
      ? "your run days or a weekly distance"
      : input.missing[0] === "days"
        ? "which days you run"
        : "a weekly distance";
  const kept = "Your run days were already set, so they stay as they are.";
  if (landed.length) {
    const sentences = [`Got it: ${listWords(landed)}.`];
    if (input.daysKept) sentences.push(kept);
    if (input.missing.length) sentences.push(`I didn't catch ${missingWords} there; tell me in Ask any time.`);
    const what = landed.length === 2 ? "either" : input.runDays.length ? "the days" : "that distance";
    sentences.push(`You can change ${what} by just telling me.`);
    return sentences.join(" ");
  }
  if (input.daysKept && !input.missing.length) return `${kept} Tell me in Ask if they've changed.`;
  if (input.missing.length) {
    return `${input.daysKept ? `${kept} ` : ""}I couldn't pick out ${missingWords} there, so I've left that for now. Tell me any time in Ask and I'll set it.`;
  }
  return "I couldn't pick out days or a distance there. Tell me any time in Ask and I'll set them.";
}

/**
 * Apply the person's answer through the existing setters: their run weekdays as the
 * stated endurance_schedule (only when none is stated yet — the follow-up never
 * overwrites a schedule they gave), and the weekly distance onto the endurance goal's
 * volume anchor (only when the goal has none). Always ok:true; what could not be read is
 * said plainly and nothing is guessed.
 */
export function answerWelcomeFollowUp(text: unknown, date = localDateISO()): WelcomeFollowUpResult {
  const answer = parseRunFollowUpAnswer(text);
  const applied: WelcomeFollowUpResult["applied"] = { run_days: [], weekly_km: null };
  let asked: WelcomeFollowUpAsk[] = [];
  try {
    asked = stillUnsaid(date);
  } catch {
    asked = [];
  }
  let daysKept = false;
  try {
    if (answer.days.length && answer.days.length < 7) {
      if (getEnduranceSchedule()?.days.length) daysKept = true;
      else {
        setProfile({ endurance_schedule: { days: answer.days, source: "chat" } });
        applied.run_days = getEnduranceSchedule()?.days.map((d) => d.dow) ?? [];
      }
    }
  } catch (err) {
    log.warn("[welcome] could not store the run days from the follow-up", { error: err });
  }
  try {
    const goal = getEnduranceGoal(date);
    if (answer.weekly_km != null && goal && !(Number(goal.weekly_km) > 0)) {
      const next = normalizeEnduranceGoal({ ...goal, weekly_km: answer.weekly_km });
      if (next) {
        setProfile({ endurance_goal: next });
        applied.weekly_km = next.weekly_km ?? null;
      }
    }
  } catch (err) {
    log.warn("[welcome] could not store the weekly volume from the follow-up", { error: err });
  }
  const missing = asked.filter((ask) =>
    ask === "days" ? !applied.run_days.length && !daysKept : applied.weekly_km == null
  );
  const reply = followUpReply({ runDays: applied.run_days, weeklyKm: applied.weekly_km, missing, daysKept });
  return { ok: true, reply, applied, week: welcomeCalendarWeek(date) };
}
