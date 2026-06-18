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
import { runAgentWithFallback, type RunOpts } from "./agents.js";

export async function runChosen(
  agent: string | undefined,
  prompt: string,
  opts: RunOpts & { op?: string } = {}
) {
  const op = opts.op ?? "auto";
  // Per-task routing: when the caller left it "auto"/blank for a known task and the
  // user pinned that task to an enabled agent, run that agent. A no-op when nothing
  // is routed (the common case) — falls through to the rotation.
  const routed = repo.resolveAgentForTask(op, agent);
  // BOTH paths go through runAgentWithFallback so a pinned agent gets the SAME
  // JSON-repair retry, circuit breaker, and telemetry as the rotation — a single
  // pin is just a one-element order. (resolveAgentForTask only returns a pin that's
  // already usable, so the one-element order won't be filtered out from under us.)
  const order = !routed || routed === "auto" ? repo.pickAgentOrder() : [routed];
  const fb = await runAgentWithFallback(order, prompt, opts);
  return { agent: fb.agent, result: fb.result, tried: fb.tried };
}
