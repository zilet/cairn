import type { DatabaseSync } from "node:sqlite";
import { extractMeasuredRmr } from "./repo/metabolism-core.js";

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
  { version: 1, name: "exercise-cues", up: (db) => addColumn(db, "exercises", "cues TEXT") },
  { version: 2, name: "plan-item-warmups", up: (db) => addColumn(db, "plan_items", "warmup_sets INTEGER") },
  { version: 3, name: "settings-onboarded", up: (db) => addColumn(db, "settings", "onboarded INTEGER DEFAULT 0") },
  { version: 4, name: "activities-enrich", up: (db) => addColumn(db, "activities", "enrichment_status TEXT") },
  { version: 5, name: "food-notes-enrich", up: (db) => addColumn(db, "food_notes", "enrichment_status TEXT") },
  {
    version: 6,
    name: "settings-enrich-enabled",
    up: (db) => addColumn(db, "settings", "enrich_enabled INTEGER DEFAULT 1"),
  },
  { version: 7, name: "exercises-mode", up: (db) => addColumn(db, "exercises", "mode TEXT DEFAULT 'reps'") },
  { version: 8, name: "sets-duration-sec", up: (db) => addColumn(db, "logged_sets", "duration_sec REAL") },
  { version: 9, name: "plan-target-seconds", up: (db) => addColumn(db, "plan_items", "target_seconds INTEGER") },
  { version: 10, name: "settings-art-enabled", up: (db) => addColumn(db, "settings", "art_enabled INTEGER DEFAULT 1") },
  { version: 11, name: "settings-meal-prefs", up: (db) => addColumn(db, "settings", "meal_prefs TEXT DEFAULT ''") },
  {
    version: 12,
    name: "activity-source-ids",
    up: (db) => {
      addColumn(db, "activities", "source TEXT");
      addColumn(db, "activities", "external_id TEXT");
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source_external
      ON activities(source, external_id)
      WHERE source IS NOT NULL AND external_id IS NOT NULL`);
    },
  },
  {
    version: 13,
    name: "garmin-source-tables",
    up: (db) => {
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
    },
  },
  {
    version: 14,
    name: "settings-connector-secrets",
    up: (db) => {
      addColumn(db, "settings", "garmin_username TEXT DEFAULT ''");
      addColumn(db, "settings", "garmin_password TEXT DEFAULT ''");
      addColumn(db, "settings", "gemini_api_key TEXT DEFAULT ''");
    },
  },
  {
    version: 15,
    name: "settings-art-enabled-at",
    up: (db) => addColumn(db, "settings", "art_enabled_at TEXT DEFAULT ''"),
  },
  {
    version: 16,
    name: "settings-garmin-sync-status",
    up: (db) => {
      addColumn(db, "settings", "garmin_last_sync_at TEXT DEFAULT ''");
      addColumn(db, "settings", "garmin_last_sync_status TEXT DEFAULT ''");
    },
  },
  { version: 17, name: "chat-archived-at", up: (db) => addColumn(db, "chat_messages", "archived_at TEXT") },
  {
    version: 18,
    name: "health-doc-source-id",
    up: (db) => {
      // Links a dated panel split out of a multi-record import back to the upload
      // row that produced it (the one that still owns the binary). NULL = a
      // standalone document (the common single-date case) or the source itself.
      addColumn(db, "health_documents", "source_doc_id INTEGER");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_health_docs_source ON health_documents(source_doc_id)`);
    },
  },
  {
    version: 19,
    name: "sessions-autoregulation",
    up: (db) => {
      // Optional per-session autoregulation feedback (Phase 3B). New tables in
      // this batch (checkins/daily_metrics/family_members/health_directives/
      // insights) need no migration — only these column adds do.
      addColumn(db, "sessions", "soreness INTEGER");
      addColumn(db, "sessions", "performance INTEGER");
      addColumn(db, "sessions", "joint_pain TEXT");
    },
  },
  { version: 20, name: "profile-about-me", up: (db) => addColumn(db, "profile", "about_me TEXT") },
  {
    version: 21,
    name: "health-directives-marker-uncertain",
    up: (db) => {
      addColumn(db, "health_directives", "marker TEXT");
      addColumn(db, "health_directives", "uncertain INTEGER DEFAULT 0");
    },
  },
  {
    version: 22,
    name: "garmin-daily-full-dataset",
    up: (db) => {
      // Full-body Garmin daily dataset: sleep architecture, HR, stress, body
      // battery dynamics, respiration, SpO2, temperature, energy, fitness, body comp.
      for (const col of [
        "deep_sleep_min REAL",
        "light_sleep_min REAL",
        "rem_sleep_min REAL",
        "awake_min REAL",
        "nap_min REAL",
        "restless_count INTEGER",
        "avg_sleep_stress REAL",
        "hrv_status TEXT",
        "max_hr REAL",
        "min_hr REAL",
        "hr_7d_avg REAL",
        "stress_max REAL",
        "body_battery_charged REAL",
        "body_battery_drained REAL",
        "respiration_avg REAL",
        "respiration_min REAL",
        "respiration_max REAL",
        "spo2_avg REAL",
        "spo2_min REAL",
        "skin_temp_dev_c REAL",
        "total_calories REAL",
        "bmr_calories REAL",
        "floors_climbed REAL",
        "intensity_min_moderate REAL",
        "intensity_min_vigorous REAL",
        "distance_m REAL",
        "vo2max REAL",
        "vo2max_cycling REAL",
        "training_readiness REAL",
        "training_status TEXT",
        "acute_load REAL",
        "fitness_age REAL",
        "weight_kg REAL",
        "body_fat_pct REAL",
        "muscle_mass_kg REAL",
        "body_water_pct REAL",
        "bone_mass_kg REAL",
        "bmi REAL",
        "visceral_fat REAL",
      ])
        addColumn(db, "garmin_daily_metrics", col);
    },
  },
  {
    version: 23,
    name: "garmin-activity-detail",
    up: (db) => {
      for (const col of [
        "moving_min REAL",
        "elevation_loss_m REAL",
        "aerobic_te REAL",
        "anaerobic_te REAL",
        "te_label TEXT",
        "avg_cadence REAL",
        "max_cadence REAL",
        "avg_power REAL",
        "max_power REAL",
        "norm_power REAL",
        "avg_speed REAL",
        "max_speed REAL",
        "avg_temp REAL",
        "vo2max REAL",
        "hr_zones_json TEXT",
      ])
        addColumn(db, "garmin_activities", col);
    },
  },
  {
    version: 24,
    name: "garmin-strength-reconciliation",
    up: (db) => {
      // Connect a synced Garmin strength activity to the day's Cairn session: the
      // raw detected exercise sets + a soft link to the reconciled session, and a
      // physiology blob (HR/zones/calories/TE + agent narrative) stamped on the session.
      addColumn(db, "garmin_activities", "exercise_sets_json TEXT");
      addColumn(db, "garmin_activities", "session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL");
      addColumn(db, "sessions", "garmin_json TEXT");
    },
  },
  {
    version: 25,
    name: "insights-next-step",
    up: (db) => {
      // Split the insight's optional concrete suggestion out of the rationale blob
      // into its own field so the card can render it as a distinct, scannable line.
      addColumn(db, "insights", "next_step TEXT");
    },
  },
  {
    version: 26,
    name: "directive-feedback-memory",
    up: (db) => {
      // Make Done/Dismiss durable: each directive records the marker snapshot and
      // a stable family key so future derivations can suppress repeats until the
      // underlying marker state materially changes.
      addColumn(db, "health_directives", "directive_key TEXT");
      addColumn(db, "health_directives", "status_at TEXT");
      addColumn(db, "health_directives", "trigger_value REAL");
      addColumn(db, "health_directives", "trigger_side TEXT");
      addColumn(db, "health_directives", "trigger_date TEXT");
      addColumn(db, "health_directives", "resurfaced_from_id INTEGER");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_directives_feedback ON health_directives(source, marker, domain, directive_key, status)"
      );
    },
  },
  {
    version: 27,
    name: "day-read-override",
    up: (db) => {
      // Persist the athlete's day-read steer ("rough night" / "easy day" / …) on the
      // cached read so a reload restores their choice and the coach context can fold it
      // in, instead of the steer being a throwaway client-only reshape.
      addColumn(db, "day_reads", "override TEXT");
    },
  },
  // Elite-build migration ladder: v27 day-read-override, v28 settings.research_enabled
  // (Stream 4), v29 settings.proactive_enabled (Stream 1), v30 memory self-updating
  // (Stream 2, renumbered from v27 to avoid the day-read-override collision).
  {
    version: 28,
    name: "research-enabled",
    up: (db) => {
      // Host-side research / evidence grounding (Stream 4). Default OFF: when off,
      // the system behaves exactly as before — deterministic, no network. The
      // evidence_cache table is created via CREATE TABLE IF NOT EXISTS in db.ts and
      // needs no migration; only this column add does.
      addColumn(db, "settings", "research_enabled INTEGER DEFAULT 0");
    },
  },
  {
    version: 29,
    name: "settings-proactive-enabled",
    up: (db) => {
      // Gate for nightly quiet-insight / weekly-read / nutrition-checkin precompute
      // (pull-never-push: these only STORE a waiting read, never notify). Default
      // on so existing deployments get calm proactivity; toggle in Settings.
      addColumn(db, "settings", "proactive_enabled INTEGER DEFAULT 1");
    },
  },
  {
    version: 30,
    name: "memory-self-updating",
    up: (db) => {
      // Turn memory from a flat append-only log into a self-updating store: a row
      // can be re-observed (updated_at + confidence), superseded by a newer row
      // (superseded_by — MARK, never hard-delete), and stamped when last surfaced
      // to the coach (last_referenced_at). The 'suggestions' outcome-learning table
      // is a new CREATE TABLE IF NOT EXISTS in db.ts and needs no migration here.
      addColumn(db, "memory", "updated_at TEXT");
      addColumn(db, "memory", "superseded_by INTEGER");
      addColumn(db, "memory", "confidence REAL DEFAULT 1");
      addColumn(db, "memory", "last_referenced_at TEXT");
    },
  },
  {
    version: 31,
    name: "sessions-finished-at",
    up: (db) => {
      // A finished workout reads differently from one mid-flight: Today shows a calm
      // "done" card instead of the full logging surface. NULL = open; a UTC stamp =
      // finished (reopen sets it back to NULL). Existing rows stay NULL (open) — only
      // newly-finished sessions get a stamp, which is the correct, conservative default.
      addColumn(db, "sessions", "finished_at TEXT");
    },
  },
  {
    version: 32,
    name: "settings-bg-ops-enabled",
    up: (db) => {
      // Safety toggle for the durable agent-job spine: when on (default), the 7
      // blocking agentic ops run as background jobs the PWA streams; when off, they
      // run INLINE exactly as before (legacy blocking behavior). The agent_jobs and
      // ai_cache tables are CREATE TABLE IF NOT EXISTS in db.ts and need no migration;
      // only this column add does.
      addColumn(db, "settings", "bg_ops_enabled INTEGER DEFAULT 1");
    },
  },
  {
    version: 33,
    name: "family-nutrition-prefs",
    up: (db) => {
      // Structured allergies + dietary restrictions for the athlete AND each family
      // member, so meal planning can hard-exclude allergens (safety) and note optional
      // kid-friendly / household mods. Free-text, nullable; existing rows stay NULL
      // (nothing declared), which the household-diet renderer treats as "say nothing".
      addColumn(db, "profile", "allergies TEXT");
      addColumn(db, "profile", "dietary_restrictions TEXT");
      addColumn(db, "family_members", "allergies TEXT");
      addColumn(db, "family_members", "dietary_restrictions TEXT");
    },
  },
  {
    version: 34,
    name: "settings-agent-routes",
    up: (db) => {
      // Optional per-task agent routing. A JSON map { task -> agent } lets a user
      // pin, say, chat → claude and meal → codex; empty/null (the default) means no
      // routing — "auto" runs the configured rotation exactly as before. Existing
      // rows stay NULL, which the reader treats as {} (no routing).
      addColumn(db, "settings", "agent_routes TEXT DEFAULT ''");
    },
  },
  {
    version: 35,
    name: "endurance-discipline-and-cardio",
    up: (db) => {
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
    },
  },
  {
    version: 36,
    name: "plan-items-exercise-nullable",
    up: (db) => {
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
    },
  },
  {
    version: 37,
    name: "profile-endurance-goal",
    up: (db) => {
      // The endurance OBJECTIVE, orthogonal to primary_discipline (which says how much
      // running matters vs lifting). One JSON blob holds either mode:
      //   race     → { mode:'race', event, date, distance_km, target?, weekly_km?, weekly_sessions? }
      //   standing → { mode:'standing', label?, distance_km?, weekly_km?, weekly_sessions? }
      // Null = no endurance goal (today's behavior). Validated/normalized in repo.
      addColumn(db, "profile", "endurance_goal_json TEXT");
    },
  },
  {
    version: 38,
    name: "program-blocks",
    up: (db) => {
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
    },
  },
  {
    version: 39,
    name: "profile-name",
    up: (db) => {
      // The athlete's name — optional, set in Me → Profile, stamped on the
      // doctor-ready clinical report (so it's no longer a fill-in-on-paper blank).
      addColumn(db, "profile", "name TEXT");
    },
  },
  {
    version: 40,
    name: "exercise-groups-canon",
    up: (db) => {
      // (1) Ensure exercise_aliases exists (already in db.ts for fresh DBs; safe to
      //     re-run via CREATE TABLE IF NOT EXISTS on older DBs).
      try {
        db.exec(`
        CREATE TABLE IF NOT EXISTS exercise_aliases (
          id INTEGER PRIMARY KEY,
          alias TEXT NOT NULL UNIQUE,
          canonical TEXT NOT NULL,
          source TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      } catch {
        /* already exists */
      }

      // (2) Backfill exercises.muscle_group:
      //     - null → classify by name (deterministic KB)
      //     - legacy free-form → canonical taxonomy value
      //     Uses a minimal inline map mirroring exercise-canon.ts to avoid a
      //     circular module dependency at migration boot time.
      try {
        // Inline legacy alias map (mirrors GROUP_ALIASES in exercise-canon.ts).
        const legacyMap: Record<string, string> = {
          legs: "quads",
          leg: "quads",
          quad: "quads",
          quadriceps: "quads",
          posterior: "hamstrings",
          "posterior chain": "hamstrings",
          hams: "hamstrings",
          hamstring: "hamstrings",
          hammies: "hamstrings",
          glute: "glutes",
          butt: "glutes",
          abs: "core",
          ab: "core",
          abdominals: "core",
          abdominal: "core",
          trunk: "core",
          obliques: "core",
          grip: "forearms",
          forearm: "forearms",
          wrist: "forearms",
          "rear delt": "rear delts",
          "rear deltoid": "rear delts",
          "rear deltoids": "rear delts",
          delts: "shoulders",
          deltoid: "shoulders",
          deltoids: "shoulders",
          shoulder: "shoulders",
          pecs: "chest",
          pec: "chest",
          lats: "back",
          lat: "back",
          bicep: "biceps",
          tricep: "triceps",
          calf: "calves",
          calve: "calves",
          stretch: "mobility",
          stretching: "mobility",
          cardio: "mobility",
        };
        const validGroups = new Set([
          "chest",
          "shoulders",
          "rear delts",
          "triceps",
          "back",
          "biceps",
          "forearms",
          "quads",
          "hamstrings",
          "glutes",
          "calves",
          "core",
          "mobility",
        ]);

        // Inline keyword classifier (mirrors CLASSIFY_RULES in exercise-canon.ts).
        function norm(s: string): string {
          return s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
        const RULES: Array<[string, RegExp[]]> = [
          [
            "mobility",
            [
              /\b90 90\b/,
              /hip switch/,
              /\bstretch/,
              /mobility/,
              /cat cow/,
              /\bcars\b/,
              /world s greatest/,
              /\bopener\b/,
              /\bdrill\b/,
              /thoracic rotation/,
              /\bfoam roll/,
            ],
          ],
          [
            "core",
            [
              /\bplank/,
              /\bcrunch/,
              /\bsit up/,
              /\bab\b/,
              /\babs\b/,
              /\bab /,
              /dead bug/,
              /hollow/,
              /\bpallof/,
              /\bl sit/,
              /hanging (leg|knee) raise/,
              /leg raise/,
              /knee raise/,
              /russian twist/,
              /\bwoodchop/,
              /\bcable rotation/,
              /\boblique/,
              /\bbird dog/,
              /\bbicycle\b/,
              /toe touch/,
              /\bv up/,
              /\brollout/,
              /ab wheel/,
              /\bsuitcase/,
            ],
          ],
          [
            "forearms",
            [
              /dead hang/,
              /\bhang\b/,
              /farmer/,
              /\bcarry\b/,
              /\bcarries\b/,
              /grip/,
              /wrist (curl|roller|extension)/,
              /\bplate pinch/,
              /\bgripper/,
              /finger/,
            ],
          ],
          ["calves", [/calf/, /\bcalves/, /\btib(ialis)?\b/, /\btoe raise/, /seated calf/, /standing calf/]],
          [
            "hamstrings",
            [
              /leg curl/,
              /lying curl/,
              /seated curl/,
              /\bham(string)?\b/,
              /\brdl\b/,
              /romanian/,
              /stiff leg/,
              /stiff legged/,
              /good morning/,
              /nordic/,
              /\bdeadlift/,
              /\bglute ham/,
              /\bghr\b/,
            ],
          ],
          [
            "glutes",
            [/hip thrust/, /glute bridge/, /\bbridge\b/, /\bglute/, /\bkickback/, /abduction/, /\bbird dog\b/],
          ],
          [
            "quads",
            [
              /squat/,
              /leg press/,
              /leg extension/,
              /\blunge/,
              /split squat/,
              /\bstep up/,
              /\bhack\b/,
              /\bsissy/,
              /\bwall sit/,
              /\bquad/,
              /goblet/,
              /pistol/,
            ],
          ],
          [
            "rear delts",
            [
              /face pull/,
              /rear delt/,
              /reverse (fly|pec|flye)/,
              /rear fly/,
              /\bband pull apart/,
              /\bypt\b/,
              /\bprone y\b/,
              /\bprone t\b/,
            ],
          ],
          [
            "shoulders",
            [
              /overhead press/,
              /\bohp\b/,
              /shoulder press/,
              /military press/,
              /\barnold/,
              /lateral raise/,
              /side raise/,
              /front raise/,
              /\bdelt/,
              /\bshoulder\b/,
              /\bpike push/,
              /upright row/,
              /\bshrug/,
            ],
          ],
          [
            "chest",
            [
              /bench press/,
              /\bbench\b/,
              /incline (db|dumbbell|barbell|press|bench)/,
              /decline (press|bench)/,
              /chest press/,
              /chest fly/,
              /\bpec(toral)? (fly|deck)/,
              /\bpec deck/,
              /\bdip\b/,
              /\bpush up/,
              /\bpushup/,
              /\bcable (fly|crossover)/,
              /\bflye?\b/,
              /\bchest\b/,
            ],
          ],
          [
            "triceps",
            [
              /triceps/,
              /\btricep/,
              /pushdown/,
              /push down/,
              /skull crusher/,
              /\bskullcrusher/,
              /overhead extension/,
              /\bkickback/,
              /close grip bench/,
              /\bcgbp\b/,
              /jm press/,
            ],
          ],
          [
            "back",
            [
              /pull up/,
              /pullup/,
              /chin up/,
              /chinup/,
              /pulldown/,
              /pull down/,
              /\blat\b/,
              /\blats\b/,
              /\brow\b/,
              /seated row/,
              /cable row/,
              /bent over row/,
              /\bt bar/,
              /\bpullover/,
              /\bback extension/,
              /hyperextension/,
              /\bpull/,
              /\bback\b/,
            ],
          ],
          [
            "biceps",
            [
              /\bcurl\b/,
              /\bcurls\b/,
              /\bbicep/,
              /\bchin\b/,
              /\bpreacher/,
              /\bhammer/,
              /\bconcentration curl/,
              /\bspider curl/,
              /\bez bar curl/,
            ],
          ],
        ];
        function classifyName(name: string): string | null {
          const n = norm(name);
          for (const [group, regexes] of RULES) {
            for (const re of regexes) if (re.test(n)) return group;
          }
          return null;
        }
        function canonicalize(raw: string | null | undefined): string | null {
          if (raw == null) return null;
          const n = norm(raw);
          if (!n) return null;
          if (validGroups.has(n)) return n;
          return legacyMap[n] ?? null;
        }

        const exercises = db.prepare("SELECT id, name, muscle_group FROM exercises").all() as Array<{
          id: number;
          name: string;
          muscle_group: string | null;
        }>;
        for (const ex of exercises) {
          const resolved = canonicalize(ex.muscle_group) ?? classifyName(ex.name);
          if (resolved && resolved !== ex.muscle_group) {
            try {
              db.prepare("UPDATE exercises SET muscle_group = ? WHERE id = ?").run(resolved, ex.id);
            } catch {
              /* skip individual failures */
            }
          }
        }
      } catch {
        /* backfill is best-effort; never block the migration */
      }
    },
  },
  {
    version: 41,
    name: "profile-goal-mode",
    up: (db) => {
      // The journey's SHAPE, orthogonal to the goal weight: lose | maintain | gain.
      // NULL (the default for existing rows) means "derive it" — lose when a goal
      // weight below current is set, else maintain — so existing deployments behave
      // exactly as before until the athlete picks a mode in Me → Profile.
      addColumn(db, "profile", "goal_mode TEXT");
    },
  },
  {
    version: 42,
    name: "food-notes-local-date",
    up: (db) => {
      // The LOCAL calendar day a meal belongs to. Day-intake used to GROUP food by
      // substr(created_at,1,10) = the UTC date, so a meal logged after ~8 PM ET
      // counted toward TOMORROW. New rows stamp this column with the device-local
      // day; backfill existing rows using SQLite's 'localtime' (the container's TZ),
      // which retroactively moves those late-evening logs onto the right day.
      addColumn(db, "food_notes", "date TEXT");
      try {
        db.exec(`UPDATE food_notes SET date = substr(datetime(created_at, 'localtime'), 1, 10) WHERE date IS NULL`);
      } catch {
        /* best-effort backfill; new inserts stamp it directly */
      }
    },
  },
  {
    version: 43,
    name: "chat-turns-tz",
    up: (db) => {
      // The device IANA timezone captured at enqueue (X-Cairn-TZ). The chat worker
      // runs AFTER the request returns, so it can't read the header itself — it
      // re-establishes this zone to frame "now" and any day-keyed log it writes.
      // NULL (existing/at-home turns) → the worker falls back to the server's TZ.
      addColumn(db, "chat_turns", "tz TEXT");
    },
  },
  {
    version: 44,
    name: "blood-pressure-readings",
    up: (db) => {
      // Point-in-time home/clinic BP readings. These are not health documents, but
      // they project into marker history as Systolic BP / Diastolic BP for the
      // connected brain and health-standing read.
      db.exec(`
      CREATE TABLE IF NOT EXISTS blood_pressure_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        measured_at TEXT NOT NULL,
        systolic INTEGER NOT NULL,
        diastolic INTEGER NOT NULL,
        pulse INTEGER,
        source TEXT DEFAULT 'manual',
        position TEXT,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bp_measured ON blood_pressure_readings(measured_at);
    `);
    },
  },
  {
    version: 45,
    name: "garmin-daily-runner-metrics",
    up: (db) => {
      // Runner performance signals from the /metrics-service runner endpoints
      // (race predictions, endurance score, hill score, training-load balance) —
      // high value for half-marathon prep. Nullable / best-effort: a device or
      // account that doesn't report a metric leaves it null.
      for (const col of [
        "endurance_score REAL",
        "hill_score REAL",
        "race_predict_5k_sec INTEGER",
        "race_predict_10k_sec INTEGER",
        "race_predict_half_sec INTEGER",
        "race_predict_marathon_sec INTEGER",
        "training_load_balance TEXT",
      ])
        addColumn(db, "garmin_daily_metrics", col);
    },
  },
  {
    version: 46,
    name: "garmin-activity-richness",
    up: (db) => {
      // Per-activity richness: list-payload fields (steps, stride, min/max elevation,
      // lap count) that were present but uncaptured, plus running dynamics (ground
      // contact, vertical oscillation/ratio) from the per-activity detail endpoint.
      for (const col of [
        "steps INTEGER",
        "avg_stride_len REAL",
        "min_elevation_m REAL",
        "max_elevation_m REAL",
        "lap_count INTEGER",
        "avg_ground_contact_ms REAL",
        "avg_vertical_osc_cm REAL",
        "avg_vertical_ratio REAL",
      ])
        addColumn(db, "garmin_activities", col);
    },
  },
  {
    version: 47,
    name: "settings-update-check-enabled",
    up: (db) =>
      // Self-hosted update detection: a quiet daily check against the GitHub
      // Releases API surfaces "a newer Cairn is available" in Settings → Data
      // (pull, never push). Default ON; one toggle disables the outbound check.
      addColumn(db, "settings", "update_check_enabled INTEGER DEFAULT 1"),
  },
  {
    version: 48,
    name: "settings-encrypted-secrets",
    up: (db) => {
      // Local at-rest hardening for Settings-saved connector secrets. The legacy
      // plaintext columns stay readable for backward compatibility; settings.ts
      // seals them into these columns when CAIRN_SETTINGS_SECRET_KEY is available.
      addColumn(db, "settings", "garmin_password_encrypted TEXT DEFAULT ''");
      addColumn(db, "settings", "gemini_api_key_encrypted TEXT DEFAULT ''");
    },
  },
  {
    version: 49,
    name: "chat-session-ids",
    up: (db) => {
      // Archived conversations used to be keyed only by archived_at, which is
      // awkward for stable PWA links. Give each archived group one durable id based
      // on its first message id; new archiveChat() writes this at archive time.
      addColumn(db, "chat_messages", "session_id TEXT");
      try {
        db.exec(`
        WITH grouped AS (
          SELECT archived_at, 'chat_' || MIN(id) AS sid
            FROM chat_messages
           WHERE archived_at IS NOT NULL
           GROUP BY archived_at
        )
        UPDATE chat_messages
           SET session_id = (SELECT sid FROM grouped WHERE grouped.archived_at = chat_messages.archived_at)
         WHERE archived_at IS NOT NULL
           AND (session_id IS NULL OR session_id = '')
      `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`);
      } catch {
        /* best-effort backfill; future archives stamp session_id directly */
      }
    },
  },
  // v50–v54 — elite-review wave build (renumbered contiguous at integration from
  // the per-wave reserved bands; none of these had ever applied to a real DB).
  {
    version: 50,
    name: "context-event-healing",
    up: (db) => {
      // Injuries heal over time: give context_events an expected recovery window and
      // an explicit resolved stamp so a minor injury stops gating the day-read/conductor
      // once it's past its window (or is confirmed healed), without hard-deleting it.
      addColumn(db, "context_events", "expected_recovery_days INTEGER");
      addColumn(db, "context_events", "resolved_at TEXT");
    },
  },
  { version: 51, name: "plan-item-superset-group", up: (db) => addColumn(db, "plan_items", "superset_group INTEGER") },
  { version: 52, name: "profile-equipment", up: (db) => addColumn(db, "profile", "equipment TEXT") },
  {
    version: 53,
    name: "exercise-tenure-first-seen",
    up: (db) => {
      // Per-movement TENURE ("14 weeks on this movement") is derived from the first
      // logged set for an exercise — no dedicated column needed. This migration only
      // ensures the supporting index exists so the first-seen read stays cheap.
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sets_exercise_session ON logged_sets(exercise_id, session_id)`);
      } catch {
        /* index may exist */
      }
    },
  },
  // v54: height in inches on profile (mirrors the app's lb/in convention). The
  // new body_measurements table itself is created via CREATE TABLE IF NOT EXISTS
  // in db.ts (which runs on every boot), so per the "new tables need no
  // migration" rule only this column add needs a versioned migration.
  { version: 54, name: "profile-height-in", up: (db) => addColumn(db, "profile", "height_in REAL") },
  {
    version: 55,
    name: "agent-run-diagnostics",
    up: (db) => {
      // Operator telemetry for CLI rotation/fallback: compact failure causes, exit
      // status, and optional usage fields when a CLI exposes token/model metadata.
      // No prompt or full output bodies are stored here.
      addColumn(db, "agent_runs", "status TEXT");
      addColumn(db, "agent_runs", "error_class TEXT");
      addColumn(db, "agent_runs", "error_message TEXT");
      addColumn(db, "agent_runs", "exit_code INTEGER");
      addColumn(db, "agent_runs", "model TEXT");
      addColumn(db, "agent_runs", "input_tokens INTEGER");
      addColumn(db, "agent_runs", "output_tokens INTEGER");
    },
  },
  {
    version: 56,
    name: "profile-journey-baseline",
    up: (db) => {
      addColumn(db, "profile", "start_weight_lb REAL");
      addColumn(db, "profile", "start_date TEXT");
      addColumn(db, "profile", "goal_bodyfat_pct REAL");
    },
  },
  // v57: the three PREVENT inputs Cairn didn't capture before — smoking, BP
  // treatment, and statin use. 0/1, NULL = not captured (keeps the read provisional).
  {
    version: 57,
    name: "profile-cv-risk-flags",
    up: (db) => {
      addColumn(db, "profile", "smoking INTEGER");
      addColumn(db, "profile", "bp_treated INTEGER");
      addColumn(db, "profile", "statin INTEGER");
    },
  },
  // v58: an off-plan exercise the athlete adds now persists immediately and gets a
  // background agentic tidy (canonicalize + classify + how-to guide + good art).
  // `enrichment_status` drives that queue's status machine; `equipment` stores the
  // classified implement (guide + muscle/equipment-aware art context).
  {
    version: 58,
    name: "exercise-enrichment",
    up: (db) => {
      addColumn(db, "exercises", "equipment TEXT");
      addColumn(db, "exercises", "enrichment_status TEXT");
    },
  },
  {
    version: 59,
    name: "settings-lead-mode",
    up: (db) =>
      // The single athlete-facing autonomy posture. The accountability ledger,
      // server safety floors, and undo path remain the execution gate; this value
      // only selects among the policy's allowed postures.
      addColumn(db, "settings", "lead_mode TEXT DEFAULT 'lead'"),
  },
  {
    version: 60,
    name: "evidence-governance",
    up: (db) => {
      addColumn(db, "evidence_cache", "source_scope TEXT DEFAULT 'general'");
      addColumn(db, "evidence_cache", "source_version TEXT");
      addColumn(db, "evidence_cache", "published_at TEXT");
      addColumn(db, "evidence_cache", "reviewed_at TEXT");
      addColumn(db, "evidence_cache", "expires_at TEXT");
      addColumn(db, "evidence_cache", "verification_status TEXT DEFAULT 'source_only'");
      // Existing rows have inspectable provenance but were never checked as a
      // claim/source pair. Preserve them as source_only and give their original
      // retrieval a bounded review window instead of retroactively calling them verified.
      try {
        db.exec(`UPDATE evidence_cache
                  SET source_scope = COALESCE(NULLIF(source_scope, ''), 'general'),
                      reviewed_at = COALESCE(reviewed_at, retrieved_at),
                      expires_at = COALESCE(expires_at, datetime(retrieved_at, '+90 days')),
                      verification_status = COALESCE(NULLIF(verification_status, ''), 'source_only')`);
      } catch {
        /* fresh/empty cache */
      }
    },
  },
  {
    version: 61,
    name: "telemetry-privacy-and-coalescing",
    up: (db) => {
      // Raw-ish historical CLI detail is not useful enough to justify retaining.
      try {
        db.exec(`UPDATE agent_runs SET error_message = NULL WHERE error_message IS NOT NULL`);
      } catch {}
      try {
        db.exec(`UPDATE agent_jobs SET error='Error: background operation failed' WHERE status='error'`);
      } catch {}
      try {
        db.exec(`UPDATE chat_turns SET error='Error: background operation failed' WHERE status='error'`);
      } catch {}
      try {
        db.exec(`UPDATE chat_messages SET meta=json_remove(meta,'$.agent_attempts')
                  WHERE json_valid(meta) AND json_type(meta,'$.agent_attempts') IS NOT NULL`);
      } catch {}
      // Pre-v61 route telemetry used concrete URLs. It is regenerable and cannot
      // be reliably scrubbed after dynamic segments have lost their schema.
      try {
        db.exec(`DELETE FROM diagnostic_events`);
      } catch {}
      try {
        db.exec(`DELETE FROM request_metric_buckets`);
      } catch {}
      addColumn(db, "diagnostic_events", "occurrence_count INTEGER NOT NULL DEFAULT 1");
      addColumn(db, "diagnostic_events", "first_seen TEXT");
      try {
        db.exec(`UPDATE diagnostic_events SET first_seen = COALESCE(first_seen, created_at)`);
      } catch {}
    },
  },
  {
    version: 62,
    name: "telemetry-route-privacy-and-build-scope",
    up: (db) => {
      // Telemetry is regenerable. Historical rows predate the closed route
      // contract and may contain user-authored path segments.
      try {
        db.exec(`DELETE FROM diagnostic_events`);
      } catch {}
      addColumn(db, "agent_runs", "build_id TEXT");
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_build_created ON agent_runs(build_id, created_at)`);
      } catch {}
      try {
        db.exec(`DROP TABLE IF EXISTS request_metric_buckets`);
      } catch {}
      db.exec(`CREATE TABLE request_metric_buckets (
        hour TEXT NOT NULL,
        build_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'product',
        protocol TEXT NOT NULL,
        method TEXT NOT NULL,
        route TEXT NOT NULL,
        status_class TEXT NOT NULL,
        latency_bucket_ms INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        max_duration_ms INTEGER NOT NULL DEFAULT 0,
        UNIQUE(hour, build_id, scope, protocol, method, route, status_class, latency_bucket_ms)
      )`);
      db.exec(`CREATE INDEX idx_request_metric_hour ON request_metric_buckets(hour DESC)`);
      db.exec(`CREATE INDEX idx_request_metric_route ON request_metric_buckets(build_id, protocol, route, hour DESC)`);
    },
  },
  {
    version: 63,
    name: "profile-measured-rmr",
    up: (db) => {
      addColumn(db, "profile", "measured_rmr_kcal REAL");
      addColumn(db, "profile", "measured_rmr_date TEXT");
      addColumn(db, "profile", "measured_rmr_source TEXT");
      try {
        const rows = db
          .prepare(
            `SELECT id, kind, doc_date, parsed_json, summary
             FROM health_documents
            WHERE lower(COALESCE(kind,'')) = 'metabolic_test'
            ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC`
          )
          .all() as any[];
        const reading = rows.map(extractMeasuredRmr).find(Boolean);
        if (reading) {
          db.prepare(
            `UPDATE profile
                SET measured_rmr_kcal = ?, measured_rmr_date = ?, measured_rmr_source = ?
              WHERE id = 1 AND measured_rmr_kcal IS NULL`
          ).run(reading.kcal, reading.date, reading.source);
        }
      } catch {
        /* health docs/profile may be empty on a fresh install */
      }
    },
  },
  {
    version: 64,
    name: "journey-baseline-backfill",
    up: (db) => {
      // Preserve the first observed point as the journey baseline. This fills only
      // missing fields; an explicit athlete-selected baseline always wins.
      try {
        db.exec(`
          UPDATE profile
             SET start_weight_lb = COALESCE(start_weight_lb, (
                   SELECT weight_lb FROM bodyweight_log ORDER BY date ASC, id ASC LIMIT 1
                 )),
                 start_date = COALESCE(start_date, (
                   SELECT date FROM bodyweight_log ORDER BY date ASC, id ASC LIMIT 1
                 ))
           WHERE id = 1
             AND (start_weight_lb IS NULL OR start_date IS NULL)
        `);
      } catch {
        /* empty profile/weight log */
      }
    },
  },
  {
    version: 65,
    name: "daily-metrics-apple-richness",
    up: (db) => {
      // Best-effort Apple Health / source-agnostic daily fields. These remain
      // nullable: a Shortcut can post only what the device actually exposes.
      for (const col of [
        "total_calories REAL",
        "distance_km REAL",
        "exercise_min REAL",
        "stand_hours REAL",
        "spo2_avg REAL",
        "vo2max REAL",
      ])
        addColumn(db, "daily_metrics", col);
    },
  },
  {
    version: 66,
    name: "exercise-key-plural-fold",
    up: (db) => {
      // normalizedExerciseKey now singularizes each token ("leg extensions" ≡ "leg
      // extension"), so any PERSISTED key computed by the old function must be re-keyed
      // through the new fold, or an active anchor-lift objective would stop matching
      // its lift (strength_objectives.exercise_key is compared to a fresh
      // normalizedExerciseKey(exercise.name) at read time in strength-objective-ledger).
      //
      // Inlined on purpose: migrations are frozen snapshots and must NOT import repo
      // modules. Keep this fold in lockstep with src/repo/exercise-canon.ts
      // (normalizedExerciseKey + foldPluralToken).
      //
      // NOTE: exercise_aliases.alias is intentionally NOT re-keyed here — despite its
      // schema comment, every reader/writer keys that column via normalizeExerciseName
      // (NOT normalizedExerciseKey), which the plural fold does not change; re-keying it
      // would break alias resolution in findOrCreateExercise.
      const NON_DISTINGUISHING = new Set(["timed"]);
      const foldPlural = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
      const rekey = (raw: string) => {
        const tokens = String(raw ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .filter(Boolean);
        const kept = tokens.filter((t) => !NON_DISTINGUISHING.has(t)).map(foldPlural);
        return (kept.length ? kept : tokens.map(foldPlural)).join(" ");
      };
      try {
        const rows = db.prepare("SELECT id, exercise, exercise_key FROM strength_objectives").all() as Array<{
          id: number;
          exercise: string;
          exercise_key: string;
        }>;
        for (const r of rows) {
          const next = rekey(r.exercise ?? r.exercise_key);
          if (next && next !== r.exercise_key) {
            db.prepare("UPDATE strength_objectives SET exercise_key = ? WHERE id = ?").run(next, r.id);
          }
        }
      } catch {
        /* table absent / empty on a fresh DB — nothing to re-key */
      }
    },
  },
  {
    version: 67,
    name: "dicom-private-identity-hardening",
    up: (db) => {
      addColumn(db, "dicom_series", "study_date TEXT");
      addColumn(db, "dicom_series", "study_description TEXT");
      addColumn(db, "dicom_series", "patient_fingerprint TEXT");
    },
  },
  // v68-v74 were briefly reserved no-ops after a parallel-deploy version collision (a
  // deployment's user_version reached 74 while this ladder ended at 67). The adaptive-chat
  // round that originally consumed those versions has since merged, so the slots now carry
  // their real (idempotent) changes again; v76 backfills them for any DB that migrated
  // through the no-op window. Before numbering a new migration, check the LIVE
  // deployment's user_version, not just this array's tail.
  {
    version: 68,
    name: "chat-turn-routing-decision",
    up: (db) => addColumn(db, "chat_turns", "routing_json TEXT"),
  },
  {
    version: 69,
    name: "chat-turn-capture-food-note",
    up: (db) => addColumn(db, "chat_turns", "capture_food_note_id INTEGER"),
  },
  {
    version: 70,
    name: "settings-chat-routing-mode",
    up: (db) => addColumn(db, "settings", "chat_routing_mode TEXT DEFAULT 'adaptive'"),
  },
  {
    version: 71,
    name: "settings-chat-profile-bindings",
    up: (db) => addColumn(db, "settings", "chat_profile_bindings TEXT DEFAULT ''"),
  },
  {
    version: 72,
    name: "adaptive-chat-agent-telemetry",
    up: (db) => {
      addColumn(db, "agent_runs", "lane TEXT");
      addColumn(db, "agent_runs", "policy_version TEXT");
      addColumn(db, "agent_runs", "reason_codes_json TEXT");
      addColumn(db, "agent_runs", "requested_model TEXT");
      addColumn(db, "agent_runs", "requested_reasoning TEXT");
      addColumn(db, "agent_runs", "effective_reasoning TEXT");
      addColumn(db, "agent_runs", "streaming INTEGER");
      addColumn(db, "agent_runs", "ttft_ms INTEGER");
      addColumn(db, "agent_runs", "chat_turn_id INTEGER");
      addColumn(db, "agent_runs", "attempt_index INTEGER");
      addColumn(db, "agent_runs", "escalation_source TEXT");
    },
  },
  {
    version: 73,
    name: "chat-turn-request-idempotency",
    up: (db) => {
      addColumn(db, "chat_turns", "request_id TEXT");
      addColumn(db, "chat_turns", "idempotent_replays INTEGER NOT NULL DEFAULT 0");
      try {
        db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_turns_request_id ON chat_turns(request_id) WHERE request_id IS NOT NULL"
        );
      } catch {
        /* partial historical test/schema without chat_turns: addColumn was also a no-op */
      }
    },
  },
  {
    version: 74,
    name: "chat-turn-build-scope",
    up: (db) => {
      addColumn(db, "chat_turns", "build_id TEXT");
      try {
        db.exec("CREATE INDEX IF NOT EXISTS idx_chat_turns_build_created ON chat_turns(build_id, created_at)");
      } catch {
        /* partial historical test/schema without chat_turns: addColumn was also a no-op */
      }
    },
  },
  {
    version: 75,
    name: "directive-intent-key",
    // Semantic identity axis for health directives: recheck | lever | notice. Legacy
    // rows stay NULL (the feedback lookup classifies their text on the fly); every new
    // insert classifies + stores it, so identity is stable across the markers /
    // health_review sources.
    up: (db) => addColumn(db, "health_directives", "intent_key TEXT"),
  },
  {
    version: 76,
    name: "adaptive-chat-columns-backfill",
    // A build shipped while v68-v74 were reserved no-ops; a DB that migrated to v75
    // through that window has the version numbers burned but not the columns. Re-run
    // every adaptive-chat column add idempotently (addColumn is a try/catch no-op when
    // the column exists) so all deployments converge on the same schema.
    up: (db) => {
      addColumn(db, "chat_turns", "routing_json TEXT");
      addColumn(db, "chat_turns", "capture_food_note_id INTEGER");
      addColumn(db, "settings", "chat_routing_mode TEXT DEFAULT 'adaptive'");
      addColumn(db, "settings", "chat_profile_bindings TEXT DEFAULT ''");
      addColumn(db, "agent_runs", "lane TEXT");
      addColumn(db, "agent_runs", "policy_version TEXT");
      addColumn(db, "agent_runs", "reason_codes_json TEXT");
      addColumn(db, "agent_runs", "requested_model TEXT");
      addColumn(db, "agent_runs", "requested_reasoning TEXT");
      addColumn(db, "agent_runs", "effective_reasoning TEXT");
      addColumn(db, "agent_runs", "streaming INTEGER");
      addColumn(db, "agent_runs", "ttft_ms INTEGER");
      addColumn(db, "agent_runs", "chat_turn_id INTEGER");
      addColumn(db, "agent_runs", "attempt_index INTEGER");
      addColumn(db, "agent_runs", "escalation_source TEXT");
      addColumn(db, "chat_turns", "request_id TEXT");
      addColumn(db, "chat_turns", "idempotent_replays INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "chat_turns", "build_id TEXT");
      try {
        db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_turns_request_id ON chat_turns(request_id) WHERE request_id IS NOT NULL"
        );
        db.exec("CREATE INDEX IF NOT EXISTS idx_chat_turns_build_created ON chat_turns(build_id, created_at)");
      } catch {
        /* index creation is best-effort on partial historical schemas */
      }
    },
  },
  {
    version: 77,
    name: "settings-agent-profile-bindings",
    // Optional per-provider, per-task override of TASK_EXECUTION_PROFILES
    // (repo/settings.ts) — same JSON shape as chat_profile_bindings. Empty/NULL
    // means every op uses the declarative default.
    up: (db) => addColumn(db, "settings", "agent_profile_bindings TEXT DEFAULT ''"),
  },
  {
    version: 78,
    name: "day-read-suggestions-dedupe",
    up: (db) => {
      // Before the dedupe guard in recordDayReadSuggestion() (day-read-use-case.ts)
      // existed, every Brief open re-recorded the day's CANONICAL (override:null)
      // day_read suggestion — and a read legitimately evolves during the day
      // (morning rest -> the athlete trains -> train -> done), so a date's re-opens
      // piled up as one row each while looking exactly like a single morning
      // suggestion. Any per-date read of this ledger (GROUP BY, a naive COUNT)
      // silently weights that date many times over. Collapse each date's canonical
      // rows to the earliest (MIN id) — the morning read, recorded before any
      // training could have been logged, which is the truthful record of what was
      // actually suggested. Steered rows (override IS NOT NULL) are deliberately
      // non-idempotent — the athlete can genuinely steer more than once in a day —
      // so they are entirely excluded from this dedup, and every other suggestion
      // kind is untouched. Idempotent: after the first pass only the earliest
      // canonical row remains per date, so it is always the MIN(id) survivor and a
      // second pass deletes nothing further.
      try {
        db.exec(`
          DELETE FROM suggestions
           WHERE kind = 'day_read'
             AND date IS NOT NULL
             AND json_extract(payload_json, '$.override') IS NULL
             AND id NOT IN (
               SELECT MIN(id) FROM suggestions
                WHERE kind = 'day_read'
                  AND date IS NOT NULL
                  AND json_extract(payload_json, '$.override') IS NULL
                GROUP BY date
             )
        `);
      } catch {
        /* suggestions table absent/empty on a fresh DB — nothing to dedupe */
      }
    },
  },
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
