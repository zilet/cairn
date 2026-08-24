import { z } from "zod";
import { buildClinicalReportData, renderClinicalReportText } from "../../report.js";
import {
  activeContextEffect,
  getCoachingFocus,
  getTrajectory,
  wholePersonTrajectory,
  listDirectives,
  nextBestStep,
  nextStepDone,
  reactionModelForCoach,
  awaitingBrainDecisions,
  listReadableBrainDecisions,
  revertDecision,
  snoozeNextStep,
} from "../../domain/brain/index.js";
import {
  annotateDirectiveFreshness,
  annotateDirectiveRecheck,
  buildHealthExport,
  deriveDirectives,
  evidenceSummary,
  getEvidenceForMarker,
  getHealthSynthesisView,
  getLatestHealthReview,
  getMarkerHistory,
  healthOutcomeAnnotations,
  cardiovascularRiskRead,
  doctorLoopRead,
  doctorPacketRead,
  nextCheckupRead,
  healthFocus,
  healthStanding,
  prioritizeMarkers,
  recordHealthOutcomeAnnotations,
  setDirectiveStatusByUser,
  symptomMarkerLinks,
} from "../../domain/health/index.js";
import { getOutcomeLearnings } from "../../domain/person/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";
import { disputeBelief, listBeliefs, undisputeBelief } from "../../repo.js";

