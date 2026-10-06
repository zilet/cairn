// What a free-text "activity" actually says. Pure: no db, no clock.
//
// `parseActivity` is the one text parser the activity writer uses (type /
// duration / distance / pace). `classifyActivityCapture` sits in front of the
// chat chokepoint: a chat agent that files a bodyweight ("173", "176.5 lbs weight
// today") or a cuff reading ("log blood pressure 125/75") as `log_activity` would
// otherwise store an activity row that no training read can ever use, while the
// weight trend and the BP history never see the reading. It is deliberately
// conservative: anything the parser recognises as a real session (a type, a
// duration or a distance) stays an activity, and a reroute needs the WHOLE text to
// be the reading — never a number fished out of a sentence about something else.

import { kmFromMiles, lbFromKg } from "./display-words.js";
export interface ParsedActivityText {
  type: string;
  duration_min: number | null;
  distance_km: number | null;
  pace: string | null;
}

export function parseActivity(text: string): ParsedActivityText {
  const t = text.toLowerCase();
  let type = "other";
  if (/\b(mtb|mountain ?bike|ride|rode|riding|cycl|bike|biked|biking|gravel)\b/.test(t)) type = "ride";
  else if (/\b(run|ran|running|jog|jogged|jogging|tempo|intervals?|park ?run|5k|10k)\b/.test(t)) type = "run";
  else if (/\bswim|swam|swimming\b/.test(t)) type = "swim";
  else if (/\b(hike|hiked|hiking|walk|walked|fell ?run|fells)\b/.test(t)) type = "hike";
  // a /km pace strongly implies a run if nothing else matched
  if (type === "other" && /\d+:\d{2}\s*(?:\/|per)\s*km/.test(t)) type = "run";

  let duration_min: number | null = null;
  // (?![a-z]) so a word that merely starts with "h" ("2 hills", "176 home scale")
  // is never read as hours, while "1h30" and "1h 30m" still are.
  const h = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?![a-z])/);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  if (h) duration_min = parseFloat(h[1]) * 60;
  if (m) duration_min = (duration_min || 0) + parseFloat(m[1]);
  const hm = t.match(/\b(\d+):(\d{2})\b(?!\s*\/)/); // 1:30 as h:mm when no /km after
  if (!duration_min && hm) duration_min = parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);

  let distance_km: number | null = null;
  const km = t.match(/(\d+(?:\.\d+)?)\s*(?:km|k\b)/);
  const mi = t.match(/(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/); // \b so "min" isn't read as miles
  if (km) distance_km = parseFloat(km[1]);
  else if (mi) distance_km = kmFromMiles(parseFloat(mi[1]));

  let pace: string | null = null;
  const pc = t.match(/(\d+:\d{2})\s*(?:\/|per)\s*km/);
  if (pc) pace = `${pc[1]}/km`;

  return { type, duration_min, distance_km, pace };
}

export type ActivityCaptureRead =
  | { kind: "activity" }
  | { kind: "weight"; weight_lb: number }
  | { kind: "blood_pressure"; systolic: number; diastolic: number; pulse: number | null }
  | { kind: "drop"; reason: "intent_not_done" | "unintelligible" };

export interface ClassifyActivityCaptureOptions {
  /** The athlete's current stored bodyweight; a unitless bare number must sit near it. */
  referenceWeightLb?: number | null;
}

// The same bounds chat's log_weight normalizer accepts.
const WEIGHT_MIN_LB = 50;
const WEIGHT_MAX_LB = 700;
// A bare number with no unit and no weight word is only a weigh-in when it is
// plausibly THIS athlete's weight — within this fraction of the stored weight, or
// inside the adult band when nothing is stored.
const BARE_NUMBER_REFERENCE_TOLERANCE = 0.15;
const BARE_NUMBER_MIN_LB = 80;
const BARE_NUMBER_MAX_LB = 450;

// Cuff-plausible ranges (narrower than the repo's clamps, which exist to store
// whatever a device reports; this decides whether a slash pair IS a reading).
const SYSTOLIC_MIN = 70;
const SYSTOLIC_MAX = 250;
const DIASTOLIC_MIN = 40;
const DIASTOLIC_MAX = 150;
const PULSE_MIN = 25;
const PULSE_MAX = 240;

