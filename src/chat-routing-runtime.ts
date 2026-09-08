// Chat provider ordering and per-attempt execution profile — the runtime plumbing around
// one chat attempt, extracted verbatim from chatTurns.ts. Which provider is tried in what
// order (selection, web preference, availability holds), what model/effort that attempt
// is pinned to, how long its leash is, and the key its telemetry is recorded under.
// The adaptive lane itself stays in chatRouting.ts; this is only how a resolved lane
// profile becomes a spawn.
//
// chatTurns.ts re-exports every public name below, so existing importers are unchanged.
import { interactiveTimeoutFor, resolveAgentExecutionProfile, type AgentDef } from "./agents.js";
import type { ChatLane, ResolvedChatProfile } from "./chatRouting.js";
import * as repo from "./repo.js";

export function cleanCliLine(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\u2022/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0]
      ?.slice(0, 220) || ""
  );
}

export function buildChatProviderOrder(
  chosen: string | null | undefined,
  autoOrder: string[],
  options: {
    preferWeb?: boolean;
    preserveSelectedFirst?: boolean;
    definitions?: Record<string, Pick<AgentDef, "web_access"> | undefined>;
  } = {}
): string[] {
  const selected = String(chosen ?? "").trim();
  const base = [...new Set([...(selected && selected !== "auto" ? [selected] : []), ...autoOrder.filter(Boolean)])];
  if (!options.preferWeb) return base;
  const web = base.filter((name) => options.definitions?.[name]?.web_access === true);
  if (!web.length) return base;
  if (options.preserveSelectedFirst && selected && selected !== "auto") {
    return [...new Set([selected, ...web, ...base])];
  }
  return [...web, ...base.filter((name) => !web.includes(name))];
}

/** Healthy providers first; anything under a live availability hold goes last. */
export function orderChatProvidersByAvailability(order: string[], now: Date = new Date()): string[] {
  if (order.length < 2) return order;
  const heldNames = new Set<string>();
  for (const name of order) {
    try {
      if (repo.getAgentAvailability(name, now)) heldNames.add(name);
    } catch {
      /* availability is advisory — an unreadable hold never reorders anything */
    }
  }
  if (!heldNames.size) return order;
  return [...order.filter((n) => !heldNames.has(n)), ...order.filter((n) => heldNames.has(n))];
}

export type RuntimeChatProfile = {
  requested: ResolvedChatProfile | null;
  effective: ResolvedChatProfile | null;
  execution: ResolvedChatProfile | null;
  unsupported: string | null;
};

export function resolveRuntimeChatProfile(
  definition: AgentDef | undefined,
  requested: ResolvedChatProfile | null,
  explicitlyBound = false
): RuntimeChatProfile {
  if (!requested) return { requested: null, effective: null, execution: null, unsupported: null };
  try {
    if (!definition) throw new Error("Unknown agent");
    const resolved = resolveAgentExecutionProfile(definition, requested);
    const effective = {
      ...(resolved.effective.model ? { model: resolved.effective.model } : {}),
      reasoning: resolved.effective.reasoning ?? requested.reasoning,
    };
    return {
      requested,
      effective,
      // Pass only capability-validated values. In particular, a legacy custom
      // provider with no profile flags runs with its own defaults.
      execution: Object.keys(resolved.effective).length ? effective : null,
      unsupported: null,
    };
  } catch (error: any) {
    return {
      requested,
      effective: null,
      execution: null,
      unsupported: explicitlyBound ? cleanCliLine(error?.message ?? error) || "Execution profile unsupported" : null,
    };
  }
}

// The leash for one chat attempt, scaled by how much thinking this turn asked for.
// A deep-lane turn runs at high effort, which a flat 90s cap can kill mid-think —
// the run then reads as a failed agent and the rotation hands a deep question to
// someone else mid-thought, which is the same silent fallthrough the job ops had.
// Waiting is the better failure mode here: chat STREAMS (the athlete watches tokens
// land, so a long turn is visibly working), every pending bubble carries a Stop, the
// turn is durable in SQLite across a reload, and a genuinely dead CLI fails at spawn
// rather than at the 90s mark. Chat's lane profile stays authoritative for
// model/effort — that is why this reads the resolved profile rather than the task
// table, where `chat` deliberately has no entry; only the timeout follows it.
// Falls back to the REQUESTED effort when `execution` is null (a provider that takes
// no profile flags, or a binding it rejected): we could not pin the effort, but the
// question was still a deep one, so the leash tracks the ambition of the turn.
export function chatTurnTimeoutMs(profile: Pick<RuntimeChatProfile, "execution" | "requested">): number {
  return interactiveTimeoutFor(profile.execution?.reasoning ?? profile.requested?.reasoning);
}

export function chatExecutionAttemptKey(
  lane: ChatLane | null,
  agent: string,
  profile: Pick<RuntimeChatProfile, "effective">
): string {
  return `${lane ?? "legacy"}\0${agent}\0${profile.effective?.model ?? ""}\0${profile.effective?.reasoning ?? "default"}`;
}
