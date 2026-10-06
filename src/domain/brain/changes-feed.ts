import type { BrainDecision, BrainDecisionKind } from "../../brain/decision-contract.js";
import type { BrainExpectation } from "../../brain/expectation-contract.js";
import type { BrainEvaluation } from "../../brain/evaluation-contract.js";
import {
  BRAIN_CHANGE_OUTCOME_PHRASES,
  type ClientBrainChange,
  type ClientBrainChangeConfidence,
  type ClientBrainChangeDay,
  type ClientBrainChangeOutcomeKey,
  type ClientBrainChanges,
  type ClientBrainChangesSeenResponse,
  type ClientBrainChangeState,
  type ClientBrainSetAside,
} from "../../contracts/brain-changes.js";
import { getBrainRollback, listBrainDecisions, listBrainExpectations } from "../../repo/brain-decisions.js";
import { latestBrainEvaluation } from "../../repo/brain-evaluations.js";
import { getAppState, setAppState } from "../../repo/app-state.js";
import { getProposal } from "../../repo/proposals.js";
import { athleteLine } from "../../repo/brain/clinician-ask.js";
import { type PlanPrescription, planPrescriptionKey, planPrescriptionSnapshot } from "../../repo/plan.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import {
  addDaysISO,
  clipText,
  daysBetweenISO,
  joinList,
  localDateISO,
  localDayOfStamp,
  localHourFraction,
  parseDbTime,
} from "../../repo/shared.js";

// ============================================================================
// THE CHANGES FEED — what the team changed, why, how it went, and Undo.
//
// A read-only, deterministic PROJECTION of `brain_decisions` for a person (v2 wave 1).
// It invents nothing: every row is a decision the ledger already holds, and Undo is
// the existing server revert (`revertDecision`) over the snapshot the autonomy layer
// stored. What it adds is the athlete register — a finished title, the why in the
// spoken voice (never signal-state `summary`/`reason` prose, never a producer label),
// one of the four fixed outcome phrases, a confidence WORD, and the Undo label naming
// the concrete effect. No evaluator verdict text, score or number-as-grade crosses it.
//
// Which rows are CHANGES: a coaching kind the TEAM decided — autonomy tier
// `quiet_apply` or `announce` — that is announced, in effect, put back, or held by the
// athlete before it landed. A change the athlete applied by hand answered an ask
// (tier `ask`) and is their own action, not the team's; advisories, day reads,
// directives and data plumbing (Garmin merges) are not changes to a plan. Nor is a
// meal plan: it is a week of meal IDEAS, never eaten as written, and adopting one moves
// no target and nothing the athlete does (the calorie target is its own kind).
// ============================================================================

const CHANGE_KINDS: ReadonlySet<string> = new Set<BrainDecisionKind>([
  "training_target",
  "training_structure",
  "exercise_rotation",
  "nutrition_target",
  "recovery_adjustment",
  "lifestyle_adjustment",
  "goal_change",
]);
const TEAM_TIERS: ReadonlySet<string> = new Set(["quiet_apply", "announce"]);

// The app_state key holding the ISO instant the athlete last opened the feed.
export const BRAIN_CHANGES_SEEN_KEY = "brain_changes_seen_at";
// Before the feed was ever opened there is no marker; the Today line then counts only
// what landed in the last day rather than shouting the whole ledger at a first open.
const UNSEEN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_LIMIT = 40;

type Row = ClientBrainChange & { event_at: string | null };

function stamp(value: unknown): string | null {
  const parsed = parseDbTime(value);
  return parsed ? parsed.toISOString() : null;
}

function heldByAthlete(decision: BrainDecision): boolean {
  const context = (decision.context ?? {}) as Record<string, unknown>;
  return decision.status === "canceled" && context.held_by_user === true;
}

function changeState(decision: BrainDecision): ClientBrainChangeState | null {
  if (decision.status === "announced") return "announced";
  if (decision.status === "reverted") return "reverted";
  if (heldByAthlete(decision)) return "held";
  // `superseded` after landing is still a change that happened; only its Undo is gone.
  if (decision.status === "applied" || (decision.status === "superseded" && decision.applied_at)) return "applied";
  return null;
}

function isTeamChange(decision: BrainDecision): boolean {
  return CHANGE_KINDS.has(String(decision.kind)) && TEAM_TIERS.has(String(decision.autonomy_tier));
}

// STATED INPUT (2026-10-06): a change that is the athlete's own word — a push stance, a
// stated quality session — is recorded `observe` (they decided; Cairn recorded), so the
// team-tier test above never saw it and "You said X → the brain changed Y" had no row.
// It is a change to what the engines do, so it belongs here, marked as theirs.
function isStatedChange(decision: BrainDecision): boolean {
  const context = (decision.context ?? {}) as Record<string, unknown>;
  return (
    CHANGE_KINDS.has(String(decision.kind)) &&
    (context.stated_by_athlete === true || context.training_drive_stance === true)
  );
}

