// A plan day's focus, read for the DATE it lands on.
//
// `plan_days.focus` is written once, by whoever drew the plan, against the week layout
// they had in mind — "Upper body only on the threshold-run day", "two clear days from
// Thursday's threshold run and Sunday's long run", "the day after deadlifts". But the
// week is dealt off the log (plan-selection's weekday ring), so the day that sentence
// was written for can land on any lifting weekday, and a stored calendar claim then
// tells the athlete something about their week that is no longer true (2026-10-19:
// the leg day read "Nothing on the legs before Thursday" on a Friday).
//
// So every surface that prints a focus FOR A DATE reads it through here: sentences and
// clauses that make a claim about the calendar are dropped at read time, and — only
// when something was dropped — one short phrase derived from the real calendar for that
// date takes their place ("Day after the threshold run."). The stored row is never
// rewritten; a focus with no calendar claim comes back exactly as stored.
import { pickDayVariant } from "./brain/day-read-rules.js";
import { type EnduranceSchedule, getEnduranceSchedule } from "./profile.js";
import { addDaysISO } from "./shared.js";

// A calendar claim: a weekday name, a relative day ("the day after …", "tomorrow"),
// a run-day role ("on the threshold-run day", "the shakeout day"), or a spacing claim
// ("two clear days from …", "before the long run"). The movement content of a focus
// ("squat-led", "upper back and arms") never matches.
const CALENDAR_CLAIMS: readonly RegExp[] = [
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)s?\b/i,
  /\b(?:the\s+)?(?:day|night|morning|evening)\s+(?:after|before)\b/i,
  /\b(?:the\s+)?(?:next|previous|following)\s+day\b/i,
  /\b(?:tomorrow|yesterday|tonight)\b/i,
  /\bclear\s+days?\b/i,
  /\b(?:\w+|\d+)\s+(?:full\s+)?days?\s+(?:from|after|before|out\s+from|away\s+from|clear\s+of)\b/i,
  /\b\d+\s*(?:h|hrs?|hours)\s+(?:from|after|before)\b/i,
  /\bon\s+(?:the|a|an|its|this)\s+(?:[\w’'-]+\s+){0,2}day\b/i,
  /\b(?:(?:threshold|tempo|quality|long|easy|interval|hill)[- ]run|shakeout|race|run)[- ]day\b/i,
  /\b(?:before|after|ahead\s+of|following|between)\s+(?:the\s+|a\s+|an\s+|its\s+)?(?:[\w-]+\s+)?(?:runs?|threshold|tempo|race|intervals?|quality)\b/i,
];

export function hasCalendarClaim(text: string): boolean {
  return CALENDAR_CLAIMS.some((re) => re.test(text));
}

const CLAUSE_SEPARATOR = /(\s*[,;:]\s+|\s+[—–-]\s+)/;
const TRAILING_JOINER = /\s+(?:and|but|so|or|with|while)$/i;
const LEADING_JOINER = /^(?:and|but|so|or|with|while)\s+/i;

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** One sentence with its calendar-claiming clauses dropped, or "" when nothing is left. */
function stripSentence(sentence: string): string {
  // A parenthetical that names the calendar goes first, whole: "(Thursday's threshold)".
  let body = sentence.replace(/\s*\(([^()]*)\)/g, (match, inner: string) => (hasCalendarClaim(inner) ? "" : match));
  if (!hasCalendarClaim(body)) return body.trim();
  const end = /[.!?]+$/.exec(body)?.[0] ?? ".";
  body = body.replace(/[.!?]+$/, "");
  const parts = body.split(CLAUSE_SEPARATOR);
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i].trim();
    if (!clause || hasCalendarClaim(clause)) continue;
    out = out ? `${out}${parts[i - 1] ?? ", "}${clause}` : clause;
  }
  out = out.replace(TRAILING_JOINER, "").replace(LEADING_JOINER, "").trim();
  return out ? `${capitalize(out)}${end}` : "";
}

/** `text` with every calendar claim dropped; `stripped` says whether anything went. */
export function stripCalendarClaims(text: string): { text: string; stripped: boolean } {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean || !hasCalendarClaim(clean)) return { text: clean, stripped: false };
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const kept = sentences.map(stripSentence).filter(Boolean);
  return { text: kept.join(" ").trim(), stripped: true };
}

// ---- the real calendar, said in a few words ----

type KeyRunKind = "quality" | "long" | "easy";

/** The stated run kinds around a date: the day itself, the day before, the day after. */
export interface FocusCalendar {
  today: KeyRunKind | null;
  yesterday: KeyRunKind | null;
  tomorrow: KeyRunKind | null;
  /** The stated quality session's noun ("threshold run"), when one is stated. */
  quality_noun: string | null;
}

const QUALITY_NOUN: Record<string, string> = {
  threshold: "threshold run",
  tempo: "tempo run",
  vo2: "VO2 session",
  hills: "hill session",
};

function dowOf(date: string): number {
  return new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getUTCDay();
}

