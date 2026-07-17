import { createHash } from "node:crypto";
import { db } from "../db.js";
import { canonicalEnduranceSport } from "./endurance-sports.js";
import { completedIntakeWindow, type CompletedIntakeDay } from "./intake-window.js";
import { getRunCompliance } from "./sessions.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";

export type UnderfuelingState =
  | "insufficient_signal"
  | "near_target"
  | "uncertain"
  | "execution_gap"
  | "prescription_strain"
  | "settling"
  | "persistent_strain";
export type UnderfuelingConfidence = "none" | "low" | "medium" | "high";
export type UnderfuelingChannelDirection = "strain" | "support" | "unknown";

export interface UnderfuelingChannel {
  key: "logged_intake" | "weight_trend" | "body_trend" | "felt_energy" | "performance" | "recovery" | "workload";
  direction: UnderfuelingChannelDirection;
  summary: string;
  samples: number;
  evidence_keys: string[];
}

export interface UnderfuelingRead {
  as_of: string;
  state: UnderfuelingState;
  confidence: UnderfuelingConfidence;
  window: { since: string; through: string; calendar_days: number };
  uncertainty: {
    deadband_kcal: number | null;
    deadband_basis: string;
    missing_food_days: number;
    partial_food_days: number;
    note: string;
  };
  intake: {
    observed_days: number;
    credible_days: number;
    compared_days: number;
    materially_below_days: number;
    near_target_days: number;
    average_gap_kcal: number | null;
    current_target_kcal: number | null;
    maintenance_estimate_kcal: number | null;
  };
  correction: {
    target_id: number | null;
    effective_date: string | null;
    age_days: number | null;
    upward_delta_kcal: number | null;
    settling: boolean;
  };
  channels: UnderfuelingChannel[];
  agreeing_channels: string[];
  conflicting_channels: string[];
  rationale: string;
  action: {
    kind: "collect_signal" | "hold" | "reshape_meals" | "raise_target" | "settle" | "recovery_package";
    kcal_delta: number | null;
    training: "proceed" | "hold_aggression" | "reduce";
    line: string;
  };
  evidence_keys: string[];
  signature: string;
}

export interface UnderfuelingOptions {
  windowDays?: number;
  expenditure?: any;
  goal?: any;
  programState?: any;
  wholePerson?: any;
}

const MATERIAL_GAP_FRAC = 0.11;
const MATERIAL_GAP_MIN_KCAL = 225;
const MIN_CREDIBLE_DIARY_DAYS = 3;
const MIN_AGREEING_CHANNELS = 2;
const SETTLING_DAYS = 7;
const PERSISTENCE_WINDOW_DAYS = 21;

// Internal causal roles keep correlated observations from pretending to be
// independent votes. Weight and waist are two views of one energy-balance
// outcome; workload describes demand, but is not an athlete outcome by itself.
// The three athlete-response families stay distinct because felt energy,
// comparable performance and recovery answer different questions.
type CausalFamily =
  | "intake_execution"
  | "energy_balance_outcome"
  | "felt_response"
  | "performance_response"
  | "recovery_response"
  | "demand_context";

const CHANNEL_FAMILY: Record<UnderfuelingChannel["key"], CausalFamily> = {
  logged_intake: "intake_execution",
  weight_trend: "energy_balance_outcome",
  body_trend: "energy_balance_outcome",
  felt_energy: "felt_response",
  performance: "performance_response",
  recovery: "recovery_response",
  workload: "demand_context",
};

const ATHLETE_RESPONSE_FAMILIES = new Set<CausalFamily>(["felt_response", "performance_response", "recovery_response"]);

function causalFamilies(channels: UnderfuelingChannel[], direction: UnderfuelingChannelDirection): Set<CausalFamily> {
  return new Set(
    channels
      .filter((channel) => channel.direction === direction)
      .map((channel) => CHANNEL_FAMILY[channel.key])
      .filter((family) => family !== "demand_context")
  );
}

function hasAthleteResponse(families: Set<CausalFamily>): boolean {
  return [...families].some((family) => ATHLETE_RESPONSE_FAMILIES.has(family));
}

