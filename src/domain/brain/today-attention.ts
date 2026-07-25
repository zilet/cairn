// ============================================================================
// The Today LEAD arbitration — which ONE surface earns the position of
// prominence today, plus a coarse ordering for the rest.
// ----------------------------------------------------------------------------
// Cairn already arbitrates the Today RAIL (`repo/today-agenda.ts`): one
// deterministic ranking + surprise budget over the side cards. What nothing has
// ever arbitrated is the MAIN column's lead, because `briefHero()` hardcodes the
// Brief as the hero. So on a day whose read is literally yesterday's conclusion
// reached by yesterday's rule — the day-read layer now says so out loud via
// `signals.continuity` — the Brief still holds the loudest slot on the screen
// while the genuinely new thing (a session just finished and waiting on its
// one-tap read, a connection surfaced for the first time) sits quietly beside it.
//
// This module decides only WHICH surface leads. It never hides a card, never
// invents one, never removes a way in, and never pushes: every surface the
// athlete could reach before is still reachable, in the same places.
//
// That last property is why this is NOT folded into `repo/today-agenda.ts`
// despite both being deterministic rankings on the Today screen. The agenda
// budgets the RAIL and exists to REDUCE (cards collapse behind "more"); this
// arbitrates the MAIN column's lead and only ever reorders emphasis. Different
// surface, different candidate set, opposite contract about what may disappear.
// Keep them separate.
//
// Constitution (docs/VISION.md): calm by default, suggestion-not-a-gate, pull
// never push, and NO scores anywhere. The `rank` numbers below are the exact
// `impact_score` precedent from `prioritizeMarkers` — they ORDER, and they are
// never serialized. The client receives semantic labels only.
//
// Pure of side effects, deterministic for a given DB state, and null-safe: every
// probe is isolated, and any failure degrades that one surface (or the whole
// decision) to absence — which the client renders exactly as it does today.
// ============================================================================

import { db } from "../../db.js";
import { listVisibleInsights } from "../../repo/coach.js";
import { localDateISO } from "../../repo/shared.js";

export type TodayAttentionSurface = "brief" | "feedback" | "insight" | "weekly" | "fuel";

// Emphasis bands, not positions in a list: `lead` is the position of prominence,
// `supporting` sits beside it, `quiet` is present and reachable but recedes.
export type TodayAttentionTier = "lead" | "supporting" | "quiet";

// Whether the Brief is saying something new today. `repeat_of_yesterday` = same
// conclusion by the same route as yesterday; `settled_quiet` = a run of quiet days
// that has stopped being news. Both mean the Brief can yield the lead.
export type TodayAttentionBriefState = "new_read" | "repeat_of_yesterday" | "settled_quiet";

export interface TodayAttentionItem {
  surface: TodayAttentionSurface;
  tier: TodayAttentionTier;
}

export interface TodayAttention {
  primary: TodayAttentionSurface;
  brief_state: TodayAttentionBriefState;
  // Most-deserving first; `items[0].surface` is always `primary`.
  items: TodayAttentionItem[];
}

