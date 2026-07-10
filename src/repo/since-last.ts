import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { recordedClientTimeZone } from "./client-tz.js";
import { latestJourneyMilestoneSince } from "./journey.js";
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
    const label =
      kind === "bloodwork"
        ? "Your latest bloodwork"
        : kind === "dexa"
          ? "Your DEXA scan"
          : kind === "ecg"
            ? "Your Garmin ECG"
            : "A new health document";
    const phrase =
      count > 1 ? `${label} and ${count - 1} more result${count - 1 === 1 ? "" : "s"} came in` : `${label} came in`;
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

// NOTE: there is deliberately NO insight/weekly-read source here. A visible
// insight always renders as its own card in the SAME Today agenda pass
// (weeklyCandidate / insightCandidate), so "a fresh weekly read is waiting"
// would announce a card sitting one slot below — robotic double-telling.
// The cards are their own announcement; continuity covers what has no card.

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

// ---- source: training actually done since the stamp ----
// The quiet backbone of continuity: before anything about labs or plans, the
// braid acknowledges the WORK. Counts distinct lifting days (a session with sets
// logged in the window) plus endurance activities — but ONLY days before today:
// today's session already speaks through the DONE hero (and Lately), and
// re-announcing it here would triple-tell the same workout. The braid is about
// time away. Words, never a streak.
const COUNT_WORDS = ["", "A", "Two", "Three", "Four", "Five", "Six"];

function trainingDoneChange(stampSql: string): Change | null {
  try {
    const today = localDateISO();
    const liftDays = Number(
      (
        db
          .prepare(
            `SELECT COUNT(DISTINCT s.date) AS n FROM sessions s
              WHERE s.date < ?
                AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id AND l.created_at > ?)`
          )
          .get(today, stampSql) as any
      )?.n ?? 0
    );
    const cardio = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM activities
              WHERE created_at > ? AND date < ? AND type IN ('run','ride','swim','hike')`
          )
          .get(stampSql, today) as any
      )?.n ?? 0
    );
    const total = liftDays + cardio;
    if (total <= 0) return null;
    const word = total > 6 ? "A stack of" : COUNT_WORDS[total];
    const phrase = total === 1 ? "A session went in the books" : `${word} sessions went in the books`;
    return { weight: 45, phrase };
  } catch {
    return null;
  }
}

// ---- source: a body-composition journey milestone since the stamp ----
function journeyMilestoneChange(stampSql: string): Change | null {
  try {
    const m = latestJourneyMilestoneSince(stampSql);
    if (!m) return null;
    return { weight: m.priority || 64, phrase: `You crossed ${m.label.toLowerCase()}` };
  } catch {
    return null;
  }
}

// ---- the kicker: name the real day when it reads naturally ----
// "SINCE TUESDAY" carries more continuity than a generic label — but only claim
// a day when it's unambiguous (yesterday, or a weekday within the last week).
// Same-day, long-gap, or any parse doubt falls back to the honest generic.
function sinceKicker(stampSql: string): string {
  const generic = "SINCE YOU LAST LOOKED";
  try {
    const ms = parseSqlTs(stampSql);
    if (ms == null) return generic;
    const tz = recordedClientTimeZone();
    const tzOpt = tz ? { timeZone: tz } : {};
    const stampDay = new Date(ms).toLocaleDateString("en-CA", tzOpt);
    const today = localDateISO();
    if (stampDay === today) return generic;
    const diffDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${stampDay}T00:00:00Z`)) / 86_400_000);
    if (diffDays === 1) return "SINCE YESTERDAY";
    if (diffDays >= 2 && diffDays <= 6) {
      const weekday = new Date(ms).toLocaleDateString("en-US", { weekday: "long", ...tzOpt });
      return weekday ? `SINCE ${weekday.toUpperCase()}` : generic;
    }
    return generic;
  } catch {
    return generic;
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
  for (const src of [
    newLabChange,
    resolvedDirectiveChange,
    journeyMilestoneChange,
    appliedPlanChange,
    recentPrChange,
    trainingDoneChange,
  ]) {
    const c = src(stampSql);
    if (c && c.phrase) changes.push(c);
  }
  if (!changes.length) return null;

  // Lead with the single most notable change; the rest BRAID into the body in
  // plain words — this line is the connective tissue between the horizons, so
  // it names what moved instead of hiding it behind a count.
  changes.sort((a, b) => b.weight - a.weight);
  const lead = changes[0];
  const named = changes.slice(1, 3);
  const unnamed = changes.length - 1 - named.length;
  const extra = changes.length - 1;

  // Priority scales modestly with the lead's notability + how much changed — a
  // resolved finding / new lab ranks higher than a routine PR. Kept in a calm
  // mid-band (continuity is never the loudest thing on the screen).
  const base = Math.round(lead.weight * 0.4); // ~20..36 for our weights
  const priority = Math.min(48, base + Math.min(extra, 3) * 3);

  const body = named.length
    ? `${named.map((c) => c.phrase).join(" · ")}${unnamed > 0 ? " · and more" : ""}`
    : undefined;

  return {
    id: "since-last",
    kind: "continuity",
    tier: "primary",
    priority,
    kicker: sinceKicker(stampSql),
    title: lead.phrase,
    ...(body ? { body } : {}),
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
