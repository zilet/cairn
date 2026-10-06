// THE STONES — six athlete-facing words over the whole picture (v2 wave 4).
//
// Strength, Endurance, Fuel, Recovery, Body, Heart. Each stone is ONE plain word (or
// two) and a reading-layer tone, projected HERE from what the server already knows:
// the five signal dimensions (src/repo/signal-state.ts, through the same
// `dayPlanningSignalState` the Brief and the coach context read) and the domain reads
// (today's strength line, the race build, today's intake, the weight trend, the lab
// read). The mapping lives only on the server: the cairn-stack and stone detail print
// the word and never work one out.
//
// Laws this module holds:
//   - Silence is QUIET, never low. A stone with nothing fresh to read says "quiet"; a
//     stale wearable reading is absent (sensor freshness is already applied by the
//     signal state), and sleep is episodic by choice, so a missing night leaves
//     Recovery quiet rather than worried.
//   - A partial intake day is IN PROGRESS, never low (`classifyIntakeDay`).
//   - No score. Words and a tone; any sentence is athlete-facing and speaks through
//     `spokenSignalVoice` (signal-backed) or an authored, day-rotated set.
//   - The race build is READ, never re-derived (`raceBuild`).
//   - The Heart stone is informational: a lab finding reads "worth noting", never a
//     verdict.
//
// Every stone is computed behind its own try/catch, so the read always returns all six.
import type {
  TodayStone,
  TodayStoneKey,
  TodayStoneTarget,
  TodayStoneTone,
  TodayStonesRead,
} from "../../contracts/today-stones.js";
import { db } from "../../db.js";
import { daysBetweenISO } from "../../lib/dates.js";
import { withoutShadowActivities } from "../../repo/activity-shadow.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { dayPlanningSignalState } from "../../repo/day-read.js";
import { listActiveDirectives } from "../../repo/directives-read.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "../../repo/endurance-sports.js";
import { goalPace } from "../../repo/goal-pace.js";
import { GOAL_PACE_WINDOW_DAYS, weightTrendRead } from "../../repo/weight-trend.js";
import { getMarkerHistory } from "../../repo/health.js";
import { completedIntakeRange } from "../../repo/intake-window.js";
import { readingAgeDays, readingPastValidity } from "../../repo/marker-validity.js";
import { raceBuild, type RaceWeekKind } from "../../repo/race-build.js";
import { addDaysISO } from "../../repo/shared.js";
import {
  isAdviceOnly,
  SIGNAL_VOICE_KEYS,
  spokenSignalVoice,
  type ResolvedSignalEvidence,
  type SignalDimension,
  type SignalPosture,
  type UnifiedSignalState,
} from "../../repo/signal-state.js";
import { todayStrengthLine } from "../../repo/today-strength-line.js";
import { todayDateParam } from "./today-surface.js";

export const TODAY_STONE_ORDER: readonly TodayStoneKey[] = [
  "strength",
  "endurance",
  "fuel",
  "recovery",
  "body",
  "heart",
];

/** Each stone's name. Exported so a surface that names a stone (the what-if ripple) never keeps its own copy. */
export const TODAY_STONE_LABELS: Readonly<Record<TodayStoneKey, string>> = {
  strength: "Strength",
  endurance: "Endurance",
  fuel: "Fuel",
  recovery: "Recovery",
  body: "Body",
  heart: "Heart",
};

// Each stone opens the surface that already owns its part of the picture.
const TARGETS: Record<TodayStoneKey, TodayStoneTarget> = {
  strength: { tab: "progress", section: "overview" },
  endurance: { tab: "plan", section: "endurance" },
  fuel: { tab: "plan", section: "food" },
  recovery: { tab: "stand", section: "recovery" },
  body: { tab: "stand", section: "body" },
  heart: { tab: "stand", section: "markers" },
};

