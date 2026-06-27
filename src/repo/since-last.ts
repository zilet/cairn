import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { localDateISO } from "./shared.js";
import type { TodayAgendaCandidate } from "./today-agenda.js";

// ============================================================================
// SINCE YOU LAST LOOKED — honest continuity, NOT a streak (VISION §6 Phase 6C).
//
// One calm plain-language line summarizing the single most notable thing that
// genuinely changed since the athlete last opened Today. NO counters, NO
// "you've been away N days", NO badge, NO score. Pull-never-push: it's a
// candidate the Today arbiter MAY surface, silent when nothing genuine changed.
// Kind, never anxious.
//
// Persistence is a single app_state stamp (no migration). Each change source is
// read in its own try/catch and is read-only — a failure in one never breaks the
// others or the candidate. We deliberately only count sources we can detect with
// a TRUSTWORTHY timestamp (a created_at / status_at column), so we never claim a
// change that didn't happen in the window.
// ============================================================================

// The Today salience arbiter (src/repo/today-agenda.ts) owns the shared
// TodayAgendaCandidate type — imported above so there's a single source of truth.

// The app_state key holding the last-seen timestamp (SQLite UTC format, so it
// compares directly against created_at / status_at columns).
export const TODAY_LAST_SEEN_KEY = "today_last_seen_at";

// Only advance the stamp if at least this long has passed since the last advance,
// so frequent same-session reloads don't wipe the window — a genuine "came back
// later" still has a real window to summarize.
const MARK_DEBOUNCE_MS = 60 * 60 * 1000; // ~1 hour

export function shouldMarkTodayAgendaSeen(requestedDate?: string | null, today = localDateISO()): boolean {
  return !requestedDate || requestedDate === today;
}

// SQLite's own timestamp format (UTC), matching `datetime('now')` columns:
// "YYYY-MM-DD HH:MM:SS". Stored + compared as a string so it lines up with
// created_at / status_at across all the source tables.
function sqlNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function parseSqlTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const norm = String(s).trim().slice(0, 19).replace(" ", "T");
  const t = Date.parse(norm + "Z");
  return Number.isFinite(t) ? t : null;
}

// Epley est-1RM (mirrors sessions.ts's private helper — a one-liner, re-derived
// here so we don't reach into a non-exported function).
function epley1RM(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

interface Change {
  // A higher weight = more notable. A resolved finding / a new lab outranks a
  // routine PR. Used to pick the lead line + scale the candidate's priority.
  weight: number;
  // The lead-line phrasing for this change (plain words, never a count/score).
  phrase: string;
}

// ---- source: a new lab / health document ingested since the stamp ----
function newLabChange(stampSql: string): Change | null {
  try {
    const row = db
      .prepare(
        `SELECT kind, doc_date, created_at FROM health_documents
          WHERE created_at > ?
          ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(stampSql) as any;
    if (!row) return null;
    const count = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM health_documents WHERE created_at > ?`).get(stampSql) as any)?.n ?? 0
    );
    const kind = String(row.kind ?? "").toLowerCase();
    const label = kind === "bloodwork" ? "Your latest bloodwork" : kind === "dexa" ? "Your DEXA scan" : "A new health document";
    const phrase = count > 1 ? `${label} and ${count - 1} more result${count - 1 === 1 ? "" : "s"} came in` : `${label} came in`;
    return { weight: 90, phrase };
  } catch {
    return null;
  }
}

// ---- source: a health directive (connected-brain finding) resolved since the stamp ----
function resolvedDirectiveChange(stampSql: string): Change | null {
  try {
    const row = db
      .prepare(
        `SELECT marker, domain, directive, status_at FROM health_directives
          WHERE status = 'resolved' AND status_at IS NOT NULL AND status_at > ?
          ORDER BY status_at DESC, id DESC LIMIT 1`
      )
      .get(stampSql) as any;
    if (!row) return null;
    const marker = String(row.marker ?? "").trim();
    const phrase = marker ? `You closed out a ${marker} finding` : "You closed out a health finding";
    return { weight: 85, phrase };
  } catch {
    return null;
  }
}

// ---- source: a new quiet insight / weekly read waiting since the stamp ----
function newInsightChange(stampSql: string): Change | null {
  try {
    const row = db
      .prepare(
        `SELECT kind, text, created_at FROM insights
          WHERE created_at > ? AND status IN ('new', 'seen')
          ORDER BY (kind = 'weekly_read') DESC, created_at DESC, id DESC LIMIT 1`
      )
      .get(stampSql) as any;
    if (!row) return null;
    const kind = String(row.kind ?? "").toLowerCase();
    const phrase = kind === "weekly_read" ? "A fresh weekly read is waiting" : "A new connection is waiting";
    // A weekly read is a bit more notable than a routine connection.
    return { weight: kind === "weekly_read" ? 70 : 55, phrase };
  } catch {
    return null;
  }
}

