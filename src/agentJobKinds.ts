export const AGENT_JOB_KINDS = [
  "session_suggest",
  "proposal",
  "evolve_program",
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
] as const;

export type AgentJobKind = (typeof AGENT_JOB_KINDS)[number];

const AGENT_JOB_KIND_SET = new Set<string>(AGENT_JOB_KINDS);

export function isAgentJobKind(kind: unknown): kind is AgentJobKind {
  return typeof kind === "string" && AGENT_JOB_KIND_SET.has(kind);
}
