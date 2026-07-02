import { Router } from "express";
import { generateInsight, reconcileMarkers, runHealthReview, runResearch, synthesizeHealth } from "../coachOps.js";
import {
  activeContextEffect,
  getCoachingFocus,
  getTrajectory,
  listDirectives,
  listVisibleInsights,
  nextBestStep,
  nextStepDone,
  reactionModelForCoach,
  snoozeNextStep,
  updateDirective,
  updateInsight,
} from "../domain/brain/index.js";
import {
  annotateDirectiveFreshness,
  deriveDirectives,
  evidenceSummary,
  getEvidence,
  getEvidenceForMarker,
  getHealthSynthesisView,
  getLatestHealthReview,
  getMarkerHistory,
  getSettings,
  healthFocus,
  healthStanding,
  listMarkerAliases,
  prioritizeMarkers,
  symptomMarkerLinks,
} from "../domain/health/index.js";
import { addMemory } from "../domain/person/index.js";
import { backgroundOp } from "./background-op.js";

export const connectedBrainRouter = Router();

// ---- health insights (marker history + whole-picture agentic review) ----
connectedBrainRouter.get("/health/markers", (_req, res) => res.json(getMarkerHistory()));

// Pull-based health standing: a descriptive, visual-friendly orientation read.
// Percentiles are real reference comparisons where a trustworthy curve exists
// (e.g. VO2max / body composition), and the "signal age" is a plain-language
// synthesis, not a 0-100 score or medical diagnosis.
connectedBrainRouter.get("/health/standing", (req, res) => {
  const referenceAge = req.query.reference_age != null ? Number(req.query.reference_age) : undefined;
  res.json(healthStanding({ referenceAge }));
});

// Latest review or null — a soft lookup like /sessions?date= (200 + null on
// absence, never 404): "no review yet" is a normal state the PWA renders.
connectedBrainRouter.get("/health/review", (_req, res) => res.json(getLatestHealthReview()));

