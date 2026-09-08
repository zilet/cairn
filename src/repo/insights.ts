// Insights (quiet cross-domain intelligence — Phase 6) and the weekly read's
// freshness stamp, split out of coach.ts. Re-exported through src/repo.ts, so
// callers are unchanged.
import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { directiveKey, listActiveDirectives } from "./directives-read.js";
import { newestHealthDocDate } from "./health.js";
import { jaccard, memNorm } from "./memory.js";
import { capStr } from "./nutrition.js";
import { localDateISO, localDayOfStamp } from "./shared.js";

// ---------- insights (quiet cross-domain intelligence — Phase 6) ----------
export interface InsightInput {
  kind?: string | null;
  text?: string | null;
  rationale?: string | null;
  next_step?: string | null; // optional concrete, low-friction suggestion
  status?: string | null; // new | seen | dismissed
  feedback?: string | null; // up | down
  // The territorial identity of the connection — see src/repo/insight-intent.ts.
  // Callers pass a key they already resolved; NULL is the honest value when
  // derivation was ambiguous, and legacy rows keep deriving theirs at read time.
  intent_key?: string | null;
}

const INSIGHT_STATUSES = new Set(["new", "seen", "dismissed"]);
const INSIGHT_FEEDBACK = new Set(["up", "down"]);

// The card surfaces the headline plainly and tucks the reasoning behind a quiet
// "why" disclosure, so we keep each field short — the rationale is one or two
// sentences, not an evidence dump — and clamp on a WORD boundary (capStr) so a
// long value never gets sliced mid-word the way a raw .slice() would.
export function addInsight(fields: InsightInput = {}) {
  const status = INSIGHT_STATUSES.has(String(fields.status)) ? String(fields.status) : "new";
  const info = db
    .prepare(
      `INSERT INTO insights (kind, text, rationale, next_step, status, feedback, intent_key) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null,
      fields.text == null ? null : capStr(fields.text, 320) || null,
      fields.rationale == null ? null : capStr(fields.rationale, 360) || null,
      fields.next_step == null ? null : capStr(fields.next_step, 200) || null,
      status,
      INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null,
      fields.intent_key == null ? null : String(fields.intent_key).trim().slice(0, 120) || null
    );
  return getInsight(Number(info.lastInsertRowid));
}

export function getInsight(id: number) {
  return db.prepare(`SELECT * FROM insights WHERE id = ?`).get(id) ?? null;
}

export function updateInsight(id: number, fields: InsightInput) {
  const cur = getInsight(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.kind !== undefined) {
    sets.push("kind = ?");
    vals.push(fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null);
  }
  if (fields.text !== undefined) {
    sets.push("text = ?");
    vals.push(fields.text == null ? null : capStr(fields.text, 320) || null);
  }
  if (fields.rationale !== undefined) {
    sets.push("rationale = ?");
    vals.push(fields.rationale == null ? null : capStr(fields.rationale, 360) || null);
  }
  if (fields.next_step !== undefined) {
    sets.push("next_step = ?");
    vals.push(fields.next_step == null ? null : capStr(fields.next_step, 200) || null);
  }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    vals.push(INSIGHT_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status);
  }
  if (fields.feedback !== undefined) {
    sets.push("feedback = ?");
    vals.push(INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null);
  }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE insights SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getInsight(id);
}

// How long a CONNECTION insight stays in the live visible set. The Today card
// shows the latest non-weekly insight, and the producer is gated ~once/20h and
// often returns nothing new — so without a window a long-resolved connection
// ("sleep dropped when mileage ramped") keeps reading as today's connection for
// weeks. A conservative recency window ages a stale connection OUT of the visible
// set; it's a VISIBILITY filter only (the row is never deleted — it stays in the
// DB and exports, just hidden from the live card). The keystone weekly_read is
// EXEMPT: a weekly read legitimately persists for the week (the scheduler refreshes
// it on its own cadence), and the Today weekly card relies on it being visible.
export const INSIGHT_VISIBLE_WINDOW_DAYS = 14;

// The Brief surfaces ONE insight at a time, in-app, when opened — so the public
// read is the live set only: new + seen, most recent first (dismissed stays in
// the DB and exports but is hidden). Quiet by default. Connection insights older
// than INSIGHT_VISIBLE_WINDOW_DAYS age out so a stale read never lingers as
// "today's"; weekly_read is exempt (it persists for the week on its own cadence).
export function listVisibleInsights(limit = 20) {
  const cutoff = new Date(Date.now() - INSIGHT_VISIBLE_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT * FROM insights
        WHERE status IN ('new', 'seen')
          AND (kind = 'weekly_read' OR substr(created_at, 1, 10) >= ?)
        ORDER BY id DESC LIMIT ?`
    )
    .all(cutoff, limit) as any[];
  return annotateWeeklyReadFreshness(rows);
}

