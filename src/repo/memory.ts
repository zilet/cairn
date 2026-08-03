import { db } from "../db.js";
import { POST_INTERVENTION_MIN_SPAN_DAYS, postInterventionWeightTrend } from "./goal-pace.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { getSessionByDate, sessionSummary } from "./sessions.js";

export type KnownMemoryKind =
  | "note"
  | "preference"
  | "constraint"
  | "goal"
  | "fact"
  | "observation"
  | "injury"
  | "decision"
  | "milestone"
  | "learning";
export type MemoryKind = KnownMemoryKind | (string & {});

export interface MemoryRow {
  id: number;
  kind: MemoryKind | null;
  content: string;
  source: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  superseded_by?: number | null;
  confidence?: number | null;
  last_referenced_at?: string | null;
}

export interface MemorySupersedeResult {
  superseded: MemoryRow | null;
  replacement: MemoryRow | null;
}

export interface RecentLearning {
  id: number;
  kind: "learning";
  content: string;
  source: string | null;
  updated_at?: string | null;
}

// ---------- memory (self-updating) ----------
// Memory is no longer a flat append-only log. A row can be RE-OBSERVED (its
// content refreshed, confidence bumped), SUPERSEDED by a newer row (marked, never
// hard-deleted — same discipline as chat archiving), and stamped when last
// surfaced to the coach. The conflict-aware update path generalizes the v26
// directive-feedback pattern (a new observation either reinforces or replaces a
// prior one) to free-text memory.

