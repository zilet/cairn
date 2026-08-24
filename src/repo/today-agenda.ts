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
// candidate is omitted (priority <= 0). The Brief is ALWAYS the hero. Supporting
// cards collapse behind one quiet "more" (`TODAY_PRIMARY_MAX` is 0 — the daily
// open is Brief + one action, not a rail of specialists). No scores cross to the
// user — `priority` is internal, exactly like marker `impact_score`; the client
// renders placement, never the number.
//
// Pure, deterministic, null-safe. Every producer read is wrapped in its own
// try/catch so one failing source never breaks the agenda — graceful: no data →
// just the hero.
//
// DELIBERATELY SEPARATE from `src/domain/brain/today-attention.ts`, which is the
// other ranking on this screen. They answer different questions over different
// surfaces: this one budgets the RAIL (which side cards render vs collapse behind
// "more", with a surprise budget over ~20 candidate producers); that one arbitrates
// the MAIN column's LEAD (which single surface — Brief, feedback, insight, weekly,
// fuel — earns the position of prominence) and can only reorder emphasis, never
// hide anything. Note the assumption above that "the Brief is ALWAYS the hero" is
// this module's rail contract; relaxing it for the main column is precisely why
// today-attention.ts exists. Merging them would couple a reducing budget to a
// non-reducing emphasis call. Keep them apart.
// ============================================================================

import { createHash } from "node:crypto";

// Import each producer read DIRECTLY from its sibling module (never from the
// barrel ../repo.js) — repo modules do this to avoid a circular import, since the
// barrel re-exports this very file.
import { getDayIntake, getMealPlan } from "./nutrition.js";
import { estimateExpenditure } from "./expenditure.js";
import { computeGoalCheck } from "./profile.js";
import { cutQualityRead, type CutQualityActive } from "./cut-quality.js";
import { fuelingFollowThroughDue } from "./fueling.js";
import { addDaysISO, clipText, localDateISO } from "./shared.js";
import { getCachedDayRead } from "./intelligence.js";
import { listVisibleInsights } from "./coach.js";
import { listActiveDirectives } from "./directives-read.js";
import { acuteGates } from "./hybrid-load.js";
import { programAdjustments, programBalance } from "./progression.js";
import { getWeeklyStats, vouchedRunCompliance } from "./sessions.js";
import { listUnreconciledGarminStrength } from "./activities.js";
import { healthFocus } from "./propagation.js";
// The health-standing momentum read — the SAME wins-in-motion the top-level Me→Standing
// view shows, surfaced here as a quiet pull-only "you're trending the right way" card.
import { standingMomentum } from "./standing.js";
// The waiting-draft 'plan' candidate — now the ONE Today surface that points at a
// review-needed draft (the duplicate side-loader card was retired).
import { listAttentionReviewHeldProposals, listProposals, listReviewHeldProposals } from "./profile.js";
// The two NEW Era-2 candidate producers, built by sibling agents. They land at
// integration time; import them now (do not stub). Each returns a fully-formed
// TodayAgendaCandidate or null.
import { sinceLastLookedCandidate } from "./since-last.js";
import { goalCheckinCandidate } from "./goal-checkin.js";
// The episodic-wearer's one calm offer: a night with the watch on would sharpen
// the recovery read. Rides the shared attention schedule for its cooldown, so it
// is made at most a handful of times and then goes quiet on its own.
import { reconcileSensorRecheckAttention, sensorRecheckCandidate } from "./sensor-recheck.js";
// The one calm ask for a measurement a live derivation is blocked on. Same shape
// as the sensor recheck: a pure producer here, and the attention ladder is only
// ever spent once placement is known.
import { measurementRequestCandidate, reconcileMeasurementRequestAttention } from "./measurement-request.js";
import { listBrainDecisions } from "./brain-decisions.js";
import { specialistVoiceLine } from "../brain/specialist-voice.js";
import { getAppState, setAppState } from "./app-state.js";
import { getSettings } from "./settings.js";

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
  // An optional quieter SECOND action rendered beside the primary one. Used by the
  // announced-change card to keep a deterministic one-tap "Hold this" alongside the
  // conversational "Discuss with coach" primary, so cancelling a scheduled change
  // never depends on an agent being reachable.
  secondary_action?: { label: string; kind: string; payload?: any };
  client_card?: string; // names an EXISTING client-rendered card id to render in place of generic text
  dismissible?: boolean;
  // Semantic version of a presentation-only attention item. This is not the
  // underlying directive id: unchanged long-lived guidance keeps one revision,
  // while materially new evidence creates a new one and may surface again.
  revision?: string;
  // A genuinely-new attention item waiting behind the "more" disclosure (the
  // surprise budget deferred or hasn't yet introduced it). Lets the client show
  // a quiet "· one new" cue on the disclosure — legible pull, never a push.
  waiting?: boolean;
};

