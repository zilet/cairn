// OPTIONAL loopback MCP adapter for the coach read catalog (ELITE-BRAIN Wave 5's
// second adapter). Fully built and covered by tests (loopback-only bind, random
// per-run path + 24-byte token distinct from CAIRN_AUTH_TOKEN, strict-MCP config)
// but NOT yet the live path: every production coach-read run uses the
// provider-neutral bounded query loop in src/runChosen.ts. Wire this only for a
// CLI that supports safe per-run MCP configuration (Claude's --strict-mcp-config)
// once the query loop's telemetry says tool-call latency justifies it.
import crypto from "node:crypto";
import http from "node:http";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { executeCoachReadTool, type CoachReadToolExecutionContext } from "./brain/read-tool-runtime.js";
import { COACH_READ_TOOL_CATALOG, type CoachReadToolName } from "./brain/read-tools.js";

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
};

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerCoachReadTools(server: ToolRegistrar, context: CoachReadToolExecutionContext): void {
  for (const name of Object.keys(COACH_READ_TOOL_CATALOG) as CoachReadToolName[]) {
    const tool = COACH_READ_TOOL_CATALOG[name];
    server.tool(name, tool.description, SCHEMAS[name], async (args: any) =>
      asText(executeCoachReadTool({ tool: name, args } as any, context))
    );
  }
}

export function buildCoachReadMcpServer(context: CoachReadToolExecutionContext): McpServer {
  const server = new McpServer({ name: "cairn-coach-read", version: "1.0.0" });
  registerCoachReadTools(server, context);
  return server;
}

export interface CoachReadMcpListener {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Claude CLI argv for one capability-scoped run. Strict mode prevents ambient
 * MCP configuration from widening the nine-tool read-only surface. */
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
}): Promise<CoachReadMcpListener> {
  const token = crypto.randomBytes(24).toString("base64url");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  const path = `/mcp/${token}`;
  app.post(path, async (req: Request, res: Response) => {
    const server = buildCoachReadMcpServer({
      run_id: String(opts.run_id).slice(0, 120),
      op: opts.op ?? "coach_read_mcp",
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
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
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const ttl = Math.max(1_000, Math.min(10 * 60_000, Math.trunc(opts.ttlMs ?? 120_000)));
  timer = setTimeout(() => {
    void close();
  }, ttl);
  timer.unref?.();
  return { url: `http://127.0.0.1:${address.port}${path}`, token, close };
}
