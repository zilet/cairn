import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

function addColumn(db: DatabaseSync, table: string, colDef: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  } catch {
    /* already exists on fresh DBs */
  }
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "exercise-cues",          up: (db) => addColumn(db, "exercises",   "cues TEXT") },
  { version: 2, name: "plan-item-warmups",      up: (db) => addColumn(db, "plan_items",  "warmup_sets INTEGER") },
  { version: 3, name: "settings-onboarded",     up: (db) => addColumn(db, "settings",    "onboarded INTEGER DEFAULT 0") },
  { version: 4, name: "activities-enrich",      up: (db) => addColumn(db, "activities",  "enrichment_status TEXT") },
  { version: 5, name: "food-notes-enrich",      up: (db) => addColumn(db, "food_notes",  "enrichment_status TEXT") },
  { version: 6, name: "settings-enrich-enabled", up: (db) => addColumn(db, "settings",   "enrich_enabled INTEGER DEFAULT 1") },
  { version: 7, name: "exercises-mode",         up: (db) => addColumn(db, "exercises",   "mode TEXT DEFAULT 'reps'") },
  { version: 8, name: "sets-duration-sec",      up: (db) => addColumn(db, "logged_sets", "duration_sec REAL") },
  { version: 9, name: "plan-target-seconds",    up: (db) => addColumn(db, "plan_items",  "target_seconds INTEGER") },
  { version: 10, name: "settings-art-enabled",  up: (db) => addColumn(db, "settings",    "art_enabled INTEGER DEFAULT 1") },
  { version: 11, name: "settings-meal-prefs",   up: (db) => addColumn(db, "settings",    "meal_prefs TEXT DEFAULT ''") },
  { version: 12, name: "activity-source-ids",    up: (db) => {
    addColumn(db, "activities", "source TEXT");
    addColumn(db, "activities", "external_id TEXT");
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source_external
      ON activities(source, external_id)
      WHERE source IS NOT NULL AND external_id IS NOT NULL`);
  } },
  { version: 13, name: "garmin-source-tables",   up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS garmin_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'garmin',
        mode TEXT NOT NULL DEFAULT 'unofficial',
        label TEXT,
        auth_status TEXT DEFAULT 'not_configured',
        token_json TEXT,
        sync_cursor TEXT,
        last_sync_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(provider, label)
      );
      CREATE TABLE IF NOT EXISTS garmin_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES garmin_sources(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
        date TEXT NOT NULL,
        start_time TEXT,
        type TEXT,
        name TEXT,
        duration_min REAL,
        distance_km REAL,
        calories REAL,
        avg_hr REAL,
        max_hr REAL,
        ascent_m REAL,
        training_load REAL,
        training_effect REAL,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        synced_at TEXT DEFAULT (datetime('now')),
        UNIQUE(source_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS garmin_daily_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES garmin_sources(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        steps INTEGER,
        sleep_min REAL,
        sleep_score REAL,
        resting_hr REAL,
        hrv_ms REAL,
        stress_avg REAL,
        body_battery_avg REAL,
        body_battery_min REAL,
        body_battery_max REAL,
        active_calories REAL,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(source_id, date)
      );
    `);
  } },
  { version: 14, name: "settings-connector-secrets", up: (db) => {
    addColumn(db, "settings", "garmin_username TEXT DEFAULT ''");
    addColumn(db, "settings", "garmin_password TEXT DEFAULT ''");
    addColumn(db, "settings", "gemini_api_key TEXT DEFAULT ''");
  } },
  { version: 15, name: "settings-art-enabled-at", up: (db) => addColumn(db, "settings", "art_enabled_at TEXT DEFAULT ''") },
  { version: 16, name: "settings-garmin-sync-status", up: (db) => {
    addColumn(db, "settings", "garmin_last_sync_at TEXT DEFAULT ''");
    addColumn(db, "settings", "garmin_last_sync_status TEXT DEFAULT ''");
  } },
  { version: 17, name: "chat-archived-at",        up: (db) => addColumn(db, "chat_messages", "archived_at TEXT") },
  { version: 18, name: "health-doc-source-id",    up: (db) => {
    // Links a dated panel split out of a multi-record import back to the upload
    // row that produced it (the one that still owns the binary). NULL = a
    // standalone document (the common single-date case) or the source itself.
    addColumn(db, "health_documents", "source_doc_id INTEGER");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_health_docs_source ON health_documents(source_doc_id)`);
  } },
  { version: 19, name: "sessions-autoregulation", up: (db) => {
    // Optional per-session autoregulation feedback (Phase 3B). New tables in
    // this batch (checkins/daily_metrics/family_members/health_directives/
    // insights) need no migration — only these column adds do.
    addColumn(db, "sessions", "soreness INTEGER");
    addColumn(db, "sessions", "performance INTEGER");
    addColumn(db, "sessions", "joint_pain TEXT");
  } },
  { version: 20, name: "profile-about-me",         up: (db) => addColumn(db, "profile", "about_me TEXT") },
  { version: 21, name: "health-directives-marker-uncertain", up: (db) => {
    addColumn(db, "health_directives", "marker TEXT");
    addColumn(db, "health_directives", "uncertain INTEGER DEFAULT 0");
  } },
  { version: 22, name: "garmin-daily-full-dataset", up: (db) => {
    // Full-body Garmin daily dataset: sleep architecture, HR, stress, body
    // battery dynamics, respiration, SpO2, temperature, energy, fitness, body comp.
    for (const col of [
      "deep_sleep_min REAL", "light_sleep_min REAL", "rem_sleep_min REAL",
      "awake_min REAL", "nap_min REAL", "restless_count INTEGER", "avg_sleep_stress REAL",
      "hrv_status TEXT", "max_hr REAL", "min_hr REAL", "hr_7d_avg REAL",
      "stress_max REAL", "body_battery_charged REAL", "body_battery_drained REAL",
      "respiration_avg REAL", "respiration_min REAL", "respiration_max REAL",
      "spo2_avg REAL", "spo2_min REAL", "skin_temp_dev_c REAL",
      "total_calories REAL", "bmr_calories REAL", "floors_climbed REAL",
      "intensity_min_moderate REAL", "intensity_min_vigorous REAL", "distance_m REAL",
      "vo2max REAL", "vo2max_cycling REAL", "training_readiness REAL",
      "training_status TEXT", "acute_load REAL", "fitness_age REAL",
      "weight_kg REAL", "body_fat_pct REAL", "muscle_mass_kg REAL",
      "body_water_pct REAL", "bone_mass_kg REAL", "bmi REAL", "visceral_fat REAL",
    ]) addColumn(db, "garmin_daily_metrics", col);
  } },
  { version: 23, name: "garmin-activity-detail", up: (db) => {
    for (const col of [
      "moving_min REAL", "elevation_loss_m REAL", "aerobic_te REAL", "anaerobic_te REAL",
      "te_label TEXT", "avg_cadence REAL", "max_cadence REAL", "avg_power REAL",
      "max_power REAL", "norm_power REAL", "avg_speed REAL", "max_speed REAL",
      "avg_temp REAL", "vo2max REAL", "hr_zones_json TEXT",
    ]) addColumn(db, "garmin_activities", col);
  } },
  { version: 24, name: "garmin-strength-reconciliation", up: (db) => {
    // Connect a synced Garmin strength activity to the day's Cairn session: the
    // raw detected exercise sets + a soft link to the reconciled session, and a
    // physiology blob (HR/zones/calories/TE + agent narrative) stamped on the session.
    addColumn(db, "garmin_activities", "exercise_sets_json TEXT");
    addColumn(db, "garmin_activities", "session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL");
    addColumn(db, "sessions", "garmin_json TEXT");
  } },
  { version: 25, name: "insights-next-step", up: (db) => {
    // Split the insight's optional concrete suggestion out of the rationale blob
    // into its own field so the card can render it as a distinct, scannable line.
    addColumn(db, "insights", "next_step TEXT");
  } },
  { version: 26, name: "directive-feedback-memory", up: (db) => {
    // Make Done/Dismiss durable: each directive records the marker snapshot and
    // a stable family key so future derivations can suppress repeats until the
    // underlying marker state materially changes.
    addColumn(db, "health_directives", "directive_key TEXT");
    addColumn(db, "health_directives", "status_at TEXT");
    addColumn(db, "health_directives", "trigger_value REAL");
    addColumn(db, "health_directives", "trigger_side TEXT");
    addColumn(db, "health_directives", "trigger_date TEXT");
    addColumn(db, "health_directives", "resurfaced_from_id INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_directives_feedback ON health_directives(source, marker, domain, directive_key, status)");
  } },
  { version: 27, name: "day-read-override", up: (db) => {
    // Persist the athlete's day-read steer ("rough night" / "easy day" / …) on the
    // cached read so a reload restores their choice and the coach context can fold it
    // in, instead of the steer being a throwaway client-only reshape.
    addColumn(db, "day_reads", "override TEXT");
  } },
];

export function runMigrations(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as any;
  const cur = Number(row?.user_version ?? 0);
  const target = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  let applied = 0;
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= cur) continue;
    db.exec("BEGIN");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      applied++;
      console.log(`[migrate] applied v${m.version} ${m.name}`);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { from: cur, to: target, applied };
}

// CLI entry point: `tsx src/migrate.ts`
// NOTE: no top-level await here — db.ts statically imports this module, so a
// TLA on the dynamic import would deadlock the cycle (this module can't finish
// evaluating until db.js does, and db.js waits on this module). A floating
// .then lets this module finish first; db.ts runs the migrations on import.
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  import("./db.js").then(({ db }) => {
    const vrow = db.prepare("PRAGMA user_version").get() as any;
    console.log(`[migrate] current user_version: ${vrow?.user_version ?? 0}`);
  });
}