// The whole word vocabulary, in one place, so the constitution tests can run every
// word through the reading grammar. One or two words each; none of them grades.
export const TODAY_STONE_WORDS = {
  quiet: "quiet",
  strength: {
    lifted: "lifted",
    under_way: "under way",
    gently: "go gently",
    rest_day: "rest day",
    off: "off today",
    strong: "strong",
    steady: "steady",
    planned: "planned",
  },
  endurance: {
    run_easy: "run easy",
    holding: "holding",
    build: "building",
    down: "easier week",
    peak: "peak week",
    taper: "tapering",
    race: "race week",
    running: "running",
  },
  fuel: { refuel: "refuel", fueled: "fueled", in_progress: "in progress", steady: "steady" },
  recovery: {
    rested: "rested",
    steady: "steady",
    recovering: "recovering",
    needs_rest: "needs rest",
    busy: "busy stretch",
  },
  body: {
    toward: "on course",
    holding: "holding",
    away: "drifting",
    down: "trending down",
    up: "trending up",
    weighed: "weighed in",
  },
  heart: { look: "worth noting", steady: "steady" },
} as const;

// Each word's ONE-word form, for the surfaces that print a word under a pebble at
// phone width (the Today strip: six columns across 360 px). Same meaning, never a
// new judgement: the long word stays the stone's voice everywhere else and in its
// aria text. Every word in TODAY_STONE_WORDS has one; a test holds that.
export const TODAY_STONE_SHORT: Readonly<Record<string, string>> = {
  quiet: "quiet",
  lifted: "lifted",
  "under way": "started",
  "go gently": "gently",
  "rest day": "rest",
  "off today": "off",
  strong: "strong",
  steady: "steady",
  planned: "planned",
  "run easy": "easy",
  holding: "holding",
  building: "building",
  "easier week": "easing",
  "peak week": "peak",
  tapering: "taper",
  "race week": "race",
  running: "running",
  refuel: "refuel",
  fueled: "fueled",
  "in progress": "ongoing",
  rested: "rested",
  recovering: "mending",
  "needs rest": "rest",
  "busy stretch": "busy",
  "on course": "on-pace",
  drifting: "drifting",
  "trending down": "lighter",
  "trending up": "heavier",
  "weighed in": "weighed",
  "worth noting": "notable",
};

// Authored lines for the stones whose evidence is a domain read rather than a signal
// voice. Rotated by calendar day (pickDayVariant), so one morning has one wording.
export const TODAY_STONE_LINES = {
  race: {
    build: ["The build keeps climbing toward race day.", "This week steps the build along toward the race."],
    down: ["An easier week inside the build, on purpose.", "This week eases off so the build can land."],
    peak: ["The biggest week of the build, before the taper.", "This is the top of the build."],
    taper: ["The taper is on: less running, fresher legs.", "Running comes down now so race day finds you fresh."],
    race: ["Race week. Keep it light and trust the build.", "It's race week; the work is already done."],
  } satisfies Record<RaceWeekKind, readonly string[]>,
  running: ["Recent runs are on record.", "You've been running lately."],
  fuel_complete: ["Today reads as a full day of eating.", "Today's meals cover the whole day."],
  fuel_settled: [
    "Your intake and weight trend agree on your energy balance.",
    "Your energy balance has a settled read.",
  ],
  fuel_partial: ["Today's log is still filling in.", "Meals so far are on record; the day isn't finished yet."],
  body_toward: ["Your weight is moving the way you're aiming.", "The recent weigh-ins are heading toward your goal."],
  body_holding: ["Your weight has been holding level lately.", "The recent weigh-ins are sitting level."],
  body_away: [
    "The recent weigh-ins have drifted away from your goal.",
    "Your weight has been moving the other way lately.",
  ],
  body_down: ["Your weight is trending down lately.", "The recent weigh-ins are heading down."],
  body_up: ["Your weight is trending up lately.", "The recent weigh-ins are heading up."],
  body_one: ["A recent weigh-in is on record; a trend needs a few more.", "One recent weigh-in so far."],
  heart_look: [
    "A lab finding is waiting on Stand when you want it.",
    "Something in your labs is worth a look when it suits you.",
  ],
  heart_steady: ["Nothing new stands out in your labs.", "Your labs raise nothing new right now."],
} as const;

