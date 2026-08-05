import { db } from "../db.js";
import { effectiveGoalMode, getEnduranceGoal, getPrimaryDiscipline, getProfile } from "./profile.js";
import { getActiveBlock } from "./program-blocks.js";
import { addDaysISO, joinList, localDateISO } from "./shared.js";
import { getMarkerHistory, lsqSlopePerDay } from "./health.js";
import { completedIntakeRange } from "./intake-window.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { matchOptimalZone, optimalDistance } from "./propagation.js";
import { recoverySessionDose } from "./training-read.js";
import { getTrainingIntent, type TrainingPriority } from "./training-intent.js";

export type WholePersonVerdict = "better" | "holding" | "worse" | "unknown";
export type WholePersonDomain =
  | "strength"
  | "endurance"
  | "body_composition"
  | "metabolic_health"
  | "recovery_wellbeing";

export interface WholePersonDomainRead {
  domain: WholePersonDomain;
  verdict: WholePersonVerdict;
  why: string;
  evidence_keys: string[];
  parked: boolean;
  /**
   * Why this window cannot attribute the domain's direction to the program.
   *
   * A "worse" read with a confounder is still WORSE — the regression stays
   * visible and is never softened away — but it is no longer UNEXPLAINED, and
   * `unexplained_worse` is what triggers a revision. Machine register, third
   * person, one sentence per cause: these are evidence lines, not athlete voice.
   */
  confounders: string[];
}

