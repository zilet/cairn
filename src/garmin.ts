import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as repo from "./repo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const TOKEN_DIR = process.env.GARMIN_TOKEN_DIR || path.join(DATA_DIR, "garmin-token");

// How many recent activities to enrich with a per-activity HR-time-in-zone fetch
// (one extra network call each). Bounded so a 200-activity backfill doesn't fan
// out into hundreds of detail calls. Daily wellness still covers `days`.
const HR_ZONE_LIMIT = Math.max(0, Math.min(60, Number(process.env.GARMIN_HR_ZONE_LIMIT ?? 20)));

// How many recent strength activities to pull detected exercise sets for (one
// extra call each), bounded the same way.
const STRENGTH_LIMIT = Math.max(0, Math.min(60, Number(process.env.GARMIN_STRENGTH_LIMIT ?? 20)));

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - Math.max(0, days - 1) * 864e5).toISOString().slice(0, 10);
}

function asNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Read the first present numeric key from a list of candidates — Garmin's
// undocumented JSON uses slightly different field names across endpoints/devices.
function pickNum(obj: any, keys: string[]): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = asNum(obj[k]);
    if (v != null) return v;
  }
  return null;
}

function pickStr(obj: any, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

const secToMin = (s: any): number | null => {
  const n = asNum(s);
  return n == null ? null : Math.round((n / 60) * 10) / 10;
};
const round1 = (n: number | null): number | null => (n == null ? null : Math.round(n * 10) / 10);

function sourceType(a: any): string {
  return a?.activityType?.typeKey || a?.activityType?.typeId || a?.type || "other";
}

// Sport-appropriate cadence (run spm, bike rpm, swim spm) from whichever the
// activity recorded.
function avgCadence(a: any): number | null {
  return pickNum(a, [
    "averageRunningCadenceInStepsPerMinute",
    "averageBikingCadenceInRevPerMinute",
    "averageSwimCadenceInStrokesPerMinute",
  ]);
}
function maxCadence(a: any): number | null {
  return pickNum(a, [
    "maxRunningCadenceInStepsPerMinute",
    "maxBikingCadenceInRevPerMinute",
    "maxSwimCadenceInStrokesPerMinute",
  ]);
}

function activityToInput(a: any): repo.GarminActivityInput {
  const durationSec = asNum(a?.movingDuration) ?? asNum(a?.duration);
  const meters = asNum(a?.distance);
  return {
    external_id: String(a.activityId),
    date: (a.startTimeLocal || a.startTimeGMT || "").slice(0, 10),
    start_time: a.startTimeLocal || a.startTimeGMT || null,
    type: sourceType(a),
    name: a.activityName || null,
    duration_min: secToMin(durationSec),
    distance_km: meters == null ? null : Math.round((meters / 1000) * 100) / 100,
    calories: asNum(a.calories),
    avg_hr: asNum(a.averageHR),
    max_hr: asNum(a.maxHR),
    ascent_m: asNum(a.elevationGain),
    training_load: asNum(a.activityTrainingLoad),
    training_effect: asNum(a.aerobicTrainingEffect),
    // richer per-activity body-reaction signals (all best-effort / null-safe)
    moving_min: secToMin(a.movingDuration),
    elevation_loss_m: asNum(a.elevationLoss),
    aerobic_te: asNum(a.aerobicTrainingEffect),
    anaerobic_te: asNum(a.anaerobicTrainingEffect),
    te_label: pickStr(a, ["trainingEffectLabel"]),
    avg_cadence: avgCadence(a),
    max_cadence: maxCadence(a),
    avg_power: pickNum(a, ["avgPower", "averagePower"]),
    max_power: asNum(a.maxPower),
    norm_power: pickNum(a, ["normPower", "normalizedPower"]),
    avg_speed: asNum(a.averageSpeed),
    max_speed: asNum(a.maxSpeed),
    avg_temp: pickNum(a, ["averageTemperature", "avgTemperature"]),
    vo2max: pickNum(a, ["vO2MaxValue", "vo2MaxValue"]),
    raw: a,
  };
}

// Cheap configured-check for the scheduler: saved/env credentials OR previously
// exported token files. Never touches the network or the garmin-connect package.
export function isGarminConfigured(): boolean {
  if (repo.getGarminCredentials().configured) return true;
  return fs.existsSync(path.join(TOKEN_DIR, "oauth1_token.json"))
    && fs.existsSync(path.join(TOKEN_DIR, "oauth2_token.json"));
}

async function makeClient() {
  const mod = await import("garmin-connect");
  const GarminConnect = (mod as any).GarminConnect || (mod as any).default;
  const { username, password } = repo.getGarminCredentials();
  const client = new GarminConnect(username && password ? { username, password } : undefined);
  if (fs.existsSync(path.join(TOKEN_DIR, "oauth1_token.json")) && fs.existsSync(path.join(TOKEN_DIR, "oauth2_token.json"))) {
    client.loadTokenByFile(TOKEN_DIR);
    return client;
  }
  if (!username || !password) {
    throw new Error("GARMIN_USERNAME/GARMIN_PASSWORD or GARMIN_TOKEN_DIR tokens are required");
  }
  await client.login();
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  client.exportTokenToFile(TOKEN_DIR);
  return client;
}

// Hit any Garmin Connect endpoint via the package's generic client; never throw.
// The connector's internal endpoints are undocumented and device-dependent, so
// every caller treats a null as "not available on this account" and degrades.
async function rawGet(client: any, url: string): Promise<any> {
  try {
    return await client.get(url);
  } catch {
    return null;
  }
}

async function getDisplayName(client: any): Promise<string | null> {
  try {
    const profile = await client.getUserProfile();
    return pickStr(profile, ["displayName", "profileId"]);
  } catch {
    return null;
  }
}

// ---- per-day field assemblers (each folds one source into the metric) ----
// The folds run in priority order in syncDailyMetrics: foldSleep is the BASE
// layer (it sets each field plainly); later folds (foldDailySummary/foldHrv)
// override with `pickNum(...) ?? m.x` where the daily summary is the better
// source. So precedence lives in the LATER fold, not here.

function foldSleep(sleep: any, m: repo.GarminDailyMetricInput) {
  const d = sleep?.dailySleepDTO;
  if (!d && !sleep) return;
  if (d) {
    m.sleep_min = secToMin(d.sleepTimeSeconds);
    m.deep_sleep_min = secToMin(d.deepSleepSeconds);
    m.light_sleep_min = secToMin(d.lightSleepSeconds);
    m.rem_sleep_min = secToMin(d.remSleepSeconds);
    m.awake_min = secToMin(d.awakeSleepSeconds);
    m.nap_min = secToMin(d.napTimeSeconds);
    m.avg_sleep_stress = asNum(d.avgSleepStress);
    m.respiration_avg = asNum(d.averageRespirationValue);
    m.respiration_min = asNum(d.lowestRespirationValue);
    m.respiration_max = asNum(d.highestRespirationValue);
    m.sleep_score = asNum(d.sleepScores?.overall?.value ?? d.sleepScore);
  }
  // SleepData top-level recovery signals.
  m.hrv_ms = asNum(sleep?.avgOvernightHrv);
  m.hrv_status = pickStr(sleep, ["hrvStatus"]);
  m.resting_hr = asNum(sleep?.restingHeartRate);
  m.restless_count = asNum(sleep?.restlessMomentsCount);
  const bbChange = asNum(sleep?.bodyBatteryChange);
  if (bbChange != null && bbChange > 0) m.body_battery_charged = bbChange;
}

function foldDailySummary(s: any, m: repo.GarminDailyMetricInput) {
  if (!s) return;
  m.steps = m.steps ?? pickNum(s, ["totalSteps", "steps"]);
  m.distance_m = pickNum(s, ["totalDistanceMeters"]);
  m.floors_climbed = pickNum(s, ["floorsAscended"]);
  m.active_calories = pickNum(s, ["activeKilocalories", "activeCalories"]);
  m.total_calories = pickNum(s, ["totalKilocalories", "totalCalories"]);
  m.bmr_calories = pickNum(s, ["bmrKilocalories", "bmrCalories"]);
  m.resting_hr = pickNum(s, ["restingHeartRate"]) ?? m.resting_hr;
  m.max_hr = pickNum(s, ["maxHeartRate"]);
  m.min_hr = pickNum(s, ["minHeartRate"]);
  m.hr_7d_avg = pickNum(s, ["lastSevenDaysAvgRestingHeartRate"]);
  m.stress_avg = pickNum(s, ["averageStressLevel", "avgStressLevel"]);
  m.stress_max = pickNum(s, ["maxStressLevel"]);
  m.body_battery_charged = pickNum(s, ["bodyBatteryChargedValue"]) ?? m.body_battery_charged;
  m.body_battery_drained = pickNum(s, ["bodyBatteryDrainedValue"]);
  m.body_battery_max = pickNum(s, ["bodyBatteryHighestValue"]);
  m.body_battery_min = pickNum(s, ["bodyBatteryLowestValue"]);
  m.spo2_avg = pickNum(s, ["averageSpo2Value", "averageSpo2", "avgSpo2"]);
  m.spo2_min = pickNum(s, ["lowestSpo2Value", "lowestSpo2"]);
  m.respiration_avg = pickNum(s, ["avgWakingRespirationValue", "respiration"]) ?? m.respiration_avg;
  m.respiration_max = pickNum(s, ["highestRespirationValue"]) ?? m.respiration_max;
  m.respiration_min = pickNum(s, ["lowestRespirationValue"]) ?? m.respiration_min;
  m.intensity_min_moderate = pickNum(s, ["moderateIntensityMinutes"]);
  m.intensity_min_vigorous = pickNum(s, ["vigorousIntensityMinutes"]);
  // body battery avg is not reported directly; mid-point of the day's range.
  if (m.body_battery_avg == null && m.body_battery_min != null && m.body_battery_max != null) {
    m.body_battery_avg = round1((m.body_battery_min + m.body_battery_max) / 2);
  }
}

function foldWeight(weight: any, iso: string, m: repo.GarminDailyMetricInput) {
  const list = weight?.dateWeightList;
  if (!Array.isArray(list) || !list.length) return;
  // Prefer a sample on this exact date, else the latest in the window.
  const sample = list.find((w: any) => String(w?.calendarDate) === iso) || list[list.length - 1];
  if (!sample) return;
  const grams = asNum(sample.weight);
  m.weight_kg = grams == null ? null : round1(grams / 1000);
  m.body_fat_pct = asNum(sample.bodyFat);
  m.body_water_pct = asNum(sample.bodyWater);
  const muscleG = asNum(sample.muscleMass);
  m.muscle_mass_kg = muscleG == null ? null : round1(muscleG / 1000);
  const boneG = asNum(sample.boneMass);
  m.bone_mass_kg = boneG == null ? null : round1(boneG / 1000);
  m.bmi = asNum(sample.bmi);
  m.visceral_fat = asNum(sample.visceralFat);
}

function foldHrv(hrv: any, m: repo.GarminDailyMetricInput) {
  const sum = hrv?.hrvSummary;
  if (!sum) return;
  m.hrv_ms = pickNum(sum, ["lastNightAvg", "weeklyAvg"]) ?? m.hrv_ms;
  m.hrv_status = pickStr(sum, ["status"]) ?? m.hrv_status;
}

function foldReadiness(tr: any, m: repo.GarminDailyMetricInput) {
  const row = Array.isArray(tr) ? tr[0] : tr;
  if (!row) return;
  m.training_readiness = pickNum(row, ["score"]);
}

async function syncDailyMetrics(client: any, sourceId: number, days: number, displayName: string | null) {
  let synced = 0;
  const rows: { iso: string; metric: repo.GarminDailyMetricInput }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 864e5);
    const iso = date.toISOString().slice(0, 10);
    const metric: repo.GarminDailyMetricInput = { date: iso };

    try { metric.steps = asNum(await client.getSteps(date)); } catch {}

    try {
      const sleep = await client.getSleepData(date);
      if (sleep) { foldSleep(sleep, metric); metric.raw = { ...(metric.raw as any || {}), sleep }; }
    } catch {}

    // The daily user summary is the workhorse: stress, body battery dynamics,
    // SpO2, respiration, intensity minutes, calories, floors, HR extremes.
    if (displayName) {
      const summary = await rawGet(client, `/usersummary-service/usersummary/daily/${displayName}?calendarDate=${iso}`);
      if (summary) { foldDailySummary(summary, metric); metric.raw = { ...(metric.raw as any || {}), summary }; }
    }

    // HRV status + last-night average (richer than the sleep field alone).
    const hrv = await rawGet(client, `/hrv-service/hrv/${iso}`);
    if (hrv) { foldHrv(hrv, metric); metric.raw = { ...(metric.raw as any || {}), hrv }; }

    // Daily training readiness (0-100), device-dependent.
    const tr = await rawGet(client, `/metrics-service/metrics/trainingreadiness/${iso}`);
    if (tr) { foldReadiness(tr, metric); metric.raw = { ...(metric.raw as any || {}), trainingReadiness: tr }; }

    // Sleep skin-temperature deviation (Fenix/Venu/Epix-class only); best-effort.
    const skin = await rawGet(client, `/wellness-service/wellness/daily/skinTemperature/${iso}`);
    if (skin) {
      metric.skin_temp_dev_c = pickNum(skin, ["deviation", "avgDeviation", "sleepTemperatureDeviation"]);
    }

    try {
      const weight = await client.getDailyWeightData(date);
      if (weight) { foldWeight(weight, iso, metric); metric.raw = { ...(metric.raw as any || {}), weight }; }
    } catch {}

    if (Object.keys(metric).length > 1) rows.push({ iso, metric });
  }

  // Slow-moving fitness metrics (VO2max, fitness age, training status) — fetch
  // once for the most recent day and stamp it on that row, rather than per day.
  if (rows.length) {
    const latest = rows[rows.length - 1];
    const maxmet = await rawGet(client, `/metrics-service/metrics/maxmet/latest/${latest.iso}`);
    const mm = Array.isArray(maxmet) ? maxmet[0] : maxmet;
    if (mm) {
      latest.metric.vo2max = pickNum(mm?.generic, ["vo2MaxPreciseValue", "vo2MaxValue"]);
      latest.metric.vo2max_cycling = pickNum(mm?.cycling, ["vo2MaxPreciseValue", "vo2MaxValue"]);
      latest.metric.fitness_age = pickNum(mm?.generic, ["fitnessAge"]) ?? pickNum(mm, ["fitnessAge"]);
    }
    const status = await rawGet(client, `/metrics-service/metrics/trainingstatus/aggregated/${latest.iso}`);
    if (status) {
      const recent = status?.mostRecentTrainingStatus?.latestTrainingStatusData;
      const dev = recent && typeof recent === "object" ? Object.values(recent)[0] as any : null;
      latest.metric.training_status = pickStr(dev, ["trainingStatusFeedbackPhrase", "trainingStatus"]);
      latest.metric.acute_load = pickNum(dev, ["acuteTrainingLoad"]);
    }
  }

  for (const { metric } of rows) {
    repo.upsertGarminDailyMetric(metric, sourceId);
    synced++;
  }
  return synced;
}

