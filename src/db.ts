import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "cairn.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  muscle_group TEXT,
  unit TEXT DEFAULT 'lb',
  constraint_note TEXT,
  cues TEXT,
  mode TEXT DEFAULT 'reps',               -- reps | timed (e.g. plank, dead hang)
  equipment TEXT,                         -- classified implement (e.g. 'a cable machine') — art/guide context
  enrichment_status TEXT                  -- pending|in_progress|done|failed|skipped|null (background 'exercise' enrichment)
);
CREATE TABLE IF NOT EXISTS plan_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_number INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  focus TEXT
);
CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_day_id INTEGER NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  exercise_id INTEGER REFERENCES exercises(id), -- NULLABLE: a cardio item (kind='cardio') has no exercise (v35)
  sets INTEGER NOT NULL DEFAULT 3,
  rep_low INTEGER,
  rep_high INTEGER,
  target_weight REAL,
  note TEXT,
  warmup_sets INTEGER,
  target_seconds INTEGER,                -- prescribed hold/duration for timed exercises
  -- First-class planned cardio (v35). kind='cardio' rows carry an endurance
  -- prescription instead of a loaded exercise: distance, duration, an HR/effort
  -- zone, and an optional interval structure (JSON). kind='strength' (default)
  -- keeps the exercise_id-driven behavior exactly as before.
  kind TEXT DEFAULT 'strength',          -- strength | cardio
  target_distance_km REAL,               -- planned distance (cardio), e.g. 12
  target_duration_min REAL,              -- planned moving time in minutes (cardio)
  target_zone TEXT,                      -- HR/effort zone, free text, e.g. 'Z2' | 'tempo' | 'easy'
  interval_json TEXT,                    -- optional interval structure, JSON (e.g. [{reps:6,on:'400m',off:'90s'}])
  superset_group INTEGER                 -- optional pairing/superset id: items on the same day sharing a value are done as a superset (v56). NULL = standalone
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  plan_day_id INTEGER REFERENCES plan_days(id),
  duration_min INTEGER,
  notes TEXT,
  soreness INTEGER,                      -- optional 1-tap autoregulation feedback (1-5; NULL = not given)
  performance INTEGER,                   -- how the session felt vs expected (1-5; NULL = not given)
  joint_pain TEXT,                       -- free-text joint/area flag, e.g. "left knee" (NULL = none)
  garmin_json TEXT,                      -- reconciled Garmin strength physiology blob (HR/zones/calories/TE + agent narrative)
  finished_at TEXT,                      -- UTC stamp set by finishSession; NULL = session still open (mid-workout). Reopen clears it.
  kind TEXT DEFAULT 'strength',          -- strength | cardio — a logged cardio effort (run/ride) is a reviewable session too (v35)
  created_at TEXT DEFAULT (datetime('now'))
);
-- Durable, versioned prescription for what the athlete chose to do on one day.
-- The weekly plan remains a reusable template: plan-backed compositions copy its
-- items here, and replacements mark the old row superseded instead of deleting it.
CREATE TABLE IF NOT EXISTS daily_session_compositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('adaptive_plan','agent_suggest','manual_plan','athlete_override')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  plan_day_id INTEGER REFERENCES plan_days(id) ON DELETE SET NULL,
  title TEXT,
  focus TEXT,
  why TEXT,
  est_minutes INTEGER,
  items_json TEXT NOT NULL,
  constraints_json TEXT,
  provenance_json TEXT,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_at TEXT,
  UNIQUE(date, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_session_active_date
  ON daily_session_compositions(date) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_session_active_session
  ON daily_session_compositions(session_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_daily_session_history
  ON daily_session_compositions(date, version DESC);
CREATE INDEX IF NOT EXISTS idx_daily_session_fingerprint
  ON daily_session_compositions(date, request_fingerprint, status);
-- Stage 2 decision metadata (docs/ADAPTIVE_DAILY_TRAINING_PLAN.md §4/§8): the
-- versioned, reason-coded envelope that explains why a day's session was chosen.
-- Additive + null-safe; a brand-new table needs no user_version migration. No raw
-- health payloads are stored here — only render-safe derived decision facts.
CREATE TABLE IF NOT EXISTS daily_session_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  composition_id INTEGER REFERENCES daily_session_compositions(id) ON DELETE SET NULL,
  policy_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_decision_date
  ON daily_session_decisions(date, id DESC);
CREATE INDEX IF NOT EXISTS idx_daily_decision_fingerprint
  ON daily_session_decisions(date, input_fingerprint);
-- Stage 4 outcome reconciliation (docs §6): one durable, idempotent outcome
-- record per accepted composition — what was suggested vs what was actually
-- trained, with confidence + reason codes. Additive; feeds progression/evolution
-- through the existing brain-event machinery, never a direct plan mutation.
CREATE TABLE IF NOT EXISTS daily_session_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  composition_id INTEGER NOT NULL REFERENCES daily_session_compositions(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(composition_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_outcome_date
  ON daily_session_outcomes(date, id DESC);
CREATE TABLE IF NOT EXISTS logged_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  set_number INTEGER NOT NULL,
  weight REAL,
  reps INTEGER,
  rir REAL,
  note TEXT,
  duration_sec REAL,                     -- seconds, for timed exercises (plank, dead hang)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sets_session ON logged_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_sets_exercise ON logged_sets(exercise_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);

-- One athlete-selected anchor lift for the current strength comeback. The target
-- is snapped when the objective is created (a then-current personal best or an
-- explicit est-1RM), so later history never moves the finish line. Old objectives
-- stay as history when a new one supersedes them.
CREATE TABLE IF NOT EXISTS strength_objectives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise TEXT NOT NULL,
  exercise_key TEXT NOT NULL,
  target_kind TEXT NOT NULL,             -- return_to_personal_best | explicit_est_1rm
  target_est_1rm REAL NOT NULL,           -- immutable snapshot for this objective
  baseline_est_1rm REAL,                  -- latest exact-lift estimate when selected
  baseline_date TEXT,
  source TEXT NOT NULL DEFAULT 'user',    -- objectives are athlete-selected only
  status TEXT NOT NULL DEFAULT 'active',  -- active | superseded | completed | archived
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  superseded_at TEXT,
  completed_at TEXT,
  achieved_est_1rm REAL,
  achieved_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_strength_objectives_status ON strength_objectives(status, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strength_objectives_one_active
  ON strength_objectives(status) WHERE status = 'active';

-- Planned exercises consciously skipped ("not today") for one session. A skip
-- only holds while the exercise has no logged sets that session — logging wins.
CREATE TABLE IF NOT EXISTS session_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  exercise TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, exercise)
);

CREATE TABLE IF NOT EXISTS plan_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  agent TEXT,
  instruction TEXT,
  raw_output TEXT,
  parsed_json TEXT,
  status TEXT DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT,                             -- the athlete's name (stamped on the doctor report; optional)
  sex TEXT DEFAULT 'male',
  age INTEGER,
  height_cm REAL,
  height_in REAL,                        -- height in inches (v59) — mirrors the app's lb/in convention; source-of-truth for BMI/WHtR/Navy body-fat. NULL = unset (BMI degrades to a "set your height" hint)
  weight_lb REAL,
  start_weight_lb REAL,                  -- journey baseline weight (v56); explicit baseline, not re-derived on every weigh-in
  start_date TEXT,                       -- journey baseline date (v56)
  goal_weight_lb REAL,
  goal_bodyfat_pct REAL,                 -- journey target body-fat percent (v56)
  goal_date TEXT,
  goal_mode TEXT,                        -- lose | maintain | gain — the journey's shape (v41). NULL = derived from goal_weight (back-compat)
  activity_factor REAL DEFAULT 1.5,
  measured_rmr_kcal REAL,                -- latest measured resting metabolic rate from a metabolic-test health document (v63)
  measured_rmr_date TEXT,                -- effective date of that indirect-calorimetry result (v63)
  measured_rmr_source TEXT,              -- provenance label, normally metabolic_test (v63)
  notes TEXT,
  about_me TEXT,                         -- rich free-text understanding (history, work, food likes/dislikes, what "better" means)
  allergies TEXT,                        -- free-text food allergies (HARD safety exclusion for meals)
  dietary_restrictions TEXT,             -- free-text diet (vegetarian, pescatarian, no pork, …) — respected strongly
  primary_discipline TEXT DEFAULT 'strength', -- strength | endurance | hybrid — shapes coach framing + day-read + stats (v35)
  endurance_sport TEXT,                  -- optional free text: running | cycling | triathlon | rowing | … (v35)
  endurance_goal_json TEXT,              -- the endurance OBJECTIVE (race | standing), orthogonal to discipline (v37)
  smoking INTEGER,                       -- 0/1, NULL = not captured (v57). Feeds AHA PREVENT; NULL assumes the lower-risk value and marks the read provisional
  bp_treated INTEGER,                    -- 0/1, NULL = not captured (v57). On antihypertensive medication — feeds AHA PREVENT the same way
  statin INTEGER,                        -- 0/1, NULL = not captured (v57). On a statin — feeds AHA PREVENT the same way
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT,
  raw_text TEXT,
  duration_min REAL,
  distance_km REAL,
  pace TEXT,
  rpe REAL,
  notes TEXT,
  source TEXT,
  external_id TEXT,
  enrichment_status TEXT,             -- pending | done | skipped | failed (NULL = n/a)
  created_at TEXT DEFAULT (datetime('now'))
);

-- Garmin is treated as an input source, not the training brain. These tables
-- preserve raw provider data while exposing normalized summaries to Cairn.
CREATE TABLE IF NOT EXISTS garmin_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'garmin',
  mode TEXT NOT NULL DEFAULT 'unofficial',      -- unofficial | official | manual
  label TEXT,
  auth_status TEXT DEFAULT 'not_configured',    -- not_configured | connected | failed
  token_json TEXT,                              -- OAuth/session tokens; keep local only
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
  -- richer per-activity body-reaction signals (migration v23)
  moving_min REAL,            -- moving (non-idle) duration
  elevation_loss_m REAL,
  aerobic_te REAL,            -- aerobic training effect (0-5)
  anaerobic_te REAL,          -- anaerobic training effect (0-5)
  te_label TEXT,              -- e.g. "tempo", "vo2max", "recovery"
  avg_cadence REAL,           -- run spm / bike rpm / swim spm (sport-dependent)
  max_cadence REAL,
  avg_power REAL,
  max_power REAL,
  norm_power REAL,
  avg_speed REAL,             -- m/s
  max_speed REAL,
  avg_temp REAL,              -- ambient temperature (C)
  vo2max REAL,                -- activity-level VO2max estimate
  hr_zones_json TEXT,         -- [{zone,secs,low_hr}] time-in-HR-zone breakdown
  exercise_sets_json TEXT,    -- [{category,name,reps,weight_kg,duration_sec,set_type}] detected strength sets (migration v24)
  -- per-activity richness (migration v46): list-payload fields + running dynamics
  -- pulled from the per-activity detail endpoint.
  steps INTEGER,              -- step count for the activity (run/walk)
  avg_stride_len REAL,        -- average stride length (Garmin raw units)
  min_elevation_m REAL,
  max_elevation_m REAL,
  lap_count INTEGER,
  avg_ground_contact_ms REAL, -- running dynamics (detail endpoint)
  avg_vertical_osc_cm REAL,   -- vertical oscillation
  avg_vertical_ratio REAL,    -- vertical ratio (%)
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL, -- reconciled Cairn session (strength activities)
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
  hrv_ms REAL,                -- overnight average HRV
  stress_avg REAL,
  body_battery_avg REAL,
  body_battery_min REAL,
  body_battery_max REAL,
  active_calories REAL,
  -- full-body dataset (migration v22) — sleep architecture, HR, stress, body
  -- battery dynamics, respiration, SpO2, temperature, energy, fitness & body comp.
  deep_sleep_min REAL,
  light_sleep_min REAL,
  rem_sleep_min REAL,
  awake_min REAL,
  nap_min REAL,
  restless_count INTEGER,
  avg_sleep_stress REAL,
  hrv_status TEXT,            -- balanced | unbalanced | low | poor
  max_hr REAL,
  min_hr REAL,
  hr_7d_avg REAL,            -- last-7-days average resting HR
  stress_max REAL,
  body_battery_charged REAL,
  body_battery_drained REAL,
  respiration_avg REAL,      -- breaths/min
  respiration_min REAL,
  respiration_max REAL,
  spo2_avg REAL,             -- pulse ox %
  spo2_min REAL,
  skin_temp_dev_c REAL,      -- sleep skin-temperature deviation (device-dependent)
  total_calories REAL,
  bmr_calories REAL,
  floors_climbed REAL,
  intensity_min_moderate REAL,
  intensity_min_vigorous REAL,
  distance_m REAL,           -- total daily distance
  vo2max REAL,
  vo2max_cycling REAL,
  training_readiness REAL,   -- 0-100 daily readiness
  training_status TEXT,      -- e.g. "productive", "maintaining", "detraining"
  acute_load REAL,
  fitness_age REAL,
  weight_kg REAL,
  body_fat_pct REAL,
  muscle_mass_kg REAL,
  body_water_pct REAL,
  bone_mass_kg REAL,
  bmi REAL,
  visceral_fat REAL,
  -- runner performance metrics (migration v45) — half-marathon-prep signals from
  -- the /metrics-service runner endpoints. All current point-in-time values.
  endurance_score REAL,
  hill_score REAL,
  race_predict_5k_sec INTEGER,
  race_predict_10k_sec INTEGER,
  race_predict_half_sec INTEGER,
  race_predict_marathon_sec INTEGER,
  training_load_balance TEXT,  -- load-balance feedback phrase (e.g. "BALANCED")
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, date)
);

CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  kind TEXT,
  content TEXT NOT NULL,
  source TEXT,
  -- Self-updating memory (v30): a memory is no longer a flat append-only log.
  -- updated_at advances when a near-duplicate folds into this row; superseded_by
  -- points at the row that replaced this one (we MARK, never hard-delete — same
  -- discipline as chat archiving); confidence rises as a fact is re-observed and
  -- is read by retrieval ranking; last_referenced_at stamps when the coach last saw it.
  updated_at TEXT,
  superseded_by INTEGER,
  confidence REAL DEFAULT 1,
  last_referenced_at TEXT
);

-- Outcome learning (v30 batch, new table — no migration needed): what the Brief /
-- session-suggest / nutrition check-in PROPOSED, so a quiet reconciliation pass can
-- later compare suggestion → actual (logged sets, weight trend, autoregulation
-- feedback) and write a durable learning memory. Suggestion-not-a-gate: this only
-- learns the athlete's tendencies, it never enforces them.
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- day_read | session_suggest | nutrition_checkin
  date TEXT,                          -- the date the suggestion was FOR (local)
  payload_json TEXT,                  -- what was proposed (read kind/focus, target kcal, …)
  outcome_json TEXT,                  -- filled in at reconciliation (what actually happened)
  created_at TEXT DEFAULT (datetime('now')),
  reconciled_at TEXT                  -- NULL until reconciled; set once a learning is drawn
);
CREATE INDEX IF NOT EXISTS idx_suggestions_unreconciled
  ON suggestions(kind, date) WHERE reconciled_at IS NULL;

