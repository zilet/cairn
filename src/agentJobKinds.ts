export const AGENT_JOB_KINDS = [
  "session_suggest",
  "session_compose",
  "proposal",
  "evolve_program",
  "compose_week",
  "meal_plan",
  "meal_swap",
  "recipe",
  "nutrition_checkin",
  "insight",
  "weekly_read",
  "health_review",
  "health_synthesis",
  "day_read_override",
  "chat_distill",
  "brain_review",
  "case_conference",
  "week_ahead",
  "marker_reconcile",
  "evidence_research",
  "exercise_reconcile",
  "memory_consolidate",
  "about_me_grow",
  "onboard",
  "what_if",
  "welcome",
  // Not agentic: a Garmin Connect pull. It is a job so the request returns at once and
  // the PWA can follow it, and it runs on its own lane (src/agentJobs.ts), never
  // behind a CLI agent.
  "garmin_sync",
] as const;

export type AgentJobKind = (typeof AGENT_JOB_KINDS)[number];

const AGENT_JOB_KIND_SET = new Set<string>(AGENT_JOB_KINDS);

export function isAgentJobKind(kind: unknown): kind is AgentJobKind {
  return typeof kind === "string" && AGENT_JOB_KIND_SET.has(kind);
}