const BP_WORDS = /\b(?:blood\s+pressure|bp|systolic|diastolic|mm\s*hg|mmhg)\b/i;
const BP_PAIR = /\b(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})(?:\s*\/\s*(\d{2,3}))?\b/i;
const PULSE_LABELLED =
  /\b(?:pulse|hr|heart\s*rate|resting\s*hr)\s*(?:of|was|is|at|:|=)?\s*(\d{2,3})\b|\b(\d{2,3})\s*bpm\b/i;

const CLOCK_TIME = /\bat\s+\d{1,2}:\d{2}(?:\s*(?:am|pm))?\b|\b\d{1,2}:\d{2}\s*(?:am|pm)\b/gi;
// Once a reading is named outright (a BP word or a weight word), ANY bare H:MM is
// the time it was taken ("bp 125/75 this morning 7:15"), never a session length —
// except a /km pace, which still marks a run.
const ANY_CLOCK_TIME = /\b\d{1,2}:\d{2}\b(?!\s*(?:\/|per)\s*km)(?:\s*(?:am|pm)\b)?/gi;

const WEIGHT_WORDS = /\b(?:weigh-?in|weight|weigh(?:ed|s|ing)?|bodyweight|body\s+weight|scale)\b/i;
const WEIGHT_WORDS_ALL = new RegExp(WEIGHT_WORDS.source, "gi");
const WEIGHT_NUMBER = /\b(\d{2,3}(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)?\b/gi;

// A number with a load unit next to lifting language is a set, not a weigh-in.
const LIFTING_WORDS =
  /\b(?:bench|squat|deadlift|press|row|curl|pull-?ups?|chin-?ups?|dips?|lunge|carry|ruck(?:ed|ing)?|dumbbells?|db|barbell|bb|kettlebells?|kb|plates?|sets?|reps?|rep|x\s*\d|\d+\s*x|×|assist(?:ed)?|vest|pack|lifted|lifting|max|pr|1rm|e1rm|warm-?up)\b/i;

// Words that may surround a stated reading without turning it into anything else.
const READING_FILLER = new Set([
  "log",
  "logged",
  "logging",
  "record",
  "recorded",
  "track",
  "save",
  "add",
  "enter",
  "note",
  "please",
  "my",
  "the",
  "a",
  "an",
  "i",
  "im",
  "i'm",
  "is",
  "was",
  "am",
  "at",
  "of",
  "in",
  "on",
  "to",
  "and",
  "it",
  "says",
  "said",
  "reads",
  "read",
  "today",
  "todays",
  "today's",
  "this",
  "morning",
  "evening",
  "night",
  "tonight",
  "yesterday",
  "now",
  "just",
  "fasted",
  "after",
  "before",
  "waking",
  "wake",
  "up",
  "breakfast",
  "new",
  "current",
  "currently",
  "down",
  "reading",
  "measured",
  "measurement",
  "seated",
  "sitting",
  "standing",
  "lying",
  "left",
  "right",
  "arm",
  "wrist",
  "cuff",
  "home",
  "resting",
  "rest",
  "with",
  "around",
  "about",
  "approx",
  "roughly",
]);

// Vocabulary that marks a real movement session even when the parser found no
// type, duration or distance ("yoga class", "played tennis", "push day done").
const ACTIVITY_WORDS =
  /\b(?:yoga|pilates|barre|climb(?:ed|ing)?|boulder(?:ed|ing)?|tennis|squash|padel|pickleball|badminton|golf(?:ed)?|soccer|football|basketball|volleyball|hockey|rugby|baseball|softball|row(?:ed|ing)?|erg|ski(?:ed|ing)?|snowboard(?:ed|ing)?|skat(?:e|ed|ing)|surf(?:ed|ing)?|paddl(?:e|ed|ing)|sup|kayak(?:ed|ing)?|canoe(?:d|ing)?|danc(?:e|ed|ing)|stretch(?:ed|ing)?|mobility|elliptical|stair(?:s|master)?|stepper|spin(?:ning)?|peloton|crossfit|hiit|circuit|workout|work(?:ed)?\s+out|train(?:ed|ing)|session|class|lift(?:ed|ing)?|gym|cardio|sport|game|match|practice|ruck(?:ed|ing)?|sprints?|jump\s+rope|skipping|box(?:ed|ing)|kickbox(?:ing)?|martial|bjj|jiu|judo|karate|muay|wrestl(?:e|ed|ing)|sauna|plunge|trek(?:ked|king)?|trail|commute|mow(?:ed|ing)?|yard\s*work|garden(?:ed|ing)?|shovel(?:ed|ing)?|chores|played|swam|walked|hiked|ran|rode|treadmill|zumba|tai\s*chi|qi\s*gong|frisbee|strength|core|(?:upper|lower|full)[- ]?body)\b|\b(?:push|pull|legs?|upper|lower|full[- ]body|arms?|chest|back|shoulders?)\s+day\b/i;

// The athlete (or a truncated message) talking about a session that has not
// happened yet: future intent, or one only now beginning. Always dropped.
const INTENT_NOT_DONE =
  /^\s*(?:let'?s|lets|let\s+us|i'?m\s+(?:going|gonna|about)\s+to|i\s+am\s+(?:going|about)\s+to|going\s+to|gonna|about\s+to|i\s+(?:want|plan|need|would\s+like|will|should)\s+to|i'?ll|want\s+to|wanna|plan(?:ning)?\s+to|start(?:ing)?|begin(?:ning)?|ready\s+to|time\s+to)\b/i;
// A question or request. Not by itself a session — unless it asks to log one.
const REQUEST_PHRASING = /^\s*(?:should\s+i|can\s+(?:we|i|you)|could\s+(?:we|you|i)|would\s+you|will\s+you)\b/i;
const LOG_VERB = /\b(?:log|logged|record|recorded|add|save|track|note)\b/i;

function hasActivityMetrics(parsed: ParsedActivityText): boolean {
  return parsed.type !== "other" || parsed.duration_min != null || parsed.distance_km != null;
}

/** Words left once the reading's own tokens and neutral filler are removed. */
function leftoverWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/g, " ") // a stated clock time ("at 7:30") is context, not content
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/g, " ")
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !READING_FILLER.has(word));
}

