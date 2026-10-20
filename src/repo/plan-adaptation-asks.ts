// ---------- an asked return never re-asks ----------
// A race adaptation made around pain does not come back by itself: its end is ASKED
// (plan-adaptations.ts `asked`, a held draft the athlete answers — autonomy-service's
// askForAdaptationRestore). Left there, an unanswered ask sat in "Waiting on you" for as
// long as nobody tapped it, and a policy re-read could put the same question back up as
// a fresh hold. So an ask has a life of its own, and a short one:
//
//   - answered: the athlete's yes landed the draft (`restored`), or their no discarded it
//     (`kept`) — the rows say so, once;
//   - unanswered after ASK_RESURFACE_AFTER_DAYS: it is stamped to come back ONCE, as a
//     quiet pull item on that day's Brief (brief-asks.ts) — never a notification;
//   - unanswered after ASK_SETTLE_AFTER_DAYS: it settles to the safe default. The change
//     made around pain STAYS (the lift keeps its adapted form), the draft and its hold are
//     set aside, and the rows record `kept` with the reason. The regular plan comes back
//     whenever the athlete asks for it; nothing is asked again.
//
// Keyed on the ask's DRAFT, not one decision id: a re-read that superseded the first
// hold with a new one on the same draft is still the same question.
// Deterministic, idempotent, agent-free; run from the scheduler's daily boundary pass.
import { db } from "../db.js";
import { addDaysISO, daysBetweenISO } from "../lib/dates.js";
import { getBrainDecision, listReviewDecisionsForProposal, patchBrainDecision } from "./brain-decisions.js";
import {
  adaptationRowIsForRace,
  askedPlanAdaptations,
  askedRestoreWords,
  settleAskedPlanAdaptations,
  type PlanAdaptationRow,
} from "./plan-adaptations.js";
import { proposalStatus, setProposalStatus } from "./proposals.js";
import { localDateISO, localDayOfStamp } from "./shared.js";

/** Days an ask waits quietly before it comes back once on the Brief. */
export const ASK_RESURFACE_AFTER_DAYS = 2;
/** Days an ask waits in all before it settles to the safe default (the adaptation stays). */
export const ASK_SETTLE_AFTER_DAYS = 7;

/** The context key a hold carries once it has been put back on the Brief (its one day). */
export const BRIEF_RESURFACE_KEY = "brief_resurface_on";

export interface AskedAdaptationGroup {
  /** The draft the athlete answers (null when the hold names none). */
  proposal_id: number | null;
  /** The hold the rows were marked against. */
  decision_id: number | null;
  /** The day the ask went up. */
  asked_on: string;
  rows: PlanAdaptationRow[];
  for_race: boolean;
  /** The day it comes back on the Brief, once stamped; null before. */
  resurface_on: string | null;
}