export type TodayAgenda = {
  hero: TodayAgendaCandidate;
  primary: TodayAgendaCandidate[];
  more: TodayAgendaCandidate[];
  total: number; // count of all surfaced non-hero candidates
};

// The attention budget: at most this many candidates render inline as `primary`;
// everything else with a positive priority collapses behind the quiet "more".
// 0 = the daily open is the Brief plus one action; supporting cards wait in more.
export const TODAY_PRIMARY_MAX = 0;

// ---- the surprise budget: one NEW thing inline per day ---------------------
// The brain already budgets material coaching changes (~1/domain/week); this is
// the SURFACE-level counterpart. At most ONE never-before-surfaced attention
// item — a new health revision, a fresh insight or weekly read, a waiting plan
// draft — is recorded per local day so the "· one new" whisper on more can
// clear. Later newcomers wait behind the quiet "more" disclosure (pull, never
// push). Routine state cards (fuel, reconcile, lately, week-ahead…), the
// hero, and announced brain changes (accountability must never be hidden by
// presentation) are never budgeted. The ledger lives in app_state as a bounded
// { "<id>:<revision|title>": "YYYY-MM-DD introduced" } map.
const TODAY_INTRO_KEY = "today_agenda_intro";
const SURPRISE_IDS = new Set([
  "health-focus",
  "fast-loss-attention",
  "connection-insight",
  "weekly-read",
  "draft-proposals",
]);
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
    const isNewcomer = SURPRISE_IDS.has(c.id) && !(introSig(c) in ledger);
    if (slots <= 0) {
      // No inline slots (the daily open keeps primary empty): still spend the
      // day's one introduction so "· one new" on more clears for that item, and
      // later newcomers wait.
      if (isNewcomer) {
        if (allowance > 0) {
          allowance -= 1;
          ledger[introSig(c)] = today;
          dirty = true;
        } else {
          deferred.add(c.id);
        }
      }
      continue;
    }
    if (isNewcomer) {
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
  if (d?.known?.kcal === true && d?.remaining && d?.target && Number(d.remaining.kcal) < 0) priority = 40;
  return {
    id: "fuel",
    kind: "fuel",
    tier: "primary",
    priority,
    client_card: "fuel",
  };
}