// Which evidence speaks for which stone. Recovery takes its whole dimension; the
// training dimension splits between the two lanes it carries; the health dimension's
// injury rows belong to what they limit (lifting) and its illness rows to recovery.
// Life capacity's recovery squeeze (`schedule_pressure`) speaks for Recovery only when
// nothing else there does; a dated commitment is the calendar's, spoken by the Brief.
// Two training-dimension rows are not about lifting at all: fuel protection is the
// fuelling lane's hold (it speaks for Fuel), and generic watch movement is untyped
// activity the Brief already weighs — neither may name the Strength stone.
const ENDURANCE_FIELDS = new Set(["run_intensity_discipline", "endurance_hold_directive"]);
const FUEL_TRAINING_FIELDS = new Set(["fuel_protection"]);
// The energy-balance estimate says how settled the TDEE picture is, not how fuelling is
// going: its voice is always "not settled yet", and its caution is a data-quality flag
// (a partial intake window, an implausible outcome). It never brakes Fuel — "refuel" off
// a thin log would infer under-eating from missing logs — and never lends its voice to
// a calm word; only a settled (supporting) estimate names the stone, in its own line.
const ENERGY_ESTIMATE_FIELD = "expenditure";
const NOT_STRENGTH_FIELDS = new Set([...ENDURANCE_FIELDS, ...FUEL_TRAINING_FIELDS, "generic_activity_load"]);
const STRENGTH_HEALTH_FIELDS = new Set(["active_injury", "joint_pain"]);
const RECOVERY_HEALTH_FIELDS = new Set(["illness", "active_health_constraint"]);

// A weigh-in older than this says nothing about where the weight is now.
export const BODY_STONE_MAX_AGE_DAYS = 14;
// Under this weekly drift (lb) the weight is holding.
const BODY_HOLDING_LB_WK = 0.25;
// How far back a logged run keeps Endurance from reading quiet when no race is set.
const RECENT_RUN_DAYS = 14;

type Evidence = ResolvedSignalEvidence;

const DIRECTION_RANK = { neutral: 0, support: 1, caution: 2, constraint: 3 } as const;

// The fresh, decision-bearing evidence a stone reads (context-only rows inform the
// coach and never decide; stale rows are absent).
function freshEvidence(
  state: UnifiedSignalState | null,
  dimension: SignalDimension,
  keep: (item: Evidence) => boolean = () => true
) {
  return (state?.dimensions?.[dimension]?.evidence ?? []).filter(
    (item) => item.freshness !== "stale" && !item.context_only && keep(item)
  );
}

// Advice that holds nothing back ranks UNDER every fresh reading, support and neutral
// alike. An HRV/RHR caution from before last night is advice-only under the last-night
// law; ranked by direction alone it would put the night before last in front of last
// night, which is exactly what that law forbids.
const leadRank = (item: Evidence): number => (isAdviceOnly(item) ? -1 : DIRECTION_RANK[item.direction]);

// The strongest item: a safety override first, then direction, advice last.
function strongest(items: Evidence[]): Evidence | null {
  return (
    [...items].sort(
      (a, b) => Number(!!b.safety_override) - Number(!!a.safety_override) || leadRank(b) - leadRank(a)
    )[0] ?? null
  );
}

const isBrake = (item: Evidence): boolean =>
  (item.direction === "caution" || item.direction === "constraint") && !isAdviceOnly(item);

// A caution that brakes nothing (advice-only) never speaks under a calm word: its voice
// says "ease off", which an ok stone would contradict. Such a lead leaves the line empty.
const isQuietCaution = (item: Evidence | null): boolean =>
  !!item && (item.direction === "caution" || item.direction === "constraint") && !isBrake(item);

interface Voiced {
  date: string;
  posture: SignalPosture | null;
}

