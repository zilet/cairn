// The day-read CACHE — the persisted Brief row and its invalidation rules.
//
// Split out of day-read.ts (W2-H2): one canonical read per calendar day, the
// no-clobber guards around an athlete's own steer, the decision-fingerprint-gated
// invalidation, and the re-open of an already-judged day. It sits ABOVE the read
// engine (it calls dayRead / the fingerprint builders to decide whether a cached row
// is still true); nothing in the engine reads back into this module.
import { db } from "../db.js";
import { scheduleDayReadRefresh } from "../dayread-refresh.js";
import { invalidateBrainSnapshot } from "../brain/snapshot.js";
import { recordDayReadDecision, reopenDayReadAdherence } from "./brain/read-adherence.js";
import { localDateISO } from "./shared.js";
import { afterSqliteCommit } from "./sqlite-savepoint.js";
import {
  currentDayReadFingerprintContext,
  dayRead,
  dayReadInputFingerprint,
  type DayRead,
} from "./day-read.js";

// ---------- Day-read cache (the Brief) ----------
// One canonical (no-override) read per calendar day, persisted so the morning
// open is instant. The nightly scheduler pass (and any cache miss) fills it; the
// few events that materially change the read invalidate the affected day, and
// the next open recomputes once and re-caches. See src/dayread.ts for the
// agentic compute + write path that wraps the deterministic dayRead() above.
export function getCachedDayRead(date: string): any | null {
  const row = db.prepare(`SELECT * FROM day_reads WHERE date = ?`).get(date) as any;
  if (!row) return null;
  let signals: any = {};
  try {
    signals = row.signals ? JSON.parse(row.signals) : {};
  } catch {
    signals = {};
  }
  const meta = signals?._day_read_meta && typeof signals._day_read_meta === "object" ? signals._day_read_meta : {};
  if (signals && typeof signals === "object") delete signals._day_read_meta;
  const computedAt = String(row.computed_at ?? "").replace(" ", "T");
  const normalizedComputedAt = computedAt && !/[zZ]|[+-]\d\d:\d\d$/.test(computedAt) ? `${computedAt}Z` : computedAt;
  const decision = meta.decision ?? undefined;
  return {
    kind: row.kind,
    headline: row.headline,
    why: row.why,
    focus: row.focus ?? null,
    est_minutes: row.est_minutes ?? null,
    signals,
    source: row.source || "deterministic",
    agent: row.agent || undefined,
    override: row.override ?? null,
    decision,
    input_fingerprint: meta.input_fingerprint ?? undefined,
    // The deterministic call this row's prose was written for (see dayReadProseIdentity).
    // Absent on rows written before the pin existed — an unknown identity never matches,
    // so such a row simply recomputes once and then carries one.
    prose_identity: typeof meta.prose_identity === "string" ? meta.prose_identity : undefined,
    curated: meta.curated === true,
    computed_at: decision?.computed_at ?? (normalizedComputedAt || undefined),
  };
}

export interface CachedOverrideIdentity {
  override: string;
  input_fingerprint?: string;
  computed_at?: string;
}

