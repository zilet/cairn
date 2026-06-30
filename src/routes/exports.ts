import { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { todayISO } from "../db.js";
import { buildHealthExport } from "../domain/health/index.js";
import { exportAll, snapshotDbTo } from "../domain/training/index.js";
import { buildClinicalReportData, renderClinicalReportHTML, renderClinicalReportText } from "../report.js";

export const exportsRouter = Router();

exportsRouter.get("/export", (_req, res) => {
  const data = { exported_at: todayISO(), ...exportAll() };
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="cairn-export-${todayISO()}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

exportsRouter.get("/export/db", async (_req, res) => {
  const tmp = path.join(os.tmpdir(), `cairn-snap-${process.pid}-${Date.now()}.db`);
  try {
    snapshotDbTo(tmp);
    res.download(tmp, `cairn-${todayISO()}.db`, (_err) => {
      fs.rm(tmp, { force: true }, () => {});
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Structured, FHIR-inspired health summary (markers/observations over time +
// non-marker clinical facts + supplements + active directives) — a portable
// read-only slice to hand a physician or another tool. Optimal-zone framing, no scores.
exportsRouter.get("/health-export", (_req, res) => {
  const data = buildHealthExport();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="cairn-health-${todayISO()}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// Clinician-facing health report — a doctor-ready, print-to-PDF HTML document
// (grouped panels + dated progress + a "findings to discuss" lead + DEXA body
// comp). The PWA opens it in a new tab (?token=); the page itself has a "Save as
// PDF" button. `?name=` stamps the patient name (also editable on the page).
// `.txt` is the plain-text twin for pasting into a MyChart message body.
// Optimal-zone framing, no scores — same boundary discipline as /health-export.
exportsRouter.get("/health-report", (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.slice(0, 120) : "";
  const html = renderClinicalReportHTML(buildClinicalReportData(), { name });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

exportsRouter.get("/health-report.txt", (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.slice(0, 120) : "";
  const text = renderClinicalReportText(buildClinicalReportData(), { name });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="cairn-health-summary-${todayISO()}.txt"`);
  res.send(text);
});
