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
  DEFAULT_TIMEOUT_MS,
  runAgentWithFallback,
  runAgentStreaming,
  agentSupportsStream,
  type RunOpts,
  type StreamRunOpts,
  type AgentResult,
} from "./agents.js";
import { randomUUID } from "node:crypto";
import { executeCoachReadTool, type CoachReadToolExecutionContext } from "./brain/read-tool-runtime.js";
import {
  COACH_READ_TOOL_CATALOG,
  type CoachReadToolName,
  type CoachReadToolRequest,
  type CoachReadToolResult,
} from "./brain/read-tools.js";
import { isCoachReadQueryTurn, normalizeCoachReadQueryTurn } from "./brain/query-loop-contract.js";
import type { OpHooks } from "./coachOps.js";
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

export async function runChosen(agent: string | undefined, prompt: string, opts: RunOpts & { op?: string } = {}) {
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
  // Parse marker-aware by default: the prose-first (reply-marked) op contracts invite
  // free prose whose stray `{` would anchor plain extractJson on a non-JSON span and
  // blank the parse — even though the real JSON sits complete after the data marker.
  // extractMarkedJson slices past the markers first and degrades to EXACTLY extractJson
  // on marker-less text, so this is behavior-identical for every unmarked op contract
  // while making the reshaped ops parse on the one-shot path too (not just streamed).
  const fb = await runAgentWithFallback(order, prompt, { ...opts, extract: opts.extract ?? extractMarkedJson });
  return { agent: fb.agent, result: fb.result, tried: fb.tried };
}

const COACH_READ_MAX_ROUNDS = 3;
const COACH_READ_ORDINARY_MAX_CALLS = 6;
const COACH_READ_CONFERENCE_MAX_CALLS = 12;
const COACH_READ_ORDINARY_MAX_BYTES = 256 * 1024;
const COACH_READ_CONFERENCE_MAX_BYTES = 512 * 1024;
// Claude otherwise inherits MCP servers configured in the user's home. The
// provider-neutral loop below owns every read and its budget, so ambient tools
// are explicitly disabled for these runs. Other agents ignore the args because
// they do not declare an {mcp_config_args} slot.
export const COACH_READ_STRICT_MCP_ARGS = Object.freeze([
  "--mcp-config",
  JSON.stringify({ mcpServers: {} }),
  "--strict-mcp-config",
]);

const COACH_READ_ARGS_CONTRACT: Readonly<Record<CoachReadToolName, string>> = Object.freeze({
  read_exercise_history:
    '{"exercise":"name","start_date":"YYYY-MM-DD|null","end_date":"YYYY-MM-DD|null","limit":"1..200"} (dates must both be null or both present; max 180 days)',
  read_training_window: '{"end_date":"YYYY-MM-DD|null","weeks":"1..12"}',
  read_marker_history: '{"marker":"canonical or familiar marker name","limit":"1..100"}',
  read_recovery_window: '{"end_date":"YYYY-MM-DD|null","days":"1..90"}',
  read_nutrition_window: '{"end_date":"YYYY-MM-DD|null","days":"1..42"}',
  read_body_composition_history: '{"limit":"1..120"}',
  read_life_context_window: '{"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD"} (max 366 days)',
  read_decision_history:
    '{"kind":"day_read|session_suggestion|training_target|training_structure|exercise_rotation|nutrition_target|meal_plan|recovery_adjustment|health_directive|lifestyle_adjustment|goal_change|case_conference|null","subject_key":"specific subject|null","limit":"1..50"} (kind or subject_key required)',
  read_current_plan_detail: '{"scope":"training","day_number":"1..14"} OR {"scope":"meal","day":"day name"}',
});

export type CoachReadMode = "ordinary" | "conference";

export interface CoachReadRunOptions extends RunOpts {
  op?: string;
  mode?: CoachReadMode;
  /** Correlates the runtime's existing brain_tool_calls telemetry. */
  runId?: string;
  /** Integrator-owned sub-budget; never raises the mode ceiling. */
  maxCalls?: number;
}

