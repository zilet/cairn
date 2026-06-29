import { Router } from "express";
import * as repo from "../repo.js";
import { getAgentCliUpdateStatus, startAgentCliUpdate } from "../agentCliUpdates.js";
import { agentInfoOp, agentModelsOp } from "../coachOps.js";
import { researchAutoEligible } from "../research.js";

export const operatorRouter = Router();

operatorRouter.get("/agents", (_req, res) => res.json(repo.getAgentConfig()));

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
    settings: repo.getSettings(),
    agents: repo.getAgentConfig(),
    route_tasks: repo.listRoutableTasks(),
    research_auto_eligible: researchAutoEligible(),
  })
);
operatorRouter.put("/settings", (req, res) =>
  res.json({
    settings: repo.setSettings(req.body ?? {}),
    agents: repo.getAgentConfig(),
    route_tasks: repo.listRoutableTasks(),
  })
);

// Agent-run telemetry: ok-rate, per-agent reliability + median latency, and the
// recent raw attempts. An operator/health view — NOT a user-facing score.
// Optional ?recent=N (last N attempts) and ?days=N (window the roll-up).
operatorRouter.get("/agent-stats", (req, res) => {
  const recent = req.query.recent != null ? Number(req.query.recent) : undefined;
  const days = req.query.days != null ? Number(req.query.days) : undefined;
  res.json(repo.getAgentStats({ recent, days }));
});
