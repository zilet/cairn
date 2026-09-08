// Shared plumbing for the coaching ops: the agent connect/visibility reads, the
// OpHooks phase channel every op reports through, and the self-critique verify
// pass (whose deterministic numeric precheck WINS over an agent's ok:true).
// Split out of the former single-file src/coachOps.ts — behavior-preserving.

import { getAgentConfig, interactiveTimeoutForOp } from "../repo/settings.js";
import type { FloorPrecheck, FloorViolation } from "../repo/verify-floors.js";
import { AgentFallbackError, agentInfo, listAgentModels, loadAgents } from "../agents.js";
import type { JsonSchema } from "../json-schema.js";
import { runChosen } from "../runChosen.js";
import { isVerifyResult, verifyResultSchema } from "../agent-contracts.js";

// runChosen is the shared agent-dispatch helper (see ./runChosen.ts). It's
// re-exported here because api.ts / mcp.ts import it from coachOps as the
// single agentic-ops entry point.
export { runChosen };

// "What's running" for one agent: installed version + best-effort current model.
// ok:false (at the adapter's HTTP 200) for an unknown agent.
export function agentInfoOp(name: string) {
  if (!loadAgents()[name]) return { ok: false as const, error: `unknown agent "${name}"` };
  const info = agentInfo(name);
  return { ok: true as const, ...info };
}

// A CLI's model catalog (grok/agy). Empty list for a CLI with no `models_list`
// or on any probe failure; ok:false only for an unknown agent.
export function agentModelsOp(name: string) {
  if (!loadAgents()[name]) return { ok: false as const, error: `unknown agent "${name}"`, models: [] as string[] };
  return { ok: true as const, models: listAgentModels(name) };
}

// Agent-status contract (v35) — a calm, additive provenance hint the PWA reads to
// distinguish "no coaching CLI is configured" from "an agent was tried and failed"
// from a real agentic result. NEVER changes existing fields; it's a sidecar string.
//   'unconfigured' — repo.pickAgentOrder() is empty (no usable agent installed/enabled)
//   'all_failed'   — agents WERE available but every attempt failed (fell to the floor)
//   'ok'           — an agent produced the result
// A `result` carries `source`/`agent`/`tried`/`ok` from the op; any subset is fine.
export function agentStatusFor(
  result: {
    source?: string | null;
    agent?: string | null;
    ok?: boolean;
    tried?: { agent: string; error: string }[] | null;
  } = {}
): "ok" | "unconfigured" | "all_failed" {
  let configured = true;
  try {
    // The USABLE set, read without rotating: this is a status question asked on every
    // GET /today-read, and pickAgentOrder() persists a new `rr_cursor` under the
    // round-robin strategy — a read path writing settings, which used to expire the
    // whole coach-context memo on every Brief open. Same predicate, no side effect
    // (the same read src/dayread-refresh.ts already uses for its side-effect-free gate).
    configured = getAgentConfig().some((a) => a.usable);
  } catch {
    configured = true;
  }
  if (!configured) return "unconfigured";
  // An agentic result is one that came from an agent (source === 'agent') or that
  // succeeded (ok !== false with a chosen agent). The deterministic floor / a
  // failed op means every available attempt failed.
  const agentic =
    result.source === "agent" || (result.ok !== false && !!result.agent && result.source !== "deterministic");
  return agentic ? "ok" : "all_failed";
}

// Optional hooks the durable agent-job worker threads into a backgrounded op:
// `signal` lets a Stop SIGKILL the live subprocess (through runChosen→runAgent),
// `onPhase` reports real progress to the job bus. ADDITIVE — when both are
// omitted (every existing caller: REST inline path, MCP, scheduler), behavior is
// byte-for-byte unchanged. The hooks default to no-ops.
export interface OpHooks {
  signal?: AbortSignal;
  onPhase?: (phase: string, meta?: any) => void;
  // Live prose tokens for the four prose-bearing ops (synthesis / session-suggest /
  // nutrition check-in / weekly read), streamed into the waiting card. The agent-job
  // worker wires this to a `delta` bus event; every other caller omits it, so those
  // ops run exactly as before (runChosenStreaming with no onDelta === runChosen).
  onDelta?: (chunk: string) => void;
}

