// One home per fact (docs/IA.md, Principle 1 and contract test 4).
//
// Every fact the athlete reads has ONE owner component that says it in full. Other
// components may glance at it — one line that links to the owner — but never repeat
// the owner's sentence. This map is the contract; test/oneHomePerFact.test.js renders
// Today and Train from one seeded fixture and fails when an owner's sentence shows in
// full on a screen it does not own, or when an 8+ word sentence appears twice on one
// screen.
//
// Component names are "<screen>.<component>". A screen is a rendered surface: Today,
// Train's home, Horizon's Week, Train's Body group, Ask, You.
//
// Self-contained on purpose: this module imports nothing, so a client test, a server
// test or a doc generator can read it alike.

export type FactKey =
  | "week_summary"
  | "today_lift_line"
  | "new_bests"
  | "race_countdown"
  | "weight_trend"
  | "deload_decision"
  | "push_stance";

export type FactScreen = "today" | "train" | "horizon" | "body" | "ask" | "you";

export interface FactOwner {
  /** The one component that says the fact in full. */
  owner: string;
  /** The screen the owner renders on. */
  screen: FactScreen;
  /** Components that may glance at the fact (a short line linking to the owner), never its full sentence. */
  glances: readonly string[];
  /** What the full form is, in a few words (documentation). */
  says: string;
}

export const FACT_OWNERS: Readonly<Record<FactKey, FactOwner>> = {
  week_summary: {
    owner: "horizon.week-summary",
    screen: "horizon",
    glances: ["today.week-strip"],
    says: "the week's one summary sentence and its done/planned counts (WeekRead.summary)",
  },
  today_lift_line: {
    owner: "today.brief",
    screen: "today",
    glances: ["today.week-strip", "horizon.week-shape", "train.program-week", "you.strength-stone"],
    says: "today's lift in the server's one line (todayStrengthLine)",
  },
  new_bests: {
    owner: "train.what-moved",
    screen: "train",
    glances: ["today.session-done"],
    says: "the week's new bests, named (coaching focus changed_since)",
  },
  race_countdown: {
    owner: "horizon.frame-hero",
    screen: "horizon",
    glances: ["today.horizon-glance", "train.focus-headline"],
    says: "days to the race and the week's stage (weekFrameLine headline + line)",
  },
  weight_trend: {
    owner: "body.goal-pace",
    screen: "body",
    glances: ["today.body-recovery", "horizon.goals", "train.what-moved"],
    says: "the ONE weight-trend sentence (weightTrendRead.line)",
  },
  deload_decision: {
    owner: "train.block-line",
    screen: "train",
    glances: [],
    says: "the block week and its deload decision (coaching focus block_line + block.decision)",
  },
  push_stance: {
    owner: "train.push-strip",
    screen: "train",
    glances: ["today.push-line"],
    says: "the push stance and its sentence (training drive stance.line); today's holds stay the Brief's",
  },
};

export const FACT_KEYS = Object.keys(FACT_OWNERS) as FactKey[];

/** The screen a component renders on ("today.brief" → "today"). */
export function screenOfComponent(component: string): FactScreen {
  return component.split(".")[0] as FactScreen;
}

/** May `component` show `fact` at all? Its owner may in full; a listed glance may as a glance. */
export function mayShowFact(fact: FactKey, component: string): boolean {
  const entry = FACT_OWNERS[fact];
  return entry.owner === component || entry.glances.includes(component);
}