// A signal's own athlete voice, or nothing — never the machine `summary`, never the
// posture floor dressed up as this stone's evidence, and never a non-braking caution's
// "go easy" under a calm word (see isQuietCaution).
function voiceLine(item: Evidence | null, ctx: Voiced, key: string = SIGNAL_VOICE_KEYS.protect): string | null {
  if (!item?.voice || isQuietCaution(item)) return null;
  return spokenSignalVoice(item.voice, ctx.date, key, ctx.posture);
}

const pick = (variants: readonly string[], date: string, key: string) =>
  pickDayVariant(variants, date, `today_stones:${key}`);

function stone(key: TodayStoneKey, word: string, tone: TodayStoneTone, line: string | null = null): TodayStone {
  const short = TODAY_STONE_SHORT[word] ?? (/\s/.test(word) ? null : word);
  return { key, label: TODAY_STONE_LABELS[key], word, short, tone, line, target: TARGETS[key] };
}

const quietStone = (key: TodayStoneKey) => stone(key, TODAY_STONE_WORDS.quiet, "quiet");

function strengthStone(state: UnifiedSignalState | null, ctx: Voiced): TodayStone {
  const W = TODAY_STONE_WORDS.strength;
  const line = todayStrengthLine(ctx.date);
  // "Nothing planned today" is the line's own empty state, not something to read under
  // a word: with nothing planned the stone speaks its evidence or stays quiet.
  const text = line.state === "none" ? null : String(line.text ?? "").trim() || null;
  // The log is truth: work done today names the stone whatever the signals say.
  if (line.state === "logged") return stone("strength", W.lifted, "ok", text);
  if (line.state === "in_progress") return stone("strength", W.under_way, "ok", text);
  const items = [
    ...freshEvidence(state, "training_load_tolerance", (item) => !NOT_STRENGTH_FIELDS.has(item.field)),
    ...freshEvidence(state, "health_constraints", (item) => STRENGTH_HEALTH_FIELDS.has(item.field)),
  ];
  const lead = strongest(items);
  if (lead && isBrake(lead)) {
    const key = lead.field === "active_injury" ? SIGNAL_VOICE_KEYS.injury : SIGNAL_VOICE_KEYS.protect;
    return stone("strength", W.gently, "watch", voiceLine(lead, ctx, key) ?? text);
  }
  // The Brief's own easy/rest read rides the strength line as a caveat; the stone agrees.
  if (line.state === "not_started" && line.suggestion) return stone("strength", W.gently, "watch", line.caveat ?? text);
  if (line.state === "rest_day") return stone("strength", W.rest_day, "ok", text);
  if (line.state === "no_lift") return stone("strength", W.off, "ok", text);
  if (line.state === "none") {
    // No plan today: only lifting evidence with a voice of its own may name the stone
    // (a neutral check-in says nothing about lifting, and "steady" over "Nothing
    // planned today" would be a word with no subject).
    const spoken = lead?.direction === "support" ? voiceLine(lead, ctx) : null;
    return spoken ? stone("strength", W.strong, "ok", spoken) : quietStone("strength");
  }
  if (lead?.direction === "support") return stone("strength", W.strong, "ok", text ?? voiceLine(lead, ctx));
  if (lead) return stone("strength", W.steady, "ok", text ?? voiceLine(lead, ctx));
  if (line.state === "not_started") return stone("strength", W.planned, "ok", text);
  return quietStone("strength");
}

function recentRunCount(date: string): number {
  const since = addDaysISO(date, -RECENT_RUN_DAYS) ?? date;
  const sport = activitySportWhere("a", RUN_SPORT_PATTERNS);
  const rows = db
    .prepare(
      `SELECT a.date AS date, a.type AS type, a.source AS source, a.external_id AS external_id
         FROM activities a WHERE a.date <= ? AND a.date > ? AND (${sport.sql})`
    )
    .all(date, since, ...sport.params) as any[];
  return withoutShadowActivities(rows).length;
}

