// The live-shaped conductor fixtures (the athlete in the "Where to focus" complaint, as
// of 2026-10-06), shared by coachingFocusWeekRead.test.js. Not a test file itself.

export const TODAY = "2026-10-06";

export function signalState({ posture = "train", fueling = "normal" } = {}) {
  const dim = (name, extra = {}) => ({
    dimension: name,
    status: "steady",
    confidence: "medium",
    evidence: [],
    conflicts: [],
    voice: { key: "unvoiced_clear" },
    ...extra,
  });
  return {
    date: TODAY,
    action: {
      posture,
      readiness: "ready",
      reason: posture === "done" ? "Today's planned work is already complete." : "Room for the planned day.",
      reasons: [posture === "done" ? "Today's planned work is already complete." : "Room for the planned day."],
      voice: { key: posture === "done" ? "completed_today" : "unvoiced_clear" },
      directives: { training: "proceed", fueling, schedule: "normal" },
    },
    dimensions: {
      recovery_capacity: dim("recovery_capacity"),
      training_load_tolerance: dim("training_load_tolerance"),
      energy_fueling: dim("energy_fueling", {
        status: fueling === "protect" ? "constrained" : "steady",
        voice: { key: fueling === "protect" ? "fuel_protect" : "unvoiced_clear" },
      }),
      life_capacity: dim("life_capacity"),
      health_constraints: dim("health_constraints"),
    },
  };
}

export const LIPIDS = {
  group: "Lipids & Cardiovascular",
  tier: "act_now",
  moves: {},
  why: "Total Cholesterol and Non-HDL-C sit off together — they move as one picture, so the same change shifts several at once",
  readings: [
    {
      name: "Total Cholesterol",
      value: 262,
      unit: "mg/dL",
      date: "2026-08-24",
      flag: "high",
      optimal: [125, 200],
      in_optimal: false,
      trend: "rising",
    },
    {
      name: "Apolipoprotein B (ApoB)",
      value: 134,
      unit: "mg/dL",
      date: "2026-08-24",
      flag: "high",
      optimal: [40, 80],
      in_optimal: false,
      trend: "falling",
    },
  ],
};

export const HRV_PRIORITY = {
  group: "Fitness & Metabolic Rate",
  tier: "track",
  readings: [
    {
      name: "HRV",
      value: 43,
      unit: "ms",
      date: "2026-10-05",
      optimal: [42, 54],
      in_optimal: false,
      trend: "falling",
      status_note: "this week's average (3 nights)",
    },
  ],
};

export function raceBuild({ currentKind = "build", daysTo = 26 } = {}) {
  const kinds = currentKind === "peak" ? ["peak", "taper", "race"] : ["build", "peak", "taper", "race"];
  const starts = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
  const km = { build: 29.5, peak: 38, taper: 23.2, race: 10.4 };
  const long = { build: 15, peak: 19.5, taper: 10.7, race: 5.7 };
  const short = {
    build: "VO2 intervals, volume holds",
    peak: "A new weekly high",
    taper: "Less volume, speed kept",
    race: "Easy runs and strides",
  };
  return {
    available: true,
    as_of: TODAY,
    running: "race",
    race: {
      event: "Cambridge Half Marathon",
      date: "2026-11-01",
      distance_km: 21.1,
      days_to_race: daysTo,
      weeks_to_race: 4,
      phase: currentKind === "peak" ? "sharpen" : "sharpen",
      target: { sec: 7200, raw: "sub-2:00 target; 1:50 stretch" },
      stretch: { sec: 6600, raw: "1:50 stretch", fit: "stretch" },
    },
    prediction: {
      estimate_sec: 6832,
      estimate_pace_sec_per_km: 324,
      basis: "watch_predictor",
      as_of: TODAY,
      trend: { delta_sec: -545, since: "2026-09-08", word: "faster" },
      gap_sec: -368,
      fit: "fits",
    },
    this_week: {
      km: km[kinds[0]],
      long_km: long[kinds[0]],
      logged_km: 6.1,
      quality: { label: "Short intervals", pace: { text: "5:16–5:26 /km" } },
    },
    weeks: kinds.map((kind, i) => ({
      week_start: starts[i + (currentKind === "peak" ? 1 : 0)],
      weeks_to_race: 3 - i - (currentKind === "peak" ? 1 : 0),
      kind,
      km: km[kind],
      long_km: long[kind],
      focus:
        kind === "build"
          ? "Sharpen rather than add: VO2 intervals while the volume holds."
          : kind === "peak"
            ? "A new weekly high: the biggest week you have run, with the long run at its top, so the other runs stay truly easy."
            : "Less volume with a little speed kept in, so race day finds the legs sharp.",
      focus_short: short[kind],
      with_lifting:
        kind === "taper"
          ? "Taper week: leg work stays on the card with fewer sets at a lighter weight, and the upper-body days keep progressing."
          : "Lower A on Friday is the last lift before Sunday's long run: the main lift stands and the leg extras drop a set, so the legs arrive ready.",
      current: i === 0,
    })),
    leg_map: [
      { day_number: 1, weekday: "Monday", run: null, strength: { name: "Upper Body & Arms" } },
      { day_number: 6, weekday: "Saturday", run: null, strength: null, ride: true },
      { day_number: 7, weekday: "Sunday", run: { kind: "long", label: "Long run", km: 15 }, strength: null },
    ],
    ride: {
      label: "trail MTB",
      day_number: 6,
      weekday: "Saturday",
      typical_min: 142.3,
      typical_load: "heavy",
      placement:
        "Saturday's trail MTB comes the day before the long run. Keep the long run conversational the morning after — the ride is still in the legs — or keep the ride easy.",
    },
    capacity: { best_week_km: 35.8 },
    review: {
      weeks: [
        { week_start: "2026-09-07", km: 23.4 },
        { week_start: "2026-09-14", km: 32.5 },
        { week_start: "2026-09-21", km: 19.5 },
        { week_start: "2026-09-28", km: 35.8 },
      ],
    },
  };
}