function parseJson(value: unknown): any {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function dayOf(stamp: unknown): string | null {
  const day = String(stamp ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The draft behind a hold: its plan_proposal ref, else `action.proposal_id`. */
function proposalOfDecision(decisionId: number | null): number | null {
  if (decisionId == null) return null;
  const d = getBrainDecision(decisionId);
  if (!d) return null;
  const fromRef = d.source_ref_type === "plan_proposal" ? Number(d.source_ref_key) : 0;
  const fromAction = Number((d.action as any)?.proposal_id) || 0;
  const id = fromRef > 0 ? fromRef : fromAction;
  return id > 0 ? id : null;
}

/** Every hold ever written on `proposalId`, any status (a re-read may have replaced the first). */
function decisionsOnProposal(proposalId: number): Array<{ id: number; status: string; context: any }> {
  const rows = db
    .prepare(
      `SELECT id, status, context_json FROM brain_decisions
        WHERE (source_ref_type = 'plan_proposal' AND source_ref_key = ?)
           OR json_extract(action_json, '$.proposal_id') = ?
        ORDER BY id`
    )
    .all(String(proposalId), proposalId) as any[];
  return rows.map((r) => ({ id: Number(r.id), status: String(r.status), context: parseJson(r.context_json) ?? {} }));
}

function resurfaceStamp(proposalId: number | null): string | null {
  if (proposalId == null) return null;
  for (const d of decisionsOnProposal(proposalId)) {
    const day = dayOf(d.context?.[BRIEF_RESURFACE_KEY]);
    if (day) return day;
  }
  return null;
}

/** The `asked` rows, one group per question (per draft). */
export function askedAdaptationGroups(): AskedAdaptationGroup[] {
  const groups = new Map<string, AskedAdaptationGroup>();
  for (const row of askedPlanAdaptations()) {
    const decisionId = row.restore_decision_id;
    const proposalId = proposalOfDecision(decisionId);
    const key = proposalId != null ? `p:${proposalId}` : decisionId != null ? `d:${decisionId}` : `r:${row.id}`;
    // resolved_at is SQLite's UTC datetime('now'): the athlete's day is its LOCAL day.
    const askedOn = localDayOfStamp(row.resolved_at) ?? row.until_date;
    let group = groups.get(key);
    if (!group) {
      group = {
        proposal_id: proposalId,
        decision_id: decisionId,
        asked_on: askedOn,
        rows: [],
        for_race: false,
        resurface_on: resurfaceStamp(proposalId),
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    if (askedOn < group.asked_on) group.asked_on = askedOn;
    if (adaptationRowIsForRace(row)) group.for_race = true;
  }
  return [...groups.values()];
}

// The reasons the rows record, in the athlete's words (they are read on the Changes feed
// and by the coach): calm, second person, the change kept rather than a lift "lost".
const KEPT_BY_ANSWER = "You chose to keep it as it is; the regular plan comes back whenever you ask for it.";
const KEPT_SET_ASIDE =
  "The question was set aside, so the adaptation stays as it is until you ask for the regular plan.";
const KEPT_UNANSWERED =
  "No answer came within a week, so the adaptation stays as it is — the safe default for a change made around pain. The regular plan comes back whenever you ask for it.";
const RESTORED_BY_ANSWER = "Back to the regular plan at your yes.";

export interface AskSettleOutcome {
  /** Rows the athlete's yes brought back. */
  restored: number[];
  /** Rows kept by the athlete's no, or by an ask set aside elsewhere. */
  kept: number[];
  /** Rows settled to the safe default because the ask went unanswered past its window. */
  settled: number[];
  /** Drafts stamped to come back once on today's Brief. */
  resurfaced: number[];
}

/** One question settled to the safe default: the hold and its draft set aside, the rows kept. */
function settleUnanswered(group: AskedAdaptationGroup, today: string): number {
  const proposalId = group.proposal_id;
  if (proposalId != null) {
    for (const hold of listReviewDecisionsForProposal(proposalId)) {
      if (hold.id == null) continue;
      patchBrainDecision(hold.id, {
        context: {
          ...((hold.context ?? {}) as Record<string, unknown>),
          ask_settled: { on: today, outcome: "kept", reason: KEPT_UNANSWERED },
        },
      });
    }
    // Retires the draft AND every live review hold on it; the receipt is the rows' own
    // reason (and the hold's `ask_settled`), so no second generic ledger row is filed.
    setProposalStatus(proposalId, "superseded", { recordDecision: false });
  }
  return settleAskedPlanAdaptations(
    group.rows.map((row) => row.id),
    "kept",
    KEPT_UNANSWERED
  );
}

/** Stamp the draft's live hold(s) to come back on `today`'s Brief — once. */
function stampResurface(group: AskedAdaptationGroup, today: string): boolean {
  if (group.proposal_id == null || group.resurface_on) return false;
  let stamped = false;
  for (const hold of listReviewDecisionsForProposal(group.proposal_id)) {
    if (hold.id == null) continue;
    patchBrainDecision(hold.id, {
      context: { ...((hold.context ?? {}) as Record<string, unknown>), [BRIEF_RESURFACE_KEY]: today },
    });
    stamped = true;
  }
  return stamped;
}

/**
 * The daily pass over every asked return: answered asks settle their rows, an unanswered
 * one is stamped to come back once on the Brief, and one past its window settles to the
 * safe default. Idempotent per day.
 */
export function settleAskedAdaptations(today: string = localDateISO()): AskSettleOutcome {
  const outcome: AskSettleOutcome = { restored: [], kept: [], settled: [], resurfaced: [] };
  for (const group of askedAdaptationGroups()) {
    const ids = group.rows.map((row) => row.id);
    const status = group.proposal_id != null ? proposalStatus(group.proposal_id) : null;
    if (status === "applied") {
      if (settleAskedPlanAdaptations(ids, "restored", RESTORED_BY_ANSWER)) outcome.restored.push(...ids);
      continue;
    }
    if (status === "discarded") {
      if (settleAskedPlanAdaptations(ids, "kept", KEPT_BY_ANSWER)) outcome.kept.push(...ids);
      continue;
    }
    if (status != null && status !== "draft") {
      if (settleAskedPlanAdaptations(ids, "kept", KEPT_SET_ASIDE)) outcome.kept.push(...ids);
      continue;
    }
    const age = daysBetweenISO(today, group.asked_on) ?? 0;
    if (age >= ASK_SETTLE_AFTER_DAYS) {
      if (settleUnanswered(group, today)) outcome.settled.push(...ids);
      continue;
    }
    if (age >= ASK_RESURFACE_AFTER_DAYS && stampResurface(group, today) && group.proposal_id != null) {
      outcome.resurfaced.push(group.proposal_id);
    }
  }
  return outcome;
}

/** An unanswered ask that comes back on `date`'s Brief — the one day it was stamped for. */
export interface ResurfacedAdaptationAsk {
  proposal_id: number;
  decision_id: number | null;
  question: string;
  detail: string;
  /** The day the ask settles to the safe default if it stays unanswered. */
  settles_on: string;
  exercises: string[];
}

export function resurfacedAdaptationAsks(date: string = localDateISO()): ResurfacedAdaptationAsk[] {
  const out: ResurfacedAdaptationAsk[] = [];
  for (const group of askedAdaptationGroups()) {
    if (group.proposal_id == null || group.resurface_on !== date) continue;
    if (proposalStatus(group.proposal_id) !== "draft") continue;
    const words = askedRestoreWords(group.rows, group.for_race);
    const settlesOn = addDaysISO(group.asked_on, ASK_SETTLE_AFTER_DAYS) ?? group.asked_on;
    out.push({
      proposal_id: group.proposal_id,
      decision_id: group.decision_id,
      question: words.summary,
      detail:
        "It was changed around pain, so it comes back only when you say so. Leave it and it simply stays as it is.",
      settles_on: settlesOn,
      exercises: [...new Set(group.rows.map((row) => row.before?.exercise ?? row.exercise).filter(Boolean))],
    });
  }
  return out;
}
