// The loopback MCP adapter for the coach read catalog — the NATIVE coach-read transport
// (src/brain/read-transport.ts). A chat turn on a CLI whose agents.json `read_tools`
// declares `native_mcp` (claude, codex — verified live 2026-11-11) starts one listener
// for the run: loopback-only bind, a random per-run path carrying a 24-byte token
// distinct from CAIRN_AUTH_TOKEN, the closed read-only catalog and nothing else. The
// CLI calls the reads itself inside ONE process (several calls, parallel allowed), and
// the budget is enforced HERE, server-side: a call past the cap, or one whose result
// would cross the per-call or total byte budget, gets a plain tool error telling the
// model to answer with what it has. Every call is recorded {tool, args_digest, ms,
// bytes, ok} — never its arguments or its result. The listener is closed in the turn's
// `finally` and on the turn's AbortSignal; a TTL backstops both.
//
// CLIs that cannot attach a per-run server safely (grok, agy) keep the provider-neutral
// prompt loop over the SAME catalog (src/runChosen.ts, src/chatTurns.ts).
import crypto from "node:crypto";
import http from "node:http";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  CoachReadToolExecutionError,
  executeCoachReadTool,
  type CoachReadToolExecutionContext,
} from "./brain/read-tool-runtime.js";
import { COACH_READ_TOOL_CATALOG, type CoachReadToolName, type CoachReadToolResult } from "./brain/read-tools.js";
import { log } from "./log.js";
import { COACH_READ_ORDINARY_MAX_BYTES, COACH_READ_ORDINARY_MAX_CALLS } from "./runChosen.js";
import { telemetryErrorName } from "./telemetry-privacy.js";

type ToolRegistrar = Pick<McpServer, "tool">;

const nullableDate = z.string().nullable().optional();
const SCHEMAS: Record<CoachReadToolName, any> = {
  read_exercise_history: {
    exercise: z.string().min(1).max(160),
    start_date: nullableDate,
    end_date: nullableDate,
    limit: z.number().int().min(1).max(200).optional(),
  },
  read_training_window: { end_date: nullableDate, weeks: z.number().int().min(1).max(12).optional() },
  read_marker_history: { marker: z.string().min(1).max(160), limit: z.number().int().min(1).max(100).optional() },
  read_recovery_window: { end_date: nullableDate, days: z.number().int().min(1).max(90).optional() },
  read_nutrition_window: { end_date: nullableDate, days: z.number().int().min(1).max(42).optional() },
  read_body_composition_history: { limit: z.number().int().min(1).max(120).optional() },
  read_life_context_window: { start_date: z.string(), end_date: z.string() },
  read_decision_history: {
    kind: z.string().nullable().optional(),
    subject_key: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  read_current_plan_detail: {
    scope: z.enum(["training", "meal"]),
    day_number: z.number().int().min(1).max(14).optional(),
    day: z.string().optional(),
  },
  read_activity_detail: { activity_id: z.number().int().min(1) },
  // The no-argument reads: the current picture of one domain each.
  read_run_week: {},
  read_health_summary: {},
  read_strength_progress: {},
  read_goal_progress: {},
  read_today_session: { date: nullableDate },
};

// Every tool here only reads, and only Cairn's own store.
const READ_ONLY_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

/** One native read call as the turn's telemetry records it. Never its arguments or result. */
interface CoachReadCallRecord {
  tool: string;
  /** sha256 of the canonical arguments, 12 hex chars: tells repeats apart, reveals nothing. */
  args_digest: string;
  ms: number;
  /** Result bytes handed to the CLI (0 when refused). */
  bytes: number;
  ok: boolean;
  refused?: "call_budget" | "byte_budget" | "invalid_request" | "execution_failed";
}

interface CoachReadMcpBudget {
  maxCalls: number;
  maxTotalBytes: number;
  maxCallBytes: number;
}

// Native reads cost no re-launch, so the call cap is twice the prompt loop's six; the
// total stays the prompt loop's 256 KB (what a turn may pull in, however it travels),
// and no single call may exceed the catalog's own largest response budget.
export const NATIVE_COACH_READ_BUDGET: Readonly<CoachReadMcpBudget> = Object.freeze({
  maxCalls: 2 * COACH_READ_ORDINARY_MAX_CALLS,
  maxTotalBytes: COACH_READ_ORDINARY_MAX_BYTES,
  maxCallBytes: Math.max(...Object.values(COACH_READ_TOOL_CATALOG).map((tool) => tool.max_response_bytes)),
});

/**
 * The per-run budget gate every registered tool shares. Stateless MCP requests each build
 * a fresh server, so the count and the byte total live here, on the listener.
 */
interface CoachReadGate {
  readonly budget: CoachReadMcpBudget;
  calls: CoachReadCallRecord[];
  totalBytes: number;
  /** MCP requests the listener received at all (an attach that never connected has 0). */
  requests: number;
}

export function createCoachReadGate(budget: Partial<CoachReadMcpBudget> = {}): CoachReadGate {
  return {
    budget: { ...NATIVE_COACH_READ_BUDGET, ...budget },
    calls: [],
    totalBytes: 0,
    requests: 0,
  };
}

function argsDigest(args: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
          )
        : value;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(args ?? {})) ?? "")
    .digest("hex")
    .slice(0, 12);
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

