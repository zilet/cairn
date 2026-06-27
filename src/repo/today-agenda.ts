// ============================================================================
// The Today salience arbiter (Era 2, §12 item 1).
// ----------------------------------------------------------------------------
// Today's cards each independently decide whether to render, so a busy day can
// stack into a dashboard — exactly the calm-by-default (§2.2) / restraint-over-
// features (§2.4) pressure Era 2 is written to relieve. This is ONE deterministic
// ranking + budget pass over the WHOLE Today surface: the same prioritize-don't-
// dump discipline `prioritizeMarkers` / `healthFocus` already apply to markers,
// now applied to every candidate card. It can ONLY ever REDUCE what's shown —
// it never invents a card to fill space, and on a quiet day Today is still just
// the Brief (+ maybe one quiet line).
//
// Each existing Today card has a producer here that reads the SAME repo data the
// client uses to decide whether that card shows, and assigns a deterministic
// `priority` (0..100) reflecting genuine importance TODAY. Empty data → the
// candidate is omitted (priority <= 0). The Brief is ALWAYS the hero. The top
// TODAY_PRIMARY_MAX non-hero candidates render inline; the rest collapse behind
// one quiet "more". No scores cross to the user — `priority` is internal, exactly
// like marker `impact_score`; the client renders placement, never the number.
//
// Pure, deterministic, null-safe. Every producer read is wrapped in its own
// try/catch so one failing source never breaks the agenda — graceful: no data →
// just the hero.
// ============================================================================

// Import each producer read DIRECTLY from its sibling module (never from the
// barrel ../repo.js) — repo modules do this to avoid a circular import, since the
// barrel re-exports this very file.
import { getDayIntake } from "./nutrition.js";
import { localDateISO } from "./shared.js";
import { listVisibleInsights, listActiveDirectives } from "./coach.js";
import { programAdjustments } from "./progression.js";
import { getRunCompliance, getWeeklyStats } from "./sessions.js";
import { listUnreconciledGarminStrength } from "./activities.js";
import { healthFocus } from "./propagation.js";
// The health-standing momentum read — the SAME wins-in-motion the top-level Me→Standing
// view shows, surfaced here as a quiet pull-only "you're trending the right way" card.
import { standingMomentum } from "./standing.js";
// The waiting-draft proposals card reads the same proposals the client's
// loadDraftProposals does — used for the 'plan' candidate.
import { listProposals } from "./profile.js";
// The two NEW Era-2 candidate producers, built by sibling agents. They land at
// integration time; import them now (do not stub). Each returns a fully-formed
// TodayAgendaCandidate or null.
import { sinceLastLookedCandidate } from "./since-last.js";
import { goalCheckinCandidate } from "./goal-checkin.js";

// ---- The shared Today-agenda contract (also consumed by sibling Era-2 cards) ----
export type TodayAgendaTier = "hero" | "primary" | "more";
export type TodayAgendaCandidate = {
  id: string; // stable, e.g. 'fuel' | 'since-last' | 'goal-checkin' | 'insight'
  kind: string; // styling category: 'training'|'fuel'|'health'|'continuity'|'goal'|'insight'|'weekly'|'reconcile'|'plan'
  tier: TodayAgendaTier; // producer's suggested tier; the arbiter may DEMOTE, never promote
  priority: number; // 0..100 deterministic importance for THIS day; <= 0 is NOT surfaced
  kicker?: string; // short label e.g. 'SINCE YOU LAST LOOKED'
  title?: string; // one calm plain-language line (NO scores)
  body?: string; // optional secondary line
  action?: { label: string; kind: string; payload?: any };
  client_card?: string; // names an EXISTING client-rendered card id to render in place of generic text
  dismissible?: boolean;
};

export type TodayAgenda = {
  hero: TodayAgendaCandidate;
  primary: TodayAgendaCandidate[];
  more: TodayAgendaCandidate[];
  total: number; // count of all surfaced non-hero candidates
};

// The attention budget: at most this many candidates render inline as `primary`;
// everything else with a positive priority collapses behind the quiet "more".
export const TODAY_PRIMARY_MAX = 2;