export const PERFORMANCE = {
  age: 44,
  hero: { headline: "You're an intermediate lifter overall — row leads (advanced for your 40s)" },
  lever: {
    headline: "Bring up your overhead press",
    why: "It's your furthest-behind lift (novice for your age) — focused volume here is where the easiest, most motivating progress is.",
    target: "about +10 lb on Barbell Overhead Press reaches intermediate",
  },
  capacities: [
    {
      key: "row",
      label: "Row",
      exercise: "Barbell Bent-Over Row",
      est_1rm: 196,
      level: "advanced",
      age_band: "40s",
      to_next: { level: "elite", lb: 15 },
    },
    {
      key: "squat",
      label: "Squat",
      exercise: "Back Squat",
      est_1rm: 228,
      level: "intermediate",
      age_band: "40s",
      to_next: { level: "advanced", lb: 20 },
    },
    {
      key: "press",
      label: "Overhead press",
      exercise: "Barbell Overhead Press",
      est_1rm: 87,
      level: "novice",
      age_band: "40s",
      to_next: { level: "intermediate", lb: 10 },
    },
  ],
  momentum: { chips: [{ kind: "climbing", text: "21 lifts climbing" }] },
  endurance: { tone: "missing", vo2max: null },
  tests_due: [{ exercise: "Barbell Bent-Over Row", kind: "strength" }],
};

export const WEIGHTS = [
  ["2026-09-23", 160.5],
  ["2026-09-24", 160.5],
  ["2026-09-26", 160.6],
  ["2026-09-27", 160.2],
  ["2026-09-28", 161.2],
  ["2026-09-29", 160.4],
  ["2026-10-01", 160.2],
  ["2026-10-02", 159.8],
  ["2026-10-04", 158.8],
  ["2026-10-05", 159.6],
  ["2026-10-06", 159.6],
].map(([date, weight_lb]) => ({ date, weight_lb }));

// The athlete in the complaint, as of 2026-10-06: muscle first with the Cambridge Half as
// supporting work 26 days out, a push athlete whose block's scheduled week-6 deload runs as
// intensification, a lipid act-now finding, an on-pace cut, a Saturday MTB, today's lift done.
export function liveShaped(over = {}) {
  return {
    date: TODAY,
    goalMode: "lose",
    leadMode: "lead",
    trainingIntent: {
      priorities: ["muscle", "leanness", "endurance", "longevity"],
      endurance_role: "supporting",
      source: "explicit",
    },
    enduranceGoal: { is_race: true, phase: "sharpen", weeks_to_race: 4 },
    programState: {
      mesocycle: { phase: "intensification" },
      lifts: [
        {
          exercise: "Barbell Overhead Press",
          muscle_group: "shoulders",
          est_1rm: 87,
          trend_per_wk: 1.2,
          status: "progressing",
        },
      ],
    },
    programBlock: {
      goal: "Muscle first — keep Cambridge Half Marathon as supporting work",
      focus: "hypertrophy",
      phase: "intensification",
      week_of: "week 6 of 6",
      scheduled_deload_skipped: true,
    },
    recovery: { delta: { hrv: -3, rhr: 1 } },
    healthFocus: {
      headline: "Lipids & Cardiovascular and inflammation are the priorities right now.",
      lead: LIPIDS,
      priorities: [LIPIDS, HRV_PRIORITY],
    },
    performance: PERFORMANCE,
    raceBuild: raceBuild(),
    goalPace: {
      points: WEIGHTS,
      trend: { lb_wk: -0.93 },
      needed: { lb_wk: -0.98 },
      goal: { weight_lb: 154, date: "2026-11-15" },
      window_days: 21,
    },
    weekWins: { prs: [] },
    cutQuality: { active: true, strength: { considered: 8, holding: 7, regressing: 1 } },
    signalState: signalState({ posture: "done", fueling: "protect" }),
    trajectory: { horizon_weeks: 8 },
    ...over,
  };
}