// Persistence is a chronological claim: the athlete must have actually reported
// or logged a low response on a strictly later calendar date than the upward
// correction. Nutrition targets and these observations are date-only, so a row on
// the effective date has unknowable ordering and cannot prove a post-correction
// response. Broader program-state and 56-day trajectory summaries may corroborate
// a later observation, but can never satisfy this gate because they blend
// pre-correction history.
function postCorrectionAthleteResponse(
  correctionDate: string | null,
  today: string
): { families: Set<CausalFamily>; evidence_keys: string[] } {
  if (!correctionDate) return { families: new Set(), evidence_keys: [] };
  const families = new Set<CausalFamily>();
  const evidence = new Set<string>();
  const fuel = db
    .prepare(`SELECT date, energy, hunger FROM fueling_feedback WHERE date > ? AND date <= ? ORDER BY date`)
    .all(correctionDate, today) as any[];
  for (const row of fuel) {
    const energy = finite(row.energy);
    const hunger = finite(row.hunger);
    if ((energy != null && energy <= 1) || (hunger != null && hunger >= 3)) {
      families.add("felt_response");
      evidence.add(`fueling_feedback:${String(row.date)}:post-correction-low`);
    }
  }
  const checkins = db
    .prepare(`SELECT date, energy, sleep_feel, soreness FROM checkins WHERE date > ? AND date <= ? ORDER BY date`)
    .all(correctionDate, today) as any[];
  for (const row of checkins) {
    const energy = finite(row.energy);
    const sleep = finite(row.sleep_feel);
    const soreness = finite(row.soreness);
    if (energy != null && energy <= 2) {
      families.add("felt_response");
      evidence.add(`checkins.energy:${String(row.date)}:post-correction-low`);
    }
    if ((sleep != null && sleep <= 2) || (soreness != null && soreness >= 4)) {
      families.add("recovery_response");
      evidence.add(`checkins.recovery:${String(row.date)}:post-correction-low`);
    }
  }
  const sessions = db
    .prepare(`SELECT date, performance, soreness FROM sessions WHERE date > ? AND date <= ? ORDER BY date`)
    .all(correctionDate, today) as any[];
  for (const row of sessions) {
    const performance = finite(row.performance);
    const soreness = finite(row.soreness);
    if (performance != null && performance <= 2) {
      families.add("performance_response");
      evidence.add(`sessions.performance:${String(row.date)}:post-correction-low`);
    }
    if (soreness != null && soreness >= 4) {
      families.add("recovery_response");
      evidence.add(`sessions.recovery:${String(row.date)}:post-correction-low`);
    }
  }
  return { families, evidence_keys: [...evidence] };
}

function finite(value: unknown): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function targetForDate(date: string): any | null {
  return (
    db
      .prepare(
        `SELECT * FROM nutrition_targets
          WHERE effective_date <= ?
          ORDER BY effective_date DESC, id DESC LIMIT 1`
      )
      .get(date) ?? null
  );
}

function currentAndPreviousTarget(date: string): { current: any | null; previous: any | null } {
  const rows = db
    .prepare(
      `SELECT * FROM nutrition_targets
        WHERE effective_date <= ?
        ORDER BY effective_date DESC, id DESC LIMIT 2`
    )
    .all(date) as any[];
  return { current: rows[0] ?? null, previous: rows[1] ?? null };
}

function deadband(target: number): number {
  // Food portions and labels are estimates. Eleven percent with a 225 kcal floor
  // absorbs ordinary logging error; ±100 kcal/day is deliberately inert.
  return Math.max(MATERIAL_GAP_MIN_KCAL, Math.round(target * MATERIAL_GAP_FRAC));
}

function intakeComparison(days: CompletedIntakeDay[]) {
  const compared = days
    .filter((day) => day.credible)
    .map((day) => {
      const target = targetForDate(day.date);
      const targetKcal = finite(target?.target_kcal);
      if (targetKcal == null || targetKcal <= 0) return null;
      const uncertainty = deadband(targetKcal);
      return {
        date: day.date,
        kcal: day.kcal,
        target_kcal: targetKcal,
        gap_kcal: day.kcal - targetKcal,
        materially_below: day.kcal < targetKcal - uncertainty,
        near_target: Math.abs(day.kcal - targetKcal) <= uncertainty,
      };
    })
    .filter(Boolean) as Array<{
    date: string;
    kcal: number;
    target_kcal: number;
    gap_kcal: number;
    materially_below: boolean;
    near_target: boolean;
  }>;
  return compared;
}