// Run a producer that may throw / return null without ever breaking the agenda.
function safe(fn: () => TodayAgendaCandidate | null): TodayAgendaCandidate | null {
  try {
    const c = fn();
    return c && Number(c.priority) > 0 ? c : null;
  } catch {
    return null;
  }
}

// ---- The Brief: ALWAYS the hero (the day's judgment leads, §5). It is rendered
// client-side by the existing brief flow; the arbiter just reserves the slot. ----
function briefHero(): TodayAgendaCandidate {
  return {
    id: "brief",
    kind: "training",
    tier: "hero",
    priority: 100,
    client_card: "brief",
  };
}

// ---- fuel: the day's logged food, as an EVALUATION glance — NEVER a "log
// something" prompt. Surfaces ONLY when there's logged fuel to evaluate; an empty
// day is not a candidate (priority <= 0), so Today never nudges capture. A day
// that's logged AND drifting over its target ranks a touch higher (worth a look);
// a steady logged day is low. Reads getDayIntake exactly like loadFuelToday. ----
function fuelCandidate(date: string): TodayAgendaCandidate | null {
  const d: any = getDayIntake(date);
  const count = Number(d?.count) || 0;
  if (count <= 0) return null; // nothing logged → not a "log something" prompt; omit
  // Logged → a calm review glance. A real target that's been overshot is slightly
  // more worth a look (still never red / never a score), so nudge it up.
  let priority = 32;
  if (d?.remaining && d?.target && Number(d.remaining.kcal) < 0) priority = 40;
  return {
    id: "fuel",
    kind: "fuel",
    tier: "primary",
    priority,
    client_card: "fuel",
  };
}

// ---- reconcile: Garmin synced a strength activity that isn't linked to a Cairn
// session yet. High — the watch has data the user genuinely needs reconciled, and
// the action is one tap. Reads listUnreconciledGarminStrength like the client. ----
function reconcileCandidate(): TodayAgendaCandidate | null {
  const rows = listUnreconciledGarminStrength();
  const n = Array.isArray(rows) ? rows.length : 0;
  if (n <= 0) return null;
  return {
    id: "garmin-reconcile",
    kind: "reconcile",
    tier: "primary",
    priority: 86,
    client_card: "garmin-reconcile",
  };
}

// ---- plan: a draft plan change waiting for review (a scheduler weekly draft, a
// chat plan change, an applied progression). High — the user asked for or is owed
// a decision (you-drive: nothing auto-applies). Reads draft proposals. ----
function planDraftCandidate(): TodayAgendaCandidate | null {
  const plans = listProposals(8) as any[];
  const drafts = (Array.isArray(plans) ? plans : []).filter((p) => p && p.status === "draft");
  if (!drafts.length) return null;
  const raw = String(drafts[0]?.instruction || "").replace(/^(auto|chat):\s*/i, "").trim();
  return {
    id: "draft-proposals",
    kind: "plan",
    tier: "primary",
    priority: 78,
    kicker: "PLAN DRAFT",
    title: drafts.length > 1 ? `${drafts.length} plan changes are waiting` : "A plan change is waiting",
    body: raw || "Review the coach's draft before anything changes.",
    action: { label: "Review", kind: "plan-coach" },
  };
}

// ---- health: a cross-domain directive needing attention. An act_now health focus
// priority (a flagged lab / compounding concern) ranks high; a quieter "track"-only
// picture ranks moderate. The health line on Today (#ctxHealth) shows the review's
// lead focus; this candidate gates that surface on whether the connected brain has
// something genuinely pressing. Reads healthFocus + listActiveDirectives. ----
function healthCandidate(): TodayAgendaCandidate | null {
  const directives = listActiveDirectives() as any[];
  if (!Array.isArray(directives) || !directives.length) return null; // nothing flagged → silent
  const focus = healthFocus();
  const actNow = Number(focus?.act_now) || 0;
  const track = Number(focus?.track) || 0;
  // No off-optimal priorities at all → the active directives are quiet/maintenance;
  // don't claim a Today slot for them.
  if (actNow <= 0 && track <= 0) return null;
  return {
    id: "health-focus",
    kind: "health",
    tier: actNow > 0 ? "primary" : "more",
    priority: actNow > 0 ? 80 : 46,
    kicker: "HEALTH READ",
    title: actNow > 0 ? "A health lever is worth reading today" : "Your connected health read has an update",
    body: "Open the full read when you want the context behind today's coaching.",
    action: { label: "Open read", kind: "me-health-read" },
  };
}

