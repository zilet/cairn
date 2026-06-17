import { db, todayISO } from "../db.js";
import { invalidateDayRead } from "./intelligence.js";
import { getOrCreateSession, getSessionDetail, sessionSummary, setsForSession } from "./sessions.js";
import { getSettings } from "./settings.js";

// ---------- activities ----------
export function parseActivity(text: string) {
  const t = text.toLowerCase();
  let type = "other";
  if (/\b(mtb|mountain ?bike|ride|rode|riding|cycl|bike|biked|biking|gravel)\b/.test(t)) type = "ride";
  else if (/\b(run|ran|running|jog|jogged|jogging|tempo|intervals?|park ?run|5k|10k)\b/.test(t)) type = "run";
  else if (/\bswim|swam|swimming\b/.test(t)) type = "swim";
  else if (/\b(hike|hiked|hiking|walk|walked|fell ?run|fells)\b/.test(t)) type = "hike";
  // a /km pace strongly implies a run if nothing else matched
  if (type === "other" && /\d+:\d{2}\s*(?:\/|per)\s*km/.test(t)) type = "run";

  let duration_min: number | null = null;
  const h = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)/);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  if (h) duration_min = parseFloat(h[1]) * 60;
  if (m) duration_min = (duration_min || 0) + parseFloat(m[1]);
  const hm = t.match(/\b(\d+):(\d{2})\b(?!\s*\/)/); // 1:30 as h:mm when no /km after
  if (!duration_min && hm) duration_min = parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);

  let distance_km: number | null = null;
  const km = t.match(/(\d+(?:\.\d+)?)\s*(?:km|k\b)/);
  const mi = t.match(/(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/); // \b so "min" isn't read as miles
  if (km) distance_km = parseFloat(km[1]);
  else if (mi) distance_km = +(parseFloat(mi[1]) * 1.60934).toFixed(2);

  let pace: string | null = null;
  const pc = t.match(/(\d+:\d{2})\s*(?:\/|per)\s*km/);
  if (pc) pace = `${pc[1]}/km`;

  return { type, duration_min, distance_km, pace };
}

export function addActivity(input: any) {
  const date = input.date || todayISO();
  const source = input.source ? String(input.source).trim() : null;
  const externalId = input.external_id ? String(input.external_id).trim() : null;
  if (source && externalId) {
    const existing = db.prepare(`SELECT * FROM activities WHERE source = ? AND external_id = ?`).get(source, externalId) as any;
    if (existing) return existing;
  }
  let { type, duration_min, distance_km, pace } = input;
  const fromText = !!(input.text && String(input.text).trim());
  if (fromText && (!type || duration_min == null)) {
    const p = parseActivity(input.text);
    type = type || p.type;
    duration_min = duration_min ?? p.duration_min;
    distance_km = distance_km ?? p.distance_km;
    pace = pace ?? p.pace;
  }
  // Free-text entries get queued for background agentic enrichment — but only if
  // it's enabled, so a disabled install records 'skipped' directly (no pending
  // churn, no wasted queue round-trip) rather than briefly showing 'pending'.
  const status = input.enrichment_status !== undefined
    ? input.enrichment_status
    : fromText && !source ? (getSettings().enrich_enabled ? "pending" : "skipped") : null;
  const info = db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, pace, rpe, notes, source, external_id, enrichment_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(date, type || "other", input.text || null, duration_min ?? null, distance_km ?? null, pace ?? null, input.rpe ?? null, input.notes ?? null, source, externalId, status);
  const row = db.prepare(`SELECT * FROM activities WHERE id = ?`).get(info.lastInsertRowid) as any;
  // Kick the enrichment queue AFTER the row exists. enrich.ts imports repo.ts,
  // so we import lazily here to avoid a module-eval circular dependency.
  if (status === "pending") {
    import("../enrich.js").then((m) => m.enqueueEnrich("activity", row.id)).catch(() => {});
  }
  invalidateDayRead(date); // a logged activity (run/walk/class) is movement — today's Brief should reflect it
  return row;
}

export function listActivities(limit = 20) {
  return db.prepare(`SELECT * FROM activities ORDER BY date DESC, id DESC LIMIT ?`).all(limit);
}

