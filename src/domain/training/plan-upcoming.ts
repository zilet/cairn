import { getBrainDecision, upcomingBrainDecisions } from "../../repo/brain-decisions.js";
import { recoveryWeekStatus } from "../../repo/profile.js";

export interface PlanUpcomingItem {
  summary: string;
  effective_date: string;
  kind: string;
  domain: string;
}

export interface PlanUpcomingNote {
  items: PlanUpcomingItem[];
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
  const recoveryDraftId = rs && rs.state === "drafted" ? Number(rs.proposal_id) : null;

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
    });
  }

  return items.length ? { items } : null;
}