// ---- standing momentum: a genuine win in motion (fat off since a DEXA, blood
// pressure trending down, a steady weight slope) — the SAME momentum the
// top-level Me→Standing read shows. Pull, never push: it rides in "more" most days
// (moderate priority), the arbiter may surface it on a quiet day, and it OMITS
// itself when there's no real win (`has_momentum` false). No scores — just the
// trajectory in plain words. Reads standingMomentum (deterministic, null-safe). ----
function standingMomentumCandidate(_date: string): TodayAgendaCandidate | null {
  let m: any = null;
  try { m = standingMomentum(); } catch { m = null; }
  if (!m || !m.has_momentum || !m.summary) return null;
  return {
    id: "standing-momentum",
    kind: "health",
    tier: "more",
    priority: 22,
    kicker: "YOUR TRAJECTORY",
    title: m.summary,
    body: "You're trending the right way — open your health standing for the full read.",
    action: { label: "See your standing", kind: "me-health-standing" },
    dismissible: true,
  };
}

// ---- program-adjustments: the handful of plan adaptations the engine noticed (a
// lift to push / deload, a group that's due, a missing pattern). Moderate, scaled
// by how actionable the set is: a deload (back off, recover) or a missing-pattern
// gap is more pressing than a steady earned overload. Reads programAdjustments. ----
function adjustmentsCandidate(): TodayAgendaCandidate | null {
  // Adjustments adapt an ACTIVE plan — on a blank slate (no plan yet) there's
  // nothing to evolve, and the volume landmarks would read every group as a "gap",
  // which would nag a brand-new user about "missing" work. Gate on having a plan
  // (mirrors weekAheadCandidate) — calm by default; no plan → silent.
  const stats: any = getWeeklyStats();
  if ((Number(stats?.week_planned) || 0) <= 0) return null;
  const rows = programAdjustments();
  if (!Array.isArray(rows) || !rows.length) return null;
  // A deload or a true gap (not a recovering / already-programmed group) lifts the
  // urgency a little above a routine progression digest.
  const pressing = rows.some(
    (a) => a && (a.kind === "deload" || (a.kind === "gap" && !a.recovering)),
  );
  return {
    id: "program-adjustments",
    kind: "plan",
    tier: "primary",
    priority: pressing ? 58 : 50,
    client_card: "program-adjustments",
  };
}

// ---- weekly read: "how the week went + the one change", waiting in-app (pull,
// never push). Moderate — a genuine end-of-week reflection is worth surfacing when
// one is waiting, but it never outranks something needing action today. Reads the
// latest kind:'weekly_read' insight from listVisibleInsights. ----
function weeklyCandidate(): TodayAgendaCandidate | null {
  const list = listVisibleInsights() as any[];
  const weekly = (Array.isArray(list) ? list : []).find((i) => i && i.kind === "weekly_read");
  if (!weekly) return null;
  // A fresh, unseen weekly read is slightly more worth surfacing than one already seen.
  const fresh = weekly.status === "new";
  return {
    id: "weekly-read",
    kind: "weekly",
    tier: "primary",
    priority: fresh ? 54 : 48,
    client_card: "weekly-read",
  };
}

// ---- connection insight: the one quiet cross-domain connection (pull, never push),
// one at a time. Lower-moderate — genuinely interesting, never urgent. Reads the
// latest NON-weekly insight from listVisibleInsights (mirrors loadTodayReads). ----
function insightCandidate(): TodayAgendaCandidate | null {
  const list = listVisibleInsights() as any[];
  const conn = (Array.isArray(list) ? list : []).find((i) => i && i.kind !== "weekly_read");
  if (!conn) return null;
  const fresh = conn.status === "new";
  return {
    id: "connection-insight",
    kind: "insight",
    tier: "primary",
    priority: fresh ? 44 : 38,
    client_card: "connection-insight",
  };
}