// ---- fueling follow-through: after a nutrition-target change APPLIED, offer a calm
// one-tap "how's fueling feeling?" read. fuelingFollowThroughDue gates it to the change's
// 7-day window, a day with logged food, and "not answered yet" — so it self-omits the rest
// of the time. A genuine coach-initiated follow-up, moderate priority (never urgent, never
// a notification); it stays pull-only behind the quiet "more" when the day has bigger news. ----
function fuelingFollowupCandidate(date: string): TodayAgendaCandidate | null {
  let due = false;
  try {
    due = !!fuelingFollowThroughDue(date)?.due;
  } catch {
    due = false;
  }
  if (!due) return null;
  return {
    id: "fueling-followup",
    kind: "fuel",
    tier: "primary",
    priority: 42,
    client_card: "fueling-followup",
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
// natural boundary. The card is accountability, not a veto gate. Its primary
// action opens a Coach conversation carrying the exact ledger id so the athlete
// can understand or modify it in ordinary language; a quieter secondary "Hold
// this" is the deterministic escape hatch — one tap cancels the scheduled change
// through the server revert path, never depending on an agent being reachable. ----
function upcomingDateLabel(effectiveDate: string, asOf: string): string {
  if (effectiveDate === addDaysISO(asOf, 1)) return "Tomorrow";
  if (effectiveDate === asOf) return "Today";
  const parsed = new Date(`${effectiveDate}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return effectiveDate;
  const sixDaysOut = addDaysISO(asOf, 6);
  if (effectiveDate > asOf && sixDaysOut && effectiveDate <= sixDaysOut) {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(parsed);
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(parsed);
}

function mealPlanAnnouncement(decision: any, asOf: string): Pick<TodayAgendaCandidate, "kicker" | "title" | "body"> {
  const effective = upcomingDateLabel(String(decision.effective_date), asOf);
  let plan: any = null;
  try {
    const id = Number((decision.action as any)?.meal_plan_id ?? decision.source_ref_key);
    if (id > 0) plan = getMealPlan(id);
  } catch {
    plan = null;
  }
  const kcal = Number(plan?.parsed?.daily_kcal);
  const protein = Number(plan?.parsed?.daily_protein_g);
  const specifics = [
    Number.isFinite(kcal) && kcal > 0 ? `${Math.round(kcal).toLocaleString("en-US")} kcal` : null,
    Number.isFinite(protein) && protein > 0 ? `${Math.round(protein)} g protein` : null,
  ].filter(Boolean);
  return {
    kicker: "COMING UP",
    title: `${effective} — your meal plan refreshes automatically`,
    body: specifics.length ? `Daily plan: ${specifics.join(" · ")}.` : "Your next week of meals is ready.",
  };
}

function announcedChangeCandidates(date: string): TodayAgendaCandidate[] {
  // Announcements describe live commitments, not the state of a routed day in
  // the past. Keeping them off historical agendas also makes relative copy such
  // as "Tomorrow" unambiguously relative to the day the athlete is opening now.
  const today = localDateISO();
  if (date !== today) return [];

  // Every standing announcement is accountability the athlete is owed. Return
  // each as its own stable candidate; the shared arbiter keeps the live rail calm
  // by placing only the highest two inline and leaving every other one reachable
  // behind "more". Earliest boundary first, then oldest decision first for a
  // deterministic same-day tie.
  const decisions = listBrainDecisions({ status: "announced", limit: 100 })
    .filter((row) => !!row.effective_date && Number(row.id) > 0)
    .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)) || Number(a.id) - Number(b.id));
  return decisions.map((decision) => {
    // When the conference stored a specialist opinion, lead the body with its
    // attributed voice ("Lab reader: ApoB is the one to move") so the athlete
    // sees WHO on the team made the call — surfaced only when it already exists.
    const voice = specialistVoiceLine((decision as any).specialist, decision.domain);
    const copy =
      decision.kind === "meal_plan"
        ? mealPlanAnnouncement(decision, today)
        : {
            kicker: "NEXT BOUNDARY",
            title: decision.summary,
            body: [
              voice ? `${voice.line}.` : null,
              `${decision.rationale || "Cairn found a structural change worth making."} Planned for ${decision.effective_date}.`,
            ]
              .filter(Boolean)
              .join(" "),
          };
    return {
      id: `announced-decision-${decision.id}`,
      kind: "plan",
      tier: "primary",
      priority: 82,
      ...copy,
      action: {
        label: "Discuss with coach",
        kind: "chat-decision",
        payload: [
          `Discuss scheduled Cairn decision #${decision.id}.`,
          `Summary: ${decision.summary}.`,
          `Rationale: ${decision.rationale || "Cairn found a structural change worth making."}`,
          `Effective date: ${decision.effective_date}.`,
          "Please explain how this fits my current data and what it changes compared with my current plan.",
        ].join(" "),
      },
      // A quiet deterministic stop, always available: one tap cancels the scheduled
      // decision through the server revert path (no agent turn), so the athlete is
      // never left waiting on a conversation to hold a change they don't want.
      secondary_action: {
        label: "Hold this",
        kind: "hold-decision",
        payload: decision.id,
      },
    };
  });
}

