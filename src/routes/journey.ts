import { Router } from "express";
import {
  activateJourneyPhase,
  createJourneyPhase,
  discardJourneyPhase,
  getJourneyPhase,
  journeyMilestones,
  journeyRead,
  journeyTransitionSuggestion,
  listJourneyPhases,
} from "../repo/journey.js";

export const journeyRouter = Router();

journeyRouter.get("/journey", (req, res) => {
  res.json(journeyRead(req.query.date ? String(req.query.date) : undefined));
});

journeyRouter.get("/journey/milestones", (req, res) => {
  res.json(journeyMilestones(req.query.date ? String(req.query.date) : undefined));
});

journeyRouter.get("/journey/transition-suggestion", (req, res) => {
  res.json(journeyTransitionSuggestion(req.query.date ? String(req.query.date) : undefined));
});

journeyRouter.get("/journey/phases", (req, res) => {
  const status = req.query.status ? String(req.query.status) : "all";
  res.json(listJourneyPhases(status as any));
});

journeyRouter.get("/journey/phases/:id", (req, res) => {
  res.json(getJourneyPhase(Number(req.params.id)));
});

journeyRouter.post("/journey/phases", (req, res) => {
  try {
    res.json(createJourneyPhase(req.body ?? {}));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "invalid journey phase" });
  }
});

journeyRouter.post("/journey/phases/:id/activate", (req, res) => {
  try {
    res.json(activateJourneyPhase(Number(req.params.id)));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "could not activate journey phase" });
  }
});

journeyRouter.post("/journey/phases/:id/discard", (req, res) => {
  res.json(discardJourneyPhase(Number(req.params.id)));
});
