import { Router } from "express";
import type { Request, Response } from "express";
import {
  getAgentCliUpdateStatus,
  installableAgentNames,
  startAgentCliUpdate,
  startInstalledAgentCliUpdate,
} from "../agentCliUpdates.js";
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
import { lastGarminStrengthExportAt } from "../repo/garmin-strength-export.js";
import { getBuildStamp } from "../build-info.js";

export const operatorRouter = Router();

operatorRouter.get("/agents", (_req, res) => res.json(getAgentConfig()));

// Per-agent read-only visibility (subprocess probes — fetched lazily, not on
// every Settings open). Both return ok:false at HTTP 200, mirroring the rest of
// Cairn's designed failure signals.
operatorRouter.get("/agents/:name/info", (req, res) => res.json(agentInfoOp(req.params.name)));
operatorRouter.get("/agents/:name/models", (req, res) => res.json(agentModelsOp(req.params.name)));

operatorRouter.get("/agent-clis/update", (_req, res) => res.json(getAgentCliUpdateStatus()));
// Backward-compatible bulk update: refresh only CLIs the user already installed;
// never turns a lean image back into an all-provider image.
operatorRouter.post("/agent-clis/update", (_req, res) => res.status(202).json(startInstalledAgentCliUpdate("manual")));
operatorRouter.post("/agent-clis/:name/install", (req, res) => {
  if (!installableAgentNames().includes(req.params.name)) {
    return res.status(400).json({ ok: false, error: "unknown or non-installable agent" });
  }
  return res.status(202).json(startAgentCliUpdate(req.params.name, "manual"));
});

// Settings + agent metadata. route_tasks is server-owned UI metadata for the
// Settings routing controls, so frontend task labels cannot drift from the
// backend allowlist.
operatorRouter.get("/settings", (_req, res) =>
  res.json({
    settings: getSettings(),
    agents: getAgentConfig(),
    route_tasks: listRoutableTasks(),
    research_auto_eligible: researchAutoEligible(),
    // Quiet state for the strength write-back toggle. Derived, not a settings column,
    // so it rides alongside `settings` rather than inside it.
    garmin_last_export_at: lastGarminStrengthExportAt(),
  })
);
operatorRouter.put("/settings", (req, res) =>
  res.json({
    settings: setSettings(req.body ?? {}),
    agents: getAgentConfig(),
    route_tasks: listRoutableTasks(),
    garmin_last_export_at: lastGarminStrengthExportAt(),
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
  ingestClientDiagnosticEvents(events, getBuildStamp());
  return res.status(204).end();
}

export function diagnosticsHandler(req: Request, res: Response) {
  const recent = req.query.recent != null ? Number(req.query.recent) : undefined;
  const days = req.query.days != null ? Number(req.query.days) : undefined;
  res.json(getDiagnostics({ recent, days }));
}

// Best-effort browser error/API-failure ingestion. Accepts only the bounded,
// privacy-scrubbed client diagnostic contract. The server derives fingerprint,
// route family, tab and build identity; it never trusts those client values.
operatorRouter.post("/telemetry/client", clientTelemetryHandler);

// Local operator issue pulse: current-build browser/API/MCP/process/scheduler
// and worker failures, release-scoped history plus a marked current-build subset,
// product latency, separately counted internal telemetry, and enforceable caps.
operatorRouter.get("/diagnostics", diagnosticsHandler);
