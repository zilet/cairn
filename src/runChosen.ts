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
import {
  runAgentWithFallback,
  runAgentStreaming,
  agentSupportsStream,
  type RunOpts,
  type StreamRunOpts,
  type AgentResult,
} from "./agents.js";
import { extractMarkedJson } from "./prompt.js";
import { createJobStreamFilter } from "./jobStreamFilter.js";

// Ops that ANALYZE medical data. Faithful clinical reasoning matters more than
// spreading load, so when the user hasn't pinned an agent these default to the
// Claude-first health order (repo.pickHealthAgentOrder) instead of the round-robin
// rotation — the same principle the health-doc ingest already follows.
const HEALTH_OPS = new Set(["health_review", "health_synthesis", "marker_reconcile"]);

// Pick the default agent order for an UNPINNED op. Health ops → Claude-first health
// order; the research op → web-capable-first; everything else → the configured
// rotation. Kept pure/testable: the injected repo funcs decide the actual order.
export function defaultOrderForOp(op: string): string[] {
  if (HEALTH_OPS.has(op)) return repo.pickHealthAgentOrder();
  if (op === "research") return repo.pickResearchAgentOrder();
  return repo.pickAgentOrder();
}

// Resolve the agent ORDER for an op: an explicit/pinned agent → a one-element order,
// else the op-aware default rotation. Shared by runChosen and runChosenStreaming so
// "the first agent in the order" means the same thing to both (the streaming path only
// streams when that first agent is stream-capable).
export function resolveOrder(agent: string | undefined, op: string): string[] {
  const routed = repo.resolveAgentForTask(op, agent);
  return !routed || routed === "auto" ? defaultOrderForOp(op) : [routed];
}

export async function runChosen(
  agent: string | undefined,
  prompt: string,
  opts: RunOpts & { op?: string } = {}
) {
  const op = opts.op ?? "auto";
  // Per-task routing: when the caller left it "auto"/blank for a known task and the
  // user pinned that task to an enabled agent, run that agent. A no-op when nothing
  // is routed (the common case) — falls through to the op-aware default order.
  // BOTH paths go through runAgentWithFallback so a pinned agent gets the SAME
  // JSON-repair retry, circuit breaker, and telemetry as the rotation — a single
  // pin is just a one-element order. (resolveAgentForTask only returns a pin that's
  // already usable, so the one-element order won't be filtered out from under us.)
  // Unpinned falls to defaultOrderForOp, which routes medical-analysis ops to the
  // faithful health order and research to a web-capable-first order.
  const order = resolveOrder(agent, op);
  const fb = await runAgentWithFallback(order, prompt, opts);
  return { agent: fb.agent, result: fb.result, tried: fb.tried };
}

// Failure-safe telemetry for a streamed job-op attempt (mirrors chat's
// recordChatAttempt — the streamed path is chat-like, not the JSON-rotation path, so
// it records directly rather than through runAgentWithFallback's sink).
function recordStreamedRun(op: string, agent: string, started: number, parsed: boolean, res: AgentResult | null, error?: string): void {
  try {
    repo.recordAgentRun({
      op,
      agent,
      ok: parsed,
      parsed,
      latency_ms: Date.now() - started,
      tried_json: false,
      status: parsed ? "ok" : error ? "error" : "invalid_output",
      error_class: parsed ? null : error ? "process_error" : "invalid_json",
      error_message: error ?? (parsed ? null : "streamed reply had no parseable JSON"),
      exit_code: res?.code ?? null,
      model: res?.usage?.model ?? null,
      input_tokens: res?.usage?.input_tokens ?? null,
      output_tokens: res?.usage?.output_tokens ?? null,
    });
  } catch { /* telemetry never breaks the loop */ }
}

// Dependency seam so the fallback decision is unit-testable offline (no CLI/network,
// no dependence on the DB's enabled-agent settings). Production callers omit `deps`
// and get the real order resolution + streaming + rotation.
export interface StreamingRunDeps {
  resolveOrder?: (agent: string | undefined, op: string) => string[];
  supportsStream?: (name: string) => boolean;
  runStreaming?: (name: string, prompt: string, opts: StreamRunOpts) => Promise<AgentResult>;
  runOneShot?: typeof runChosen;
}

// Streaming sibling of runChosen for the prose-bearing job ops. When `onDelta` is
// provided AND the first agent in the (explicit or rotation) order is stream-capable
// (claude/grok), it streams: the athlete-facing prose is emitted token by token via a
// marker-aware gate (createJobStreamFilter — pre-marker narration is suppressed, the
// trailing JSON never reaches the card), and the structured JSON is re-parsed from the
// full text with extractMarkedJson. On ANY streaming failure (transport error, or a
// reply that carried no parseable JSON) — and whenever `onDelta` is absent or the first
// agent can't stream — it falls back to the ordinary one-shot runChosen rotation, which
// keeps its own JSON-repair retry + circuit breaker + telemetry. The stub and every
// non-streaming agent therefore behave byte-for-byte as today. Returns runChosen's
// { agent, result, tried } shape so callers are unchanged.
export async function runChosenStreaming(
  agent: string | undefined,
  prompt: string,
  opts: RunOpts & { op?: string; onDelta?: (chunk: string) => void } = {},
  deps: StreamingRunDeps = {}
) {
  const { onDelta, ...rest } = opts;
  const op = rest.op ?? "auto";
  const runOneShot = deps.runOneShot ?? runChosen;
  if (onDelta) {
    const supportsStream = deps.supportsStream ?? agentSupportsStream;
    const runStreaming = deps.runStreaming ?? runAgentStreaming;
    const first = (deps.resolveOrder ?? resolveOrder)(agent, op)[0];
    if (first && supportsStream(first)) {
      const gate = createJobStreamFilter(onDelta);
      const started = Date.now();
      try {
        const res = await runStreaming(first, prompt, {
          signal: rest.signal,
          timeoutMs: rest.timeoutMs,
          onDelta: gate.push,
        });
        gate.finish();
        const parsed = extractMarkedJson(res.raw);
        if (parsed && typeof parsed === "object") {
          recordStreamedRun(op, first, started, true, res);
          return { agent: first, result: { ...res, parsed }, tried: [] as { agent: string; error: string }[] };
        }
        // Ran but returned no parseable JSON → fall through to the one-shot rotation
        // (which has the JSON-repair retry the streaming path deliberately skips).
        recordStreamedRun(op, first, started, false, res);
      } catch (e: any) {
        if (rest.signal?.aborted) throw e; // a deliberate Stop — never retry elsewhere
        recordStreamedRun(op, first, started, false, null, e?.message ?? String(e));
        // transport failure → fall through to the one-shot rotation
      }
    }
  }
  return runOneShot(agent, prompt, rest);
}