// Per-activity HR time-in-zone breakdown (one call each, bounded by HR_ZONE_LIMIT).
async function fetchHrZones(client: any, activityId: string | number): Promise<any[] | null> {
  const data = await rawGet(client, `/activity-service/activity/${activityId}/hrTimeInZones`);
  if (!Array.isArray(data) || !data.length) return null;
  return data.map((z: any) => ({
    zone: asNum(z?.zoneNumber),
    secs: asNum(z?.secsInZone),
    low_hr: asNum(z?.zoneLowBoundary),
  })).filter((z) => z.zone != null);
}

// Detected strength exercise sets for one activity (one call each, bounded by
// STRENGTH_LIMIT). Garmin records each set as ACTIVE/REST with a detected
// exercise category (e.g. "BENCH_PRESS"), rep count, weight (grams) and duration.
// We keep only ACTIVE sets and normalize weight to kg. Null-safe / best-effort.
async function fetchExerciseSets(client: any, activityId: string | number): Promise<any[] | null> {
  const data = await rawGet(client, `/activity-service/activity/${activityId}/exerciseSets`);
  const raw = Array.isArray(data?.exerciseSets) ? data.exerciseSets : Array.isArray(data) ? data : null;
  if (!raw || !raw.length) return null;
  const sets = raw
    .filter((s: any) => String(s?.setType ?? "").toUpperCase() !== "REST")
    .map((s: any) => {
      const ex = Array.isArray(s?.exercises) ? s.exercises[0] : null;
      const grams = asNum(s?.weight);
      return {
        category: pickStr(ex, ["category"]),
        name: pickStr(ex, ["name"]),
        reps: asNum(s?.repetitionCount),
        weight_kg: grams == null ? null : round1(grams / 1000),
        duration_sec: asNum(s?.duration),
        set_type: pickStr(s, ["setType"]),
      };
    })
    .filter((s: any) => s.category || s.name || s.reps != null || s.duration_sec != null);
  return sets.length ? sets : null;
}