// ---- week-ahead: a calm sketch of lift / run / mixed / rest across the next few
// days. A forward look, never urgent — low priority so it sinks below anything
// about today. There's no cheap repo read for the agentic week-ahead, so we gate it
// on having a plan to sketch from (getWeeklyStats carries week_planned). ----
function weekAheadCandidate(): TodayAgendaCandidate | null {
  const stats: any = getWeeklyStats();
  const planned = Number(stats?.week_planned) || 0;
  if (planned <= 0) return null; // no plan → nothing to sketch a week from
  return {
    id: "week-ahead",
    kind: "plan",
    tier: "more",
    priority: 40,
    client_card: "week-ahead",
  };
}

// ---- run-compliance / endurance: this week's prescribed-vs-actual running, when a
// run is actually programmed. Low — a quiet trajectory read, not a today decision.
// Reads getRunCompliance (mirrors the Endurance compliance line). ----
function runComplianceCandidate(): TodayAgendaCandidate | null {
  const rc: any = getRunCompliance();
  const prescribed = Number(rc?.prescribed_sessions) || 0;
  if (prescribed <= 0) return null; // no runs prescribed → nothing to comply with
  return {
    id: "run-compliance",
    kind: "training",
    tier: "more",
    priority: 36,
    kicker: "RUNNING",
    title: rc?.in_words ? String(rc.in_words) : "This week's runs have a plan to compare against",
    body: "Check the endurance view for the week shape and any synced-watch context.",
    action: { label: "Open endurance", kind: "plan-endurance" },
  };
}

// ---- lately: the steady feed of what you actually did (finished sessions + cardio).
// The lowest steady surface — always-there context, never something that needs
// attention. It exists whenever there's recent training; gate it on the week having
// any logged activity so a brand-new install's Today stays empty. ----
function latelyCandidate(): TodayAgendaCandidate | null {
  const stats: any = getWeeklyStats();
  const did = (Number(stats?.week_done) || 0) + (Number(stats?.week_cardio) || 0);
  if (did <= 0) return null;
  return {
    id: "lately",
    kind: "continuity",
    tier: "more",
    priority: 15,
    client_card: "lately",
  };
}

// ============================================================================
// todayAgenda — the single ranking + budget pass.
// ============================================================================
export function todayAgenda(date?: string): TodayAgenda {
  const d = String(date || localDateISO());
  const hero = briefHero();

  // Build every candidate, each isolated so one failing source never breaks the
  // agenda. Producers that read by date take `d`; the rest are date-agnostic.
  const candidates: TodayAgendaCandidate[] = [];
  const add = (c: TodayAgendaCandidate | null) => { if (c) candidates.push(c); };

  add(safe(() => fuelCandidate(d)));
  add(safe(() => reconcileCandidate()));
  add(safe(() => planDraftCandidate()));
  add(safe(() => healthCandidate()));
  add(safe(() => adjustmentsCandidate()));
  add(safe(() => weeklyCandidate()));
  add(safe(() => insightCandidate()));
  add(safe(() => weekAheadCandidate()));
  add(safe(() => runComplianceCandidate()));
  add(safe(() => latelyCandidate()));

  // The two NEW Era-2 candidate producers (sibling-built). They return a finished
  // candidate or null; still wrapped in safe() so a throw never breaks the agenda
  // and a priority<=0 producer self-omits.
  add(safe(() => sinceLastLookedCandidate(d)));
  add(safe(() => goalCheckinCandidate()));
  add(safe(() => standingMomentumCandidate(d)));

  // Stable sort by priority desc. Array.prototype.sort is stable in modern V8, but
  // tie-break on insertion order explicitly so the budget split is deterministic.
  const indexed = candidates.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => (b.c.priority - a.c.priority) || (a.i - b.i));
  const ordered = indexed.map((x) => x.c);

  // Budget: the top TODAY_PRIMARY_MAX become `primary` (rendered inline); the rest
  // become `more` (collapsed behind one quiet disclosure). The arbiter may DEMOTE a
  // producer's suggested tier here, never promote it — placement is the arbiter's.
  const primary = ordered.slice(0, TODAY_PRIMARY_MAX).map((c) => ({ ...c, tier: "primary" as const }));
  const more = ordered.slice(TODAY_PRIMARY_MAX).map((c) => ({ ...c, tier: "more" as const }));

  return { hero, primary, more, total: ordered.length };
}