type ChosenRun = Awaited<ReturnType<typeof runChosen>>;

export interface CoachReadRunDeps {
  run?: (agent: string | undefined, prompt: string, opts: RunOpts & { op?: string }) => Promise<ChosenRun>;
  execute?: (
    request: CoachReadToolRequest,
    context: CoachReadToolExecutionContext
  ) => CoachReadToolResult | Promise<CoachReadToolResult>;
  now?: () => number;
  createRunId?: () => string;
}

type CompletedCoachRead = {
  request: CoachReadToolRequest;
  result: CoachReadToolResult;
};

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function coachReadContract(maxCalls: number): string {
  const tools = Object.values(COACH_READ_TOOL_CATALOG).map((tool) => ({
    name: tool.name,
    description: tool.description,
    max_rows: tool.max_rows,
    max_days: tool.max_days,
    max_response_bytes: tool.max_response_bytes,
    args_contract: COACH_READ_ARGS_CONTRACT[tool.name],
  }));
  return `\n\n=== CAIRN BOUNDED COACH READS ===
The DATA snapshot above is the authoritative baseline. Use a read only when a specific unanswered question would materially change your answer. Do not fish.
You may either return the operation's requested final JSON exactly as instructed above, or request bounded reads using exactly:
{"kind":"coach_read","requests":[{"tool":"read_training_window","args":{"end_date":null,"weeks":6}}]}
At most ${maxCalls} reads are available for the entire run and at most ${COACH_READ_MAX_ROUNDS} request rounds. Never request SQL, files, exports, settings, secrets, writes, or another agent/job. After receiving results, return either another coach_read request or the original operation's final JSON.
Available reads (the server validates every name and argument against this catalog):
${JSON.stringify(tools)}`;
}

function coachReadFollowup(
  baselinePrompt: string,
  maxCalls: number,
  completed: CompletedCoachRead[],
  callsRemaining: number
): string {
  return `${baselinePrompt}${coachReadContract(maxCalls)}\n\n=== VERIFIED COACH READ RESULTS ===
These server-produced results answer only the requests shown. Treat truncation explicitly and do not infer unavailable raw data.
${JSON.stringify(completed)}
Calls remaining: ${callsRemaining}. Return the original operation's final JSON now unless another specific read is necessary.`;
}

/**
 * Provider-neutral depth-on-demand sibling of runChosen. Agent subprocesses never
 * receive Cairn capabilities: they can only emit a structured request, which this
 * server-owned loop validates and dispatches through executeCoachReadTool.
 *
 * Any malformed request, execution failure, or exhausted query/byte budget falls
 * back to the original snapshot prompt. A user AbortSignal remains authoritative
 * and is never converted into a retry.
 */