// Normalize for a forgiving similarity check (lowercase, drop punctuation,
// collapse whitespace) — shared by memory dedup and insight dedup. A handful of
// generic words are dropped (via memTokens) so "prefers training in the morning"
// and "trains mornings" overlap on the load-bearing tokens, not on filler.
const MEM_STOPWORDS = new Set(
  "the a an and or to of in on for is are i im my me you your he she they it that this with at as be been being do does prefer prefers like likes".split(
    " "
  )
);
export function memNorm(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function memTokens(s: string): Set<string> {
  return new Set(
    memNorm(s)
      .split(" ")
      .filter((w) => w && !MEM_STOPWORDS.has(w))
  );
}
// Jaccard word-overlap between two token sets (0..1). Shared by the memory
// near-dup fold (stopword-trimmed tokens) and the insight dedup guard.
export function jaccard(A: Set<string>, B: Set<string>): number {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}
// Jaccard word-overlap between two memory contents (0..1), stopword-trimmed.
function memOverlap(a: string, b: string): number {
  return jaccard(memTokens(a), memTokens(b));
}

// Add a durable memory. Three-tier dedup, strongest-first:
//   1. exact (case-insensitive) repeat → return the existing row, bump confidence
//   2. near-duplicate of a recent SAME-KIND live row (≥ MEM_DUP_THRESHOLD overlap)
//      → fold into it: refresh content to the longer/newer phrasing, advance
//        updated_at, raise confidence. We update in place instead of accumulating
//        near-identical noise — the headline self-updating behavior.
//   3. otherwise → insert a fresh row.
// Superseded rows are excluded from the near-dup comparison (they're history).
const MEM_DUP_THRESHOLD = 0.6;
export function addMemory(content: string, kind: MemoryKind = "observation", source = "user"): MemoryRow | null {
  const trimmed = (content ?? "").toString().trim();
  if (!trimmed) {
    // Nothing to remember — return the most recent live row as a harmless no-op
    // value so callers that read `.id` don't crash (matches prior truthy return).
    return (
      (db.prepare(`SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY id DESC LIMIT 1`).get() as
        | MemoryRow
        | undefined) ?? null
    );
  }
  // 1. exact repeat (any kind) — reinforce, never duplicate.
  const exact = db
    .prepare(`SELECT * FROM memory WHERE content = ? COLLATE NOCASE AND superseded_by IS NULL`)
    .get(trimmed) as MemoryRow | undefined;
  if (exact) {
    db.prepare(
      `UPDATE memory SET updated_at = datetime('now'), confidence = MIN(5, COALESCE(confidence,1) + 0.5) WHERE id = ?`
    ).run(exact.id);
    return getMemory(exact.id);
  }
  // 2. semantic near-duplicate among recent same-kind live rows.
  const recent = db
    .prepare(`SELECT * FROM memory WHERE superseded_by IS NULL AND kind = ? ORDER BY id DESC LIMIT 60`)
    .all(kind) as unknown as MemoryRow[];
  let best: MemoryRow | null = null,
    bestScore = 0;
  for (const r of recent) {
    const score = memOverlap(trimmed, String(r.content ?? ""));
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (best && bestScore >= MEM_DUP_THRESHOLD) {
    // Fold in: keep the richer phrasing (longer wins, ties keep the new one),
    // advance updated_at, raise confidence. No new row.
    const keep = trimmed.length > String(best.content ?? "").length ? trimmed : String(best.content);
    db.prepare(
      `UPDATE memory SET content = ?, updated_at = datetime('now'), confidence = MIN(5, COALESCE(confidence,1) + 0.5) WHERE id = ?`
    ).run(keep, best.id);
    return getMemory(best.id);
  }
  // 3. genuinely new fact.
  const info = db
    .prepare(`INSERT INTO memory (kind, content, source, confidence) VALUES (?, ?, ?, 1)`)
    .run(kind, trimmed, source);
  return (db.prepare(`SELECT * FROM memory WHERE id = ?`).get(info.lastInsertRowid) as MemoryRow | undefined) ?? null;
}

// List memory, newest first. Superseded rows are HIDDEN by default (they're
// history kept for the curation UI / export, never surfaced to the coach);
// pass includeSuperseded for the full curate-able list.
export function listMemory(limit = 50, opts: { includeSuperseded?: boolean } = {}): MemoryRow[] {
  limit = Math.max(1, Math.min(500, Number(limit) || 50)); // clamp caller-supplied limit
  const where = opts.includeSuperseded ? "" : "WHERE superseded_by IS NULL";
  return db.prepare(`SELECT * FROM memory ${where} ORDER BY id DESC LIMIT ?`).all(limit) as unknown as MemoryRow[];
}

export function getMemory(id: number): MemoryRow | null {
  return (db.prepare(`SELECT * FROM memory WHERE id = ?`).get(id) as MemoryRow | undefined) ?? null;
}

export function updateMemory(
  id: number,
  patch: { content?: string; kind?: MemoryKind; confidence?: number }
): MemoryRow | null {
  const cur = getMemory(id);
  if (!cur) return null;
  const conf = Number.isFinite(patch.confidence as number)
    ? Math.min(5, Math.max(0, Number(patch.confidence)))
    : (cur.confidence ?? null);
  db.prepare(`UPDATE memory SET content = ?, kind = ?, confidence = ?, updated_at = datetime('now') WHERE id = ?`).run(
    patch.content != null ? String(patch.content).trim() : cur.content,
    patch.kind ?? cur.kind,
    conf,
    id
  );
  return getMemory(id);
}

// Mark a memory superseded by another row (we MARK, never destroy — the old fact
// stays in the DB and exports for an audit trail, just hidden from live reads).
// If replacementContent is given, a new row is created first and the old one
// points at it; otherwise the caller passes an existing replacementId.
export function supersedeMemory(
  id: number,
  replacement?: { content?: string; kind?: MemoryKind; replacementId?: number; reason?: string }
): MemorySupersedeResult | null {
  const cur = getMemory(id);
  if (!cur) return null;
  let newId = replacement?.replacementId ?? null;
  let newRow: MemoryRow | null = null;
  const content = replacement?.content ? String(replacement.content).trim() : "";
  if (!newId && content) {
    // addMemory may itself fold the replacement into an existing live row; use
    // whatever id it lands on as the supersedor (and never point a row at itself).
    newRow = addMemory(content, replacement?.kind ?? cur.kind ?? "observation", "supersede");
    newId = newRow?.id ?? null;
  } else if (newId) {
    newRow = getMemory(newId);
  }
  if (newId && newId === id) newId = null; // a fold-into-self is just an update, not a supersession
  db.prepare(`UPDATE memory SET superseded_by = ?, updated_at = datetime('now') WHERE id = ?`).run(newId, id);
  return { superseded: getMemory(id), replacement: newRow };
}

export function deleteMemory(id: number) {
  return { deleted: db.prepare(`DELETE FROM memory WHERE id = ?`).run(id).changes };
}

// Stamp a set of memory ids as just-surfaced-to-the-coach (recency-of-reference,
// distinct from created_at/updated_at). Bounded and best-effort.
function touchMemoryReferenced(ids: number[]) {
  if (!ids?.length) return;
  const stmt = db.prepare(`UPDATE memory SET last_referenced_at = datetime('now') WHERE id = ?`);
  for (const id of ids.slice(0, 60)) {
    try {
      stmt.run(id);
    } catch {
      /* best effort */
    }
  }
}

// Ranked retrieval for the coaching context. Instead of a raw recency dump, this
// ALWAYS includes the load-bearing kinds (constraint/injury/preference/decision/
// milestone/goal) — the durable person-model — PLUS the most recent observations,
// excludes superseded rows, and is bounded. Surfacing a memory stamps its
// last_referenced_at so the consolidation pass can tell live facts from stale ones.
//
// RECENCY IS THE TIEBREAK, NEVER THE RANK. Confidence stays primary — a fact the
// athlete has restated is load-bearing however long ago they first said it — but
// among equally-confident rows the one that has been LIVE most recently wins, and
// "live" means COALESCE(last_referenced_at, updated_at, created_at): a stamp this
// column has carried since v-whenever and that, until now, nothing ever read.
// Ordering by updated_at alone made a preference stated once in June rank exactly
// like one confirmed yesterday.
export function memoryForCoach(limit = 40): MemoryRow[] {
  const loadBearing = db
    .prepare(
      `SELECT * FROM memory
     WHERE superseded_by IS NULL
       AND COALESCE(source, '') <> 'reaction-model'
       AND kind IN ('constraint','injury','preference','decision','milestone','goal')
     ORDER BY COALESCE(confidence,1) DESC,
              COALESCE(last_referenced_at, updated_at, created_at) DESC,
              id DESC
     LIMIT ?`
    )
    .all(Math.max(8, Math.floor(limit * 0.7))) as unknown as MemoryRow[];
  const seen = new Set(loadBearing.map((r) => r.id));
  const recent = db
    .prepare(
      `SELECT * FROM memory
      WHERE superseded_by IS NULL AND COALESCE(source, '') <> 'reaction-model'
      ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as unknown as MemoryRow[];
  const merged: MemoryRow[] = [...loadBearing];
  for (const r of recent) {
    if (merged.length >= limit) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  const out = merged.slice(0, limit);
  touchMemoryReferenced(out.map((r) => r.id));
  return out;
}

// ---------- outcome learning (suggestions → actuals) ----------
// Record what a producer (the Brief / session-suggest / nutrition check-in)
// PROPOSED, so a quiet reconciliation pass can later compare it to what actually
// happened and learn the athlete's tendencies. Suggestion-not-a-gate: this never
// gates a future suggestion, it only seasons the coach context with learnings.
export type SuggestionKind = "day_read" | "session_suggest" | "nutrition_checkin";

export function recordSuggestion(kind: SuggestionKind, date: string | null, payload: any) {
  try {
    const info = db
      .prepare(`INSERT INTO suggestions (kind, date, payload_json) VALUES (?, ?, ?)`)
      .run(kind, date ?? null, payload != null ? JSON.stringify(payload).slice(0, 8000) : null);
    return db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(info.lastInsertRowid);
  } catch {
    return null; // recording an outcome is never allowed to break the producer
  }
}

function hydrateSuggestion(r: any) {
  if (!r) return null;
  let payload: any = null,
    outcome: any = null;
  try {
    payload = r.payload_json ? JSON.parse(r.payload_json) : null;
  } catch {}
  try {
    outcome = r.outcome_json ? JSON.parse(r.outcome_json) : null;
  } catch {}
  return { ...r, payload, outcome };
}

export function listSuggestions(limit = 50) {
  limit = Math.max(1, Math.min(500, Number(limit) || 50)); // clamp caller-supplied limit
  return (db.prepare(`SELECT * FROM suggestions ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrateSuggestion);
}

// HAZARD: the day_read ledger is one row per RECORDING, not one row per date.
// Before the dedupe guard in recordDayReadSuggestion() (day-read-use-case.ts)
// existed, every Brief open re-recorded the day's canonical (override:null)
// suggestion, and a read legitimately evolves during the day (morning rest -> the
// athlete trains -> train -> done) — so a re-opened date accumulated one row per
// open while looking exactly like a single morning suggestion. Migration 78
// backfill-deduped the historical fallout and the live guard now keeps future
// canonical rows to one per date, but any caller that queries `suggestions`
// directly is one GROUP BY / COUNT away from re-introducing the same trap (a
// future regression of the guard, or simply forgetting it exists) and silently
// over-weighting a re-opened date. Read the day_read ledger through THIS helper
// instead of the raw table whenever the analysis wants one observation per date:
// it always collapses to the earliest (MIN id) CANONICAL row per date — the
// morning read, recorded before the day's outcome could influence it. Steered
// rows (override IS NOT NULL) are deliberately excluded: each steer is a distinct,
// non-idempotent athlete action, not a re-open, and every date can carry more than
// one (see recordDayReadSuggestion's contract) — a caller that also needs steer
// history should query `suggestions` directly rather than collapse it away here.
export function dayReadSuggestionsByDate(opts: { since?: string; until?: string } = {}) {
  // payload_json IS NOT NULL AND json_valid(payload_json) guards json_extract()
  // below: without it, a NULL payload_json row reads as canonical (json_extract of
  // NULL is NULL, same as an explicit override:null) and a malformed one throws
  // and aborts the whole query. Both are excluded from the candidate pool instead —
  // never returned as if they were the canonical row for their date.
  const conds = [
    `kind = 'day_read'`,
    `date IS NOT NULL`,
    `payload_json IS NOT NULL`,
    `json_valid(payload_json)`,
    `json_extract(payload_json, '$.override') IS NULL`,
  ];
  const params: string[] = [];
  if (opts.since) {
    conds.push(`date >= ?`);
    params.push(opts.since);
  }
  if (opts.until) {
    conds.push(`date <= ?`);
    params.push(opts.until);
  }
  const where = conds.join(" AND ");
  const rows = db
    .prepare(
      `SELECT s.* FROM suggestions s
        JOIN (SELECT date, MIN(id) AS min_id FROM suggestions WHERE ${where} GROUP BY date) f
          ON f.date = s.date AND f.min_id = s.id
       ORDER BY s.date ASC`
    )
    .all(...params) as any[];
  return rows.map(hydrateSuggestion);
}

// Durable learnings drawn from reconciliation are stored as memory rows of kind
// 'learning' (source 'outcome-learning'); surfaced to the coach via getCoachContext.
export function recentLearnings(limit = 6): RecentLearning[] {
  return (
    db
      .prepare(
        `SELECT id, kind, content, source, COALESCE(updated_at, created_at) AS updated_at FROM memory
     WHERE kind = 'learning' AND superseded_by IS NULL
     ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(20, Number(limit) || 6))) as Array<{
      id: number;
      content: string;
      source: string | null;
      updated_at?: string | null;
    }>
  ).map((r) => ({
    id: Number(r.id),
    kind: "learning",
    content: String(r.content),
    source: r.source == null ? null : String(r.source),
    updated_at: r.updated_at,
  }));
}

// Surface the outcome-learning store as a quiet "What Cairn has noticed" read (F2).
// Same rows recentLearnings feeds the coach, but with the id + a stamp the UI can
// show — gentle observations drawn from suggestion → actual reconciliation, never
// a score or a gate. Live (non-superseded) learnings only, newest-first. Returns
// { learnings:[{id, content, noticed_at}] } so the panel is a thin projection.
export interface OutcomeLearning {
  id: number;
  content: string;
  noticed_at: string | null;
}
export function getOutcomeLearnings(limit = 12): { learnings: OutcomeLearning[] } {
  const n = Math.max(1, Math.min(50, Number(limit) || 12));
  let learnings: OutcomeLearning[] = [];
  try {
    learnings = (
      db
        .prepare(
          `SELECT id, content, COALESCE(updated_at, created_at) AS noticed_at FROM memory
       WHERE kind = 'learning' AND superseded_by IS NULL
       ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`
        )
        .all(n) as any[]
    ).map((r) => ({
      id: Number(r.id),
      content: String(r.content),
      noticed_at: r.noticed_at ? String(r.noticed_at) : null,
    }));
  } catch {
    /* memory table absent on a very old DB — empty */
  }
  return { learnings };
}

// Write a durable learning, retiring any live learning it CONTRADICTS. The two
// minutes-drift lessons are the case that needs this: they are opposite readings of
// one tendency, so leaving yesterday's "running shorter" live beside today's
// "running longer" would show the coach both at once. Ordering matters — the new row
// is written first so the retired one can point AT it (supersession marks, never
// deletes), and the two texts are deliberately worded far enough apart that
// addMemory's near-dup fold cannot merge them into one drifting sentence.
function writeLearning(lesson: string, retire: readonly string[] = []): void {
  const added = addMemory(lesson, "learning", "outcome-learning");
  if (!added?.id || !retire.length) return;
  for (const stale of retire) {
    const rows = db
      .prepare(
        `SELECT id FROM memory
          WHERE kind = 'learning' AND superseded_by IS NULL AND content = ? COLLATE NOCASE AND id <> ?`
      )
      .all(stale, added.id) as Array<{ id: number }>;
    for (const row of rows) supersedeMemory(row.id, { replacementId: added.id });
  }
}

// Reconcile suggestions whose date has passed and that aren't reconciled yet:
// compare suggestion → actual and, where there's a genuine, plain-language lesson,
// write ONE durable 'learning' memory. Deterministic & calm — no agent needed, no
// numeric scores surfaced, never a gate. Bounded per pass.
//
// A row can also DEFER: a nutrition check-in judged the day after it was made has no
// post-intervention evidence yet, and guessing off the pre-intervention trend is
// exactly the bug this loop used to have. A deferred row records its partial outcome
// and keeps `reconciled_at` NULL so a later nightly pass concludes it. That is
// idempotent (the partial outcome is rewritten, never appended) and terminating —
// reconcileOneSuggestion closes a check-in at its deadline whatever the evidence, so
// nothing requeues forever. Deferral is SILENT: no lesson, no error.
export function reconcileSuggestions(opts: { maxPerPass?: number } = {}): {
  reconciled: number;
  learnings: number;
  deferred: number;
} {
  const today = localDateISO();
  const max = Math.max(1, Math.min(40, opts.maxPerPass ?? 20));
  // Only reconcile suggestions whose target date is strictly in the past (so the
  // day's logging is settled) — never today's open suggestion. A nutrition check-in
  // additionally waits out its minimum post-intervention span before it is even
  // SELECTED, so the common case never occupies a pass's budget just to defer.
  const checkinEligibleThrough = addDaysISO(today, -POST_INTERVENTION_MIN_SPAN_DAYS) ?? today;
  const rows = (
    db
      .prepare(
        `SELECT * FROM suggestions
     WHERE reconciled_at IS NULL AND date IS NOT NULL AND date < ?
       AND (kind <> 'nutrition_checkin' OR date <= ?)
     ORDER BY id ASC LIMIT ?`
      )
      .all(today, checkinEligibleThrough, max) as any[]
  ).map(hydrateSuggestion);
  let learnings = 0;
  let deferred = 0;
  let reconciled = 0;
  for (const s of rows) {
    let outcome: any = null;
    let lesson: string | null = null;
    let retire: readonly string[] = [];
    let defer = false;
    try {
      const r = reconcileOneSuggestion(s, today);
      outcome = r.outcome;
      lesson = r.lesson;
      retire = r.retire ?? [];
      defer = !!r.defer;
    } catch {
      outcome = { error: true };
    }
    if (lesson) {
      // A learning is durable & curatable like any memory (it can be edited or
      // superseded by a later, contradicting learning).
      writeLearning(lesson, retire);
      learnings++;
    }
    const blob = outcome != null ? JSON.stringify(outcome).slice(0, 8000) : null;
    if (defer) {
      db.prepare(`UPDATE suggestions SET outcome_json = ? WHERE id = ?`).run(blob, s.id);
      deferred++;
      continue;
    }
    db.prepare(`UPDATE suggestions SET outcome_json = ?, reconciled_at = datetime('now') WHERE id = ?`).run(blob, s.id);
    reconciled++;
  }
  return { reconciled, learnings, deferred };
}

const OUTCOME_LESSONS = {
  restTrainedFlat:
    "Earned-rest reads matter for you: when you trained through one and felt flat, the coach should keep rest prominent next time.",
  restTrainedFine:
    "Rest-day reads can be conservative for you: training through one went fine, so the coach can tolerate slightly higher frequency before calling rest.",
  deficitTrendUp:
    "Deficit check-ins may be underestimating intake or expenditure when bodyweight trends up; lean toward the higher TDEE next time.",
  // The two minutes-drift readings. They are OPPOSITES, so each retires the other
  // (see writeLearning) — and they are worded far enough apart that addMemory's
  // 0.6-Jaccard near-dup fold cannot silently merge them, which would have left one
  // row whose text said "shorter" while the evidence said "longer".
  sessionsRunShort:
    "Sessions have been finishing well under the suggested time lately; the coach can size suggestions down.",
  sessionsRunLong: "Sessions keep running past the suggested time lately; the coach can budget more minutes up front.",
};

// ---- day_read: reading a rest call the athlete trained through ----
//
// n = 1 IS NOT A POLICY.
//
// These two lessons are the only ones here that tell the coach to change how it reads
// a WHOLE CLASS of mornings, and they used to be written off a single day: one rest
// read trained through, and "the coach can tolerate slightly higher frequency before
// calling rest" entered the store as a durable sentence, was promoted to a standing
// constraint by the nightly librarian, and was read into the coach prompt every
// morning after. A live audit found exactly that row, carrying a confidence its
// evidence never earned.
//
// So they need a PATTERN, the way the minutes drift below already does, and at the
// floor the reaction model holds every other learned pattern to (`learningForGroup`,
// src/repo/reaction-model.ts): at least two DISTINCT days saying the same thing. Below
// the floor nothing is written at all — no tentative row, no half-lesson — because the
// calm, common answer here is silence.
//
// The two readings are opposites, so whichever clears the floor retires the other: an
// athlete whose evidence has genuinely turned over should replace the old sentence,
// not accumulate a second one beside it.
const REST_OVERRIDE_MIN_OUTCOMES = 2;
// The same lookback and sample as the minutes drift: recent means recent, and a
// stretch the athlete has moved on from should stop speaking on its own.
const REST_OVERRIDE_LOOKBACK_DAYS = 45;
const REST_OVERRIDE_SAMPLE = 12;

type RestOverrideReading = "fine" | "flat";

// How ONE reconciled rest morning reads: the athlete trained through it, and their own
// session feedback says whether it cost them. An explicit low score (≤2) is the only
// thing that reads as "the rest call was right"; absent feedback is not evidence of
// harm. Anything that is not a trained-through rest read returns null and takes no part.
function restOverrideReading(outcome: unknown): RestOverrideReading | null {
  if (!outcome || typeof outcome !== "object") return null;
  const row = outcome as Record<string, any>;
  if (String(row.read_kind ?? "") !== "rest" || !row.trained) return null;
  const felt = row.feedback?.performance == null ? null : Number(row.feedback.performance);
  return felt != null && Number.isFinite(felt) && felt <= 2 ? "flat" : "fine";
}

// The durable lesson for a rest read just trained through, or null. `pendingDate` and
// `pending` describe the row being reconciled, whose outcome has not been stored yet
// and so must be counted here explicitly; prior days count once each, by date.
function restOverrideLesson(
  pendingDate: string,
  pending: RestOverrideReading,
  today: string
): { lesson: string; retire: readonly string[] } | null {
  const since = addDaysISO(today, -REST_OVERRIDE_LOOKBACK_DAYS) ?? today;
  const agreeing = new Set<string>([pendingDate]);
  try {
    const prior = db
      .prepare(
        `SELECT date, outcome_json FROM suggestions
          WHERE kind = 'day_read' AND reconciled_at IS NOT NULL
            AND outcome_json IS NOT NULL AND date IS NOT NULL AND date >= ? AND date <> ?
          ORDER BY date DESC, id DESC LIMIT ?`
      )
      .all(since, pendingDate, REST_OVERRIDE_SAMPLE) as any[];
    for (const row of prior) {
      let parsed: unknown = null;
      try {
        parsed = row.outcome_json ? JSON.parse(String(row.outcome_json)) : null;
      } catch {
        parsed = null;
      }
      if (restOverrideReading(parsed) === pending) agreeing.add(String(row.date));
    }
  } catch {
    return null;
  }
  if (agreeing.size < REST_OVERRIDE_MIN_OUTCOMES) return null;
  return pending === "flat"
    ? { lesson: OUTCOME_LESSONS.restTrainedFlat, retire: [OUTCOME_LESSONS.restTrainedFine] }
    : { lesson: OUTCOME_LESSONS.restTrainedFine, retire: [OUTCOME_LESSONS.restTrainedFlat] };
}

// ---- session_suggest: reading the minutes drift ----
// One session that overran is a busy Tuesday. The lesson needs a PATTERN, so it takes
// at least three reconciled outcomes drifting the SAME way; a window with drift in
// both directions says nothing and stays silent. The margin is deliberately coarse —
// ±30% of the suggested minutes — because est_minutes is itself an estimate and a
// 50-vs-55-minute day is agreement, not drift.
const MINUTES_DRIFT_MIN_OUTCOMES = 3;
const MINUTES_DRIFT_SHORT_RATIO = 0.7;
const MINUTES_DRIFT_LONG_RATIO = 1.3;
// Recent means recent: an eight-week-old tendency should not still be shaping today's
// suggestion, and the sample cap keeps the read on the current stretch.
const MINUTES_DRIFT_LOOKBACK_DAYS = 45;
const MINUTES_DRIFT_SAMPLE = 12;

interface MinutesOutcome {
  suggested_minutes?: unknown;
  actual_minutes?: unknown;
  trained?: unknown;
}

// A comparable day: the athlete actually trained AND both minute figures exist. A
// day they skipped is not a shorter session, and a session logged without a duration
// is presence without measurement — never evidence of a shortfall.
function minutesRatio(outcome: MinutesOutcome | null): number | null {
  if (!outcome || !outcome.trained) return null;
  const suggested = Number(outcome.suggested_minutes);
  const actual = Number(outcome.actual_minutes);
  if (!Number.isFinite(suggested) || suggested <= 0) return null;
  if (!Number.isFinite(actual) || actual <= 0) return null;
  return actual / suggested;
}

// The durable lesson (and the contradicting one it retires), or null — the calm,
// common answer. `pending` is the outcome just computed for the row being reconciled,
// which has not been stored yet, so it must be counted here explicitly.
function sessionMinutesDriftLesson(
  pending: MinutesOutcome,
  today: string
): { lesson: string; retire: readonly string[] } | null {
  const since = addDaysISO(today, -MINUTES_DRIFT_LOOKBACK_DAYS) ?? today;
  let prior: any[] = [];
  try {
    prior = db
      .prepare(
        `SELECT outcome_json FROM suggestions
          WHERE kind = 'session_suggest' AND reconciled_at IS NOT NULL
            AND outcome_json IS NOT NULL AND date IS NOT NULL AND date >= ?
          ORDER BY date DESC, id DESC LIMIT ?`
      )
      .all(since, MINUTES_DRIFT_SAMPLE) as any[];
  } catch {
    return null;
  }
  const ratios: number[] = [];
  const pendingRatio = minutesRatio(pending);
  if (pendingRatio != null) ratios.push(pendingRatio);
  for (const row of prior) {
    let parsed: MinutesOutcome | null = null;
    try {
      parsed = row.outcome_json ? JSON.parse(String(row.outcome_json)) : null;
    } catch {
      parsed = null;
    }
    const ratio = minutesRatio(parsed);
    if (ratio != null) ratios.push(ratio);
  }
  const short = ratios.filter((r) => r < MINUTES_DRIFT_SHORT_RATIO).length;
  const long = ratios.filter((r) => r > MINUTES_DRIFT_LONG_RATIO).length;
  if (short >= MINUTES_DRIFT_MIN_OUTCOMES && long === 0) {
    return { lesson: OUTCOME_LESSONS.sessionsRunShort, retire: [OUTCOME_LESSONS.sessionsRunLong] };
  }
  if (long >= MINUTES_DRIFT_MIN_OUTCOMES && short === 0) {
    return { lesson: OUTCOME_LESSONS.sessionsRunLong, retire: [OUTCOME_LESSONS.sessionsRunShort] };
  }
  return null;
}

// How long a nutrition check-in may wait for its own evidence before the ledger
// closes it out regardless. Four weeks is generous next to the 7-day minimum span,
// and it is what makes deferral terminate: a check-in made by someone who then
// stopped weighing in reconciles at the deadline with `evidence:"insufficient"` and
// no lesson, rather than sitting unreconciled forever.
const NUTRITION_CHECKIN_MAX_DEFER_DAYS = 28;

// Compare ONE suggestion to what actually happened. Returns the recorded outcome
// blob plus an optional one-line lesson (null = nothing worth remembering — the
// calm, common answer), the contradicting lessons that lesson retires, and whether
// the row should DEFER instead of closing. All comparisons are best-effort and
// null-safe.
function reconcileOneSuggestion(
  s: any,
  today = localDateISO()
): { outcome: any; lesson: string | null; retire?: readonly string[]; defer?: boolean } {
  const date = String(s.date);
  const p = s.payload || {};
  if (s.kind === "day_read") {
    const sess = getSessionByDate(date) as any;
    const summary = sess ? sessionSummary(sess.id) : null;
    const trained = !!(summary && summary.sets > 0);
    const fb = sess ? { soreness: sess.soreness, performance: sess.performance, joint_pain: sess.joint_pain } : null;
    const outcome = { read_kind: p.kind ?? null, trained, sets: summary?.sets ?? 0, feedback: fb };
    // The interesting cross-grain case: the Brief protected rest, the athlete
    // trained anyway, and it went fine → they tolerate higher frequency than the
    // read assumed. Suggestion-not-a-gate, learned not enforced.
    if (p.kind === "rest" && trained) {
      // performance feedback is optional 1-tap (1-5). Only an EXPLICIT low score
      // (≤2) flips this to "the rest read was right"; null/absent means we don't
      // know it went badly, so the default reading is the higher-frequency one.
      //
      // The reading of THIS day is not yet a lesson: restOverrideLesson spans it plus
      // the recent reconciled days, so the store only hears it once a run of mornings
      // points the same way (n = 1 is not a policy — see the floor above).
      const reading = restOverrideReading(outcome) ?? "fine";
      const override = restOverrideLesson(date, reading, today);
      return override ? { outcome, lesson: override.lesson, retire: override.retire } : { outcome, lesson: null };
    }
    if (p.kind === "train" && !trained) {
      return { outcome, lesson: null }; // a planned-but-skipped day is normal life, not a lesson
    }
    return { outcome, lesson: null };
  }
  if (s.kind === "session_suggest") {
    const sess = getSessionByDate(date) as any;
    const summary = sess ? sessionSummary(sess.id) : null;
    const suggestedMin = Number(p.est_minutes ?? p.minutes);
    const outcome = {
      suggested_minutes: Number.isFinite(suggestedMin) ? suggestedMin : null,
      trained: !!(summary && summary.sets > 0),
      sets: summary?.sets ?? 0,
      actual_minutes: sess?.duration_min ?? null,
    };
    // The drift read spans this outcome plus the recent reconciled ones, so it can
    // only speak once a run of days points the same way (see sessionMinutesDriftLesson).
    const drift = sessionMinutesDriftLesson(outcome, today);
    return drift ? { outcome, lesson: drift.lesson, retire: drift.retire } : { outcome, lesson: null };
  }
  if (s.kind === "nutrition_checkin") {
    // Did the bodyweight trend move the way the check-in expected? The ONLY evidence
    // that can answer that is what the scale did on or after the check-in date. The
    // trailing-window slope this used to read (getWeeklyStats' trend_lb_wk, ≤21 days
    // ending today) is almost entirely PRE-intervention at reconciliation time, so it
    // was scoring the check-in against the trend it was made to change.
    const trend = postInterventionWeightTrend(date, today);
    const expected = String(
      p.direction ?? (Number(p.target_kcal) && p.tdee && Number(p.target_kcal) < Number(p.tdee) ? "down" : "")
    );
    const outcome: Record<string, unknown> = {
      proposed_target_kcal: p.target_kcal ?? null,
      expected_direction: expected || null,
      post_intervention_trend_lb_wk: trend.lb_wk,
      post_intervention_weigh_ins: trend.weigh_ins,
      post_intervention_span_days: trend.span_days,
      evidence_window: trend.first_date && trend.last_date ? `${trend.first_date}..${trend.last_date}` : null,
    };
    if (!trend.sufficient) {
      // Not enough post-intervention weigh-ins yet. Wait — quietly — unless the
      // deadline has passed, in which case close the row honestly with no lesson.
      const deadlinePassed = date <= (addDaysISO(today, -NUTRITION_CHECKIN_MAX_DEFER_DAYS) ?? today);
      outcome.evidence = deadlinePassed ? "insufficient" : "pending";
      return { outcome, lesson: null, defer: !deadlinePassed };
    }
    outcome.evidence = "sufficient";
    if (expected === "down" && trend.lb_wk != null && trend.lb_wk > 0.2) {
      return { outcome, lesson: OUTCOME_LESSONS.deficitTrendUp };
    }
    return { outcome, lesson: null };
  }
  return { outcome: null, lesson: null };
}