// Exported only so the sibling coachOps/* domain modules can share it; not part
// of the intended public surface (it was file-private before the split).
export function agentFailure(error: unknown, hooks?: OpHooks): { agent: null; tried: { agent: string; error: string }[] } {
  // A user Stop is control flow, not graceful degradation: preserve cancellation
  // so the durable job worker can mark the operation canceled instead of failed.
  if (hooks?.signal?.aborted) throw error;
  return {
    agent: null,
    tried: error instanceof AgentFallbackError ? error.tried : [],
  };
}

// ---------- self-critique verify pass (Trust build V1) ----------
// Check a just-produced high-stakes draft against its HARD floors/constraints and
// apply a fix. TWO stages, in this order:
//
//   1. A DETERMINISTIC pre-check (`src/repo/verify-floors.ts`) computes every
//      numeric floor breach from the server's own figures. This used to be the
//      model's job, which made it an agent turn whose inputs fully determined its
//      output — and one that could disagree with the server's own arithmetic.
//   2. A bounded agent turn that REPAIRS those findings and makes the checks only
//      a model can make (injury-area contraindication, dietary/timing fit against
//      the athlete's own words, encoding integrity in its own repair). Its
//      contract is unchanged: { ok, violations:[], fixed_draft? }.
//
// THE PRE-CHECK WINS. An `ok:true` verdict over an unrepaired breach is not
// accepted: the repair is asked for once more, and if the breach still stands it
// is SURFACED on the outcome (`unresolved`) rather than shipped as "checked, all
// clear". A downstream hard gate may still reject the draft outright — for the
// meal plan that is `validateMealPlanDraftForPersistence`.
//
// THE AGENT TURN IS SKIPPED when the pre-check finds no breach AND no judgement
// check applies (no injuries, constraint notes, equipment/constraint text,
// dietary declarations or health context on file). The draft is then genuinely
// fully checked by the server, so it reports `by:"server"` and costs nothing.
//
// FAIL-OPEN is preserved: any agent failure (down, unparseable, wrong shape)
// returns the ORIGINAL DRAFT UNCHANGED, i.e. a verify that dies still ships the
// unchecked draft, and nothing is ever reported as `checked:true` on that path.
// The pre-check itself is try/caught to the same effect, except that an unreadable
// pre-check keeps the agent turn rather than skipping it — failing toward MORE
// checking, never less.
//
// What a failure no longer does is THROW AWAY THE SERVER'S OWN ARITHMETIC. When
// the pre-check had already found breaches and the agent turn then died, the
// outcome carries `{ checked: false, by: "server", unresolved: [...] }` instead of
// null: the draft still ships (fail-open), but the athlete is told which floor is
// over rather than being shown a plan whose breach only the server ever knew
// about. `verified` stays null when there was nothing for the server to say.
export interface VerifyOutcome<T> {
  draft: T;
  verified: {
    // TRUE only when a check actually completed. False means the agent turn never
    // produced a usable verdict and the fields below are the server's half alone.
    checked: boolean;
    adjustments: string[];
    // Who did the checking: "server" when the deterministic pass is the only thing
    // that spoke (a skipped turn, or a failed one), "agent" when a turn completed.
    by: "server" | "agent";
    // Deterministic breaches still standing. Present only when non-empty; a
    // surfaced breach is never silently shipped as clean.
    unresolved?: string[];
  } | null;
}

function verifyPrecheck<T>(precheck: (d: T) => FloorPrecheck, draft: T): FloorPrecheck {
  try {
    return precheck(draft);
  } catch {
    // An unreadable pre-check must not look like "no violations, nothing to
    // judge" — that would silently skip the whole backstop. Keep the agent turn.
    return { violations: [], judgment_applies: true, judgment_reasons: ["floor pre-check unavailable"] };
  }
}