// ---------------------------------------------------------------------------
// Weekly-read staleness (pull, never push) — mirrors the health-synthesis
// drift_sig pattern (repo/health-focus.ts). The weekly read ("how the week
// went + the one change") legitimately persists for its slot, so mid-week it
// keeps asserting last slot's advice. We stamp a coarse freshness signature at
// generation, compare it live at serve, and — when the picture has moved —
// mark the read `stale` and DEFANG its "one change" so no surface asserts a
// stale action. The re-read affordance is a quiet tap (client), never a nag.
//
// Signature shape (each a meaningfully-sized change on its own, not daily churn):
//  - week_sessions: distinct training days this local week (a workout completed
//    since the read is material to a "how the week went" story).
//  - latest_doc_date: newest health-doc effective date (new labs landed).
//  - directive_keys: the active cross-domain directive identity set (a flagged
//    finding opened/closed/changed).
//  - weight_bucket: latest weigh-in rounded to a 2 lb bucket (a real move, not a
//    0.2 lb wiggle).
//  - latest_context_event_id: max non-archived context-event id (a NEW trip /
//    injury / life event since the read).
// A cached read with NO stored signature (legacy) or an id mismatch compares as
// "can't tell" → never stale. Never throws.
// ---------------------------------------------------------------------------
const WEEKLY_READ_FRESHNESS_KEY = "weekly_read_freshness";

export interface WeeklyReadSignature {
  week_sessions: number;
  latest_doc_date: string | null;
  directive_keys: string[];
  weight_bucket: number | null;
  latest_context_event_id: number | null;
}

function weeklyReadWeekStartISO(today = localDateISO()): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

