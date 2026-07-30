import { agentStatusFor } from "../../coachOps.js";
import { db } from "../../db.js";
import {
  computeCanonicalDayRead,
  computeDayRead,
  dayReadProseConsistencyIssue,
  localToday,
} from "../../dayread.js";
import { ensureDayReadRefresh, scheduleDayReadRefresh } from "../../dayread-refresh.js";
import {
  dayRead,
  dayReadHeadline,
  dayReadPeriodizationContext,
  forwardLook,
  getCachedDayRead,
  invalidateDayRead,
  replaceStaleDayReadOverride,
  saveDayRead,
  type DayReadDecision,
  type DayReadPeriodizationContext,
} from "../../repo/intelligence.js";
import { recordSuggestion } from "../../repo/memory.js";
import { buildRecoveryMenu, type RecoveryMenu } from "../../repo/recovery-menu.js";
import { getTrajectory } from "../../repo/trajectory.js";
import { decideTodayAttention, type TodayAttention } from "./today-attention.js";

type AgentStatus = ReturnType<typeof agentStatusFor>;

export interface DayReadResult {
  kind: "train" | "easy" | "rest" | "done";
  focus: string | null;
  why: string;
  est_minutes: number | null;
  signals: Record<string, unknown>;
  headline?: string;
  source?: string;
  cached?: boolean;
  forward: string | null;
  arc: string | null;
  // The ledger metadata the read carries, reusing the repo layer's own definition
  // (same seam as DayReadPeriodizationContext below) so the response cannot drift
  // from what dayread.ts writes. Optional to match what attachDayReadContext can
  // actually produce: it casts a plain read through, and a legacy cached row
  // (written before the decision metadata existed) carries none of these.
  // ClientDayRead has always said so.
  decision?: DayReadDecision;
  input_fingerprint?: string;
  computed_at?: string;
  // A hand-authored read (the demo seed's Brief) pinned against recompute.
  curated?: boolean;
  // The optional guided recovery menu on a rest/easy day (never dayRead-computed,
  // never persisted — derived fresh alongside forward/arc; see attachDayReadContext).
  recovery?: RecoveryMenu | null;
  periodization_context: DayReadPeriodizationContext;
  // Which Today surface earns the position of prominence (see today-attention.ts).
  // Optional by contract: absent on any non-live date and on any failure, and the
  // client renders exactly as it did before the field existed.
  attention?: TodayAttention;
  agent_status?: AgentStatus;
  agent_issue?: "invalid_response" | "unreachable";
  error?: string;
  [key: string]: unknown;
}

// DayReadPeriodizationContext now lives in the repo layer, so the Brief RESPONSE
// and the day-read PROMPT read one definition (the agent needs to know it is on
// day 3 of 7 of a deload as much as the client does). It is deliberately NOT
// re-exported from here: brain/index.ts already `export *`s both this module and
// repo/intelligence.js, so a re-export would surface the same name down two paths
// and read as a duplicate export. Import it from the repo module.

export interface ReadTodayOptions {
  date?: string;
  override?: string;
  agent?: string;
  reset?: boolean;
  recordOutcome?: boolean;
}

// (A byte-identical copy of the headline literals used to live here, a third
// implementation alongside dayread.ts's and the recovery-week clamp's. The one
// rotated implementation now lives beside the rest of the Brief's vocabulary in
// repo/day-read.ts, and takes the date it is speaking for.)

