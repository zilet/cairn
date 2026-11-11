// ---------- coach read transports: one abstraction, two ways in ----------
// The closed coach-read catalog (./read-tools.ts, executed by ./read-tool-runtime.ts)
// reaches a coaching CLI one of two ways:
//
//   native_mcp  — the CLI calls the reads ITSELF, inside one process, over a per-run
//                 loopback MCP server (src/coachReadMcp.ts). Several calls, parallel
//                 allowed, budget enforced by the listener. No re-launch per round.
//   prompt_loop — the provider-neutral protocol: the CLI answers with a bare
//                 {"kind":"coach_read",…} object, the server runs the reads and
//                 re-launches it with the verified results (src/runChosen.ts,
//                 src/chatTurns.ts). Works for every CLI; costs a launch per round.
//
// WHICH one a CLI gets is config, never code: agents.json `read_tools` (verified live,
// with the CLI version and date it was proven on). Callers ask this module for the
// transport and for the launch extras; nothing outside it branches on an agent's name.
import { loadAgents, type AgentDef, type AgentReadToolsDef } from "../agents.js";
import { COACH_READ_TOOL_NAMES, type CoachReadToolName } from "./read-tools.js";

export type CoachReadTransport = "native_mcp" | "prompt_loop";

export interface ResolvedCoachReadTransport {
  transport: CoachReadTransport;
  /** Present only for a native transport: the declared attach templates. */
  spec: AgentReadToolsDef | null;
}

const PROMPT_LOOP: ResolvedCoachReadTransport = Object.freeze({ transport: "prompt_loop", spec: null });

// A native declaration is honoured only when it is complete: a transport with no attach
// args would launch the CLI with nothing to call, which is the prompt loop with extra
// steps and none of its protocol.
function nativeSpec(def: Pick<AgentDef, "read_tools"> | undefined): AgentReadToolsDef | null {
  const spec = def?.read_tools;
  if (!spec || spec.transport !== "native_mcp") return null;
  if (!Array.isArray(spec.attach_args) || !spec.attach_args.length) return null;
  if (!spec.attach_args.every((arg) => typeof arg === "string")) return null;
  if (!spec.attach_args.some((arg) => arg.includes("{mcp_url}"))) return null;
  return spec;
}

/** The transport an agent's coach reads travel over. Unknown agent or no declaration ⇒ prompt_loop. */
export function resolveCoachReadTransport(
  agentName: string,
  definitions: Record<string, Pick<AgentDef, "read_tools"> | undefined> = loadAgents()
): ResolvedCoachReadTransport {
  const spec = nativeSpec(definitions?.[agentName]);
  return spec ? { transport: "native_mcp", spec } : PROMPT_LOOP;
}

/** True when this agent reads natively. A pure predicate over agents.json for the routing policy. */
export function agentReadsNatively(
  agentName: string,
  definitions?: Record<string, Pick<AgentDef, "read_tools"> | undefined>
): boolean {
  return resolveCoachReadTransport(agentName, definitions).transport === "native_mcp";
}

// The listener's URL shape (src/coachReadMcp.ts): loopback, a random port, a per-run
// base64url token. Anything else is refused before it can reach an argv template — the
// URL is substituted inside a JSON string (claude) and a TOML string (codex), so a quote
// or a backslash in it would change what the CLI is configured with.
const LOOPBACK_MCP_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp\/[A-Za-z0-9_-]{16,128}$/;

export function isLoopbackCoachReadUrl(url: string): boolean {
  return LOOPBACK_MCP_URL.test(String(url ?? ""));
}

/** How this CLI names the given reads, comma-joined, for `{allowed_tools}`. */
export function coachReadAllowedTools(
  spec: Pick<AgentReadToolsDef, "allowed_tool_template">,
  tools: readonly CoachReadToolName[] = COACH_READ_TOOL_NAMES
): string {
  const template = spec.allowed_tool_template || "{tool}";
  return tools.map((tool) => template.replaceAll("{tool}", tool)).join(",");
}

/**
 * The argv a native run attaches at the agent's `{mcp_config_args}` slot. Throws on a
 * URL that is not this process's own loopback listener — the caller treats that as an
 * attach failure and falls back to the prompt loop.
 */
export function expandCoachReadAttachArgs(
  spec: AgentReadToolsDef,
  opts: { url: string; tools?: readonly CoachReadToolName[] }
): string[] {
  if (!isLoopbackCoachReadUrl(opts.url)) throw new Error("coach read attach refused a non-loopback URL");
  const allowed = coachReadAllowedTools(spec, opts.tools ?? COACH_READ_TOOL_NAMES);
  return (spec.attach_args ?? []).map((arg) => arg.replaceAll("{mcp_url}", opts.url).replaceAll("{allowed_tools}", allowed));
}

/**
 * What a run over this transport adds to its launch: the attach argv (native only) and
 * the tool policy (`coach_reads` for native — COACH_READS_PREAMBLE, never NO_TOOLS_PREAMBLE).
 * The prompt loop adds nothing: it is a prompt protocol, and the CLI's own tools stay off.
 */
export function coachReadLaunchExtras(
  resolved: ResolvedCoachReadTransport,
  opts: { url?: string; tools?: readonly CoachReadToolName[] } = {}
): { mcpConfigArgs?: string[]; tools?: "coach_reads" } {
  if (resolved.transport !== "native_mcp" || !resolved.spec) return {};
  if (!opts.url) throw new Error("a native coach read needs its listener URL");
  return {
    mcpConfigArgs: expandCoachReadAttachArgs(resolved.spec, { url: opts.url, tools: opts.tools }),
    tools: "coach_reads",
  };
}
