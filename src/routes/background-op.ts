import type { Response } from "express";
import { enqueueAgentJob } from "../agentJobs.js";
import type { AgentJobKind } from "../agentJobKinds.js";
import { createAgentJob } from "../domain/person/index.js";

// Heavy agentic ops are always durable background jobs. The historical
// bg_ops_enabled flag remains readable for imported settings, but disabling it
// must never put a 90-300s CLI wait back onto a user-facing request.
export function backgroundOp(res: Response, kind: AgentJobKind, input: any, agent?: string | null): boolean {
  const job = createAgentJob({ kind, input, agent: agent ?? null });
  enqueueAgentJob((job as any).id);
  res.json({ ok: true, job });
  return true;
}
