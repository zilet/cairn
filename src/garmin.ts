import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emitBrainEvent } from "./brainEvents.js";
import * as repo from "./repo.js";
import { localDateISO } from "./repo/shared.js";

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

export function garminSkinTempEnabled(value = process.env.GARMIN_SKIN_TEMP_ENABLED): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

const SKIN_TEMP_ENABLED = garminSkinTempEnabled();

function isoDaysAgo(days: number): string {
  return localDateISO(new Date(Date.now() - Math.max(0, days - 1) * 864e5));
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

// Garmin signals "no data" with a NEGATIVE SENTINEL rather than by omitting the
// key or sending null — `averageStressLevel: -1` is the one that shows up daily,
// and -2 appears on some firmware. Every metric guarded by these helpers is
// physically non-negative (a stress level, a body-battery reading, an SpO2
// percentage, a step count, a calorie burn), so a negative reading is ABSENCE and
// must be stored as null. Left raw, -1 lands in the averages as a real low value.
function asNonNegNum(v: any): number | null {
  const n = asNum(v);
  return n == null || n < 0 ? null : n;
}

function pickNonNegNum(obj: any, keys: string[]): number | null {
  const n = pickNum(obj, keys);
  return n == null || n < 0 ? null : n;
}

// Garmin computes the daily-summary `restingHeartRate` from the LOWEST heart rate
// it observed over the calendar day. That is only a resting figure when the watch
// was actually worn through a rest window — overnight, normally. Worn during
// waking hours only, the "resting" HR is just the day's quietest desk minute and
// lands at 90–120 against a true 52–60 baseline, which then poisons every
// recent-vs-baseline delta built on it.
//
// So the sleep-derived value (foldSleep, measured across actual sleep) always
// wins, and a summary-derived one is credible only when the day shows genuine
// rest coverage: a minimum HR low enough that the athlete was demonstrably at
// rest at some point, and a value inside a physiologically plausible band.
// Anything else stays null — wearable data is an optional input, and its absence
// must read as absence, never as a caution.
const RHR_REST_COVERAGE_MAX_HR = 65; // day's min HR at/below this ⇒ a real rest window was captured
const RHR_PLAUSIBLE_MIN = 30;
const RHR_PLAUSIBLE_MAX = 90;

export function credibleSummaryRestingHr(restingHr: number | null, minHr: number | null): number | null {
  if (restingHr == null) return null;
  if (restingHr < RHR_PLAUSIBLE_MIN || restingHr > RHR_PLAUSIBLE_MAX) return null;
  // The witness is held to the same plausibility bar as the value it vouches for.
  // A `-1` no-data sentinel or a 0 from a dropped HR trace satisfies "low enough to
  // prove a rest window" arithmetically while proving the opposite — the watch saw
  // nothing — and that is exactly the day whose summary "resting" HR is junk.
  if (minHr == null || minHr < RHR_PLAUSIBLE_MIN || minHr > RHR_REST_COVERAGE_MAX_HR) return null;
  return restingHr;
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
  return String(k)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
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
  return [...node.path, obj.sport, obj.sportType, obj.activityType, obj.activityTypeKey, obj.type, obj.label, obj.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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
      "trainingBalanceFeedbackPhrase",
      "monthlyLoadBalanceFeedbackPhrase",
      "feedbackPhrase",
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
  const text = [activity?.aerobicTrainingEffectMessage, activity?.anaerobicTrainingEffectMessage]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
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
  return (
    fs.existsSync(path.join(TOKEN_DIR, "oauth1_token.json")) && fs.existsSync(path.join(TOKEN_DIR, "oauth2_token.json"))
  );
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
  const hasTokenFiles =
    fs.existsSync(path.join(TOKEN_DIR, "oauth1_token.json")) &&
    fs.existsSync(path.join(TOKEN_DIR, "oauth2_token.json"));
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

export function garminErrorStatus(e: any): number | null {
  const direct = [
    e?.status,
    e?.statusCode,
    e?.response?.status,
    e?.response?.statusCode,
    e?.cause?.status,
    e?.cause?.response?.status,
  ];
  for (const v of direct) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  const msg = String(e?.message ?? e ?? "");
  const m = msg.match(/\((\d{3})\)|\bstatus(?:Code)?\D{0,8}(\d{3})\b/i);
  const n = Number(m?.[1] ?? m?.[2]);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

function isOptionalUnavailableStatus(status: number | null): boolean {
  return status === 403 || status === 404 || status === 410;
}

type RawGetOptions = {
  optionalKey?: string;
  unavailable?: Set<string>;
  quietStatuses?: number[];
};

// Hit any Garmin Connect endpoint via the package's generic client; never throw.
// The connector's internal endpoints are undocumented and device-dependent, so
// every caller treats a null as "not available on this account" and degrades.
export async function rawGet(client: any, url: string, options: RawGetOptions = {}): Promise<any> {
  if (options.optionalKey && options.unavailable?.has(options.optionalKey)) return null;
  // The package's get() reaches axios with NO baseURL, so a RELATIVE service path
  // throws "Invalid URL" — the connectapi host must be prepended. This was the real
  // root cause behind the all-null rich fields (the instrumentation below exposed it
  // on the first live sync: every rawGet failed "Invalid URL"). Every internal service
  // endpoint lives under GC_API (https://connectapi.garmin.com), exactly how the
  // library's own methods build their absolute URLs (UrlClass.GC_API + "/<service>…").
  const full = absoluteGarminUrl(client, url);
  try {
    return await client.get(full);
  } catch (e: any) {
    const status = garminErrorStatus(e);
    if (options.optionalKey && options.unavailable && isOptionalUnavailableStatus(status)) {
      options.unavailable.add(options.optionalKey);
    }
    const quiet = status != null && (options.quietStatuses ?? []).includes(status);
    if (quiet) return null;
    // These endpoints are undocumented and device-dependent — a null is normal.
    // But the failures used to be INVISIBLE, which masked the displayName bug
    // (a null displayName silently skipped the whole daily-summary block) and
    // made wrong-vs-unavailable endpoints indistinguishable. Log + degrade.
    console.warn(`[garmin] GET ${full} failed: ${e?.message ?? e}`);
    return null;
  }
}

// Write-side twins of rawGet. Same URL discipline (the package's client reaches
// axios with NO baseURL, so the connectapi host has to be prepended by hand), and
// the same undocumented-endpoint reality — but these THROW rather than degrading to
// null. A read that comes back empty is a field the app can live without; a write
// that silently did nothing would leave Cairn believing Garmin holds sets it does
// not, so the caller has to see the failure.
function absoluteGarminUrl(client: any, url: string): string {
  const base = client?.url?.GC_API || "https://connectapi.garmin.com";
  return /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

export async function rawPost(client: any, url: string, body: unknown): Promise<any> {
  return client.post(absoluteGarminUrl(client, url), body);
}

export async function rawPut(client: any, url: string, body: unknown): Promise<any> {
  return client.put(absoluteGarminUrl(client, url), body);
}

export async function rawDelete(client: any, url: string): Promise<any> {
  const full = absoluteGarminUrl(client, url);
  // GarminConnect exposes get/post/put directly but not delete; its underlying
  // HttpClient does, and that is the same authenticated transport.
  if (typeof client?.client?.delete === "function") return client.client.delete(full);
  if (typeof client?.delete === "function") return client.delete(full);
  throw new Error("Garmin client exposes no DELETE transport");
}

// The authenticated client, shared with the write-back path (src/garminExport.ts) so
// there is exactly one place that resolves credentials and token files.
export { makeClient as makeGarminClient };

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
async function fetchActivityDetail(
  client: any,
  activityId: string | number
): Promise<{
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

export function foldSleep(sleep: any, m: repo.GarminDailyMetricInput) {
  const d = sleep?.dailySleepDTO;
  if (!d && !sleep) return;
  if (d) {
    m.sleep_min = secToMin(d.sleepTimeSeconds);
    m.deep_sleep_min = secToMin(d.deepSleepSeconds);
    m.light_sleep_min = secToMin(d.lightSleepSeconds);
    m.rem_sleep_min = secToMin(d.remSleepSeconds);
    m.awake_min = secToMin(d.awakeSleepSeconds);
    m.nap_min = secToMin(d.napTimeSeconds);
    m.avg_sleep_stress = asNonNegNum(d.avgSleepStress);
    m.respiration_avg = asNonNegNum(d.averageRespirationValue);
    m.respiration_min = asNonNegNum(d.lowestRespirationValue);
    m.respiration_max = asNonNegNum(d.highestRespirationValue);
    m.sleep_score = asNonNegNum(d.sleepScores?.overall?.value ?? d.sleepScore);
  }
  // SleepData top-level recovery signals.
  m.hrv_ms = asNum(sleep?.avgOvernightHrv);
  m.hrv_status = pickStr(sleep, ["hrvStatus"]);
  m.resting_hr = asNum(sleep?.restingHeartRate);
  m.restless_count = asNonNegNum(sleep?.restlessMomentsCount);
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

export function foldDailySummary(s: any, m: repo.GarminDailyMetricInput) {
  if (!s) return;
  m.steps = m.steps ?? pickNonNegNum(s, ["totalSteps", "steps"]);
  m.distance_m = pickNonNegNum(s, ["totalDistanceMeters"]);
  m.floors_climbed = pickNonNegNum(s, ["floorsAscended"]);
  m.active_calories = pickNonNegNum(s, ["activeKilocalories", "activeCalories"]);
  m.total_calories = pickNonNegNum(s, ["totalKilocalories", "totalCalories"]);
  m.bmr_calories = pickNonNegNum(s, ["bmrKilocalories", "bmrCalories"]);
  m.max_hr = pickNonNegNum(s, ["maxHeartRate"]);
  m.min_hr = pickNonNegNum(s, ["minHeartRate"]);
  // Resting HR precedence: whatever foldSleep measured across actual sleep wins
  // outright. The summary value is only ever a FALLBACK, and only when the day's
  // HR trace proves a rest window was captured — see credibleSummaryRestingHr.
  // Ordered after min_hr because that guard reads it.
  m.resting_hr = m.resting_hr ?? credibleSummaryRestingHr(pickNum(s, ["restingHeartRate"]), m.min_hr);
  m.hr_7d_avg = pickNum(s, ["lastSevenDaysAvgRestingHeartRate"]);
  m.stress_avg = pickNonNegNum(s, ["averageStressLevel", "avgStressLevel"]);
  m.stress_max = pickNonNegNum(s, ["maxStressLevel"]);
  m.body_battery_charged = pickNonNegNum(s, ["bodyBatteryChargedValue"]) ?? m.body_battery_charged;
  m.body_battery_drained = pickNonNegNum(s, ["bodyBatteryDrainedValue"]);
  m.body_battery_max = pickNonNegNum(s, ["bodyBatteryHighestValue"]);
  m.body_battery_min = pickNonNegNum(s, ["bodyBatteryLowestValue"]);
  m.spo2_avg = pickNonNegNum(s, ["averageSpo2Value", "averageSpo2", "avgSpo2"]);
  m.spo2_min = pickNonNegNum(s, ["lowestSpo2Value", "lowestSpo2"]);
  m.respiration_avg = pickNonNegNum(s, ["avgWakingRespirationValue", "respiration"]) ?? m.respiration_avg;
  m.respiration_max = pickNonNegNum(s, ["highestRespirationValue"]) ?? m.respiration_max;
  m.respiration_min = pickNonNegNum(s, ["lowestRespirationValue"]) ?? m.respiration_min;
  m.intensity_min_moderate = pickNonNegNum(s, ["moderateIntensityMinutes"]);
  m.intensity_min_vigorous = pickNonNegNum(s, ["vigorousIntensityMinutes"]);
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
  m.training_readiness = pickNonNegNum(row, ["score"]);
}

async function syncDailyMetrics(client: any, sourceId: number, days: number, displayName: string | null) {
  let synced = 0;
  const unavailable = new Set<string>();
  const rows: { iso: string; metric: repo.GarminDailyMetricInput }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 864e5);
    const iso = localDateISO(date);
    const metric: repo.GarminDailyMetricInput = { date: iso };

    try {
      metric.steps = asNonNegNum(await client.getSteps(date));
    } catch {}

    try {
      const sleep = await client.getSleepData(date);
      if (sleep) {
        foldSleep(sleep, metric);
        metric.raw = { ...((metric.raw as any) || {}), sleep };
      }
    } catch {}

    // The daily user summary is the workhorse: stress, body battery dynamics,
    // SpO2, respiration, intensity minutes, calories, floors, HR extremes.
    if (displayName) {
      const summary = await rawGet(client, `/usersummary-service/usersummary/daily/${displayName}?calendarDate=${iso}`);
      if (summary) {
        foldDailySummary(summary, metric);
        metric.raw = { ...((metric.raw as any) || {}), summary };
      }
    }

    // HRV status + last-night average (richer than the sleep field alone).
    const hrv = await rawGet(client, `/hrv-service/hrv/${iso}`);
    if (hrv) {
      foldHrv(hrv, metric);
      metric.raw = { ...((metric.raw as any) || {}), hrv };
    }

    // Daily training readiness (0-100), device-dependent.
    const tr = await rawGet(client, `/metrics-service/metrics/trainingreadiness/${iso}`);
    if (tr) {
      foldReadiness(tr, metric);
      metric.raw = { ...((metric.raw as any) || {}), trainingReadiness: tr };
    }

    // Sleep skin-temperature deviation is optional and currently unverified for
    // this account. The Garmin client logs 404s internally before our catch can
    // quiet them, so keep this behind an explicit opt-in until the endpoint is
    // proven for a device that reports it.
    // If enabled, query a single day with startDate=endDate. Field shape varies
    // by device, so we search the tree for a deviation value (root-first, so a
    // daily avg wins over a per-sample one). This stays off until verified live.
    if (SKIN_TEMP_ENABLED) {
      const skin = await rawGet(
        client,
        `/wellness-service/wellness/daily/skinTemperature?startDate=${iso}&endDate=${iso}`,
        {
          optionalKey: "skin-temperature",
          unavailable,
          quietStatuses: [403, 404, 410],
        }
      );
      if (skin) {
        metric.skin_temp_dev_c = pickNumDeep(skin, [
          "avgDeviation",
          "deviation",
          "sleepTemperatureDeviation",
          "temperatureDeviation",
          "avgDeviationSleep",
        ]);
      }
    }

    // Richer sleep DTO — fills sleep_score / avg_sleep_stress / restless_count when
    // the package's getSleepData returned a reduced shape. Only when something's
    // actually missing, and only if we resolved a displayName.
    if (
      displayName &&
      (metric.sleep_score == null || metric.avg_sleep_stress == null || metric.restless_count == null)
    ) {
      const fullSleep = await rawGet(
        client,
        `/wellness-service/wellness/dailySleepData/${displayName}?date=${iso}&nonSleepBufferMinutes=60`
      );
      if (fullSleep) {
        foldSleepDetail(fullSleep, metric);
        metric.raw = { ...((metric.raw as any) || {}), fullSleep };
      }
    }

    try {
      const weight = await client.getDailyWeightData(date);
      if (weight) {
        foldWeight(weight, iso, metric);
        metric.raw = { ...((metric.raw as any) || {}), weight };
      }
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
        latest.metric.race_predict_half_sec = pickNumDeep(rp, [
          "timeHalfMarathon",
          "raceTimeHalfMarathon",
          "halfMarathon",
        ]);
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
    // A sync is one recovery boundary, not N per-row review candidates. The
    // caller compares the before/after current state and may emit one material
    // transition after the batch.
    repo.upsertGarminDailyMetric(metric, sourceId, { emitEvent: false });
    synced++;
  }
  return synced;
}

export function materialGarminRecoveryTransition(before: any, after: any): string | null {
  const b = before?.recovery ?? before ?? {};
  const a = after?.recovery ?? after ?? {};
  const bq = b?.quality?.training_readiness ?? before?.quality?.training_readiness;
  const aq = a?.quality?.training_readiness ?? after?.quality?.training_readiness;
  const br = asNum(b.training_readiness);
  const ar = asNum(a.training_readiness);
  const beforeFresh = bq?.freshness === "fresh";
  const afterFresh = aq?.freshness === "fresh";
  if (
    ar != null &&
    afterFresh &&
    ar < 35 &&
    (br == null || !beforeFresh)
  ) {
    return `fresh readiness is low (${Math.round(ar)})`;
  }
  if (br != null && ar != null && beforeFresh && afterFresh && (br < 35) !== (ar < 35)) {
    return ar < 35
      ? `fresh readiness crossed low (${Math.round(ar)})`
      : `fresh readiness recovered above low (${Math.round(ar)})`;
  }
  const bs = String(b.training_status ?? "").trim();
  const as = String(a.training_status ?? "").trim();
  // First sync should stay quiet for ordinary/benign states. These statuses are
  // the conservative subset that can reasonably change today's recovery bias.
  const materialFirstStatuses = ["DETRAINING", "OVERREACHING", "STRAINED", "UNPRODUCTIVE"];
  const canonicalStatus = as.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/_\d+$/, "");
  if (!bs && as && materialFirstStatuses.includes(canonicalStatus)) return `training status is ${as}`;
  if (bs && as && bs !== as) return `training status changed from ${bs} to ${as}`;
  return null;
}

export function emitMaterialGarminRecoveryTransition(
  before: any,
  after: any,
  sourceId: string | number,
  date = localDateISO()
): string | null {
  const reason = materialGarminRecoveryTransition(before, after);
  if (!reason) return null;
  emitBrainEvent({
    kind: "recovery_metrics_changed",
    domain: "recovery",
    date,
    entity_id: sourceId,
    subject_key: "garmin:material-recovery",
    reason,
    material: true,
  });
  return reason;
}

// Per-activity HR time-in-zone breakdown (one call each, bounded by HR_ZONE_LIMIT).
async function fetchHrZones(client: any, activityId: string | number): Promise<any[] | null> {
  const data = await rawGet(client, `/activity-service/activity/${activityId}/hrTimeInZones`);
  if (!Array.isArray(data) || !data.length) return null;
  return data
    .map((z: any) => ({
      zone: asNum(z?.zoneNumber),
      secs: asNum(z?.secsInZone),
      low_hr: asNum(z?.zoneLowBoundary),
    }))
    .filter((z) => z.zone != null);
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
    label: repo.garminSourceLabel(),
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
    // Runs landed by THIS sync — the calibration reader below looks only at them,
    // so a 200-activity backfill doesn't re-read the whole history every pass.
    const runIds: number[] = [];
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
      if (!strength && saved?.id && /run/i.test(String(saved.type ?? input.type ?? ""))) runIds.push(Number(saved.id));
      activities++;
    }

    // Reconcile each strength activity into the day's Cairn session: deterministic
    // physiology merge now (always), then queue the agentic narrative/extrapolation
    // layer on the serial enrichment queue (no-op when enrichment/agents are off).
    for (const id of strengthIds) {
      try {
        repo.reconcileGarminStrength(id);
      } catch (e: any) {
        console.warn(`[garmin] reconcile #${id} failed: ${e?.message ?? e}`);
      }
    }
    // Finished Cairn sessions whose work Garmin may not have yet. Cap the lookback
    // at 7 days so enabling the (default-on) toggle does not silently backfill a
    // month of history into the athlete's Garmin calendar. finishSession still
    // exports the session just finished, regardless of age.
    const exportSince = isoDaysAgo(Math.min(7, days));
    const exportIds = repo.getSettings().garmin_export_strength ? repo.sessionsEligibleForGarminExport(exportSince) : [];
    if (strengthIds.length || exportIds.length) {
      import("./enrich.js")
        .then((m) => {
          for (const id of strengthIds) m.enqueueEnrich("garmin_strength", id);
          // After the strength reconcile above, so a session that just linked a watch
          // activity is exported against its new target rather than the old one.
          for (const id of exportIds) m.enqueueEnrich("garmin_export", id);
        })
        .catch(() => {});
    }
    const beforeRecovery = options.daily === false ? null : repo.getGarminCoachSummary(Math.min(days, 14));
    const displayName = options.daily === false ? null : await getDisplayName(client, rows || []);
    const daily =
      options.daily === false ? 0 : await syncDailyMetrics(client, source.id, Math.min(days, 14), displayName);
    if (options.daily !== false) {
      const afterRecovery = repo.getGarminCoachSummary(Math.min(days, 14));
      emitMaterialGarminRecoveryTransition(beforeRecovery, afterRecovery, source.id);
    }
    repo.upsertGarminSource({
      label: source.label,
      mode: "unofficial",
      auth_status: "connected",
      last_sync_at: new Date().toISOString(),
    });
    repo.setGarminSyncStatus(`ok: ${activities} activit${activities === 1 ? "y" : "ies"} · ${daily} daily`);
    // A synced run is where a calibration test physically HAPPENED, so read the
    // freshly landed runs for a test signature (a 30-min threshold effort, a
    // fixed-HR benchmark) before re-deriving the personal HR model — a detected
    // time trial anchors the very threshold the derive is about to compute.
    // Detection is idempotent per activity, so a re-sync stacks nothing, and both
    // steps are deterministic: no agent, no push, nothing the athlete must answer.
    try {
      for (const id of runIds) {
        try {
          repo.detectRunCalibration(id);
        } catch {
          /* a detection is additive — it must never fail a sync */
        }
      }
      repo.deriveHrModel(localDateISO());
    } catch (e: any) {
      console.warn(`[garmin] HR-model refresh skipped: ${e?.message ?? e}`);
    }
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
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((e) => {
      console.error(e?.message ?? e);
      process.exitCode = 1;
    });
}