function enduranceStone(state: UnifiedSignalState | null, ctx: Voiced): TodayStone {
  const W = TODAY_STONE_WORDS.endurance;
  const lead = strongest(freshEvidence(state, "training_load_tolerance", (item) => ENDURANCE_FIELDS.has(item.field)));
  if (lead && isBrake(lead)) {
    const word = lead.field === "endurance_hold_directive" ? W.holding : W.run_easy;
    return stone("endurance", word, "watch", voiceLine(lead, ctx));
  }
  // The race build is read, never re-derived: the week's kind is the ladder's own. With
  // no current rung (the engine returned no week) there is no kind to read, so the stone
  // falls through to the plain running read below rather than inventing one.
  const build = raceBuild(ctx.date);
  const kind: RaceWeekKind | undefined =
    build.available && build.race ? build.weeks.find((week) => week.current)?.kind : undefined;
  if (kind) return stone("endurance", W[kind], "ok", pick(TODAY_STONE_LINES.race[kind], ctx.date, `race:${kind}`));
  if (recentRunCount(ctx.date) > 0 || lead)
    return stone(
      "endurance",
      W.running,
      "ok",
      voiceLine(lead, ctx) ?? pick(TODAY_STONE_LINES.running, ctx.date, "running")
    );
  return quietStone("endurance");
}

function fuelStone(state: UnifiedSignalState | null, ctx: Voiced): TodayStone {
  const W = TODAY_STONE_WORDS.fuel;
  const lead = strongest([
    ...freshEvidence(state, "energy_fueling", (item) => item.field !== ENERGY_ESTIMATE_FIELD),
    ...freshEvidence(state, "training_load_tolerance", (item) => FUEL_TRAINING_FIELDS.has(item.field)),
  ]);
  const estimate = strongest(freshEvidence(state, "energy_fueling", (item) => item.field === ENERGY_ESTIMATE_FIELD));
  // A measured fuelling brake is read off closed, credible days — never off today's
  // unfinished log — so it may speak on a partial day. Same key as the conductor's
  // fueling card, so one signal reads as one observation across the two.
  if (lead && isBrake(lead)) return stone("fuel", W.refuel, "watch", voiceLine(lead, ctx, SIGNAL_VOICE_KEYS.fueling));
  // Today, classified by the one credibility rule: complete, partial or absent.
  const today = completedIntakeRange(ctx.date, ctx.date, ctx.date).days.find((day) => day.date === ctx.date);
  if (today?.coverage === "complete")
    return stone("fuel", W.fueled, "ok", pick(TODAY_STONE_LINES.fuel_complete, ctx.date, "fuel"));
  if (today) return stone("fuel", W.in_progress, "quiet", pick(TODAY_STONE_LINES.fuel_partial, ctx.date, "fuel"));
  if (lead) return stone("fuel", W.steady, "ok", voiceLine(lead, ctx, SIGNAL_VOICE_KEYS.fueling));
  // Only a settled estimate is something to read; an unsettled one is quiet.
  if (estimate?.direction === "support")
    return stone("fuel", W.steady, "ok", pick(TODAY_STONE_LINES.fuel_settled, ctx.date, "fuel"));
  return quietStone("fuel");
}

function recoveryStone(state: UnifiedSignalState | null, ctx: Voiced): TodayStone {
  const W = TODAY_STONE_WORDS.recovery;
  const lead = strongest([
    ...freshEvidence(state, "recovery_capacity"),
    ...freshEvidence(state, "health_constraints", (item) => RECOVERY_HEALTH_FIELDS.has(item.field)),
  ]);
  if (lead) {
    const line = voiceLine(lead, ctx);
    if (isBrake(lead))
      return stone("recovery", lead.direction === "constraint" ? W.needs_rest : W.recovering, "watch", line);
    return stone("recovery", lead.direction === "support" ? W.rested : W.steady, "ok", line);
  }
  const squeeze = strongest(freshEvidence(state, "life_capacity", (item) => item.voice?.key === "schedule_pressure"));
  if (squeeze && isBrake(squeeze)) return stone("recovery", W.busy, "watch", voiceLine(squeeze, ctx));
  // No fresh night, no reading, no check-in: nothing to read. Sleep is episodic by
  // choice, so this is quiet — never short, never low.
  return quietStone("recovery");
}