export function computeWeeklyReadSignature(): WeeklyReadSignature {
  const today = localDateISO();
  let week_sessions = 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(DISTINCT date) AS c FROM sessions WHERE date >= ?`)
      .get(weeklyReadWeekStartISO(today)) as any;
    week_sessions = Number(row?.c ?? 0);
  } catch {
    week_sessions = 0;
  }
  let latest_doc_date: string | null = null;
  try {
    latest_doc_date = newestHealthDocDate();
  } catch {
    latest_doc_date = null;
  }
  let directive_keys: string[] = [];
  try {
    directive_keys = (listActiveDirectives() as any[])
      .map((d) => directiveKey(d))
      .filter(Boolean)
      .sort();
  } catch {
    directive_keys = [];
  }
  let weight_bucket: number | null = null;
  try {
    const w = db.prepare(`SELECT weight_lb FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`).get() as any;
    const lb = Number(w?.weight_lb);
    weight_bucket = Number.isFinite(lb) ? Math.round(lb / 2) * 2 : null; // 2 lb dead-band
  } catch {
    weight_bucket = null;
  }
  let latest_context_event_id: number | null = null;
  try {
    const c = db.prepare(`SELECT MAX(id) AS id FROM context_events WHERE archived = 0`).get() as any;
    latest_context_event_id = c?.id != null ? Number(c.id) : null;
  } catch {
    latest_context_event_id = null;
  }
  return { week_sessions, latest_doc_date, directive_keys, weight_bucket, latest_context_event_id };
}

// Stamp the freshness signature for the just-written weekly read. Keyed by the
// insight id so a serve-time comparison only trusts the signature that belongs
// to the read on screen. Called from generateInsight after the row is stored.
export function stampWeeklyReadFreshness(insightId: number): void {
  try {
    setAppState(
      WEEKLY_READ_FRESHNESS_KEY,
      JSON.stringify({ insight_id: Number(insightId), sig: computeWeeklyReadSignature() })
    );
  } catch {
    /* freshness stamping never blocks generation */
  }
}

function readWeeklyReadFreshness(): { insight_id: number; sig: any } | null {
  const raw = getAppState(WEEKLY_READ_FRESHNESS_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const id = Number(v?.insight_id);
    if (!Number.isFinite(id)) return null;
    return { insight_id: id, sig: v?.sig ?? null };
  } catch {
    return null;
  }
}

function weeklyKeysDiffer(a: unknown, b: unknown): boolean {
  const sa = Array.isArray(a) ? [...a].map(String).sort() : [];
  const sb = Array.isArray(b) ? [...b].map(String).sort() : [];
  return JSON.stringify(sa) !== JSON.stringify(sb);
}

// Conservative, threshold-biased comparison. Any single true trigger flags stale
// (each shape is already a meaningfully-sized change — see the doc comment above).
function weeklyReadSignatureDiffers(saved: any): boolean {
  if (!saved || typeof saved !== "object") return false; // legacy, no signature → can't tell
  const cur = computeWeeklyReadSignature();
  if (Number(saved.week_sessions) !== cur.week_sessions) return true;
  if (String(saved.latest_doc_date ?? "") !== String(cur.latest_doc_date ?? "")) return true;
  if (weeklyKeysDiffer(saved.directive_keys, cur.directive_keys)) return true;
  const sw = saved.weight_bucket;
  const cw = cur.weight_bucket;
  if ((sw == null) !== (cw == null)) return true;
  if (sw != null && cw != null && Number(sw) !== Number(cw)) return true;
  if (Number(saved.latest_context_event_id ?? 0) !== Number(cur.latest_context_event_id ?? 0)) return true;
  return false;
}

export interface WeeklyReadFreshness {
  stale: boolean;
  as_of: string | null;
}

// The freshness verdict for a weekly_read insight row. Legacy / mismatched rows
// read as fresh (can't tell → never stale), matching the synthesis contract.
export function weeklyReadFreshness(weekly: any): WeeklyReadFreshness {
  // created_at is a UTC instant; this date is shown to the athlete as the day the
  // read was written, so it is framed in their zone rather than sliced.
  const as_of = weekly?.created_at ? localDayOfStamp(weekly.created_at) : null;
  if (!weekly || weekly.kind !== "weekly_read") return { stale: false, as_of };
  const stored = readWeeklyReadFreshness();
  if (!stored || stored.insight_id !== Number(weekly.id)) return { stale: false, as_of };
  return { stale: weeklyReadSignatureDiffers(stored.sig), as_of };
}

// Annotate the most-recent weekly_read row (the one the Today card shows) with a
// freshness verdict, and — when stale — DEFANG it: null the "one change"
// (next_step) and attach a calm stale_note so no surface asserts a moved-on
// action. Additive + copy-on-write (the DB row is never mutated); rows without a
// weekly read, or a fresh one, pass through untouched.
function annotateWeeklyReadFreshness(rows: any[]): any[] {
  const idx = Array.isArray(rows) ? rows.findIndex((r) => r && r.kind === "weekly_read") : -1;
  if (idx < 0) return rows;
  const { stale } = weeklyReadFreshness(rows[idx]);
  if (!stale) return rows;
  const copy = [...rows];
  copy[idx] = {
    ...rows[idx],
    stale: true,
    stale_note:
      "This was the week's read when it was written — your training, labs, or weight have moved since. Re-read it when you like.",
    next_step: null,
  };
  return copy;
}

// How many downvoted insight texts stay in the dedup corpus, beyond the recency
// window. A thumbs-down means "don't say this again" — so the theme has to keep
// suppressing new near-repeats even after it ages past `limit`. Bounded so the
// corpus can never grow without limit.
export const DOWNVOTED_DEDUP_LIMIT = 30;

// A compact, bounded list of recent insight TEXTS (any status) so the generator
// can tell the agent what it already said and avoid repeating a connection.
// Dedup is a soft prompt hint here; isDuplicateInsight() is the real guard.
// Downvoted insight texts are UNIONED in (beyond the recency window) so a
// connection the athlete waved off doesn't resurface once it scrolls past `limit`
// — a downvoted THEME stays suppressed, keeping the existing soft+real dedup shape.
export function recentInsightTexts(limit = 12): string[] {
  const recent = db
    .prepare(`SELECT text FROM insights ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((r: any) => String(r?.text ?? "").trim())
    .filter(Boolean);
  const downvoted = db
    .prepare(`SELECT text FROM insights WHERE feedback = 'down' ORDER BY id DESC LIMIT ?`)
    .all(DOWNVOTED_DEDUP_LIMIT)
    .map((r: any) => String(r?.text ?? "").trim())
    .filter(Boolean);
  // Recent first (newest-first order preserved), then any downvoted not already present.
  const seen = new Set(recent);
  const out = [...recent];
  for (const t of downvoted) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// The other half of the same one-tap. A thumbs-DOWN already steers the generator —
// it suppresses the theme through the dedup corpus above — while a thumbs-UP did
// nothing at all, so the only feedback the athlete could give that changed anything
// was negative. These are the connections they said were worth having: a small,
// bounded "more like this" the generator can aim at. Never a template to copy (the
// dedup guard still refuses a near-repeat of any of them) — a direction only.
export const UPVOTED_STEER_LIMIT = 6;

export function upvotedInsightTexts(limit = UPVOTED_STEER_LIMIT): string[] {
  return db
    .prepare(`SELECT text FROM insights WHERE feedback = 'up' ORDER BY id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(UPVOTED_STEER_LIMIT, limit)))
    .map((r: any) => String(r?.text ?? "").trim())
    .filter(Boolean);
}

// True when a candidate insight essentially repeats one of the recent ones:
// exact-after-normalize, or a high word-overlap (Jaccard) match. Keeps the
// quiet stream from echoing the same connection twice. Normalizes with the same
// forgiving rule as memory dedup (memNorm) so "the same connection reworded"
// collapses; unlike memory it keeps stopwords (short insight texts need them).
export function isDuplicateInsight(candidate: string, recent: string[] = recentInsightTexts()): boolean {
  const cand = memNorm(candidate);
  if (!cand) return true; // nothing to say is a no-op, never a fresh insight
  const candSet = new Set(cand.split(" "));
  for (const r of recent) {
    const rn = memNorm(r);
    if (!rn) continue;
    if (rn === cand) return true;
    if (jaccard(candSet, new Set(rn.split(" "))) >= 0.7) return true;
  }
  return false;
}