// ---- the internal ranking (NEVER serialized — see the header) ---------------
// The bands, in plain language:
//   BRIEF_NEWS      the Brief has something new to say → nothing outranks it.
//   FEEDBACK        a finished session waiting on its one-tap read. Bound to a
//                   moment that passes: asked today about work done today.
//   INSIGHT_NEW     a cross-domain connection surfaced for the first time.
//   WEEKLY_NEW      a fresh, unacknowledged weekly read.
//   BRIEF_SETTLED   the Brief repeating itself — it yields to genuine news only.
//   INSIGHT_SEEN /  already-seen reads and an actionable fuel state: real, but
//   WEEKLY_SEEN /   never NEWS, so they never take the lead from the Brief.
//   FUEL
const RANK = {
  BRIEF_NEWS: 100,
  FEEDBACK: 80,
  INSIGHT_NEW: 70,
  WEEKLY_NEW: 60,
  BRIEF_SETTLED: 50,
  INSIGHT_SEEN: 45,
  WEEKLY_SEEN: 44,
  FUEL: 40,
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// One isolated probe: a failing source omits its own surface, never the decision.
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Is a session logged today still waiting on its 1-tap autoregulation read?
// Mirrors the client's own gate exactly (`hasLoggedSets` in today-session-
// controller.ts + `hasFeedback` in today-session-status-client.ts) so the server
// never names a lead the client cannot render. A narrow query on purpose:
// `getSessionByDate` hydrates sets, skips and the daily composition, and this
// runs on every Brief serve.
function feedbackAwaiting(date: string): boolean {
  const row = db
    .prepare(
      `SELECT s.soreness AS soreness, s.performance AS performance, s.joint_pain AS joint_pain,
              (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id) AS set_count
         FROM sessions s WHERE s.date = ? ORDER BY s.id LIMIT 1`
    )
    .get(date) as { soreness: unknown; performance: unknown; joint_pain: unknown; set_count: unknown } | undefined;
  if (!row) return false;
  if (!(Number(row.set_count) > 0)) return false;
  const given =
    row.soreness != null || row.performance != null || (row.joint_pain != null && String(row.joint_pain).trim() !== "");
  return !given;
}

type ReadState = "none" | "new" | "seen";

// The live insight surfaces, read from the SAME source the Today cards render
// from (`listVisibleInsights`, mirroring `loadTodayReads`), so the arbitration
// and the cards can never disagree about what exists.
function insightStates(): { insight: ReadState; weekly: ReadState } {
  const rows = listVisibleInsights() as Array<Record<string, unknown>>;
  const list = Array.isArray(rows) ? rows : [];
  const connection = list.find((row) => row && row.kind !== "weekly_read");
  const weekly = list.find((row) => row && row.kind === "weekly_read");
  return {
    insight: !connection ? "none" : connection.status === "new" ? "new" : "seen",
    // A STALE weekly read has had its "one change" defanged upstream (the
    // freshness guard in repo/coach.ts), so it is no longer news to lead with.
    weekly: !weekly ? "none" : weekly.status === "new" && weekly.stale !== true ? "new" : "seen",
  };
}

// Does the Brief still have something new to say today? Deliberately narrow: it
// yields ONLY on a quiet (rest/easy) day with nothing logged, whose own prose
// already admits it is repeating itself. A train day leads (there is a session to
// do), a done day leads (the debrief is today's news), a steered read leads (the
// athlete just asked it something), and a legacy cached row with no continuity
// block leads — absence degrades to today's behavior, never to a demotion.
export function briefState(read: Record<string, unknown>): TodayAttentionBriefState {
  if (read.override) return "new_read";
  const kind = String(read.kind ?? "");
  if (kind !== "rest" && kind !== "easy") return "new_read";

  const signals = record(read.signals);
  const loggedToday = record(signals.logged_today);
  const activities = loggedToday.activities;
  const moved =
    signals.trained_today === true ||
    Number(loggedToday.sets ?? 0) > 0 ||
    (Array.isArray(activities) && activities.length > 0);
  if (moved) return "new_read";

  const continuity = signals.continuity;
  if (!continuity || typeof continuity !== "object") return "new_read";
  const c = continuity as Record<string, unknown>;
  if (c.repeat_of_yesterday === true) return "repeat_of_yesterday";
  if (Number(c.quiet_streak ?? 0) >= 2) return "settled_quiet";
  return "new_read";
}

export interface DecideTodayAttentionOptions {
  // Injectable for deterministic tests; defaults to the active local day.
  today?: string;
}

/**
 * Decide which Today surface earns the lead. Returns `null` for anything but the
 * live local day (a routed past date renders archival state and arbitrates
 * nothing) and for any failure — both of which the client treats as "render
 * exactly as before".
 */
export function decideTodayAttention(
  date: string,
  read: Record<string, unknown> | null | undefined,
  options: DecideTodayAttentionOptions = {}
): TodayAttention | null {
  try {
    if (!read || typeof read !== "object") return null;
    const today = options.today ?? localDateISO();
    if (!date || date !== today) return null;

    const state = safe(() => briefState(read), "new_read" as TodayAttentionBriefState);
    const reads = safe(() => insightStates(), { insight: "none" as ReadState, weekly: "none" as ReadState });
    const awaiting = safe(() => feedbackAwaiting(date), false);
    // Fuel rides on the read the Brief already computed — no extra query, and the
    // two can never disagree. Only "behind" is asking for anything right now.
    const fuelBehind = record(record(read.signals).fuel).bucket === "behind";

    // The Brief is ALWAYS a candidate, so `items` is never empty and the lead can
    // never fall through to nothing.
    const candidates: Array<{ surface: TodayAttentionSurface; rank: number }> = [
      { surface: "brief", rank: state === "new_read" ? RANK.BRIEF_NEWS : RANK.BRIEF_SETTLED },
    ];
    if (awaiting) candidates.push({ surface: "feedback", rank: RANK.FEEDBACK });
    if (reads.insight !== "none") {
      candidates.push({ surface: "insight", rank: reads.insight === "new" ? RANK.INSIGHT_NEW : RANK.INSIGHT_SEEN });
    }
    if (reads.weekly !== "none") {
      candidates.push({ surface: "weekly", rank: reads.weekly === "new" ? RANK.WEEKLY_NEW : RANK.WEEKLY_SEEN });
    }
    if (fuelBehind) candidates.push({ surface: "fuel", rank: RANK.FUEL });

    // Stable sort by rank desc, tie-broken on declaration order so the decision is
    // byte-identical for identical state (Array#sort is stable in modern V8, but
    // say it explicitly — this is a contract the tests hold us to).
    const items = candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => b.candidate.rank - a.candidate.rank || a.index - b.index)
      .map(
        ({ candidate }, position): TodayAttentionItem => ({
          surface: candidate.surface,
          tier: position === 0 ? "lead" : position === 1 ? "supporting" : "quiet",
        })
      );

    return { primary: items[0].surface, brief_state: state, items };
  } catch {
    return null;
  }
}
