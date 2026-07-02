import { Router } from "express";
import {
  addBodyMeasurement,
  applyMeasurementAction,
  deleteBodyMeasurement,
  getBodyMeasurement,
  getBodyMetricTrends,
  getBodyMetricsSummary,
  normalizeUnit,
  updateBodyMeasurement,
} from "../repo/body-metrics.js";
import { setProfile } from "../repo/profile.js";

export const bodyMetricsRouter = Router();

// The measurements list + latest reading + derived indicators + per-site trends,
// in one composed payload the PWA renders directly. `?days=` bounds the window;
// `?unit=cm` re-expresses circumferences + trends in centimeters (storage stays in).
bodyMetricsRouter.get("/body-metrics", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 365;
  res.json(getBodyMetricsSummary(Number.isFinite(days) ? days : 365, normalizeUnit(req.query.unit)));
});

// Log a measuring session. Body carries any subset of the sites (inches by default;
// pass unit:"cm" to log centimeters), plus an optional note/source and — for
// convenience — height_in (routed to the profile so BMI / body-fat light up from
// the same call; it follows the same unit). Values are clamped in the repo.
bodyMetricsRouter.post("/body-metrics", (req, res) => {
  const body = req.body ?? {};
  const unit = normalizeUnit(body.unit);
  let heightSet = false;
  if (body.height_in != null && body.height_in !== "") {
    const h = Number(body.height_in);
    setProfile({ height_in: unit === "cm" && Number.isFinite(h) ? Math.round((h / 2.54) * 10) / 10 : body.height_in });
    heightSet = true;
  }
  const measurement = addBodyMeasurement(body.date, body, body.note, body.source ?? "manual", unit);
  res.json({ ok: true, measurement, height_set: heightSet, summary: getBodyMetricsSummary(365, unit) });
});

// Per-site least-squares trends (plain-language + sparkline points), null-safe.
bodyMetricsRouter.get("/body-metrics/trends", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 365;
  res.json(getBodyMetricTrends(Number.isFinite(days) ? days : 365, normalizeUnit(req.query.unit)));
});

// Single-row read — 200 + null on absence (the PWA api() helper resolves to the
// body regardless of status, so a 404 error-object would read as a truthy hit).
bodyMetricsRouter.get("/body-metrics/:id", (req, res) => {
  res.json(getBodyMeasurement(Number(req.params.id)));
});

bodyMetricsRouter.put("/body-metrics/:id", (req, res) => {
  const updated = updateBodyMeasurement(Number(req.params.id), req.body ?? {});
  if (!updated) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(updated);
});

bodyMetricsRouter.delete("/body-metrics/:id", (req, res) => {
  res.json(deleteBodyMeasurement(Number(req.params.id)));
});

// Agentic capture parity with the chat `log_measurement` action, exposed on REST
// too: "waist 34, chest 42" style free-field body → one clean logged session.
bodyMetricsRouter.post("/body-metrics/log", (req, res) => {
  res.json(applyMeasurementAction(req.body ?? {}));
});
