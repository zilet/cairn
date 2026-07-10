import { Router } from "express";
import type { Request, Response } from "express";
import { getAgentCliUpdateStatus, startAgentCliUpdate } from "../agentCliUpdates.js";
import { agentInfoOp, agentModelsOp } from "../coachOps.js";
import {
  getAgentConfig,
  getAgentStats,
  getBrainDiagnostics,
  getSettings,
  listRoutableTasks,
  setSettings,
} from "../domain/operator/index.js";
import { researchAutoEligible } from "../research.js";
import { getDiagnostics, ingestClientDiagnosticEvents, parseClientDiagnosticBatch } from "../repo/diagnostics.js";
import { getVersion } from "../version.js";

export const operatorRouter = Router();

operatorRouter.get("/agents", (_req, res) => res.json(getAgentConfig()));

// Per-agent read-only visibility (subprocess probes — fetched lazily, not on
// every Settings open). Both return ok:false at HTTP 200, mirroring the rest of
// Cairn's designed failure signals.
operatorRouter.get("/agents/:name/info", (req, res) => res.json(agentInfoOp(req.params.name)));
operatorRouter.get("/agents/:name/models", (req, res) => res.json(agentModelsOp(req.params.name)));

operatorRouter.get("/agent-clis/update", (_req, res) => res.json(getAgentCliUpdateStatus()));
operatorRouter.post("/agent-clis/update", (_req, res) => res.status(202).json(startAgentCliUpdate("manual")));

// Settings + agent metadata. route_tasks is server-owned UI metadata for the
// Settings routing controls, so frontend task labels cannot drift from the
// backend allowlist.
operatorRouter.get("/settings", (_req, res) =>
  res.json({
    settings: getSettings(),
    agents: getAgentConfig(),
    route_tasks: listRoutableTasks(),
    research_auto_eligible: researchAutoEligible(),
  })
);
operatorRouter.put("/settings", (req, res) =>
  res.json({
    settings: setSettings(req.body ?? {}),
    agents: getAgentConfig(),
    route_tasks: listRoutableTasks(),
  })
);

// Agent-run telemetry: ok-rate, per-agent reliability + median latency, and the
// recent raw attempts. An operator/health view — NOT a user-facing score.
// Optional ?recent=N (last N attempts) and ?days=N (window the roll-up).
operatorRouter.get("/agent-stats", (req, res) => {
  const recent = req.query.recent != null ? Number(req.query.recent) : undefined;
  const days = req.query.days != null ? Number(req.query.days) : undefined;
  res.json(getAgentStats({ recent, days }));
});

operatorRouter.get("/brain-diagnostics", (req, res) =>
  res.json(getBrainDiagnostics(req.query.limit != null ? Number(req.query.limit) : undefined))
);

export function clientTelemetryHandler(req: Request, res: Response) {
  const events = parseClientDiagnosticBatch(req.body);
  if (!events) return res.status(400).json({ error: "invalid telemetry batch" });
  ingestClientDiagnosticEvents(events, getVersion());
  return res.status(204).end();
}

export function diagnosticsHandler(req: Request, res: Response) {
  const recent = req.query.recent != null ? Number(req.query.recent) : undefined;
  const days = req.query.days != null ? Number(req.query.days) : undefined;
  res.json(getDiagnostics({ recent, days }));
}

// Best-effort browser error/API-failure ingestion. Accepts only the bounded,
// privacy-scrubbed client diagnostic contract; never request bodies or app data.
operatorRouter.post("/telemetry/client", clientTelemetryHandler);

// Local operator issue pulse: grouped browser/server/process failures, recent
// sanitized events, and slow API requests over a bounded time window.
operatorRouter.get("/diagnostics", diagnosticsHandler);
