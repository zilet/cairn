// Migrations v51–v100, plus the private helpers only these entries use. See
// `src/migrate.ts` for the ladder's rules and the runner that applies them.
//
// FROZEN TRANSFORMS. The four data-repair migrations here (v63, v87, v92, v97)
// call snapshots under `./frozen/`, not the live repo modules they were written
// against. A migration records what the ladder DID; importing live code would
// let a fresh install replay it against today's semantics.

import type { DatabaseSync } from "node:sqlite";
import { log } from "../log.js";
import { addColumn, hasTable, type Migration } from "./helpers.js";
import { retireSupersededExpectations } from "./frozen/v087-expectation-arbitration.js";
import { clampProposalProvenanceDates } from "./frozen/v092-proposal-provenance-clamp.js";
import { extractMeasuredRmr } from "./frozen/v063-measured-rmr.js";
import { repairOutcomeComparability } from "./frozen/v097-outcome-comparability.js";

// v96: a db-free read of stored training intent. Mirrors the shape
// normalizeTrainingIntent / getTrainingIntent understand, without importing
// those modules (they pull in db.ts and would close a boot-order cycle).
const MIGRATION_PRIORITIES = new Set(["longevity", "muscle", "leanness", "strength", "endurance"]);
const MIGRATION_ENDURANCE_ROLES = new Set(["none", "supporting", "co_primary", "primary"]);

function parseMigrationTrainingIntent(
  raw: unknown
): { priorities: string[]; endurance_role: string; source?: "explicit" | "derived" } | null {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.priorities)) return null;
  const priorities: string[] = [];
  for (const item of obj.priorities) {
    const priority = String(item ?? "")
      .trim()
      .toLowerCase();
    if (MIGRATION_PRIORITIES.has(priority) && !priorities.includes(priority)) priorities.push(priority);
    if (priorities.length === 5) break;
  }
  const role = String(obj.endurance_role ?? "")
    .trim()
    .toLowerCase();
  if (!priorities.length || !MIGRATION_ENDURANCE_ROLES.has(role)) return null;
  const sourceRaw = String(obj.source ?? "")
    .trim()
    .toLowerCase();
  const source = sourceRaw === "explicit" || sourceRaw === "derived" ? sourceRaw : undefined;
  return { priorities, endurance_role: role, ...(source ? { source } : {}) };
}

function muscleOrStrengthAheadOfEndurance(priorities: string[]): boolean {
  const endurance = priorities.indexOf("endurance");
  const endRank = endurance < 0 ? Number.POSITIVE_INFINITY : endurance;
  const muscle = priorities.indexOf("muscle");
  const strength = priorities.indexOf("strength");
  return (muscle >= 0 && muscle < endRank) || (strength >= 0 && strength < endRank);
}

/**
 * Mirror getTrainingIntent: normalizeTrainingIntent succeeding is what marks
 * `source: "explicit"`. The persisted JSON usually has no source marker, so
 * "the JSON exists and has priorities" is explicit. A derived marker, if
 * present, is not a stated hierarchy.
 */
function migrationStoredIntentIsExplicit(
  profile: { training_intent_json?: string | null } | null | undefined
): { priorities: string[]; endurance_role: string } | null {
  if (!profile) return null;
  const parsed = parseMigrationTrainingIntent(profile.training_intent_json);
  if (!parsed || parsed.source === "derived") return null;
  return parsed;
}

function migrationIntentIsStrengthLed(
  profile: { training_intent_json?: string | null; primary_discipline?: string | null } | null | undefined
): boolean {
  const explicit = migrationStoredIntentIsExplicit(profile);
  if (!explicit) return false;
  if (explicit.endurance_role !== "none" && explicit.endurance_role !== "supporting") return false;
  return muscleOrStrengthAheadOfEndurance(explicit.priorities);
}

// ---- v82 data repair: fossilized plan_items.note / daily_session_compositions.why
// prose from three retired code generations (found live via direct DB inspection,
// never inferred from code — see the round's audit notes). Every branch matches a
// PRECISE, previously-verified shape and is a no-op on a note it doesn't recognize
// — nothing here blanks a note it can't confidently identify. Safe to run twice:
// each guard tests the CURRENT shape of the text before touching it, so a row
// already repaired (by an earlier pass of this same migration, or in the ordinary
// course by the now-fixed addCoachAdjustmentNote in repo/plan.ts) simply fails
// every guard on the second pass.

// (a) Gen-1's doubled rotation clause: the exercise name and the "start light"
// instruction each appear twice, one full clause nested inside the other. `\1`
// is a literal backreference to whatever the first capture matched, so this is
// safe even though exercise names are free text.
const GEN1_DOUBLED_ROTATION_NOTE =
  /^Rotated in for (.+?) — Rotate a same-pattern variation in for \1\. — start light, log your actual working weight\.$/;

// (c) A stacked, frozen "moment" narrative (an old progression-hold layer) that
// outlived the moment it described — it never gets superseded because nothing
// re-triggers that exact branch, so it just sits there indefinitely.
const FROZEN_PROGRESSION_COACH_NOTE =
  "Coach note: Strength has been slipping — back the load off about 10% and let it rebuild on a clean run.";

// (b) A note clamped mid-word at exactly the old 500-char column budget (the bug
// fixed in addCoachAdjustmentNote). Trim back to the last complete sentence.
function trimToLastSentence(text: string): string {
  const lastPunct = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"));
  if (lastPunct <= 0) return text; // no sentence boundary to trim back to — leave it alone
  return text.slice(0, lastPunct + 1);
}

