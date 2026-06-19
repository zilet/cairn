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
  // Elite-build migration ladder: v27 day-read-override, v28 settings.research_enabled
  // (Stream 4), v29 settings.proactive_enabled (Stream 1), v30 memory self-updating
  // (Stream 2, renumbered from v27 to avoid the day-read-override collision).
  { version: 28, name: "research-enabled", up: (db) => {
    // Host-side research / evidence grounding (Stream 4). Default OFF: when off,
    // the system behaves exactly as before — deterministic, no network. The
    // evidence_cache table is created via CREATE TABLE IF NOT EXISTS in db.ts and
    // needs no migration; only this column add does.
    addColumn(db, "settings", "research_enabled INTEGER DEFAULT 0");
  } },
  { version: 29, name: "settings-proactive-enabled", up: (db) => {
    // Gate for nightly quiet-insight / weekly-read / nutrition-checkin precompute
    // (pull-never-push: these only STORE a waiting read, never notify). Default
    // on so existing deployments get calm proactivity; toggle in Settings.
    addColumn(db, "settings", "proactive_enabled INTEGER DEFAULT 1");
  } },
  { version: 30, name: "memory-self-updating", up: (db) => {
    // Turn memory from a flat append-only log into a self-updating store: a row
    // can be re-observed (updated_at + confidence), superseded by a newer row
    // (superseded_by — MARK, never hard-delete), and stamped when last surfaced
    // to the coach (last_referenced_at). The 'suggestions' outcome-learning table
    // is a new CREATE TABLE IF NOT EXISTS in db.ts and needs no migration here.
    addColumn(db, "memory", "updated_at TEXT");
    addColumn(db, "memory", "superseded_by INTEGER");
    addColumn(db, "memory", "confidence REAL DEFAULT 1");
    addColumn(db, "memory", "last_referenced_at TEXT");
  } },
  { version: 31, name: "sessions-finished-at", up: (db) => {
    // A finished workout reads differently from one mid-flight: Today shows a calm
    // "done" card instead of the full logging surface. NULL = open; a UTC stamp =
    // finished (reopen sets it back to NULL). Existing rows stay NULL (open) — only
    // newly-finished sessions get a stamp, which is the correct, conservative default.
    addColumn(db, "sessions", "finished_at TEXT");
  } },
  { version: 32, name: "settings-bg-ops-enabled", up: (db) => {
    // Safety toggle for the durable agent-job spine: when on (default), the 7
    // blocking agentic ops run as background jobs the PWA streams; when off, they
    // run INLINE exactly as before (legacy blocking behavior). The agent_jobs and
    // ai_cache tables are CREATE TABLE IF NOT EXISTS in db.ts and need no migration;
    // only this column add does.
    addColumn(db, "settings", "bg_ops_enabled INTEGER DEFAULT 1");
  } },
  { version: 33, name: "family-nutrition-prefs", up: (db) => {
    // Structured allergies + dietary restrictions for the athlete AND each family
    // member, so meal planning can hard-exclude allergens (safety) and note optional
    // kid-friendly / household mods. Free-text, nullable; existing rows stay NULL
    // (nothing declared), which the household-diet renderer treats as "say nothing".
    addColumn(db, "profile", "allergies TEXT");
    addColumn(db, "profile", "dietary_restrictions TEXT");
    addColumn(db, "family_members", "allergies TEXT");
    addColumn(db, "family_members", "dietary_restrictions TEXT");
  } },
  { version: 34, name: "settings-agent-routes", up: (db) => {
    // Optional per-task agent routing. A JSON map { task -> agent } lets a user
    // pin, say, chat → claude and meal → codex; empty/null (the default) means no
    // routing — "auto" runs the configured rotation exactly as before. Existing
    // rows stay NULL, which the reader treats as {} (no routing).
    addColumn(db, "settings", "agent_routes TEXT DEFAULT ''");
  } },
  { version: 35, name: "endurance-discipline-and-cardio", up: (db) => {
    // Endurance/runner-first + hybrid support. profile.primary_discipline drives
    // coach framing, the day-read, and weekly stats (default 'strength' = today's
    // behavior); endurance_sport is optional free text ("running"/"cycling"/…).
    addColumn(db, "profile", "primary_discipline TEXT DEFAULT 'strength'");
    addColumn(db, "profile", "endurance_sport TEXT");
    // First-class PLANNED cardio: a plan_items row can be a cardio prescription
    // (kind='cardio') with no exercise_id. Existing rows stay kind='strength'.
    addColumn(db, "plan_items", "kind TEXT DEFAULT 'strength'");
    addColumn(db, "plan_items", "target_distance_km REAL");
    addColumn(db, "plan_items", "target_duration_min REAL");
    addColumn(db, "plan_items", "target_zone TEXT");
    addColumn(db, "plan_items", "interval_json TEXT");
    // A logged cardio effort (run/ride) modeled as a reviewable session too.
    addColumn(db, "sessions", "kind TEXT DEFAULT 'strength'");
  } },
  { version: 36, name: "plan-items-exercise-nullable", up: (db) => {
    // v35 added the cardio columns to plan_items via ALTER, but SQLite cannot
    // drop a NOT NULL constraint with ALTER — so DBs migrated from an older
    // schema still have exercise_id NOT NULL and reject cardio items (which have
    // exercise_id = null). Fresh DBs get the nullable column straight from db.ts,
    // so only rebuild when the constraint is genuinely still there. plan_items
    // has no incoming FKs and no indexes/triggers, so a copy-rebuild is safe and
    // runs inside this migration's BEGIN/COMMIT. (v35 already added every column
    // referenced below, since migrations apply in ascending order.)
    const info = db.prepare("PRAGMA table_info(plan_items)").all() as Array<{ name: string; notnull: number }>;
    const ex = info.find((c) => c.name === "exercise_id");
    if (!ex || ex.notnull !== 1) return; // already nullable (fresh DB) — nothing to do
    db.exec(`
      CREATE TABLE plan_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_day_id INTEGER NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        exercise_id INTEGER REFERENCES exercises(id),
        sets INTEGER NOT NULL DEFAULT 3,
        rep_low INTEGER,
        rep_high INTEGER,
        target_weight REAL,
        note TEXT,
        warmup_sets INTEGER,
        target_seconds INTEGER,
        kind TEXT DEFAULT 'strength',
        target_distance_km REAL,
        target_duration_min REAL,
        target_zone TEXT,
        interval_json TEXT
      );
      INSERT INTO plan_items_new (id, plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note, warmup_sets, target_seconds, kind, target_distance_km, target_duration_min, target_zone, interval_json)
        SELECT id, plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note, warmup_sets, target_seconds, kind, target_distance_km, target_duration_min, target_zone, interval_json FROM plan_items;
      DROP TABLE plan_items;
      ALTER TABLE plan_items_new RENAME TO plan_items;
    `);
  } },
  { version: 37, name: "profile-endurance-goal", up: (db) => {
    // The endurance OBJECTIVE, orthogonal to primary_discipline (which says how much
    // running matters vs lifting). One JSON blob holds either mode:
    //   race     → { mode:'race', event, date, distance_km, target?, weekly_km?, weekly_sessions? }
    //   standing → { mode:'standing', label?, distance_km?, weekly_km?, weekly_sessions? }
    // Null = no endurance goal (today's behavior). Validated/normalized in repo.
    addColumn(db, "profile", "endurance_goal_json TEXT");
  } },
  { version: 38, name: "program-blocks", up: (db) => {
    // Periodization / training-block model. A mesocycle with a goal, a phase,
    // and a week counter so progression can be structured (accumulation →
    // intensification → deload → realization) rather than random. At most one
    // block is active at a time (enforced at the API layer). NO scores.
    // CREATE TABLE IF NOT EXISTS is idempotent — safe to re-run on any DB.
    db.exec(`
      CREATE TABLE IF NOT EXISTS program_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL DEFAULT 'Training block',
        focus TEXT NOT NULL DEFAULT 'strength',
        phase TEXT NOT NULL DEFAULT 'accumulation',
        week_index INTEGER NOT NULL DEFAULT 1,
        total_weeks INTEGER NOT NULL DEFAULT 6,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_program_blocks_status ON program_blocks(status);
    `);
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
