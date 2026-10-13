// READING A PERSON'S RUNNING WORDS, deterministically — no agent, and bounded on purpose.
//
// Two questions about a short piece of free text:
//
//   - `namedWeekdays`: which weekdays did they NAME, and which did they rule out? A
//     weekday counts only as a whole word. The abbreviations that are also ordinary words
//     ("sat", "sun", "wed", "mon") count only where they plainly mean a day: inside a list
//     or range of days ("Tue, Thu and Sun", "Sat/Sun", "Mon-Fri"), or capitalised after a
//     word that introduces a day ("on Sun"). So "I sat out most of last month" names no
//     Saturday and "in the sun on weekends" is the weekend, never a Sunday. A day said
//     with a negation in the same clause ("not Mondays", "I don't run on Mondays",
//     "Monday is rest") is RULED OUT, and a ruled-out day never lands even when it is
//     also inside a range ("Mon-Fri except Wednesday").
//   - `runningMentions`: is running, or a race, something they actually said they do or
//     want? "Run" alone is not running: "run a tight ship", "run errands", "in the long
//     run" and "running late" are other things. And a mention under a negation ("I don't
//     run", "no races planned") is not intent.
//
// When the words do not plainly say it, these read nothing: the callers store nothing
// and say so calmly. Never a guess at what someone meant.

export interface WeekdayMention {
  dow: number;
  /** The clause the day was named in (comma / semicolon / "then" bounded), for its run kind. */
  clause: string;
}

export interface NamedWeekdays {
  /** Days named and not ruled out, in the order first named. */
  days: WeekdayMention[];
  /** Days the words ruled out ("not Mondays", "Monday is rest"). */
  excluded: number[];
}

const FULL_DAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
// Abbreviations that are not ordinary English words.
const SAFE_ABBR: Record<string, number> = { tue: 2, tues: 2, thu: 4, thur: 4, thurs: 4, fri: 5 };
// Abbreviations that ARE ordinary words (sat, sun, wed, mon) — a day only in a day context.
const AMBIGUOUS_ABBR: Record<string, number> = { sun: 0, mon: 1, wed: 3, weds: 3, sat: 6 };
// Words that introduce a single capitalised abbreviation as a day ("long run on Sun").
const DAY_INTRO = new Set(["on", "every", "each", "most", "some", "this", "next", "before", "after", "usually"]);
// Words that make "weekdays"/"workdays" mean all five ("on weekdays", "every workday").
const ALL_WEEKDAYS_INTRO = new Set(["on", "every", "all"]);

type DayToken = {
  start: number;
  end: number;
  dows: number[];
  /** "full" names and safe abbreviations stand alone; "ambiguous" ones need a day context. */
  strength: "full" | "ambiguous";
  /** A single day (can be a range endpoint); weekend/weekdays are lists only. */
  single: boolean;
  capitalised: boolean;
  prevWord: string;
};