function statedKind(schedule: EnduranceSchedule | null, date: string | null): KeyRunKind | null {
  if (!schedule || !date) return null;
  const dow = dowOf(date);
  const kinds = schedule.days.filter((d) => d.dow === dow).map((d) => d.kind);
  if (kinds.includes("quality")) return "quality";
  if (kinds.includes("long")) return "long";
  return kinds.length ? "easy" : null;
}

/** The stated run calendar around `date` — the athlete's own run days, never a guess. */
export function focusCalendarOn(date: string): FocusCalendar {
  let schedule: EnduranceSchedule | null = null;
  try {
    schedule = getEnduranceSchedule();
  } catch {
    schedule = null;
  }
  const d = String(date).slice(0, 10);
  return {
    today: statedKind(schedule, d),
    yesterday: statedKind(schedule, addDaysISO(d, -1)),
    tomorrow: statedKind(schedule, addDaysISO(d, 1)),
    quality_noun: QUALITY_NOUN[String(schedule?.quality?.type ?? "")] ?? null,
  };
}

// Date-neutral on purpose: a week strip prints Friday's cell on Monday, so "today"
// would be the wrong word for every cell but one.
const SAME_DAY: readonly ((run: string) => string)[] = [
  (run) => `${capitalize(run)} the same day.`,
  (run) => `Shares the day with the ${run}.`,
];
const DAY_AFTER: readonly ((run: string) => string)[] = [
  (run) => `Day after the ${run}.`,
  (run) => `The ${run} is the day before.`,
];
const DAY_BEFORE: readonly ((run: string) => string)[] = [
  (run) => `Day before the ${run}.`,
  (run) => `The ${run} is the next day.`,
];

function runNoun(kind: KeyRunKind, calendar: FocusCalendar): string {
  if (kind === "long") return "long run";
  if (kind === "quality") return calendar.quality_noun ?? "quality run";
  return "easy run";
}

const isKey = (kind: KeyRunKind | null): kind is "quality" | "long" => kind === "quality" || kind === "long";

/** The one calendar phrase for `date`, or null when its neighbourhood holds no stated run worth saying. */
export function calendarFocusPhrase(date: string, calendar: FocusCalendar = focusCalendarOn(date)): string | null {
  if (isKey(calendar.today)) {
    return pickDayVariant(SAME_DAY, date, "plan-day-focus:same")(runNoun(calendar.today, calendar));
  }
  if (isKey(calendar.yesterday)) {
    return pickDayVariant(DAY_AFTER, date, "plan-day-focus:after")(runNoun(calendar.yesterday, calendar));
  }
  if (isKey(calendar.tomorrow)) {
    return pickDayVariant(DAY_BEFORE, date, "plan-day-focus:before")(runNoun(calendar.tomorrow, calendar));
  }
  if (calendar.today === "easy") {
    return pickDayVariant(SAME_DAY, date, "plan-day-focus:same")(runNoun("easy", calendar));
  }
  return null;
}

/**
 * A plan day's stored focus as it reads on `date`: calendar claims dropped, and — only
 * when one was — the real calendar's phrase in their place. A focus that makes no
 * calendar claim comes back exactly as stored; null in, null out; null when nothing is
 * left to say.
 */
export function datedPlanDayFocus(
  focus: string | null | undefined,
  date: string | null | undefined,
  opts: { calendar?: FocusCalendar } = {}
): string | null {
  if (focus == null) return null;
  const raw = String(focus);
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(String(date))) return raw;
  const { text, stripped } = stripCalendarClaims(raw);
  if (!stripped) return raw;
  const d = String(date).slice(0, 10);
  const phrase = calendarFocusPhrase(d, opts.calendar ?? focusCalendarOn(d));
  const out = [text, phrase].filter(Boolean).join(" ").trim();
  return out || null;
}

// ---- the race build's leg trim, said on the focus ----
//
// A plan day's stored focus ("Squat-led lower body") is written for the day at full
// dose. In the race build's last two weeks, and on the eve of a placed key run, the
// stress budget trims that day's legs (stress-budget.ts: taper week's lighter legs,
// race week's heavy legs sitting out, the eve's fewer leg sets). A focus that still
// reads as the full day tells the athlete the card is something it is not, so every
// surface that prints a trimmed day's focus says the trim beside it. The trim is READ —
// the stress budget's own code for the day, carried in by the caller — never re-derived
// here; this module only words it, rotated by date.

// `post_race_recovery` is the whole card, not only the legs: the days after a race
// (race-recovery.ts) every lift goes lighter. It rides the same reader and wording path.
export type LegTrim = "race_taper_legs" | "race_week_legs" | "key_run_eve" | "post_race_recovery";