// ---------- Today: the unified "Lately" feed ----------
// One timeline of what the athlete actually DID — finished strength `sessions`
// and cardio/free-text `activities` merged, newest-first, normalized to a single
// row shape the PWA renders with one renderer. The old Today "RECENT" strip read
// only `activities`, so it was structurally blind to lifting (a different table);
// this surfaces both. Garmin cardio is enriched from its linked `garmin_activities`
// row — the real start time plus the body-reaction blob (HR zones, temperature,
// effort/TE, VO2) — so a synced run gets the same physiology treatment a strength
// session already gets. A calm, deterministic one-liner (`note`) rides along only
// when there's something real to say (the watch's effort label / the reconciled
// "body's reaction" summary); null is the common, quiet case.
export type FeedRow = {
  kind: "strength" | "activity";
  id: number;            // source row id (session id / activity id)
  date: string;          // YYYY-MM-DD — for day grouping + relative labels
  at: string | null;     // ISO w/ clock time ONLY when real (session.finished_at / garmin start_time)
  title: string;         // "Push day" | "run"
  stats: string;         // "12 sets · 4,200 lb" | "47 min · 6.48 km · 7:15/km"
  note: string | null;   // calm deterministic line, null = nothing worth saying
  source: string | null; // "garmin" | activities.source | null
  meta: Record<string, any>;     // kind-specific raw bits for the renderer
  detail: Record<string, any> | null; // body-reaction blob (HR zones, temp, effort, VO2) or null
};

// Any non-null value? Used to drop an all-empty detail blob to null.
function _hasAny(o: Record<string, any>): boolean {
  return Object.values(o).some((v) => v != null);
}

// A Garmin effort label ("TEMPO" / "AEROBIC_BASE" / "VO2MAX") → a calm note, else
// fall back to the dominant HR zone. Deterministic; no agent on this path.
function _cardioNote(d: Record<string, any> | null): string | null {
  if (!d) return null;
  if (d.te_label) return `${String(d.te_label).replace(/_/g, " ").toLowerCase()} effort`;
  const zones = Array.isArray(d.hr_zones) ? d.hr_zones : [];
  if (zones.length) {
    const dom = zones.reduce((a: any, b: any) => ((b?.secs || 0) > (a?.secs || 0) ? b : a), zones[0]);
    const z = Number(dom?.zone) || 0;
    if (z <= 2) return "easy — mostly aerobic";
    if (z >= 4) return "hard effort";
    return "steady tempo";
  }
  return null;
}

export function recentTraining(limit = 6): FeedRow[] {
  const lim = Math.max(1, Math.min(50, limit));
  // Pull a generous window of EACH kind before merging, so a day with several
  // walks can't crowd the day's strength session off the combined slice.
  const pull = lim * 3;

  // --- finished strength sessions (the live/open session stays on Today, not here) ---
  const sessRows = db.prepare(
    `SELECT s.id, s.date, s.finished_at, s.garmin_json, pd.name AS day_name
     FROM sessions s
     LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
     WHERE s.finished_at IS NOT NULL
     ORDER BY s.date DESC, s.id DESC LIMIT ?`
  ).all(pull) as any[];

  const sessions: FeedRow[] = sessRows.map((s) => {
    const sum = sessionSummary(s.id);
    let g: any = null;
    try { g = s.garmin_json ? JSON.parse(s.garmin_json) : null; } catch { g = null; }
    const stats = [
      `${sum.sets} set${sum.sets === 1 ? "" : "s"}`,
      sum.tonnage > 0 ? `${sum.tonnage.toLocaleString()} lb` : null,
    ].filter(Boolean).join(" · ");
    const detail = g ? {
      duration_min: g.duration_min ?? null,
      avg_hr: g.avg_hr ?? null, max_hr: g.max_hr ?? null, calories: g.calories ?? null,
      training_effect: g.training_effect ?? null, aerobic_te: g.aerobic_te ?? null,
      anaerobic_te: g.anaerobic_te ?? null,
      hr_zones: Array.isArray(g.hr_zones) ? g.hr_zones : null,
    } : null;
    return {
      kind: "strength",
      id: s.id,
      date: s.date,
      at: s.finished_at ? String(s.finished_at).replace(" ", "T") + "Z" : null,
      title: s.day_name || "Session",
      stats,
      note: g && g.summary ? String(g.summary) : null,
      source: g ? "garmin" : null,
      meta: { sets: sum.sets, tonnage: sum.tonnage, exercises: sum.exercises },
      detail: detail && _hasAny(detail) ? detail : null,
    };
  });

  // --- cardio / free-text activities, enriched from the linked Garmin row ---
  const actRows = db.prepare(
    `SELECT a.id, a.date, a.type, a.raw_text, a.notes, a.duration_min, a.distance_km, a.pace, a.rpe, a.source,
            g.start_time AS g_start, g.moving_min AS g_moving, g.avg_hr AS g_avg_hr, g.max_hr AS g_max_hr,
            g.calories AS g_cal, g.training_effect AS g_te, g.aerobic_te AS g_aer, g.anaerobic_te AS g_anaer,
            g.te_label AS g_telabel, g.vo2max AS g_vo2, g.avg_temp AS g_temp, g.avg_cadence AS g_cad,
            g.avg_power AS g_pow, g.avg_speed AS g_spd, g.elevation_loss_m AS g_eloss, g.hr_zones_json AS g_zones
     FROM activities a
     LEFT JOIN garmin_activities g ON g.activity_id = a.id
     ORDER BY a.date DESC, a.id DESC LIMIT ?`
  ).all(pull) as any[];

  const activities: FeedRow[] = actRows.map((a) => {
    let hr_zones: any = null;
    try { hr_zones = a.g_zones ? JSON.parse(a.g_zones) : null; } catch { hr_zones = null; }
    const detailRaw = {
      moving_min: a.g_moving ?? null, avg_hr: a.g_avg_hr ?? null, max_hr: a.g_max_hr ?? null,
      calories: a.g_cal ?? null, training_effect: a.g_te ?? null, aerobic_te: a.g_aer ?? null,
      anaerobic_te: a.g_anaer ?? null, te_label: a.g_telabel ?? null, vo2max: a.g_vo2 ?? null,
      avg_temp: a.g_temp ?? null, avg_cadence: a.g_cad ?? null, avg_power: a.g_pow ?? null,
      avg_speed: a.g_spd ?? null, elevation_loss_m: a.g_eloss ?? null,
      hr_zones: Array.isArray(hr_zones) ? hr_zones : null,
    };
    const detail = _hasAny(detailRaw) ? detailRaw : null;
    const stats = [
      a.duration_min ? `${a.duration_min} min` : null,
      a.distance_km ? `${a.distance_km} km` : null,
      a.pace || null,
      a.rpe != null ? `RPE ${a.rpe}` : null,
    ].filter(Boolean).join(" · ");
    return {
      kind: "activity",
      id: a.id,
      date: a.date,
      at: a.g_start ? String(a.g_start) : null, // real activity start (Garmin); manual logs stay date-only
      title: a.type || a.raw_text || "activity",
      stats: stats || a.notes || "",
      note: _cardioNote(detail),
      source: a.g_start ? "garmin" : (a.source || null),
      meta: { duration_min: a.duration_min ?? null, distance_km: a.distance_km ?? null, pace: a.pace ?? null },
      detail,
    };
  });

  // Merge: date desc, then real timestamp desc (nulls last), then id desc.
  const merged = [...sessions, ...activities].sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? 1 : -1;
    const tx = x.at ? (Date.parse(x.at) || 0) : 0;
    const ty = y.at ? (Date.parse(y.at) || 0) : 0;
    if (tx !== ty) return ty - tx;
    return y.id - x.id;
  });
  return merged.slice(0, lim);
}

