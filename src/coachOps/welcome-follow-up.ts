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
// is read deterministically from the person's own words: weekday names they wrote, and a
// distance with its unit. Nothing they did not write is invented; what cannot be read is
// said back plainly, with Ask as the place to tell it later.
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

// Running in the person's own words: the activity, or a race distance.
const RUNNING_WORDS =
  /\b(?:run|runs|running|runner|ran|jog|jogging|race|racing|marathon|half[\s-]*marathon|ultra|parkrun|5\s?k|10\s?k|\d+\s?(?:km|k)\s+race)\b/i;

/**
 * The follow-up this welcome should ask, or null. Read AFTER the first message was
 * applied, so anything it already stated (run days, a weekly volume on the goal) is
 * already on the profile and is not asked again.
 */
export function welcomeRunFollowUp(raw: string, date = localDateISO()): WelcomeFollowUp | null {
  let goal: ReturnType<typeof getEnduranceGoal> = null;
  let runDays = 0;
  try {
    goal = getEnduranceGoal(date);
    runDays = getEnduranceSchedule()?.days.length ?? 0;
  } catch {
    return null;
  }
  if (!goal && !RUNNING_WORDS.test(String(raw ?? ""))) return null;
  const asks: WelcomeFollowUpAsk[] = [];
  if (!runDays) asks.push("days");
  // The volume has somewhere to go only when there is a goal to anchor (weekly_km).
  if (goal && !(Number(goal.weekly_km) > 0)) asks.push("volume");
  if (!asks.length) return null;
  const set = asks.length === 2 ? ASK_BOTH : asks[0] === "days" ? ASK_DAYS : ASK_VOLUME;
  return { asks, question: pickDayVariant(set, date, `welcome_follow_up:${asks.join("+")}`) };
}

// ---------- reading the answer ----------

const DAY_WORDS: ReadonlyArray<[RegExp, number[]]> = [
  [/\bweekends?\b/i, [6, 0]],
  [/\bsun(?:day)?s?\b/i, [0]],
  [/\bmon(?:day)?s?\b/i, [1]],
  [/\btue(?:s|sday)?s?\b/i, [2]],
  [/\bwed(?:s|nesday)?s?\b/i, [3]],
  [/\bthu(?:r|rs|rsday)?s?\b/i, [4]],
  [/\bfri(?:day)?s?\b/i, [5]],
  [/\bsat(?:urday)?s?\b/i, [6]],
];

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

export interface RunFollowUpAnswer {
  days: Array<{ dow: number; kind: RunKind }>;
  weekly_km: number | null;
}

/**
 * What the answer SAYS: the weekdays it names (with a run kind when the same clause says
 * one — "long run Sunday"), and a weekly distance. A distance counts as weekly when the
 * words around it say so ("a week", "weekly", "per week"), or when it is the only
 * distance in an answer to a volume question and is not the long run's.
 */
export function parseRunFollowUpAnswer(
  text: unknown,
  asks: readonly WelcomeFollowUpAsk[] = ["days", "volume"]
): RunFollowUpAnswer {
  const words = typeof text === "string" ? text.slice(0, 600) : "";
  const byDow = new Map<number, RunKind>();
  for (const clause of words.split(/[,;.\n]|\bthen\b/i)) {
    const kind = clauseKind(clause);
    for (const [pattern, dows] of DAY_WORDS) {
      if (!pattern.test(clause)) continue;
      for (const dow of dows) {
        const prior = byDow.get(dow);
        byDow.set(dow, prior && prior !== "any" ? prior : kind);
      }
    }
  }
  const days = [...byDow.entries()]
    .sort((a, b) => ((a[0] + 6) % 7) - ((b[0] + 6) % 7))
    .map(([dow, kind]) => ({ dow, kind }));

  const found: Array<{ km: number; weekly: boolean; long: boolean }> = [];
  for (const match of words.matchAll(DISTANCE)) {
    const low = Number(match[1]);
    const high = match[2] != null ? Number(match[2]) : low;
    const unit = match[3].toLowerCase();
    const raw = (low + high) / 2;
    const km = unit.startsWith("m") ? kmFromMiles(raw) : raw;
    const at = match.index ?? 0;
    const before = words.slice(Math.max(0, at - 24), at);
    const after = words.slice(at + match[0].length, at + match[0].length + 24);
    found.push({
      km,
      weekly: /\b(?:weekly|a week|per week|each week|every week|\/\s?w(?:ee)?k|wk)\b/i.test(`${before} ${after}`),
      long: /\blong\b/i.test(`${before} ${after}`),
    });
  }
  const weekly =
    found.find((d) => d.weekly) ??
    (asks.includes("volume") && found.length === 1 && !found[0].long ? found[0] : undefined);
  const weekly_km = weekly && weekly.km >= 1 && weekly.km <= 400 ? Math.round(weekly.km * 10) / 10 : null;
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
 * Apply the person's answer through the existing setters: their run weekdays as the
 * stated endurance_schedule (only when none is stated yet — the follow-up never
 * overwrites a schedule they gave), and the weekly distance onto the endurance goal's
 * volume anchor (only when the goal has none). Always ok:true; what could not be read is
 * said plainly and nothing is guessed.
 */
export function answerWelcomeFollowUp(text: unknown, date = localDateISO()): WelcomeFollowUpResult {
  const answer = parseRunFollowUpAnswer(text);
  const applied: WelcomeFollowUpResult["applied"] = { run_days: [], weekly_km: null };
  try {
    if (answer.days.length && answer.days.length < 7 && !getEnduranceSchedule()?.days.length) {
      setProfile({ endurance_schedule: { days: answer.days, source: "chat" } });
      applied.run_days = getEnduranceSchedule()?.days.map((d) => d.dow) ?? [];
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
  const parts: string[] = [];
  if (applied.run_days.length) {
    const ordered = [...applied.run_days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    parts.push(`your runs go on ${listWords(ordered.map((dow) => WEEKDAY_NAMES[dow]))}`);
  }
  if (applied.weekly_km != null) {
    // In the athlete's own units (display-words.ts is the one formatter).
    const distance = distanceWords(applied.weekly_km, athleteUnits().distance, { whole: true });
    parts.push(`the build starts from around ${distance} a week`);
  }
  const reply = parts.length
    ? `Got it: ${listWords(parts)}. You can change either by just telling me.`
    : "I couldn't pick out days or a distance there. Tell me any time in Ask and I'll set them.";
  return { ok: true, reply, applied, week: welcomeCalendarWeek(date) };
}