export function attachDayReadContext(readDate: string, read: Record<string, unknown>): DayReadResult {
  let arc: string | null = null;
  try {
    arc = getTrajectory(readDate)?.line ?? null;
  } catch {
    arc = null;
  }

  // The forward line rides on done days too: forwardLook() resolves "next"
  // relative to today's logged work — the day AFTER a logged lifting session,
  // or (for a cardio-only done day) the still-unstarted adaptive lifting pick.
  // Either way it names the true next session: a prospective line, never a
  // second recommendation for today (focus/est_minutes stay null on done;
  // that contract is enforced upstream by enforceCompletionContract).
  let forward: string | null = null;
  try {
    forward = forwardLook(readDate).text || null;
  } catch {
    forward = null;
  }

  const periodizationContext = dayReadPeriodizationContext(readDate);

  // The Today lead arbitration. Every Brief response — REST, MCP and agentJobs
  // alike — flows through here, so all three agree on what leads today. Null
  // (past date, or any failure inside) simply omits the key.
  let attention = null as ReturnType<typeof decideTodayAttention>;
  try {
    attention = decideTodayAttention(readDate, read);
  } catch {
    attention = null;
  }

  // The guided recovery menu (Track D): a rest/easy Brief is never a void. Same
  // precedent as forward/arc above — derived fresh per response, never cached
  // or persisted, so it always reflects today's live symptom/load state.
  //
  // …and for the same reason, only on a day the athlete can still act on. The menu
  // is an invitation to move NOW, grounded in today's live symptom and load state;
  // offered against a routed past date it invites a session that day is over for,
  // and it would be grounded in today's symptoms rather than that day's anyway.
  // `attention` above declines past dates on the same reasoning.
  let recovery: RecoveryMenu | null = null;
  try {
    if (readDate >= localToday()) recovery = buildRecoveryMenu(readDate, String(read.kind ?? ""));
  } catch {
    recovery = null;
  }

  return {
    ...read,
    forward,
    arc,
    periodization_context: periodizationContext,
    ...(attention ? { attention } : {}),
    ...(recovery ? { recovery } : {}),
  } as DayReadResult;
}

// Record the Brief suggestion for outcome learning, idempotent for the canonical
// read and intentionally non-idempotent for steered override reads.
export function recordDayReadSuggestion(date: string, read: Record<string, unknown>, override?: string | null): void {
  try {
    if (!override) {
      // json_extract, not a payload_json LIKE '%"override":null%' substring match —
      // the latter is brittle (any key-order or whitespace change in the serialized
      // payload silently disables the dedupe and the duplicate rows come straight
      // back; see migration 78, which backfill-deduped the historical fallout).
      // payload_json IS NOT NULL keeps the null-safety of the old LIKE, under which
      // a NULL payload_json (LIKE against NULL is NULL, never TRUE) never counted
      // as an existing canonical row.
      const existing = db
        .prepare(
          `SELECT 1 FROM suggestions
            WHERE kind = 'day_read' AND date = ? AND payload_json IS NOT NULL
              AND json_extract(payload_json, '$.override') IS NULL
            LIMIT 1`
        )
        .get(date);
      if (existing) return;
    }
    recordSuggestion("day_read", date, {
      kind: read?.kind ?? null,
      focus: read?.focus ?? null,
      est_minutes: read?.est_minutes ?? null,
      override: override ?? null,
    });
  } catch {
    // Outcome recording is best-effort and must never block the Brief.
  }
}