function readBloodPressure(text: string, hasBpWords: boolean): ActivityCaptureRead | null {
  const pair = text.match(BP_PAIR);
  if (!pair) return null;
  const systolic = Number(pair[1]);
  const diastolic = Number(pair[2]);
  if (systolic < SYSTOLIC_MIN || systolic > SYSTOLIC_MAX) return null;
  if (diastolic < DIASTOLIC_MIN || diastolic > DIASTOLIC_MAX) return null;
  if (diastolic >= systolic) return null;
  // A second slash pair ("120/80 then 118/76") is two readings or something else
  // entirely — not one reading to store.
  const rest = text.slice((pair.index ?? 0) + pair[0].length);
  if (BP_PAIR.test(rest)) return null;
  let pulse: number | null = pair[3] != null ? Number(pair[3]) : null;
  const labelled = text.match(PULSE_LABELLED);
  if (pulse == null && labelled) pulse = Number(labelled[1] ?? labelled[2]);
  if (pulse != null && (pulse < PULSE_MIN || pulse > PULSE_MAX)) pulse = null;
  if (!hasBpWords) {
    // A bare slash pair only counts when it is the whole message.
    const stripped = text
      .replace(BP_PAIR, " ")
      .replace(PULSE_LABELLED, " ")
      .replace(/\b(?:pulse|hr|heart\s*rate|bpm)\b/gi, " ");
    if (leftoverWords(stripped).length > 0) return null;
  }
  return { kind: "blood_pressure", systolic, diastolic, pulse };
}

