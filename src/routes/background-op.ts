import type { Response } from "express";
import { enqueueAgentJob } from "../agentJobs.js";
import type { AgentJobKind } from "../agentJobKinds.js";
import { createAgentJob, getSettings } from "../domain/person/index.js";

// Heavy agentic ops are durable background jobs by default. When the Settings
// safety valve is off, callers run their legacy inline path unchanged.
export function backgroundOp(res: Response, kind: AgentJobKind, input: any, agent?: string | null): boolean {
  if (!getSettings().bg_ops_enabled) return false;
  const job = createAgentJob({ kind, input, agent: agent ?? null });
  enqueueAgentJob((job as any).id);
  res.json({ ok: true, job });
  return true;
}
