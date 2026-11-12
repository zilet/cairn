// Chat's coach reads: the contract text each transport appends to the prompt, and the
// per-turn telemetry shape. The transports themselves are src/brain/read-transport.ts
// (which CLI reads how) and src/coachReadMcp.ts (the native listener); the turn engine
// that drives them is src/chatTurns.ts.
//
// The direction (owner, 2026-11-11): the coach should LOOK things up for the question
// that comes, not carry everything in its prompt. So the lean core is what it always
// knows, and the contract tells it to read before answering when the question turns on
// something the core does not hold — and never to call data missing without reading for
// it. The "full" context keeps the original "authoritative baseline / do not fish"
// wording byte for byte (settings.chat_context), as the runtime switch back.
import { NATIVE_COACH_READ_BUDGET } from "./coachReadMcp.js";
import { COACH_READ_MAX_ROUNDS, coachReadToolList } from "./runChosen.js";
import type { CoachReadTransport } from "./brain/read-transport.js";

/** One read as a turn's telemetry keeps it: never its arguments or its result. */
export interface ChatReadCall {
  tool: string;
  ms: number;
  bytes: number;
  ok: boolean;
}

/** Stored on the assistant message's meta (`reads`) and summarized in the [coach-read] log line. */
export interface ChatReadTelemetry {
  transport: CoachReadTransport;
  calls: ChatReadCall[];
  /** Agent launches that read: prompt-loop rounds, or 1 for a native run that called anything. */
  rounds: number;
  total_bytes: number;
  /** A native attach that failed and fell back to the prompt loop on the same agent. */
  native_fallback?: boolean;
}

const CHAT_NATIVE_READ_MAX_CALLS = NATIVE_COACH_READ_BUDGET.maxCalls;

// The guidance both lean transports share: what the core is, when to read, and the two
// failure modes the owner named — answering without looking, and looking for what is
// already here. `where` is where DATA and the state blocks sit relative to the contract:
// the prompt loop's contract follows DATA ("above"); the native contract sits in the
// static head, before the state blocks and DATA ("below").
function lookItUpGuidance(where: "above" | "below"): string {
  return `DATA ${where} is the core you always have: who they are, today, and this week (plus the ids your actions name). Everything older or deeper — past sessions and how a lift has moved, trends, labs and findings, body composition, fuel and recovery history and baselines, this week's run rationale, the decision ledger — is one coach read away.
- When the question turns on a specific the core does not hold (a past session, a trend, a lab value, a number), LOOK IT UP before you answer. Answer from what the read returned.
- ${NEVER_CLAIM_MISSING} without having read for it first.
- Do not read for what the core or the blocks ${where} already answer — today's activities, today's food, this week's days are already here.`;
}

// The rule every coach/deep prompt carries exactly once. With the reads open it says to
// read first (lookItUpGuidance); once they are spent — or a lean prompt-loop turn has no
// read contract at all — it must not ask for a read the model cannot make.
const NEVER_CLAIM_MISSING = `Never say something is missing, "not visible" or "hasn't synced"`;

/**
 * The lean prompt loop's suffix once its reads are used up (or dropped after a malformed
 * request): the read contract goes, so the never-claim-missing rule rides alone, in its
 * no-reads form.
 */
export function chatLeanNoReadsRule(): string {
  return `\n\n=== NO MORE READS THIS TURN ===
- ${NEVER_CLAIM_MISSING} without it being absent from DATA and the blocks in this prompt. Reply now with what you have.`;
}

/** The lean prompt-loop contract: the guidance plus the bare-JSON read protocol. */
export function chatLeanPromptLoopContract(maxCalls: number): string {
  return `\n\n=== COACH READS: LOOK IT UP ===
${lookItUpGuidance("above")}
To look something up, return ONLY this JSON object this turn — no reply marker, no prose, nothing else:
{"kind":"coach_read","requests":[{"tool":"read_training_window","args":{"end_date":null,"weeks":6}}]}
Several reads may go in one request. The server runs them and calls you again with the verified results; THEN write your normal reply using the OUTPUT CONTRACT above (the reply marker, then prose). When the core already answers, just reply now.
At most ${maxCalls} reads across at most ${COACH_READ_MAX_ROUNDS} rounds. Never request SQL, files, exports, settings, secrets, writes, or another agent/job.
Available reads (the server validates every name and argument against this catalog):
${JSON.stringify(coachReadToolList())}`;
}

/**
 * The native contract: plain tool-use guidance, no JSON protocol. The CLI already
 * receives every tool's description and argument schema over MCP, so the prompt names
 * the tools and states only what the descriptions do not: the budget, when to read, and
 * never to call something missing without reading. It sits in the prompt's static head
 * (after the OUTPUT CONTRACT, before the state blocks and DATA), so the bytes ahead of
 * the turn's volatile blocks are the same every turn.
 */
export function chatNativeReadContract(maxCalls = CHAT_NATIVE_READ_MAX_CALLS): string {
  const tools = coachReadToolList()
    .map((tool) => tool.name)
    .join(", ");
  return `\n\n=== COACH READS: YOUR TOOLS ===
${lookItUpGuidance("below")}
Your tools on this run are Cairn's read-only coach reads (and nothing else): ${tools}. Call them directly — several at once when the question needs several — then write your reply using the OUTPUT CONTRACT above: the reply marker, then prose. Never narrate the lookups to the athlete and never paste a read's raw result; the reply starts at the marker.
At most ${maxCalls} reads for this reply; past that a read returns an error — then answer with what you have.`;
}

export function emptyChatReadTelemetry(transport: CoachReadTransport): ChatReadTelemetry {
  return { transport, calls: [], rounds: 0, total_bytes: 0 };
}

/** One log line, no athlete text: the transport, the counts, and the tool names. */
export function chatReadLogLine(turnId: number, reads: ChatReadTelemetry, promptBytes: number | null): string {
  const tools = reads.calls.map((call) => `${call.tool}${call.ok ? "" : "!"}`).join(",");
  return `[coach-read] turn#${turnId} transport=${reads.transport}${reads.native_fallback ? " (native attach failed, prompt loop)" : ""} calls=${reads.calls.length} rounds=${reads.rounds} bytes=${reads.total_bytes} prompt_bytes=${promptBytes ?? "?"}${tools ? ` tools=${tools}` : ""}`;
}
