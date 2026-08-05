import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { registerChatTools } from "./surfaces/mcp/chat.js";
import { registerConnectedBrainTools } from "./surfaces/mcp/connected-brain.js";
import { registerDailyDriverTools } from "./surfaces/mcp/daily-driver.js";
import { registerDayCoachTools } from "./surfaces/mcp/day-coach.js";
import { registerGarminTools } from "./surfaces/mcp/garmin.js";
import { registerHealthMetricsTools } from "./surfaces/mcp/health-metrics.js";
import { registerHealthRecordTools } from "./surfaces/mcp/health-records.js";
import { registerImagingTools } from "./surfaces/mcp/imaging.js";
import { registerMemoryLearningTools } from "./surfaces/mcp/memory-learning.js";
import { registerNutritionTools } from "./surfaces/mcp/nutrition.js";
import { registerOperatorTools } from "./surfaces/mcp/operator.js";
import { registerPersonTools } from "./surfaces/mcp/person.js";
import { registerPersonContextTools } from "./surfaces/mcp/person-context.js";
import { registerPlanExerciseTools } from "./surfaces/mcp/plan-exercises.js";
import { registerProgramTools } from "./surfaces/mcp/program.js";
import { registerSystemTools } from "./surfaces/mcp/system.js";
import { registerTrainingLogTools } from "./surfaces/mcp/training-log.js";
import { registerTrainingStatusTools } from "./surfaces/mcp/training-status.js";
import { registerBodyMetricsTools } from "./surfaces/mcp/body-metrics.js";
import { registerJourneyTools } from "./surfaces/mcp/journey.js";
import { registerCalibrationTools } from "./surfaces/mcp/calibration.js";
import { getBuildInfo, getBuildStamp } from "./build-info.js";
import { recordDiagnosticEvent } from "./repo/diagnostics.js";
import {
  isInternalMcpMetricOperation,
  normalizeMcpMetricOperation,
  recordRequestMetric,
  registerMcpMetricOperation,
} from "./repo/request-metrics.js";
import { telemetryErrorName, telemetryIdentifier, telemetryStackFrames } from "./telemetry-privacy.js";

const KNOWN_MCP_METHODS = new Map([
  ["initialize", "initialize"],
  ["notifications/initialized", "initialized"],
  ["tools/list", "tools_list"],
  ["ping", "ping"],
]);

function instrumentTelemetry(server: McpServer): McpServer {
  const tool = server.tool.bind(server) as (...values: unknown[]) => unknown;
  server.tool = ((...args: unknown[]) => {
    registerMcpMetricOperation(args[0]);
    return tool(...args);
  }) as McpServer["tool"];
  return server;
}

export function mcpMetricOperation(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "unknown";
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method === "tools/call") return normalizeMcpMetricOperation(request.params?.name);
  return typeof request.method === "string" ? KNOWN_MCP_METHODS.get(request.method) || "unknown" : "unknown";
}

export function buildMcpServer(): McpServer {
  const server = instrumentTelemetry(new McpServer({ name: "cairn", version: getBuildInfo().version }));
  registerSystemTools(server);
  registerChatTools(server);
  registerConnectedBrainTools(server);
  registerDailyDriverTools(server);
  registerDayCoachTools(server);
  registerGarminTools(server);
  registerHealthMetricsTools(server);
  registerHealthRecordTools(server);
  registerImagingTools(server);
  registerMemoryLearningTools(server);
  registerNutritionTools(server);
  registerOperatorTools(server);
  registerPersonTools(server);
  registerPersonContextTools(server);
  registerPlanExerciseTools(server);
  registerProgramTools(server);
  registerTrainingLogTools(server);
  registerTrainingStatusTools(server);
  registerBodyMetricsTools(server);
  registerJourneyTools(server);
  registerCalibrationTools(server);

  return server;
}

// Stateless Streamable HTTP handler: fresh server+transport per request.
export async function handleMcpPost(req: Request, res: Response) {
  const started = performance.now();
  const server = buildMcpServer();
  const tool = mcpMetricOperation(req.body);
  res.once("finish", () => {
    recordRequestMetric({
      protocol: "mcp",
      method: "POST",
      route: tool,
      status: res.statusCode,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      scope: isInternalMcpMetricOperation(tool) ? "internal" : "product",
    });
  });
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const errorName = telemetryErrorName(err);
    recordDiagnosticEvent({
      source: "mcp",
      kind: "server_exception",
      level: "error",
      operation: tool,
      status: 500,
      fingerprint: `mcp:server_exception:${tool}:${errorName}`,
      message: `${errorName}: MCP request failed`,
      stack: telemetryStackFrames(err),
      release: getBuildStamp(),
    });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}

export function methodNotAllowed(_req: Request, res: Response) {
  recordRequestMetric({
    protocol: "mcp",
    method: _req.method,
    route: "unknown",
    status: 405,
    duration_ms: 0,
    scope: "internal",
  });
  recordDiagnosticEvent({
    source: "mcp",
    kind: "http_error",
    level: "warning",
    operation: telemetryIdentifier(_req.method, 20, "UNKNOWN"),
    status: 405,
    fingerprint: `mcp:http_error:${telemetryIdentifier(_req.method, 20, "UNKNOWN")}:405`,
    message: "HTTP 405",
    release: getBuildStamp(),
  });
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}
