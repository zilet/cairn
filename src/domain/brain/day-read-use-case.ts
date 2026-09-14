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
  dayReadProseIdentity,
  forwardLook,
  getCachedDayRead,
  invalidateDayRead,
  replaceStaleDayReadOverride,
  saveDayRead,
  type DayReadDecision,
  type DayReadPeriodizationContext,
} from "../../repo/intelligence.js";
import { morningReview, type MorningReview } from "../../repo/brain/morning-review.js";
import { recordSuggestion } from "../../repo/memory.js";
import { buildRecoveryMenu, type RecoveryMenu } from "../../repo/recovery-menu.js";
import { weekWins } from "../../repo/sessions.js";
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
  // When the evidence behind the read last landed (see evidenceAsOf below). Absent
  // when no fresh evidence has a sync row to point at.
  evidence_as_of?: string;
  computed_at?: string;
  // A hand-authored read (the demo seed's Brief) pinned against recompute.
  curated?: boolean;
  // The optional guided recovery menu on a rest/easy day (never dayRead-computed,
  // never persisted — derived fresh alongside forward/arc; see attachDayReadContext).
  recovery?: RecoveryMenu | null;
  // The same trained-days/new-bests rollup the done card's week footnote reads
  // (today-session-status-client.ts doneWeekHtml), threaded onto rest/easy Briefs
  // too — the reassurance matters most on a day with no session card to carry it.
  // Never persisted (derived fresh, same precedent as recovery); absent on a
  // zero-training week (absence is not failure — the client renders nothing).
  week?: { trained_days_7: number; prs: number } | null;
  // The morning wake-up review (W4.7): one short past-tense passage above
  // today's suggestion, plus an optional landed win. Never persisted (derived
  // fresh, same precedent as forward/arc/week/recovery); absent entirely when
  // there's nothing to say — silence is the calm default, not a failure state.
  look_back?: MorningReview | null;
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