function writeDayRead(date: string, read: any, expectedStaleOverride?: CachedOverrideIdentity): boolean {
  if (!date || !read || !read.kind) return false;
  const override = read.override != null && String(read.override).trim() ? String(read.override).trim() : null;
  // A CURATED read is deliberately authored rather than derived — the demo seed's
  // hand-written Brief, and anything else pinned on purpose. Its signals are
  // illustrative, so no fingerprint the live DB produces will ever match it; left
  // to the ordinary rules it gets overwritten by the deterministic floor on the
  // first open. It is pinned instead: only an explicit invalidateDayRead() (which
  // deletes the row outright) retires it.
  const curated = read.curated === true;
  const existing = getCachedDayRead(date);
  if (existing?.curated && !curated) return false;
  // No-clobber guard: a canonical (no-steer) recompute — nightly precompute, boot
  // warm, a cache-miss compute — must never overwrite an athlete's persisted steer
  // for the day. Ordinary material writes clear it via invalidateDayRead(); the
  // serve-time reconciliation path uses the exact-identity replacement below.
  if (!override && existing?.override) {
    const trustedReplacement =
      !!expectedStaleOverride &&
      existing.override === expectedStaleOverride.override &&
      existing.input_fingerprint === expectedStaleOverride.input_fingerprint &&
      existing.computed_at === expectedStaleOverride.computed_at;
    if (!trustedReplacement) return false;
  }
  let inputFingerprint = typeof read.input_fingerprint === "string" ? read.input_fingerprint : null;
  if (!inputFingerprint) {
    try {
      inputFingerprint = dayReadInputFingerprint(date, read, currentDayReadFingerprintContext(date));
    } catch {
      inputFingerprint = null;
    }
  }
  const computedAt =
    typeof read.computed_at === "string" && read.computed_at ? read.computed_at : new Date().toISOString();
  const decision =
    read.decision && typeof read.decision === "object"
      ? read.decision
      : {
          rule_code: "cached_read_write",
          basis: read.source === "agent" ? "agent" : "deterministic",
          baseline_kind: read.kind,
          // A read handed to us without a decision has no reason BEYOND its own
          // `why` — and the athlete must never be shown boundary trivia dressed up
          // as coaching, so the reason stays empty and the Brief renders nothing.
          reason: "",
          evidence: [],
          computed_at: computedAt,
        };
  const storedSignals = {
    ...(read.signals ?? {}),
    _day_read_meta: {
      decision,
      input_fingerprint: inputFingerprint,
      ...(typeof read.prose_identity === "string" && read.prose_identity
        ? { prose_identity: read.prose_identity }
        : {}),
      ...(curated ? { curated: true } : {}),
    },
  };
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, est_minutes, signals, source, agent, override, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       kind=excluded.kind, headline=excluded.headline, why=excluded.why, focus=excluded.focus,
       est_minutes=excluded.est_minutes, signals=excluded.signals, source=excluded.source,
       agent=excluded.agent, override=excluded.override, computed_at=excluded.computed_at`
  ).run(
    date,
    read.kind,
    read.headline ?? null,
    read.why ?? null,
    read.focus ?? null,
    read.est_minutes != null && Number.isFinite(Number(read.est_minutes)) ? Math.round(Number(read.est_minutes)) : null,
    JSON.stringify(storedSignals),
    read.source ?? "deterministic",
    read.agent ?? null,
    override
  );
  // Keep the table to a rolling few weeks — old reads are never served.
  try {
    db.prepare(`DELETE FROM day_reads WHERE date < date('now','-21 days')`).run();
  } catch { /* bounding the table is housekeeping — never fail the read it rode in on */ }
  // Persist the recommendation as a bounded, outcome-addressable decision carrying
  // a falsifiable read-adherence expectation. This runs after the canonical cache
  // write and is intentionally fail-soft: an audit outage must never make the Brief
  // unavailable.
  //
  // The identity used to be the whole `signals` blob, which moves all day, so one
  // date produced ~19 immutable rows and 18 supersedes. It is now the CLAIM the read
  // makes — kind plus override, deliberately NOT `inputFingerprint` (see
  // recordDayReadDecision) — so any recompute reaching the same conclusion is
  // idempotent and only a genuine change of call records.
  try {
    recordDayReadDecision(date, read, { override });
  } catch {
    // The day-read cache is authoritative; learning/audit recording is best effort.
  }
  return true;
}

export function saveDayRead(date: string, read: any): boolean {
  return writeDayRead(date, read);
}

// The one trusted exception to saveDayRead's athlete-steer no-clobber guard.
// readToday's material-truth reconciliation passes the exact cached identity it
// inspected; a newer/different steer therefore wins and is never cleared.
export function replaceStaleDayReadOverride(date: string, read: any, expected: CachedOverrideIdentity): boolean {
  if (!expected?.override) return false;
  return writeDayRead(date, read, expected);
}

// Work that lands for a day ALREADY judged re-opens that judgement. This is the one
// part of an invalidation that must NOT be economised away, because it answers a
// different question from the read cache. The cache asks "could today's suggestion
// have changed"; adherence asks "was the suggestion I already made followed", and it
// asks it against the RAW logged counts (`adherenceFactsChanged` in
// brain/read-adherence.ts compares logged_sets / logged_activities / real_activities
// / load). The decision fingerprint deliberately drops exactly that granularity — a
// set added to a past day moves no grade and no fact — so a late correction on a
// judged day leaves the fingerprint perfectly still. Gate the re-open behind the
// fingerprint and that correction is never re-judged, and the resulting error is
// asymmetric: a missed re-judgement always turns a `diverged` into a stale
// `aligned`, never the reverse, so the loop quietly flatters itself on the one metric
// built to measure it honestly.
//
// Cheap by construction. Only a PAST day can have been judged (an expectation for `d`
// matures on d+1), so today — the overwhelmingly common case — costs one string
// compare and no query at all; and reopenDayReadAdherence itself no-ops unless the
// day's logged facts actually moved. Best-effort: re-judging must never fail a write.
//
// Callers run this AFTER COMMIT, so a rolled-back savepoint can never re-open a
// judgement against a write that did not land.
function reopenJudgedDay(d: string): void {
  try {
    if (d < localDateISO()) reopenDayReadAdherence(d);
  } catch {
    /* re-judging is best effort; it must never fail a write */
  }
}

// The same invalidation, but only when the write could actually have changed what
// today should be. `invalidateDayRead` DELETES the row unconditionally, so a
// six-hourly watch sync (or a re-sync writing byte-identical numbers) destroyed the
// warm agentic read before the narrowed decision fingerprint was ever consulted —
// the serve-time comparison wave 1 built could not run on a row that no longer
// existed. Recomputing the deterministic floor and comparing fingerprints costs one
// synchronous read; losing the coach's sentence costs the athlete the Brief.
//
// It is now also what the TRAINING LOG writes go through — logging a set, importing
// Garmin sets, recording an activity, a Garmin upsert or strength reconcile. Those
// fire far more often than a watch sync (once per set), and under the unconditional
// path each one deleted the cached read and armed another agent run, which is how a
// single evening spent ten-plus day_read recomputes on an already-terminal day.
//
// Returns true when the cached read was actually retired. A cold cache still takes
// the normal path — no live read is computed at all — so the fresh-wake background
// re-warm keeps its trigger and a burst against a cold cache stays cheap.
//
// The one thing it does NOT economise is re-judging a day that has already been
// judged — see reopenJudgedDay, which runs on every exit path.
export function invalidateDayReadIfDecisionChanged(date?: string): boolean {
  const d = date || localDateISO();
  let cached: any = null;
  try {
    cached = getCachedDayRead(d);
  } catch {
    cached = null;
  }
  // A curated read is pinned on purpose — only an explicit invalidateDayRead retires it.
  if (cached?.curated) {
    afterSqliteCommit(() => reopenJudgedDay(d));
    return false;
  }
  if (cached && typeof cached.input_fingerprint === "string" && cached.input_fingerprint) {
    // The comparison is only as good as the state it reads, and the unified signal
    // state plus its training-log producers are memoized per (date, request). A
    // caller that already touched them earlier in the SAME request — which is every
    // set-logging request that reconciles or reads before it writes — would compare
    // the PRE-write snapshot, find the fingerprint unmoved, and pin a Brief that is
    // now wrong. Drop exactly the keys invalidateDayRead drops after commit; the
    // 14-day recovery window and the 21-day TDEE stay warm because neither moves on
    // one training write. Outside a request scope this is a no-op.
    //
    // `day_read` belongs in this set even though the cached row is about to SURVIVE:
    // coach.ts memoizes the read with the request's signal state embedded in its
    // `signals`, so dropping signal_state without it would leave the coach context
    // holding a fresh signal_state beside a day_read carrying the stale one. Rebuild
    // is cheap on this path precisely because the row is still there.
    invalidateBrainSnapshot("day_read");
    invalidateBrainSnapshot("signal_state");
    invalidateBrainSnapshot("recent_sessions");
    invalidateBrainSnapshot("training_signals");
    invalidateBrainSnapshot("program_state");
    let live: DayRead | null = null;
    try {
      live = dayRead(d);
    } catch {
      live = null;
    }
    if (live?.input_fingerprint && live.input_fingerprint === cached.input_fingerprint) {
      // The cached READ survives — but the day's JUDGEMENT is still re-opened.
      afterSqliteCommit(() => reopenJudgedDay(d));
      return false;
    }
  }
  invalidateDayRead(d); // re-opens the judgement itself, on its own commit hook
  return true;
}

export function invalidateDayRead(date?: string): void {
  const d = date || localDateISO();
  try {
    db.prepare(`DELETE FROM day_reads WHERE date = ?`).run(d);
  } catch { /* nothing cached for that date is the outcome invalidation wanted */ }
  // Fresh-wake: schedule a debounced, coalesced, fire-and-forget background
  // recompute so the athlete's next open serves a warm agentic read instead of
  // paying the ~90s agent run inline. Best-effort + off the write path — it only
  // acts when `d` covers today AND an agent is usable (see src/dayread-refresh.ts).
  afterSqliteCommit(() => {
    invalidateBrainSnapshot("day_read");
    // The unified signal state is now memoized per (date, request), and a day-read
    // invalidation means the training log just moved underneath it. Drop it and the
    // training-log-derived producers it reads, so a recompute LATER IN THE SAME
    // request sees the write rather than the pre-write snapshot. The two heaviest
    // producers (recovery:14, expenditure:21) are deliberately left warm — neither
    // a 14-day recovery window nor a 21-day TDEE moves on one logged set.
    invalidateBrainSnapshot("signal_state");
    invalidateBrainSnapshot("recent_sessions");
    invalidateBrainSnapshot("training_signals");
    invalidateBrainSnapshot("program_state");
    try {
      scheduleDayReadRefresh(d);
    } catch { /* the refresh is a warm-ahead convenience; the next open recomputes anyway */ }
    // Work that lands for a day ALREADY judged re-opens that judgement. Every
    // training write for a date reaches EITHER this function or its guarded sibling
    // with that date, and BOTH re-open — which is why the hook lives on the two
    // invalidation functions rather than at the eight call sites where the ninth
    // would silently be missed. See reopenJudgedDay for why the guarded path cannot
    // skip it.
    reopenJudgedDay(d);
  });
}