const WORD = /[a-z]+(?:['’][a-z]+)*/gi;

function dayToken(word: string, start: number, prevWord: string): DayToken | null {
  const lower = word.toLowerCase().replace(/['’]s$/, "");
  const bare = lower.endsWith("s") && FULL_DAYS[lower.slice(0, -1)] != null ? lower.slice(0, -1) : lower;
  const capitalised = /^[A-Z]/.test(word);
  const base = { start, end: start + word.length, capitalised, prevWord };
  if (FULL_DAYS[bare] != null) return { ...base, dows: [FULL_DAYS[bare]], strength: "full", single: true };
  if (SAFE_ABBR[lower] != null) return { ...base, dows: [SAFE_ABBR[lower]], strength: "full", single: true };
  if (AMBIGUOUS_ABBR[lower] != null)
    return { ...base, dows: [AMBIGUOUS_ABBR[lower]], strength: "ambiguous", single: true };
  if (lower === "weekend" || lower === "weekends") return { ...base, dows: [6, 0], strength: "full", single: false };
  if (
    (lower === "weekdays" || lower === "workdays" || lower === "weekday" || lower === "workday") &&
    ALL_WEEKDAYS_INTRO.has(prevWord)
  )
    return { ...base, dows: [1, 2, 3, 4, 5], strength: "full", single: false };
  return null;
}

// Between two day words: a list ("Tue, Thu and Sun", "Sat/Sun") or a range ("Mon-Fri",
// "Monday to Friday"). An em dash is a pause, never a range ("Not Mondays — Tue").
function joinBetween(gap: string): "list" | "range" | null {
  if (/^\s*(?:-|–|to|through|thru|till|until)\s*$/i.test(gap)) return "range";
  const rest = gap.replace(/\b(?:and|or|plus|n)\b/gi, "").replace(/[\s,/&+]/g, "");
  return rest === "" ? "list" : null;
}

// Clause boundaries for negation and run kind. A comma closes a clause, so "I don't run
// on Mondays, but Tue/Thu" keeps the negation on Monday.
const CLAUSE_BREAK = /[,;.!?\n:()]|—|\s[-–]\s|\bbut\b|\bthen\b|\bhowever\b/gi;

function clauseSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    const at = m.index ?? 0;
    spans.push([from, at]);
    from = at + m[0].length;
  }
  spans.push([from, text.length]);
  return spans;
}

const NEG_BEFORE =
  /\b(?:not|no|never|nothing|don['’]?t|do\s+not|doesn['’]?t|didn['’]?t|won['’]?t|can['’]?t|cannot|except|excluding|besides|other\s+than|apart\s+from|skip|skipping|avoid|avoiding|without)\b/i;
const NEG_AFTER = /^\W*(?:(?:is|are|=)\s+(?:my\s+|a\s+|for\s+)?)?(?:off|rest(?:ing)?)(?![\w-])/i;

export function namedWeekdays(text: unknown): NamedWeekdays {
  const words = typeof text === "string" ? text.slice(0, 600) : "";
  const tokens: Array<{ word: string; start: number }> = [];
  for (const m of words.matchAll(WORD)) tokens.push({ word: m[0], start: m.index ?? 0 });
  const days: DayToken[] = [];
  for (const [i, t] of tokens.entries()) {
    const found = dayToken(t.word, t.start, (tokens[i - 1]?.word ?? "").toLowerCase());
    if (found) days.push(found);
  }
  if (!days.length) return { days: [], excluded: [] };

  // Chain day words that are joined as a list or a range; a chain of two or more, or
  // one with a full day name in it, makes every day word in it a day.
  const joins: Array<"list" | "range" | null> = days.map((d, i) =>
    i === 0 ? null : joinBetween(words.slice(days[i - 1].end, d.start))
  );
  const accepted = new Array<boolean>(days.length).fill(false);
  let chainStart = 0;
  for (let i = 0; i <= days.length; i++) {
    if (i < days.length && i > 0 && joins[i]) continue;
    const chain = days.slice(chainStart, i);
    const ok = chain.length >= 2 || chain.some((d) => d.strength === "full");
    for (let k = chainStart; k < i; k++) {
      const d = days[k];
      const alone = d.strength === "ambiguous" && d.capitalised && DAY_INTRO.has(d.prevWord) && chain.length === 1;
      accepted[k] = ok || alone;
    }
    chainStart = i;
  }

  const spans = clauseSpans(words);
  const clauseOf = (at: number) => spans.find(([a, b]) => at >= a && at <= b) ?? [0, words.length];
  const negated = (d: DayToken) => {
    const [a, b] = clauseOf(d.start);
    return NEG_BEFORE.test(words.slice(a, d.start)) || NEG_AFTER.test(words.slice(d.end, b));
  };

  const named: WeekdayMention[] = [];
  const excluded = new Set<number>();
  const add = (dow: number, d: DayToken, out: boolean) => {
    if (out) excluded.add(dow);
    else {
      const [a, b] = clauseOf(d.start);
      named.push({ dow, clause: words.slice(a, b) });
    }
  };
  for (const [i, d] of days.entries()) {
    if (!accepted[i]) continue;
    const out = negated(d);
    const prev = days[i - 1];
    if (joins[i] === "range" && prev && prev.single && d.single && accepted[i - 1]) {
      // The range's inner days, forward through the week ("Fri-Mon" wraps). The ends
      // are added on their own.
      const out2 = out || negated(prev);
      for (let dow = (prev.dows[0] + 1) % 7; dow !== d.dows[0]; dow = (dow + 1) % 7) add(dow, d, out2);
    }
    for (const dow of d.dows) add(dow, d, out);
  }
  const seen = new Set<number>();
  const days_ = named.filter((m) => {
    if (excluded.has(m.dow) || seen.has(m.dow)) return false;
    seen.add(m.dow);
    return true;
  });
  return { days: days_, excluded: [...excluded].sort((a, b) => a - b) };
}

// ---------- running and race intent ----------

export interface RunningMention {
  /** "race": a race or an event distance; "activity": running as something they do. */
  kind: "race" | "activity";
  text: string;
  negated: boolean;
}

const RACE_PATTERN =
  /\b(?:half[\s-]*marathons?|marathons?|ultra[\s-]*marathons?|ultras|parkruns?|races?|racing|\d+(?:\.\d+)?\s?k\b(?:[\s-]*ready)?|\d+(?:\.\d+)?\s?(?:km|mi|miles?)\s+races?)/gi;
const RACE_NOT =
  /^\s*(?:steps|a\s+day|daily|followers|a\s+(?:year|month)|salary|thoughts|heart|mind|pulse|cars?|bikes?|condition)\b/i;
const ACTIVITY_PATTERN = /\b(?:running|runner|runners|jog|jogs|jogging|jogged|jogger|trail[\s-]?runs?)\b/gi;
const RUNNING_NOT =
  /^\s+(?:late|out|low|short|behind|errands|around\s+after|(?:a|an|my|our|the|his|her|their)\s+(?:own\s+)?(?:business|company|team|shop|store|firm|household|show|meeting|project|tight|numbers|risk|program|campaign))\b/i;
const RUN_VERB = /\b(?:run|runs|ran)\b/gi;
// "a run", "my long run", "an easy run": the noun.
const RUN_NOUN_BEFORE =
  /(?:\b(?:a|an|my|long|easy|short|tempo|morning|evening|lunch|trail|weekend|recovery|quality|first|weekly|daily|slow|steady|interval|hill|fun|group|club)|\d\s?(?:k|km|mi|miles?))\s+$/i;
// What follows "run" when it is running: a count, a distance, a day, a frequency.
const RUN_VERB_AFTER = new RegExp(
  "^\\s*(?:(?:about|around|roughly|maybe|usually|normally|also|still|currently|now|mostly|just)\\s+)?(?:" +
    [
      "\\d",
      "(?:one|two|three|four|five|six|seven|once|twice)\\b",
      "a\\s+(?:bit|little|lot|few|couple|5k|10k|half|marathon|race|mile|km|parkrun)\\b",
      "an?\\s+\\d",
      "(?:some|regularly|daily|often|every|occasionally|sometimes|too|also|easy|slow|fast|outside|outdoors|again)\\b",
      "as\\s+well\\b",
      "on\\s+(?:the\\s+)?(?:treadmill|track|trails?|road|weekends?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\\b",
      "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b",
      "weekends?\\b",
      "in\\s+the\\s+(?:morning|evening|park)\\b",
      "and\\s+(?:lift|bike|swim|cycle|ride|train)",
      "$",
      "[.,;!?)]",
    ].join("|") +
    ")",
  "i"
);
const INTENT_NEG =
  /\b(?:don['’]?t|do\s+not|doesn['’]?t|didn['’]?t|never|not|no|without|hate|hated|stopped|quit|can['’]?t|cannot|won['’]?t|nor|neither|zero)\b/i;

/** Every running or race mention in the words, each with whether a negation governs it. */
export function runningMentions(text: unknown): RunningMention[] {
  const words = typeof text === "string" ? text.slice(0, 4000) : "";
  const spans = clauseSpans(words);
  const clauseStart = (at: number) => (spans.find(([a, b]) => at >= a && at <= b) ?? [0])[0];
  const out: RunningMention[] = [];
  const push = (kind: RunningMention["kind"], at: number, match: string) =>
    out.push({ kind, text: match, negated: INTENT_NEG.test(words.slice(clauseStart(at), at)) });
  for (const m of words.matchAll(RACE_PATTERN)) {
    const at = m.index ?? 0;
    const after = words.slice(at + m[0].length);
    if (RACE_NOT.test(after)) continue;
    if (/[$£€]\s*$/.test(words.slice(Math.max(0, at - 2), at))) continue; // "$10k"
    if (/^rat\s/i.test(words.slice(Math.max(0, at - 4), at))) continue; // "the rat race"
    push("race", at, m[0]);
  }
  for (const m of words.matchAll(ACTIVITY_PATTERN)) {
    const at = m.index ?? 0;
    const after = words.slice(at + m[0].length);
    if (/^running$/i.test(m[0]) && RUNNING_NOT.test(after)) continue;
    if (/^jog$/i.test(m[0]) && /^\s+(?:my|your|his|her|their)\s+memory\b/i.test(after)) continue;
    push("activity", at, m[0]);
  }
  for (const m of words.matchAll(RUN_VERB)) {
    const at = m.index ?? 0;
    const before = words.slice(Math.max(0, at - 30), at);
    const after = words.slice(at + m[0].length);
    if (/\bin\s+the\s+long\s+$/i.test(before)) continue; // "in the long run"
    if (/^\s+of\b/i.test(after)) continue; // "a run of bad luck"
    if (RUN_NOUN_BEFORE.test(before) || RUN_VERB_AFTER.test(after)) push("activity", at, m[0]);
  }
  return out;
}

/** Running or a race is something the words say they do or want (not just the word "run"). */
export function mentionsRunningIntent(text: unknown): boolean {
  return runningMentions(text).some((m) => !m.negated);
}

/** The words state a running GOAL — a race, an event distance, a "10k-ready" — not merely running. */
export function statesRunningGoal(text: unknown): boolean {
  return runningMentions(text).some((m) => m.kind === "race" && !m.negated);
}