function readWeight(text: string, namedWeight: boolean, referenceWeightLb: number | null): ActivityCaptureRead | null {
  if (LIFTING_WORDS.test(text)) return null;
  const candidates: Array<{ lb: number; unit: string | null }> = [];
  for (const match of text.matchAll(WEIGHT_NUMBER)) {
    const value = Number(match[1]);
    const unit = match[2] ? match[2].toLowerCase() : null;
    const lb = unit && unit.startsWith("k") ? lbFromKg(value) : value;
    if (!Number.isFinite(lb) || lb < WEIGHT_MIN_LB || lb > WEIGHT_MAX_LB) continue;
    candidates.push({ lb: Math.round(lb * 10) / 10, unit });
  }
  // Two plausible numbers ("176 down from 178") is a story, not one weigh-in.
  if (candidates.length !== 1) return null;
  const [{ lb, unit }] = candidates;
  const stripped = text
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, " ")
    .replace(WEIGHT_NUMBER, " ")
    .replace(WEIGHT_WORDS_ALL, " ");
  const onlyTheReading = leftoverWords(stripped).length === 0;
  if (namedWeight) {
    // "weight" / "weighed" / "scale" names the reading outright; still refuse a
    // sentence that carries other content ("weighed 176 then ran").
    return onlyTheReading ? { kind: "weight", weight_lb: lb } : null;
  }
  if (!onlyTheReading) return null;
  if (unit) return { kind: "weight", weight_lb: lb };
  // A unitless bare number: only when it is plausibly this athlete's weight.
  if (referenceWeightLb != null && Number.isFinite(referenceWeightLb) && referenceWeightLb > 0) {
    return Math.abs(lb - referenceWeightLb) / referenceWeightLb <= BARE_NUMBER_REFERENCE_TOLERANCE
      ? { kind: "weight", weight_lb: lb }
      : null;
  }
  return lb >= BARE_NUMBER_MIN_LB && lb <= BARE_NUMBER_MAX_LB ? { kind: "weight", weight_lb: lb } : null;
}

/**
 * Decide what a chat `log_activity` text really is. Order matters and is
 * conservative: a text the parser reads as a session (type, duration or distance)
 * is ALWAYS an activity; only a text that is wholly a weigh-in or a cuff reading is
 * rerouted; and an activity with no type, duration or distance is dropped only when
 * it is an unstarted intention or carries no movement vocabulary at all.
 */
export function classifyActivityCapture(
  text: unknown,
  options: ClassifyActivityCaptureOptions = {}
): ActivityCaptureRead {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return { kind: "drop", reason: "unintelligible" };
  const hasBpWords = BP_WORDS.test(raw);
  // With BP named outright, the slash pair is the reading, not a session: parse the
  // rest so "bp 125/75 hr 60" cannot read "75 hr" as a 75-hour activity.
  // A clock time of day ("at 7:15", "7:15am") is when, not how long — the parser
  // would read it as a 7h15 duration and shield a weigh-in as an "activity".
  const namedWeight = WEIGHT_WORDS.test(raw);
  const withoutClock = raw.replace(hasBpWords || namedWeight ? ANY_CLOCK_TIME : CLOCK_TIME, " ");
  const parsed = parseActivity(hasBpWords ? withoutClock.replace(BP_PAIR, " ") : withoutClock);
  if (hasActivityMetrics(parsed)) return { kind: "activity" };

  const bp = readBloodPressure(raw, hasBpWords);
  if (bp) return bp;

  const referenceWeightLb = options.referenceWeightLb == null ? null : Number(options.referenceWeightLb);
  const weight = hasBpWords ? null : readWeight(raw, namedWeight, referenceWeightLb);
  if (weight) return weight;

  if (INTENT_NOT_DONE.test(raw)) return { kind: "drop", reason: "intent_not_done" };
  // A lift filed as an activity is the wrong action, but it is still the athlete's
  // training: keep it rather than lose it.
  const namesMovement = ACTIVITY_WORDS.test(raw) || LIFTING_WORDS.test(raw);
  // A question or request is a session only when it asks to LOG one that happened
  // ("can we log my yoga class from this morning"); "should I do yoga?" is not.
  if (REQUEST_PHRASING.test(raw) && !(namesMovement && LOG_VERB.test(raw))) {
    return { kind: "drop", reason: "intent_not_done" };
  }
  if (!namesMovement) return { kind: "drop", reason: "unintelligible" };
  return { kind: "activity" };
}
