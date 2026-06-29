import { Router } from "express";
import { consolidateMemory, growAboutMe, reconcileOutcomes } from "../coachOps.js";
import * as repo from "../repo.js";

export const memoryLearningRouter = Router();

// ---- memory ----
// ?all=1 includes superseded rows (history) for the curation UI; default hides them.
memoryLearningRouter.get("/memory", (req, res) =>
  res.json(repo.listMemory(req.query.limit ? Number(req.query.limit) : 50, { includeSuperseded: req.query.all === "1" }))
);

memoryLearningRouter.post("/memory", (req, res) => {
  const b = req.body ?? {};
  if (!b.content) return res.status(400).json({ error: "content required" });
  res.json(repo.addMemory(b.content, b.kind, b.source));
});

memoryLearningRouter.put("/memory/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = repo.updateMemory(Number(req.params.id), {
    content: b.content,
    kind: b.kind,
    confidence: b.confidence,
  });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});

// Supersede (mark, never hard-delete): optionally provide a replacement content
// (a new row is created) or replacement_id (point at an existing row).
memoryLearningRouter.post("/memory/:id/supersede", (req, res) => {
  const b = req.body ?? {};
  const r = repo.supersedeMemory(Number(req.params.id), {
    content: b.replacement ?? b.content,
    kind: b.kind,
    replacementId: b.replacement_id,
    reason: b.reason,
  });
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

memoryLearningRouter.delete("/memory/:id", (req, res) => res.json(repo.deleteMemory(Number(req.params.id))));

// Quiet memory consolidation: merge near-duplicates, supersede contradictions,
// promote recurring observations. Marks, never hard-deletes. On demand here; also
// scheduled nightly. Designed ok:false at 200 when the agent returns nothing usable.
memoryLearningRouter.post("/memory/consolidate", async (req, res) => {
  try {
    res.json(await consolidateMemory(req.body?.agent));
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// Grow profile.about_me from typed memory + family + check-ins (augments, never
// overwrites blindly). changed:false is the calm, common answer.
memoryLearningRouter.post("/profile/grow-about-me", async (req, res) => {
  try {
    res.json(await growAboutMe(req.body?.agent));
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ---- outcome learning (suggestions -> actuals) ----
memoryLearningRouter.get("/suggestions", (req, res) =>
  res.json(repo.listSuggestions(req.query.limit ? Number(req.query.limit) : 50))
);

// Reconcile past suggestions to what actually happened, writing durable learnings.
// Deterministic, no agent. Also scheduled quietly.
memoryLearningRouter.post("/suggestions/reconcile", (req, res) =>
  res.json(reconcileOutcomes({ maxPerPass: req.body?.max != null ? Number(req.body.max) : undefined }))
);

// ---- outcome learnings: "What Cairn has noticed" (F2, pull-never-push) ----
// The durable, plain-language learnings drawn from suggestion -> actual
// reconciliation (e.g. "tolerates higher training frequency than the read
// assumed"). A quiet read, never a score or a gate — these only season the
// coach's defaults. Reads the existing 'learning' memory rows; nothing new stored.
memoryLearningRouter.get("/learnings", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(repo.getOutcomeLearnings(Number.isFinite(limit as number) ? (limit as number) : undefined));
});