// A draft the autonomy layer already OWNS — a pending/announced/applied brain
// decision has scheduled it for its natural boundary with one-tap Undo — is not the
// athlete's call to make. Under lead mode a bounded (floors-clamped) nutrition or
// training change quiet-applies exactly this way: the proposal stays a `draft` while
// the ledger carries it, so filtering on status alone would nag "needs your decision"
// for a change the team already made. hydrateProposal only ever attaches these three
// statuses to a live proposal, so any autonomy row means the ledger owns it; keep the
// check explicit so a future status can't silently start re-nagging.
function autonomyOwnedDraft(proposal: any): boolean {
  const status = proposal?.autonomy?.status;
  return status === "pending" || status === "announced" || status === "applied";
}

// ---- plan: a draft that genuinely requires the athlete's review — the ask path
// (lead_mode='review_everything', or a goal/user-locked/safety boundary), NOT a change
// the autonomy layer already scheduled and NOT a budget hold (which waits quietly and
// lands automatically when the surprise-budget week rolls). High because the athlete is
// owed a decision. Applies the same autonomy filter the coach list (isOpenProposal) uses. ----
function planDraftCandidate(): TodayAgendaCandidate | null {
  const leadMode = getSettings().lead_mode;
  const reviewHolds = (
    leadMode === "review_everything" ? listReviewHeldProposals(8) : listAttentionReviewHeldProposals(8)
  ) as any[];
  const recentPlans = listProposals(8) as any[];
  const reviewIds = new Set((Array.isArray(reviewHolds) ? reviewHolds : []).map((p) => Number(p?.id)));
  // Genuine review holds are intentionally first and independently bounded. The
  // secondary recent scan is only for bare chat/manual drafts or review posture.
  const plans = [
    ...(Array.isArray(reviewHolds) ? reviewHolds : []),
    ...(Array.isArray(recentPlans) ? recentPlans.filter((p) => !reviewIds.has(Number(p?.id))) : []),
  ];
  const drafts = plans.filter((p) => {
    if (!p || p.status !== "draft" || autonomyOwnedDraft(p)) return false;
    // Review-everything intentionally preserves the traditional review queue,
    // including bare drafts. Coach-led postures never turn an orphaned chat or
    // manual artifact into a generic Review wall.
    if (leadMode === "review_everything") return true;
    if (p.autonomy?.status !== "review" || p.autonomy?.review_required !== true) return false;
    // Only genuine independent-review boundaries may interrupt Today in lead /
    // announce-first. Ordinary requested-review, stale-draft, or budget-hold
    // bookkeeping is handled in conversation/repair or waits for the budget week to
    // roll — never pushed back as a generic plan review.
    return ["safety_floor", "user_lock", "domain_policy", "clinical"].includes(
      String(p.autonomy?.review_reason_code ?? "")
    );
  });
  if (!drafts.length) return null;
  const raw = String(drafts[0]?.instruction || "")
    .replace(/^(auto|chat):\s*/i, "")
    .trim();
  // Prefer the draft's own athlete-facing summary over the internal instruction
  // ("nutrition: adaptive check-in") so the one remaining card actually says what
  // the decision is about.
  const summary = String(drafts[0]?.parsed?.summary || "").trim();
  return {
    id: "draft-proposals",
    kind: "plan",
    tier: "primary",
    priority: 78,
    kicker: "NEEDS YOUR DECISION",
    title: drafts.length > 1 ? `${drafts.length} plan changes are waiting` : "A plan change is waiting",
    body: clipAgenda(summary || raw || "This one needs your decision before anything changes."),
    action: { label: "Review", kind: "plan-coach" },
  };
}

