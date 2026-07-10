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

import { createHash } from "node:crypto";

// Import each producer read DIRECTLY from its sibling module (never from the
// barrel ../repo.js) — repo modules do this to avoid a circular import, since the
// barrel re-exports this very file.
import { getDayIntake } from "./nutrition.js";
import { localDateISO } from "./shared.js";
import { getCachedDayRead } from "./intelligence.js";
import { listVisibleInsights, listActiveDirectives } from "./coach.js";
import { programAdjustments, programBalance, recentMuscleLoad } from "./progression.js";
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
import { listBrainDecisions } from "./brain-decisions.js";
import { getAppState, setAppState } from "./app-state.js";

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
  // Semantic version of a presentation-only attention item. This is not the
  // underlying directive id: unchanged long-lived guidance keeps one revision,
  // while materially new evidence creates a new one and may surface again.
  revision?: string;
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

// ---- the surprise budget: one NEW thing inline per day ---------------------
// The brain already budgets material coaching changes (~1/domain/week); this is
// the SURFACE-level counterpart. At most ONE never-before-surfaced attention
// item — a new health revision, a fresh insight or weekly read, a waiting plan
// draft — is introduced INLINE per local day. Later newcomers wait behind the
// quiet "more" disclosure (pull, never push) and take the inline slot on a
// later day. Routine state cards (fuel, reconcile, lately, week-ahead…), the
// hero, and announced brain changes (accountability must never be hidden by
// presentation) are never budgeted. The ledger lives in app_state as a bounded
// { "<id>:<revision|title>": "YYYY-MM-DD introduced" } map.
const TODAY_INTRO_KEY = "today_agenda_intro";
const SURPRISE_IDS = new Set(["health-focus", "connection-insight", "weekly-read", "draft-proposals"]);
const INTRO_LEDGER_MAX_AGE_DAYS = 60;

function introSig(c: TodayAgendaCandidate): string {
  return `${c.id}:${c.revision ?? c.title ?? ""}`;
}

