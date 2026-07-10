import type { AgentJobKind } from "../../agentJobKinds.js";
import { enqueueAgentJob } from "../../agentJobs.js";
import { createAgentJob } from "../../repo.js";

// MCP calls share the same durable non-blocking execution contract as REST.
// Returning the job immediately prevents a tool client from holding an HTTP
// request open while a CLI reasons; get_agent_job exposes the eventual result.
export function queueMcpAgentJob(kind: AgentJobKind, input: Record<string, unknown> = {}, agent?: string | null) {
  const job = createAgentJob({ kind, input, agent: agent ?? null });
  enqueueAgentJob((job as any).id);
  return { ok: true as const, queued: true as const, job };
}
