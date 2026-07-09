import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  addHealthDocument,
  confirmPendingLab,
  deleteHealthDocument,
  deriveDirectives,
  getHealthDocument,
  getHealthDocumentRaw,
  getSettings,
  listHealthDocuments,
  setHealthDocEnrichStatus,
  updateHealthDocFields,
} from "../domain/health/index.js";
import { UPLOADS_DIR, safeUploadPath } from "../uploadPaths.js";
import { extForMime, isAcceptedMime, isInlineMime } from "../uploadMime.js";
import { streamEnrichRow } from "./enrich-stream.js";

export const healthDocsRouter = Router();

healthDocsRouter.get("/", (req, res) =>
  res.json(listHealthDocuments(req.query.limit ? Number(req.query.limit) : 50))
);

// Single row (poll fallback for watching enrichment_status).
healthDocsRouter.get("/:id", (req, res) => {
  const d = getHealthDocument(Number(req.params.id));
  if (!d) return res.status(404).json({ error: "not found" });
  res.json(d);
});

// Live enrichment status for one health document (Server-Sent Events) — the
// SSE-first path the PWA uses instead of polling; snapshot then transitions, close
// on terminal. getHealthDocument returns the PUBLIC shape (never the raw file_path).
// EventSource can't set headers, so the PWA reaches this with ?token=.
healthDocsRouter.get("/:id/stream", streamEnrichRow("health", getHealthDocument));

// Stream the original file. Only raster images / PDF are served inline.
healthDocsRouter.get("/:id/file", (req, res) => {
  const row = getHealthDocumentRaw(Number(req.params.id)) as any;
  const filePath = safeUploadPath(row?.file_path);
  if (!row || !filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "not found" });
  }
  const inline = isInlineMime(row.mime);
  res.setHeader("Content-Type", isAcceptedMime(row.mime) ? row.mime : "application/octet-stream");
  res.setHeader("Content-Disposition", inline ? "inline" : "attachment");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(filePath).on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "read failed" });
  }).pipe(res);
});

healthDocsRouter.post("/", (req, res) => {
  const b = req.body ?? {};
  const pasted = (b.text ?? "").toString().trim();
  const mime = pasted ? "text/plain" : (b.mime ?? "").toString();
  if (!isAcceptedMime(mime)) {
    return res.status(400).json({ error: "mime must be an image, PDF, zip, HTML, XML, or pasted text" });
  }
  if (!pasted && !b.data_base64) return res.status(400).json({ error: "data_base64 or text required" });

  let buf: Buffer;
  if (pasted) {
    buf = Buffer.from(pasted.slice(0, 400000), "utf8");
  } else {
    try {
      buf = Buffer.from(String(b.data_base64), "base64");
    } catch {
      return res.status(400).json({ error: "invalid base64" });
    }
  }
  if (!buf.length) return res.status(400).json({ error: "empty file" });

  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.${extForMime(mime)}`;
    const filePath = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(filePath, buf);

    const status = getSettings().enrich_enabled ? "pending" : "skipped";
    const row = addHealthDocument({
      kind: b.kind ?? "other",
      doc_date: b.doc_date ?? null,
      original_name: b.original_name ?? (pasted ? "Pasted results" : null),
      mime,
      file_path: filePath,
      enrichment_status: status,
    });

    if (status === "pending") {
      import("../enrich.js").then((m) => m.enqueueEnrich("health", row.id)).catch(() => {});
    }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

healthDocsRouter.put("/:id", (req, res) => {
  const row = getHealthDocument(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });
  const b = req.body ?? {};
  const fields: { kind?: string | null; doc_date?: string | null } = {};
  if (b.kind !== undefined) fields.kind = b.kind;
  let dateChanged = false;
  if (b.doc_date !== undefined) {
    const d = b.doc_date == null ? null : String(b.doc_date).trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: "doc_date must be YYYY-MM-DD" });
    fields.doc_date = d || null;
    dateChanged = (d || null) !== (row.doc_date || null);
  }
  const updated = updateHealthDocFields(Number(req.params.id), fields);
  if (dateChanged) {
    try { deriveDirectives(); } catch { /* keep the edit path resilient */ }
    import("../enrich.js").then((m) => m.enqueueReviewRefresh()).catch(() => {});
  }
  res.json(updated);
});

// Re-run the agentic scan over a document's original file.
healthDocsRouter.post("/:id/reanalyze", (req, res) => {
  const row = getHealthDocumentRaw(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const filePath = safeUploadPath(row.file_path);
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: "no source file to re-analyze" });
  if (!getSettings().enrich_enabled) return res.status(409).json({ error: "analysis is disabled in settings" });
  setHealthDocEnrichStatus(Number(req.params.id), "pending");
  import("../enrich.js").then((m) => m.enqueueEnrich("health", Number(req.params.id))).catch(() => {});
  res.json(getHealthDocument(Number(req.params.id)));
});

// Confirm a pending_confirm lab paste — the chat propose→apply gate for a bulk panel.
// When a transcriber is reachable it flips the draft into the completeness-first,
// Claude-first health ingest (the same path the paste box uses); otherwise it commits
// the chat agent's inline markers directly. Nothing writes to Health until this fires.
healthDocsRouter.post("/:id/confirm", (req, res) => {
  const id = Number(req.params.id);
  if (!getHealthDocumentRaw(id)) return res.status(404).json({ error: "not found" });
  const result = confirmPendingLab(id);
  if (!result.ok) return res.status(404).json({ error: result.reason || "not found" });
  if (result.enqueue) {
    import("../enrich.js").then((m) => m.enqueueEnrich("health", id)).catch(() => {});
  }
  if (result.committed) {
    // Markers landed inline (no transcriber reachable) → refresh the connected brain
    // + whole-picture review, mirroring the enrichment path's follow-ons.
    try { deriveDirectives(); } catch { /* keep the confirm resilient */ }
    import("../enrich.js").then((m) => m.enqueueReviewRefresh()).catch(() => {});
  }
  res.json(result.doc ?? getHealthDocument(id));
});

healthDocsRouter.delete("/:id", (req, res) => {
  const row = getHealthDocumentRaw(Number(req.params.id)) as any;
  const result = deleteHealthDocument(Number(req.params.id));
  const filePath = safeUploadPath(row?.file_path);
  if (filePath) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(`${filePath}-x`, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  res.json(result);
});
