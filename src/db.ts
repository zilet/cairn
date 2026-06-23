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
  mode TEXT DEFAULT 'reps'                -- reps | timed (e.g. plank, dead hang)
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
  interval_json TEXT                     -- optional interval structure, JSON (e.g. [{reps:6,on:'400m',off:'90s'}])
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
  weight_lb REAL,
  goal_weight_lb REAL,
  goal_date TEXT,
  goal_mode TEXT,                        -- lose | maintain | gain — the journey's shape (v41). NULL = derived from goal_weight (back-compat)
  activity_factor REAL DEFAULT 1.5,
  notes TEXT,
  about_me TEXT,                         -- rich free-text understanding (history, work, food likes/dislikes, what "better" means)
  allergies TEXT,                        -- free-text food allergies (HARD safety exclusion for meals)
  dietary_restrictions TEXT,             -- free-text diet (vegetarian, pescatarian, no pork, …) — respected strongly
  primary_discipline TEXT DEFAULT 'strength', -- strength | endurance | hybrid — shapes coach framing + day-read + stats (v35)
  endurance_sport TEXT,                  -- optional free text: running | cycling | triathlon | rowing | … (v35)
  endurance_goal_json TEXT,              -- the endurance OBJECTIVE (race | standing), orthogonal to discipline (v37)
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

CREATE TABLE IF NOT EXISTS meal_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  week_of TEXT,
  agent TEXT,
  raw_output TEXT,
  parsed_json TEXT,
  status TEXT DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS food_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
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

-- In-app chat with the coaching agent. Each turn is one row; assistant rows
-- carry which agent answered and a JSON meta of applied actions / draft ids.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  role TEXT NOT NULL,        -- user | assistant
  content TEXT NOT NULL,
  agent TEXT,
  meta TEXT,
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
  garmin_password TEXT DEFAULT '',            -- optional override for GARMIN_PASSWORD
  gemini_api_key TEXT DEFAULT '',             -- optional override for GEMINI_API_KEY / GOOGLE_AI_KEY
  art_enabled_at TEXT DEFAULT '',             -- when art_enabled last flipped on (spend telemetry window)
  garmin_last_sync_at TEXT DEFAULT '',        -- when the last Garmin sync finished (UTC ISO)
  garmin_last_sync_status TEXT DEFAULT '',    -- short result: "ok: 12 activities · 14 daily" | "failed: …"
  proactive_enabled INTEGER DEFAULT 1,        -- 1 = nightly quiet insight + weekly read/nutrition-checkin precompute (pull-never-push)
  research_enabled INTEGER DEFAULT 0,         -- 1 = host-side evidence research on (default OFF; off ⇒ deterministic, no network)
  bg_ops_enabled INTEGER DEFAULT 1,           -- 1 = run supported agentic ops as durable background jobs (off ⇒ legacy inline blocking behavior)
  agent_routes TEXT DEFAULT ''                -- optional JSON map { task -> agent }; empty/null = no routing (Auto everywhere, today's behavior)
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
  alias TEXT NOT NULL UNIQUE,                 -- normalizedExerciseKey(variant name)
  canonical TEXT NOT NULL,                    -- the exercise name to merge into
  source TEXT,                                -- agent | manual | seed
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

-- Uploaded health documents (bloodwork / DEXA / other), analyzed in the
-- background by a file/vision-capable agent into structured markers + summary.
-- The binary lives on disk under data/uploads/; file_path points at it.
CREATE TABLE IF NOT EXISTS health_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  kind TEXT,                          -- bloodwork | dexa | other
  doc_date TEXT,                      -- the test date (YYYY-MM-DD)
  original_name TEXT,
  mime TEXT,
  file_path TEXT,                     -- absolute path to the stored binary (NULL for client-recorded analyses / derived panels)
  parsed_json TEXT,                   -- extracted markers/structured JSON
  summary TEXT,
  enrichment_status TEXT,             -- pending | in_progress | done | failed | skipped (NULL = n/a)
  source_doc_id INTEGER               -- the upload this dated panel was split out of (NULL = standalone / the source itself)
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
  archived INTEGER DEFAULT 0
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
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);

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
  op TEXT,                            -- which operation: day_read | session_suggest | nutrition_checkin | insight | coach_draft | ...
  agent TEXT,                         -- the agent that produced (or failed) this attempt
  ok INTEGER,                         -- 1 = produced a usable parsed result
  parsed INTEGER,                     -- 1 = output parsed as JSON
  latency_ms INTEGER,                 -- wall-clock for this attempt
  tried_json INTEGER,                 -- 1 = the one-shot JSON-repair retry was used
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at);

-- Tiny generic key/value scratchpad for scheduler bookkeeping (last-run stamps
-- for the miss-tolerant coach draft + the weekly proactive passes). Survives a
-- restart so a missed slot still fires once when the process comes back up.
-- Regenerable — losing it just means a proactive pass might run one extra time.
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

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
`);

runMigrations(db);

// Indexes that reference migrated columns must be created after migrations so
// older local databases can boot and then add the columns they need.
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source_external
  ON activities(source, external_id)
  WHERE source IS NOT NULL AND external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_directives_feedback
  ON health_directives(source, marker, domain, directive_key, status);
`);

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