// ---------- WHEN THE EVIDENCE LANDED, NOT WHEN THE SENTENCE WAS WRITTEN ----------
//
// The Brief's stamp said one thing — "Updated 4:00 AM" — for two different facts,
// and the client has long been ready to say both ("As of 7:39 sync" over "Read at
// 4:00 AM"). Nothing on the server ever emitted the first half, so the midnight
// rollover recompute's own clock read as the age of the athlete's data.
//
// Two rules keep this honest. It reads only evidence the signal state itself
// resolved `fresh` — a stale reading is absent everywhere else and must not date
// the Brief either. And it returns an INSTANT or nothing: observations carry a
// wake-day DATE, and rendering a bare date through the client's clock formatter
// would print a midnight no sync ever happened at. The instant comes from the row
// the sync actually wrote, so the label ("As of … sync") is literally true; with no
// such row the key is omitted and the client falls back to computed_at, which is
// exactly the pre-existing single line.
function evidenceAsOf(read: Record<string, unknown>): string | null {
  try {
    const state = (read?.signals as { signal_state?: any } | undefined)?.signal_state;
    const dimensions = state?.dimensions;
    if (!dimensions || typeof dimensions !== "object") return null;
    const dates = new Set<string>();
    for (const dimension of Object.values(dimensions as Record<string, any>)) {
      for (const item of Array.isArray(dimension?.evidence) ? dimension.evidence : []) {
        if (item?.freshness !== "fresh") continue;
        const date = String(item?.date ?? "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
      }
    }
    if (!dates.size) return null;
    const list = [...dates];
    const landed = db
      .prepare(
        `SELECT MAX(COALESCE(updated_at, created_at)) AS at FROM garmin_daily_metrics
          WHERE date IN (${list.map(() => "?").join(",")})`
      )
      .get(...list) as { at?: string | null } | undefined;
    const at = landed?.at ? String(landed.at).trim() : "";
    if (!at) return null;
    // SQLite's datetime('now') is UTC with no zone marker, and the client parses this
    // with `new Date(...)` — which reads a bare stamp as LOCAL time and would shift
    // the label by the whole offset. Say UTC explicitly.
    return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(at) ? at : `${at.replace(" ", "T")}Z`;
  } catch {
    return null;
  }
}

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

  // The week-wins reassurance: rest/easy Briefs otherwise carry no reminder that
  // training has actually been happening. Same aggregate the done card's week
  // footnote reads (repo/sessions.ts weekWins) — a zero-training week yields the
  // key `undefined` here, and doneWeekHtml renders nothing for it either way.
  let week: { trained_days_7: number; prs: number } | null = null;
  try {
    const kind = String(read.kind ?? "");
    if (kind === "rest" || kind === "easy") {
      const w = weekWins(readDate);
      const days = Number(w?.trained_days_7 ?? 0);
      const prs = Array.isArray(w?.prs) ? w.prs.length : 0;
      if (days > 0 || prs > 0) week = { trained_days_7: days, prs };
    }
  } catch {
    week = null;
  }

  // The look-back: derived fresh, same precedent as forward/arc/week above.
  // Empty (no passages, no win) is omitted from the response entirely, exactly
  // like `week` on a zero-training week — absence is not failure.
  let lookBack: MorningReview | null = null;
  try {
    const review = morningReview(readDate);
    if (review.passages.length || review.win) lookBack = review;
  } catch {
    lookBack = null;
  }

  const asOf = evidenceAsOf(read);

  return {
    ...read,
    forward,
    arc,
    ...(asOf ? { evidence_as_of: asOf } : {}),
    periodization_context: periodizationContext,
    ...(attention ? { attention } : {}),
    ...(recovery ? { recovery } : {}),
    ...(week ? { week } : {}),
    ...(lookBack ? { look_back: lookBack } : {}),
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
      // readToday only ever runs on a request the athlete made, so every compute it
      // reaches for is interactive: it jumps the spawn queue ahead of the scheduler's
      // warms and the enrichment drain rather than opening the Brief on a spinner.
      const read = await computeCanonicalDayRead({ date, agent, force: true, priority: "interactive" });
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
        // A fingerprint move is NOT by itself a change of what the day is. Every input
        // that could move a recommendation moves it — a watch sync, a memoized state
        // going live — and treating that as material is what overwrote the athlete's
        // morning sentence with floor prose and armed a third agent run for one set of
        // facts. What matters is whether the deterministic CALL changed: the read's
        // prose identity (date, kind, rule_code, focus). A row written before the pin
        // existed carries no identity, so fall back to the coarse call it does carry —
        // its baseline kind — rather than churning every cached read on deploy.
        const identityChanged =
          typeof cached.prose_identity === "string"
            ? cached.prose_identity !== dayReadProseIdentity(readDate, live)
            : String(cached.decision?.baseline_kind ?? cached.kind ?? "") !== String(live.kind ?? "");
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
          identityChanged;
        if (materialTruthChanged) {
          const factual = {
            ...live,
            headline: dayReadHeadline(live, readDate),
            source: "deterministic",
            override: null,
            prose_identity: dayReadProseIdentity(readDate, live),
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
        // The inputs drifted but the CALL did not. Keep the sentence the athlete is
        // already reading and re-stamp the row against the fresher evidence — exactly
        // what computeDayRead's prose pin does, done inline because it needs no agent
        // and no timer. That is the whole change: this path used to write floor prose
        // over the morning's wording and arm yet another agent run.
        if (fingerprintChanged && !cached.override) {
          const stampedAt = new Date().toISOString();
          const restamped = {
            ...cached,
            signals: live.signals,
            input_fingerprint: live.input_fingerprint,
            prose_identity: dayReadProseIdentity(readDate, live),
            // Prose stays pinned, provenance stays current — the same split
            // pinnedDayReadProse makes, for the same reason: a decision re-stamped
            // with a fresh computed_at over the morning's evidence list describes two
            // different moments in one row. The cached list is the fallback so a
            // decision never loses provenance it already had.
            decision:
              cached.decision && typeof cached.decision === "object"
                ? {
                    ...cached.decision,
                    computed_at: stampedAt,
                    evidence: Array.isArray(live?.decision?.evidence)
                      ? live.decision.evidence
                      : cached.decision.evidence,
                  }
                : live.decision,
            computed_at: stampedAt,
          };
          try {
            saveDayRead(readDate, restamped);
          } catch {
            /* the response is still truthful */
          }
          if (recordOutcome) recordDayReadSuggestion(readDate, restamped, null);
          return attachDayReadContext(readDate, {
            ...restamped,
            cached: true,
            agent_status: agentStatusFor(restamped),
          });
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
      ? await computeDayRead({ date, override, agent, priority: "interactive" })
      : await computeCanonicalDayRead({ date, agent, priority: "interactive" });
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