const LEG_TRIM_PHRASES: Record<LegTrim, readonly string[]> = {
  race_taper_legs: ["Lighter on the legs — taper week.", "Taper week: the legs go lighter.", "Legs kept light for the taper."],
  race_week_legs: [
    "Race week: the heavy leg work sits out.",
    "Heavy legs sit out — race week.",
    "Race week, so the big leg lifts rest.",
  ],
  key_run_eve: [
    "Fewer leg sets — a key run is close.",
    "Leg sets trimmed so the key run gets fresh legs.",
    "A little lighter on the legs ahead of the key run.",
  ],
  post_race_recovery: [
    "Lighter — recovering from the race.",
    "Lighter today, recovering from the race.",
    "A lighter session while you recover from the race.",
  ],
};

// Short forms beside a day's NAME ("Lower, lighter — taper week."), for a row or a
// strip cell that says why the day differs from its usual dose.
const LEG_TRIM_NOTES: Record<LegTrim, readonly ((name: string) => string)[]> = {
  race_taper_legs: [(n) => `${n}, lighter — taper week.`, (n) => `${n} stays on, lighter for the taper.`],
  race_week_legs: [(n) => `${n}, heavy legs sit out — race week.`, (n) => `${n} without the heavy leg work — race week.`],
  key_run_eve: [(n) => `${n}, fewer leg sets — key run next.`, (n) => `${n}, a little lighter ahead of the key run.`],
  post_race_recovery: [
    (n) => `${n}, lighter — recovering from the race.`,
    (n) => `${n} stays on, lighter after the race.`,
  ],
};

// The trim as a trailing CLAUSE, for a line whose subject is already another fact about
// the day — "Lower lands here this week, lighter for the taper." — so a moved or swapped
// day that is also trimmed says both in one sentence instead of losing the trim.
const LEG_TRIM_CLAUSES: Record<LegTrim, readonly string[]> = {
  race_taper_legs: ["lighter for the taper", "with lighter legs for the taper"],
  race_week_legs: ["without the heavy leg work for race week", "with the heavy legs sitting out for race week"],
  key_run_eve: ["with fewer leg sets ahead of the key run", "a little lighter ahead of the key run"],
  post_race_recovery: ["lighter while you recover from the race", "a little lighter after the race"],
};

// The focus already says it: an agent-written or stored sentence that names the taper,
// race week or lighter legs does not get a second clause saying the same.
const ALREADY_TRIMMED = /\b(?:taper|race[- ]week|lighter|light legs|legs? (?:light|fresh)|sits? out|trimmed|fewer leg sets)\b/i;

export function isLegTrim(value: unknown): value is LegTrim {
  return (
    value === "race_taper_legs" ||
    value === "race_week_legs" ||
    value === "key_run_eve" ||
    value === "post_race_recovery"
  );
}

/** The trim in one sentence for `date` (rotated), or null for no trim. */
export function legTrimPhrase(trim: unknown, date: string): string | null {
  if (!isLegTrim(trim)) return null;
  return pickDayVariant(LEG_TRIM_PHRASES[trim], String(date).slice(0, 10), `plan-day-focus:trim:${trim}`);
}

/** "Lower, lighter — taper week." — the day's NAME with its trim, for a row's note. Null with no trim or name. */
export function legTrimNote(name: string | null | undefined, trim: unknown, date: string): string | null {
  const n = String(name ?? "").replace(/[.\s]+$/, "").trim();
  if (!n || !isLegTrim(trim)) return null;
  return pickDayVariant(LEG_TRIM_NOTES[trim], String(date).slice(0, 10), `plan-day-focus:trim-note:${trim}`)(n);
}

/** "lighter for the taper" — the trim as a clause to close another sentence about the day (rotated). Null for no trim. */
export function legTrimClause(trim: unknown, date: string): string | null {
  if (!isLegTrim(trim)) return null;
  return pickDayVariant(LEG_TRIM_CLAUSES[trim], String(date).slice(0, 10), `plan-day-focus:trim-clause:${trim}`);
}

/** `sentence` closed with the trim's clause: "Push B today, since you've already run, lighter for the taper." */
export function withLegTrimClause(sentence: string, trim: unknown, date: string): string {
  const clause = legTrimClause(trim, date);
  const body = String(sentence ?? "").trim();
  if (!clause || !body) return body;
  return `${body.replace(/[.!?]+$/, "")}, ${clause}.`;
}

/**
 * A (dated) focus with the day's leg trim said beside it: the focus as given, then the
 * trim's one sentence — unless the focus already says it. No trim: the focus exactly as
 * given. A day with no focus of its own takes the trim sentence alone.
 */
export function legTrimFocus(focus: string | null | undefined, trim: unknown, date: string): string | null {
  const base = focus == null ? "" : String(focus).replace(/\s+/g, " ").trim();
  const phrase = legTrimPhrase(trim, date);
  if (!phrase) return focus ?? null;
  // Idempotent: a focus that already carries the trim (a week cell's, read again by the
  // day page) never takes the sentence twice.
  if (base && (base.includes(phrase) || ALREADY_TRIMMED.test(base))) return base;
  if (!base) return phrase;
  return `${/[.!?]$/.test(base) ? base : `${base}.`} ${phrase}`;
}