// ---- health: a cross-domain directive needing attention. An act_now health focus
// priority (a flagged lab / compounding concern) ranks high; a quieter "track"-only
// picture ranks moderate. The health line on Today (#ctxHealth) shows the review's
// lead focus; this candidate gates that surface on whether the connected brain has
// something genuinely pressing. Reads healthFocus + listActiveDirectives. ----
const HEALTH_AGENDA_SEEN_KEY = "today_agenda_seen:health-focus";
const FAST_LOSS_AGENDA_SEEN_KEY = "today_agenda_seen:fast-loss-attention";
const FAST_LOSS_ACK_COOLDOWN_DAYS = 14;

function clipAgenda(value: unknown, max = 230): string {
  return clipText(value, max, { collapseWhitespace: true, ellipsis: "…" });
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

function healthCandidate(
  date: string,
  opts: { includeSeen?: boolean; asOf?: string } = {}
): TodayAgendaCandidate | null {
  // This is an attention delta for NOW, never a historical Today card. The durable
  // health strategy remains in Stand and in the plan-shaping brain regardless.
  if (date !== (opts.asOf ?? localDateISO())) return null;
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

type TodayAgendaAckRecord = { revision: string; acknowledged_on: string };

function readTodayAgendaAckRecord(key: string): TodayAgendaAckRecord | null {
  try {
    const parsed = JSON.parse(getAppState(key) || "null") as Partial<TodayAgendaAckRecord> | null;
    const revision = typeof parsed?.revision === "string" ? parsed.revision : "";
    const acknowledgedOn = typeof parsed?.acknowledged_on === "string" ? parsed.acknowledged_on : "";
    return revision && /^\d{4}-\d{2}-\d{2}$/.test(acknowledgedOn)
      ? { revision, acknowledged_on: acknowledgedOn }
      : null;
  } catch {
    return null;
  }
}

function acknowledgementStillCurrent(key: string, revision: string, date: string, cooldownDays: number): boolean {
  const record = readTodayAgendaAckRecord(key);
  if (!record || record.revision !== revision) return false;
  const resurfacesOn = addDaysISO(record.acknowledged_on, cooldownDays);
  return !!resurfacesOn && date < resurfacesOn;
}

function rateBand(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `q${Math.round(n / 0.25)}` : null;
}

function goalWeightBand(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `q${Math.round(n / 5)}` : null;
}

function trendSeverityBucket(trend: number, safeMax: number): "above" | "well-above" | "far-above" {
  const ratio = Math.abs(trend) / safeMax;
  if (ratio >= 1.35) return "far-above";
  if (ratio >= 1.15) return "well-above";
  return "above";
}

function fastLossAgendaRevision(goal: any, expenditure: any, cut: CutQualityActive): string {
  const safeMax = Number(goal?.leanness_rate?.safe_max_rate_lb ?? goal?.safe_max_rate_lb);
  const trend = Number(expenditure?.trend_lb_wk);
  const material = {
    goal: {
      mode: goal?.goal_mode ?? null,
      requested_rate_band: rateBand(goal?.requested?.weekly_rate_lb),
      remaining_weight_band: goalWeightBand(goal?.lbs_to_lose),
      ideal_rate_band: rateBand(goal?.leanness_rate?.lean_ideal_rate_lb ?? goal?.recommended?.weekly_rate_lb),
      safe_rate_band: rateBand(safeMax),
    },
    severity: trendSeverityBucket(trend, safeMax),
    verdict: cut.verdict,
    anchors: cut.strength.anchors
      .map((anchor) => ({
        name: String(anchor?.name || "")
          .trim()
          .toLowerCase(),
        status: anchor?.status ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 24);
}

// A whole-context CUT-QUALITY attention item. This deliberately ignores the
// weekly compass's simple OLS pace flag: it requires the robust 21-day outcome
// trend, medium/high confidence, the leanness-aware safe band, and enough recent
// established lifting to say whether strength is holding, mixed, or sliding.
function fastLossCandidate(
  date: string,
  opts: { includeSeen?: boolean; asOf?: string } = {}
): TodayAgendaCandidate | null {
  if (date !== (opts.asOf ?? localDateISO())) return null;
  const expenditure = estimateExpenditure(21, { syncMeasuredRmr: false });
  if (!["medium", "high"].includes(String(expenditure?.confidence))) return null;
  const goal: any = computeGoalCheck(undefined, { expenditure, syncMeasuredRmr: false });
  const cut = cutQualityRead(date, { goal, expenditure });
  if (!cut.active || cut.verdict === "insufficient" || cut.rate.vs_lean_safe !== "above") return null;
  const safeMax = Number(goal?.leanness_rate?.safe_max_rate_lb ?? goal?.safe_max_rate_lb);
  const trend = Number(expenditure?.trend_lb_wk);
  if (!Number.isFinite(safeMax) || safeMax <= 0 || !Number.isFinite(trend) || Math.abs(trend) <= safeMax) return null;

  const revision = fastLossAgendaRevision(goal, expenditure, cut);
  if (
    !opts.includeSeen &&
    acknowledgementStillCurrent(FAST_LOSS_AGENDA_SEEN_KEY, revision, date, FAST_LOSS_ACK_COOLDOWN_DAYS)
  ) {
    return null;
  }
  const strengthBody =
    cut.verdict === "preserving"
      ? "Strength is holding, which is a good sign; the loss rate is still above your lean-safe band."
      : cut.verdict === "mixed"
        ? "Strength is mixed while the faster loss continues, so this is worth reviewing in context."
        : "Strength is sliding alongside the faster loss, so protecting the training signal matters now.";
  return {
    id: "fast-loss-attention",
    kind: "fuel",
    tier: "primary",
    priority: cut.verdict === "sliding" ? 81 : cut.verdict === "mixed" ? 77 : 73,
    kicker: "CUT QUALITY",
    title: "Your cut is moving faster than the muscle-preserving band.",
    body: strengthBody,
    action: { label: "Review the read", kind: "progress-energy" },
    dismissible: true,
    revision,
  };
}

export function acknowledgeTodayAgendaCandidate(
  id: string,
  revision?: string | null
): { ok: boolean; id: string; revision?: string; stale?: boolean; error?: string } {
  const asOf = localDateISO();
  const current =
    id === "health-focus"
      ? healthCandidate(asOf, { includeSeen: true, asOf })
      : id === "fast-loss-attention"
        ? fastLossCandidate(asOf, { includeSeen: true, asOf })
        : null;
  if (id !== "health-focus" && id !== "fast-loss-attention") {
    return { ok: false, id, error: "candidate is not acknowledgement-aware" };
  }
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
  const key = id === "health-focus" ? HEALTH_AGENDA_SEEN_KEY : FAST_LOSS_AGENDA_SEEN_KEY;
  const stored =
    id === "health-focus" ? current.revision : JSON.stringify({ revision: current.revision, acknowledged_on: asOf });
  setAppState(key, stored);
  if (getAppState(key) !== stored) {
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
  const rows = programAdjustments(programBalance(2, date), acuteGates(date));
  if (!Array.isArray(rows) || !rows.length) return null;
  // A deload or a missing-pattern gap lifts the urgency a little above a routine
  // progression digest. (This used to also test `!a.recovering` on the gap, which
  // could never be false: `recovering` is only ever set on a kind:'balance' row.
  // Removed rather than left as a guard that reads like it protects something.)
  const pressing = rows.some((a) => a && (a.kind === "deload" || a.kind === "gap"));
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
// Reads vouchedRunCompliance (mirrors the Endurance compliance line) — an applied
// plan that cannot speak for THIS week reads as no prescription at all, so a card
// is never printed against a fossilized target. ----
function runComplianceCandidate(date: string): TodayAgendaCandidate | null {
  const rc: any = vouchedRunCompliance(weekStartFor(date));
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
  add(safe(() => fuelingFollowupCandidate(d)));
  add(safe(() => reconcileCandidate()));
  try {
    for (const announced of announcedChangeCandidates(d)) add(announced);
  } catch {
    /* one unavailable producer still degrades to the rest of Today */
  }
  add(safe(() => planDraftCandidate()));
  add(safe(() => healthCandidate(d)));
  add(safe(() => fastLossCandidate(d)));
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
  // A PURE read here — never spends the offer. Its own priority (14) means the
  // sort below decides whether it actually lands inline or behind "more", and
  // that isn't known until every candidate is ranked; see the reconcile call
  // after placement, which is the only place this offer may be spent.
  add(safe(() => sensorRecheckCandidate(d)));
  // Also a PURE read — the ask is only spent after placement, below.
  add(safe(() => measurementRequestCandidate(d)));

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
  // become `more` (collapsed behind one quiet disclosure). When MAX is 0 the daily
  // open keeps primary empty — Brief + one action — and every supporting card waits
  // in more. The arbiter may DEMOTE a producer's suggested tier here, never promote
  // it. A held-out newcomer skips the inline tier (its slot backfills) but keeps its
  // sorted position among "more" — waiting, never gone.
  const inline = ordered.filter((c) => !heldOut.has(c.id));
  const primary = inline.slice(0, TODAY_PRIMARY_MAX).map((c) => ({ ...c, tier: "primary" as const }));
  const primaryIds = new Set(primary.map((c) => c.id));
  // When nothing renders inline, more is the surface a human can actually open.
  // Spend sensor/measurement offers against that set so MAX=0 cannot burn the
  // ladder by never counting a card as seen.
  const seenIds = TODAY_PRIMARY_MAX > 0 ? primaryIds : new Set(ordered.map((c) => c.id));

  // The sensor-recheck offer is spent now that placement is known. When MAX is
  // 0, more is the surface a human can open, so a card there counts as seen —
  // otherwise the ladder would never tick. When MAX > 0, only inline primary
  // spends (a card buried in more was never shown). Mirrors the surprise
  // budget's own live-day / human-pass gate above; `reconcileSensorRecheckAttention`
  // also clears a resolved episode regardless of placement (that's cleanup, not
  // spending, so it isn't gated on `surfaced`).
  if (d === localDateISO() && opts.markIntroduced !== false) {
    try {
      reconcileSensorRecheckAttention(d, seenIds.has("sensor-recheck"));
    } catch {
      /* presentation-only; a failed write just re-offers (or re-cleans) next time */
    }
    try {
      // Same contract, one need at a time: the ask is spent only for the request
      // that actually reached the seen set, and every retired need is swept
      // regardless of placement.
      const surfaced = [...seenIds].find((id) => id.startsWith("measurement-request-")) ?? null;
      reconcileMeasurementRequestAttention(d, surfaced);
    } catch {
      /* presentation-only; a failed write just re-asks (or re-cleans) next time */
    }
  }

  // Stamp genuinely-new attention items that ended up behind the disclosure
  // (deferred by the budget, or simply outranked) so the client can whisper
  // "· one new" on the collapsed summary — the waiting item stays pull-only.
  const ledger = d === localDateISO() ? loadIntroLedger() : null;
  const more = ordered
    .filter((c) => !primaryIds.has(c.id))
    .map((c) => ({
      ...c,
      tier: "more" as const,
      ...(ledger && SURPRISE_IDS.has(c.id) && !(introSig(c) in ledger) ? { waiting: true } : {}),
    }));

  return { hero, primary, more, total: ordered.length };
}