export function registerConnectedBrainTools(server: McpToolRegistrar) {
  server.tool(
    "list_brain_decisions",
    "Read recent meaningful coaching decisions and their accountable status. Bounded, pull-only, with no raw prompts or hidden reasoning.",
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => asText(listReadableBrainDecisions({ limit: limit ?? 50 }))
  );

  server.tool(
    "list_waiting_brain_decisions",
    "Read the coaching decisions still waiting on the athlete, across every domain, each with the athlete-facing sentence the case conference wrote for it. Not time-windowed: a hold stays until it is resolved.",
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => asText(awaitingBrainDecisions(limit ?? 20))
  );

  server.tool(
    "revert_brain_decision",
    "Undo one reversible autonomous coaching decision using its server-owned rollback snapshot. The user's word wins; returns a calm error when the decision is not reversible.",
    { id: z.number().int().positive(), reason: z.string().max(300).optional() },
    async ({ id, reason }) => asText(revertDecision(id, reason ?? "user undo"))
  );

  server.tool(
    "get_health_markers",
    "Marker history aggregated across every uploaded health document: per marker the latest value/flag, the previous reading, a numeric time series, and a trend ({dir: rising|falling|stable, change, span_days, n}) so you can speak to direction over time, not just the latest value. Each marker also carries its health group (group/group_label — e.g. Lipids & Cardiovascular, Metabolic & Glucose), and the top-level `groups` list gives the canonical-ordered groups present. Flagged (low/high) markers sort first.",
    {},
    async () => asText(getMarkerHistory())
  );

  server.tool(
    "get_health_standing",
    "A pull-based health standing read: actual-age vs selectable reference-age percentiles for markers with real reference curves (VO2max/body composition), plus BP, labs, activity, Garmin/recovery signals, and a plain signal_age synthesis. Motivational orientation only — no 0-100 score and not medical advice.",
    {
      reference_age: z
        .number()
        .optional()
        .describe("Compare against this decade; e.g. 20 for 20s, 30 for 30s. Defaults to 20s."),
    },
    async ({ reference_age }) => asText(healthStanding({ referenceAge: reference_age }))
  );

  server.tool(
    "get_cardiovascular_risk",
    "Cardiovascular risk input/enhancer read: collects PREVENT/PCE inputs, names missing clinical inputs, surfaces ApoB/Lp(a)/hs-CRP/body-fat/VO2max/family-history risk enhancers, and gives counterfactual lever projections. It does not emit a risk percentage unless sourced coefficients are vendored; informational, not medical advice.",
    {},
    async () => asText(cardiovascularRiskRead())
  );

  server.tool(
    "get_doctor_loop",
    "Doctor-loop read: structured missing-workup recommendations plus lab/DEXA retest attention derived through the adaptive attention engine. Informational, not medical advice; no PREVENT/PCE risk coefficients are computed here.",
    {},
    async () => asText(doctorLoopRead({ refresh: true }))
  );

  server.tool(
    "get_next_checkup",
    "Next-checkup read: the athlete-facing view of the recheck-cadence engine. Returns { lede, due_now[], upcoming[], follow_through[], prep, has_content, frame }: rechecks whose window is open (due_now) or opening (upcoming) plus worth-adding workups, visible follow-through on active supplements & directives (each target marker's latest value, trend words, recheck state, and a plain status — moving your way / not yet / awaiting first recheck), and a deterministic prep list (ordered labs from your last visit/review, what to bring, what to ask). Informational, not medical advice; no scores.",
    { as_of: z.string().optional().describe("YYYY-MM-DD for due/upcoming checks; defaults to today.") },
    async ({ as_of }) => asText(nextCheckupRead({ refresh: true, asOf: as_of }))
  );

  server.tool(
    "get_doctor_packet",
    "Export-ready doctor packet: current prioritized health focus, active connected-brain directives, doctor-loop missing-workup/retest plan, AHA PREVENT cardiovascular-risk read, and latest intervention-outcome annotations. Informational, not medical advice; no disease-labeling or wellness scores.",
    { as_of: z.string().optional().describe("YYYY-MM-DD date for due/retest checks; defaults to today.") },
    async ({ as_of }) => asText(doctorPacketRead({ refresh: true, asOf: as_of }))
  );

  server.tool(
    "get_health_outcomes",
    "Intervention-to-outcome read: compares follow-up marker readings after prior connected-brain directives/intervention anchors and labels each as improving, unchanged, or worsening. Directional only, not proof of causation, no diagnosis, and no automatic directive changes. Pass record:true only when the user explicitly wants the read saved as an insight + learning memory.",
    {
      limit: z.number().int().optional(),
      record: z.boolean().optional(),
    },
    async ({ limit, record }) =>
      asText(record ? recordHealthOutcomeAnnotations(limit) : healthOutcomeAnnotations(limit))
  );

  server.tool(
    "get_health_review",
    "Get the latest whole-picture health review (headline, wins, watchlist, focus areas, follow-ups, training/nutrition impact) — or null when none has been run yet.",
    {},
    async () => asText(getLatestHealthReview())
  );

  server.tool(
    "run_health_review",
    "Queue a durable whole-picture health review over the user's context and marker history. Returns a job immediately; poll get_agent_job. Informational, not medical advice.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("health_review", {}, agent))
  );

  server.tool(
    "get_priority_markers",
    "Markers re-ranked by impact: distance from the OPTIMAL zone (not just the lab's normal range), most-actionable first, flagged (low/high) markers always on top, and a marker HEADING out of optimal ranked above a stably-borderline one. Each marker carries optimal/distance/in_optimal/actionable, its health group (group/group_label), a least-squares trend ({dir: rising|falling|stable, change, span_days, n, slope_per_week, projection}) and a forecast ({direction: improving|worsening|stable, eta_text, crossing}) — eta_text is a PLAIN-LANGUAGE projection vs optimal ('trending toward optimal, roughly 6 weeks out'); never a score. The top-level `groups` lists the canonical-ordered groups present. Informational, not medical advice — the internal impact_score is an ordering signal only, never a user-facing grade.",
    {},
    async () => asText(prioritizeMarkers())
  );

  server.tool(
    "get_health_focus",
    "The deterministic TIERED health priorities (elite-coach prioritization): the flat directive flood collapsed into a handful of connected priorities — one per health group, tier (act_now/track), the markers driving it, whether they compound, and the LEAD move per domain. Plain words, no scores; the basis for the whole-picture synthesis.",
    {},
    async () => asText(healthFocus())
  );

  server.tool(
    "get_coaching_focus",
    "THE CONDUCTOR — the single sequenced WHOLE-PICTURE focus, the cross-domain analog of get_health_focus. Arbitrates training, running, DEXA body-comp, labs, nutrition and recovery into ONE lead lever for this block + 1-2 things handled alongside (usually via a different lever) + an explicit 'later' (what's deferred) + the cross-domain connections + ONE batched ~6-8wk retest checkpoint. How an elite coach prioritizes + sequences: act on a few things, name what waits, connect the domains. Plain words, no scores.",
    {},
    async () => asText(getCoachingFocus())
  );

  server.tool(
    "get_reaction_model",
    "How THIS user actually reacts, learned from their own logged history: a handful of plain-language patterns (e.g. how a deficit moves their weight, whether hs-CRP tracks training load, what late events cost their sleep, which plan days land vs get skipped, whether recovery signal is even available) each with a confidence WORD (tentative/observed/strong) — never a number. The personalization spine.",
    {},
    async () => asText(reactionModelForCoach())
  );

  server.tool(
    "get_trajectory",
    "The user's forward ARC: a periodized horizon (weeks/phase) toward their goals (body-comp, longevity markers, any race), the milestones along it, and today framed as the next step on the path. Plain words, no completion %; null line when there's no goal/block/race.",
    { date: z.string().optional() },
    async ({ date }) => asText(getTrajectory(date))
  );

  server.tool(
    "get_whole_person_trajectory",
    "Read the standing everything-better objective across strength, endurance, body composition, metabolic health, and recovery. Names what this phase intentionally parks and flags only unexplained regression; plain words, no score.",
    {
      end: z.string().optional().describe("YYYY-MM-DD window end; defaults to today"),
      days: z.number().int().min(28).max(120).optional(),
    },
    async ({ end, days }) => asText(wholePersonTrajectory({ end, days }))
  );

  server.tool(
    "get_context_effect",
    "The active life-context effect: events the user mentioned once (a late concert, travel, illness, a hard week) that should shape today — expect worse sleep / a transient inflammation bump (don't alarm) / ease the load / disrupted fueling — each with a fade date. Plain words; empty when nothing's active.",
    { date: z.string().optional() },
    async ({ date }) => asText(activeContextEffect(date))
  );

  server.tool(
    "get_next_step",
    "The single highest-leverage next action across ALL domains (train/fuel/recover/recheck/life) right now — one calm thing, or null on a quiet day. A suggestion the user drives, never a to-do wall.",
    { date: z.string().optional() },
    async ({ date }) => asText(nextBestStep(date) ?? { next_step: null })
  );

  server.tool(
    "mark_next_step",
    "Record the user's response to a next-step: action 'done' (did it) or 'snooze' (not today) by step_key — so a handled/skipped step doesn't return tomorrow. Pull, never push.",
    { step_key: z.string(), action: z.enum(["done", "snooze"]) },
    async ({ step_key, action }) => {
      if (action === "done") nextStepDone(step_key);
      else snoozeNextStep(step_key);
      return asText({ ok: true, step_key, action });
    }
  );

  server.tool(
    "get_health_synthesis",
    "The cached elite-coach whole-picture health story (the headline, the 2-3 connected priorities + their concrete moves, the single highest-leverage change), plus the deterministic focus tiering and a `stale` flag (true when newer labs landed than the synthesis was written against). Returns the last generated narrative (or null); regenerate with synthesize_health.",
    {},
    async () => {
      const view = getHealthSynthesisView();
      return asText({ synthesis: view.synthesis, focus: healthFocus(), stale: view.stale });
    }
  );

  server.tool(
    "synthesize_health",
    "Queue and cache the elite-coach whole-picture synthesis across labs, body composition, training, recovery, nutrition, supplements, and life. Returns a job immediately; poll get_agent_job. Informational and pull-only.",
    { agent: z.string().optional().describe("agent name from list_agents; omit/'auto' for the rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("health_synthesis", {}, agent))
  );

  server.tool(
    "get_health_export",
    "Structured, FHIR-inspired health summary: a portable read-only slice of the user's markers/observations over time (latest value + unit + effective date + full history[], the OPTIMAL reference band — distinct from the lab's normal range — an optimal-zone status like within-optimal/above-optimal, and the deterministic trend), plus non-marker MyChart clinicalFacts such as medications/allergies/procedures, the understood supplement regimen, and active connected-brain directives, under a self-describing meta header (exportVersion, generated, subject). Something to hand a physician or another tool. INFORMATIONAL, not medical advice — no 0-100 scores anywhere.",
    {},
    async () => asText(buildHealthExport())
  );

  server.tool(
    "get_health_report",
    "Doctor-ready CLINICAL summary as plain text — the human-readable counterpart to get_health_export (which is JSON for tools). A 'findings to discuss' lead (every marker outside its lab range or optimal target, in priority order), then markers grouped into clinical panels (Lipids & Cardiovascular, Metabolic, …) with the latest value, lab flag, optimal target, and the full dated history so progress is visible, plus DEXA body composition and the supplement list. Ready to paste into a patient-portal (MyChart) message. The PWA renders the same data as a print-to-PDF page at GET /api/health-report. INFORMATIONAL, not medical advice — no 0-100 scores.",
    { name: z.string().optional().describe("patient name to stamp on the summary") },
    async ({ name }) => asText(renderClinicalReportText(buildClinicalReportData(), { name }))
  );

  server.tool(
    "list_directives",
    "List the connected-brain cross-domain health directives (a flagged finding propagated into nutrition/training/watch, with rationale, an evidence citation where well-established, and an `uncertain` flag where the lever is real but unsettled). Active by default; pass all:true for the full history incl. resolved/dismissed feedback rows.",
    { all: z.boolean().optional() },
    async ({ all }) => asText(annotateDirectiveRecheck(annotateDirectiveFreshness(listDirectives({ all: !!all }))))
  );

  server.tool(
    "get_symptom_links",
    "Symptom ↔ marker connections: a symptom the user logged (in a life event or a check-in note — e.g. blurry vision, fatigue, headaches) co-occurring with a genuinely out-of-optimal lab marker (e.g. an elevated systolic BP, low ferritin). A quiet 'worth mentioning to your clinician' read — INFORMATIONAL, never a diagnosis; returns [] when nothing co-occurs. The connected brain reaching across the logs.",
    {},
    async () => asText(symptomMarkerLinks())
  );

  server.tool(
    "update_directive",
    "Flip a directive's status (the review side of propose-review-apply — nothing auto-applies). `resolved` means handled for that marker snapshot; `dismissed` suppresses equivalent future advice until the marker materially changes. Returns the updated directive, or null when the id is unknown.",
    { id: z.number().int(), status: z.enum(["active", "resolved", "dismissed"]) },
    // Mirrors PUT /api/directives/:id: a Done/Dismiss re-derives synchronously so a
    // cross-source twin is suppressed on the same flip.
    async ({ id, status }) => asText(setDirectiveStatusByUser(id, status))
  );

  server.tool(
    "derive_directives",
    "Re-run the deterministic propagation engine over the latest markers: clears the 'markers' directive source and re-derives evidence-based nutrition/training/watch directives for every out-of-optimal marker, while honoring prior Done/Dismiss feedback. Idempotent; leaves agent-emitted 'health_review' directives untouched.",
    {},
    async () => asText(deriveDirectives())
  );

  server.tool(
    "reconcile_markers",
    "Queue a conservative reconciliation of differently named versions of the same lab analyte. Returns a job immediately; poll get_agent_job. It never merges incompatible analytes/units or changes measured values.",
    { agent: z.string().optional().describe("agent name from list_agents; omit/'auto' for the rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("marker_reconcile", {}, agent))
  );

  server.tool(
    "research",
    "Queue one cited health/longevity evidence pass and cache its verified claims. Returns a job immediately; poll get_agent_job. Gated by research_enabled; off means no network. Informational, not medical advice.",
    {
      question: z.string().describe("the health/longevity question to ground"),
      markers: z.array(z.string()).optional().describe("relevant marker names, e.g. ['ApoB']"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
      force: z.boolean().optional().describe("re-research even when cached evidence exists for this topic"),
    },
    async ({ question, markers, agent, force }) =>
      asText(queueMcpAgentJob("evidence_research", { question, markers, force }, agent))
  );

  server.tool(
    "get_evidence",
    "Make a directive's citation INSPECTABLE: returns the cited evidence behind ONE marker as { marker, evidence:[{claim, source_title, source_url, body, confidence, retrieved_at}] }. Reads the evidence cache only (never the network), so it works with research disabled; evidence:[] when research never ran for that marker. INFORMATIONAL, not medical advice.",
    {
      marker: z
        .string()
        .optional()
        .describe("the marker name, e.g. 'ApoB' (omit for the most-recent cached evidence overall)"),
      limit: z.number().int().optional(),
    },
    async ({ marker, limit }) => asText(getEvidenceForMarker(marker, limit))
  );

  server.tool(
    "get_evidence_summary",
    "Make the evidence cache DISCOVERABLE without an N-fetch fan-out: returns { research_enabled, total, by_marker:[{marker, count}] } — the per-marker count of cited rows on file, so a UI can show a 'see the evidence (N)' hint and know up-front where evidence exists. Reads the cache only (never the network). INFORMATIONAL, not medical advice.",
    {},
    async () => asText(evidenceSummary())
  );

  server.tool(
    "list_beliefs",
    "The coach's inspectable beliefs: one calm, grouped list over learned cross-domain models, felt-signal correlations, and personal-response modifiers (how THIS athlete tends to respond) — each row in athlete voice with its evidence in plain words (never a number/score) and its dispute status. Active connected-brain directives already show via list_directives (linked here via a count, not duplicated). Disputed beliefs stay listed under set_aside — transparent, not deleted.",
    {},
    async () => asText(listBeliefs())
  );

  server.tool(
    "dispute_belief",
    "Mark one coach belief 'that's not right' by its id (from list_beliefs). This is NEVER a one-tap inversion — it only sets the belief aside: it stops feeding prompts/personal-response modifiers and is recorded as a negative outcome for the pattern that produced it, but stays visible under set_aside for transparency. Reversible via undispute_belief.",
    { id: z.string() },
    async ({ id }) => asText(disputeBelief(id))
  );

  server.tool(
    "undispute_belief",
    "Restore a disputed belief (from list_beliefs' set_aside) back to active.",
    { id: z.string() },
    async ({ id }) => asText(undisputeBelief(id))
  );

  server.tool(
    "get_outcome_learnings",
    "The quiet 'What Cairn has noticed' read: durable, plain-language learnings drawn from suggestion → actual reconciliation (e.g. 'tolerates higher training frequency than the read assumed'). Returns { learnings:[{id, content, noticed_at}] }, newest-first. These season the coach's defaults — never a score, never a gate; pull-never-push.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(getOutcomeLearnings(limit))
  );
}
