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

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "cairn", version: "0.1.0" });
  registerSystemTools(server);
  registerChatTools(server);
  registerConnectedBrainTools(server);
  registerDailyDriverTools(server);
  registerDayCoachTools(server);
  registerGarminTools(server);
  registerHealthMetricsTools(server);
  registerHealthRecordTools(server);
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

  return server;
}

// Stateless Streamable HTTP handler: fresh server+transport per request.
export async function handleMcpPost(req: Request, res: Response) {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (_err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}

export function methodNotAllowed(_req: Request, res: Response) {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}