// Exported for a focused boundary test: the pre-check-wins rule is the whole
// point of the two-stage pass, and it can only be proven with an agent that
// answers "ok:true" over a real breach.
export async function runVerify<T>(
  agent: string | undefined,
  draft: T,
  precheck: (d: T) => FloorPrecheck,
  buildPrompt: (d: T, violations: FloorViolation[]) => string,
  validate: (fixed: any) => boolean,
  op: string,
  hooks?: OpHooks,
  // The DRAFT's own schema. `fixed_draft` carries a whole corrected draft, and an
  // unnamed object node there would be gutted by constrained decoding — so the verify
  // contract is built per draft shape from the same artifact the drafting run enforced.
  draftSchema?: JsonSchema
): Promise<VerifyOutcome<T>> {
  const pre = verifyPrecheck(precheck, draft);
  if (!pre.violations.length && !pre.judgment_applies) {
    // Fully answered by the server. No prompt, no spend, no model discretion.
    return { draft, verified: { checked: true, adjustments: [], by: "server" } };
  }
  // The fail-open outcome. The draft is untouched either way; the difference is
  // whether the server has something true to say about it that the dead agent
  // turn would otherwise have taken down with it.
  const failOpen = (): VerifyOutcome<T> =>
    pre.violations.length
      ? {
          draft,
          verified: {
            checked: false,
            adjustments: [],
            by: "server",
            unresolved: pre.violations.map((v) => v.message),
          },
        }
      : { draft, verified: null };
  try {
    const askAgent = async (current: T, violations: FloorViolation[]) => {
      const { result } = await runChosen(agent, buildPrompt(current, violations), {
        op,
        timeoutMs: interactiveTimeoutForOp(op),
        signal: hooks?.signal,
        acceptParsed: (parsed) => isVerifyResult(parsed, validate),
        schema: draftSchema ? verifyResultSchema(draftSchema) : undefined,
      });
      return result.parsed as any;
    };
    const readViolations = (v: any): string[] =>
      Array.isArray(v?.violations)
        ? v.violations.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 240))
        : [];

    let current = draft;
    let adjustments: string[] = [];
    let remaining = pre.violations;
    // Two turns at most: the repair, then ONE re-repair when the deterministic
    // pass says the breach still stands (including when the model claimed ok:true
    // over it — the pre-check, not the model, decides whether a floor is honored).
    for (let attempt = 0; attempt < 2; attempt++) {
      const v = await askAgent(current, remaining);
      if (!v || typeof v !== "object") return failOpen();
      if (v.ok === false && v.fixed_draft && typeof v.fixed_draft === "object" && validate(v.fixed_draft)) {
        current = v.fixed_draft as T;
        adjustments = [...new Set([...adjustments, ...readViolations(v)])];
      } else if (v.ok !== true) {
        // Defensive only: acceptParsed rejects this before rotation stops. Never
        // show "checked" for a malformed verdict or an unusable fix — but the
        // server's own findings survive the failure.
        return failOpen();
      }
      remaining = verifyPrecheck(precheck, current).violations;
      if (!remaining.length) break;
    }
    if (current === draft && !adjustments.length && !remaining.length) {
      return { draft, verified: { checked: true, adjustments: [], by: "agent" } };
    }
    return {
      draft: current,
      verified: {
        checked: true,
        adjustments: adjustments.length || current === draft ? adjustments : ["adjusted to honor your floors"],
        by: "agent",
        ...(remaining.length ? { unresolved: remaining.map((r) => r.message) } : {}),
      },
    };
  } catch (error) {
    // A failed verifier is deliberately fail-open, but a user-initiated Stop is
    // not an agent-quality failure. Preserve cancellation all the way to the
    // request/job boundary so we never persist work the athlete canceled.
    if (hooks?.signal?.aborted) throw error;
    // Verify unavailable → ship the draft (graceful degrade), carrying whatever
    // the deterministic pass already established about it.
    return failOpen();
  }
}