// ---- source: a strength PR set since the stamp ----
// PRs aren't stored as a flag — they're derived at log time. We recompute
// cheaply + conservatively: for any reps set logged after the stamp that beats
// the best est-1RM the athlete had BEFORE that set (a true all-time PR at the
// moment it was logged), surface it. Bounded to the few sets in the window, and
// the "best prior" query excludes the set itself, so a re-log can't false-PR.
function recentPrChange(stampSql: string): Change | null {
  try {
    const sets = db
      .prepare(
        `SELECT ls.id, ls.weight, ls.reps, ls.created_at, e.name AS exercise
           FROM logged_sets ls
           JOIN exercises e ON e.id = ls.exercise_id
          WHERE ls.created_at > ? AND ls.weight > 0 AND ls.reps > 0
          ORDER BY ls.created_at DESC, ls.id DESC
          LIMIT 50`
      )
      .all(stampSql) as any[];
    if (!sets.length) return null;
    for (const s of sets) {
      const est = epley1RM(Number(s.weight), Number(s.reps));
      if (!Number.isFinite(est) || est <= 0) continue;
      // Best est-1RM for this lift from any OTHER set logged at or before this one.
      const prior = db
        .prepare(
          `SELECT weight, reps FROM logged_sets
            WHERE exercise_id = (SELECT exercise_id FROM logged_sets WHERE id = ?)
              AND id != ? AND weight > 0 AND reps > 0
              AND created_at <= ?`
        )
        .all(s.id, s.id, s.created_at) as any[];
      const prevBest = prior.reduce((m, r) => Math.max(m, epley1RM(Number(r.weight), Number(r.reps))), 0);
      if (est > prevBest && prevBest > 0) {
        const ex = String(s.exercise ?? "").trim() || "a lift";
        return { weight: 50, phrase: `You set a new ${ex} best` };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---- source: a plan proposal applied since the stamp ----
// We can detect that a proposal exists in 'applied' state, but the table has NO
// applied_at column (only created_at) — so we can't tell WHEN it was applied. To
// stay honest we only count one whose DRAFT was created in the window (i.e. a
// proposal drafted-and-applied since you last looked); a long-standing draft you
// just applied is deliberately NOT surfaced here rather than risk a false claim.
function appliedPlanChange(stampSql: string): Change | null {
  try {
    const row = db
      .prepare(
        `SELECT id, created_at FROM plan_proposals
          WHERE status = 'applied' AND created_at > ?
          ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(stampSql) as any;
    if (!row) return null;
    return { weight: 60, phrase: "Your plan picked up an adjustment" };
  } catch {
    return null;
  }
}

// The candidate the Today arbiter calls. Returns null (silent) when there's no
// prior stamp (first-ever open) or nothing genuinely notable changed.
export function sinceLastLookedCandidate(_date?: string): TodayAgendaCandidate | null {
  let stampSql: string | null = null;
  try {
    stampSql = getAppState(TODAY_LAST_SEEN_KEY);
  } catch {
    stampSql = null;
  }
  // First-ever open (no prior stamp) → silent. Never summarize "the beginning of
  // time" — that would surface everything as "new".
  if (!stampSql || !parseSqlTs(stampSql)) return null;

  const changes: Change[] = [];
  for (const src of [newLabChange, resolvedDirectiveChange, appliedPlanChange, newInsightChange, recentPrChange]) {
    const c = src(stampSql);
    if (c && c.phrase) changes.push(c);
  }
  if (!changes.length) return null;

  // Lead with the single most notable change; the rest fold into plain words.
  changes.sort((a, b) => b.weight - a.weight);
  const lead = changes[0];
  const extra = changes.length - 1;

  // Priority scales modestly with the lead's notability + how much changed — a
  // resolved finding / new lab ranks higher than a routine PR. Kept in a calm
  // mid-band (continuity is never the loudest thing on the screen).
  const base = Math.round(lead.weight * 0.4); // ~20..36 for our weights
  const priority = Math.min(48, base + Math.min(extra, 3) * 3);

  const title =
    extra > 0
      ? `${lead.phrase} — and ${extra} other thing${extra === 1 ? "" : "s"} moved`
      : lead.phrase;

  return {
    id: "since-last",
    kind: "continuity",
    tier: "primary",
    priority,
    kicker: "SINCE YOU LAST LOOKED",
    title,
    dismissible: true,
  };
}

// Advance the last-seen stamp to now, DEBOUNCED so frequent same-session reloads
// don't keep wiping the window. The integrator calls this at the END of the
// GET /api/today-agenda handler (after the candidate is computed). Best-effort —
// never throws into the request path.
export function markTodaySeen(): void {
  try {
    const prev = parseSqlTs(getAppState(TODAY_LAST_SEEN_KEY));
    if (prev != null && Date.now() - prev < MARK_DEBOUNCE_MS) return; // within the window — leave it
    setAppState(TODAY_LAST_SEEN_KEY, sqlNow());
  } catch {
    /* best-effort */
  }
}