function loadIntroLedger(): Record<string, string> {
  try {
    const parsed = JSON.parse(getAppState(TODAY_INTRO_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Decide which candidates to HOLD OUT of the inline tier this pass, and record
// the single introduction the day's allowance covers. Walks the sorted order
// simulating the inline slots, so a deferred newcomer's slot backfills with the
// next routine candidate and the inline tier never starves. `record: false`
// computes the identical shape WITHOUT spending the allowance — for surfaces no
// human is looking at (the MCP tool), so an agent's read can never mark a
// newcomer "introduced" that nobody saw.
function applySurpriseBudget(
  ordered: TodayAgendaCandidate[],
  today: string,
  maxInline: number,
  record: boolean
): Set<string> {
  const deferred = new Set<string>();
  const ledger = loadIntroLedger();
  let allowance = Object.values(ledger).some((v) => v === today) ? 0 : 1;
  let slots = maxInline;
  let dirty = false;
  for (const c of ordered) {
    if (slots <= 0) break;
    if (SURPRISE_IDS.has(c.id) && !(introSig(c) in ledger)) {
      if (allowance > 0) {
        allowance -= 1;
        ledger[introSig(c)] = today;
        dirty = true;
        slots -= 1;
      } else {
        deferred.add(c.id);
      }
    } else {
      slots -= 1;
    }
  }
  if (dirty && record) {
    const cutoff = Date.parse(`${today}T00:00:00Z`) - INTRO_LEDGER_MAX_AGE_DAYS * 86_400_000;
    for (const [key, value] of Object.entries(ledger)) {
      const t = Date.parse(`${String(value)}T00:00:00Z`);
      if (!Number.isFinite(t) || t < cutoff) delete ledger[key];
    }
    try {
      setAppState(TODAY_INTRO_KEY, JSON.stringify(ledger));
    } catch {
      /* the budget is presentation-only; a failed write just re-introduces tomorrow */
    }
  }
  return deferred;
}

// Run a producer that may throw / return null without ever breaking the agenda.
function safe(fn: () => TodayAgendaCandidate | null): TodayAgendaCandidate | null {
  try {
    const c = fn();
    return c && Number(c.priority) > 0 ? c : null;
  } catch {
    return null;
  }
}

function weekStartFor(date: string): string {
  const d = new Date(String(date || localDateISO()).slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
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

// If the Brief has decided today is deliberately easy/rest, the agenda must not
// re-introduce plan-forward training cards underneath it. If today's Brief cache
// is cold, stay conservative until the read fills it; past/future routed dates
// keep the old behavior because they are review/planning views, not "open today".
function planForwardAllowed(date: string): boolean {
  try {
    const kind = getCachedDayRead(date)?.kind;
    if (!kind && date === localDateISO()) return false;
    return kind !== "rest" && kind !== "easy";
  } catch {
    return true;
  }
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

// ---- announced change: a structural coaching decision that will land at its
// natural boundary unless the athlete says "hold on". It is explicit without
// becoming a notification; the action cancels the decision deterministically in
// one tap (the server revert path), never through an agent turn. ----
function announcedChangeCandidate(): TodayAgendaCandidate | null {
  const decision = listBrainDecisions({ status: "announced", limit: 20 }).find((row) => !!row.effective_date);
  if (!decision) return null;
  return {
    id: `announced-decision-${decision.id}`,
    kind: "plan",
    tier: "primary",
    priority: 82,
    kicker: "NEXT BOUNDARY",
    title: decision.summary,
    body: `${decision.rationale || "Cairn found a structural change worth making."} Planned for ${decision.effective_date}.`,
    action: {
      label: "Hold on",
      kind: "hold-decision",
      payload: decision.id,
    },
  };
}

// ---- plan: a draft that requires review under the selected autonomy mode or a
// goal/user-locked boundary. High because the athlete is owed a decision. ----
function planDraftCandidate(): TodayAgendaCandidate | null {
  const plans = listProposals(8) as any[];
  const drafts = (Array.isArray(plans) ? plans : []).filter((p) => p && p.status === "draft");
  if (!drafts.length) return null;
  const raw = String(drafts[0]?.instruction || "")
    .replace(/^(auto|chat):\s*/i, "")
    .trim();
  return {
    id: "draft-proposals",
    kind: "plan",
    tier: "primary",
    priority: 78,
    kicker: "PLAN DRAFT",
    title: drafts.length > 1 ? `${drafts.length} plan changes are waiting` : "A plan change is waiting",
    body: raw || "This one needs your decision before anything changes.",
    action: { label: "Review", kind: "plan-coach" },
  };
}

// ---- health: a cross-domain directive needing attention. An act_now health focus
// priority (a flagged lab / compounding concern) ranks high; a quieter "track"-only
// picture ranks moderate. The health line on Today (#ctxHealth) shows the review's
// lead focus; this candidate gates that surface on whether the connected brain has
// something genuinely pressing. Reads healthFocus + listActiveDirectives. ----
const HEALTH_AGENDA_SEEN_KEY = "today_agenda_seen:health-focus";

function clipAgenda(value: unknown, max = 230): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function healthAgendaRevision(focus: any, directives: any[]): string {
  const lead = focus?.lead ?? null;
  const material = {
    group: lead?.group ?? null,
    tier: lead?.tier ?? null,
    markers: Array.isArray(lead?.markers) ? lead.markers : [],
    readings: Array.isArray(lead?.readings)
      ? lead.readings.map((row: any) => ({
          name: row?.name ?? null,
          value: row?.value ?? null,
          flag: row?.flag ?? null,
          trend: row?.trend ?? null,
        }))
      : [],
    moves: lead?.moves ?? {},
    directives: directives
      .map((row: any) => ({
        key: row?.directive_key ?? `${row?.marker ?? ""}:${row?.domain ?? ""}`,
        marker: row?.marker ?? null,
        side: row?.trigger_side ?? null,
        value: row?.trigger_value ?? null,
        date: row?.trigger_date ?? null,
      }))
      .sort((a: any, b: any) => String(a.key).localeCompare(String(b.key))),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 24);
}

function healthCandidate(date: string, opts: { includeSeen?: boolean } = {}): TodayAgendaCandidate | null {
  // This is an attention delta for NOW, never a historical Today card. The durable
  // health strategy remains in Stand and in the plan-shaping brain regardless.
  if (date !== localDateISO()) return null;
  const directives = listActiveDirectives() as any[];
  if (!Array.isArray(directives) || !directives.length) return null; // nothing flagged → silent
  const focus = healthFocus();
  const actNow = Number(focus?.act_now) || 0;
  const track = Number(focus?.track) || 0;
  // No off-optimal priorities at all → the active directives are quiet/maintenance;
  // don't claim a Today slot for them.
  if (actNow <= 0 && track <= 0) return null;
  const lead = focus?.lead as any;
  if (!lead) return null;
  const revision = healthAgendaRevision(focus, directives);
  if (!opts.includeSeen && getAppState(HEALTH_AGENDA_SEEN_KEY) === revision) return null;
  const move = lead?.moves?.nutrition || lead?.moves?.training || lead?.moves?.watch || "";
  const body = clipAgenda(
    move || lead?.why || "Open the connected read to see how this is already shaping training and meals."
  );
  return {
    id: "health-focus",
    kind: "health",
    tier: actNow > 0 ? "primary" : "more",
    priority: actNow > 0 ? 80 : 46,
    kicker: "HEALTH READ",
    title: clipAgenda(focus.headline || `${lead.group} is shaping today's coaching.`, 120),
    body,
    action: { label: "Open read", kind: "me-health-read" },
    dismissible: true,
    revision,
  };
}

export function acknowledgeTodayAgendaCandidate(
  id: string,
  revision?: string | null
): { ok: boolean; id: string; revision?: string; stale?: boolean; error?: string } {
  if (id !== "health-focus") return { ok: false, id, error: "candidate is not acknowledgement-aware" };
  const current = healthCandidate(localDateISO(), { includeSeen: true });
  if (!current?.revision) return { ok: false, id, error: "candidate is no longer active" };
  if (revision && revision !== current.revision) {
    return {
      ok: false,
      id,
      revision: current.revision,
      stale: true,
      error: "candidate changed before acknowledgement",
    };
  }
  setAppState(HEALTH_AGENDA_SEEN_KEY, current.revision);
  if (getAppState(HEALTH_AGENDA_SEEN_KEY) !== current.revision) {
    return { ok: false, id, revision: current.revision, error: "acknowledgement could not be persisted" };
  }
  return { ok: true, id, revision: current.revision };
}

// ---- standing momentum: a genuine win in motion (fat off since a DEXA, blood
// pressure trending down, a steady weight slope) — the SAME momentum the
// top-level Me→Standing read shows. Pull, never push: it rides in "more" most days
// (moderate priority), the arbiter may surface it on a quiet day, and it OMITS
// itself when there's no real win (`has_momentum` false). No scores — just the
// trajectory in plain words. Reads standingMomentum (deterministic, null-safe). ----
function standingMomentumCandidate(_date: string): TodayAgendaCandidate | null {
  let m: any = null;
  try {
    m = standingMomentum();
  } catch {
    m = null;
  }
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
function adjustmentsCandidate(date: string, weeklyStats?: any): TodayAgendaCandidate | null {
  // Adjustments adapt an ACTIVE plan — on a blank slate (no plan yet) there's
  // nothing to evolve, and the volume landmarks would read every group as a "gap",
  // which would nag a brand-new user about "missing" work. Gate on having a plan
  // (mirrors weekAheadCandidate) — calm by default; no plan → silent.
  const stats: any = weeklyStats ?? getWeeklyStats(date);
  if ((Number(stats?.week_planned) || 0) <= 0) return null;
  const rows = programAdjustments(programBalance(2, date), recentMuscleLoad(2, date));
  if (!Array.isArray(rows) || !rows.length) return null;
  // A deload or a true gap (not a recovering / already-programmed group) lifts the
  // urgency a little above a routine progression digest.
  const pressing = rows.some((a) => a && (a.kind === "deload" || (a.kind === "gap" && !a.recovering)));
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
    // The insight row id versions this attention item, so NEXT week's read is a
    // genuinely new thing to the surprise budget while re-fetches of this one aren't.
    revision: String(weekly.id ?? ""),
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
    // Versioned by the insight row id — a NEW connection is a new thing to the
    // surprise budget; re-fetching the same one is not.
    revision: String(conn.id ?? ""),
  };
}

// ---- week-ahead: a calm sketch of lift / run / mixed / rest across the next few
// days. A forward look, never urgent — low priority so it sinks below anything
// about today. There's no cheap repo read for the agentic week-ahead, so we gate it
// on having a plan to sketch from (getWeeklyStats carries week_planned). ----
function weekAheadCandidate(date: string, weeklyStats?: any): TodayAgendaCandidate | null {
  const stats: any = weeklyStats ?? getWeeklyStats(date);
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
function runComplianceCandidate(date: string): TodayAgendaCandidate | null {
  const rc: any = getRunCompliance(weekStartFor(date));
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
function latelyCandidate(date: string, weeklyStats?: any): TodayAgendaCandidate | null {
  const stats: any = weeklyStats ?? getWeeklyStats(date);
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
// `markIntroduced` (default true) controls whether this pass may SPEND the day's
// surprise allowance (write the intro ledger). The PWA's GET /api/today-agenda is
// the one surface a human actually sees, so it records; the MCP tool passes false
// so a coaching agent's read never marks a newcomer "introduced" nobody saw.
export function todayAgenda(date?: string, opts: { markIntroduced?: boolean } = {}): TodayAgenda {
  const d = String(date || localDateISO());
  const hero = briefHero();
  const showPlanForward = planForwardAllowed(d);

  // Build every candidate, each isolated so one failing source never breaks the
  // agenda. Producers that read by date take `d`; the rest are date-agnostic.
  const candidates: TodayAgendaCandidate[] = [];
  const add = (c: TodayAgendaCandidate | null) => {
    if (c) candidates.push(c);
  };

  // The weekly stats read is shared by three candidates below (adjustments/week-ahead/
  // lately) — compute it ONCE and thread it in rather than recomputing per candidate.
  // Null on failure (each candidate falls back to its own compute, then self-omits).
  let weeklyStats: any = null;
  try {
    weeklyStats = getWeeklyStats(d);
  } catch {
    weeklyStats = null;
  }

  add(safe(() => fuelCandidate(d)));
  add(safe(() => reconcileCandidate()));
  add(safe(() => announcedChangeCandidate()));
  add(safe(() => planDraftCandidate()));
  add(safe(() => healthCandidate(d)));
  if (showPlanForward) add(safe(() => adjustmentsCandidate(d, weeklyStats)));
  add(safe(() => weeklyCandidate()));
  add(safe(() => insightCandidate()));
  if (showPlanForward) {
    add(safe(() => weekAheadCandidate(d, weeklyStats)));
    add(safe(() => runComplianceCandidate(d)));
  }
  add(safe(() => latelyCandidate(d, weeklyStats)));

  // The two NEW Era-2 candidate producers (sibling-built). They return a finished
  // candidate or null; still wrapped in safe() so a throw never breaks the agenda
  // and a priority<=0 producer self-omits.
  add(safe(() => sinceLastLookedCandidate(d)));
  add(safe(() => goalCheckinCandidate()));
  add(safe(() => standingMomentumCandidate(d)));

  // Stable sort by priority desc. Array.prototype.sort is stable in modern V8, but
  // tie-break on insertion order explicitly so the budget split is deterministic.
  const indexed = candidates.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => b.c.priority - a.c.priority || a.i - b.i);
  const ordered = indexed.map((x) => x.c);

  // The surprise budget only shapes the LIVE today surface — a routed historical
  // date renders archival state and introduces nothing.
  let heldOut = new Set<string>();
  if (d === localDateISO()) {
    try {
      heldOut = applySurpriseBudget(ordered, d, TODAY_PRIMARY_MAX, opts.markIntroduced !== false);
    } catch {
      heldOut = new Set();
    }
  }

  // Budget: the top TODAY_PRIMARY_MAX become `primary` (rendered inline); the rest
  // become `more` (collapsed behind one quiet disclosure). The arbiter may DEMOTE a
  // producer's suggested tier here, never promote it — placement is the arbiter's.
  // A held-out newcomer skips the inline tier (its slot backfills) but keeps its
  // sorted position among "more" — waiting, never gone.
  const inline = ordered.filter((c) => !heldOut.has(c.id));
  const primary = inline.slice(0, TODAY_PRIMARY_MAX).map((c) => ({ ...c, tier: "primary" as const }));
  const primaryIds = new Set(primary.map((c) => c.id));
  const more = ordered.filter((c) => !primaryIds.has(c.id)).map((c) => ({ ...c, tier: "more" as const }));

  return { hero, primary, more, total: ordered.length };
}