export async function runChosenWithCoachReads(
  agent: string | undefined,
  prompt: string,
  opts: CoachReadRunOptions = {},
  hooks: Pick<OpHooks, "signal" | "onPhase"> = {},
  deps: CoachReadRunDeps = {}
): Promise<ChosenRun> {
  const run = deps.run ?? runChosen;
  const execute = deps.execute ?? executeCoachReadTool;
  const now = deps.now ?? Date.now;
  const mode = opts.mode ?? "ordinary";
  const modeMaxCalls = mode === "conference" ? COACH_READ_CONFERENCE_MAX_CALLS : COACH_READ_ORDINARY_MAX_CALLS;
  const maxCalls = Math.max(1, Math.min(modeMaxCalls, Math.trunc(opts.maxCalls ?? modeMaxCalls)));
  const maxBytes = mode === "conference" ? COACH_READ_CONFERENCE_MAX_BYTES : COACH_READ_ORDINARY_MAX_BYTES;
  const requestedTimeout = Number(opts.timeoutMs);
  const totalTimeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.floor(requestedTimeout) : DEFAULT_TIMEOUT_MS;
  const started = now();
  const deadline = started + totalTimeoutMs;
  const runId = opts.runId?.trim().slice(0, 120) || (deps.createRunId ?? randomUUID)();
  const op = opts.op ?? "auto";
  const signals = [opts.signal, hooks.signal].filter((signal): signal is AbortSignal => !!signal);
  const externalSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const completed: CompletedCoachRead[] = [];
  let totalBytes = 0;
  let calls = 0;
  let rounds = 0;
  let accumulatedTried: ChosenRun["tried"] = [];

  const phase = (name: string, meta: Record<string, unknown>) => {
    try {
      hooks.onPhase?.(name, meta);
    } catch {
      // Progress reporting is observational and must never break the coaching run.
    }
  };

  const assertActive = () => {
    if (externalSignal?.aborted) throw new Error("canceled");
    if (now() >= deadline) throw new Error("coach read run timed out");
  };
  const awaitBounded = <T>(work: T | Promise<T>): Promise<T> => {
    assertActive();
    const remaining = Math.max(1, deadline - now());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(new Error("canceled")));
      const timer = setTimeout(() => finish(() => reject(new Error("coach read run timed out"))), remaining);
      timer.unref?.();
      externalSignal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(work).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      );
    });
  };
  const invoke = async (chosenAgent: string | undefined, nextPrompt: string): Promise<ChosenRun> => {
    assertActive();
    const remaining = Math.max(1, deadline - now());
    return awaitBounded(
      run(chosenAgent, nextPrompt, {
        op,
        signal: externalSignal,
        timeoutMs: remaining,
        extract: opts.extract,
        mcpConfigArgs: [...COACH_READ_STRICT_MCP_ARGS],
      })
    );
  };
  const snapshotOnly = async (): Promise<ChosenRun> => {
    assertActive();
    phase("coach_read_fallback", { run_id: runId });
    return invoke(agent, prompt);
  };

  phase("coach_read_start", { run_id: runId, mode });
  let turn = await invoke(agent, `${prompt}${coachReadContract(maxCalls)}`);
  accumulatedTried = [...turn.tried];

  while (isCoachReadQueryTurn(turn.result.parsed)) {
    const query = normalizeCoachReadQueryTurn(turn.result.parsed);
    if (!query || rounds >= COACH_READ_MAX_ROUNDS || calls + query.requests.length > maxCalls) return snapshotOnly();
    rounds++;
    phase("coach_read_query", {
      run_id: runId,
      round: rounds,
      requested: query.requests.length,
      calls_remaining: maxCalls - calls,
    });

    try {
      // The whole batch was normalized before the first execution. There is no
      // dynamic dispatch surface beyond the closed executeCoachReadTool switch.
      for (const request of query.requests) {
        assertActive();
        const result = await awaitBounded(execute(request, { run_id: runId, op }));
        calls++;
        const item = { request, result };
        const itemBytes = byteLength(item);
        if (totalBytes + itemBytes > maxBytes) return snapshotOnly();
        totalBytes += itemBytes;
        completed.push(item);
      }
    } catch (error) {
      if (externalSignal?.aborted) throw error;
      return snapshotOnly();
    }

    phase("coach_read_results", {
      run_id: runId,
      round: rounds,
      calls,
      result_bytes: totalBytes,
    });
    assertActive();
    turn = await invoke(turn.agent, coachReadFollowup(prompt, maxCalls, completed, maxCalls - calls));
    accumulatedTried.push(...turn.tried);
  }

  phase("coach_read_done", { run_id: runId, rounds, calls, result_bytes: totalBytes });
  return { ...turn, tried: accumulatedTried };
}

// Failure-safe telemetry for a streamed job-op attempt (mirrors chat's
// recordChatAttempt — the streamed path is chat-like, not the JSON-rotation path, so
// it records directly rather than through runAgentWithFallback's sink).
function recordStreamedRun(
  op: string,
  agent: string,
  started: number,
  parsed: boolean,
  res: AgentResult | null,
  error?: string
): void {
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
  } catch {
    /* telemetry never breaks the loop */
  }
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