const CALL_BUDGET_TEXT =
  "Read budget for this reply is spent. Do not call more reads: answer now with what you already have, and say plainly if something you would have checked is missing.";
const BYTE_BUDGET_TEXT =
  "That read's result is larger than this reply's remaining read budget, so it was not returned. Do not retry it: answer with what you have, or ask a narrower read (a shorter window or one exercise or marker) once.";
const INVALID_TEXT =
  "Those arguments are outside this read's contract (dates YYYY-MM-DD, windows within their limits). Fix them once, or answer with what you have.";
const FAILED_TEXT = "That read failed on the server. Answer with what you have and do not retry it.";

/**
 * Run one native read through the gate: reserve a call slot BEFORE executing (so a
 * burst of parallel calls cannot overshoot the cap), execute through the closed
 * runtime, then hold the result to the per-call and total byte budget.
 */
export function gatedCoachRead(
  gate: CoachReadGate,
  name: CoachReadToolName,
  args: unknown,
  context: CoachReadToolExecutionContext,
  execute: (request: unknown, context: CoachReadToolExecutionContext) => CoachReadToolResult = executeCoachReadTool
) {
  const started = performance.now();
  const record = (bytes: number, ok: boolean, refused?: CoachReadCallRecord["refused"]) => {
    gate.calls.push({
      tool: name,
      args_digest: argsDigest(args),
      ms: Math.round(performance.now() - started),
      bytes,
      ok,
      ...(refused ? { refused } : {}),
    });
  };
  const used = gate.calls.length;
  if (used >= gate.budget.maxCalls) {
    record(0, false, "call_budget");
    return toolError(CALL_BUDGET_TEXT);
  }
  // Reserve this call's slot now; the record below replaces the placeholder.
  const placeholder: CoachReadCallRecord = { tool: name, args_digest: argsDigest(args), ms: 0, bytes: 0, ok: false };
  gate.calls.push(placeholder);
  const settle = (bytes: number, ok: boolean, refused?: CoachReadCallRecord["refused"]) => {
    placeholder.ms = Math.round(performance.now() - started);
    placeholder.bytes = bytes;
    placeholder.ok = ok;
    if (refused) placeholder.refused = refused;
  };
  let result: CoachReadToolResult;
  try {
    result = execute({ tool: name, args: args ?? {} }, context);
  } catch (error) {
    const invalid = error instanceof CoachReadToolExecutionError && error.code === "invalid_request";
    settle(0, false, invalid ? "invalid_request" : "execution_failed");
    return toolError(invalid ? INVALID_TEXT : FAILED_TEXT);
  }
  const text = JSON.stringify(result);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > gate.budget.maxCallBytes || gate.totalBytes + bytes > gate.budget.maxTotalBytes) {
    settle(0, false, "byte_budget");
    return toolError(BYTE_BUDGET_TEXT);
  }
  gate.totalBytes += bytes;
  settle(bytes, true);
  return { content: [{ type: "text" as const, text }] };
}