// Run a fresh whole-picture health review via the shared agent rotation.
// Like the meal swap, ok:false at status 200 is the designed failure signal
// when the agent returns garbage (addHealthReview rejects the shape).
connectedBrainRouter.post("/health/review", async (req, res) => {
  const agent = req.body?.agent;
  if (backgroundOp(res, "health_review", { agent: agent ?? null }, agent)) return;
  try {
    res.json(await runHealthReview(agent));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---- the connected brain: priority markers + propagation directives (T4) ----
// Markers re-ranked by impact (distance from OPTIMAL, most-actionable first).
// Informational, not medical advice; the impact_score is an internal ordering
// signal only and is never rendered as a user-facing grade.
connectedBrainRouter.get("/markers/priority", (_req, res) => res.json(prioritizeMarkers()));

// Marker-name canonicalization (analyte de-duplication). GET lists the learned
// variant->canonical aliases; POST runs the agentic reconciler over the distinct
// marker names and persists genuine same-analyte merges (the deterministic
// normalizer + KB are always on; this learns the long tail). Synchronous like the
// meal swap: one agent call; ok:false at 200 is the designed failure signal.
connectedBrainRouter.get("/markers/aliases", (_req, res) => res.json({ aliases: listMarkerAliases() }));

connectedBrainRouter.post("/markers/reconcile", async (req, res) => {
  try {
    const out = await reconcileMarkers(req.body?.agent); // busts the cached Brief itself when it realigns
    res.json(out);
  } catch (e: any) {
    res.json({ ok: false, error: e?.message || "reconcile failed" });
  }
});

// ---- the "knows-me" layer: personal model, trajectory, life-context, next-step ----
// All read-only, plain words, no scores: the personal coaching team, surfaced for the PWA.
connectedBrainRouter.get("/reaction-model", (_req, res) => res.json(reactionModelForCoach()));
connectedBrainRouter.get("/trajectory", (req, res) =>
  res.json(getTrajectory(typeof req.query.date === "string" ? req.query.date : undefined))
);
connectedBrainRouter.get("/context-effect", (req, res) =>
  res.json(activeContextEffect(typeof req.query.date === "string" ? req.query.date : undefined))
);
connectedBrainRouter.get("/next-step", (req, res) =>
  res.json(nextBestStep(typeof req.query.date === "string" ? req.query.date : undefined) ?? null)
);

// done / snooze are the calm "did it" / "not today" feedback: a skipped step doesn't
// return tomorrow (constitution: pull, never push; the user drives).
connectedBrainRouter.post("/next-step/done", (req, res) => {
  const k = String(req.body?.step_key ?? "").trim();
  if (!k) return res.status(400).json({ ok: false, error: "step_key required" });
  nextStepDone(k);
  res.json({ ok: true });
});

connectedBrainRouter.post("/next-step/snooze", (req, res) => {
  const k = String(req.body?.step_key ?? "").trim();
  if (!k) return res.status(400).json({ ok: false, error: "step_key required" });
  snoozeNextStep(k);
  res.json({ ok: true });
});

// The elite-coach synthesis layer: the deterministic TIERED focus (priorities,
// not a flat directive flood) + the latest cached agentic health-story narrative.
// Both informational, no scores. The narrative is regenerated via POST below.
connectedBrainRouter.get("/health/focus", (_req, res) => res.json(healthFocus()));

// THE CONDUCTOR: one sequenced whole-picture focus (lead + parallel + later +
// connections + a batched retest) across training, running, DEXA, health, nutrition
// and recovery. Pull/on-demand; the surface leads with this instead of a card flood.
connectedBrainRouter.get("/coaching-focus", (_req, res) => res.json(getCoachingFocus()));

// The cached synthesis carries a `stale` flag so the PWA can offer a calm
// "refresh this read" affordance when newer labs/training have drifted past it.
connectedBrainRouter.get("/health/synthesis", (_req, res) => {
  const view = getHealthSynthesisView();
  res.json({ synthesis: view.synthesis, focus: healthFocus(), stale: view.stale });
});

connectedBrainRouter.post("/health/synthesis", async (req, res) => {
  const agent = req.body?.agent;
  if (backgroundOp(res, "health_synthesis", { agent: agent ?? null }, agent)) return;
  try {
    res.json(await synthesizeHealth(agent));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Active cross-domain directives (?all=1 includes resolved/dismissed). Each row carries
// a freshness verdict (acute / age_days / stale) anchored to the marker's real reading
// date, so the PWA can stop surfacing a stale acute finding (e.g. a 2-week-old hs-CRP)
// as a current training/nutrition shaper while chronic findings stay put.
connectedBrainRouter.get("/directives", (req, res) =>
  res.json({
    directives: annotateDirectiveFreshness(
      listDirectives({ all: req.query.all === "1" || req.query.all === "true" }),
    ),
  })
);

// Symptom <-> marker connections: a symptom the user logged (in a life event or a
// check-in note) co-occurring with a genuinely out-of-optimal marker: a quiet
// "worth mentioning to your clinician" read. Informational, never diagnostic; [] when
// nothing co-occurs. The connected brain reaching ACROSS the logs.
connectedBrainRouter.get("/symptom-links", (_req, res) => res.json({ links: symptomMarkerLinks() }));

// User-controlled status flip (the review side of propose-review-apply). This
// is feedback memory, not just a hide: resolved/dismissed directives suppress
// equivalent future advice until the relevant marker changes enough. Nothing
// auto-applies. 400 on a bad status, 404 on an unknown id.
connectedBrainRouter.put("/directives/:id", (req, res) => {
  const status = String(req.body?.status ?? "");
  if (!["active", "resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "status must be active | resolved | dismissed" });
  }
  const updated = updateDirective(Number(req.params.id), { status });
  if (!updated) return res.status(404).json({ error: "directive not found" });
  res.json({ ok: true, directive: updated });
});

// Re-run the deterministic propagation engine over the latest markers.
connectedBrainRouter.post("/directives/derive", (_req, res) => {
  const out = deriveDirectives(); // busts today's cached Brief itself
  res.json({ ok: true, derived: out.derived, directives: out.directives });
});

// ---- host-side research & grounding (Stream 4) ----
// Read cached evidence (by ?topic= and/or ?marker=). Always available: reads the
// cache only, never the network, so it works even with research disabled.
connectedBrainRouter.get("/research", (req, res) => {
  const topic = typeof req.query.topic === "string" ? req.query.topic : undefined;
  const marker = typeof req.query.marker === "string" ? req.query.marker : undefined;
  res.json({ enabled: getSettings().research_enabled, evidence: getEvidence({ topic, marker }) });
});

// Make a directive's citation INSPECTABLE: the cited evidence behind ONE marker,
// projected to the verifiable fields { claim, source_title, source_url, body,
// confidence, retrieved_at }. Reads the cache only (never the network), so it
// works with research disabled; evidence:[] when research never ran for it.
connectedBrainRouter.get("/evidence", (req, res) => {
  const marker = typeof req.query.marker === "string" ? req.query.marker : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(getEvidenceForMarker(marker, Number.isFinite(limit as number) ? (limit as number) : undefined));
});

// Make cached evidence DISCOVERABLE (F1): the per-marker counts so a directive /
// marker view can show "see the evidence (N)" without an N-fetch fan-out, plus a
// total and whether research is on. Reads the cache only (never the network).
connectedBrainRouter.get("/evidence/summary", (_req, res) => res.json(evidenceSummary()));

// Run a cited, web-grounded evidence pass for ONE question and cache it. Gated by
// settings.research_enabled: when off, serves only cached evidence and returns
// ok:false (the designed signal, at 200): never reaches the network. Informational,
// not medical advice.
connectedBrainRouter.post("/research", async (req, res) => {
  try {
    const question = String(req.body?.question ?? "").trim();
    if (!question) return res.status(400).json({ ok: false, error: "question required" });
    const markers = Array.isArray(req.body?.markers) ? req.body.markers.map(String) : [];
    res.json(await runResearch(question, { markers, agent: req.body?.agent, force: !!req.body?.force }));
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- quiet cross-domain insights (Phase 6: pull-based, never pushed) ----
// The Brief surfaces ONE at a time when the app is opened. GET returns the live
// stream (new + seen, most recent first); dismissed insights stay in the DB and
// exports but are hidden here.
connectedBrainRouter.get("/insights", (req, res) =>
  res.json(listVisibleInsights(req.query.limit ? Number(req.query.limit) : 20))
);

// Run ONE agentic pass over the whole picture for a single genuine cross-domain
// connection, dedupe against what we've already said, and store it. Like the
// health review, ok:false at status 200 is the designed failure signal: the
// agent found nothing real (found:false) or returned an unusable shape. NO push
// notification ever fires; the result simply waits in-app.
connectedBrainRouter.post("/insights/generate", async (req, res) => {
  const agent = req.body?.agent;
  const kind = req.body?.kind === "weekly_read" ? "weekly_read" : "insight";
  if (backgroundOp(res, kind, { agent: agent ?? null, kind: req.body?.kind }, agent)) return;
  try {
    res.json(await generateInsight(agent, req.body?.kind));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Mark an insight seen/dismissed and/or record thumbs feedback. On feedback:'up'
// we ALSO write the insight text to memory so the relationship learns what kind
// of connection lands. 404 on unknown id (a real lookup, unlike the soft reads).
connectedBrainRouter.put("/insights/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = updateInsight(Number(req.params.id), { status: b.status, feedback: b.feedback });
  if (!updated) return res.status(404).json({ error: "not found" });
  if (b.feedback === "up") {
    const text = String((updated as any).text ?? "").trim();
    if (text) addMemory(text, "insight", "insight-feedback");
  }
  res.json(updated);
});