export function getActivity(id: number) {
  return db.prepare(`SELECT * FROM activities WHERE id = ?`).get(id) ?? null;
}

// Update only the structured fields the enricher provides; leave the rest intact.
export function updateActivityFields(id: number, fields: Record<string, any>) {
  const allowed = ["type", "duration_min", "distance_km", "pace", "rpe", "notes"];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getActivity(id);
  vals.push(id);
  db.prepare(`UPDATE activities SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getActivity(id);
}

export function setActivityEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE activities SET enrichment_status = ? WHERE id = ?`).run(status, id);
  return getActivity(id);
}

// ---------- Garmin source data ----------
export interface GarminSourceInput {
  mode?: "unofficial" | "official" | "manual";
  label?: string | null;
  auth_status?: string | null;
  token_json?: any;
  sync_cursor?: string | null;
  last_sync_at?: string | null;
}

export interface GarminActivityInput {
  external_id: string;
  date?: string;
  start_time?: string | null;
  type?: string | null;
  name?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  calories?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  ascent_m?: number | null;
  training_load?: number | null;
  training_effect?: number | null;
  moving_min?: number | null;
  elevation_loss_m?: number | null;
  aerobic_te?: number | null;
  anaerobic_te?: number | null;
  te_label?: string | null;
  avg_cadence?: number | null;
  max_cadence?: number | null;
  avg_power?: number | null;
  max_power?: number | null;
  norm_power?: number | null;
  avg_speed?: number | null;
  max_speed?: number | null;
  avg_temp?: number | null;
  vo2max?: number | null;
  hr_zones?: any;            // [{zone,secs,low_hr}] — serialized to hr_zones_json
  exercise_sets?: any;       // [{category,name,reps,weight_kg,duration_sec,set_type}] — serialized to exercise_sets_json
  raw?: any;
}