-- Elite-brain accountability spine: durable decisions, falsifiable expectations,
-- deterministic evaluations, and sanitized depth-on-demand telemetry. These are
-- additive tables (not columns on an existing table), so fresh and existing DBs
-- converge through CREATE TABLE IF NOT EXISTS without a migration version.
CREATE TABLE IF NOT EXISTS brain_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  effective_date TEXT,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT,
  source TEXT,
  source_ref_type TEXT,
  source_ref_key TEXT,
  status TEXT NOT NULL,
  autonomy_tier TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  reversible INTEGER DEFAULT 0,
  input_fingerprint TEXT,
  context_json TEXT,
  action_json TEXT,
  specialist_json TEXT,
  applied_at TEXT,
  reverted_at TEXT,
  superseded_by INTEGER REFERENCES brain_decisions(id),
  evaluator_version TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_decisions_fingerprint
  ON brain_decisions(input_fingerprint) WHERE input_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brain_decisions_status_created
  ON brain_decisions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brain_decisions_source
  ON brain_decisions(source_ref_type, source_ref_key);

-- Exact server-owned undo payloads. Kept separate from context_json because the
-- latter is deliberately shallow/bounded for model context and would truncate a
-- nested plan. Never included in coach context or public diagnostics.
CREATE TABLE IF NOT EXISTS brain_rollbacks (
  decision_id INTEGER PRIMARY KEY REFERENCES brain_decisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brain_expectations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES brain_decisions(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  subject_key TEXT,
  direction TEXT NOT NULL,
  baseline_json TEXT,
  target_json TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  minimum_data_json TEXT,
  confounder_policy TEXT,
  confidence TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  evaluator TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brain_expectations_maturity
  ON brain_expectations(status, window_end, id);
CREATE INDEX IF NOT EXISTS idx_brain_expectations_decision
  ON brain_expectations(decision_id, id);

CREATE TABLE IF NOT EXISTS brain_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expectation_id INTEGER NOT NULL REFERENCES brain_expectations(id) ON DELETE CASCADE,
  evaluated_at TEXT DEFAULT (datetime('now')),
  verdict TEXT NOT NULL,
  actual_json TEXT,
  evidence_json TEXT,
  confounders_json TEXT,
  explanation TEXT,
  evaluator_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_evaluations_expectation
  ON brain_evaluations(expectation_id, evaluated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS brain_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  op TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_summary TEXT,
  rows_returned INTEGER,
  latency_ms INTEGER,
  status TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brain_tool_calls_run
  ON brain_tool_calls(run_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_brain_tool_calls_created
  ON brain_tool_calls(created_at DESC);

CREATE TABLE IF NOT EXISTS meal_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  week_of TEXT,
  agent TEXT,
  raw_output TEXT,
  parsed_json TEXT,
  status TEXT DEFAULT 'draft'
);

-- Accepted adaptive-nutrition targets (the MacroFactor-style loop's OUTPUT, persisted).
-- When the athlete accepts a nutrition_target proposal, the accepted numbers land here
-- with an effective_date so the fuel card / goal math / next check-in read the ACCEPTED
-- target instead of forever re-deriving the formula. History is kept (one row per
-- acceptance); the active target is the newest row with effective_date <= today.
CREATE TABLE IF NOT EXISTS nutrition_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_date TEXT NOT NULL,       -- YYYY-MM-DD the accepted target takes effect
  target_kcal INTEGER,
  protein_g INTEGER,
  carbs_g INTEGER,
  fat_g INTEGER,
  source TEXT,                        -- 'checkin' | 'manual' | ...
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nutrition_targets_eff ON nutrition_targets(effective_date);

CREATE TABLE IF NOT EXISTS food_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  date TEXT,                          -- LOCAL calendar day the meal belongs to (stamped at insert, device-zone aware); created_at stays the UTC instant
  meal TEXT,
  raw_output TEXT,
  parsed_json TEXT,
  image_path TEXT,
  enrichment_status TEXT              -- pending | done | skipped | failed (NULL = n/a)
);

-- Bodyweight log over time (separate from profile's single current weight).
CREATE TABLE IF NOT EXISTS bodyweight_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  weight_lb REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bw_date ON bodyweight_log(date);

-- At-home body measurements (circumferences, in inches — mirrors the app's
-- lb/in convention). One row per measuring session; every site is nullable so
-- the athlete can log only what they measured that day. These feed the derived,
-- deterministic indicators (BMI, waist-to-height, waist-to-hip, Navy body-fat %)
-- so an at-home tape gives a reliable read between DEXA scans (which go stale).
CREATE TABLE IF NOT EXISTS body_measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                       -- YYYY-MM-DD (local day)
  waist_in REAL,
  hip_in REAL,
  chest_in REAL,
  shoulder_in REAL,
  neck_in REAL,
  thigh_in REAL,
  upper_arm_in REAL,
  calf_in REAL,
  forearm_in REAL,
  note TEXT,
  source TEXT DEFAULT 'manual',            -- manual | chat | shortcut | other
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_body_measurements_date ON body_measurements(date);

-- Body-composition / nutrition journey phases. Transitions are proposed first:
-- status='proposed' rows wait for explicit user apply; only status='active'
-- shapes the current journey read.
CREATE TABLE IF NOT EXISTS journey_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                    -- cut | maintenance | diet_break | reverse | gain
  start_date TEXT,
  end_date TEXT,
  start_weight_lb REAL,
  target_weight_lb REAL,
  start_bodyfat_pct REAL,
  target_bodyfat_pct REAL,
  planned_rate_lb_wk REAL,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | active | completed | discarded
  reason TEXT,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_journey_phases_status ON journey_phases(status, start_date);

-- Home / clinic blood-pressure readings. Unlike labs, these are point-in-time
-- measurements; the exact timestamp matters for repeated home averages and for
-- separating "morning at rest" from a clinic/vitals reading. They are also
-- projected into marker history as Systolic BP / Diastolic BP so the connected
-- brain can correlate them with labs, body composition, recovery and training.
CREATE TABLE IF NOT EXISTS blood_pressure_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  measured_at TEXT NOT NULL,                 -- local/known timestamp, "YYYY-MM-DD HH:MM:SS"
  systolic INTEGER NOT NULL,
  diastolic INTEGER NOT NULL,
  pulse INTEGER,
  source TEXT DEFAULT 'manual',              -- manual | mychart | garmin | other
  position TEXT,                             -- seated | standing | lying | unknown/free text
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bp_measured ON blood_pressure_readings(measured_at);

-- In-app chat with the coaching agent. Each turn is one row; assistant rows
-- carry which agent answered and a JSON meta of applied actions / draft ids.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  role TEXT NOT NULL,        -- user | assistant
  content TEXT NOT NULL,
  agent TEXT,
  meta TEXT,
  session_id TEXT,          -- stable archived-conversation id for deep links (e.g. /app/chat?session=...)
  archived_at TEXT           -- set by chat reset/clear ("fresh start"); archived turns leave the live conversation but are never deleted
);

-- Durable chat-turn outbox + job state. A chat turn is no longer a blocking
-- request/response: POST /api/chat persists the user message, opens a turn here
-- (status 'queued'), and a serial in-process worker (src/chatTurns.ts, mirrors
-- the enrich queue) drains it — runs the agent, applies actions, writes the
-- assistant chat_messages row, links it back. The PWA reconstructs in-flight +
-- queued turns from this table on (re)load, so a follow-up queued while the coach
-- is thinking — or a turn interrupted by a tab switch / reload / restart — never
-- disappears. New table → no migration needed (created on every boot).
CREATE TABLE IF NOT EXISTS chat_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,                          -- stamped when the worker picks it up
  finished_at TEXT,                         -- stamped on done/error/canceled
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | running | done | error | canceled
  user_message_id INTEGER,                  -- the chat_messages row for the user's turn
  message TEXT,                             -- the user's text (prompt build + queued-bubble display)
  image_path TEXT,                          -- absolute path to an attached photo (agent reads it), or NULL
  image_url TEXT,                           -- public /api/chat-images/... URL for the bubble, or NULL
  agent TEXT,                               -- requested agent ('auto'/NULL or an explicit name)
  chosen_agent TEXT,                        -- the agent that actually produced the reply
  phase TEXT,                               -- latest progress phase (for late SSE subscribers / poll)
  reply TEXT,                               -- the assistant reply text once done
  assistant_message_id INTEGER,             -- the chat_messages row for the assistant turn
  meta TEXT,                                -- JSON { applied, drafts }
  tz TEXT,                                  -- the device IANA zone captured at enqueue (X-Cairn-TZ); the worker re-frames "now"/day-keys in it
  routing_json TEXT,                        -- privacy-safe {policy_version,lane,reason_codes}; never raw message/path data
  capture_food_note_id INTEGER,             -- first-write-wins food_notes row for an instant text/photo capture
  request_id TEXT,                          -- optional bounded client retry key; unique when present
  idempotent_replays INTEGER NOT NULL DEFAULT 0,
  build_id TEXT,                            -- release/build that accepted the turn; enables coherent lane telemetry
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_status ON chat_turns(status, id);

-- Durable agent-job spine — the GENERALIZATION of chat_turns for blocking
-- agentic ops (session-suggest, plan proposal/evolution, meal plan/swap/recipe,
-- nutrition check-in, insight/weekly-read, day-read override, chat-distill,
-- health review/synthesis).
-- Valid kind values are owned by src/agentJobKinds.ts AGENT_JOB_KINDS.
-- POST /api/<op> persists a job here (status 'queued') and a serial in-process
-- worker (src/agentJobs.ts, mirrors the chat-turn queue) drains it: runs the
-- coachOp, and on done records a thin ref to the ALREADY-persisted result row
-- (ref_table / ref_id) instead of duplicating the payload. The PWA reconstructs
-- in-flight + queued jobs from this table on (re)load, so a backgrounded op
-- survives a tab switch / reload / restart. New table → no migration needed.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,                          -- stamped when the worker picks it up
  finished_at TEXT,                         -- stamped on done/error/canceled
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | running | done | error | canceled
  kind TEXT NOT NULL,                       -- one of src/agentJobKinds.ts AGENT_JOB_KINDS
  phase TEXT,                               -- latest progress phase (for late SSE subscribers / poll)
  input_json TEXT,                          -- the op's typed inputs (agent + per-kind args)
  agent TEXT,                               -- requested agent ('auto'/NULL or an explicit name)
  chosen_agent TEXT,                        -- the agent that actually produced the result
  ref_table TEXT,                           -- table holding the persisted result (e.g. meal_plans, plan_proposals, insights)
  ref_id INTEGER,                           -- row id in ref_table (resolved live on hydrate)
  result_json TEXT,                         -- thin result snapshot (the exact body the sync endpoint returned)
  cache_key TEXT,                           -- ai_cache key when this job served/wrote the cache
  meta TEXT,                                -- JSON { frac:{done,total}, ... } for determinate progress
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_kind ON agent_jobs(kind, id);

-- Host-side AI result cache (serve-stale-then-revalidate). A fingerprint of an
-- idempotent agentic op's inputs maps to the parsed result it produced, so an
-- identical request inside the freshness window is served instantly (no agent
-- run, no spend) and a stale hit is served immediately while a fresh compute runs
-- in the background. Regenerable — mirrors evidence_cache; NOT Anthropic SDK
-- prompt caching, just SQLite result caching. Only the safe-to-cache ops write
-- here (session_suggest / insight / weekly_read); always-fresh ops never do.
CREATE TABLE IF NOT EXISTS ai_cache (
  kind TEXT NOT NULL,                       -- the op kind (session_suggest | insight | weekly_read)
  cache_key TEXT NOT NULL,                  -- sha1 fingerprint of the normalized inputs + a coarse context stamp
  ref_table TEXT,                           -- optional pointer to a persisted result row
  ref_id INTEGER,
  result_json TEXT,                         -- the cached parsed result (the sync-endpoint body)
  chosen_agent TEXT,                        -- the agent that produced it
  computed_at TEXT DEFAULT (datetime('now')),
  stale_after TEXT,                         -- UTC stamp past which the entry is stale (served, then revalidated)
  PRIMARY KEY (kind, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_computed ON ai_cache(computed_at);

-- Single-row app settings (like profile). Controls how coaching agents are
-- chosen when none is named, and the weekly auto-coach schedule.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  agent_strategy TEXT DEFAULT 'round_robin',  -- round_robin | random | priority
  agent_order TEXT,                           -- JSON array of agent names, preferred order
  disabled_agents TEXT,                       -- JSON array of agent names that are off
  rr_cursor TEXT,                             -- last agent started (round-robin cursor)
  coach_enabled INTEGER DEFAULT 0,            -- 1 = weekly auto-draft on
  coach_day INTEGER DEFAULT 0,                -- 0=Sun .. 6=Sat
  coach_hour INTEGER DEFAULT 20,              -- local hour
  updated_at TEXT DEFAULT (datetime('now')),
  onboarded INTEGER DEFAULT 0,
  enrich_enabled INTEGER DEFAULT 1,           -- 1 = background agentic enrichment on
  art_enabled INTEGER DEFAULT 1,              -- 1 = generated artwork (needs Gemini key)
  meal_prefs TEXT DEFAULT '',                 -- free-text meal/schedule preferences the coach always sees
  garmin_username TEXT DEFAULT '',            -- optional override for GARMIN_USERNAME
  garmin_password TEXT DEFAULT '',            -- legacy plaintext override for GARMIN_PASSWORD; read for back-compat
  garmin_password_encrypted TEXT DEFAULT '',  -- encrypted override when CAIRN_SETTINGS_SECRET_KEY is set
  gemini_api_key TEXT DEFAULT '',             -- legacy plaintext override for GEMINI_API_KEY / GOOGLE_AI_KEY; read for back-compat
  gemini_api_key_encrypted TEXT DEFAULT '',   -- encrypted override when CAIRN_SETTINGS_SECRET_KEY is set
  art_enabled_at TEXT DEFAULT '',             -- when art_enabled last flipped on (spend telemetry window)
  garmin_last_sync_at TEXT DEFAULT '',        -- when the last Garmin sync finished (UTC ISO)
  garmin_last_sync_status TEXT DEFAULT '',    -- short result: "ok: 12 activities · 14 daily" | "failed: …"
  proactive_enabled INTEGER DEFAULT 1,        -- 1 = nightly quiet insight + weekly read/nutrition-checkin precompute (pull-never-push)
  research_enabled INTEGER DEFAULT 0,         -- 1 = host-side evidence research on (default OFF; off ⇒ deterministic, no network)
  bg_ops_enabled INTEGER DEFAULT 1,           -- legacy compatibility flag; agentic surfaces always use durable jobs
  agent_routes TEXT DEFAULT '',               -- optional JSON map { task -> agent }; empty/null = no routing (Auto everywhere, today's behavior)
  chat_routing_mode TEXT DEFAULT 'adaptive',  -- adaptive | single (legacy one-profile chat path)
  chat_profile_bindings TEXT DEFAULT '',      -- JSON provider -> capture|coach|deep -> optional {model,reasoning}
  agent_profile_bindings TEXT DEFAULT '',     -- JSON provider -> task -> optional {model,reasoning}; overrides TASK_EXECUTION_PROFILES (repo/settings.ts)
  update_check_enabled INTEGER DEFAULT 1,     -- 1 = quiet daily check for a newer Cairn release (GitHub Releases API); pull-never-push, surfaced in Settings → Data
  lead_mode TEXT DEFAULT 'lead'                -- lead | announce_first | review_everything — one calm autonomy control
);

-- Generated-artwork bookkeeping (see src/art.ts). art_assets records what each
-- cached PNG under data/art/ depicts; art_aliases maps semantically-equivalent
-- queries onto one asset so equal-looking images are generated once; art_usage
-- is the spend ledger for every paid Gemini call (and every avoided one).
CREATE TABLE IF NOT EXISTS art_assets (
  key TEXT PRIMARY KEY,                       -- sha1 cache key = PNG filename under data/art/
  kind TEXT NOT NULL,                         -- food | exercise | activity
  text TEXT NOT NULL,                         -- canonical concept the image depicts
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS art_aliases (
  kind TEXT NOT NULL,
  query TEXT NOT NULL,                        -- normalized caller query
  asset_key TEXT NOT NULL,                    -- -> art_assets.key
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (kind, query)
);

-- Marker-name canonicalization (the connected brain's analyte de-duplication).
-- Different labs name the same analyte differently ("Glucose (random)" vs
-- "Glucose Random"; "Vitamin D" vs "25-OH Vitamin D"; "eGFR" vs the long form),
-- which would otherwise split one analyte's history into parallel series. Like
-- art_aliases, this persists each learned variant→canonical decision so it's
-- resolved once: a deterministic normalizer + a curated KB are the offline floor
-- (see src/repo/marker-canon.ts), and the agentic reconciler learns the harder
-- clinical synonyms into this table (source 'agent'/'manual'/'kb'). getMarkerHistory
-- keys by the canonical, so every connected-brain surface merges automatically.
CREATE TABLE IF NOT EXISTS marker_aliases (
  raw_norm TEXT PRIMARY KEY,                  -- normalizeMarkerName(raw lab name)
  canonical_key TEXT NOT NULL,               -- normalizeMarkerName(canonical) — the merge key
  canonical_name TEXT NOT NULL,              -- canonical display name
  source TEXT DEFAULT 'agent',               -- kb | agent | manual
  created_at TEXT DEFAULT (datetime('now'))
);

-- Exercise-name canonicalization (the strength brain's movement de-duplication).
-- "Dead hang" and "Dead hang timed" are the same movement logged under two names,
-- splitting one lift's history into parallel series. Like marker_aliases, this
-- persists each variant→canonical decision so the dedup is resolved once. The
-- deterministic normalizer + classifier (src/repo/exercise-canon.ts) are the offline
-- floor; the reconciler (repo.mergeExercises) persists learned aliases here.
CREATE TABLE IF NOT EXISTS exercise_aliases (
  id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,                 -- normalizeExerciseName(variant name) — the lookup key
  canonical TEXT NOT NULL,                    -- the exercise name to merge into
  source TEXT,                                -- agent | manual | seed | merge
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS art_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  kind TEXT,
  query TEXT,
  asset_key TEXT,
  action TEXT NOT NULL,                       -- generate | canonicalize | reuse | fail
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  est_cost_usd REAL DEFAULT 0,                -- estimated money spent on this call
  est_saved_usd REAL DEFAULT 0                -- estimated generation cost avoided (reuse rows)
);
CREATE INDEX IF NOT EXISTS idx_art_usage_created ON art_usage(created_at);

-- Uploaded health documents (labs, DEXA, ECG, vitals, visit notes, summaries, etc.), analyzed in the
-- background by a file/vision-capable agent into structured markers + summary.
-- The binary lives on disk under data/uploads/; file_path points at it.
CREATE TABLE IF NOT EXISTS health_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  kind TEXT,                          -- see src/healthDocumentKinds.ts
  doc_date TEXT,                      -- the test date (YYYY-MM-DD)
  original_name TEXT,
  mime TEXT,
  file_path TEXT,                     -- absolute path to the stored binary (NULL for client-recorded analyses / derived panels)
  parsed_json TEXT,                   -- extracted markers/structured JSON
  summary TEXT,
  enrichment_status TEXT,             -- pending | in_progress | done | failed | skipped (NULL = n/a)
  source_doc_id INTEGER               -- the upload this dated panel was split out of (NULL = standalone / the source itself)
);

-- A first-class imaging study is one health_documents row (kind = 'imaging').
-- Its report + image pages live as ordered attachments here so a multi-file study
-- remains one clinical record. DICOM is not ingested yet; the optional identifiers
-- reserve the later Study/Series/SOP linkage without changing this ownership model.
CREATE TABLE IF NOT EXISTS imaging_study_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  health_document_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  original_name TEXT,
  mime TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'image', -- report | image | mychart
  dicom_study_uid TEXT,
  dicom_series_uid TEXT,
  dicom_sop_uid TEXT,
  UNIQUE(health_document_id, sequence),
  UNIQUE(health_document_id, sha256),
  FOREIGN KEY(health_document_id) REFERENCES health_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_imaging_files_study ON imaging_study_files(health_document_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_imaging_files_study_hash ON imaging_study_files(health_document_id, sha256);

-- Durable, serial DICOM ingestion. The archive path is private staging state and
-- is removed at every terminal outcome. Public projections never select it.
CREATE TABLE IF NOT EXISTS dicom_import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | running | done | failed
  source_mime TEXT NOT NULL,
  staging_path TEXT,
  source_bytes INTEGER NOT NULL,
  target_study_id INTEGER,
  analyze INTEGER NOT NULL DEFAULT 0,
  entries_seen INTEGER NOT NULL DEFAULT 0,
  instances_indexed INTEGER NOT NULL DEFAULT 0,
  studies_created INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT,
  result_json TEXT,
  error_code TEXT,
  FOREIGN KEY(target_study_id) REFERENCES health_documents(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_dicom_jobs_status ON dicom_import_jobs(status, id);

CREATE TABLE IF NOT EXISTS dicom_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  health_document_id INTEGER NOT NULL,
  study_instance_uid TEXT NOT NULL,
  series_instance_uid TEXT NOT NULL,
  modality TEXT,
  series_number INTEGER,
  study_date TEXT,
  study_description TEXT,
  description TEXT,
  body_part TEXT,
  laterality TEXT,
  frame_of_reference_uid TEXT,
  patient_fingerprint TEXT,
  instance_count INTEGER NOT NULL DEFAULT 0,
  frame_count INTEGER NOT NULL DEFAULT 0,
  preview_support_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(health_document_id, series_instance_uid),
  FOREIGN KEY(health_document_id) REFERENCES health_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dicom_series_study ON dicom_series(health_document_id, series_number, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dicom_series_uid ON dicom_series(series_instance_uid);

CREATE TABLE IF NOT EXISTS dicom_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL,
  imaging_study_file_id INTEGER NOT NULL UNIQUE,
  sop_class_uid TEXT NOT NULL,
  sop_instance_uid TEXT NOT NULL,
  transfer_syntax_uid TEXT NOT NULL,
  instance_number INTEGER,
  number_of_frames INTEGER NOT NULL DEFAULT 1,
  rows INTEGER,
  columns INTEGER,
  samples_per_pixel INTEGER,
  photometric_interpretation TEXT,
  bits_allocated INTEGER,
  bits_stored INTEGER,
  high_bit INTEGER,
  pixel_representation INTEGER,
  planar_configuration INTEGER,
  rescale_slope REAL,
  rescale_intercept REAL,
  window_center REAL,
  window_width REAL,
  pixel_spacing TEXT,
  image_position TEXT,
  image_orientation TEXT,
  slice_location REAL,
  frame_of_reference_uid TEXT,
  body_part TEXT,
  laterality TEXT,
  burned_in_annotation TEXT,
  source_deidentification_claim TEXT,
  preview_support_reason TEXT,
  preview_path TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(series_id, sop_instance_uid),
  FOREIGN KEY(series_id) REFERENCES dicom_series(id) ON DELETE CASCADE,
  FOREIGN KEY(imaging_study_file_id) REFERENCES imaging_study_files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dicom_instances_series ON dicom_instances(series_id, instance_number, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dicom_instances_sop_uid ON dicom_instances(sop_instance_uid);

-- Runtime-only cryptographic material. SQLite snapshots preserve this table;
-- JSON/public exports never select it.
CREATE TABLE IF NOT EXISTS private_runtime_secrets (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Whole-picture health reviews: an agent's longevity/wellness read over the
-- athlete's full context + aggregated marker history (see repo.getMarkerHistory).
-- parsed_json is the coerced/clamped review contract (headline, wins, watchlist,
-- focus, followups, training/nutrition impact).
CREATE TABLE IF NOT EXISTS health_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  agent TEXT,
  parsed_json TEXT NOT NULL,
  raw_output TEXT
);

-- Life timeline the coach plans around: trips, injuries, life events.
-- meta_json holds kind-specific detail: trip {location}, injury {area,severity},
-- life_event {impact}.
CREATE TABLE IF NOT EXISTS context_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  kind TEXT,                          -- trip | injury | life_event
  title TEXT,
  detail TEXT,
  start_date TEXT,
  end_date TEXT,                      -- nullable (ongoing / open-ended)
  meta_json TEXT,
  archived INTEGER DEFAULT 0,
  expected_recovery_days INTEGER,     -- injuries: expected healing window (days from start); NULL = open-ended / non-injury
  resolved_at TEXT                    -- YYYY-MM-DD an event was explicitly closed (healed); NULL = still open
);

-- Optional subjective morning check-in (mood/energy/sleep-feel/soreness on a
-- small 1-5 scale). Feeds dayRead as a parallel signal and is the graceful
-- degradation path when there's no wearable. Offered, never required.
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  mood INTEGER,                       -- 1-5 (NULL = not given)
  energy INTEGER,                     -- 1-5
  sleep_feel INTEGER,                 -- 1-5 (how rested you feel, not a wearable score)
  soreness INTEGER,                   -- 1-5
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(date);

-- One-tap fueling follow-through. After a nutrition-target change APPLIES, Today quietly
-- offers a calm "how's fueling feeling?" check on days the athlete logs food, only while
-- the change is inside its 7-day follow-through window. Adherence-neutral, no scores:
-- energy/hunger are a small 1-3 "running low / steady / plenty" read. One row per day
-- (date UNIQUE, upserted), linked to the triggering nutrition_target brain_decision so the
-- next adaptive check-in can weigh the subjective signal against the change it followed.
CREATE TABLE IF NOT EXISTS fueling_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE,
  energy INTEGER,                     -- 1-3 (running low / steady / plenty)
  hunger INTEGER,                     -- 1-3 (NULL = not given)
  note TEXT,
  decision_id INTEGER,                -- applied nutrition_target brain_decision this follows (NULL if none active)
  created_at TEXT DEFAULT (datetime('now'))
);

-- Supplement UNDERSTANDING (not a daily log). The athlete says what they take in
-- plain words ("creatine daily, omega-3, some D, whey occasionally"); the system
-- APPROXIMATES each into a canonical name + typical dose + cadence + the markers /
-- domains it touches, so the connected brain can reason about it (D3 ↔ vitamin-D
-- marker, omega-3 ↔ triglycerides, whey ↔ protein floor, creatine ↔ eGFR). No
-- rows-per-day, no check-offs. active=0 = "stopped taking" (kept for history).
CREATE TABLE IF NOT EXISTS supplements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,                          -- canonical name (e.g. 'Creatine monohydrate')
  raw TEXT,                           -- what the athlete actually said
  dose TEXT,                          -- approximate dose ('5 g', '1-2 g EPA+DHA') or NULL
  frequency TEXT,                     -- daily | most days | occasional | weekly | as needed
  category TEXT,                      -- performance | omega-3 | vitamin | mineral | protein | ...
  related_markers TEXT,               -- JSON array of marker keys it touches (connected brain)
  note TEXT,                          -- one-line plain-language "what this means"
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Source-agnostic daily metrics (Apple Health via Shortcuts, manual, etc.),
-- parallel to garmin_daily_metrics. getRecoverySummary() merges both into one
-- unified recovery view. UNIQUE(source,date) so re-imports upsert in place.
CREATE TABLE IF NOT EXISTS daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,                        -- apple | manual | ... (the provider this row came from)
  date TEXT,
  steps INTEGER,
  sleep_min REAL,
  sleep_score REAL,
  resting_hr REAL,
  hrv_ms REAL,
  active_calories REAL,
  total_calories REAL,
  distance_km REAL,
  exercise_min REAL,
  stand_hours REAL,
  spo2_avg REAL,
  vo2max REAL,
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);

-- Scoped Apple Health Shortcut credentials. Only SHA-256 hashes are retained:
-- the one-time pairing code and the eventual ingest credential are shown once,
-- then cannot be recovered from the database. Pairings are short-lived and
-- single-use; connections can be independently revoked without rotating the
-- owner's CAIRN_AUTH_TOKEN.
CREATE TABLE IF NOT EXISTS apple_health_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  shortcut_version TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_apple_health_connections_active
  ON apple_health_connections(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS apple_health_pairings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  shortcut_version TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  connection_id INTEGER REFERENCES apple_health_connections(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_apple_health_pairings_active
  ON apple_health_pairings(used_at, expires_at);

-- Family members the coach plans around (partner, kids). Their recurring
-- commitments live as context_events (kind:'family_event'); this is the roster.
CREATE TABLE IF NOT EXISTS family_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  color TEXT,                         -- UI accent for this person
  relationship TEXT,                  -- partner | child | parent | ...
  birthdate TEXT,                     -- YYYY-MM-DD (nullable)
  notes TEXT,
  allergies TEXT,                     -- free-text food allergies (HARD safety exclusion in household meals)
  dietary_restrictions TEXT,          -- free-text diet — surfaced as optional kid-friendly / household mods
  created_at TEXT DEFAULT (datetime('now'))
);

-- The connected-brain cross-domain directives: a flagged finding (a lab marker,
-- a pattern) propagated into every domain it touches. deriveDirectives() writes
-- these from out-of-optimal markers; getCoachContext carries the active ones
-- into the meal / training / day-read prompts. Citation filled by Stage-2 T4.
CREATE TABLE IF NOT EXISTS health_directives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  source TEXT,                        -- where this batch came from (e.g. 'markers', 'health_review')
  domain TEXT,                        -- nutrition | training | watch
  marker TEXT,                        -- the source marker key (e.g. 'LDL-C') this propagated from, when applicable
  directive_key TEXT,                 -- stable family key for suppressing repeats across re-derives
  intent_key TEXT,                    -- semantic intent (recheck | lever | notice) — identity axis across sources
  directive TEXT,                     -- the concrete cross-domain instruction
  rationale TEXT,                     -- plain-language why
  citation TEXT,                      -- evidence link/reference (NULL when the mapping is uncertain)
  uncertain INTEGER DEFAULT 0,        -- 1 when the lever is real but not settled (research-recommended)
  status TEXT DEFAULT 'active',       -- active | resolved | dismissed
  status_at TEXT,                     -- when the user explicitly handled/dismissed it
  trigger_value REAL,                 -- marker value that caused this directive, when numeric
  trigger_side TEXT,                  -- low | high | unknown at derivation time
  trigger_date TEXT,                  -- latest marker date at derivation time
  resurfaced_from_id INTEGER          -- previous feedback row this was allowed to resurface from
);
CREATE INDEX IF NOT EXISTS idx_directives_status ON health_directives(status);

-- Quiet in-app cross-domain insights (Phase 6): a periodic agent pass surfaces
-- ONE real connection at a time. Shown in the Brief when the app is opened,
-- never pushed. Thumbs up/down lands in the feedback column.
CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  kind TEXT,                          -- connection | weekly_read | continuity | ...
  text TEXT,                          -- the one-line insight, plain language
  rationale TEXT,                     -- the short supporting reasoning, user-facing voice
  next_step TEXT,                     -- optional one concrete, low-friction suggestion (or null)
  status TEXT DEFAULT 'new',          -- new | seen | dismissed
  feedback TEXT                       -- up | down | NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status);

-- Adaptive attention schedule: one deterministic cadence row per signal the
-- coach may revisit. Released entries have no next_due, so due queries stay quiet
-- until new data, a related symptom, a question, or a goal change reactivates them.
CREATE TABLE IF NOT EXISTS attention_schedule (
  signal_key TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  tier TEXT NOT NULL,                  -- active | confirming | surveillance | released
  next_due TEXT,                       -- YYYY-MM-DD; NULL when released
  last_checked TEXT,                   -- YYYY-MM-DD of the reading/event that drove this state
  reason TEXT NOT NULL,
  release_condition TEXT NOT NULL,
  source TEXT,
  state_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attention_due ON attention_schedule(next_due, tier);
CREATE INDEX IF NOT EXISTS idx_attention_domain ON attention_schedule(domain, tier);

-- Precomputed day-read cache (the Brief). One canonical (no-override) read per
-- calendar day, written by the nightly scheduler pass (and on a cache miss) so
-- the morning open is instant and never waits on an agent. Invalidated by the
-- few events that materially change the read: a check-in, the day's first
-- logged set, new recovery/daily metrics. Regenerable — safe to drop.
CREATE TABLE IF NOT EXISTS day_reads (
  date TEXT PRIMARY KEY,              -- YYYY-MM-DD (the day this read is for)
  kind TEXT,                          -- train | easy | rest
  headline TEXT,
  why TEXT,
  focus TEXT,
  est_minutes INTEGER,
  signals TEXT,                       -- JSON: the deterministic inputs behind the call
  source TEXT,                        -- agent | deterministic
  agent TEXT,                         -- which agent produced it (when source='agent')
  override TEXT,                      -- the athlete's persisted steer for the day (null = canonical read)
  computed_at TEXT DEFAULT (datetime('now'))
);

-- Agent-run telemetry (one row per agent ATTEMPT, written from the runChosen /
-- runAgentWithFallback / day-read paths). Makes the agentic loop observable:
-- ok-rate, per-agent latency, how often the JSON-repair retry was needed. Writes
-- are cheap + failure-safe (never throw into the coaching loop). Regenerable —
-- pure telemetry, safe to prune. Surfaced via getAgentStats / GET /api/agent-stats
-- / MCP get_agent_stats. No numeric score is ever derived from this for the user;
-- it's an operator/health view, not a grade.
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT,
  op TEXT,                            -- which operation: day_read | session_suggest | nutrition_checkin | insight | coach_draft | ...
  agent TEXT,                         -- the agent that produced (or failed) this attempt
  ok INTEGER,                         -- 1 = produced a usable parsed result
  parsed INTEGER,                     -- 1 = output parsed as JSON
  latency_ms INTEGER,                 -- wall-clock for this attempt
  tried_json INTEGER,                 -- 1 = the one-shot JSON-repair retry was used
  status TEXT,                        -- ok | auth_required | invalid_output | empty_reply | error | timeout | ...
  error_class TEXT,                   -- compact machine-readable cause, e.g. auth_required/process_error
  error_message TEXT,                 -- short sanitized operator-facing detail; never prompt/output bodies
  exit_code INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  lane TEXT,                            -- capture | coach | deep for adaptive chat attempts
  policy_version TEXT,                  -- versioned chat-routing taxonomy only
  reason_codes_json TEXT,               -- JSON array of versioned taxonomy enums; never source text
  requested_model TEXT,                 -- sanitized per-run model binding requested by route policy
  requested_reasoning TEXT,             -- low | medium | high | xhigh
  effective_reasoning TEXT,             -- provider-adjusted effort (for example xhigh -> high)
  streaming INTEGER,                    -- 1 when the attempt used the streaming adapter
  ttft_ms INTEGER,                      -- first accepted visible reply delta, when streamed
  chat_turn_id INTEGER,                 -- durable correlation to chat_turns.id
  attempt_index INTEGER,                -- monotonic attempt number inside the durable turn
  escalation_source TEXT,               -- capture | coach when this attempt followed/requested escalation
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at);

-- Local-first diagnostic spine for browser/API/process failures. Every write is
-- bounded + sanitized before it reaches this table; payload bodies, query values,
-- prompts, health data, credentials and raw agent output never belong here.
-- Regenerable operator telemetry, retained for 30 days by the repo write path.
CREATE TABLE IF NOT EXISTS diagnostic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                -- client | api | process | scheduler
  kind TEXT NOT NULL,                  -- api_failure | render_error | http_error | slow_request | ...
  level TEXT NOT NULL,                 -- warning | error
  operation TEXT,
  route TEXT,
  status INTEGER,
  duration_ms INTEGER,
  request_id TEXT,
  fingerprint TEXT NOT NULL,
  message TEXT,
  stack TEXT,
  metadata_json TEXT,
  release TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_diagnostic_events_created ON diagnostic_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostic_events_issue ON diagnostic_events(fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostic_events_route ON diagnostic_events(route, created_at DESC);

-- Hourly, low-cardinality request histograms. Successful API/MCP calls are
-- aggregated rather than retained as raw request rows; percentile reads are
-- approximate bucket upper bounds and never contain bodies or query values.
CREATE TABLE IF NOT EXISTS request_metric_buckets (
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
);
CREATE INDEX IF NOT EXISTS idx_request_metric_hour ON request_metric_buckets(hour DESC);
-- idx_request_metric_route lives in the post-migration exec below: it references
-- build_id, which pre-v62 databases only gain when migration v62 rebuilds this
-- table — creating it here crashes boot BEFORE runMigrations can fix the table.

-- Tiny generic key/value scratchpad for scheduler bookkeeping (last-run stamps
-- for the miss-tolerant coach draft + the weekly proactive passes). Survives a
-- restart so a missed slot still fires once when the process comes back up.
-- Regenerable — losing it just means a proactive pass might run one extra time.
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Durable scheduler ownership. One row owns one logical operation in one
-- calendar slot, so a provider outage cannot consume the slot and a restart can
-- recover an expired in-flight lease. claim_token fences a late worker after
-- its lease has been reclaimed by a newer attempt.
CREATE TABLE IF NOT EXISTS scheduler_operations (
  operation TEXT NOT NULL,
  slot_stamp TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','retry_wait','succeeded','no_op','exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_expires_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  PRIMARY KEY (operation, slot_stamp)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_operations_due
  ON scheduler_operations(status, next_retry_at, lease_expires_at);

-- Host-side research / evidence cache (Stream 4 — grounding). When research is
-- enabled, src/research.ts runs a dedicated web-capable agent over a question and
-- stores each cited claim here: a plain-language body + its source title/url +
-- a confidence band, scoped to a topic and (optionally) a marker. Used to GROUND
-- the health review (inject retrieved passages) and to VERIFY agent-emitted
-- citations. Regenerable cache — safe to drop; a TTL re-research pass refreshes
-- stale rows. INFORMATIONAL, not medical advice.
CREATE TABLE IF NOT EXISTS evidence_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT,                         -- normalized research question / subject key
  marker TEXT,                        -- the marker this evidence is about (e.g. 'ApoB'), or NULL
  claim TEXT,                         -- the plain-language claim / finding
  source_title TEXT,                  -- citation title (e.g. 'AHA/ACC 2018 Cholesterol Guideline')
  source_url TEXT,                    -- the URL backing the claim (http/https, validated)
  body TEXT,                          -- the supporting passage / detail
  confidence TEXT,                    -- high | moderate | low (plain-language band, never a score)
  source_scope TEXT DEFAULT 'general',-- general | athlete | clinician (never inferred across boundaries)
  source_version TEXT,                -- publication/guideline revision identifier
  published_at TEXT,                  -- source publication date when supplied
  reviewed_at TEXT,                   -- when Cairn last reviewed this claim/source pairing
  expires_at TEXT,                    -- deterministic review/refresh boundary
  verification_status TEXT DEFAULT 'source_only', -- claim_source | source_only | unverified
  retrieved_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_topic ON evidence_cache(topic);
CREATE INDEX IF NOT EXISTS idx_evidence_marker ON evidence_cache(marker);

-- Periodization / training-block model (v38). A mesocycle with a goal, a
-- phase, and a week counter so progression can be structured
-- (accumulation → intensification → deload → realization) rather than random.
-- At most one block should be active at a time (enforced by convention at the
-- API layer). status: active | completed | abandoned.
-- NO scores anywhere — goal/phase/focus are plain descriptive labels.
CREATE TABLE IF NOT EXISTS program_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL DEFAULT 'Training block',  -- free text, e.g. "Build squat + base"
  focus TEXT NOT NULL DEFAULT 'strength',       -- strength | hypertrophy | endurance-base | peak
  phase TEXT NOT NULL DEFAULT 'accumulation',   -- accumulation | intensification | deload | realization
  week_index INTEGER NOT NULL DEFAULT 1,        -- 1-based current week within the block
  total_weeks INTEGER NOT NULL DEFAULT 6,       -- planned length (2–12)
  started_at TEXT NOT NULL DEFAULT (datetime('now')), -- UTC ISO when the block started
  status TEXT NOT NULL DEFAULT 'active',        -- active | completed | abandoned
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_program_blocks_status ON program_blocks(status);

-- Server-side idempotency ledger for offline-outbox replays. The PWA's outbox
-- retries queued mutating writes (sets, activities, bodyweight, food notes,
-- session finish) with a client-generated X-Idempotency-Key; this table lets the
-- server replay the FIRST 2xx response for a repeated key instead of applying the
-- write twice. Only durable-outbox routes are admitted. Successful responses are
-- retained for the lifetime of the database because that outbox has no expiry;
-- keys are capped at 120 characters and stored response bodies at 64 KiB. This is
-- a new table, so no migration is needed.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
`);

runMigrations(db);

// Indexes that reference migrated columns must be created after migrations so
// older local databases can boot and then add the columns they need.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_agent_runs_build_created
  ON agent_runs(build_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_metric_route
  ON request_metric_buckets(build_id, protocol, route, hour DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source_external
  ON activities(source, external_id)
  WHERE source IS NOT NULL AND external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_directives_feedback
  ON health_directives(source, marker, domain, directive_key, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_turns_request_id
  ON chat_turns(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_turns_build_created
  ON chat_turns(build_id, created_at);
`);

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