export interface WholePersonTrajectory {
  window: { start: string; end: string; days: number };
  objective: "everything better";
  phase: {
    name: string | null;
    optimizes: string[];
    floors: string[];
    protects: WholePersonDomain[];
    parks: WholePersonDomain[];
  };
  domains: WholePersonDomainRead[];
  unexplained_worse: WholePersonDomain[];
  revision_needed: boolean;
  line: string;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function halves(values: Array<{ date: string; value: number }>): { first: number | null; last: number | null } {
  const ordered = [...values].sort((a, b) => a.date.localeCompare(b.date));
  if (ordered.length < 4) return { first: null, last: null };
  const half = Math.max(2, Math.floor(ordered.length / 2));
  return {
    first: average(ordered.slice(0, half).map((row) => row.value)),
    last: average(ordered.slice(-half).map((row) => row.value)),
  };
}

function compare(
  first: number | null,
  last: number | null,
  tolerance: number,
  lowerIsBetter = false
): WholePersonVerdict {
  if (first == null || last == null) return "unknown";
  const delta = last - first;
  if (Math.abs(delta) <= tolerance) return "holding";
  const improving = lowerIsBetter ? delta < 0 : delta > 0;
  return improving ? "better" : "worse";
}

// ---------- why a regression might not be the program's fault ----------
//
// The evaluators have had this discipline all along: `contextEventConfounders`
// (src/domain/brain/evaluation-service.ts) refuses a decisive verdict from a
// window a trip, an injury or an illness ran through. This read did not, so a
// strength slide with a perfectly good explanation reached the scheduler as an
// `unexplained_worse` and opened a case conference about it.
//
// The rules below MIRROR that module rather than importing it: this is `repo/`
// and that is `domain/`, and reaching upward from here would close a cycle
// through half the layer. evaluation-service.ts stays the source of truth for the
// horizon semantics; if these drift apart, that one is right.
const DISRUPTIVE_CONTEXT = /\b(trip|travel|injur|ill|sick|stress|medicat|supplement|surgery|hospital|bereave|grief)\b/i;
const OPEN_ENDED_CONTEXT_HORIZON_DAYS = 14;
const OPEN_ENDED_CONTEXT_HORIZON_MAX_DAYS = 120;

// A body shedding weight this fast is in a real energy deficit, and an est-1RM
// sliding under one is the expected cost of the cut rather than a program that
// stopped working. MEASURED, never intended: a "lose" goal alone would confound
// every cutting athlete's every regression forever, which is the same permanent
// silence the open-ended context event once caused.
const UNDERFUEL_LB_PER_WEEK = 1.0;
const UNDERFUEL_MIN_WEIGH_INS = 4;
// …or logged intake that actually came in under the accepted target, on enough
// readable days to mean something. Ten days is the shortest span that is more
// than one hard week.
const UNDERFUEL_INTAKE_FRACTION = 0.9;
const UNDERFUEL_MIN_CREDIBLE_DAYS = 10;

function isoDay(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

function contextEventEffectiveEnd(row: {
  end_date?: unknown;
  resolved_at?: unknown;
  start_date?: unknown;
  expected_recovery_days?: unknown;
}): string | null {
  const explicit = isoDay(row.end_date) || isoDay(row.resolved_at);
  if (explicit) return explicit;
  const start = isoDay(row.start_date);
  if (!start) return null;
  const recovery = Number(row.expected_recovery_days);
  const horizon =
    Number.isFinite(recovery) && recovery > 0
      ? Math.min(OPEN_ENDED_CONTEXT_HORIZON_MAX_DAYS, Math.trunc(recovery))
      : OPEN_ENDED_CONTEXT_HORIZON_DAYS;
  return addDaysISO(start, horizon) ?? start;
}

function contextConfounders(start: string, end: string): string[] {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = db
      .prepare(
        `SELECT id, kind, title, detail, start_date, end_date, resolved_at, expected_recovery_days, meta_json
           FROM context_events
          WHERE COALESCE(archived, 0) = 0
            AND COALESCE(start_date, ?) <= ?
            AND COALESCE(end_date, ?) >= ?
          ORDER BY COALESCE(start_date, ''), id LIMIT 100`
      )
      .all(start, end, end, start) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const row of rows) {
    const effectiveEnd = contextEventEffectiveEnd(row);
    if (effectiveEnd == null || effectiveEnd < start) continue;
    const kind = String(row.kind ?? "");
    let meta = "";
    try {
      meta = row.meta_json ? String(row.meta_json) : "";
    } catch {
      meta = "";
    }
    const material =
      kind === "trip" || kind === "injury"
        ? true
        : DISRUPTIVE_CONTEXT.test(`${kind} ${String(row.title ?? "")} ${String(row.detail ?? "")} ${meta}`);
    if (!material) continue;
    const label = String(row.title ?? row.kind ?? "context event")
      .trim()
      .slice(0, 100);
    out.push(`Context event '${label}' overlapped this window.`);
  }
  return out;
}

/** The accepted calorie target in force at the end of the window, if any. */
function activeCalorieTarget(end: string): number | null {
  try {
    const row = db
      .prepare(
        `SELECT target_kcal FROM nutrition_targets
          WHERE effective_date <= ? AND target_kcal IS NOT NULL AND target_kcal > 0
          ORDER BY effective_date DESC, id DESC LIMIT 1`
      )
      .get(end) as { target_kcal: number } | undefined;
    const value = Number(row?.target_kcal);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function fuelingConfounders(start: string, end: string): string[] {
  const out: string[] = [];
  try {
    const weights = db
      .prepare(
        `SELECT date, weight_lb FROM bodyweight_log
          WHERE date BETWEEN ? AND ? AND weight_lb IS NOT NULL
          ORDER BY date, id LIMIT 500`
      )
      .all(start, end) as Array<{ date: string; weight_lb: number }>;
    const points = weights
      .map((row) => ({ date: isoDay(row.date), value: Number(row.weight_lb) }))
      .filter((point) => Number.isFinite(point.value) && point.value > 0);
    if (points.length >= UNDERFUEL_MIN_WEIGH_INS) {
      const perWeek = (lsqSlopePerDay(points) ?? 0) * 7;
      if (perWeek <= -UNDERFUEL_LB_PER_WEEK) {
        out.push(
          `Bodyweight fell about ${Math.abs(Math.round(perWeek * 10) / 10)} lb a week across this window, an energy deficit large enough to account for lost strength on its own.`
        );
      }
    }
  } catch {
    /* no weigh-in history is no fueling evidence, never a claim about one */
  }
  try {
    const target = activeCalorieTarget(end);
    if (target != null) {
      const intake = completedIntakeRange(start, end, end);
      const credible = intake.days.filter((day) => day.credible);
      if (credible.length >= UNDERFUEL_MIN_CREDIBLE_DAYS) {
        const average = credible.reduce((sum, day) => sum + day.kcal, 0) / credible.length;
        if (average < target * UNDERFUEL_INTAKE_FRACTION) {
          out.push(
            `Logged intake averaged ${Math.round(average)} kcal against an accepted target of ${Math.round(target)} across ${credible.length} readable days, so this window was underfuelled relative to what was planned.`
          );
        }
      }
    }
  } catch {
    /* an unreadable intake window is silence, not evidence */
  }
  return out;
}

/**
 * An open symptom that could account for the lifts that slid.
 *
 * Two scopes, two different questions. An AREA watch has to actually load one of
 * the regressing movements — that is what `painAreaLoadsExercise` is for, and a
 * shoulder watch explains nothing about a squat. A SYSTEMIC watch names no place,
 * so it can never establish movement relevance (that law holds), but "everything
 * feels off" IS an explanation for a whole DOMAIN moving down, which is the
 * question being asked here. `sessions.joint_pain` is read alongside the
 * lifecycle table for the reason reaction-model states: that is where the athlete
 * actually writes it at session finish, and only some of those notes ever become
 * a lifecycle row.
 */
function symptomConfounders(
  start: string,
  end: string,
  regressing: Array<{ name: string; muscle_group: string | null }>
): string[] {
  const out: string[] = [];
  try {
    const events = db
      .prepare(
        `SELECT area_text, scope, last_reported_on FROM training_symptom_events
          WHERE status = 'active' AND onset_on <= ?
            AND (resolved_on IS NULL OR resolved_on > ?)
            AND last_reported_on >= ?
          ORDER BY last_reported_on DESC, id DESC LIMIT 50`
      )
      .all(end, start, start) as Array<{ area_text: string; scope: string | null; last_reported_on: string }>;
    for (const event of events) {
      if (String(event.scope ?? "area") === "systemic") {
        out.push(
          `An unresolved whole-body symptom ('${String(event.area_text).slice(0, 60)}') was open across this window.`
        );
        continue;
      }
      const hit = regressing.find((exercise) => painAreaLoadsExercise(String(event.area_text), exercise));
      if (hit) {
        out.push(
          `An unresolved ${String(event.area_text).slice(0, 60)} symptom, last spoken about on ${isoDay(event.last_reported_on)}, covers what ${hit.name} loads.`
        );
      }
    }
  } catch {
    /* no lifecycle table is no symptom evidence */
  }
  try {
    const notes = db
      .prepare(
        `SELECT date, joint_pain FROM sessions
          WHERE date BETWEEN ? AND ? AND joint_pain IS NOT NULL AND trim(joint_pain) <> ''
          ORDER BY date DESC, id DESC LIMIT 100`
      )
      .all(start, end) as Array<{ date: string; joint_pain: string }>;
    for (const note of notes) {
      const hit = regressing.find((exercise) => painAreaLoadsExercise(String(note.joint_pain), exercise));
      if (hit) {
        out.push(`Joint pain was logged on ${isoDay(note.date)} covering what ${hit.name} loads.`);
        break; // one is enough to explain the window; a list of them is noise
      }
    }
  } catch {
    /* same */
  }
  return out;
}

function strengthRegressionConfounders(
  start: string,
  end: string,
  regressing: Array<{ name: string; muscle_group: string | null }>
): string[] {
  return [
    ...new Set([
      ...contextConfounders(start, end),
      ...fuelingConfounders(start, end),
      ...symptomConfounders(start, end, regressing),
    ]),
  ];
}

function strengthRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.date, ls.exercise_id, e.name AS exercise, e.muscle_group AS muscle_group,
              ls.weight, ls.reps
       FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id
      WHERE s.date BETWEEN ? AND ? AND ls.weight > 0 AND ls.reps > 0
      ORDER BY s.date, ls.id LIMIT 3000`
    )
    .all(start, end) as any[];
  const trajectoryEligibility = new Map<number, boolean>();
  const comparableRows = rows.filter((row) => {
    const sessionId = Number(row.session_id);
    const cached = trajectoryEligibility.get(sessionId);
    if (cached != null) return cached;
    const eligible = recoverySessionDose(sessionId).classification !== "compliant";
    trajectoryEligibility.set(sessionId, eligible);
    return eligible;
  });
  const byLift = new Map<string, Map<string, number>>();
  const muscleGroups = new Map<string, string | null>();
  for (const row of comparableRows) {
    const estimate = Number(row.weight) * (1 + Number(row.reps) / 30);
    const key = `${row.exercise_id}|${row.exercise}`;
    const dates = byLift.get(key) ?? new Map<string, number>();
    dates.set(String(row.date), Math.max(dates.get(String(row.date)) ?? 0, estimate));
    byLift.set(key, dates);
    muscleGroups.set(key, row.muscle_group == null ? null : String(row.muscle_group));
  }
  const comparable = [...byLift.entries()]
    .map(([key, dates]) => {
      const points = [...dates.entries()].map(([date, value]) => ({ date, value }));
      if (points.length < 4) return null;
      const split = halves(points);
      const tolerance = Math.max(1.5, Math.abs(split.first ?? 0) * 0.01);
      return {
        exercise: key.split("|").slice(1).join("|"),
        muscle_group: muscleGroups.get(key) ?? null,
        verdict: compare(split.first, split.last, tolerance),
      };
    })
    .filter(
      (row): row is { exercise: string; muscle_group: string | null; verdict: WholePersonVerdict } =>
        row != null && row.verdict !== "unknown"
    );
  const improving = comparable.filter((row) => row.verdict === "better");
  const regressing = comparable.filter((row) => row.verdict === "worse");
  const verdict: WholePersonVerdict = !comparable.length
    ? "unknown"
    : regressing.length
      ? "worse"
      : improving.length
        ? "better"
        : "holding";
  const names = (items: typeof comparable) =>
    items
      .slice(0, 5)
      .map((row) => row.exercise)
      .join(", ");
  // Asked ONLY of a regression, and only about the lifts that actually slid. A
  // holding or improving picture has nothing to explain away, and running the
  // reads anyway would cost three table scans on every trajectory call.
  const confounders =
    verdict === "worse"
      ? strengthRegressionConfounders(
          start,
          end,
          regressing.map((row) => ({ name: row.exercise, muscle_group: row.muscle_group }))
        )
      : [];
  const regressionWhy = `${regressing.length} comparable lift${regressing.length === 1 ? " needs" : "s need"} rebuilding: ${names(regressing)}${improving.length ? `; ${improving.length} other lift${improving.length === 1 ? " is" : "s are"} still advancing: ${names(improving)}` : ""}. Regression stays visible even when the overall program is improving.`;
  return {
    domain: "strength",
    verdict,
    parked,
    confounders,
    why:
      verdict === "unknown"
        ? "Not enough comparable loaded exposures yet."
        : verdict === "better"
          ? `${improving.length} comparable lift${improving.length === 1 ? " is" : "s are"} advancing${improving.length ? `: ${names(improving)}` : ""}.`
          : verdict === "holding"
            ? "Comparable lift capacity held steady."
            : // The regression itself is never softened — only the claim that nobody
              // can say why. What the window already explains is appended to it.
              `${regressionWhy}${confounders.length ? ` This window already has an explanation on record: ${confounders.join(" ")}` : ""}`,
    evidence_keys: rows.length
      ? [
          `logged_sets:${start}..${end}:n=${rows.length}`,
          `strength_exposures_comparable:${comparableRows.length}`,
          `strength_lifts_comparable:${comparable.length}`,
        ]
      : [],
  };
}

function enduranceRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const rows = db
    .prepare(
      `SELECT date, COALESCE(distance_km, 0) AS distance_km, COALESCE(duration_min, 0) AS duration_min
       FROM activities WHERE date BETWEEN ? AND ? AND (distance_km > 0 OR duration_min > 0)
      ORDER BY date, id LIMIT 1000`
    )
    .all(start, end) as any[];
  const points = rows.map((row) => ({
    date: String(row.date),
    value: Number(row.distance_km) > 0 ? Number(row.distance_km) : Number(row.duration_min) / 10,
  }));
  const split = halves(points);
  const verdict = compare(split.first, split.last, 0.25);
  return {
    domain: "endurance",
    verdict,
    parked,
    // Only the strength read carries confounders today; the others declare the
    // field so the shape is uniform and a caller never has to null-check it.
    confounders: [],
    why:
      verdict === "unknown"
        ? "Not enough comparable endurance work yet."
        : verdict === "better"
          ? "Endurance capacity or completed volume moved up."
          : verdict === "holding"
            ? "Endurance work held its level."
            : "Endurance capacity or completed volume moved down.",
    evidence_keys: rows.length ? [`activities:${start}..${end}:n=${rows.length}`] : [],
  };
}

function bodyRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const profile = getProfile();
  const mode = effectiveGoalMode(profile);
  const weights = db
    .prepare(
      `SELECT date, weight_lb AS value FROM bodyweight_log WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 500`
    )
    .all(start, end) as any[];
  const split = halves(weights.map((row) => ({ date: String(row.date), value: Number(row.value) })));
  let verdict: WholePersonVerdict = "unknown";
  if (split.first != null && split.last != null) {
    const delta = split.last - split.first;
    verdict =
      mode === "lose"
        ? compare(split.first, split.last, 0.5, true)
        : mode === "gain"
          ? compare(split.first, split.last, 0.5)
          : Math.abs(delta) <= 2
            ? "holding"
            : "worse";
  }
  return {
    domain: "body_composition",
    verdict,
    parked,
    // Only the strength read carries confounders today; the others declare the
    // field so the shape is uniform and a caller never has to null-check it.
    confounders: [],
    why:
      verdict === "unknown"
        ? "Not enough body-composition trend data yet."
        : verdict === "better"
          ? `Weight moved in the ${mode} phase's intended direction.`
          : verdict === "holding"
            ? "Bodyweight stayed inside the phase's intended range."
            : `Bodyweight moved against the ${mode} phase's intended direction.`,
    evidence_keys: weights.length ? [`bodyweight_log:${start}..${end}:n=${weights.length}`] : [],
  };
}

function healthRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  let improving = 0;
  let worsening = 0;
  let comparable = 0;
  let pointCount = 0;
  const history = getMarkerHistory();
  for (const marker of history.markers) {
    const points = (Array.isArray(marker?.points) ? marker.points : [])
      .filter((point: any) => point?.date >= start && point?.date <= end && Number.isFinite(Number(point?.value)))
      .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
    if (points.length < 2) continue;
    const zone = matchOptimalZone(marker.name);
    if (!zone) continue;
    const firstDistance = optimalDistance(Number(points[0].value), zone);
    const lastDistance = optimalDistance(Number(points[points.length - 1].value), zone);
    const delta = lastDistance - firstDistance;
    comparable++;
    pointCount += points.length;
    if (delta < -0.02) improving++;
    else if (delta > 0.02) worsening++;
  }
  const verdict: WholePersonVerdict =
    worsening > improving ? "worse" : improving > worsening ? "better" : comparable > 0 ? "holding" : "unknown";
  return {
    domain: "metabolic_health",
    verdict,
    parked,
    // Only the strength read carries confounders today; the others declare the
    // field so the shape is uniform and a caller never has to null-check it.
    confounders: [],
    why:
      verdict === "unknown"
        ? "No comparable follow-up clinical window yet."
        : verdict === "better"
          ? "More tracked markers moved favorably than unfavorably."
          : verdict === "holding"
            ? "The available marker picture held without a clear directional change."
            : "More tracked markers moved unfavorably than favorably.",
    evidence_keys: comparable ? [`marker_history:${start}..${end}:markers=${comparable}:n=${pointCount}`] : [],
  };
}

function recoveryRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const rows = db
    .prepare(
      `SELECT date, sleep_min, resting_hr, hrv_ms FROM daily_metrics WHERE date BETWEEN ? AND ?
     UNION ALL SELECT date, sleep_min, resting_hr, hrv_ms FROM garmin_daily_metrics WHERE date BETWEEN ? AND ?
     ORDER BY date LIMIT 1000`
    )
    .all(start, end, start, end) as any[];
  const signals: Array<{ key: "sleep_min" | "hrv_ms" | "resting_hr"; tolerance: number; lower: boolean }> = [
    { key: "sleep_min", tolerance: 15, lower: false },
    { key: "hrv_ms", tolerance: 2, lower: false },
    { key: "resting_hr", tolerance: 1, lower: true },
  ];
  const reads = signals
    .map((signal) => {
      const points = rows
        .map((row) => ({ date: String(row.date), value: Number(row[signal.key]) }))
        .filter((point) => Number.isFinite(point.value));
      const split = halves(points);
      return compare(split.first, split.last, signal.tolerance, signal.lower);
    })
    .filter((read) => read !== "unknown");
  const better = reads.filter((read) => read === "better").length;
  const worse = reads.filter((read) => read === "worse").length;
  const verdict: WholePersonVerdict = !reads.length
    ? "unknown"
    : better > worse
      ? "better"
      : worse > better
        ? "worse"
        : "holding";
  return {
    domain: "recovery_wellbeing",
    verdict,
    parked,
    // Only the strength read carries confounders today; the others declare the
    // field so the shape is uniform and a caller never has to null-check it.
    confounders: [],
    why:
      verdict === "unknown"
        ? "Not enough comparable recovery nights yet."
        : verdict === "better"
          ? "Sleep, HRV, and resting-heart-rate direction improved together."
          : verdict === "holding"
            ? "Recovery signals held their level."
            : "Recovery signals weakened across the window.",
    evidence_keys: rows.length ? [`daily_metrics:${start}..${end}:n=${rows.length}`] : [],
  };
}

