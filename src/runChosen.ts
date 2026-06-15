// Shared agent dispatch. Run a prompt with an explicit agent, or "auto"/blank to
// use the configured rotation (round-robin / random / priority) with fallthrough
// on failure. `opts.op` labels the run for agent-stats telemetry; `opts.timeoutMs`
// lets interactive callers shorten the leash. The "auto" path records telemetry
// itself (inside runAgentWithFallback); the explicit-agent path records one row
// here, failure-safe (telemetry never breaks the loop).
//
// This lives in its own leaf module so coachOps / dayread / research can share ONE
// copy: research can't import coachOps (coachOps imports research → a cycle), and
// three drifting hand-rolled copies is exactly what this consolidates.
import * as repo from "./repo.js";
import { runAgent, runAgentWithFallback, type RunOpts } from "./agents.js";

export async function runChosen(
  agent: string | undefined,
  prompt: string,
  opts: RunOpts & { op?: string } = {}
) {
  const op = opts.op ?? "auto";
  if (!agent || agent === "auto") {
    const fb = await runAgentWithFallback(repo.pickAgentOrder(), prompt, opts);
    return { agent: fb.agent, result: fb.result, tried: fb.tried };
  }
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runAgent>> | null = null;
  try {
    result = await runAgent(agent, prompt, { timeoutMs: opts.timeoutMs });
    return { agent, result, tried: [] as { agent: string; error: string }[] };
  } finally {
    try {
      repo.recordAgentRun({
        op, agent,
        ok: !!result?.parsed,
        parsed: !!result?.parsed,
        latency_ms: Date.now() - started,
        tried_json: false,
      });
    } catch { /* telemetry never breaks the loop */ }
  }
}