function bodyStone(ctx: Voiced): TodayStone {
  const W = TODAY_STONE_WORDS.body;
  const L = TODAY_STONE_LINES;
  // Read as of the stone's date, so a past date's trend never fits later weigh-ins.
  // The ONE weight-trend read (weight-trend.ts): the rate every weight surface prints.
  const pace = goalPace(GOAL_PACE_WINDOW_DAYS, ctx.date);
  const latest = pace.points.filter((point) => point.date <= ctx.date).at(-1);
  const age = latest ? daysBetweenISO(ctx.date, latest.date) : null;
  if (!latest || age == null || age > BODY_STONE_MAX_AGE_DAYS) return quietStone("body");
  const slope = weightTrendRead(ctx.date, { pace }).rate_lb_wk;
  if (slope == null) return stone("body", W.weighed, "ok", pick(L.body_one, ctx.date, "body"));
  const moving = Math.abs(slope) >= BODY_HOLDING_LB_WK ? Math.sign(slope) : 0;
  const goal = pace.goal.weight_lb;
  const aim = goal == null ? 0 : Math.sign(goal - latest.weight_lb);
  if (moving === 0) return stone("body", W.holding, "ok", pick(L.body_holding, ctx.date, "body"));
  if (aim === 0)
    return moving < 0
      ? stone("body", W.down, "ok", pick(L.body_down, ctx.date, "body"))
      : stone("body", W.up, "ok", pick(L.body_up, ctx.date, "body"));
  if (moving === aim) return stone("body", W.toward, "ok", pick(L.body_toward, ctx.date, "body"));
  return stone("body", W.away, "watch", pick(L.body_away, ctx.date, "body"));
}

// The Heart stone is a STANDING read: a directive's status carries no dated history, so
// a past `date` reads today's findings (marker validity is still aged to that date).
function heartStone(ctx: Voiced): TodayStone {
  const W = TODAY_STONE_WORDS.heart;
  // A finding the athlete has not yet acknowledged is the one thing worth a look;
  // an acknowledged one stays in effect for coaching and off the to-do surfaces.
  const open = listActiveDirectives().filter((row: any) => !row?.acknowledged);
  if (open.length) return stone("heart", W.look, "watch", pick(TODAY_STONE_LINES.heart_look, ctx.date, "heart"));
  const markers = getMarkerHistory().markers ?? [];
  const inDate = markers.some((m: any) => {
    const date = m?.latest?.date;
    return !!date && !readingPastValidity(m?.name, readingAgeDays(date, ctx.date));
  });
  if (inDate) return stone("heart", W.steady, "ok", pick(TODAY_STONE_LINES.heart_steady, ctx.date, "heart"));
  return quietStone("heart");
}

function guarded(key: TodayStoneKey, build: () => TodayStone): TodayStone {
  try {
    return build();
  } catch {
    return quietStone(key);
  }
}

export function todayStones(dateQuery?: unknown): TodayStonesRead {
  const date = todayDateParam(dateQuery);
  let state: UnifiedSignalState | null = null;
  try {
    state = dayPlanningSignalState(date);
  } catch {
    state = null;
  }
  const ctx: Voiced = { date, posture: state?.action?.posture ?? null };
  // A signal state that failed to build degrades each stone to its domain read alone.
  const byKey: Record<TodayStoneKey, () => TodayStone> = {
    strength: () => guarded("strength", () => strengthStone(state, ctx)),
    endurance: () => guarded("endurance", () => enduranceStone(state, ctx)),
    fuel: () => guarded("fuel", () => fuelStone(state, ctx)),
    recovery: () => guarded("recovery", () => recoveryStone(state, ctx)),
    body: () => guarded("body", () => bodyStone(ctx)),
    heart: () => guarded("heart", () => heartStone(ctx)),
  };
  return { date, stones: TODAY_STONE_ORDER.map((key) => byKey[key]()) };
}
