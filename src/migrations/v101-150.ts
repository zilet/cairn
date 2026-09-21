// Migrations v101–v150. See `src/migrate.ts` for the ladder's rules (append-only,
// dense integer versions, no down-migrations) and the runner that applies them.
//
// To add one, append an entry here with the next integer version. Then do the
// schema two-step: the matching column must ALSO appear in that table's
// `CREATE TABLE IF NOT EXISTS` in `src/db.ts`, or a fresh database never gets it.
// `npm run schema:check` enforces both halves.
//
// A data-repair migration must call a FROZEN snapshot under `./frozen/`, never a
// live repo module — see the header of `v051-100.ts`.

import { log } from "../log.js";
import { addColumn, type Migration } from "./helpers.js";
import { repairExerciseIdentity } from "./frozen/v103-exercise-identity-repair.js";
import {
  GARMIN_HRV_STATUSES,
  elapsedMinutesFromRaw,
  isCairnAuthoredName,
  isPlaceholderCalories,
  parseRawActivity,
  repairCairnAuthoredGarminBlob,
} from "./frozen/v104-garmin-export-fidelity.js";

export const MIGRATIONS_101_150: Migration[] = [
  {
    version: 101,
    name: "profile-endurance-schedule",
    up: (db) => addColumn(db, "profile", "endurance_schedule_json TEXT"),
  },
  {
    // The athlete's stated LIFTING weekdays — the strength counterpart to v101's run
    // days. {days:[{dow}], note?, source, updated_at}; no `kind`, because a lifting day
    // is named by the plan's own rotation, not by the schedule. NULL keeps every
    // existing DB on the purely positional ring it has today.
    version: 102,
    name: "profile-strength-schedule",
    up: (db) => addColumn(db, "profile", "strength_schedule_json TEXT"),
  },
  {
    version: 103,
    name: "exercise-identity-repair",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // THE ROWS THIS EXISTS FOR. Exercise aliases were being WRITTEN and never READ,
    // so the catalog accumulated the same movement under several names while the
    // alias rows that already joined them went unused: one chest-press station typed
    // three ways, a rope hammer curl duplicated with a "Cable" prefix, a single-arm
    // row aliased but never folded, an alias pointing at a canonical that does not
    // exist, a pull-up stored as a TIMED movement, and two muscle groups naming the
    // wrong region (a chest-supported row filed under "chest", a neutral-grip pull-up
    // under "forearms"). Each split lift is its own progress line and its own share
    // of per-muscle volume, so the coaching read was working from a divided history.
    //
    // WHAT IT CHANGES. Repoints broken aliases at the row their canonical keys to;
    // folds the named clusters and then every remaining pair that shares one
    // expandedExerciseKey into the member with the most logged sets; puts "Pull Up"
    // back on reps; corrects the two muscle groups and the leg press's Garmin FIT
    // category (SQUAT/LEG_PRESS, from the checked-in catalog — never an invented
    // enum). Logged numbers are never touched: a merge only moves which exercise a
    // set belongs to. Idempotent — a second pass finds no broken alias, no named
    // `from` row and no multi-member cluster. The transform is the frozen
    // repairExerciseIdentity so this migration cannot drift with the live module;
    // POST /api/exercises/dedupe re-runs the live equivalent whenever it is needed.
    up: (db) => {
      repairExerciseIdentity(db);
    },
  },
  // 103 is reserved by a sibling package landing in the same round.
  {
    version: 104,
    name: "garmin-export-fidelity",
    // Cairn's own write-back, read back wrong.
    //
    // THE ROWS THIS EXISTS FOR. A finished Cairn strength session is pushed to Garmin
    // as a manual "shell" activity. The inbound sync then read that shell the way it
    // reads a run — `movingDuration` for the time, `calories` verbatim — and on a shell
    // neither field means that. `movingDuration` is the summed length of the 45-second
    // ACTIVE slots Cairn itself wrote, so a 34-minute session came back as 6 minutes on
    // the training log; `calories` is Garmin's auto-calculation for an activity with no
    // heart rate, a constant 65.534 flagged `isAutoCalcCalories`, which then SUMMED into
    // the day as if someone had burned it. The sync now reads both correctly
    // (repo/garmin-authorship.ts), but a re-sync cannot undo what is already stored:
    // `upsertGarminActivity` COALESCEs, so an incoming NULL preserves the placeholder
    // forever. This pulls the rows already on disk back onto the same law.
    //
    // WHAT IT CHANGES. Only activities whose NAME says Cairn authored them, and only
    // the sessions those front. Duration moves UP, never down (the defect only ever
    // shortened it), and calories are cleared only where the stored figure is the
    // placeholder. A watch recording is never touched — that is the athlete's own
    // measurement. It also re-arms the FIT mapping for movements previously recorded as
    // unmappable, so the hand-checked names added this round (a Pallof press is FIT's
    // "Cable Core Press") can actually be placed; a mapping a human SKIPPED is left
    // alone, and every row is re-scored deterministically on the next export.
    //
    // Per-row try/catch: one unparseable payload must not stop the repair of the rest.
    // Idempotent by construction — a second pass finds every duration already at least
    // as long and every placebo calorie already null, and writes nothing.
    up: (db) => {
      addColumn(db, "settings", "garmin_last_export_attempt_at TEXT DEFAULT ''");
      addColumn(db, "settings", "garmin_last_export_status TEXT DEFAULT ''");

      let activities: any[] = [];
      try {
        activities = db
          .prepare(
            `SELECT id, session_id, external_id, name, duration_min, calories, raw_json
               FROM garmin_activities WHERE name IS NOT NULL`
          )
          .all() as any[];
      } catch {
        return; /* a DB predating garmin_activities has nothing to repair */
      }

      const updateActivity = db.prepare(`UPDATE garmin_activities SET duration_min = ?, calories = ? WHERE id = ?`);
      const repairedSessions = new Map<number, number>(); // session_id -> best repaired minutes
      let activityFixes = 0;
      for (const row of activities) {
        try {
          if (!isCairnAuthoredName(row.name)) continue;
          const raw = parseRawActivity(row.raw_json);
          const elapsed = elapsedMinutesFromRaw(raw);
          const stored = row.duration_min == null ? null : Number(row.duration_min);
          const duration = elapsed != null && (stored == null || elapsed > stored) ? elapsed : stored;
          const calories = isPlaceholderCalories(row.calories, raw) ? null : (row.calories ?? null);
          if (row.session_id != null) {
            const best = Math.max(repairedSessions.get(Number(row.session_id)) ?? 0, Number(duration) || 0);
            repairedSessions.set(Number(row.session_id), best);
          }
          if (duration === stored && calories === (row.calories ?? null)) continue;
          updateActivity.run(duration, calories, Number(row.id));
          activityFixes++;
        } catch {
          /* one unreadable activity is left exactly as stored */
        }
      }

      // The session blob is what the training log and the coach context actually read.
      let sessions: any[] = [];
      try {
        sessions = db
          .prepare(`SELECT id, duration_min, garmin_json FROM sessions WHERE garmin_json IS NOT NULL`)
          .all() as any[];
      } catch {
        sessions = [];
      }
      const updateSession = db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`);
      let sessionFixes = 0;
      for (const row of sessions) {
        try {
          const blob = JSON.parse(String(row.garmin_json));
          if (!blob || typeof blob !== "object" || Array.isArray(blob)) continue;
          if (!isCairnAuthoredName(blob.name)) continue;
          const changed = repairCairnAuthoredGarminBlob(blob, {
            sessionDurationMin: row.duration_min == null ? null : Number(row.duration_min),
            activityDurationMin: repairedSessions.get(Number(row.id)) ?? null,
          });
          if (!changed) continue;
          updateSession.run(JSON.stringify(blob), Number(row.id));
          sessionFixes++;
        } catch {
          /* an unparseable blob is left exactly as stored */
        }
      }

      // A remembered "unmappable" is a memo, not a decision — ensureGarminMapping never
      // re-scores one. Clearing it lets this round's hand-checked names land; 'skipped'
      // (a human's own no) is deliberately untouched.
      let remapped = 0;
      try {
        remapped = Number(
          db
            .prepare(
              `UPDATE exercises SET garmin_category = NULL, garmin_exercise = NULL, garmin_map_status = NULL
                WHERE garmin_map_status = 'unmapped'`
            )
            .run().changes
        );
      } catch {
        /* a DB predating the mapping columns has nothing to re-arm */
      }

      // `NONE` is the watch reporting that it has NO HRV status yet. Stored verbatim it
      // reads as one — the coach context renders it beside "balanced", and nothing
      // downstream can tell "no reading" from a reading. Absence must look like absence.
      let hrvCleared = 0;
      try {
        const placeholders = GARMIN_HRV_STATUSES.map(() => "?").join(", ");
        hrvCleared = Number(
          db
            .prepare(
              `UPDATE garmin_daily_metrics SET hrv_status = NULL
                WHERE hrv_status IS NOT NULL AND LOWER(hrv_status) NOT IN (${placeholders})`
            )
            .run(...GARMIN_HRV_STATUSES).changes
        );
      } catch {
        /* a DB predating garmin_daily_metrics has nothing to normalize */
      }

      if (activityFixes || sessionFixes || remapped || hrvCleared) {
        log.info(
          `[migrate] v104: repaired ${activityFixes} Garmin activity row(s) + ${sessionFixes} session blob(s), re-armed ${remapped} exercise mapping(s), cleared ${hrvCleared} non-status HRV value(s).`
        );
      }
    },
  },
  {
    version: 105,
    name: "exercise-rename-suggestions",
    // A stored exercise name can now be RETITLED. Casing lands deterministically at
    // boot and on every write; an agent's same-lift respelling lands through the
    // rename chokepoint; a proposal the identity guard cannot vouch for is parked here
    // for a human yes/no instead of being dropped on the floor (which is how the
    // catalog kept "Seated Leg Press - Machine" through fifty enrichment passes). A
    // declined suggestion is remembered so the next Tidy never re-asks it.
    up: (db) => {
      addColumn(db, "exercises", "suggested_name TEXT");
      addColumn(db, "exercises", "refused_name TEXT");
    },
  },
  {
    version: 106,
    name: "run-display-units",
    // Athlete-facing run distance and pace: km (min/km) or mi (min/mile). The
    // engine stays in kilometres; only the PWA (and any surface that formats
    // a prescription) converts. Default km so existing installs do not flip.
    up: (db) => addColumn(db, "settings", "run_units TEXT DEFAULT 'km'"),
  },
];