function statedWords(decision: BrainDecision): string | null {
  if (!isStatedChange(decision)) return null;
  const words = String(((decision.context ?? {}) as Record<string, unknown>).words ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return words ? clipText(words, 160) : null;
}

// The athlete asked for it in their own words: it is in the feed, but it is not news.
function athleteAsked(decision: BrainDecision): boolean {
  const context = (decision.context ?? {}) as Record<string, unknown>;
  return (
    context.explicit_user_request === true || context.athlete_requested_restructure === true || isStatedChange(decision)
  );
}

// ---------- what the change touched (for the title, the composed why and the Undo label) ----------

// Which way one lift's prescription moved, read off the snapshot the change carries
// (`before` beside the after-values the apply wrote) or, for a change that has not
// landed yet, off the live plan it is about to overwrite. `unknown` when neither
// exists: an older row the feed cannot read a direction from, never a guessed one.
type LiftMove = "raised" | "lowered" | "held" | "range" | "sets_up" | "sets_down" | "added" | "unknown";

interface Touched {
  exercises: string[];
  // One per exercise, in the same order.
  moves: LiftMove[];
  swaps: Array<{ from: string; to: string }>;
  recoveryCycle: boolean;
}

type Prescription = Partial<Record<"sets" | "rep_low" | "rep_high" | "target_weight" | "target_seconds", unknown>>;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The value a field holds after the change. A field the change did not name keeps the
// value it had; only `target_weight` treats an explicit null as a value (bodyweight).
function after(change: Prescription, before: Prescription, key: keyof Prescription): unknown {
  const value = change[key];
  return value === undefined || (value === null && key !== "target_weight") ? before[key] : value;
}

function liftMove(change: Prescription, before: Prescription | null, added: boolean): LiftMove {
  if (added) return "added";
  if (!before) return "unknown";
  // Load first. Bodyweight (null) sits between an assist (negative) and added load, so
  // numeric order with null as 0 is also the harder-to-lift order: less assist is a raise.
  const weightBefore = num(before.target_weight) ?? 0;
  const weightAfter = num(after(change, before, "target_weight")) ?? 0;
  if (weightAfter !== weightBefore) return weightAfter > weightBefore ? "raised" : "lowered";
  const secondsBefore = num(before.target_seconds);
  const secondsAfter = num(after(change, before, "target_seconds"));
  if (secondsBefore != null && secondsAfter != null && secondsAfter !== secondsBefore)
    return secondsAfter > secondsBefore ? "raised" : "lowered";
  if (
    num(after(change, before, "rep_low")) !== num(before.rep_low) ||
    num(after(change, before, "rep_high")) !== num(before.rep_high)
  )
    return "range";
  const setsBefore = num(before.sets);
  const setsAfter = num(after(change, before, "sets"));
  if (setsBefore != null && setsAfter != null && setsAfter !== setsBefore)
    return setsAfter > setsBefore ? "sets_up" : "sets_down";
  return "held";
}

function payloadTouched(
  changes: unknown,
  swaps: unknown,
  beforeOf: (change: any) => Prescription | null
): Omit<Touched, "recoveryCycle"> {
  const swapList = (Array.isArray(swaps) ? swaps : [])
    .map((swap: any) => ({ from: String(swap?.from ?? "").trim(), to: String(swap?.to ?? "").trim() }))
    .filter((swap) => swap.from && swap.to);
  const swapNames = new Set(swapList.flatMap((swap) => [swap.from.toLowerCase(), swap.to.toLowerCase()]));
  const exercises: string[] = [];
  const moves: LiftMove[] = [];
  const swappedIn: string[] = [];
  const seen = new Set<string>();
  for (const change of Array.isArray(changes) ? changes : []) {
    const name = String(change?.exercise ?? "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    // The movement a swap brought in is the swap, not a second lift whose target moved.
    // The applied record names it by its resolved name, which can differ from the
    // draft's spelling; there it is the one entry with a recorded, empty `before` that
    // was not added (nothing of that name was on the day before the swap).
    const isSwapIn =
      swapNames.has(key) ||
      (swapList.length > 0 &&
        change &&
        typeof change === "object" &&
        "before" in change &&
        change.before == null &&
        change.change !== "added");
    if (isSwapIn) {
      if (!swapNames.has(key) || swapList.some((swap) => swap.to.toLowerCase() === key)) swappedIn.push(name);
      continue;
    }
    exercises.push(name);
    moves.push(liftMove(change ?? {}, beforeOf(change), change?.change === "added"));
  }
  // Name what came in the way the plan now spells it.
  const named =
    swappedIn.length === swapList.length ? swapList.map((swap, i) => ({ ...swap, to: swappedIn[i] })) : swapList;
  return { exercises, moves, swaps: named };
}

// The draft a plan-proposal decision was routed from, read once per row. Null when the
// decision has no draft behind it, or the draft cannot be read.
interface Draft {
  instruction: string;
  parsed: Record<string, any>;
}

function draftOf(decision: BrainDecision): Draft | null {
  const action = (decision.action ?? {}) as Record<string, any>;
  const proposalId =
    Number(action.proposal_id) ||
    (decision.source_ref_type === "plan_proposal" ? Number(decision.source_ref_key) : Number.NaN);
  if (!(proposalId > 0)) return null;
  try {
    const proposal = getProposal(proposalId) as any;
    if (!proposal) return null;
    const parsed = proposal.parsed && typeof proposal.parsed === "object" ? proposal.parsed : {};
    return { instruction: String(proposal.instruction ?? ""), parsed };
  } catch {
    return null; // an unreadable draft only thins the row
  }
}

// What one read of the feed shares across its rows: the day it reads as, and the live
// plan (read at most once, and only when a row that has not landed needs it).
interface ReadContext {
  asOf: string;
  livePlan: () => Map<string, PlanPrescription>;
}

function touched(decision: BrainDecision, draft: Draft | null, read: ReadContext): Touched {
  const action = (decision.action ?? {}) as Record<string, any>;
  const base = { recoveryCycle: Number(action.recovery_cycle_id) > 0 };
  if (Array.isArray(action.changes) || Array.isArray(action.swaps)) {
    // A landed change carries its own before-values.
    const recorded = (change: any): Prescription | null =>
      change?.before && typeof change.before === "object" ? change.before : null;
    return { ...base, ...payloadTouched(action.changes, action.swaps, recorded) };
  }
  // An announced change has not written its action yet; its draft says what it will do,
  // and the plan it has not touched yet is its before.
  if (draft) {
    const changes = Array.isArray(draft.parsed.changes) ? draft.parsed.changes : [];
    const swaps = changes
      .filter((change: any) => change?.swap?.from && change?.swap?.to)
      .map((change: any) => change.swap);
    const live = (change: any): Prescription | null => {
      const key = planPrescriptionKey(change?.day_number, change?.exercise);
      if (!key) return null;
      try {
        return read.livePlan().get(key) ?? null;
      } catch {
        return null;
      }
    };
    return {
      ...base,
      ...payloadTouched(
        changes.filter((change: any) => !change?.swap),
        swaps,
        live
      ),
    };
  }
  return { ...base, exercises: [], moves: [], swaps: [] };
}

// ---------- the athlete register ----------

// Producers' own prefixes on `instruction`/`rationale` ("auto: …", "case conference: …")
// — a record of who drafted it, not a sentence for a person — are refused by
// `athleteLine` (src/repo/brain/clinician-ask.ts), the one athlete-line gate the feed and
// the clinician ask projection share. Narrowed to the known producers, so an
// athlete-facing sentence that opens "Heads up: …" still reads.

// The progression engine. Its changes are earned from the log, which is the one cause
// the feed may name when it composes a why nobody wrote.
const PROGRESSION_SOURCE = "auto-progression";

// Producers whose `summary` is a templated label for the ledger, not a headline
// ("Auto-progression for day 1 — 2 lifts", "Rotate A → B on day 3"). Their title is
// worded from what the change touched instead.
const LABEL_SUMMARY_SOURCES: ReadonlySet<string> = new Set([PROGRESSION_SOURCE, "auto-run-plan", "exercise-swap"]);
// A plan-day NUMBER and an arrow are the ledger's shorthand, never the athlete's words.
const LABEL_SHAPE = /\bday \d+\b|→|->/i;

// True when `a` is `b`, or a clipped copy of it.
function sameText(a: unknown, b: unknown): boolean {
  // A clipped copy ends in an ellipsis; compare what is left of it as a prefix.
  const norm = (value: unknown) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .replace(/(?:…|\.\.\.)$/, "")
      .trim()
      .toLowerCase();
  const clipped = norm(a);
  const full = norm(b);
  return !!clipped && !!full && full.startsWith(clipped);
}

function spoken(text: unknown, max: number, draft: Draft | null = null): string | null {
  const value = athleteLine(text, max);
  if (!value) return null;
  // The decision's rationale falls back to the draft's `instruction` when the draft
  // wrote no rationale — the producer's label ("day 1 progression", "swap A → B",
  // "evolve program") or an agent-facing instruction. Never a why.
  if (draft && sameText(value, draft.instruction)) return null;
  return value;
}

// ---------- no absolute dates in a row that already sits under its day ----------
//
// Stored reasons are pinned to their dates on purpose (normalizeHistoricalReason in
// src/repo/proposal-truth.ts turns "today" into "on September 23, 2026" so a reason
// still reads true next month). The feed prints every row under its day, so the date
// comes back out here, in the projection only: relative to the row's day, or the
// sentence carrying it is dropped. The stored text is never rewritten.

const MONTHS_FULL = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_SOURCE =
  "(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|\\d{4}-\\d{2}-\\d{2})";
const ANY_DATE = new RegExp(`\\b${DATE_SOURCE}\\b`, "i");

function isoOfDate(phrase: string, anchor: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2})$/.exec(phrase.trim())?.[1];
  if (iso) return iso;
  const match = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/i.exec(phrase.trim());
  if (!match) return null;
  const month = MONTHS_FULL.indexOf(match[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const anchorYear = Number(anchor.slice(0, 4));
  const build = (year: number) => `${year}-${pad(month + 1)}-${pad(Number(match[2]))}`;
  if (match[3]) return build(Number(match[3]));
  // No year: the nearest reading that is not months after the row's day.
  const guess = build(anchorYear);
  return guess > (addDaysISO(anchor, 183) ?? anchor) ? build(anchorYear - 1) : guess;
}

function weekStart(day: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return addDaysISO(day, -((new Date(ms).getUTCDay() + 6) % 7)) ?? day;
}

interface RowVoice {
  // The day the row is printed under, and the day the feed is read as.
  day: string;
  asOf: string;
}

// The date said the way the feed says its own days (`dayWord`: today, yesterday, a
// weekday inside the near week), so a reason and the status line above it speak one
// language. Further back, the row's own day is already said by the day it sits under,
// so it is left out (""), and the day before it is "the day before". null when the
// date cannot be said plainly at all.
function relativeDay(iso: string, voice: RowVoice): string | null {
  const near = (addDaysISO(voice.asOf, -6) ?? voice.asOf) <= iso && iso <= (addDaysISO(voice.asOf, 6) ?? voice.asOf);
  if (near) return dayWord(iso, voice.asOf);
  if (iso === voice.day) return "";
  if (iso === addDaysISO(voice.day, -1)) return "the day before";
  return null;
}

const isWeekday = (word: string): boolean => WEEKDAYS.includes(word);

// "on <day>": a weekday keeps its "on"; the other words stand alone.
const onDay = (word: string): string => (isWeekday(word) ? `on ${word}` : word);

// "<day>'s": the row's own day, further back, is just "the".
function possessive(word: string): string {
  if (word === "") return "the";
  if (word === "the day before") return "the previous day's";
  return `${word}'s`;
}

function relativeWeek(iso: string, voice: RowVoice): string {
  const week = weekStart(iso);
  const rowWeek = weekStart(voice.day);
  const current = rowWeek === weekStart(voice.asOf);
  if (week === rowWeek) return current ? "this week" : "that week";
  if (week === addDaysISO(rowWeek, -7)) return current ? "last week" : "the week before";
  return iso < voice.day ? "an earlier week" : "a later week";
}

// A replacement that opens a sentence carries the capital the original span opened with.
function cased(replacement: string, source: string, offset: number): string {
  const before = source.slice(0, offset);
  const opens = before.trim() === "" || /[.!?]["'’”)\]]?\s+$/.test(before);
  return opens && replacement ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["'’”)\]]?)\s+(?=["'“‘(]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function withoutAbsoluteDates(text: string, voice: RowVoice): string | null {
  if (!ANY_DATE.test(text)) return text;
  const re = (pattern: string) => new RegExp(pattern.replace(/DATE/g, `(${DATE_SOURCE})`), "gi");
  const iso = (phrase: string) => isoOfDate(phrase, voice.day);
  // A day left out leaves a mark, so only the word after it can take its capital.
  const DROP = "\u0001";
  let out = text
    .replace(re("\\bthe week of DATE\\b"), (match, phrase: string, offset: number, source: string) => {
      const day = iso(phrase);
      return day ? cased(relativeWeek(day, voice), source, offset) : match;
    })
    .replace(re("\\s*\\bthrough DATE\\b"), (_match, phrase: string) => {
      const day = iso(phrase);
      const word = day ? relativeDay(day, voice) : null;
      return word ? ` through ${word}` : "";
    })
    .replace(
      re("\\bthe DATE(?= (?:session|workout)s?\\b)"),
      (match, phrase: string, offset: number, source: string) => {
        const day = iso(phrase);
        if (!day) return match;
        const word = relativeDay(day, voice);
        return cased(word == null ? "the last" : possessive(word), source, offset);
      }
    )
    .replace(re("\\bon DATE\\b"), (match, phrase: string, offset: number, source: string) => {
      const day = iso(phrase);
      if (!day) return match;
      const word = relativeDay(day, voice);
      if (word === "") return DROP;
      return cased(word == null ? (day < voice.day ? "earlier" : "later") : onDay(word), source, offset);
    })
    .replace(re("\\bDATE['’]s\\b"), (match, phrase: string, offset: number, source: string) => {
      const day = iso(phrase);
      const word = day ? relativeDay(day, voice) : null;
      return word == null ? match : cased(possessive(word), source, offset);
    })
    .replace(re("\\bthe DATE(?= [A-Za-z])"), (match, phrase: string, offset: number, source: string) => {
      const day = iso(phrase);
      if (!day) return match;
      const word = relativeDay(day, voice);
      return cased(word == null ? (day < voice.day ? "the earlier" : "the later") : possessive(word), source, offset);
    })
    // The row's own day, said bare ("Since Sep 6 the squat stalled"), is the day the
    // row already sits under: it leaves, with the little word that pointed at it.
    .replace(
      re("(?:\\b(?:since|from|as of|at|by|until|till)\\s+)?\\bDATE\\b"),
      (match, phrase: string, offset: number, source: string) => {
        const day = iso(phrase);
        const word = day ? relativeDay(day, voice) : null;
        if (word == null) return match;
        if (word === "") return DROP;
        const lead = match.slice(0, match.length - phrase.length);
        return cased(lead + word, source, offset);
      }
    );
  // A day left out at the head of a sentence hands its capital (and any comma it
  // carried) to the next word; a mark anywhere else just leaves.
  out = out
    .replace(
      new RegExp(`(^|[.!?]["'’”)\\]]?\\s+)\\s*${DROP}[\\s,;:]*(\\p{Ll})?`, "gu"),
      (_m, head: string, c?: string) => head + (c ? c.toUpperCase() : "")
    )
    .replace(new RegExp(`\\s*${DROP}`, "g"), "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  // A date nothing above could say plainly takes its sentence with it.
  out = splitSentences(out)
    .filter((sentence) => !ANY_DATE.test(sentence))
    .join(" ");
  return out || null;
}

// ---------- the why's shape ----------

// A sentence or two. Enough to say why; a paragraph belongs to the detail it came from.
const WHY_MAX_CHARS = 240;

function capWhy(text: string): string {
  const sentences = splitSentences(text);
  let out = "";
  for (const sentence of sentences.slice(0, 2)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > WHY_MAX_CHARS) break;
    out = next;
  }
  if (out) return out;
  // One sentence longer than the cap is cut at a word, never inside one.
  return clipText(sentences[0] ?? text, WHY_MAX_CHARS, { wordBoundary: true });
}

// A note a producer left for itself ("Gym lacks seated calf machine; swap to standing
// calf raise matching working weight") is not a sentence to a person: it opens without a
// capital or never ends. Only what reads as a sentence becomes the why.
function readsAsSentence(text: string): boolean {
  const value = text.trim();
  if (value.split(/\s+/).length < 3) return false;
  return /^["'“‘(]?[A-Z0-9]/.test(value) && /[.!?…]["'’”)\]]?$/.test(value);
}

function spokenWhy(text: unknown, draft: Draft | null, voice: RowVoice): string | null {
  const value = spoken(text, 1_000, draft);
  if (!value) return null;
  const undated = withoutAbsoluteDates(value, voice);
  if (!undated) return null;
  const capped = capWhy(undated);
  return readsAsSentence(capped) ? capped : null;
}

// ---------- titles ----------

const TITLE_FALLBACK: Record<string, string> = {
  training_target: "Moved a training target",
  training_structure: "Reshaped your training week",
  exercise_rotation: "Rotated an exercise",
  nutrition_target: "Adjusted your calorie target",
  recovery_adjustment: "Eased the week for recovery",
  lifestyle_adjustment: "Adjusted a daily habit",
  goal_change: "Adjusted your goal timeline",
};

// The verb follows the direction the snapshot shows, never a generic "moved": a hold
// reads as held, a new rep range as reshaped. "Moved" is left only for an older row
// whose direction the feed cannot read.
const ONE_LIFT: Record<LiftMove, (name: string) => string> = {
  raised: (name) => `Raised your ${name} target`,
  lowered: (name) => `Lowered your ${name} target`,
  held: (name) => `Held your ${name} target`,
  range: (name) => `Reshaped your ${name} rep range`,
  sets_up: (name) => `Added volume to your ${name}`,
  sets_down: (name) => `Trimmed volume on your ${name}`,
  added: (name) => `Added ${name} to your plan`,
  unknown: (name) => `Moved your ${name} target`,
};

const TWO_LIFTS: Record<LiftMove, (a: string, b: string) => string> = {
  raised: (a, b) => `Raised your ${a} and ${b} targets`,
  lowered: (a, b) => `Lowered your ${a} and ${b} targets`,
  held: (a, b) => `Held your ${a} and ${b} targets`,
  range: (a, b) => `Reshaped your ${a} and ${b} rep ranges`,
  sets_up: (a, b) => `Added volume to your ${a} and ${b}`,
  sets_down: (a, b) => `Trimmed volume on your ${a} and ${b}`,
  added: (a, b) => `Added ${a} and ${b} to your plan`,
  unknown: (a, b) => `Moved your ${a} and ${b} targets`,
};

const MANY_LIFTS: Record<LiftMove, (count: number) => string> = {
  raised: (count) => `Raised your targets on ${count} lifts`,
  lowered: (count) => `Lowered your targets on ${count} lifts`,
  held: (count) => `Held your targets on ${count} lifts`,
  range: (count) => `Reshaped the rep ranges on ${count} lifts`,
  sets_up: (count) => `Added volume on ${count} lifts`,
  sets_down: (count) => `Trimmed volume on ${count} lifts`,
  added: (count) => `Added ${count} lifts to your plan`,
  unknown: (count) => `Moved your targets on ${count} lifts`,
};

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function liftsTitle(exercises: string[], moves: LiftMove[]): string | null {
  if (!exercises.length) return null;
  const [first, second] = moves;
  if (exercises.length === 1) return ONE_LIFT[first](exercises[0]);
  const same = moves.every((move) => move === first);
  if (exercises.length === 2)
    return same
      ? TWO_LIFTS[first](exercises[0], exercises[1])
      : `${ONE_LIFT[first](exercises[0])} and ${lowerFirst(ONE_LIFT[second](exercises[1]))}`;
  return same ? MANY_LIFTS[first](exercises.length) : `Adjusted your targets on ${exercises.length} lifts`;
}

function writtenTitle(decision: BrainDecision, draft: Draft | null): string | null {
  if (LABEL_SUMMARY_SOURCES.has(String(decision.source ?? ""))) return null;
  const written = spoken(decision.summary, 140, draft);
  return written && !LABEL_SHAPE.test(written) ? written : null;
}

// A stated change is titled by WHAT IT CHANGED, in words with no absolute date (the feed's
// voice): the push and how long it runs, the quality session as named. Null when the row
// is not a stated one the feed knows how to title.
function statedTitle(decision: BrainDecision, voice: RowVoice): string | null {
  if (!isStatedChange(decision)) return null;
  const context = (decision.context ?? {}) as Record<string, unknown>;
  const action = (decision.action ?? {}) as Record<string, unknown>;
  if (context.training_drive_stance === true) {
    if (action.training_drive !== "push") return "Back to a steady drive";
    const until = String(action.until ?? "");
    const span = until ? daysBetweenISO(until, voice.day) : null;
    if (action.scope === "block") return "Pushing harder through the end of this block";
    if (span != null && span >= 0) {
      const days = span + 1;
      if (days % 7 === 0 && days <= 84) return `Pushing harder for the next ${countWord(days / 7)} week${days === 7 ? "" : "s"}`;
      return `Pushing harder for the next ${countWord(days)} days`;
    }
    return "Pushing harder, as you asked";
  }
  const label = String(action.title ?? "").trim();
  return label || null;
}

function changeTitle(decision: BrainDecision, what: Touched, draft: Draft | null, voice: RowVoice): string {
  const stated = statedTitle(decision, voice);
  if (stated) return stated;
  const written = writtenTitle(decision, draft);
  const undated = written ? withoutAbsoluteDates(written, voice) : null;
  if (undated) return undated;
  const { swaps, exercises, moves } = what;
  const perLift = decision.kind === "training_target" || decision.kind === "exercise_rotation";
  if (swaps.length) {
    // A swap is titled as the swap, whatever else rode along with it.
    const swapped =
      swaps.length === 1 ? `Swapped ${swaps[0].from} for ${swaps[0].to}` : `Swapped ${swaps.length} exercises`;
    const rest = perLift ? liftsTitle(exercises, moves) : null;
    return rest ? `${swapped} and ${lowerFirst(rest)}` : swapped;
  }
  if (perLift) {
    const lifts = liftsTitle(exercises, moves);
    if (lifts) return lifts;
  }
  return TITLE_FALLBACK[String(decision.kind)] ?? "Made a coaching change";
}

// ---------- the why ----------

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function countWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

type MoveGroup = "up" | "range" | "held" | "down" | "added";
const GROUP_ORDER: readonly MoveGroup[] = ["up", "range", "held", "down", "added"];
const GROUP_OF: Record<LiftMove, MoveGroup | null> = {
  raised: "up",
  sets_up: "up",
  range: "range",
  held: "held",
  lowered: "down",
  sets_down: "down",
  added: "added",
  unknown: null,
};

// Every lift went the same way. Only the step UP names a cause, because the progression
// engine only steps up what the log earned; the rest say what happened and nothing more.
const SAME_WAY_WHY: Record<MoveGroup, readonly string[]> = {
  up: [
    "Your recent sessions carried these, so each one moved up a step.",
    "Your logged sessions earned a step up on each of these.",
    "Each of these moved up a step on the strength of your recent sessions.",
  ],
  range: ["These keep their load and move to a new rep range.", "Same load on these, with a new rep range to work in."],
  held: ["These stay where they are for now.", "Nothing moved on these; they hold where they are for now."],
  down: ["Each of these eased back a step for now.", "All of these came down a step for now."],
  added: ["Each of these is new on your plan.", "These joined your plan."],
};

const GROUP_PHRASE: Record<MoveGroup, (count: number) => string> = {
  up: (count) => `${countWord(count)} moved up a step`,
  range: (count) => `${countWord(count)} moved to a new rep range`,
  held: (count) => `${countWord(count)} held where ${count === 1 ? "it was" : "they were"}`,
  down: (count) => `${countWord(count)} eased back`,
  added: (count) => `${countWord(count)} joined your plan`,
};

const MIXED_WHY: ReadonlyArray<(list: string) => string> = [
  (list) => `${capitalize(list)}.`,
  (list) => `Of these, ${list}.`,
];

// A progression that touched several lifts and wrote no why of its own: say what the
// snapshot shows, counted, in words that rotate by day. Null when any lift's direction
// cannot be read, when a swap rode along, or when the change is not the engine's.
function composedWhy(decision: BrainDecision, what: Touched, voice: RowVoice): string | null {
  if (String(decision.source ?? "") !== PROGRESSION_SOURCE) return null;
  if (what.swaps.length || what.exercises.length < 2) return null;
  const groups = what.moves.map((move) => GROUP_OF[move]);
  if (groups.some((group) => group == null)) return null;
  const key = `changes_why:${decision.id ?? ""}`;
  const present = GROUP_ORDER.filter((group) => groups.includes(group));
  if (present.length === 1) return pickDayVariant(SAME_WAY_WHY[present[0]], voice.day, key);
  const parts = present.map((group) => GROUP_PHRASE[group](groups.filter((g) => g === group).length));
  return pickDayVariant(MIXED_WHY, voice.day, key)(joinList(parts));
}

// The why is a sentence someone WROTE for the athlete (the action's own explanation,
// the draft's rationale, or, for a one-lift change, that lift's own reason) or, for a
// progression across several lifts, the count of which way they went. When none of
// that survives, the why is null rather than a cause nobody recorded.
function changeWhy(decision: BrainDecision, draft: Draft | null, what: Touched, voice: RowVoice): string | null {
  const action = (decision.action ?? {}) as Record<string, unknown>;
  const written =
    spokenWhy(action.user_explanation, draft, voice) ??
    (draft ? spokenWhy(draft.parsed.rationale, draft, voice) : spokenWhy(decision.rationale, null, voice));
  if (written) return written;
  const changes = draft && Array.isArray(draft.parsed.changes) ? draft.parsed.changes : [];
  if (changes.length === 1) {
    // A bare delta ("+5 lb") is a number, not a reason; readsAsSentence refuses it.
    const reason = spokenWhy(changes[0]?.reason, draft, voice);
    if (reason) return reason;
  }
  return composedWhy(decision, what, voice);
}

// The stated row's why: the athlete's words first, then what the brain changed for them.
// The quote is never cut inside a word; the change sentence is the decision's own.
function capStatedWhy(said: string, changed: string | null): string {
  const quote = `You said “${said.replace(/[“”"]/g, "")}”.`;
  if (!changed) return quote;
  const both = `${quote} ${changed}`;
  return both.length <= WHY_MAX_CHARS + 120 ? both : quote;
}

// ---------- outcome and confidence ----------

function latestOutcome(decision: BrainDecision): {
  expectation: BrainExpectation | null;
  evaluation: BrainEvaluation | null;
} {
  if (!decision.id) return { expectation: null, evaluation: null };
  let best: { expectation: BrainExpectation; evaluation: BrainEvaluation | null; when: string } | null = null;
  for (const expectation of listBrainExpectations({ decisionId: decision.id, limit: 12 })) {
    // A window a newer change took over never earns a verdict about THIS change.
    if (expectation.status === "superseded") continue;
    const evaluation = expectation.id ? latestBrainEvaluation(expectation.id) : null;
    const when = String(evaluation?.evaluated_at ?? expectation.window_end ?? expectation.created_at ?? "");
    if (!best || (!!evaluation && !best.evaluation) || (!!evaluation === !!best.evaluation && when > best.when))
      best = { expectation, evaluation, when };
  }
  return best
    ? { expectation: best.expectation, evaluation: best.evaluation }
    : { expectation: null, evaluation: null };
}

function outcomeKey(state: ClientBrainChangeState, evaluation: BrainEvaluation | null): ClientBrainChangeOutcomeKey {
  if (state === "reverted" || state === "held" || evaluation?.verdict === "canceled") return "stopped";
  if (evaluation?.verdict === "aligned") return "as_expected";
  if (evaluation?.verdict === "not_aligned") return "not_as_expected";
  return "too_early";
}

function confidenceWord(expectation: BrainExpectation | null): ClientBrainChangeConfidence {
  const word = String(expectation?.confidence ?? "");
  return word === "strong" || word === "observed" ? word : "tentative";
}

// ---------- Undo, labelled by the server ----------

function restoreLabel(decision: BrainDecision, what: Touched): string {
  if (what.recoveryCycle) return "Return to your regular week";
  // The athlete's own push / steady statement (src/domain/training/training-drive.ts).
  if ((decision.context as Record<string, unknown> | null)?.training_drive_stance === true)
    return "Go back to your previous drive";
  if ((decision.context as Record<string, unknown> | null)?.stated_kind === "run_week")
    return "Go back to your previous run week";
  switch (decision.kind) {
    case "training_target":
      return what.exercises.length === 1 ? `Restore previous ${what.exercises[0]} target` : "Restore previous targets";
    case "exercise_rotation":
      return what.swaps.length === 1 ? `Bring back ${what.swaps[0].from}` : "Restore previous exercises";
    case "training_structure":
      return "Restore your previous week";
    case "nutrition_target":
      return "Restore previous calorie target";
    case "goal_change":
      return "Restore previous goal date";
    case "recovery_adjustment":
      return "Return to your regular week";
    default:
      return "Undo this change";
  }
}

function holdLabel(decision: BrainDecision, what: Touched): string {
  switch (decision.kind) {
    case "training_target":
      return what.exercises.length === 1
        ? `Keep your current ${what.exercises[0]} target`
        : "Keep your current targets";
    case "exercise_rotation":
      return what.swaps.length === 1 ? `Keep ${what.swaps[0].from}` : "Keep your current exercises";
    case "training_structure":
    case "recovery_adjustment":
      return "Keep your week as it is";
    case "nutrition_target":
      return "Keep your current calorie target";
    case "goal_change":
      return "Keep your current goal date";
    default:
      return "Don't make this change";
  }
}

// Mirrors what revertDecision will accept: an announced change is held (canceled), an
// applied one is restored only while it is reversible AND its snapshot exists.
function undoFor(decision: BrainDecision, state: ClientBrainChangeState, what: Touched) {
  if (state === "announced") return { available: true, label: holdLabel(decision, what) };
  if (state === "applied" && decision.status === "applied" && decision.reversible && decision.id) {
    let rollback: unknown = null;
    try {
      rollback = getBrainRollback(decision.id);
    } catch {
      rollback = null;
    }
    if (rollback) return { available: true, label: restoreLabel(decision, what) };
  }
  return { available: false, label: null };
}

// ---------- day words ----------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekday(day: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(ms) ? WEEKDAYS[new Date(ms).getUTCDay()] : day;
}

function monthDay(day: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function dayWord(day: string, asOf: string): string {
  if (day === asOf) return "today";
  if (day === addDaysISO(asOf, -1)) return "yesterday";
  if (day === addDaysISO(asOf, 1)) return "tomorrow";
  const nearPast = (addDaysISO(asOf, -6) ?? asOf) <= day && day < asOf;
  const nearFuture = asOf < day && day <= (addDaysISO(asOf, 6) ?? asOf);
  return nearPast || nearFuture ? weekday(day) : monthDay(day);
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function statusLine(state: ClientBrainChangeState, day: string, landsOn: string | null, asOf: string): string {
  if (state === "announced") return landsOn ? `Lands ${dayWord(landsOn, asOf)}` : "Lands soon";
  if (state === "reverted") return "Put back";
  if (state === "held") return "Held before it landed";
  return `Landed ${dayWord(day, asOf)}`;
}

// ---------- drafts set aside ----------
//
// A held draft the team SET ASIDE (a superseded `thaw_receipt` row, autonomy-service.ts)
// changed nothing, so it is not a row of the feed. It still never silently disappears:
// it is one quiet line under the changes, worded HERE from what the draft touched and
// the machine reason the receipt carries — never the draft's own agent summary (clipped
// engineering prose), an ISO date or a threshold.

const MAX_SET_ASIDE = 5;

// Why it was set aside, by the receipt's machine outcome. Plain words, no dates.
const SET_ASIDE_REASON: Record<string, string> = {
  superseded_by_newer_review: "a newer review replaced it.",
  closed_source_superseded: "a newer one took its place.",
  superseded_premise_gone: "what it was about is no longer in your plan.",
  superseded_pain_settled: "the pain it was protecting has settled.",
  superseded_week_passed: "the week it was written for has passed.",
  superseded_stale_proposal: "it waited too long to still fit.",
  superseded_stale_evidence: "your picture moved after it was written.",
  superseded_stale_plan: "it sat too long to still fit your week.",
  refused_by_plan: "it no longer fit your plan as it stands.",
};
const SET_ASIDE_REASON_BY_CODE: Record<string, string> = {
  source_superseded: SET_ASIDE_REASON.superseded_by_newer_review,
  premise_gone: SET_ASIDE_REASON.superseded_premise_gone,
  stale_proposal: SET_ASIDE_REASON.superseded_stale_proposal,
  stale_snapshot: SET_ASIDE_REASON.superseded_stale_evidence,
  stale_plan: SET_ASIDE_REASON.superseded_stale_plan,
  apply_refused: SET_ASIDE_REASON.refused_by_plan,
};
const SET_ASIDE_FALLBACK_REASON = "it no longer fit where you are.";

function setAsideSubject(decision: BrainDecision, draft: Draft | null): string | null {
  const action = (decision.action ?? {}) as Record<string, any>;
  if (decision.source_ref_type === "meal_plan" || Number(action.meal_plan_id) > 0) return "a week of meals";
  const parsed = draft?.parsed ?? null;
  if (parsed?.kind === "nutrition_target") return "your calorie target";
  if (parsed && Array.isArray(parsed.changes)) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const change of parsed.changes) {
      const name = String(change?.exercise ?? change?.swap?.from ?? "").trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
    }
    if (names.length === 1 || names.length === 2) return joinList(names);
    if (names.length > 2) return `${countWord(names.length)} lifts`;
  }
  if (parsed && Array.isArray(parsed.days)) return "your plan";
  return null;
}

function setAsideLine(decision: BrainDecision): string {
  const action = (decision.action ?? {}) as Record<string, any>;
  const context = (decision.context ?? {}) as Record<string, unknown>;
  const reason =
    SET_ASIDE_REASON[String(action.outcome ?? "")] ??
    SET_ASIDE_REASON_BY_CODE[String(context.review_reason_code ?? "")] ??
    SET_ASIDE_FALLBACK_REASON;
  const subject = setAsideSubject(decision, draftOf(decision));
  return subject
    ? `An older draft for ${subject} was set aside: ${reason}`
    : `An older draft was set aside: ${reason}`;
}

function setAsideRead(decisions: BrainDecision[], floor: string, asOf: string): ClientBrainSetAside[] {
  const out: Array<ClientBrainSetAside & { at: string }> = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    try {
      const context = (decision.context ?? {}) as Record<string, unknown>;
      if (decision.status !== "superseded" || context.thaw_receipt !== true || decision.id == null) continue;
      const day = localDayOfStamp(decision.created_at);
      if (!day || day < floor || day > asOf) continue;
      // One line per draft: a later sweep that files a second receipt for it says nothing new.
      const source = `${decision.source_ref_type ?? ""}:${decision.source_ref_key ?? decision.id}`;
      if (seen.has(source)) continue;
      seen.add(source);
      out.push({
        id: decision.id,
        day,
        label: dayGroupLabel(day, asOf),
        line: setAsideLine(decision),
        at: stamp(decision.created_at) ?? "",
      });
    } catch {
      // Per-row isolation, as for the changes.
    }
  }
  out.sort((a, b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at) || b.id - a.id);
  return out.slice(0, MAX_SET_ASIDE).map(({ at: _at, ...row }) => row);
}

// ---------- the read ----------

function seenMarker(): string | null {
  const raw = getAppState(BRAIN_CHANGES_SEEN_KEY);
  return raw ? stamp(raw) : null;
}

function projectDecision(decision: BrainDecision, read: ReadContext, floor: string, seenFrom: number): Row | null {
  const { asOf } = read;
  if ((!isTeamChange(decision) && !isStatedChange(decision)) || decision.id == null) return null;
  const state = changeState(decision);
  if (!state) return null;
  const decidedDay = localDayOfStamp(decision.created_at) ?? "";
  const landedDay =
    String(decision.effective_date ?? "").slice(0, 10) || localDayOfStamp(decision.applied_at) || decidedDay;
  const day = state === "announced" || state === "held" ? decidedDay : landedDay;
  if (!day) return null;
  // Announced changes are forward-looking, so they stay until they land or are held.
  if (state !== "announced" && day < floor) return null;
  const eventAt =
    state === "applied" ? stamp(decision.applied_at) : state === "announced" ? stamp(decision.created_at) : null;
  // ONE piece of news per decision, at its first surfacing: an announced change is news
  // when it is announced, and landing later is the same decision, not a second one. A
  // quiet change is never shown while pending, so it first surfaces when it lands.
  const surfacedAt =
    state === "announced" || (state === "applied" && decision.autonomy_tier === "announce")
      ? stamp(decision.created_at)
      : state === "applied"
        ? stamp(decision.applied_at)
        : null;
  const surfacedMs = surfacedAt ? Date.parse(surfacedAt) : Number.NaN;
  const draft = draftOf(decision);
  const what = touched(decision, draft, read);
  const voice: RowVoice = { day, asOf };
  const { expectation, evaluation } = latestOutcome(decision);
  const key = outcomeKey(state, evaluation);
  const landsOn = state === "announced" ? String(decision.effective_date ?? "").slice(0, 10) || null : null;
  const said = statedWords(decision);
  const why = changeWhy(decision, draft, what, voice);
  return {
    id: decision.id,
    day,
    state,
    domain: String(decision.domain),
    title: changeTitle(decision, what, draft, voice),
    // "You said X → the brain changed Y": the quote leads the why, the change follows.
    why: said ? capStatedWhy(said, why) : why,
    ...(said ? { said } : {}),
    status_line: statusLine(state, day, landsOn, asOf),
    lands_on: landsOn,
    outcome: { key, phrase: BRAIN_CHANGE_OUTCOME_PHRASES[key] },
    confidence: confidenceWord(expectation),
    undo: undoFor(decision, state, what),
    new: Number.isFinite(surfacedMs) && surfacedMs > seenFrom && !athleteAsked(decision),
    event_at: eventAt,
  };
}

function dayGroupLabel(day: string, asOf: string): string {
  return capitalize(dayWord(day, asOf));
}

function sinceSeenLine(count: number, rows: Row[], asOf: string, now: Date): string | null {
  if (count <= 0) return null;
  const noun = count === 1 ? "change" : "changes";
  const yesterday = addDaysISO(asOf, -1) ?? asOf;
  const overnight =
    localHourFraction(now) < 12 &&
    rows.filter((row) => row.new).every((row) => row.day === asOf || row.day === yesterday);
  return overnight ? `${count} ${noun} overnight` : `${count} ${noun} since you last looked`;
}

export function brainChangesRead(
  opts: { days?: number; limit?: number; asOf?: string; now?: Date } = {}
): ClientBrainChanges {
  const now = opts.now ?? new Date();
  const asOf = opts.asOf ?? localDateISO(now);
  const windowDays = Math.max(1, Math.min(90, Math.trunc(Number(opts.days) || DEFAULT_WINDOW_DAYS)));
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(opts.limit) || DEFAULT_LIMIT)));
  const floor = addDaysISO(asOf, -windowDays) ?? asOf;
  const seenAt = seenMarker();
  const seenFrom = seenAt ? Date.parse(seenAt) : now.getTime() - UNSEEN_LOOKBACK_MS;
  const candidates = [
    ...listBrainDecisions({ status: "announced", limit: 100 }),
    ...listBrainDecisions({ status: "applied", limit: 200 }),
    ...listBrainDecisions({ status: "reverted", limit: 100 }),
    ...listBrainDecisions({ status: "canceled", limit: 100 }),
    ...listBrainDecisions({ status: "superseded", limit: 100 }),
  ];
  let livePlan: Map<string, PlanPrescription> | null = null;
  const read: ReadContext = { asOf, livePlan: () => (livePlan ??= planPrescriptionSnapshot()) };
  const rows: Row[] = [];
  for (const decision of candidates) {
    try {
      const row = projectDecision(decision, read, floor, seenFrom);
      if (row) rows.push(row);
    } catch {
      // Per-row isolation: one unreadable decision thins the feed, never breaks it.
    }
  }
  rows.sort(
    (a, b) =>
      b.day.localeCompare(a.day) || String(b.event_at ?? "").localeCompare(String(a.event_at ?? "")) || b.id - a.id
  );
  const shown = rows.slice(0, limit);
  const groups: ClientBrainChangeDay[] = [];
  for (const { event_at: _eventAt, ...change } of shown) {
    const last = groups[groups.length - 1];
    if (last && last.day === change.day) last.changes.push(change);
    else groups.push({ day: change.day, label: dayGroupLabel(change.day, asOf), changes: [change] });
  }
  // Counted over the rows actually returned, so the Today line always equals the
  // number of new rows the feed shows.
  const sinceSeen = shown.filter((row) => row.new).length;
  return {
    as_of: asOf,
    days: groups,
    since_seen: sinceSeen,
    since_seen_line: sinceSeenLine(sinceSeen, shown, asOf, now),
    seen_at: seenAt,
    seen_through: now.toISOString(),
    set_aside: setAsideRead(candidates, floor, asOf),
  };
}

// The athlete opened the feed. `through` is the instant the feed they looked at was read
// (`seen_through`), so a change that lands between the read and this call stays new. The
// marker never moves backwards and never ahead of now.
export function markBrainChangesSeen(opts: { through?: unknown; now?: Date } = {}): ClientBrainChangesSeenResponse {
  const now = opts.now ?? new Date();
  const requested = opts.through == null || opts.through === "" ? null : parseDbTime(opts.through);
  const through = requested && requested.getTime() < now.getTime() ? requested : now;
  const current = seenMarker();
  const next = current && Date.parse(current) > through.getTime() ? current : through.toISOString();
  setAppState(BRAIN_CHANGES_SEEN_KEY, next);
  return { ok: true, seen_at: next };
}