export function registerCoachReadTools(
  server: ToolRegistrar,
  context: CoachReadToolExecutionContext,
  gate?: CoachReadGate
): void {
  for (const name of Object.keys(COACH_READ_TOOL_CATALOG) as CoachReadToolName[]) {
    const tool = COACH_READ_TOOL_CATALOG[name];
    server.tool(name, tool.description, SCHEMAS[name], READ_ONLY_ANNOTATIONS, async (args: any) =>
      gate ? gatedCoachRead(gate, name, args, context) : asText(executeCoachReadTool({ tool: name, args } as any, context))
    );
  }
}

function buildCoachReadMcpServer(context: CoachReadToolExecutionContext, gate?: CoachReadGate): McpServer {
  const server = new McpServer({ name: "cairn-coach-read", version: "1.0.0" });
  registerCoachReadTools(server, context, gate);
  return server;
}

export interface CoachReadMcpListener {
  url: string;
  token: string;
  /** The run's budget gate: every call recorded so far, and the bytes handed out. */
  gate: CoachReadGate;
  /**
   * Restart the TTL backstop from now (clamped like the first one). The chat turn calls
   * it when its CLI run takes its spawn permit, so a long queue wait never eats the time
   * the run itself has to call the reads.
   */
  rearm(ttlMs: number): void;
  close(): Promise<void>;
}

// The TTL backstop's bounds: never under a second, never past half an hour (a chat turn's
// longest leash is the 10-minute default, and the first TTL also covers a permit wait).
const COACH_READ_LISTENER_MAX_TTL_MS = 30 * 60_000;
export function clampListenerTtl(ttlMs: number | undefined): number {
  return Math.max(1_000, Math.min(COACH_READ_LISTENER_MAX_TTL_MS, Math.trunc(Number(ttlMs) || 120_000)));
}

/** Claude CLI argv for one capability-scoped run. Strict mode prevents ambient
 * MCP configuration from widening the closed read-only surface. The live chat path
 * builds its argv from agents.json `read_tools.attach_args` (src/brain/read-transport.ts);
 * this stays as the minimal form for callers outside chat. */
export function coachReadMcpConfigArgs(listener: Pick<CoachReadMcpListener, "url">): string[] {
  return [
    "--mcp-config",
    JSON.stringify({ mcpServers: { "cairn-coach-read": { type: "http", url: listener.url } } }),
    "--strict-mcp-config",
  ];
}

export async function startCoachReadMcpListener(opts: {
  run_id: string;
  op?: string;
  ttlMs?: number;
  signal?: AbortSignal;
  budget?: Partial<CoachReadMcpBudget>;
}): Promise<CoachReadMcpListener> {
  const token = crypto.randomBytes(24).toString("base64url");
  const gate = createCoachReadGate(opts.budget);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  const path = `/mcp/${token}`;
  app.post(path, async (req: Request, res: Response) => {
    gate.requests++;
    const server = buildCoachReadMcpServer(
      {
        run_id: String(opts.run_id).slice(0, 120),
        op: opts.op ?? "coach_read_mcp",
      },
      gate
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // The read-only loop's own transport. Name the failure so an operator can tell a
      // dead loop from a quiet one; the payload carries athlete text, so only the error
      // name travels.
      log.warn(`[coach-read] MCP transport failed (${telemetryErrorName(err)})`);
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  // Stateless server: no standalone SSE stream and no session to end. The spec's answer
  // is 405, which a client reads as "POST only" rather than as a dead server.
  app.all(path, (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });
  app.use((_req, res) => res.status(404).end());

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("coach read listener did not acquire a loopback port");
  }
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const onAbort = () => {
    void close();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    opts.signal?.removeEventListener("abort", onAbort);
    // A CLI killed mid-call can leave a keep-alive socket open; close() alone would wait
    // for it, so drop idle and live connections with the server.
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  if (opts.signal?.aborted) {
    await close();
    throw new Error("canceled");
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const arm = (ttlMs: number | undefined) => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void close();
    }, clampListenerTtl(ttlMs));
    timer.unref?.();
  };
  arm(opts.ttlMs);
  return { url: `http://127.0.0.1:${address.port}${path}`, token, gate, rearm: arm, close };
}