export async function readToday(options: ReadTodayOptions = {}): Promise<DayReadResult> {
  const { date, override, agent, reset, recordOutcome = false } = options;
  const readDate = date || localToday();

  try {
    if (reset) {
      invalidateDayRead(readDate);
      // force: this is the athlete asking for a new read, so it must not be answered
      // with a run that started before their invalidation — but it still joins the
      // canonical lane, so opens arriving behind it share this one agent call.
      const read = await computeCanonicalDayRead({ date, agent, force: true });
      if (recordOutcome) recordDayReadSuggestion(readDate, read, null);
      return attachDayReadContext(readDate, { ...read, agent_status: agentStatusFor(read) });
    }

    if (!override) {
      const cached = getCachedDayRead(readDate);
      if (cached) {
        // A curated read is authored, not derived — its illustrative signals can
        // never match a live recompute, so every reconciliation below would fire
        // and replace the hand-written Brief with the deterministic floor on the
        // very first open. Serve it as written; invalidateDayRead() retires it.
        if (cached.curated) {
          if (recordOutcome) recordDayReadSuggestion(readDate, cached, cached.override ?? null);
          return attachDayReadContext(readDate, { ...cached, cached: true, agent_status: agentStatusFor(cached) });
        }
        // A transient all-agent failure may have cached the deterministic floor.
        // Serve it instantly, then quietly ensure one agent-gated re-warm is
        // pending so the Brief heals instead of pinning floor prose all day.
        if (cached.source === "deterministic") ensureDayReadRefresh(readDate);
        // The cache is a prose accelerator, never the authority on whether work
        // has happened. A Garmin/manual activity can land while an older agentic
        // warm is still in flight and re-save prospective copy after invalidation.
        // Recheck only the deterministic temporal fact before serving the row so
        // a completed run can never show "Start session" from a stale morning read.
        const live = dayRead(readDate);
        const liveLogged = live?.signals?.logged_today as { sets?: unknown; activities?: unknown[] } | undefined;
        const cachedLogged = cached?.signals?.logged_today as { sets?: unknown; activities?: unknown[] } | undefined;
        const liveHasWork =
          Number(liveLogged?.sets ?? 0) > 0 ||
          (Array.isArray(liveLogged?.activities) && liveLogged.activities.length > 0);
        const cachedHasWork =
          Number(cachedLogged?.sets ?? 0) > 0 ||
          (Array.isArray(cachedLogged?.activities) && cachedLogged.activities.length > 0);
        const liveLoad = String(live?.signals?.today_load ?? "");
        const cachedLoad = String(cached?.signals?.today_load ?? "");
        const loadClassificationChanged = !!liveLoad && !!cachedLoad && liveLoad !== cachedLoad;
        const trainedFactChanged =
          typeof cached?.signals?.trained_today === "boolean" &&
          Boolean(live?.signals?.trained_today) !== Boolean(cached.signals.trained_today);
        const completionChanged = (live.kind === "done") !== (cached.kind === "done");
        const proseContradiction = dayReadProseConsistencyIssue(cached, live?.signals);
        const fingerprintChanged =
          typeof cached.input_fingerprint !== "string" || cached.input_fingerprint !== live.input_fingerprint;
        // Fuel bucket flip (e.g. a lunch that moved protein from behind → on_pace
        // after the morning read cached "protein's light so far"). Only a real flip
        // between two PRESENT buckets counts — a cached row from before this signal
        // existed (pre-deploy) has no fuel key, and must NOT churn the whole cache on
        // deploy, so a missing side is treated as no-change.
        const liveFuel = (live?.signals?.fuel as { bucket?: unknown } | undefined)?.bucket;
        const cachedFuel = (cached?.signals?.fuel as { bucket?: unknown } | undefined)?.bucket;
        const fuelBucketChanged = liveFuel != null && cachedFuel != null && liveFuel !== cachedFuel;
        const materialTruthChanged =
          completionChanged ||
          liveHasWork !== cachedHasWork ||
          loadClassificationChanged ||
          trainedFactChanged ||
          fuelBucketChanged ||
          proseContradiction != null ||
          fingerprintChanged;
        if (materialTruthChanged) {
          const factual = {
            ...live,
            headline: dayReadHeadline(live, readDate),
            source: "deterministic",
            override: null,
          };
          // No await separates the getCachedDayRead above from this write, dayRead()
          // is synchronous, and node:sqlite is synchronous in a single process — so
          // nothing can persist a newer steer in between and the compare-and-replace
          // cannot lose. (An earlier "serve the winner instead" branch guarded that
          // impossible interleaving; keep this block await-free so it stays so.)
          try {
            if (cached.override) {
              replaceStaleDayReadOverride(readDate, factual, {
                override: cached.override,
                input_fingerprint: cached.input_fingerprint,
                computed_at: cached.computed_at,
              });
            } else {
              saveDayRead(readDate, factual);
            }
          } catch {
            /* the response is still truthful */
          }
          // The factual row keeps every subsequent open truthful, but its prose is
          // the deterministic floor. Re-warm in the background (debounced, agent-gated)
          // so the day still gets the warm agentic DONE debrief instead of pinning
          // floor prose for the rest of the day.
          scheduleDayReadRefresh(readDate);
          if (recordOutcome) recordDayReadSuggestion(readDate, factual, null);
          return attachDayReadContext(readDate, { ...factual, agent_status: agentStatusFor(factual) });
        }
        if (recordOutcome) recordDayReadSuggestion(readDate, cached, null);
        return attachDayReadContext(readDate, { ...cached, cached: true, agent_status: agentStatusFor(cached) });
      }
    }

    // The cache-miss path. Every invalidation leaves the cache cold, so a burst of
    // opens against one cleared row used to spawn one agent run EACH (plus the
    // background re-warm's). The canonical read now has one lane per date; a steered
    // read is transient and never cached, so it keeps its own run.
    const read = override
      ? await computeDayRead({ date, override, agent })
      : await computeCanonicalDayRead({ date, agent });
    if (recordOutcome) recordDayReadSuggestion(readDate, read, override ?? null);
    return attachDayReadContext(readDate, { ...read, agent_status: agentStatusFor(read) });
  } catch (e: any) {
    const fallback = dayRead(date);
    return attachDayReadContext(readDate, {
      ...fallback,
      headline: dayReadHeadline(fallback, readDate),
      source: "deterministic",
      error: e?.message ?? String(e),
    });
  }
}