export interface GarminDailyMetricInput {
  date: string;
  steps?: number | null;
  sleep_min?: number | null;
  sleep_score?: number | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
  stress_avg?: number | null;
  body_battery_avg?: number | null;
  body_battery_min?: number | null;
  body_battery_max?: number | null;
  active_calories?: number | null;
  // full-body dataset
  deep_sleep_min?: number | null;
  light_sleep_min?: number | null;
  rem_sleep_min?: number | null;
  awake_min?: number | null;
  nap_min?: number | null;
  restless_count?: number | null;
  avg_sleep_stress?: number | null;
  hrv_status?: string | null;
  max_hr?: number | null;
  min_hr?: number | null;
  hr_7d_avg?: number | null;
  stress_max?: number | null;
  body_battery_charged?: number | null;
  body_battery_drained?: number | null;
  respiration_avg?: number | null;
  respiration_min?: number | null;
  respiration_max?: number | null;
  spo2_avg?: number | null;
  spo2_min?: number | null;
  skin_temp_dev_c?: number | null;
  total_calories?: number | null;
  bmr_calories?: number | null;
  floors_climbed?: number | null;
  intensity_min_moderate?: number | null;
  intensity_min_vigorous?: number | null;
  distance_m?: number | null;
  vo2max?: number | null;
  vo2max_cycling?: number | null;
  training_readiness?: number | null;
  training_status?: string | null;
  acute_load?: number | null;
  fitness_age?: number | null;
  weight_kg?: number | null;
  body_fat_pct?: number | null;
  muscle_mass_kg?: number | null;
  body_water_pct?: number | null;
  bone_mass_kg?: number | null;
  bmi?: number | null;
  visceral_fat?: number | null;
  raw?: any;
}

export function jsonOrNull(v: any): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function hydrateJson(row: any, key = "raw_json") {
  if (!row) return row;
  let raw: any = null;
  try { raw = row[key] ? JSON.parse(row[key]) : null; } catch { raw = null; }
  return { ...row, raw };
}

function cleanGarminMode(mode: any): "unofficial" | "official" | "manual" {
  return ["unofficial", "official", "manual"].includes(mode) ? mode : "unofficial";
}

function normalizeGarminType(t: any): string {
  const s = String(t ?? "").toLowerCase();
  if (/\b(run|running|trail_running|treadmill)\b/.test(s)) return "run";
  if (/\b(cycl|bike|biking|mountain|mtb|gravel|road_biking)\b/.test(s)) return "ride";
  if (/\b(swim|swimming)\b/.test(s)) return "swim";
  if (/\b(walk|hike|hiking)\b/.test(s)) return "hike";
  if (/\b(strength|cardio|training|fitness_equipment)\b/.test(s)) return "other";
  return s || "other";
}

// Garmin strength-style activities (strength_training, functional_strength_training,
// indoor_cardio with weights, etc.) are modeled as Cairn *sessions*, not loose
// activities. Matches the raw provider type, not normalizeGarminType (which folds
// these into "other"). Lifting/weight phrasing also counts.
export function isStrengthGarminType(t: any): boolean {
  return /strength|weight|lifting/i.test(String(t ?? ""));
}

function paceFrom(durationMin?: number | null, distanceKm?: number | null, type?: string | null): string | null {
  if (!durationMin || !distanceKm || distanceKm <= 0 || normalizeGarminType(type) !== "run") return null;
  const secPerKm = Math.round((durationMin * 60) / distanceKm);
  const m = Math.floor(secPerKm / 60);
  const s = String(secPerKm % 60).padStart(2, "0");
  return `${m}:${s}/km`;
}

export function upsertGarminSource(input: GarminSourceInput = {}) {
  const label = (input.label ?? "default").toString().trim() || "default";
  const mode = cleanGarminMode(input.mode);
  const cur = db.prepare(`SELECT * FROM garmin_sources WHERE provider = 'garmin' AND label = ?`).get(label) as any;
  if (!cur) {
    const info = db.prepare(
      `INSERT INTO garmin_sources (provider, mode, label, auth_status, token_json, sync_cursor, last_sync_at)
       VALUES ('garmin', ?, ?, ?, ?, ?, ?)`
    ).run(mode, label, input.auth_status ?? "not_configured", jsonOrNull(input.token_json), input.sync_cursor ?? null, input.last_sync_at ?? null);
    return db.prepare(`SELECT * FROM garmin_sources WHERE id = ?`).get(info.lastInsertRowid);
  }
  db.prepare(
    `UPDATE garmin_sources SET mode = ?, auth_status = COALESCE(?, auth_status),
       token_json = COALESCE(?, token_json), sync_cursor = COALESCE(?, sync_cursor),
       last_sync_at = COALESCE(?, last_sync_at), updated_at = datetime('now')
     WHERE id = ?`
  ).run(mode, input.auth_status ?? null, jsonOrNull(input.token_json), input.sync_cursor ?? null, input.last_sync_at ?? null, cur.id);
  return db.prepare(`SELECT * FROM garmin_sources WHERE id = ?`).get(cur.id);
}