export function wholePersonTrajectory(opts: { end?: string; days?: number } = {}): WholePersonTrajectory {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.end || "")) ? String(opts.end) : localDateISO();
  const days = Math.max(28, Math.min(120, Math.trunc(Number(opts.days) || 56)));
  const start = addDaysISO(end, -(days - 1)) ?? end;
  const block = (() => {
    try {
      return getActiveBlock();
    } catch {
      return null;
    }
  })() as any;
  const race = (() => {
    try {
      return getEnduranceGoal(end);
    } catch {
      return null;
    }
  })() as any;
  const profile = getProfile();
  const mode = effectiveGoalMode(profile);
  const discipline = getPrimaryDiscipline();
  const intent = getTrainingIntent(profile);
  const parks: WholePersonDomain[] = [];
  const protects: WholePersonDomain[] = ["strength"];
  const floors = ["no avoidable strength regression", "no avoidable lean-mass loss"];
  const optimizes: string[] = [];
  if (intent.source === "explicit") {
    const label: Record<TrainingPriority, string> = {
      longevity: "longevity",
      muscle: "muscle development",
      leanness: "body composition",
      strength: "strength",
      endurance: "endurance",
    };
    optimizes.push(...intent.priorities.map((priority) => label[priority]));
  } else {
    // Exact legacy behavior for profiles that have not yet stated an ordered
    // hierarchy; the explicit path above is authoritative once present.
    if (discipline === "strength" || discipline === "hybrid") {
      optimizes.push("strength and muscle development");
    }
    if (race?.is_race) {
      optimizes.push("endurance");
    }
    if (mode === "lose") {
      optimizes.push("body composition");
    }
    if (mode === "gain") {
      if (!optimizes.includes("strength and muscle development")) optimizes.push("strength and muscle development");
      optimizes.push("lean mass development");
    }
    if (block?.phase) optimizes.push(String(block.phase));
  }
  const parked = (domain: WholePersonDomain) => parks.includes(domain);
  const domains = [
    strengthRead(start, end, parked("strength")),
    enduranceRead(start, end, parked("endurance")),
    bodyRead(start, end, parked("body_composition")),
    healthRead(start, end, parked("metabolic_health")),
    recoveryRead(start, end, parked("recovery_wellbeing")),
  ];
  // UNEXPLAINED is the operative word, and it now means what it says. A domain
  // that moved down inside a window already holding a trip, an injury, a real
  // energy deficit or an open symptom has an explanation on record — it is still
  // a regression, it is still visible in `domains`, and the revision trigger this
  // feeds (the scheduler's case conference) is no longer opened about it. The
  // evaluators have refused decisive verdicts from confounded windows all along;
  // this read was the one place a confounded window still demanded an answer.
  const worse = domains.filter((domain) => domain.verdict === "worse" && !domain.parked);
  const unexplainedWorse = worse.filter((domain) => !domain.confounders.length).map((domain) => domain.domain);
  const confoundedWorse = worse.filter((domain) => domain.confounders.length).map((domain) => domain.domain);
  const readable = (domains_: WholePersonDomain[]) => joinList(domains_.map((domain) => domain.replaceAll("_", " ")));
  const better = domains
    .filter((domain) => domain.verdict === "better")
    .map((domain) => domain.domain.replaceAll("_", " "));
  const confoundedClause = confoundedWorse.length
    ? ` ${readable(confoundedWorse)} moved down too, inside a window that already explains it.`
    : "";
  const line = unexplainedWorse.length
    ? `${better.length ? `${joinList(better)} improved; ` : ""}${readable(unexplainedWorse)} moved the wrong way, so the plan needs a revision.${confoundedClause}`
    : better.length
      ? `${joinList(better)} improved; the rest is holding or still too early to call.${confoundedClause}`
      : `The whole-person picture is holding or still too early to call; no unexplained regression is visible.${confoundedClause}`;
  return {
    window: { start, end, days },
    objective: "everything better",
    phase: { name: block?.phase ?? race?.phase ?? mode, optimizes: [...new Set(optimizes)], floors, protects, parks },
    domains,
    unexplained_worse: unexplainedWorse,
    revision_needed: unexplainedWorse.length > 0,
    line,
  };
}