function theilSen(rows: Array<{ date: string; value: number }>): number | null {
  if (rows.length < 3) return null;
  const slopes: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const span = daysBetweenISO(rows[j].date, rows[i].date);
      if (span != null && span > 0) slopes.push((rows[j].value - rows[i].value) / span);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  return slopes[Math.floor(slopes.length / 2)];
}

function bodyChannel(today: string): UnderfuelingChannel {
  const since = addDaysISO(today, -35) ?? today;
  const rows = (
    db
      .prepare(
        `SELECT date, waist_in AS value FROM body_measurements
        WHERE date BETWEEN ? AND ? AND waist_in IS NOT NULL
        ORDER BY date, id`
      )
      .all(since, today) as any[]
  )
    .map((row) => ({ date: String(row.date), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.value));
  const span = rows.length >= 2 ? daysBetweenISO(rows.at(-1)!.date, rows[0].date) : null;
  const slope = span != null && span >= 14 ? theilSen(rows) : null;
  if (slope == null) {
    return {
      key: "body_trend",
      direction: "unknown",
      summary: "Tape measurements are too sparse to corroborate the fuel read; a single measurement is never acted on.",
      samples: rows.length,
      evidence_keys: rows.length ? [`body_measurements:${since}..${today}:n=${rows.length}`] : [],
    };
  }
  const weekly = slope * 7;
  const direction: UnderfuelingChannelDirection =
    weekly <= -0.25 ? "strain" : Math.abs(weekly) <= 0.15 ? "support" : "unknown";
  return {
    key: "body_trend",
    direction,
    summary:
      direction === "strain"
        ? "Repeated waist measurements are moving quickly enough to corroborate the broader loss signal, with tape uncertainty retained."
        : direction === "support"
          ? "Repeated waist measurements are broadly stable; the tape does not corroborate an urgent fuel correction."
          : "The repeated tape trend is directional but not strong enough to own a fuel decision.",
    samples: rows.length,
    evidence_keys: [`body_measurements:${rows[0].date}..${rows.at(-1)!.date}:n=${rows.length}`],
  };
}

function subjectiveChannels(
  since: string,
  today: string
): { felt: UnderfuelingChannel; recovery: UnderfuelingChannel } {
  const fuel = db
    .prepare(`SELECT date, energy, hunger FROM fueling_feedback WHERE date BETWEEN ? AND ? ORDER BY date`)
    .all(since, today) as any[];
  const checkins = db
    .prepare(`SELECT date, energy, sleep_feel, soreness FROM checkins WHERE date BETWEEN ? AND ? ORDER BY date`)
    .all(since, today) as any[];
  const sessions = db
    .prepare(`SELECT date, performance, soreness FROM sessions WHERE date BETWEEN ? AND ? ORDER BY date`)
    .all(since, today) as any[];
  const lowFuelDays = new Set(
    fuel
      .filter((row) => {
        const energy = finite(row.energy);
        const hunger = finite(row.hunger);
        return (energy != null && energy <= 1) || (hunger != null && hunger >= 3);
      })
      .map((row) => String(row.date))
  );
  const lowEnergyDays = new Set(
    checkins
      .filter((row) => {
        const energy = finite(row.energy);
        return energy != null && energy <= 2;
      })
      .map((row) => String(row.date))
  );
  const steadyFuelDays = new Set(
    fuel
      .filter((row) => {
        const energy = finite(row.energy);
        const hunger = finite(row.hunger);
        return energy != null && energy >= 2 && (hunger == null || hunger <= 2);
      })
      .map((row) => String(row.date))
  );
  const energyLow = new Set([...lowFuelDays, ...lowEnergyDays]);
  const poorRecovery = new Set([
    ...checkins
      .filter((row) => {
        const sleep = finite(row.sleep_feel);
        const soreness = finite(row.soreness);
        return (sleep != null && sleep <= 2) || (soreness != null && soreness >= 4);
      })
      .map((row) => String(row.date)),
    ...sessions
      .filter((row) => {
        const soreness = finite(row.soreness);
        return soreness != null && soreness >= 4;
      })
      .map((row) => String(row.date)),
  ]);
  return {
    felt: {
      key: "felt_energy",
      direction: energyLow.size >= 2 ? "strain" : steadyFuelDays.size >= 2 ? "support" : "unknown",
      summary:
        energyLow.size >= 2
          ? "Fueling and check-in feedback repeatedly says energy availability feels low."
          : steadyFuelDays.size >= 2
            ? "Recent fueling feedback is steady enough not to corroborate an urgent correction."
            : "Subjective fueling feedback is still too thin for a directional call.",
      samples: fuel.length + checkins.length,
      evidence_keys: [
        ...(fuel.length ? [`fueling_feedback:${since}..${today}:n=${fuel.length}`] : []),
        ...(checkins.length ? [`checkins:${since}..${today}:n=${checkins.length}`] : []),
      ],
    },
    recovery: {
      key: "recovery",
      direction: poorRecovery.size >= 2 ? "strain" : "unknown",
      summary:
        poorRecovery.size >= 2
          ? "Sleep-feel or soreness has been repeatedly subdued across recent calendar days."
          : "Recent subjective recovery does not yet show a repeated strain pattern.",
      samples: checkins.length + sessions.length,
      evidence_keys: [
        ...(checkins.length ? [`checkins:${since}..${today}:n=${checkins.length}`] : []),
        ...(sessions.length ? [`sessions_feedback:${since}..${today}:n=${sessions.length}`] : []),
      ],
    },
  };
}

// The endurance analogue of the same-lift performance read, feeding the SAME
// performance channel. A genuine decline in endurance OUTPUT — run pace slipping while
// weekly mileage holds, or prescribed runs falling well short two weeks running while
// still training — is a performance-under-strain tell. Conservative + adherence-neutral:
// both signals need real, repeated running (a thin/skipped week never fires), and it
// only ever pushes the protective (fuel-the-work) direction. null when nothing qualifies.
function enduranceStrainSignal(today: string): { reason: string; evidence: string } | null {
  return runPaceDeclineWhileVolumeHeld(today) ?? sustainedRunComplianceDrop(today);
}

// Pace decline while volume held: the last ~14 days of RUN efforts vs the ~14 before.
// Both halves need ≥2 runs with pace; recent mileage must be HELD (≥85% of prior, so a
// taper/ease is excluded) AND recent average pace materially slower (≥5%).
function runPaceDeclineWhileVolumeHeld(today: string): { reason: string; evidence: string } | null {
  const start = addDaysISO(today, -27) ?? today;
  const mid = addDaysISO(today, -13) ?? today; // last 14 days = "recent"
  let rows: any[] = [];
  try {
    rows = db
      .prepare(`SELECT date, type, distance_km, duration_min FROM activities WHERE date BETWEEN ? AND ? ORDER BY date`)
      .all(start, today) as any[];
  } catch {
    return null;
  }
  const recent: { km: number; pace: number }[] = [];
  const prior: { km: number; pace: number }[] = [];
  for (const r of rows) {
    if (canonicalEnduranceSport(r.type).key !== "run") continue; // pace is a foot-sport read
    const km = Number(r.distance_km);
    const min = Number(r.duration_min);
    if (!(km > 0) || !(min > 0)) continue;
    (String(r.date) >= mid ? recent : prior).push({ km, pace: min / km });
  }
  if (recent.length < 2 || prior.length < 2) return null;
  const total = (xs: { km: number; pace: number }[], f: (x: { km: number; pace: number }) => number) =>
    xs.reduce((a, b) => a + f(b), 0);
  const recentKm = total(recent, (x) => x.km);
  const priorKm = total(prior, (x) => x.km);
  const recentPace = total(recent, (x) => x.pace) / recent.length;
  const priorPace = total(prior, (x) => x.pace) / prior.length;
  if (recentKm < priorKm * 0.85) return null; // volume dropped (a taper/ease) — not a strain read
  if (recentPace < priorPace * 1.05) return null; // pace not materially slower
  return {
    reason: "Run pace has slipped while weekly mileage held — endurance output is under strain.",
    evidence: `run_pace_decline:${Math.round(priorPace * 100) / 100}->${Math.round(recentPace * 100) / 100}min_per_km`,
  };
}

// Sustained run-compliance drop: two consecutive weeks where the plan prescribed real
// mileage, the athlete still ran GENUINELY (≥2 outings each week), yet fell well short
// (<60%). Requiring ≥2 real outings per week keeps a busy-but-fine fortnight (a thin run
// week, or ran-just-under-plan) from ever reading as strain — a thin logging week lowers
// confidence, it never signals under-fuelling (adherence-neutral by constitution).
function sustainedRunComplianceDrop(today: string): { reason: string; evidence: string } | null {
  const monday = (() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const lastMonday = addDaysISO(monday, -7);
  if (!lastMonday) return null;
  try {
    const cur = getRunCompliance(monday);
    const prev = getRunCompliance(lastMonday);
    const short = (c: any) =>
      c.prescribed_km > 0 && c.actual_sessions >= 2 && c.actual_km > 0 && c.pct_km != null && c.pct_km < 0.6;
    if (short(cur) && short(prev)) {
      return {
        reason:
          "Prescribed runs have fallen well short two weeks running while still training — endurance output is under strain.",
        evidence: `run_compliance_drop:${prev.pct_km}->${cur.pct_km}`,
      };
    }
  } catch {
    /* no plan / table absent → no signal */
  }
  return null;
}

function performanceChannel(since: string, today: string, program: any, whole: any): UnderfuelingChannel {
  const rows = db
    .prepare(
      `SELECT date, performance FROM sessions WHERE date BETWEEN ? AND ? AND performance IS NOT NULL ORDER BY date`
    )
    .all(since, today) as any[];
  const lowDays = new Set(rows.filter((row) => Number(row.performance) <= 2).map((row) => String(row.date)));
  const regressing = (Array.isArray(program?.lifts) ? program.lifts : []).filter(
    (lift: any) => lift?.status === "regressing"
  );
  const progressing = (Array.isArray(program?.lifts) ? program.lifts : []).filter(
    (lift: any) => lift?.status === "progressing"
  );
  const wholeStrength = (Array.isArray(whole?.domains) ? whole.domains : []).find((d: any) => d?.domain === "strength");
  const endurance = enduranceStrainSignal(today);
  const strengthStrain = lowDays.size >= 2 || regressing.length >= 2 || wholeStrength?.verdict === "worse";
  const strain = strengthStrain || !!endurance;
  const support = !strain && (progressing.length >= 2 || wholeStrength?.verdict === "better");
  return {
    key: "performance",
    direction: strain ? "strain" : support ? "support" : "unknown",
    summary: strain
      ? strengthStrain && endurance
        ? "Same-lift trends and endurance output both show performance under strain."
        : strengthStrain
          ? "Repeated session feedback or same-lift trends show performance under strain."
          : String(endurance!.reason)
      : support
        ? "Same-lift performance is holding or progressing, which argues against an urgent fuel correction."
        : "Performance evidence is mixed or too thin to call.",
    samples: rows.length + regressing.length + progressing.length + (endurance ? 1 : 0),
    evidence_keys: [
      ...(rows.length ? [`sessions.performance:${since}..${today}:n=${rows.length}`] : []),
      ...(regressing.length ? [`program_state:regressing=${regressing.length}`] : []),
      ...(endurance ? [endurance.evidence] : []),
      ...(wholeStrength?.evidence_keys ?? []),
    ],
  };
}

function weightChannel(expenditure: any, goal: any): UnderfuelingChannel {
  const trend = finite(expenditure?.trend_lb_wk);
  const confidence = String(expenditure?.confidence ?? "none");
  const ideal = finite(goal?.leanness_rate?.lean_ideal_rate_lb ?? goal?.recommended?.weekly_rate_lb);
  const safe = finite(goal?.leanness_rate?.safe_max_rate_lb) ?? (ideal == null ? null : ideal * 1.35);
  if (trend == null || !["medium", "high"].includes(confidence) || safe == null || safe <= 0) {
    return {
      key: "weight_trend",
      direction: "unknown",
      summary: "The robust completed-day weight trend is not confident enough to own a fuel change.",
      samples: Number(expenditure?.coverage?.weigh_in_days) || 0,
      evidence_keys: [],
    };
  }
  const loss = trend < 0 ? Math.abs(trend) : 0;
  const strain = loss > safe * 1.1;
  const onPath = ideal != null && loss >= ideal * 0.55 && loss <= safe * 1.1;
  return {
    key: "weight_trend",
    direction: strain ? "strain" : onPath || loss === 0 ? "support" : "unknown",
    summary: strain
      ? `The robust ${expenditure.window_days ?? 21}-day trend is faster than the phase's lean-safe band.`
      : onPath
        ? "The robust weight trend is inside the intended phase band, so the diary alone cannot justify a correction."
        : loss === 0
          ? "The robust weight trend is stable and does not corroborate a large logged deficit."
          : "The robust weight trend is outside the expected direction but not a clear under-fueling signal.",
    samples: Number(expenditure?.coverage?.weigh_in_days) || 0,
    evidence_keys: [`expenditure:${expenditure?.window_days ?? 21}d:${confidence}`],
  };
}

function workloadChannel(program: any): UnderfuelingChannel {
  const highFuel = program?.hybrid?.fuel?.risk === "high" || program?.hybrid?.status === "fuel-protect";
  const acute = finite(program?.mesocycle?.acute_chronic_ratio);
  const strain = highFuel || (acute != null && acute > 1.5);
  return {
    key: "workload",
    direction: strain ? "strain" : "unknown",
    summary: strain
      ? "Actual recent workload and duration raise recovery and fueling demand; wearable calorie burn is not eaten back literally."
      : "Workload does not independently corroborate an urgent fuel correction.",
    samples: strain ? 1 : 0,
    evidence_keys: strain ? ["program_state:workload"] : [],
  };
}

export function underfuelingRead(today = localDateISO(), opts: UnderfuelingOptions = {}): UnderfuelingRead {
  const windowDays = Math.max(7, Math.min(28, Math.trunc(Number(opts.windowDays) || 14)));
  const intakeWindow = completedIntakeWindow(windowDays, today);
  const compared = intakeComparison(intakeWindow.days);
  const targets = currentAndPreviousTarget(today);
  const currentTarget = finite(targets.current?.target_kcal);
  const currentDeadband = currentTarget != null ? deadband(currentTarget) : null;
  const averageGap = compared.length
    ? Math.round(compared.reduce((sum, day) => sum + day.gap_kcal, 0) / compared.length)
    : null;
  const belowDays = compared.filter((day) => day.materially_below).length;
  const nearDays = compared.filter((day) => day.near_target).length;
  const logDirection: UnderfuelingChannelDirection =
    compared.length >= MIN_CREDIBLE_DIARY_DAYS && belowDays >= 3
      ? "strain"
      : compared.length >= MIN_CREDIBLE_DIARY_DAYS && nearDays >= Math.ceil(compared.length * 0.6)
        ? "support"
        : "unknown";
  const logChannel: UnderfuelingChannel = {
    key: "logged_intake",
    direction: logDirection,
    summary:
      logDirection === "strain"
        ? "Several credibly logged completed days sit materially below their effective targets; the execution pattern is unresolved, not explained."
        : logDirection === "support"
          ? "Credibly logged completed days are mostly inside the logging-error band around their targets."
          : "Food coverage is too sparse or mixed to infer a consistent execution pattern.",
    samples: compared.length,
    evidence_keys: compared.length
      ? [`food_notes:${intakeWindow.since}..${intakeWindow.through}:credible=${compared.length}`]
      : [],
  };
  const signalSince = addDaysISO(today, -6) ?? today;
  const subjective = subjectiveChannels(signalSince, today);
  const wholeRecovery = (Array.isArray(opts.wholePerson?.domains) ? opts.wholePerson.domains : []).find(
    (d: any) => d?.domain === "recovery_wellbeing"
  );
  if (subjective.recovery.direction !== "strain" && wholeRecovery?.verdict === "worse") {
    subjective.recovery = {
      ...subjective.recovery,
      direction: "strain",
      summary: "The multi-night recovery trajectory has weakened across the comparison window.",
      evidence_keys: [...subjective.recovery.evidence_keys, ...(wholeRecovery.evidence_keys ?? [])],
    };
  } else if (subjective.recovery.direction === "unknown" && ["holding", "better"].includes(wholeRecovery?.verdict)) {
    subjective.recovery = {
      ...subjective.recovery,
      direction: "support",
      summary: "The multi-night recovery trajectory is holding or improving.",
      evidence_keys: [...subjective.recovery.evidence_keys, ...(wholeRecovery.evidence_keys ?? [])],
    };
  }
  const channels: UnderfuelingChannel[] = [
    logChannel,
    weightChannel(opts.expenditure, opts.goal),
    bodyChannel(today),
    subjective.felt,
    performanceChannel(intakeWindow.since, today, opts.programState, opts.wholePerson),
    subjective.recovery,
    workloadChannel(opts.programState),
  ];
  const strain = channels.filter((channel) => channel.direction === "strain");
  const support = channels.filter((channel) => channel.direction === "support");
  const strainFamilies = causalFamilies(channels, "strain");
  const supportFamilies = causalFamilies(channels, "support");
  const athleteResponseStrain = hasAthleteResponse(strainFamilies);
  const hardConflict =
    strainFamilies.size >= MIN_AGREEING_CHANNELS &&
    supportFamilies.size >= MIN_AGREEING_CHANNELS &&
    strainFamilies.size <= supportFamilies.size;
  const executionCandidate =
    logDirection === "strain" && athleteResponseStrain && strainFamilies.size >= MIN_AGREEING_CHANNELS && !hardConflict;
  const prescriptionCandidate =
    logDirection !== "strain" &&
    strainFamilies.has("energy_balance_outcome") &&
    athleteResponseStrain &&
    strainFamilies.size >= MIN_AGREEING_CHANNELS &&
    !hardConflict;

  const correctionAge = targets.current?.effective_date
    ? daysBetweenISO(today, String(targets.current.effective_date))
    : null;
  const currentKcal = finite(targets.current?.target_kcal);
  const previousKcal = finite(targets.previous?.target_kcal);
  const upwardDelta = currentKcal != null && previousKcal != null ? currentKcal - previousKcal : null;
  const upwardCorrection = upwardDelta != null && upwardDelta >= 100;
  const settling = !!(upwardCorrection && correctionAge != null && correctionAge >= 0 && correctionAge < SETTLING_DAYS);
  const postCorrectionResponse = postCorrectionAthleteResponse(
    upwardCorrection ? String(targets.current?.effective_date ?? "") || null : null,
    today
  );
  const hasPostCorrectionResponse = postCorrectionResponse.families.size > 0;
  const persistent = !!(
    upwardCorrection &&
    correctionAge != null &&
    correctionAge >= SETTLING_DAYS &&
    correctionAge <= PERSISTENCE_WINDOW_DAYS &&
    hasPostCorrectionResponse &&
    athleteResponseStrain &&
    strainFamilies.size >= MIN_AGREEING_CHANNELS &&
    !hardConflict
  );
  const awaitingPostCorrectionResponse = !!(
    upwardCorrection &&
    correctionAge != null &&
    correctionAge >= SETTLING_DAYS &&
    correctionAge <= PERSISTENCE_WINDOW_DAYS &&
    prescriptionCandidate &&
    !hasPostCorrectionResponse
  );

  let state: UnderfuelingState;
  if (
    currentTarget == null ||
    (compared.length < MIN_CREDIBLE_DIARY_DAYS && strainFamilies.size < MIN_AGREEING_CHANNELS)
  )
    state = "insufficient_signal";
  else if (hardConflict || (logDirection === "strain" && !athleteResponseStrain)) state = "uncertain";
  else if (persistent) state = "persistent_strain";
  else if (awaitingPostCorrectionResponse) state = "uncertain";
  else if (settling && (executionCandidate || prescriptionCandidate || strainFamilies.size >= MIN_AGREEING_CHANNELS))
    state = "settling";
  else if (executionCandidate) state = "execution_gap";
  else if (prescriptionCandidate) state = "prescription_strain";
  else if (logDirection === "support" || supportFamilies.size >= MIN_AGREEING_CHANNELS) state = "near_target";
  else state = "uncertain";

  const confidence: UnderfuelingConfidence =
    state === "insufficient_signal"
      ? "none"
      : state === "uncertain"
        ? "low"
        : strainFamilies.size >= 4 && supportFamilies.size === 0 && compared.length >= 7
          ? "high"
          : ["execution_gap", "prescription_strain", "persistent_strain"].includes(state)
            ? "medium"
            : "low";
  const action: UnderfuelingRead["action"] =
    state === "execution_gap"
      ? {
          kind: "reshape_meals",
          kcal_delta: 0,
          training: strain.some((channel) => ["performance", "recovery"].includes(channel.key))
            ? "hold_aggression"
            : "proceed",
          line: "Keep the current target and make the meal pattern easier to complete, including practical carb-forward fuel around training.",
        }
      : state === "prescription_strain"
        ? {
            kind: "raise_target",
            kcal_delta: strainFamilies.size >= 4 ? 200 : 150,
            training: "hold_aggression",
            line: "Protect the next training block with one bounded carb-forward fuel step; do not chase literal exercise calories.",
          }
        : state === "persistent_strain"
          ? {
              kind: "recovery_package",
              kcal_delta: 250,
              training: "reduce",
              line: "The correction has had time to settle and several independent channels still agree; coordinate a recovery week with another bounded move toward maintenance.",
            }
          : state === "settling"
            ? {
                kind: "settle",
                kcal_delta: 0,
                training: strain.some((channel) => ["performance", "recovery"].includes(channel.key))
                  ? "hold_aggression"
                  : "proceed",
                line: "A recent fuel correction is still inside its seven-day settling window, so no second calorie move is made.",
              }
            : state === "insufficient_signal"
              ? {
                  kind: "collect_signal",
                  kcal_delta: null,
                  training: "proceed",
                  line: "Hold the plan while completed-day and outcome signals become comparable.",
                }
              : {
                  kind: "hold",
                  kcal_delta: 0,
                  training: "proceed",
                  line: awaitingPostCorrectionResponse
                    ? "Hold the current correction until a felt, performance, or recovery response is observed on a later calendar date."
                    : state === "uncertain"
                      ? "The channels do not agree strongly enough to change fuel; ordinary logging uncertainty remains the leading explanation."
                      : "The current target and outcome signals are aligned closely enough to hold steady.",
                };
  const rationale =
    state === "execution_gap"
      ? "The logged pattern is materially below target and at least one independent felt-performance/recovery channel agrees; Cairn changes execution support, not calories."
      : state === "prescription_strain"
        ? "The diary is near target while robust weight and performance/recovery channels agree that the prescription is too aggressive."
        : state === "persistent_strain"
          ? "A fresh athlete-response signal and independent corroboration still show strain after the prior upward correction had seven days to settle."
          : state === "settling"
            ? "The latest upward correction remains inside the no-double-adjust window."
            : awaitingPostCorrectionResponse
              ? "The apparent strain comes from evidence that predates the current correction or from aggregate history, so it cannot justify another fuel move."
              : state === "uncertain"
                ? "The diary is estimated and either stands alone or conflicts with supportive outcome channels, so the plan holds."
                : state === "near_target"
                  ? "The available channels support staying with the current plan."
                  : "There is not yet enough comparable completed-day evidence for a fuel action.";
  const evidenceKeys = [
    ...new Set([...channels.flatMap((channel) => channel.evidence_keys), ...postCorrectionResponse.evidence_keys]),
  ];
  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        state,
        through: intakeWindow.through,
        target: targets.current?.id ?? null,
        strain: strain.map((channel) => channel.key),
        support: support.map((channel) => channel.key),
        strain_families: [...strainFamilies].sort(),
        support_families: [...supportFamilies].sort(),
        post_correction_response_families: [...postCorrectionResponse.families].sort(),
      })
    )
    .digest("hex");
  return {
    as_of: today,
    state,
    confidence,
    window: { since: intakeWindow.since, through: intakeWindow.through, calendar_days: intakeWindow.calendar_days },
    uncertainty: {
      deadband_kcal: currentDeadband,
      deadband_basis: "max(225 kcal, 11% of each day's effective target)",
      missing_food_days: intakeWindow.missing_days,
      partial_food_days: intakeWindow.partial_days,
      note: "Food portions, labels, exercise load, scale readings, and tape measurements are estimates; missing food days are unknown, never zero.",
    },
    intake: {
      observed_days: intakeWindow.days.length,
      credible_days: intakeWindow.credible_days,
      compared_days: compared.length,
      materially_below_days: belowDays,
      near_target_days: nearDays,
      average_gap_kcal: averageGap,
      current_target_kcal: currentTarget,
      maintenance_estimate_kcal:
        ["medium", "high"].includes(String(opts.expenditure?.confidence ?? "")) &&
        finite(opts.expenditure?.tdee) != null
          ? Math.round(Number(opts.expenditure.tdee))
          : null,
    },
    correction: {
      target_id: targets.current?.id == null ? null : Number(targets.current.id),
      effective_date: targets.current?.effective_date ?? null,
      age_days: correctionAge,
      upward_delta_kcal: upwardDelta,
      settling,
    },
    channels,
    agreeing_channels: strain.map((channel) => channel.key),
    conflicting_channels: support.map((channel) => channel.key),
    rationale,
    action,
    evidence_keys: evidenceKeys,
    signature,
  };
}
