import {
  awaitingBrainDecisions,
  getBrainDecision,
  landedBrainDecisions,
  upcomingBrainDecisions,
} from "../../repo/brain-decisions.js";
import { recoveryWeekStatus } from "../../repo/profile.js";

export interface PlanUpcomingItem {
  summary: string;
  effective_date: string;
  kind: string;
  domain: string;
  // The conductor's own athlete-facing sentence, when one exists. Optional so the
  // pre-existing forward items keep exactly the shape the Plan surface already reads.
  explanation?: string | null;
}

export interface PlanUpcomingNote {
  items: PlanUpcomingItem[];
  // Changes that have ALREADY taken effect in the last week. Present only when there
  // is something to say.
  landed?: PlanUpcomingItem[];
  // Decisions still waiting on the athlete, with the sentence the conference wrote
  // for them. Not aged out — a hold is an open question, not history.
  awaiting?: PlanUpcomingItem[];
}

// A calm, FORWARD-LOOKING note for the Plan surface: the queued training/recovery
// changes the brain will land soon (a recovery week landing Monday, a bounded
// target change) so a reshaped week announces itself instead of arriving
// silently. Pull-never-push, no scores, no retrospective "what your team did"
// feed — only what's coming and when.
//
// Scoped to the Plan tab's own domains (training + recovery); nutrition/health
// changes live on their own surfaces. Excludes the recovery draft the Plan's
// recovery banner already shows (matched on action.proposal_id) so the same
// change never appears twice. Returns null when nothing is waiting.
export function planUpcomingNote(windowDays = 10): PlanUpcomingNote | null {
  const rs = recoveryWeekStatus();
  const recoveryDraftId = rs && (rs.state === "drafted" || rs.state === "upcoming") ? Number(rs.proposal_id) : null;

  const items: PlanUpcomingItem[] = [];
  for (const d of upcomingBrainDecisions(windowDays)) {
    if (d.domain !== "training" && d.domain !== "recovery") continue;
    if (recoveryDraftId != null) {
      // The recovery banner already covers this draft — never show it twice.
      const proposalId = Number((getBrainDecision(d.id)?.action as any)?.proposal_id);
      if (Number.isFinite(proposalId) && proposalId === recoveryDraftId) continue;
    }
    const summary = String(d.summary ?? "").trim();
    if (!summary || !d.effective_date) continue;
    items.push({
      summary,
      effective_date: String(d.effective_date),
      kind: String(d.kind),
      domain: String(d.domain),
      explanation: d.explanation,
    });
  }

  const planDomain = (domain: string) => domain === "training" || domain === "recovery";
  const row = (d: { summary: string; kind: string; domain: string; explanation: string | null }, date: string) => ({
    summary: String(d.summary ?? "").trim(),
    effective_date: date,
    kind: String(d.kind),
    domain: String(d.domain),
    explanation: d.explanation,
  });

  // An applied change speaks through the plan items themselves (brain_change_reason);
  // repeating it here would say the same thing twice. What is missing everywhere else
  // is the conference's own sentence, so that is what these rows carry.
  const landed = landedBrainDecisions(7)
    .filter((d) => planDomain(d.domain) && d.explanation)
    .map((d) => row(d, d.landed_date))
    .filter((item) => item.summary);

  // Not time-windowed. A hold is an open question waiting on the athlete, not an
  // event receding into history — ageing one off the surface is how the brain's own
  // good intent evaporates unseen.
  const awaiting = awaitingBrainDecisions()
    .filter((d) => planDomain(d.domain))
    .map((d) => row(d, d.decided_date))
    .filter((item) => item.summary);

  if (!items.length && !landed.length && !awaiting.length) return null;
  return { items, ...(landed.length ? { landed } : {}), ...(awaiting.length ? { awaiting } : {}) };
}