export function listGarminSources() {
  return db.prepare(`SELECT id, provider, mode, label, auth_status, sync_cursor, last_sync_at, created_at, updated_at FROM garmin_sources ORDER BY id`).all();
}

export function getGarminSource(id?: number | null) {
  if (id) return db.prepare(`SELECT * FROM garmin_sources WHERE id = ?`).get(id) ?? null;
  return db.prepare(`SELECT * FROM garmin_sources WHERE provider = 'garmin' ORDER BY id LIMIT 1`).get() ?? null;
}

export function upsertGarminActivity(input: GarminActivityInput, sourceId?: number | null) {
  if (!input.external_id || !String(input.external_id).trim()) throw new Error("external_id required");
  const source = sourceId ? getGarminSource(sourceId) : upsertGarminSource({ label: "default" });
  if (!source) throw new Error("Garmin source not found");
  const start = input.start_time ?? null;
  const date = input.date || (start ? String(start).slice(0, 10) : todayISO());
  const type = normalizeGarminType(input.type);
  const name = input.name || `Garmin ${type}`;
  // Strength activities become enriched Cairn *sessions* (see reconcileGarminStrength),
  // so they never get a generic `activities` row that would duplicate the workout in
  // Today's RECENT list. Cardio (run/walk/ride) still surfaces as an activity.
  const strength = isStrengthGarminType(input.type);
  const activity = strength ? null : (addActivity({
    date, type, duration_min: input.duration_min ?? null, distance_km: input.distance_km ?? null,
    pace: paceFrom(input.duration_min, input.distance_km, type), text: name,
    source: "garmin", external_id: String(input.external_id), enrichment_status: null,
    notes: [
      input.avg_hr ? `avg HR ${Math.round(input.avg_hr)}` : null,
      input.training_load ? `load ${Math.round(input.training_load)}` : null,
      input.training_effect ? `effect ${input.training_effect}` : null,
    ].filter(Boolean).join(" · ") || null,
  }) as any);
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, activity_id, date, start_time, type, name, duration_min, distance_km,
        calories, avg_hr, max_hr, ascent_m, training_load, training_effect,
        moving_min, elevation_loss_m, aerobic_te, anaerobic_te, te_label, avg_cadence, max_cadence,
        avg_power, max_power, norm_power, avg_speed, max_speed, avg_temp, vo2max, hr_zones_json,
        exercise_sets_json, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_id, external_id) DO UPDATE SET
       activity_id = COALESCE(excluded.activity_id, garmin_activities.activity_id),
       date = excluded.date, start_time = excluded.start_time, type = excluded.type, name = excluded.name,
       duration_min = excluded.duration_min, distance_km = excluded.distance_km, calories = excluded.calories,
       avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, ascent_m = excluded.ascent_m,
       training_load = excluded.training_load, training_effect = excluded.training_effect,
       moving_min = excluded.moving_min, elevation_loss_m = excluded.elevation_loss_m,
       aerobic_te = excluded.aerobic_te, anaerobic_te = excluded.anaerobic_te, te_label = excluded.te_label,
       avg_cadence = excluded.avg_cadence, max_cadence = excluded.max_cadence,
       avg_power = excluded.avg_power, max_power = excluded.max_power, norm_power = excluded.norm_power,
       avg_speed = excluded.avg_speed, max_speed = excluded.max_speed, avg_temp = excluded.avg_temp,
       vo2max = excluded.vo2max,
       hr_zones_json = COALESCE(excluded.hr_zones_json, garmin_activities.hr_zones_json),
       exercise_sets_json = COALESCE(excluded.exercise_sets_json, garmin_activities.exercise_sets_json),
       raw_json = excluded.raw_json, synced_at = datetime('now')`
  ).run(
    source.id, String(input.external_id), activity?.id ?? null, date, start, type, name,
    input.duration_min ?? null, input.distance_km ?? null, input.calories ?? null,
    input.avg_hr ?? null, input.max_hr ?? null, input.ascent_m ?? null,
    input.training_load ?? null, input.training_effect ?? null,
    input.moving_min ?? null, input.elevation_loss_m ?? null, input.aerobic_te ?? null,
    input.anaerobic_te ?? null, input.te_label ?? null, input.avg_cadence ?? null, input.max_cadence ?? null,
    input.avg_power ?? null, input.max_power ?? null, input.norm_power ?? null,
    input.avg_speed ?? null, input.max_speed ?? null, input.avg_temp ?? null, input.vo2max ?? null,
    jsonOrNull(input.hr_zones), jsonOrNull(input.exercise_sets), jsonOrNull(input.raw)
  );
  return hydrateJson(db.prepare(`SELECT * FROM garmin_activities WHERE source_id = ? AND external_id = ?`).get(source.id, String(input.external_id)));
}

// The normalized daily columns, in the order they bind. `date`/`source_id` are
// the conflict key (handled separately); `raw_json` is appended last. Built from
// a map so the ~40-column upsert stays readable and COALESCE-merges on conflict
// (a later partial sync never nulls a field an earlier richer one filled).
const GARMIN_DAILY_COLS = [
  "steps", "sleep_min", "sleep_score", "resting_hr", "hrv_ms", "stress_avg",
  "body_battery_avg", "body_battery_min", "body_battery_max", "active_calories",
  "deep_sleep_min", "light_sleep_min", "rem_sleep_min", "awake_min", "nap_min",
  "restless_count", "avg_sleep_stress", "hrv_status", "max_hr", "min_hr", "hr_7d_avg",
  "stress_max", "body_battery_charged", "body_battery_drained",
  "respiration_avg", "respiration_min", "respiration_max", "spo2_avg", "spo2_min",
  "skin_temp_dev_c", "total_calories", "bmr_calories", "floors_climbed",
  "intensity_min_moderate", "intensity_min_vigorous", "distance_m", "vo2max",
  "vo2max_cycling", "training_readiness", "training_status", "acute_load", "fitness_age",
  "weight_kg", "body_fat_pct", "muscle_mass_kg", "body_water_pct", "bone_mass_kg",
  "bmi", "visceral_fat",
] as const;

export function upsertGarminDailyMetric(input: GarminDailyMetricInput, sourceId?: number | null) {
  const source = sourceId ? getGarminSource(sourceId) : upsertGarminSource({ label: "default" });
  if (!source) throw new Error("Garmin source not found");
  const cols = ["source_id", "date", ...GARMIN_DAILY_COLS, "raw_json"];
  const placeholders = cols.map(() => "?").join(", ");
  // COALESCE(excluded, existing) so a sparse re-sync preserves richer prior values.
  const updates = [...GARMIN_DAILY_COLS, "raw_json"]
    .map((c) => `${c} = COALESCE(excluded.${c}, garmin_daily_metrics.${c})`)
    .join(", ");
  const values: any[] = [source.id, input.date];
  for (const c of GARMIN_DAILY_COLS) values.push((input as any)[c] ?? null);
  values.push(jsonOrNull(input.raw));
  db.prepare(
    `INSERT INTO garmin_daily_metrics (${cols.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT(source_id, date) DO UPDATE SET ${updates}, updated_at = datetime('now')`
  ).run(...values);
  invalidateDayRead(); // a Garmin sync brings fresh recovery → today's Brief recomputes
  return hydrateJson(db.prepare(`SELECT * FROM garmin_daily_metrics WHERE source_id = ? AND date = ?`).get(source.id, input.date));
}

// hydrateJson + parse the per-activity JSON arrays (hr_zones, exercise_sets) into
// clean fields, dropping the raw *_json strings.
function hydrateGarminActivity(r: any) {
  if (!r) return r;
  const out = hydrateJson(r) as any;
  for (const key of ["hr_zones_json", "exercise_sets_json"] as const) {
    const field = key.replace(/_json$/, "");
    let v: any = null;
    try { v = out[key] ? JSON.parse(out[key]) : null; } catch { v = null; }
    out[field] = v;
    delete out[key];
  }
  return out;
}

export function listGarminActivities(limit = 30) {
  return (db.prepare(`SELECT * FROM garmin_activities ORDER BY date DESC, id DESC LIMIT ?`).all(limit) as any[]).map((r) => hydrateGarminActivity(r));
}

export function getGarminActivity(id: number) {
  return hydrateGarminActivity(db.prepare(`SELECT * FROM garmin_activities WHERE id = ?`).get(id));
}

// Strength-style Garmin activities for a single date or a recent window (used by
// the reconcile endpoint / MCP tool). Filtered by raw provider type.
export function listStrengthGarminActivities(opts: { date?: string; days?: number } = {}): any[] {
  if (opts.date) {
    return (db.prepare(`SELECT * FROM garmin_activities WHERE date = ? ORDER BY id`).all(opts.date) as any[])
      .filter((r) => isStrengthGarminType(r.type));
  }
  const days = Math.max(1, Math.min(365, opts.days ?? 30));
  const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  return (db.prepare(`SELECT * FROM garmin_activities WHERE date >= ? ORDER BY date DESC, id DESC`).all(since) as any[])
    .filter((r) => isStrengthGarminType(r.type));
}

// Synced Garmin *strength* activities that haven't been linked to a Cairn session
// yet (`session_id` null) — the watch logged a lift Cairn doesn't know about. Drives
// the calm "reconcile?" Today card; reconciling clears the list (the row gets a
// session_id). Newest-first, hydrated like listGarminActivities. Always [] when
// Garmin isn't configured (no rows).
export function listUnreconciledGarminStrength(days = 30): any[] {
  const d = Math.max(1, Math.min(365, days));
  const since = new Date(Date.now() - (d - 1) * 864e5).toISOString().slice(0, 10);
  return (db.prepare(`SELECT * FROM garmin_activities WHERE date >= ? AND session_id IS NULL ORDER BY date DESC, id DESC`).all(since) as any[])
    .filter((r) => isStrengthGarminType(r.type))
    .map((r) => hydrateGarminActivity(r));
}

// Deterministic merge of a Garmin strength activity into the day's Cairn session:
// attach the physiology layer (HR/zones/calories/TE) to sessions.garmin_json, link
// garmin_activities.session_id, and drop any stale duplicate generic activity row.
// Runs during sync regardless of agent availability; the agentic layer (enrich.ts)
// adds the narrative summary + extrapolated exercises on top. Returns null if the
// row isn't a strength activity. Idempotent (safe to re-run on every sync).
export function reconcileGarminStrength(garminActivityId: number) {
  const row = db.prepare(`SELECT * FROM garmin_activities WHERE id = ?`).get(garminActivityId) as any;
  if (!row || !isStrengthGarminType(row.type)) return null;
  const date = row.date || todayISO();

  // Clean up any stale generic activity row this Garmin activity created before we
  // started modeling strength as a session (so it stops duplicating in RECENT).
  if (row.external_id) {
    db.prepare(`DELETE FROM activities WHERE source = 'garmin' AND external_id = ?`).run(String(row.external_id));
  }

  const session = getOrCreateSession(date) as any;

  let hr_zones: any = null;
  try { hr_zones = row.hr_zones_json ? JSON.parse(row.hr_zones_json) : null; } catch { hr_zones = null; }
  const durationMin = row.duration_min ?? row.moving_min ?? null;

  // A day with two strength activities keeps the longer one as the session's
  // primary blob, but always refreshes the link. When re-reconciling the SAME
  // activity, preserve any narrative/extrapolation a prior agentic pass wrote.
  let existing: any = null;
  try { existing = session.garmin_json ? JSON.parse(session.garmin_json) : null; } catch { existing = null; }
  const sameActivity = existing && existing.external_id === row.external_id;
  const isPrimary = !existing || sameActivity || (durationMin ?? 0) >= (existing.duration_min ?? -1);

  if (isPrimary) {
    const blob = {
      external_id: row.external_id ?? null,
      type: row.type ?? "strength_training",
      name: row.name ?? null,
      duration_min: durationMin,
      avg_hr: row.avg_hr ?? null,
      max_hr: row.max_hr ?? null,
      calories: row.calories ?? null,
      training_effect: row.training_effect ?? null,
      aerobic_te: row.aerobic_te ?? null,
      anaerobic_te: row.anaerobic_te ?? null,
      hr_zones,
      summary: sameActivity ? existing.summary ?? null : null,
      intensity: sameActivity ? existing.intensity ?? null : null,
      extrapolated: sameActivity ? !!existing.extrapolated : false,
      reconciled_at: new Date().toISOString(),
      agent: sameActivity ? existing.agent ?? null : null,
    };
    db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(blob), session.id);
  }
  db.prepare(`UPDATE garmin_activities SET session_id = ? WHERE id = ?`).run(session.id, garminActivityId);
  invalidateDayRead(date);

  let exercise_sets: any = null;
  try { exercise_sets = row.exercise_sets_json ? JSON.parse(row.exercise_sets_json) : null; } catch { exercise_sets = null; }
  const sets = setsForSession(session.id) as any[];
  return { session: getSessionDetail(session.id), has_manual_sets: sets.length > 0, exercise_sets, is_primary: isPrimary };
}

// Merge the agentic narrative (summary / intensity / extrapolated flag / agent)
// into a session's existing Garmin blob. Used by enrich.ts after the agent runs.
export function updateSessionGarminNarrative(
  sessionId: number,
  patch: { summary?: string | null; intensity?: string | null; extrapolated?: boolean; agent?: string | null }
) {
  const s = db.prepare(`SELECT garmin_json FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) return null;
  let blob: any = {};
  try { blob = s.garmin_json ? JSON.parse(s.garmin_json) : {}; } catch { blob = {}; }
  if (patch.summary !== undefined) blob.summary = patch.summary;
  if (patch.intensity !== undefined) blob.intensity = patch.intensity;
  if (patch.extrapolated !== undefined) blob.extrapolated = !!patch.extrapolated;
  if (patch.agent !== undefined) blob.agent = patch.agent;
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(blob), sessionId);
  invalidateDayRead();
  return getSessionDetail(sessionId);
}

