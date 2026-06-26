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

// How many recent activities to enrich with the per-activity detail call (one
// extra call each) for training load + running dynamics (ground contact, vertical
// oscillation/ratio). Bounded like the others.
const DETAIL_LIMIT = Math.max(0, Math.min(60, Number(process.env.GARMIN_DETAIL_LIMIT ?? 20)));

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

function normKey(k: string): string {
  return String(k).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function objectNodes(root: any, path: string[] = [], depth = 0): { obj: any; path: string[] }[] {
  if (!root || typeof root !== "object" || depth > 5) return [];
  const here = !Array.isArray(root) ? [{ obj: root, path }] : [];
  const kids = Object.entries(root).flatMap(([k, v]) => objectNodes(v, [...path, k], depth + 1));
  return [...here, ...kids];
}

// Like pickNum but searches the whole object TREE (root-first) for the first node
// carrying one of the candidate keys. Garmin's undocumented metric payloads wrap the
// score we want at varying depths (e.g. endurance/hill score sometimes nest under a
// DTO; training load lives under acuteTrainingLoadDTO) — a flat top-level pickNum
// misses those. Root is visited before its children, so a top-level summary value
// still wins over a nested per-sample one. Best-effort / null-safe.
function pickNumDeep(root: any, keys: string[]): number | null {
  for (const node of objectNodes(root)) {
    const v = pickNum(node.obj, keys);
    if (v != null) return v;
  }
  return null;
}

function contextText(node: { obj: any; path: string[] }): string {
  const obj = node.obj ?? {};
  return [
    ...node.path,
    obj.sport,
    obj.sportType,
    obj.activityType,
    obj.activityTypeKey,
    obj.type,
    obj.label,
    obj.name,
  ].filter(Boolean).join(" ").toLowerCase();
}

function normalizeVo2Value(value: number, key: string): number | null {
  const k = normKey(key);
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  // Some Garmin maxmet payloads report METs instead of mL/kg/min.
  const vo2 = k.includes("maxmet") && v > 3 && v < 25 ? v * 3.5 : v;
  return vo2 >= 10 && vo2 <= 100 ? round1(vo2) : null;
}

function vo2FromObject(obj: any, mode: "generic" | "cycling", trustedContainer = false): number | null {
  const hits: { score: number; value: number }[] = [];
  for (const [key, raw] of Object.entries(obj ?? {})) {
    const n = asNum(raw);
    if (n == null) continue;
    const k = normKey(key);
    const isCyclingKey = /cycl|bik/.test(k);
    const hasVo2Key = k.includes("vo2") && k.includes("max");
    const hasMaxMetKey = k.includes("maxmet");
    const isValueKey = trustedContainer && (k === "value" || k === "precisevalue");
    if (mode === "generic" && isCyclingKey) continue;
    if (mode === "cycling" && !isCyclingKey && !trustedContainer) continue;
    if (!hasVo2Key && !hasMaxMetKey && !isValueKey) continue;
    const value = normalizeVo2Value(n, key);
    if (value == null) continue;
    const precise = k.includes("precise") ? 0 : 1;
    const modeFit = mode === "cycling" ? (isCyclingKey ? 0 : 2) : /generic|run|walk/.test(k) ? 0 : 1;
    const shape = hasVo2Key ? 0 : hasMaxMetKey ? 2 : 4;
    hits.push({ score: precise + modeFit + shape, value });
  }
  hits.sort((a, b) => a.score - b.score);
  return hits[0]?.value ?? null;
}

function fitnessAgeFromObject(obj: any): number | null {
  for (const [key, raw] of Object.entries(obj ?? {})) {
    if (!normKey(key).includes("fitnessage")) continue;
    const n = asNum(raw);
    if (n != null && n >= 10 && n <= 100) return Math.round(n);
  }
  return null;
}

// The /metrics-service/metrics/trainingstatus/aggregated/{date} payload is a
// COMPOSITE — it carries the latest training status AND the monthly training-load
// balance in one response. (There is no standalone /trainingloadbalance endpoint;
// reaching for `/metrics/trainingloadbalance/latest/{name}` 404s — the data only
// ever ships inside this aggregate.) Both sit under a device-id-keyed map, so we
// take the first device's row. Pure + null-safe so it can be unit-tested offline.
export function extractTrainingStatus(status: any): {
  training_status: string | null;
  acute_load: number | null;
  training_load_balance: string | null;
} {
  const recent = status?.mostRecentTrainingStatus?.latestTrainingStatusData;
  const statusDev = recent && typeof recent === "object" ? (Object.values(recent)[0] as any) : null;
  const lbMap = status?.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap;
  const lbDev = lbMap && typeof lbMap === "object" ? (Object.values(lbMap)[0] as any) : null;
  return {
    training_status: pickStr(statusDev, ["trainingStatusFeedbackPhrase", "trainingStatus"]),
    // acuteTrainingLoad nests under acuteTrainingLoadDTO on most devices — search deep.
    acute_load: pickNumDeep(statusDev, ["acuteTrainingLoad", "dailyTrainingLoadAcute"]),
    training_load_balance: pickStr(lbDev, [
      "trainingBalanceFeedbackPhrase", "monthlyLoadBalanceFeedbackPhrase", "feedbackPhrase",
    ]),
  };
}

export function extractGarminActivityVo2(activity: any): number | null {
  return vo2FromObject(activity, "generic");
}

export function extractGarminFitnessMetrics(maxmet: any): {
  vo2max: number | null;
  vo2max_cycling: number | null;
  fitness_age: number | null;
} {
  const nodes = objectNodes(maxmet);
  const genericNodes = nodes.filter((node) => !/cycl|bik/.test(contextText(node)));
  const cyclingNodes = nodes.filter((node) => /cycl|bik/.test(contextText(node)));
  const namedGeneric = genericNodes.filter((node) => /generic|run|running|walk/.test(contextText(node)));

  const firstVo2 = (list: { obj: any; path: string[] }[], mode: "generic" | "cycling") => {
    for (const node of list) {
      const v = vo2FromObject(node.obj, mode, /generic|run|running|walk|cycl|bik|maxmet/.test(contextText(node)));
      if (v != null) return v;
    }
    return null;
  };

  const vo2max = firstVo2(namedGeneric, "generic") ?? firstVo2(genericNodes, "generic");
  const vo2max_cycling = firstVo2(cyclingNodes, "cycling");
  let fitness_age: number | null = null;
  for (const node of [...namedGeneric, ...genericNodes, ...nodes]) {
    fitness_age = fitnessAgeFromObject(node.obj);
    if (fitness_age != null) break;
  }
  return { vo2max, vo2max_cycling, fitness_age };
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

export function extractGarminActivityHrZones(activity: any): any[] | null {
  const zones = [1, 2, 3, 4, 5]
    .map((zone) => ({ zone, secs: asNum(activity?.[`hrTimeInZone_${zone}`]), low_hr: null }))
    .filter((z) => z.secs != null && z.secs > 0);
  return zones.length ? zones : null;
}

export function extractGarminActivityTeLabel(activity: any): string | null {
  const explicit = pickStr(activity, ["trainingEffectLabel", "trainingEffect"]);
  if (explicit) return explicit.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const text = [
    activity?.aerobicTrainingEffectMessage,
    activity?.anaerobicTrainingEffectMessage,
  ].filter(Boolean).join(" ").toUpperCase();
  if (!text) return null;
  if (text.includes("VO2_MAX") || text.includes("VO2MAX")) return "VO2MAX";
  if (text.includes("LACTATE_THRESHOLD") || text.includes("THRESHOLD")) return "LACTATE_THRESHOLD";
  if (text.includes("ANAEROBIC") && !text.includes("NO_ANAEROBIC")) return "ANAEROBIC";
  if (text.includes("TEMPO")) return "TEMPO";
  if (text.includes("AEROBIC_BASE")) return "AEROBIC_BASE";
  if (text.includes("AEROBIC_FITNESS")) return "AEROBIC_FITNESS";
  if (text.includes("RECOVERY")) return "RECOVERY";
  return null;
}

export function extractGarminActivityTemp(activity: any): number | null {
  const direct = pickNum(activity, ["averageTemperature", "avgTemperature"]);
  if (direct != null) return direct;
  const lo = pickNum(activity, ["minTemperature"]);
  const hi = pickNum(activity, ["maxTemperature"]);
  return lo != null && hi != null ? round1((lo + hi) / 2) : null;
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
    te_label: extractGarminActivityTeLabel(a),
    avg_cadence: avgCadence(a),
    max_cadence: maxCadence(a),
    avg_power: pickNum(a, ["avgPower", "averagePower"]),
    max_power: asNum(a.maxPower),
    norm_power: pickNum(a, ["normPower", "normalizedPower"]),
    avg_speed: asNum(a.averageSpeed),
    max_speed: asNum(a.maxSpeed),
    avg_temp: extractGarminActivityTemp(a),
    vo2max: extractGarminActivityVo2(a),
    hr_zones: extractGarminActivityHrZones(a),
    // list-payload richness (present but previously uncaptured). Running dynamics
    // (ground contact, vertical oscillation/ratio) come from the detail call in
    // syncGarmin — they aren't in the list payload.
    steps: asNum(a.steps),
    avg_stride_len: pickNum(a, ["avgStrideLength", "averageStrideLength"]),
    min_elevation_m: pickNum(a, ["minElevation"]),
    max_elevation_m: pickNum(a, ["maxElevation"]),
    lap_count: pickNum(a, ["lapCount"]),
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

export function garminClientCredentials(username: string, password: string, hasTokenFiles: boolean) {
  if (username && password) return { username, password };
  // garmin-connect requires a credentials object even when OAuth tokens are
  // loaded immediately afterward; these placeholders are never sent to Garmin.
  if (hasTokenFiles) return { username: "token", password: "token" };
  return null;
}

async function makeClient() {
  const mod = await import("garmin-connect");
  const GarminConnect = (mod as any).GarminConnect || (mod as any).default;
  const { username, password } = repo.getGarminCredentials();
  const hasTokenFiles = fs.existsSync(path.join(TOKEN_DIR, "oauth1_token.json"))
    && fs.existsSync(path.join(TOKEN_DIR, "oauth2_token.json"));
  const credentials = garminClientCredentials(username, password, hasTokenFiles);
  if (!credentials) {
    throw new Error("GARMIN_USERNAME/GARMIN_PASSWORD or GARMIN_TOKEN_DIR tokens are required");
  }
  const client = new GarminConnect(credentials);
  if (hasTokenFiles) {
    client.loadTokenByFile(TOKEN_DIR);
    return client;
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
  // The package's get() reaches axios with NO baseURL, so a RELATIVE service path
  // throws "Invalid URL" — the connectapi host must be prepended. This was the real
  // root cause behind the all-null rich fields (the instrumentation below exposed it
  // on the first live sync: every rawGet failed "Invalid URL"). Every internal service
  // endpoint lives under GC_API (https://connectapi.garmin.com), exactly how the
  // library's own methods build their absolute URLs (UrlClass.GC_API + "/<service>…").
  const base = client?.url?.GC_API || "https://connectapi.garmin.com";
  const full = /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`;
  try {
    return await client.get(full);
  } catch (e: any) {
    // These endpoints are undocumented and device-dependent — a null is normal.
    // But the failures used to be INVISIBLE, which masked the displayName bug
    // (a null displayName silently skipped the whole daily-summary block) and
    // made wrong-vs-unavailable endpoints indistinguishable. Log + degrade.
    console.warn(`[garmin] GET ${full} failed: ${e?.message ?? e}`);
    return null;
  }
}

// The displayName the /usersummary + several /metrics endpoints key on is the
// account's GUID-style profile id. When the package's getUserProfile() returned
// null (it throws on some accounts), the ENTIRE daily-summary fetch was skipped —
// losing stress, body battery, calories, HR extremes, SpO2, respiration, intensity
// minutes, floors, distance. Fall back hard so a single null never blanks the day.
async function getDisplayName(client: any, activities: any[] = []): Promise<string | null> {
  // 1. The package's profile call — the canonical GUID displayName.
  try {
    const profile = await client.getUserProfile();
    const name = pickStr(profile, ["displayName", "profileId"]);
    if (name) return name;
  } catch (e: any) {
    console.warn(`[garmin] getUserProfile failed: ${e?.message ?? e}`);
  }
  // 2. The social-profile endpoint carries the same GUID-style displayName.
  const social = await rawGet(client, "/userprofile-service/socialProfile");
  const socialName = pickStr(social, ["displayName", "profileId"]);
  if (socialName) return socialName;
  // 3. Last resort: the activity payloads carry ownerDisplayName / ownerId. Not
  //    always the GUID the usersummary endpoint wants, but far better than skipping
  //    the whole block — and rawGet now logs if the resulting URL 404s.
  for (const a of activities) {
    const name = pickStr(a, ["ownerDisplayName", "ownerId", "ownerProfilePk"]);
    if (name) return name;
  }
  return null;
}

// Per-activity detail (one bounded call each): the list payload omits the training
// load and running dynamics. /activity-service/activity/{id} carries both in
// summaryDTO. Best-effort / null-safe like every other endpoint.
async function fetchActivityDetail(client: any, activityId: string | number): Promise<{
  training_load: number | null;
  avg_ground_contact_ms: number | null;
  avg_vertical_osc_cm: number | null;
  avg_vertical_ratio: number | null;
} | null> {
  const data = await rawGet(client, `/activity-service/activity/${activityId}`);
  const s = data?.summaryDTO ?? data ?? null;
  if (!s) return null;
  return {
    training_load: pickNum(s, ["activityTrainingLoad", "trainingLoad"]),
    avg_ground_contact_ms: pickNum(s, ["avgGroundContactTime", "averageGroundContactTime"]),
    avg_vertical_osc_cm: pickNum(s, ["avgVerticalOscillation", "averageVerticalOscillation"]),
    avg_vertical_ratio: pickNum(s, ["avgVerticalRatio", "averageVerticalRatio"]),
  };
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

// The package's getSleepData returns a REDUCED DTO on some accounts/devices, so
// sleep_score / avg_sleep_stress / restless_count come back null. The richer
// wellness endpoint fills those gaps. This is a GAP-FILLER (only sets a field that's
// still null) — it must never null out a value foldSleep already captured.
function foldSleepDetail(sleep: any, m: repo.GarminDailyMetricInput) {
  const d = sleep?.dailySleepDTO ?? sleep;
  if (!d) return;
  m.sleep_score = m.sleep_score ?? asNum(d.sleepScores?.overall?.value ?? d.sleepScore ?? d.overallSleepScore);
  m.avg_sleep_stress = m.avg_sleep_stress ?? asNum(d.avgSleepStress);
  m.restless_count = m.restless_count ?? asNum(d.restlessMomentsCount ?? sleep?.restlessMomentsCount);
  m.sleep_min = m.sleep_min ?? secToMin(d.sleepTimeSeconds);
  m.deep_sleep_min = m.deep_sleep_min ?? secToMin(d.deepSleepSeconds);
  m.light_sleep_min = m.light_sleep_min ?? secToMin(d.lightSleepSeconds);
  m.rem_sleep_min = m.rem_sleep_min ?? secToMin(d.remSleepSeconds);
  m.awake_min = m.awake_min ?? secToMin(d.awakeSleepSeconds);
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
    // FIX: the old path appended the date as a SEGMENT (`…/skinTemperature/${iso}`)
    // and 404'd on every sync. The wellness skin-temp endpoint takes startDate/endDate
    // QUERY params (same convention as python-garminconnect's get_skin_temp_data) — a
    // single day is start==end. Field shape varies by device, so we search the tree
    // for a deviation value (root-first, so a daily avg wins over a per-sample one).
    // NOTE: the exact deviation field name still wants live verification on a watch
    // that reports it; the path + param shape follow the documented convention.
    const skin = await rawGet(
      client,
      `/wellness-service/wellness/daily/skinTemperature?startDate=${iso}&endDate=${iso}`,
    );
    if (skin) {
      metric.skin_temp_dev_c = pickNumDeep(skin, [
        "avgDeviation", "deviation", "sleepTemperatureDeviation", "temperatureDeviation", "avgDeviationSleep",
      ]);
    }

    // Richer sleep DTO — fills sleep_score / avg_sleep_stress / restless_count when
    // the package's getSleepData returned a reduced shape. Only when something's
    // actually missing, and only if we resolved a displayName.
    if (displayName && (metric.sleep_score == null || metric.avg_sleep_stress == null || metric.restless_count == null)) {
      const fullSleep = await rawGet(client, `/wellness-service/wellness/dailySleepData/${displayName}?date=${iso}&nonSleepBufferMinutes=60`);
      if (fullSleep) { foldSleepDetail(fullSleep, metric); metric.raw = { ...(metric.raw as any || {}), fullSleep }; }
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
    if (maxmet) {
      const fit = extractGarminFitnessMetrics(maxmet);
      latest.metric.vo2max = fit.vo2max;
      latest.metric.vo2max_cycling = fit.vo2max_cycling;
      latest.metric.fitness_age = fit.fitness_age; // maxmet rarely carries this — overridden below
    }
    // Fitness age has its OWN endpoint; the maxmet payload only carries VO2max, so
    // the old maxmet read returned null almost always. Prefer the dedicated source.
    const fa = await rawGet(client, `/fitnessage-service/fitnessage/${latest.iso}`);
    if (fa) {
      const v = pickNum(fa, ["biologicalAge", "fitnessAge", "achievableFitnessAge"]);
      if (v != null && v >= 10 && v <= 100) latest.metric.fitness_age = Math.round(v);
    }
    // Training status + monthly training-LOAD-BALANCE come from ONE aggregate. The
    // old code made a SECOND call to `/metrics/trainingloadbalance/latest/{name}` for
    // the balance phrase, which 404'd every sync — that endpoint doesn't exist; the
    // balance ships inside this same trainingstatus aggregate (see extractTrainingStatus).
    const status = await rawGet(client, `/metrics-service/metrics/trainingstatus/aggregated/${latest.iso}`);
    if (status) {
      const ts = extractTrainingStatus(status);
      latest.metric.training_status = ts.training_status;
      latest.metric.acute_load = ts.acute_load;
      latest.metric.training_load_balance = ts.training_load_balance;
    }

    // Runner performance signals (half-marathon prep). Race predictions key on the
    // displayName; endurance/hill score key on the account via a calendarDate query.
    // All best-effort — rawGet logs a wrong-path/unavailable endpoint, every field
    // degrades to null.
    if (displayName) {
      // `/racepredictions/latest/{displayName}` returns a single latest object (or, on
      // some accounts, a one-element list). Field names match python-garminconnect.
      const racePred = await rawGet(client, `/metrics-service/metrics/racepredictions/latest/${displayName}`);
      if (racePred) {
        const rp = Array.isArray(racePred) ? racePred[racePred.length - 1] : racePred;
        latest.metric.race_predict_5k_sec = pickNumDeep(rp, ["time5K", "raceTime5K", "fiveK"]);
        latest.metric.race_predict_10k_sec = pickNumDeep(rp, ["time10K", "raceTime10K", "tenK"]);
        latest.metric.race_predict_half_sec = pickNumDeep(rp, ["timeHalfMarathon", "raceTimeHalfMarathon", "halfMarathon"]);
        latest.metric.race_predict_marathon_sec = pickNumDeep(rp, ["timeMarathon", "raceTimeMarathon", "marathon"]);
      }
    }
    // FIX: endurance & hill score require a `calendarDate` QUERY param (same shape as
    // python-garminconnect's get_endurance_score / get_hill_score single-day form).
    // The old paramless calls returned nothing. Scores can nest under a DTO, so search
    // the tree (overallScore is the headline value, ahead of any sub-component).
    const endur = await rawGet(client, `/metrics-service/metrics/endurancescore?calendarDate=${latest.iso}`);
    if (endur) latest.metric.endurance_score = pickNumDeep(endur, ["overallScore", "enduranceScore", "score", "avg"]);
    const hill = await rawGet(client, `/metrics-service/metrics/hillscore?calendarDate=${latest.iso}`);
    if (hill) latest.metric.hill_score = pickNumDeep(hill, ["overallScore", "hillScore", "score", "strengthScore"]);
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
    let detailFetches = 0;
    const strengthIds: number[] = [];
    for (const row of rows || []) {
      const input = activityToInput(row);
      if (input.date && input.date < since) continue;
      const strength = repo.isStrengthGarminType(sourceType(row));
      // Per-activity detail (bounded): training load + running dynamics. The list
      // payload omits both; activityTrainingLoad lives in the detail's summaryDTO.
      if (detailFetches < DETAIL_LIMIT) {
        const detail = await fetchActivityDetail(client, input.external_id);
        if (detail) {
          if (detail.training_load != null) input.training_load = detail.training_load;
          input.avg_ground_contact_ms = detail.avg_ground_contact_ms;
          input.avg_vertical_osc_cm = detail.avg_vertical_osc_cm;
          input.avg_vertical_ratio = detail.avg_vertical_ratio;
        }
        detailFetches++;
      }
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
    const displayName = options.daily === false ? null : await getDisplayName(client, rows || []);
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