export async function syncGarmin(options: { days?: number; limit?: number; daily?: boolean } = {}) {
  const days = Math.max(1, Math.min(180, options.days ?? Number(process.env.GARMIN_SYNC_DAYS ?? 30)));
  const limit = Math.max(1, Math.min(200, options.limit ?? Number(process.env.GARMIN_SYNC_LIMIT ?? 100)));
  const source = repo.upsertGarminSource({
    label: process.env.GARMIN_SOURCE_LABEL || "default",
    mode: "unofficial",
    auth_status: "not_configured",
  }) as any;
  try {
    const client = await makeClient();
    repo.upsertGarminSource({ label: source.label, mode: "unofficial", auth_status: "connected" });
    const since = isoDaysAgo(days);
    const rows = await client.getActivities(0, limit);
    let activities = 0;
    let zoneFetches = 0;
    let strengthFetches = 0;
    const strengthIds: number[] = [];
    for (const row of rows || []) {
      const input = activityToInput(row);
      if (input.date && input.date < since) continue;
      const strength = repo.isStrengthGarminType(sourceType(row));
      // Enrich the most recent activities with HR-time-in-zone (bounded calls).
      if (zoneFetches < HR_ZONE_LIMIT) {
        const zones = await fetchHrZones(client, input.external_id);
        if (zones) input.hr_zones = zones;
        zoneFetches++;
      }
      // Pull detected exercise sets for recent strength activities (bounded calls).
      if (strength && strengthFetches < STRENGTH_LIMIT) {
        const sets = await fetchExerciseSets(client, input.external_id);
        if (sets) input.exercise_sets = sets;
        strengthFetches++;
      }
      const saved = repo.upsertGarminActivity(input, source.id) as any;
      if (strength && saved?.id) strengthIds.push(saved.id);
      activities++;
    }

    // Reconcile each strength activity into the day's Cairn session: deterministic
    // physiology merge now (always), then queue the agentic narrative/extrapolation
    // layer on the serial enrichment queue (no-op when enrichment/agents are off).
    for (const id of strengthIds) {
      try { repo.reconcileGarminStrength(id); } catch (e: any) { console.warn(`[garmin] reconcile #${id} failed: ${e?.message ?? e}`); }
    }
    if (strengthIds.length) {
      import("./enrich.js")
        .then((m) => { for (const id of strengthIds) m.enqueueEnrich("garmin_strength", id); })
        .catch(() => {});
    }
    const displayName = options.daily === false ? null : await getDisplayName(client);
    const daily = options.daily === false ? 0 : await syncDailyMetrics(client, source.id, Math.min(days, 14), displayName);
    repo.upsertGarminSource({ label: source.label, mode: "unofficial", auth_status: "connected", last_sync_at: new Date().toISOString() });
    repo.setGarminSyncStatus(`ok: ${activities} activit${activities === 1 ? "y" : "ies"} · ${daily} daily`);
    return { ok: true, source_id: source.id, days, activities, daily_metrics: daily };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    repo.upsertGarminSource({ label: source.label, mode: "unofficial", auth_status: "failed" });
    repo.setGarminSyncStatus(`failed: ${msg}`);
    return { ok: false, source_id: source.id, error: msg };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const daysArg = process.argv.find((x) => x.startsWith("--days="))?.split("=")[1];
  const limitArg = process.argv.find((x) => x.startsWith("--limit="))?.split("=")[1];
  syncGarmin({
    days: daysArg ? Number(daysArg) : undefined,
    limit: limitArg ? Number(limitArg) : undefined,
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  });
}