export function listGarminDailyMetrics(limit = 30) {
  return (db.prepare(`SELECT * FROM garmin_daily_metrics ORDER BY date DESC LIMIT ?`).all(limit) as any[]).map((r) => hydrateJson(r));
}

export function getGarminCoachSummary(days = 14) {
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);
  const source = listGarminSources()[0] ?? null;
  const activities = db.prepare(
    `SELECT type,
            COUNT(*) AS sessions,
            ROUND(COALESCE(SUM(duration_min), 0), 1) AS minutes,
            ROUND(COALESCE(SUM(distance_km), 0), 2) AS distance_km,
            ROUND(AVG(avg_hr), 1) AS avg_hr,
            ROUND(COALESCE(SUM(training_load), 0), 1) AS training_load,
            MAX(date) AS last_date
     FROM garmin_activities
     WHERE date >= ?
     GROUP BY type
     ORDER BY minutes DESC`
  ).all(since) as any[];
  const hard = (db.prepare(
    `SELECT date, type, name, duration_min, distance_km, avg_hr, max_hr, training_load,
            training_effect, aerobic_te, anaerobic_te, te_label, avg_power, vo2max, hr_zones_json
     FROM garmin_activities
     WHERE date >= ? AND (training_load >= 80 OR training_effect >= 3.5 OR duration_min >= 90)
     ORDER BY date DESC, id DESC LIMIT 8`
  ).all(since) as any[]).map((r) => {
    let hr_zones: any = null;
    try { hr_zones = r.hr_zones_json ? JSON.parse(r.hr_zones_json) : null; } catch { hr_zones = null; }
    const { hr_zones_json, ...rest } = r;
    return { ...rest, hr_zones };
  });
  const daily = db.prepare(
    `SELECT
       ROUND(AVG(sleep_min), 1) AS avg_sleep_min,
       ROUND(AVG(sleep_score), 1) AS avg_sleep_score,
       ROUND(AVG(deep_sleep_min), 1) AS avg_deep_sleep_min,
       ROUND(AVG(rem_sleep_min), 1) AS avg_rem_sleep_min,
       ROUND(AVG(resting_hr), 1) AS avg_resting_hr,
       ROUND(AVG(hrv_ms), 1) AS avg_hrv_ms,
       ROUND(AVG(stress_avg), 1) AS avg_stress,
       ROUND(AVG(body_battery_avg), 1) AS avg_body_battery,
       ROUND(AVG(body_battery_max), 1) AS avg_body_battery_max,
       ROUND(AVG(respiration_avg), 1) AS avg_respiration,
       ROUND(AVG(spo2_avg), 1) AS avg_spo2,
       ROUND(AVG(active_calories), 1) AS avg_active_calories,
       ROUND(AVG(intensity_min_vigorous), 1) AS avg_vigorous_min,
       ROUND(AVG(training_readiness), 1) AS avg_training_readiness,
       ROUND(AVG(acute_load), 1) AS avg_acute_load,
       MAX(vo2max) AS vo2max,
       MAX(training_status) AS training_status,
       MAX(hrv_status) AS hrv_status,
       MAX(skin_temp_dev_c) AS skin_temp_dev_c,
       MAX(weight_kg) AS weight_kg,
       MAX(body_fat_pct) AS body_fat_pct,
       MAX(muscle_mass_kg) AS muscle_mass_kg,
       MAX(date) AS last_date
     FROM garmin_daily_metrics
     WHERE date >= ?`
  ).get(since) as any;
  // Latest non-null point-in-time signals (acute training load and fitness age
  // are CURRENT values, not things to average — take the most recent reading).
  // These were captured by the sync but dropped here until now.
  const latestOf = (col: string): number | null => {
    try {
      const r = db.prepare(
        `SELECT ${col} AS v FROM garmin_daily_metrics WHERE date >= ? AND ${col} IS NOT NULL ORDER BY date DESC LIMIT 1`
      ).get(since) as any;
      return r?.v != null && Number.isFinite(Number(r.v)) ? Number(r.v) : null;
    } catch { return null; }
  };
  daily.acute_load = latestOf("acute_load");
  daily.fitness_age = latestOf("fitness_age");
  daily.training_readiness = latestOf("training_readiness"); // latest readiness, alongside the window avg
  return { days, since, source, activities, hard_sessions: hard, recovery: daily };
}