function repairPlanItemNote(note: string): string | null {
  if (note === FROZEN_PROGRESSION_COACH_NOTE) return null; // no base note beneath it
  const frozenLayer = `\n${FROZEN_PROGRESSION_COACH_NOTE}`;
  if (note.endsWith(frozenLayer)) return note.slice(0, -frozenLayer.length);

  const doubled = note.match(GEN1_DOUBLED_ROTATION_NOTE);
  if (doubled) return `Rotated in for ${doubled[1]} — start light, log your actual working value.`;

  if (note.length === 500 && !/[.!?]$/.test(note)) {
    const trimmed = trimToLastSentence(note);
    if (trimmed !== note) return trimmed;
  }

  return note;
}

function repairPlanItemNotes(db: DatabaseSync) {
  if (!hasTable(db, "plan_items")) return;
  const rows = db.prepare(`SELECT id, note FROM plan_items WHERE note IS NOT NULL`).all() as Array<{
    id: number;
    note: string;
  }>;
  const update = db.prepare(`UPDATE plan_items SET note = ? WHERE id = ?`);
  for (const row of rows) {
    const repaired = repairPlanItemNote(row.note);
    if (repaired !== row.note) update.run(repaired, row.id);
  }
}

// Same machine-register bug, one layer up: the session header's `why`. These two
// exact literals are what planSnapshot() (repo/adaptive-session.ts) used to write
// before this round — kept here as plain strings (not imported) so this migration
// never depends on a live repo module's current wording. The replacements are
// index 0 of that file's SESSION_WHY_OVERRIDE / SESSION_WHY_ROTATION variant sets;
// keep these three in sync if that wording changes again.
const LEGACY_OVERRIDE_WHY = /^Explicit plan-day override: Day \d+\.$/;
const LEGACY_ADAPTIVE_WHY = /^Adaptive plan selection for \d{4}-\d{2}-\d{2}\.$/;

function repairSessionCompositionWhy(db: DatabaseSync) {
  if (!hasTable(db, "daily_session_compositions")) return;
  const rows = db.prepare(`SELECT id, why FROM daily_session_compositions WHERE why IS NOT NULL`).all() as Array<{
    id: number;
    why: string;
  }>;
  const update = db.prepare(`UPDATE daily_session_compositions SET why = ? WHERE id = ?`);
  for (const row of rows) {
    if (LEGACY_OVERRIDE_WHY.test(row.why)) update.run("Your call today.", row.id);
    else if (LEGACY_ADAPTIVE_WHY.test(row.why)) update.run("Today's regular spot in the rotation.", row.id);
  }
}

// ---- v83: what v82's live run left behind. v82 applied ONE transform per row
// and returned — so on a 500-clamped note the mid-word trim ran first, and
// trimming back to the last full sentence EXPOSED a frozen "slipping" layer as
// the new terminal text that was never re-checked. It also only stripped that
// layer in terminal position (a stack with the layer FIRST survived), and its
// gen-1 rotation pattern demanded the "working weight" suffix while a hybrid
// generation wrote "working value". All three shapes were found live after v82
// ran. v83 composes its transforms instead of returning after the first match,
// filters the frozen layer LINE-WISE so position in the stack is irrelevant,
// and accepts either gen-1 suffix. Idempotent for the same reason as v82: every
// guard tests the current text.
const GEN1_DOUBLED_ROTATION_NOTE_ANY_SUFFIX =
  /^Rotated in for (.+?) — Rotate a same-pattern variation in for \1\. — start light, log your actual working (?:weight|value)\.\s*$/;

function repairPlanItemNoteV83(note: string): string | null {
  // (1) Drop the frozen progression layer wherever it sits in the stack.
  const lines = note.split("\n").filter((line) => line.trim() !== FROZEN_PROGRESSION_COACH_NOTE);
  let repaired = lines.join("\n").trim();
  if (!repaired) return null;

  // (2) Gen-1 doubled rotation clause, either generation's closing word.
  const doubled = repaired.match(GEN1_DOUBLED_ROTATION_NOTE_ANY_SUFFIX);
  if (doubled) repaired = `Rotated in for ${doubled[1]} — start light, log your actual working value.`;

  return repaired;
}

function repairPlanItemNotesV83(db: DatabaseSync) {
  if (!hasTable(db, "plan_items")) return;
  const rows = db.prepare(`SELECT id, note FROM plan_items WHERE note IS NOT NULL`).all() as Array<{
    id: number;
    note: string;
  }>;
  const update = db.prepare(`UPDATE plan_items SET note = ? WHERE id = ?`);
  for (const row of rows) {
    const repaired = repairPlanItemNoteV83(row.note);
    if (repaired !== row.note) update.run(repaired, row.id);
  }
}

