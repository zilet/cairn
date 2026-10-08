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
import { addColumn, hasTable, type Migration } from "./helpers.js";
import { repairExerciseIdentity } from "./frozen/v103-exercise-identity-repair.js";
import { repairStrengthObjectiveIdentity } from "./frozen/v108-strength-objective-identity.js";
import { repairCairnShellEnergy } from "./frozen/v113-cairn-shell-energy.js";
import { backfillGarminRunStructure } from "./frozen/v117-garmin-run-structure.js";
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
  {
    version: 107,
    name: "profile-movement-considerations",
    // A lasting, painless condition the athlete states ("mild scoliosis") had no home
    // but an injury event, which hard-gates the lifts it touches every day with no end.
    // {items:[{label, detail?, wants_addressed, source, stated_on}]}; it informs plan
    // selection and balance only. NULL keeps every existing profile exactly as it is.
    up: (db) => addColumn(db, "profile", "movement_considerations_json TEXT"),
  },
  {
    version: 108,
    name: "strength-objective-identity",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // Objective selection matched the typed name on an exact key and never asked the
    // exercise resolver, so an anchor typed "Bench Press" found no history ("no
    // exposure logged yet") while the athlete's Barbell Bench Press — which that name
    // aliases to — carried forty sets; and a name that only resolved AFTER selection
    // kept a null baseline. Selection now goes through the resolver; this re-points
    // the active rows it would have resolved and snaps a missing baseline as of the
    // day the objective was chosen. Idempotent: a resolved row with a baseline is
    // left alone.
    up: (db) => {
      try {
        const { renamed, baselined } = repairStrengthObjectiveIdentity(db);
        if (renamed || baselined) {
          log.info(`[migrate] v108: re-pointed ${renamed} strength objective(s), snapped ${baselined} baseline(s).`);
        }
      } catch {
        /* a DB predating strength_objectives has nothing to repair */
      }
    },
  },
  {
    version: 109,
    name: "hrv-weekly-average-repair",
    // foldHrv used to fall back to Garmin's `weeklyAvg` on a morning with no night of
    // its own, storing a seven-day average under a one-night date. Ingestion now keeps
    // `lastNightAvg` only; this clears the history it wrote, and ONLY the rows that
    // provably came from that fallback: the raw summary says there was no last night
    // AND the stored value is that summary's weekly average. The raw blob is untouched,
    // so the weekly figure is still there. A DB without the table or column (a
    // household instance jumping from an old schema) has nothing to repair.
    up: (db) => {
      const summary = (key: string) =>
        `CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, '$.hrv.hrvSummary.${key}') END`;
      let cleared = 0;
      try {
        cleared = Number(
          db
            .prepare(
              `UPDATE garmin_daily_metrics SET hrv_ms = NULL
                WHERE hrv_ms IS NOT NULL
                  AND ${summary("lastNightAvg")} IS NULL
                  AND ${summary("weeklyAvg")} = hrv_ms`
            )
            .run().changes
        );
      } catch {
        /* a DB predating garmin_daily_metrics.hrv_ms / raw_json has nothing to repair */
      }
      if (cleared) log.info(`[migrate] v109: cleared ${cleared} HRV value(s) that were Garmin's weekly average.`);
    },
  },
  {
    version: 110,
    name: "plan-days-strength-only",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // Plan days hold STRENGTH work only. Runs moved to the run engine and the stated
    // run days (weeklyRunPlan / flexibleTrainingAgenda compute every week live), and a
    // rest day is now a calendar weekday the athlete neither lifts nor runs. So the
    // repair removes what the plan used to carry for them:
    //   1. every run item (plan_items.kind = 'cardio');
    //   2. every plan day that carried no strength work — a v99 rest row, or a day that
    //      held only runs. An empty TRAINING day that never held a run is an editor
    //      scaffold and is left alone.
    // History is never orphaned: a session or a composed card that pointed at a removed
    // day keeps its row with the link cleared (the ring re-reads it off what was lifted,
    // exactly as it does for any unlinked session). Remaining day_numbers are kept as
    // they are — nothing needs them contiguous. Idempotent: a second pass finds no run
    // item and no such day.
    up: (db) => {
      // No blanket try/catch — a real failure must roll the whole repair back rather
      // than half-apply it. A partial database (a household instance or a test harness
      // jumping from an old schema) that lacks one of the tables simply has nothing of
      // that kind to repair.
      const hasTable = (name: string): boolean =>
        !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
      const hasColumn = (table: string, column: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
      if (!hasTable("plan_days") || !hasTable("plan_items")) return;
      if (!hasColumn("plan_items", "kind") || !hasColumn("plan_days", "day_type")) return;
      const doomed = (
        db
          .prepare(
            `SELECT pd.id AS id FROM plan_days pd
              WHERE COALESCE(pd.day_type, 'training') = 'rest'
                 OR (EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_day_id = pd.id AND pi.kind = 'cardio')
                     AND NOT EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_day_id = pd.id
                                      AND COALESCE(pi.kind, 'strength') != 'cardio'))`
          )
          .all() as Array<{ id: number }>
      ).map((row) => Number(row.id));
      for (const id of doomed) {
        if (hasTable("sessions")) db.prepare(`UPDATE sessions SET plan_day_id = NULL WHERE plan_day_id = ?`).run(id);
        if (hasTable("daily_session_compositions")) {
          db.prepare(`UPDATE daily_session_compositions SET plan_day_id = NULL WHERE plan_day_id = ?`).run(id);
        }
      }
      const removedItems = Number(db.prepare(`DELETE FROM plan_items WHERE kind = 'cardio'`).run().changes);
      let removedDays = 0;
      for (const id of doomed) {
        db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(id);
        removedDays += Number(db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(id).changes);
      }
      // Every remaining day is a training day; the column stays for historical reads.
      db.prepare(`UPDATE plan_days SET day_type = 'training' WHERE COALESCE(day_type, 'training') != 'training'`).run();
      // 3. An open draft that only ever proposed RUNS (the weekly run-plan drafts, a
      //    run-only chat or evolution draft) can no longer apply — runs are not plan
      //    items. Retire it as the system does a stale draft ('superseded'), cancel any
      //    announced/pending decision that would try to land it at the next boundary, and
      //    close its review hold — the same three steps setProposalStatus takes, inlined
      //    because a migration never calls app code.
      let retiredDrafts = 0;
      if (hasTable("plan_proposals") && hasColumn("plan_proposals", "parsed_json")) {
        const drafts = db
          .prepare(`SELECT id, parsed_json FROM plan_proposals WHERE status = 'draft'`)
          .all() as Array<{ id: number; parsed_json: string | null }>;
        for (const draft of drafts) {
          let parsed: any = null;
          try {
            parsed = draft.parsed_json ? JSON.parse(draft.parsed_json) : null;
          } catch {
            continue; // unreadable — left for a person
          }
          const hasRuns = Array.isArray(parsed?.cardio) && parsed.cardio.length > 0;
          const hasStrength =
            (Array.isArray(parsed?.changes) && parsed.changes.length > 0) ||
            (Array.isArray(parsed?.days) && parsed.days.length > 0);
          if (!hasRuns || hasStrength) continue;
          const id = Number(draft.id);
          db.prepare(`UPDATE plan_proposals SET status = 'superseded' WHERE id = ?`).run(id);
          retiredDrafts++;
          if (!hasTable("brain_decisions")) continue;
          const linked = db
            .prepare(
              `SELECT id, status FROM brain_decisions
                WHERE status IN ('announced','pending','review')
                  AND ((source_ref_type = 'plan_proposal' AND source_ref_key = ?)
                       OR json_extract(action_json, '$.proposal_id') = ?)`
            )
            .all(String(id), id) as Array<{ id: number; status: string }>;
          for (const decision of linked) {
            db.prepare(`UPDATE brain_decisions SET status = ? WHERE id = ?`).run(
              decision.status === "review" ? "superseded" : "canceled",
              decision.id
            );
            if (hasTable("brain_expectations")) {
              db.prepare(
                `UPDATE brain_expectations SET status = 'canceled' WHERE decision_id = ? AND status IN ('pending','mature')`
              ).run(decision.id);
            }
          }
        }
      }
      if (removedItems || removedDays || retiredDrafts) {
        log.info(
          `[migrate] v110: removed ${removedItems} run item(s) and ${removedDays} non-lifting plan day(s); retired ${retiredDrafts} run-only draft(s).`
        );
      }
    },
  },
  {
    // When a plan slot's prescription was last authored. A plateau read measured under
    // an older prescription must not rotate a movement the athlete (or an agent) just
    // wrote into the day. NULL keeps every existing row reading as settled.
    version: 111,
    name: "plan-item-prescribed-at",
    up: (db) => addColumn(db, "plan_items", "prescribed_at TEXT"),
  },
  {
    version: 112,
    name: "directive-active-status-at-clear",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // An ACTIVE directive carrying `status_at` now means "acknowledged" (the athlete's
    // Done on a finding that still stands — isAcknowledgedDirective). Before that
    // meaning existed, every status flip stamped status_at, the un-hide back to active
    // included, so a legacy active row can carry a stamp nobody meant as a Done and
    // would read as acknowledged: off the to-do surfaces for a finding the athlete never
    // saw through. Every such row predates acknowledgement, so the stamp is cleared.
    // Resolved/dismissed rows keep theirs — that stamp is the athlete's own feedback.
    // Idempotent: a second pass finds no active row with a stamp.
    up: (db) => {
      const hasTable = !!db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'health_directives'`)
        .get();
      if (!hasTable) return;
      const cleared = db
        .prepare(`UPDATE health_directives SET status_at = NULL WHERE status = 'active' AND status_at IS NOT NULL`)
        .run();
      if (Number(cleared.changes) > 0) {
        log.info(`[migrate] v112: cleared a stale status stamp from ${cleared.changes} active directive(s).`);
      }
    },
  },
  {
    version: 113,
    name: "garmin-cairn-shell-energy",
    // Cairn's own strength shells, taken back OUT of the day's energy.
    //
    // A finished session is written to Garmin as a manual "shell" activity, and Garmin
    // adds each manual activity's calories (above resting) to the day's active and
    // total kcal. The sync stored those verbatim, and the expenditure prior reads them —
    // so Cairn's own write-back leaked into Cairn's TDEE (5–35 kcal/day at Garmin's
    // placeholder, ~150 once the shell carries a real estimate). The sync now stores the
    // totals NET of what the shells contributed (repo/garmin-shell-energy.ts) and records
    // that amount in `cairn_shell_kcal`; the raw `burned_calories` /
    // `wellness_active_calories` ride beside it so the identity stays auditable.
    //
    // Two-step: the three columns also live in db.ts's create block. The repair
    // subtracts ONCE per row — only rows whose `cairn_shell_kcal` is still NULL, each
    // stamped with the amount (0 on a day with no shell) — so a re-run touches nothing.
    // The transform is the frozen repairCairnShellEnergy.
    up: (db) => {
      addColumn(db, "garmin_daily_metrics", "cairn_shell_kcal REAL");
      addColumn(db, "garmin_daily_metrics", "burned_calories REAL");
      addColumn(db, "garmin_daily_metrics", "wellness_active_calories REAL");
      try {
        const { adjusted, stamped } = repairCairnShellEnergy(db);
        if (adjusted) {
          log.info(`[migrate] v113: took Cairn's own shells out of ${adjusted} Garmin day(s) (${stamped} stamped).`);
        }
      } catch {
        /* a DB predating garmin_daily_metrics has nothing to repair */
      }
    },
  },
  {
    version: 114,
    name: "settings-meal-plan-auto-draft",
    // Meal plans are ideation: drafted when the athlete asks, not twice a week on
    // their own. `meal_plan_auto_draft` is the one switch over every automatic
    // draft (the weekly slot and the owned protective reshape channel). DEFAULT 0
    // so an existing install lands on the same default as a fresh one; the
    // scheduler retires any request parked before the switch existed.
    up: (db) => addColumn(db, "settings", "meal_plan_auto_draft INTEGER DEFAULT 0"),
  },
  {
    version: 115,
    name: "bodyweight-exact-double-submits",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // A weigh-in submitted twice (a second tap, a retried request) landed as two
    // identical rows seconds apart. logWeight now treats an identical value on the same
    // date within WEIGHT_RESUBMIT_WINDOW_MIN (10 minutes, repo/bodyweight.ts) as a no-op;
    // this folds the bursts already on disk under the same law. ONLY exact duplicates go:
    // same date, same value, created within 600 seconds of the row the live no-op would
    // have answered with — the latest identical row that SURVIVES, never a duplicate that
    // is itself being folded — and carrying no words that row lacks (its note is
    // NULL/blank or equal to it). So identical rows at 07:00, 07:08, 07:16 and 07:24 keep
    // 07:00 and 07:16, exactly as logWeight would have written them: the window is
    // measured from a kept row, a burst never chains past it. The earliest row of a burst
    // survives, as the live no-op keeps the first write. Genuinely different same-day
    // readings are untouched — the one-per-day rule for those is a READ rule
    // (dailyManualWeighIns), never a delete. A row without created_at is never matched.
    // The walk is a greedy replay in id order (a "was the anchor itself kept" question
    // SQL cannot answer without recursion), with the constants spelled out inline so it
    // cannot drift with live code. Idempotent: a second pass finds every survivor more
    // than 600 s from the kept identical row before it, or carrying its own words.
    up: (db) => {
      if (!hasTable(db, "bodyweight_log")) return;
      // A very old table without created_at has no window to judge a burst by.
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(bodyweight_log)`).all() as Array<{ name: string }>).map((c) => c.name)
      );
      if (!columns.has("created_at") || !columns.has("note")) return;
      const rows = db
        .prepare(
          `SELECT id, date, weight_lb, note, CAST(strftime('%s', created_at) AS INTEGER) AS at
             FROM bodyweight_log
            WHERE created_at IS NOT NULL AND strftime('%s', created_at) IS NOT NULL
            ORDER BY date, id`
        )
        .all() as Array<{ id: number; date: string; weight_lb: number; note: string | null; at: number }>;
      const kept = new Map<string, Array<{ weight_lb: number; note: string | null; at: number }>>();
      const doomed: number[] = [];
      for (const row of rows) {
        const day = kept.get(row.date) ?? [];
        kept.set(row.date, day);
        let anchor: { note: string | null; at: number } | null = null;
        for (let i = day.length - 1; i >= 0; i--) {
          if (Math.abs(day[i].weight_lb - row.weight_lb) < 0.001) {
            anchor = day[i];
            break;
          }
        }
        const blank = row.note == null || String(row.note).trim() === "";
        if (anchor && Math.abs(Number(row.at) - anchor.at) <= 600 && (blank || anchor.note === row.note)) {
          doomed.push(Number(row.id));
          continue;
        }
        day.push({ weight_lb: Number(row.weight_lb), note: row.note ?? null, at: Number(row.at) });
      }
      const del = db.prepare(`DELETE FROM bodyweight_log WHERE id = ?`);
      for (const id of doomed) del.run(id);
      if (doomed.length > 0) {
        log.info(`[migrate] v115: folded ${doomed.length} double-submitted weigh-in(s) into their first entry.`);
      }
    },
  },
  {
    version: 116,
    name: "food-note-person-edit-lock",
    // A person's edit wins over a late enrichment pass. `person_edited_at` is stamped
    // by updateFoodNote (the meal card's row edits, the edit sheet, a chat/MCP
    // correction), and updateFoodNoteParsed — the one writer every enricher uses —
    // refuses a note that carries it. NULL keeps every existing note enrichable
    // exactly as before. Two-step: the column also lives in db.ts's create block.
    up: (db) => addColumn(db, "food_notes", "person_edited_at TEXT"),
  },
  {
    version: 117,
    name: "garmin-run-structure",
    // A run's shape, not just its summary. Six hill repeats with walked recoveries
    // average to an easy-looking heart rate; the watch's own segment summary
    // (`splitSummaries`: warm-up, work bouts, recoveries, walking) says what the run
    // was. That, the grade-adjusted speed, the Body Battery change and the per-lap list
    // now have columns (repo/run-structure.ts). Two-step: the four columns also live in
    // db.ts's create block. The backfill reads the list payload already stored in
    // `raw_json` — and fills the running dynamics the sync never managed to write — via
    // the frozen backfillGarminRunStructure; it writes only NULL columns, so a re-run
    // touches nothing. Laps need a network call, so they arrive with the next sync.
    up: (db) => {
      addColumn(db, "garmin_activities", "gap_speed REAL");
      addColumn(db, "garmin_activities", "body_battery_delta REAL");
      addColumn(db, "garmin_activities", "structure_json TEXT");
      addColumn(db, "garmin_activities", "laps_json TEXT");
      if (!hasTable(db, "garmin_activities")) return;
      const touched = backfillGarminRunStructure(db);
      if (touched) {
        log.info(`[migrate] v117: read the stored shape of ${touched} Garmin activit${touched === 1 ? "y" : "ies"}.`);
      }
    },
  },
  {
    version: 118,
    name: "garmin-laps-relabel",
    // Pure data repair — no schema change. The first lap fetch read the plain lap list,
    // which labels every lap of a watch workout "INTERVAL" (warm-up and recoveries
    // included), and stored them all as work. Laps are now read from the typed list.
    // Clearing the stored laps lets the next sync fetch them again, labelled; the sync
    // skips only activities whose laps are already stored.
    up: (db) => {
      if (!hasTable(db, "garmin_activities")) return;
      try {
        db.exec(`UPDATE garmin_activities SET laps_json = NULL WHERE laps_json IS NOT NULL`);
      } catch {
        /* a DB without laps_json has nothing to clear */
      }
    },
  },
  {
    version: 119,
    name: "exercise-input-profile",
    // What a movement's log row asks for (repo/exercise-input.ts). A stretch takes no
    // load and no RIR, and a one-sided drill is dosed per side — neither was
    // expressible. Both columns are OVERRIDES: NULL keeps every existing exercise on
    // the derived read (mobility group / prep name / bodyweight movement without a
    // loaded log), so no backfill. Two-step: both also live in db.ts's create block.
    up: (db) => {
      addColumn(db, "exercises", "input_profile TEXT");
      addColumn(db, "exercises", "per_side INTEGER");
    },
  },
  {
    version: 120,
    name: "weight-display-units",
    // Athlete-facing bodyweight and loads: lb or kg (the units registry,
    // repo/display-words.ts). Stored weights stay pounds; only the formatter edge
    // converts. Default lb so existing installs do not flip. Two-step: also in db.ts.
    up: (db) => addColumn(db, "settings", "weight_units TEXT DEFAULT 'lb'"),
  },
  {
    version: 121,
    name: "usage-ping-opt-in",
    // The opt-in weekly usage ping (src/usagePing.ts): a random install id, the version,
    // the host platform, CPU arch and Node version — nothing else, and only when the
    // owner turns it on. DEFAULT 0 keeps every existing install silent. Two-step: the
    // column also lives in db.ts's settings create block and repo/settings.ts's list.
    up: (db) => addColumn(db, "settings", "usage_ping_enabled INTEGER DEFAULT 0"),
  },
  {
    version: 122,
    name: "settings-coach-welcomed",
    // Whether the first-run welcome exchange with the coach has happened (src/coachOps/
    // welcome.ts). Separate from `onboarded`: "Look around first" opens the app without a
    // coach, and the welcome still waits for the day an agent is connected. DEFAULT 0;
    // two-step: also in db.ts's settings create block and repo/settings.ts's list.
    // An install that already onboarded through the old form has met its coach: mark it
    // welcomed, so an upgrade never greets a long-standing athlete with "say hello".
    up: (db) => {
      addColumn(db, "settings", "coach_welcomed INTEGER DEFAULT 0");
      if (!hasTable(db, "settings")) return;
      try {
        db.exec(`UPDATE settings SET coach_welcomed = 1 WHERE onboarded = 1 AND COALESCE(coach_welcomed, 0) = 0`);
      } catch {
        /* a settings table older than the onboarded column has nobody to welcome */
      }
    },
  },
  {
    version: 123,
    name: "auth-device-hint",
    // The same browser signing in again reuses its own device row (repo/auth-devices.ts
    // createDeviceSession) instead of minting a duplicate: rows remember the sha256 of
    // the browser's non-secret device hint. NULL on every existing row, so nothing is
    // reused until that browser next signs in. Two-step: also in db.ts's create block.
    up: (db) => {
      if (!hasTable(db, "auth_devices")) return;
      addColumn(db, "auth_devices", "hint_hash TEXT");
    },
  },
  {
    version: 124,
    name: "auth-passkey-provenance",
    // Revoking a device removes every passkey it could still hold — bound to it, added
    // by it, or last used by it (repo/auth-devices.ts passkeysRemovedByRevoking): a synced
    // passkey lives on every device of its account, so the binding alone is not enough.
    // Existing rows take their current binding as the registering device (the closest
    // record there is); last_used_device_id fills in on the next sign-in. Two-step: also
    // in db.ts's create block.
    up: (db) => {
      if (!hasTable(db, "auth_passkeys")) return;
      addColumn(db, "auth_passkeys", "registered_device_id INTEGER");
      addColumn(db, "auth_passkeys", "last_used_device_id INTEGER");
      try {
        db.exec(`UPDATE auth_passkeys SET registered_device_id = device_id WHERE registered_device_id IS NULL`);
      } catch {
        /* a passkeys table older than device_id has nothing to backfill */
      }
    },
  },
  {
    version: 125,
    name: "mcp-grant-provenance",
    // Connected AI apps (repo/mcp-clients.ts) remember the redirect URI a grant was
    // approved for (Settings shows THAT host, not the registration's first) and the device
    // that made the key or approved the grant (revoking that device from another one
    // disconnects them). OAuth tokens remember the refresh token whose rotation minted
    // them, for the refresh-reuse grace. NULL on existing rows: an older grant shows its
    // registration's host only when it registered one URI, and is cut by no device.
    // Two-step: also in db.ts's create blocks.
    up: (db) => {
      if (hasTable(db, "mcp_clients")) {
        addColumn(db, "mcp_clients", "redirect_uri TEXT");
        addColumn(db, "mcp_clients", "created_by_device_id INTEGER");
      }
      if (hasTable(db, "oauth_tokens")) addColumn(db, "oauth_tokens", "parent_id INTEGER");
    },
  },
  {
    version: 126,
    name: "agent-run-failure-tail",
    // A failed agent attempt keeps a short redacted tail of what the CLI printed
    // (src/agentFailureTail.ts), so an exit no classifier recognises is diagnosable
    // after the fact instead of leaving only "process_exit". NULL on existing rows and
    // on every successful attempt. Two-step: also in db.ts's create block.
    up: (db) => {
      if (hasTable(db, "agent_runs")) addColumn(db, "agent_runs", "failure_tail TEXT");
    },
  },
  {
    version: 127,
    name: "settings-model-class-bindings",
    // The person's own model choice per provider and class (Settings -> Agents:
    // Everyday = fast, Deep work = deep). '' on existing rows = every CLI runs its own
    // default model; deliberately no backfill of the old claude sonnet/fable pins.
    // Two-step: also in db.ts's settings create block.
    up: (db) => {
      if (hasTable(db, "settings")) addColumn(db, "settings", "model_class_bindings TEXT DEFAULT ''");
    },
  },
  {
    version: 128,
    name: "settings-lab-units",
    // The lab-value display system: 'us' (conventional, mg/dL) | 'si' (mmol/L, µmol/L)
    // | '' = automatic, following weight_units (kg reads SI). Display only — every
    // comparison stays in the canonical unit (repo/lab-units.ts). Two-step: also in
    // db.ts's settings create block.
    up: (db) => {
      if (hasTable(db, "settings")) addColumn(db, "settings", "lab_units TEXT DEFAULT ''");
    },
  },
];
