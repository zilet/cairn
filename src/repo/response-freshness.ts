// The freshness key behind the HTTP response memo (src/routes/response-memo.ts): one
// string that moves whenever anything a memoized Today/Horizon read could depend on
// moves, so a repeat GET can be answered — or a 304 given — BEFORE the read is
// computed again.
//
// It is built from the signatures the process-wide memos already trust:
//   • coachContextBackstopSignature() — row counts, high-water marks, an UPDATE
//     odometer over every table the coach context reads, the profile and settings
//     rows by value, and the training/food/coach counters (repo/training-cache.ts);
//   • currentMarkerDataVersion() — the marker-history counter (repo/marker-cache.ts);
//   • the local DATE, the device zone, and a short wall-clock SLOT (below).
// plus ONE addition of its own: an odometer over the bookkeeping tables those reads
// consult but the coach context deliberately leaves out — app_state (the "since you
// last looked" stamp, the Changes feed's seen marker, a drained backlog), ai_cache
// (a week-ahead or weekly read landing), agent_availability (whether an
// agent is usable colours the Brief's agent status), the exercise-guide index and the
// Garmin source rows. And the in-memory agent-state generation
// (repo/agent-state-generation.ts): a CLI login, install or update changes what
// /settings and the Brief's agent_status say without writing a row.
// Freshness beats speed: over-invalidation only costs a recompute.
//
// The SLOT is ten minutes rather than the coach memo's hour. A few reads carry a
// minute-level clock of their own (the fuel pace model's "expected by now"), and a
// response memo must never hold one of those past the point a fresh compute would
// have said something different for long. Ten minutes still covers every burst of
// opens and background revalidations, which is where the memo earns its keep.
//
// Leaf-ish on purpose: it imports only the two signature leaves and the clock, so a
// route module can read it without dragging a repo cycle in.
import { db } from "../db.js";
import { agentStateGeneration } from "./agent-state-generation.js";
import { currentMarkerDataVersion } from "./marker-cache.js";
import { localHourFraction, nowContext } from "./shared.js";
import { coachContextBackstopSignature } from "./training-cache.js";

/** The wall-clock bucket every memoized response is keyed to, in minutes. */
export const RESPONSE_FRESHNESS_SLOT_MINUTES = 10;

// app_state keys that are pure liveness bookkeeping. A heartbeat is written every
// few seconds by the scheduler and is read by nothing a memoized surface renders.
const APP_STATE_IGNORED_KEYS = ["scheduler_heartbeat"] as const;

// agent_jobs is deliberately NOT here: a job's own bookkeeping (queued → running →
// phase ticks → failed) moves on every step while nothing a memoized read shows has
// changed, and a job that lands writes its result where the read looks (ai_cache,
// day_reads, insights), which IS covered. Keyed on it, one retrying background job
// kept every Today read from ever being remembered.
const AUX_TABLES = [
  "ai_cache",
  "agent_availability",
  "exercise_guides",
  "garmin_sources",
  "symptom_report_events",
] as const;

// An UPDATE on these tables counts only when it moves a column a reader can see. A
// garmin_sources row is restamped at the end of EVERY full pass (`last_sync_at`, and
// `updated_at` with it) — the sync's receipt, which no memoized read shows (the coach
// summary leaves both out; Settings reads the sync time off its own unmemoized route).
// Its connection state (`auth_status`), mode, label and token still count.
const AUX_UPDATE_WHEN: Partial<Record<(typeof AUX_TABLES)[number], string>> = {
  garmin_sources: `WHEN NEW.provider IS NOT OLD.provider OR NEW.mode IS NOT OLD.mode OR NEW.label IS NOT OLD.label
    OR NEW.auth_status IS NOT OLD.auth_status OR NEW.token_json IS NOT OLD.token_json`,
};

const AUX_ODOMETER_TABLE = "_cairn_response_aux_writes";

let auxOdometer: ReturnType<typeof db.prepare> | null = null;

/**
 * One TEMP counter row plus TEMP INSERT/UPDATE/DELETE triggers on each bookkeeping
 * table — the same connection-local, schema-free shape the coach-context odometer
 * uses (repo/training-cache.ts). app_state counts only a write that CHANGES a value
 * of a key a reader can see: an upsert of the same value is not news.
 * Returns null when SQLite refused any of it; the caller then never memoizes.
 */
function installAuxOdometer(): ReturnType<typeof db.prepare> | null {
  try {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${AUX_ODOMETER_TABLE} (n INTEGER NOT NULL)`);
    const seeded = db.prepare(`SELECT COUNT(*) AS c FROM ${AUX_ODOMETER_TABLE}`).get() as { c?: number } | undefined;
    if (!seeded?.c) db.exec(`INSERT INTO ${AUX_ODOMETER_TABLE} (n) VALUES (0)`);
    const bump = `UPDATE ${AUX_ODOMETER_TABLE} SET n = n + 1;`;
    for (const t of AUX_TABLES) {
      for (const op of ["INSERT", "UPDATE", "DELETE"]) {
        const when = op === "UPDATE" ? (AUX_UPDATE_WHEN[t] ?? "") : "";
        db.exec(
          `CREATE TEMP TRIGGER IF NOT EXISTS _cairn_resp_${op.toLowerCase()}_${t} AFTER ${op} ON ${t} ${when} BEGIN ${bump} END`
        );
      }
    }
    const ignored = APP_STATE_IGNORED_KEYS.map((k) => `'${k}'`).join(",");
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS _cairn_resp_insert_app_state AFTER INSERT ON app_state
       WHEN NEW.key NOT IN (${ignored}) BEGIN ${bump} END`
    );
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS _cairn_resp_update_app_state AFTER UPDATE ON app_state
       WHEN NEW.key NOT IN (${ignored}) AND (NEW.value IS NOT OLD.value OR NEW.key IS NOT OLD.key) BEGIN ${bump} END`
    );
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS _cairn_resp_delete_app_state AFTER DELETE ON app_state
       WHEN OLD.key NOT IN (${ignored}) BEGIN ${bump} END`
    );
    return db.prepare(`SELECT n FROM ${AUX_ODOMETER_TABLE}`);
  } catch {
    return null;
  }
}

/** The bookkeeping odometer's reading, or null when it is missing (never memoize then). */
function auxWrites(): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!auxOdometer) auxOdometer = installAuxOdometer();
      const n = (auxOdometer?.get() as { n?: number } | undefined)?.n;
      if (typeof n === "number") return n;
    } catch {
      /* the temp table went with a rolled-back transaction: reinstall once */
    }
    auxOdometer = null;
  }
  return null;
}

/** The ten-minute wall-clock slot of the local day, in the active device zone. */
function clockSlot(at: Date): number {
  const minuteOfDay = Math.round(localHourFraction(at) * 60);
  return Math.floor(minuteOfDay / RESPONSE_FRESHNESS_SLOT_MINUTES);
}

/**
 * The key a memoized response is stored under. `null` means "do not memoize": the
 * odometer could not be read, so there is no way to prove a stored body current.
 */
export function responseFreshnessKey(): string | null {
  const aux = auxWrites();
  if (aux == null) return null;
  const coach = coachContextBackstopSignature();
  if (coach.startsWith("nocoach:")) return null;
  const at = new Date();
  const now = nowContext(at);
  return [coach, currentMarkerDataVersion(), aux, agentStateGeneration(), now.date, clockSlot(at), now.tz ?? ""].join(
    "|",
  );
}