export const MIGRATIONS_051_100: Migration[] = [
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
      //
      // json_extract() THROWS (and aborts the whole statement) on malformed JSON,
      // and — per review — the query planner is not guaranteed to evaluate the
      // kind/date predicates before it reaches a bad row, even though it does for
      // this exact shape today. `payload_json IS NOT NULL AND json_valid(payload_json)`
      // guards every json_extract() call below (both in the DELETE and its
      // subquery) so a malformed or NULL payload can never blow up the migration —
      // that row is simply excluded from the canonical pool: never deleted (we
      // can't prove what it is), and never eligible to be picked as the MIN(id)
      // survivor either (a NULL/malformed row winning that slot would delete every
      // REAL read for its date out from under it — the sharper of the two bugs).
      //
      // No try/catch around the DELETE: a genuine failure must not be swallowed
      // into a silent "applied, did nothing". runMigrations wraps every up() in
      // BEGIN/ROLLBACK-on-throw and only stamps PRAGMA user_version after up()
      // returns cleanly, so letting an unexpected error propagate is what makes a
      // real failure loud instead of a phantom success. The one deliberately
      // absorbed case is the table not existing yet at all (an old/partial schema,
      // or a minimal test fixture) — checked explicitly via sqlite_master, not by
      // catching whatever the DELETE happens to throw.
      const hasSuggestionsTable = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'suggestions'`)
        .get();
      if (!hasSuggestionsTable) return;
      db.exec(`
        DELETE FROM suggestions
         WHERE kind = 'day_read'
           AND date IS NOT NULL
           AND payload_json IS NOT NULL
           AND json_valid(payload_json)
           AND json_extract(payload_json, '$.override') IS NULL
           AND id NOT IN (
             SELECT MIN(id) FROM suggestions
              WHERE kind = 'day_read'
                AND date IS NOT NULL
                AND payload_json IS NOT NULL
                AND json_valid(payload_json)
                AND json_extract(payload_json, '$.override') IS NULL
              GROUP BY date
           )
      `);
    },
  },
  {
    version: 79,
    name: "food-notes-eaten-at",
    // The LOCAL wall-clock time ("HH:MM", 24-hour) a meal was eaten, when the
    // athlete stated one. Purely additive and nullable: `date` still owns the
    // local calendar day and `created_at` still owns the UTC instant of the
    // write, so every existing row keeps reading exactly as it did with
    // eaten_at NULL — no time is, and stays, first-class.
    up: (db) => addColumn(db, "food_notes", "eaten_at TEXT"),
  },
  {
    version: 80,
    name: "profile-training-intent",
    up: (db) => {
      // Nullable by design: existing athletes derive the old discipline/goal-mode
      // behavior until they explicitly save an ordered durable intent.
      addColumn(db, "profile", "training_intent_json TEXT");
    },
  },
  {
    version: 81,
    name: "profile-home-location",
    up: (db) => {
      // Durable home base only. Temporary travel remains a dated context_event
      // with meta.location and never overwrites this profile identity.
      addColumn(db, "profile", "home_location TEXT");
    },
  },
  {
    version: 82,
    name: "plan-item-note-prose-repair",
    // Pure data repair — no schema change. See the repair functions above for
    // exactly what each of the three fossil patterns looked like and why each
    // guard is precise rather than a blanket clamp/strip.
    up: (db) => {
      repairPlanItemNotes(db);
      repairSessionCompositionWhy(db);
    },
  },
  {
    version: 83,
    name: "plan-item-note-prose-repair-2",
    // The three shapes v82's single-transform pass left behind on the live
    // instance — see repairPlanItemNoteV83 above.
    up: (db) => repairPlanItemNotesV83(db),
  },
  {
    version: 84,
    name: "garmin-wear-quality-repair",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // Two classes of junk already sitting in garmin_daily_metrics, both of which
    // the ingest guards (src/garmin.ts) now reject at the source:
    //   1. Resting HR derived from the DAILY SUMMARY on a day the watch was not
    //      worn overnight. Garmin computes that figure from the lowest HR it saw
    //      all day, so daytime-only wear reports 90–120 against a true 52–60.
    //      A row with no sleep recorded and no low-HR minute is exactly that case.
    //      A stored min_hr that is itself junk — a negative sentinel, or a zero from
    //      a dropped HR trace — cannot vouch for anything either, so it is treated
    //      the same as a missing one rather than as a very low resting minute.
    //   2. Negative "no data" sentinels (-1, -2) stored raw on metrics that are
    //      physically non-negative — averageStressLevel: -1 is the common one.
    // Idempotent: every statement is a guarded UPDATE that no longer matches once
    // it has run. The 30 / 65 / 90 thresholds mirror RHR_PLAUSIBLE_MIN,
    // RHR_REST_COVERAGE_MAX_HR and RHR_PLAUSIBLE_MAX in src/garmin.ts; they are
    // inlined rather than imported because db.ts runs this ladder on import and sits
    // BELOW garmin.ts in the graph — importing upward would close a cycle.
    up: (db) => {
      try {
        db.prepare(
          `UPDATE garmin_daily_metrics
              SET resting_hr = NULL
            WHERE resting_hr IS NOT NULL
              AND sleep_min IS NULL
              AND (min_hr IS NULL OR min_hr < 30 OR min_hr > 65 OR resting_hr > 90 OR resting_hr < 30)`
        ).run();
      } catch {
        /* table absent on an ancient DB — nothing to repair */
      }
      for (const column of [
        // min_hr/max_hr carry the same sentinel. The pass above already treats a
        // negative min_hr as no witness at all, so either order repairs the same
        // rows; these are here so the stored trace itself stops reading as a real
        // (impossibly low) heart rate.
        "min_hr",
        "max_hr",
        "stress_avg",
        "stress_max",
        "body_battery_charged",
        "body_battery_drained",
        "body_battery_max",
        "body_battery_min",
        "body_battery_avg",
        "spo2_avg",
        "spo2_min",
        "respiration_avg",
        "respiration_min",
        "respiration_max",
        "training_readiness",
        "steps",
        "active_calories",
        "total_calories",
        "bmr_calories",
        "floors_climbed",
        "distance_m",
        "intensity_min_moderate",
        "intensity_min_vigorous",
        "restless_count",
        "avg_sleep_stress",
        "sleep_score",
      ]) {
        try {
          db.prepare(`UPDATE garmin_daily_metrics SET ${column} = NULL WHERE ${column} < 0`).run();
        } catch {
          /* column may not exist on an older ladder position */
        }
      }
    },
  },
  {
    version: 85,
    name: "day-read-entity-decode",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // Agent-authored Brief prose arrived HTML-escaped and nothing stopped it: the
    // live deployment stores a headline reading `Push session &amp; run complete`,
    // which the PWA then escapes a SECOND time for rendering, so the athlete reads
    // the entity itself. The intake guard now decodes on the way in
    // (decodeDayReadAgentProse, src/dayread.ts); this decodes what is already stored.
    //
    // `&amp;` is decoded LAST, exactly as the runtime helper does it — decoding it
    // first would turn a stored `&amp;lt;` into `<` in one hop, which is the
    // double-decode the runtime guard rejects rather than performs. Idempotent for
    // singly-escaped text (the only shape observed): a second run finds no entity
    // left and matches no row.
    up: (db) => {
      const decode = (column: string) =>
        `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column},` +
        ` '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&nbsp;', ' '), '&amp;', '&')`;
      for (const column of ["headline", "why", "focus"]) {
        try {
          db.prepare(
            `UPDATE day_reads
                SET ${column} = ${decode(column)}
              WHERE ${column} IS NOT NULL
                AND (${column} LIKE '%&amp;%' OR ${column} LIKE '%&lt;%' OR ${column} LIKE '%&gt;%'
                     OR ${column} LIKE '%&quot;%' OR ${column} LIKE '%&#39;%' OR ${column} LIKE '%&nbsp;%')`
          ).run();
        } catch {
          /* column absent on an ancient DB — nothing to repair */
        }
      }
    },
  },
  {
    version: 86,
    name: "directive-soft-resolve-compaction",
    // Pure data repair — no schema change, so no db.ts counterpart (a fresh DB has no
    // rows to compact and is already in the post-migration shape).
    //
    // HISTORY, NOT A LIVE BUG. Before the diff-based reconcile landed
    // (reconcileDirectives, src/repo/coach.ts), every propagation pass soft-resolved its
    // own output and wrote it again, so a handful of live findings left ~1000 resolved
    // 'markers' rows in bursts of 300+ a day. The engine has churned zero rows since;
    // this clears the pile that engine already left behind.
    //
    // DELIBERATELY NARROW — three guards, each load-bearing:
    //
    //  1. `status_at IS NULL` — a MACHINE soft-resolve, never a user action. The
    //     learning consumers filter on `status_at IS NOT NULL` (lastDirectiveFeedback
    //     and directiveFeedbackForCoach in propagation.ts, sinceLast, the reaction
    //     model's intervention list), so nothing removed here was ever visible to
    //     them at all. USER feedback — a Done or a Dismiss, which suppresses a
    //     directive from resurfacing and dates an intervention — is never touched,
    //     however duplicated it looks.
    //     The HISTORY consumers do read these rows — `listDirectives({all:true})`
    //     feeds the learned timeline (repo/learned-timeline.ts), the health-outcome
    //     annotations (repo/health-outcomes.ts) and the `?all=1` REST/MCP listing.
    //     For them the deletion is not merely safe but favourable: guard 2 partitions
    //     on the full trigger snapshot, so every row it drops is informationally
    //     identical to the keeper — the timeline showed the same sentence a hundred
    //     times over, and the annotation pass deduped them again on its own key.
    //     One nuance: intent_key, rationale, citation and uncertain sit OUTSIDE the
    //     partition, so a group collapses onto the EARLIEST row's wording of those.
    //     That is the intended reading of a machine re-derive (the first time the
    //     brain reached this conclusion), and the directive text itself — the part a
    //     person reads — is inside the partition and therefore identical either way.
    //  2. EXACT duplicates only: same directive_key, text, domain, marker AND the same
    //     trigger snapshot. Two resolves of the same advice at different marker values
    //     are two different facts and both survive.
    //  3. Nothing referenced by `resurfaced_from_id`. That chain should only ever point
    //     at a status_at-stamped row, but a legacy row predating the intent-key engine
    //     could break the rule, and a dangling audit link is worse than a duplicate.
    //
    // 'health_review' rows are left alone entirely — that source clears and rewrites
    // only its own rows, and its history is agent-authored rather than machine churn.
    //
    // Idempotent: the keeper is the earliest `created_at` in each group, so a second run
    // finds one row per group and matches nothing.
    up: (db) => {
      try {
        db.prepare(
          `DELETE FROM health_directives
            WHERE id IN (
                  SELECT id FROM (
                         SELECT id, ROW_NUMBER() OVER (
                                  PARTITION BY COALESCE(directive_key, ''), COALESCE(directive, ''),
                                               COALESCE(domain, ''), COALESCE(marker, ''),
                                               COALESCE(trigger_value, ''), COALESCE(trigger_side, ''),
                                               COALESCE(trigger_date, '')
                                      ORDER BY created_at ASC, id ASC
                                ) AS rn
                           FROM health_directives
                          WHERE source = 'markers' AND status = 'resolved' AND status_at IS NULL
                       )
                   WHERE rn > 1
                 )
              AND id NOT IN (
                  SELECT resurfaced_from_id FROM health_directives WHERE resurfaced_from_id IS NOT NULL
                 )`
        ).run();
      } catch {
        /* an ancient DB without the directive columns has no churn to compact */
      }
    },
  },
  {
    version: 87,
    name: "expectation-overlap-arbitration",
    // Pure data repair — no schema change, so no db.ts counterpart. A fresh DB has no rows
    // to arbitrate and every row it will write goes through insertBrainExpectation, which
    // applies this same rule at write time.
    //
    // THE ROWS THIS EXISTS FOR. `overlappingDecisionConfounders` forces an inconclusive
    // verdict on any expectation whose window overlaps another live decision's over the same
    // metric + subject, and the writers open windows far faster than 14-28 day windows close.
    // The result on the live deployment was mutual annihilation: 82 pending expectations
    // against 5 evaluated, and exactly two conclusive verdicts in the ledger's entire
    // lifetime — both on `day_read_adherence`, the one metric whose windows are a single day
    // and therefore never overlap. Stacks of six windows stood open on one exercise.
    // Supersede-on-write stops new stacks forming; this retires the ones already standing so
    // the newest window in each can finally answer for itself.
    //
    // Same helper as the write path, deliberately: retireSupersededExpectations owns the rule
    // once (src/repo/brain/expectation-arbitration.ts) so a repair and a write cannot come to
    // different conclusions about who owns a metric. It takes the handle rather than reaching
    // for the db singleton, which is what lets a migration call it at all — db.ts statically
    // imports this module.
    //
    // Idempotent by construction: a survivor is a row that loses to nobody, so a second pass
    // finds no pairs and updates nothing. Precedent for the underlying rule is
    // recordBlockDecision (src/repo/program-blocks.ts:180-183), which has always refused to
    // open a second `vo2max_trend` window over a live one.
    up: (db) => {
      try {
        retireSupersededExpectations(db);
      } catch {
        /* a DB predating the brain ledger has no windows to arbitrate */
      }
    },
  },
  {
    version: 88,
    name: "symptom-scope-and-inferred-evidence",
    // Two columns, one round. `symptom_reports` is a brand-new table so it needs no
    // entry here (db.ts's CREATE TABLE IF NOT EXISTS covers fresh and existing DBs
    // alike); these two ALTERs are the half that a CREATE can never reach.
    //
    // scope: every row written before today meant 'area' — a named place that may
    // load a lift — so the default is not a guess, it is what those rows already say.
    // 'systemic' is the new thing an athlete could not previously express at all.
    //
    // evidence: every observation on record came from an athlete tapping a button, so
    // 'stated' is likewise the honest backfill. 'inferred' is reserved for the quiet
    // tolerated exposures the session-finish pass now records, and the distinction is
    // load-bearing — silence is not confirmation, and the surfaces must be able to say
    // so. Each ALTER guards itself, so a fresh DB (where db.ts already created both
    // columns) and a second pass are both clean no-ops.
    up: (db) => {
      addColumn(
        db,
        "training_symptom_events",
        "scope TEXT NOT NULL DEFAULT 'area' CHECK (scope IN ('area','systemic'))"
      );
      addColumn(
        db,
        "movement_tolerance_observations",
        "evidence TEXT NOT NULL DEFAULT 'stated' CHECK (evidence IN ('stated','inferred'))"
      );
    },
  },
  {
    version: 89,
    name: "settings-training-drive",
    // The athlete's standing posture toward the accumulated-load rest, beside
    // lead_mode (v59) and read the same way: a PREFERENCE that sets which reads are
    // available, never one that can produce a read the evidence does not support.
    // 'steady' is what every existing row has always meant, so the default is the
    // backfill rather than a guess. Idempotent — a fresh DB already has the column
    // from db.ts's CREATE TABLE, and addColumn guards the second pass.
    up: (db) => addColumn(db, "settings", "training_drive TEXT DEFAULT 'steady'"),
  },
  {
    version: 90,
    name: "insight-intent-key",
    // WHAT an insight connects, so a genuine rephrase of a connection already made
    // can be refused — text dedup only ever caught rewordings. Nullable with no
    // default and no CHECK: the vocabulary lives in src/repo/insight-intent.ts and
    // will keep growing, and a schema constraint would freeze it at today's list.
    //
    // DELIBERATELY NOT BACKFILLED. Legacy rows keep a NULL key and have one derived
    // from their text at READ time (insightIntentCorpus), so every later improvement
    // to derivation improves them retroactively — a backfill would instead freeze
    // today's weaker derivation into the table. Idempotent: a fresh DB already has
    // the column from db.ts, and addColumn guards the second pass.
    up: (db) => addColumn(db, "insights", "intent_key TEXT"),
  },
  {
    version: 91,
    name: "day-read-expectations-heal",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // THE ROWS THIS EXISTS FOR. Every day-read decision used to be fingerprinted off
    // the read's INPUTS, so a mid-day recompute reaching the very same call still wrote
    // a new immutable row, superseded the morning's, and cancelled the pending
    // prediction riding on it. On the live deployment that cancelled 13 of 22
    // day_read_adherence expectations: the ledger's highest-frequency learning signal,
    // thrown away by its own recompute loop. The writer no longer creates the state
    // (the fingerprint hashes the CLAIM now) and the evaluator no longer reads it that
    // way (dayReadExpectationSurvivesSupersession); this puts the rows already written
    // back to `pending` so the nightly pass can finally judge the days they ask about.
    //
    // WHICH ROWS. Only `day_read_adherence`, only rows that were cancelled, and only
    // where the whole supersession chain behind them is built of successors that never
    // took the claim away: a non-predictive `done` acknowledgement, or a later read
    // making the SAME call. A genuine change of call (rest → train) stays cancelled,
    // which is exactly what it should be.
    //
    // brain_evaluations is APPEND-ONLY and nothing here deletes from it. A stored
    // `canceled` verdict remains as history; sameEvaluation (evaluation-service.ts)
    // appends the new verdict beside it and every reader takes the newest.
    //
    // DIAGNOSTICS ONLY. readAdherenceModel reads the training log, never a verdict, so
    // nothing this touches can change what the Brief says — only what the loop is able
    // to learn from.
    //
    // Idempotent by construction: a second pass finds the rows already `pending`, which
    // the status filter excludes.
    up: (db) => {
      try {
        db.exec(`
          WITH RECURSIVE chain(root_id, own_kind, node_id, bad, depth) AS (
            SELECT root.id,
                   json_extract(root.action_json, '$.kind'),
                   successor.id,
                   CASE
                     WHEN successor.kind <> 'day_read' OR successor.source_ref_type <> 'day_read' THEN 1
                     WHEN json_extract(successor.action_json, '$.kind') IN ('train','easy','rest')
                      AND json_extract(successor.action_json, '$.kind')
                          IS NOT json_extract(root.action_json, '$.kind') THEN 1
                     ELSE 0
                   END,
                   1
              FROM brain_decisions root
              JOIN brain_decisions successor ON successor.id = root.superseded_by
             WHERE root.kind = 'day_read' AND root.source_ref_type = 'day_read'
            UNION ALL
            SELECT chain.root_id,
                   chain.own_kind,
                   successor.id,
                   CASE
                     WHEN successor.kind <> 'day_read' OR successor.source_ref_type <> 'day_read' THEN 1
                     WHEN json_extract(successor.action_json, '$.kind') IN ('train','easy','rest')
                      AND json_extract(successor.action_json, '$.kind') IS NOT chain.own_kind THEN 1
                     ELSE 0
                   END,
                   chain.depth + 1
              FROM chain
              JOIN brain_decisions node ON node.id = chain.node_id
              JOIN brain_decisions successor ON successor.id = node.superseded_by
             WHERE chain.depth < 20
          )
          UPDATE brain_expectations
             SET status = 'pending'
           WHERE metric_key = 'day_read_adherence'
             AND status IN ('canceled', 'evaluated')
             AND (
               status = 'canceled'
               OR EXISTS (
                 SELECT 1 FROM brain_evaluations latest
                  WHERE latest.expectation_id = brain_expectations.id
                    AND latest.verdict = 'canceled'
                    AND latest.id = (
                      SELECT newest.id FROM brain_evaluations newest
                       WHERE newest.expectation_id = brain_expectations.id
                       ORDER BY newest.evaluated_at DESC, newest.id DESC LIMIT 1
                    )
               )
             )
             AND decision_id IN (SELECT root_id FROM chain)
             AND decision_id NOT IN (SELECT root_id FROM chain WHERE bad = 1)
        `);
      } catch {
        /* a DB predating the brain ledger has no cancelled predictions to heal */
      }
    },
  },
  {
    version: 92,
    name: "proposal-provenance-future-evidence-clamp",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // THE ROWS THIS EXISTS FOR. `inferredEvidenceDate` used to take the first ISO date
    // it found in a reason's prose and write it into reason_provenance unclamped. A
    // reason that names a forward WINDOW ("suspend Z4 for 2026-08-09 → 2026-08-22")
    // therefore stored an evidence_date in its own future. Nothing caught it on the way
    // in, and every later rehydration of that row threw "evidence_date cannot be after
    // as_of_date" — which took down the whole listProposals call, and with it the
    // scheduler's draft-adoption sweep, on every tick. The write path now clamps the
    // inference and the read path clamps instead of throwing; this pulls the payloads
    // already on disk back onto the same law so they stop being a live hazard.
    //
    // WHAT IT CHANGES. Only `evidence_date` values that sit strictly after their OWN
    // `as_of_date`, moved down to that as_of_date. No row is deleted, no reason prose is
    // rewritten, no as_of_date is touched, and a payload with consistent dates is left
    // byte-identical (it is only re-serialized when the clamp actually moved something).
    //
    // Per-row try/catch: one unparseable parsed_json must not stop the repair of the
    // rest. Idempotent by construction — the second pass finds every evidence_date at
    // or below its as_of and writes nothing.
    up: (db) => {
      let rows: any[] = [];
      try {
        rows = db.prepare(`SELECT id, parsed_json FROM plan_proposals WHERE parsed_json IS NOT NULL`).all() as any[];
      } catch {
        return; /* a DB predating plan_proposals has nothing to repair */
      }
      const update = db.prepare(`UPDATE plan_proposals SET parsed_json = ? WHERE id = ?`);
      for (const row of rows) {
        try {
          const parsed = JSON.parse(String(row.parsed_json));
          if (!clampProposalProvenanceDates(parsed)) continue;
          update.run(JSON.stringify(parsed), Number(row.id));
        } catch {
          /* an unparseable payload is left exactly as stored; hydration quarantines it */
        }
      }
    },
  },
  {
    version: 93,
    name: "surface-dismissals",
    // A Today-agenda card dismiss or an insight marked 'dismissed' is now evidence,
    // not a client-only removal — see src/repo/surface-dismissals.ts. New table, so
    // this is CREATE TABLE IF NOT EXISTS (also in db.ts for fresh DBs); idempotent by
    // construction.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS surface_dismissals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          surface TEXT NOT NULL,
          item_key TEXT NOT NULL,
          date TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_dismissals_unique
          ON surface_dismissals(surface, item_key, date);
        CREATE INDEX IF NOT EXISTS idx_surface_dismissals_lookup
          ON surface_dismissals(surface, item_key);
      `);
    },
  },
  {
    version: 94,
    name: "belief-dispositions",
    // Brand-new table (W3.6 inspectable beliefs) — db.ts's own CREATE TABLE IF NOT
    // EXISTS already covers every boot, migrated or not, so this entry is a
    // reservation/marker rather than a functional requirement: it exists so the
    // round's version ledger accounts for the schema change, and so a DB that
    // somehow ran an older db.ts snapshot without the table still gets it on the
    // next boot. Idempotent by construction (IF NOT EXISTS); no db.ts counterpart
    // beyond the CREATE TABLE that already lives there.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS belief_dispositions (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disputed')),
          disputed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 95,
    name: "assisted-sign-repair",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // THE ROWS THIS EXISTS FOR. An assisted lift stores assist as a NEGATIVE
    // weight. The client sends a plain signed number, so a typing slip of +40 on
    // a lift that had been −25/−30/−40 assist stored a loaded +40. Re-ground
    // then moved the plan target from −25 to +40, prefill made every later set
    // weighted, and the e1RM trend read as regressing because Epley ran on the
    // flipped rows.
    //
    // WHAT IT CHANGES. For exercises whose name matches /\bassist(ed)?\b/i:
    // a logged_sets row with weight > 0 that has an earlier negative-weight set
    // on the same exercise AND whose magnitude is within 1.5× of the max assist
    // magnitude of the prior 60 days is flipped to −weight. Epley is computed
    // at read time and never runs on weight ≤ 0, so there is no est_1rm column
    // to clear. plan_items of those exercises whose target_weight > 0 sits in
    // the same band are flipped the same way. Idempotent: a second pass finds
    // no matching positive rows.
    up: (db) => {
      const assistName = /\bassist(ed)?\b/i;
      const dayShift = (iso: string, days: number): string => {
        const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };
      let flippedSets = 0;
      let flippedPlans = 0;
      try {
        const exercises = db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>;
        for (const ex of exercises) {
          if (!assistName.test(String(ex.name ?? ""))) continue;
          let sets: Array<{ id: number; weight: number; date: string }> = [];
          try {
            sets = db
              .prepare(
                `SELECT ls.id AS id, ls.weight AS weight, s.date AS date
                   FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
                  WHERE ls.exercise_id = ? AND ls.weight IS NOT NULL`
              )
              .all(ex.id) as Array<{ id: number; weight: number; date: string }>;
          } catch {
            continue;
          }
          for (const row of sets) {
            const w = Number(row.weight);
            if (!Number.isFinite(w) || w <= 0) continue;
            const date = String(row.date ?? "").slice(0, 10);
            const earlierNegative = sets.some((s) => Number(s.weight) < 0 && String(s.date).slice(0, 10) < date);
            if (!earlierNegative) continue;
            const windowStart = dayShift(date, -60);
            const priorMags = sets
              .filter((s) => {
                const d = String(s.date).slice(0, 10);
                return Number(s.weight) < 0 && d < date && d >= windowStart;
              })
              .map((s) => Math.abs(Number(s.weight)));
            if (!priorMags.length) continue;
            const maxMag = Math.max(...priorMags);
            if (w > maxMag * 1.5) continue;
            try {
              db.prepare(`UPDATE logged_sets SET weight = -ABS(weight) WHERE id = ?`).run(row.id);
              flippedSets++;
            } catch {
              /* row disappeared under us — skip */
            }
          }
          const negMags = sets
            .map((s) => Number(s.weight))
            .filter((w) => Number.isFinite(w) && w < 0)
            .map((w) => Math.abs(w));
          if (!negMags.length) continue;
          const band = Math.max(...negMags) * 1.5;
          try {
            const items = db
              .prepare(
                `SELECT id, target_weight FROM plan_items
                  WHERE exercise_id = ? AND target_weight IS NOT NULL AND target_weight > 0`
              )
              .all(ex.id) as Array<{ id: number; target_weight: number }>;
            for (const item of items) {
              const tw = Number(item.target_weight);
              if (!Number.isFinite(tw) || tw <= 0 || tw > band) continue;
              db.prepare(`UPDATE plan_items SET target_weight = -ABS(target_weight) WHERE id = ?`).run(item.id);
              flippedPlans++;
            }
          } catch {
            /* plan_items absent on an ancient DB */
          }
        }
      } catch {
        /* exercises/logged_sets absent — nothing to repair */
      }
      if (flippedSets || flippedPlans) {
        log.info(`[migrate] v95 assisted-sign-repair: ${flippedSets} logged_sets, ${flippedPlans} plan_items`);
      }
    },
  },
  {
    version: 96,
    name: "abandon-mismatched-endurance-base-blocks",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // THE ROWS THIS EXISTS FOR. ensureActiveBlock used to pick endurance-base
    // whenever a race sat inside the ~10-week build window, ignoring a stored
    // training intent whose endurance_role was none/supporting and whose
    // muscle/strength priorities sat ahead of endurance. Those blocks are the
    // live defect: week 1–2, still active, focus endurance-base, goal prefixed
    // "Build toward " (the auto-derived label), on an athlete whose STATED
    // (explicit) intent is strength/muscle first. Mark them abandoned (keep
    // the row — provenance) so the next ensureActiveBlock call re-derives
    // through chooseBlockFocus. A hand-opened block (any other goal text), a
    // derived/NULL intent, a co_primary/primary athlete's block, a block
    // already into week 3+, and any non-endurance-base focus are left alone.
    //
    // Profile and intent are read through raw SQL. This file cannot import
    // repo/training-intent.ts (that module imports profile → db → here).
    // Idempotent: a second pass finds no matching ACTIVE row.
    up: (db) => {
      try {
        if (!hasTable(db, "program_blocks")) return;
        const profile = (() => {
          try {
            return db.prepare(`SELECT training_intent_json, primary_discipline FROM profile WHERE id = 1`).get() as
              | { training_intent_json?: string | null; primary_discipline?: string | null }
              | undefined;
          } catch {
            return undefined;
          }
        })();
        if (!migrationIntentIsStrengthLed(profile)) return;
        db.exec(`
          UPDATE program_blocks
             SET status = 'abandoned'
           WHERE status = 'active'
             AND focus = 'endurance-base'
             AND week_index <= 2
             AND goal LIKE 'Build toward %'
        `);
      } catch {
        /* a DB predating program_blocks / profile has nothing to repair */
      }
    },
  },
  {
    version: 97,
    name: "outcome-comparability-repair",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // THE ROWS THIS EXISTS FOR. daily-reconciliation used to treat a rest-day
    // train-anyway envelope as a recovery window because a regex ran over the
    // stored decision JSON (caps.intensity "deload", "recovery earns tomorrow's
    // work", template.focus "recovery"). recovery_dose then landed on every
    // lift, day-wide, so a month of work at or above the working load never
    // counted. Live: 0 recovery_cycles rows, yet most outcome rows carried
    // recovery_dose on every dose.
    //
    // WHAT IT CHANGES. For daily_session_outcomes in the last 60 days, drop a
    // stored recovery_dose reason when no recovery_cycles row (active/recheck
    // as of the date) and no applied recovery-week stamp covered that date.
    // Travel is left alone: a stored row cannot prove the prescription was a
    // reduced one. Idempotent: a second pass finds nothing left to drop. The
    // transform is repairOutcomeComparability so this migration and the runtime
    // cannot drift.
    up: (db) => {
      const dayShift = (iso: string, days: number): string => {
        const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };
      const cycleCovers = (date: string): boolean => {
        try {
          const row = db
            .prepare(
              `SELECT exit_on FROM recovery_cycles
                WHERE effective_on <= ?
                  AND (completed_at IS NULL OR substr(completed_at, 1, 10) > ?)
                  AND (canceled_at IS NULL OR substr(canceled_at, 1, 10) > ?)
                ORDER BY effective_on DESC, id DESC LIMIT 1`
            )
            .get(date, date, date) as { exit_on?: string } | undefined;
          if (!row) return false;
          return date < String(row.exit_on ?? "").slice(0, 10);
        } catch {
          return false;
        }
      };
      // The applied-week stamp is the other structured source runtime consults
      // (activeRecoveryWeekLedger). Read raw so this file stays free of repo/db
      // imports. A missing table or a date-only legacy stamp still counts.
      const appliedWeekCovers = (date: string): boolean => {
        try {
          const row = db.prepare(`SELECT value FROM app_state WHERE key = 'recovery_week_applied'`).get() as
            | { value?: string }
            | undefined;
          if (!row?.value) return false;
          let appliedOn = String(row.value).slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedOn)) {
            try {
              appliedOn = String(JSON.parse(row.value)?.applied_on ?? "").slice(0, 10);
            } catch {
              return false;
            }
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedOn)) return false;
          const until = dayShift(appliedOn, 7);
          return date >= appliedOn && date < until;
        } catch {
          return false;
        }
      };
      let repaired = 0;
      try {
        if (!hasTable(db, "daily_session_outcomes")) return;
        const today = new Date().toISOString().slice(0, 10);
        const cutoff = dayShift(today, -60);
        const rows = db
          .prepare(
            `SELECT id, date, facts_json FROM daily_session_outcomes
              WHERE date >= ? AND date <= ?`
          )
          .all(cutoff, today) as Array<{ id: number; date: string; facts_json: string }>;
        const update = db.prepare(`UPDATE daily_session_outcomes SET facts_json = ? WHERE id = ?`);
        for (const row of rows) {
          try {
            let facts: unknown;
            try {
              facts = JSON.parse(row.facts_json);
            } catch {
              continue;
            }
            const on = String(row.date).slice(0, 10);
            const next = repairOutcomeComparability(facts, {
              recovery: cycleCovers(on) || appliedWeekCovers(on),
            });
            const serialized = JSON.stringify(next);
            if (serialized === row.facts_json) continue;
            update.run(serialized, row.id);
            repaired++;
          } catch {
            /* one corrupt row never aborts the rest */
          }
        }
      } catch {
        /* daily_session_outcomes / recovery_cycles absent — nothing to repair */
      }
      if (repaired) {
        log.info(`[migrate] v97 outcome-comparability-repair: ${repaired} daily_session_outcomes`);
      }
    },
  },
  {
    version: 98,
    name: "strength-objectives-one-active-per-lift",
    // MULTI-ANCHOR OBJECTIVES. The anchor-lift journey shipped with a partial
    // unique index on `status` — literally one active objective in the whole
    // database. An athlete rebuilding squat, deadlift, row, bench, curl and
    // press in parallel could therefore hold exactly one of those six, and
    // naming the second silently superseded the first.
    //
    // The invariant becomes ONE ACTIVE ROW PER exercise_key. Additive and
    // non-destructive: no row is read, rewritten or deleted, so an existing
    // active objective survives untouched and simply stops blocking the others.
    // Idempotent — DROP ... IF EXISTS / CREATE ... IF NOT EXISTS both re-run
    // cleanly, and the db.ts CREATE TABLE block already carries the new index
    // for fresh databases.
    up: (db) => {
      // The only legitimate no-op is a DB predating the table — checked EXPLICITLY via
      // sqlite_master rather than by swallowing every error. A try/catch around both
      // statements could commit a DROP whose CREATE failed, leaving the table with NO
      // uniqueness at all and the version stamped, so no retry would ever run it again.
      // Any real SQL error now propagates and runMigrations' transaction rolls back.
      if (!hasTable(db, "strength_objectives")) return;
      db.exec(`DROP INDEX IF EXISTS idx_strength_objectives_one_active`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_strength_objectives_one_active_per_lift
                 ON strength_objectives(exercise_key) WHERE status = 'active'`);
    },
  },
  {
    version: 99,
    name: "plan-days-day-type",
    // THE REST DAY BECOMES FIRST-CLASS. Until now a week template could only say
    // "train" — a rest day existed by being absent, so a seven-day template of
    // five lifting days and two runs had no seam anywhere in it, and the day
    // selector surfaced a training day on every calendar day of the year.
    //
    // `day_type` is additive and defaulted, so every existing row reads exactly as
    // it did before: an untouched plan is a plan of training days. Nothing is
    // rewritten and nothing is deleted. The one invariant the writers enforce on
    // top of the column is that a 'rest' day carries no plan_items — which no
    // existing row can violate, because no existing row is a rest day.
    up: (db) => addColumn(db, "plan_days", "day_type TEXT NOT NULL DEFAULT 'training'"),
  },
  {
    version: 100,
    name: "exercise-garmin-mapping",
    // STRENGTH WRITE-BACK NEEDS A RESOLVED FIT ENUM PER LIFT. Garmin only accepts
    // a set whose exercise is a member of its own two-level FIT enum (a category,
    // plus an optional sub-exercise under it), so every lift Cairn wants to push
    // has to carry the pair it resolved to. It is stored on the row rather than
    // re-derived per export so a hand-corrected or agent-refined mapping survives,
    // and so an unmappable movement is remembered as unmappable instead of being
    // re-scored on every sync.
    //
    // Purely additive: three nullable columns. An existing row reads exactly as it
    // did (no mapping ⇒ nothing is exported for that lift), and findOrCreateExercise
    // fills the deterministic pair on the next insert. Nothing is rewritten, nothing
    // is deleted, and the write-back toggle itself lives in `settings` (whose own
    // column repair adds garmin_export_strength).
    up: (db) => {
      addColumn(db, "exercises", "garmin_category TEXT");
      addColumn(db, "exercises", "garmin_exercise TEXT");
      addColumn(db, "exercises", "garmin_map_status TEXT");
    },
  },
];
