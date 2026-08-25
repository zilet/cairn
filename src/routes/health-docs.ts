import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  addHealthDocument,
  addImagingStudyFile,
  confirmImagingStudy,
  confirmPendingLab,
  correctImagingStudy,
  createImagingStudy,
  dedupeHealthDocuments,
  deleteHealthDocument,
  deleteImagingStudy,
  deriveDirectives,
  getHealthDocument,
  getHealthDocumentRaw,
  getImagingStudy,
  getImagingStudyFileRaw,
  getSettings,
  IMAGING_FILE_MIMES,
  isImagingRecommendationStatus,
  listHealthDocuments,
  MAX_IMAGING_FILE_BYTES,
  setHealthDocEnrichStatus,
  updateHealthDocFields,
  updateImagingRecommendationStatus,
} from "../domain/health/index.js";
import { inferHealthDocumentKind, normalizeHealthDocumentKind } from "../healthDocumentKinds.js";
import { UPLOADS_DIR, safeUploadPath } from "../uploadPaths.js";
import { extForMime, isAcceptedMime, isInlineMime } from "../uploadMime.js";
import { streamEnrichRow } from "./enrich-stream.js";
import {
  createDicomImportJobFromStaged,
  createDicomStagingPath,
  dicomFrame,
  dicomInstanceFile,
  dicomManifest,
  publicDicomImportJob,
} from "../dicomImports.js";
import { DICOM_LIMITS, DicomImportError } from "../dicom.js";

export const healthDocsRouter = Router();

function privateNoStore(res: any) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );
}

export async function stageDicomRequest(req: any): Promise<{ path: string; bytes: number }> {
  const stagingPath = createDicomStagingPath();
  const stream = fs.createWriteStream(stagingPath, { flags: "wx", mode: 0o600 });
  let bytes = 0;
  try {
    for await (const rawChunk of req) {
      const chunk = Buffer.from(rawChunk);
      bytes += chunk.length;
      if (bytes > DICOM_LIMITS.archiveBytes) throw new DicomImportError("source_size_limit");
      if (!stream.write(chunk))
        await new Promise<void>((resolve, reject) => {
          stream.once("drain", resolve);
          stream.once("error", reject);
        });
    }
    await new Promise<void>((resolve, reject) =>
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
    );
    if (bytes < 4) throw new DicomImportError("empty_source");
    return { path: stagingPath, bytes };
  } catch (error) {
    stream.destroy();
    try {
      fs.rmSync(stagingPath, { force: true });
    } catch {}
    throw error;
  }
}

healthDocsRouter.post("/imaging/dicom-imports", async (req, res) => {
  const mime = String(req.get("Content-Type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!["application/dicom", "application/zip", "application/x-zip-compressed"].includes(mime))
    return res.status(415).json({ error: "content type must be application/dicom or application/zip" });
  const declared = Number(req.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > DICOM_LIMITS.archiveBytes)
    return res.status(413).json({ error: "DICOM import exceeds the request limit" });
  const rawTarget = req.query.target_study_id ?? req.get("X-Cairn-Target-Study-Id");
  const targetStudyId = rawTarget == null || rawTarget === "" ? null : Number(rawTarget);
  if (targetStudyId != null && (!Number.isInteger(targetStudyId) || targetStudyId <= 0))
    return res.status(400).json({ error: "target_study_id must be a positive integer" });
  try {
    const staged = await stageDicomRequest(req);
    const job = createDicomImportJobFromStaged({
      stagingPath: staged.path,
      sourceMime: mime,
      sourceBytes: staged.bytes,
      targetStudyId,
      analyze: truthy(req.query.analyze ?? req.get("X-Cairn-Analyze")),
    });
    privateNoStore(res);
    return res.status(202).json(job);
  } catch (error) {
    const code = error instanceof DicomImportError ? error.code : "upload_failed";
    return res.status(code === "source_size_limit" ? 413 : 400).json({ error: code });
  }
});

healthDocsRouter.get("/imaging/dicom-imports/:jobId", (req, res) => {
  const job = publicDicomImportJob(Number(req.params.jobId));
  if (!job) return res.status(404).json({ error: "not found" });
  privateNoStore(res);
  res.json(job);
});

healthDocsRouter.get("/:id/dicom/manifest", (req, res) => {
  const manifest = dicomManifest(Number(req.params.id));
  if (!manifest) return res.status(404).json({ error: "not found" });
  privateNoStore(res);
  res.json(manifest);
});

healthDocsRouter.get("/:id/dicom/instances/:instanceId/file", (req, res) => {
  const source = dicomInstanceFile(Number(req.params.id), Number(req.params.instanceId));
  if (!source || !fs.existsSync(source.filePath)) return res.status(404).json({ error: "not found" });
  privateNoStore(res);
  res.setHeader("Content-Type", "application/dicom");
  res.setHeader("Content-Disposition", `attachment; filename="dicom-instance-${Number(req.params.instanceId)}.dcm"`);
  res.setHeader("Content-Length", String(source.sizeBytes));
  fs.createReadStream(source.filePath)
    .on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "read failed" });
    })
    .pipe(res);
});

healthDocsRouter.get("/:id/dicom/instances/:instanceId/frames/:frame", (req, res) => {
  try {
    const decoded = dicomFrame(Number(req.params.id), Number(req.params.instanceId), Number(req.params.frame));
    if (!decoded) return res.status(404).json({ error: "not found" });
    const body = Buffer.allocUnsafe(decoded.pixels.length * 4);
    for (let index = 0; index < decoded.pixels.length; index++) body.writeFloatLE(decoded.pixels[index], index * 4);
    privateNoStore(res);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Cairn-Pixel-Format", "float32-le");
    res.setHeader("X-Cairn-Rows", String(decoded.rows));
    res.setHeader("X-Cairn-Columns", String(decoded.columns));
    res.setHeader("X-Cairn-Window-Center", String(decoded.windowCenter));
    res.setHeader("X-Cairn-Window-Width", String(decoded.windowWidth));
    res.setHeader("X-Cairn-Inverted", decoded.inverted ? "1" : "0");
    res.setHeader("Content-Length", String(body.length));
    res.send(body);
  } catch (error) {
    const code = error instanceof DicomImportError ? error.code : "frame_unavailable";
    res.status(code === "frame_out_of_bounds" ? 416 : 422).json({ error: code });
  }
});

export function imagingBuffer(value: unknown): Buffer | null {
  const input = String(value ?? "").trim();
  if (!input || !/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) return null;
  const buf = Buffer.from(input, "base64");
  return buf.length ? buf : null;
}

export function imagingMimeMatches(buf: Buffer, mime: string): boolean {
  if (mime === "application/pdf") return buf.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "image/png")
    return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg" || mime === "image/jpg")
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  return false;
}

export function publicImagingDraftInput(body: any, docDate: string | null) {
  return {
    doc_date: docDate,
    original_name: body?.original_name,
    summary: body?.summary,
    study: {
      modality: body?.modality,
      raw_modality: body?.raw_modality,
      procedure: body?.procedure,
      study_date: docDate,
    },
  };
}

// One panel per draw date, across the whole record set: fold records that
// carry the same draw (same date, agreeing readings) into one. A bare call
// only REPORTS the plan; the fold — which deletes twin records, and the file
// of an identical second upload — needs an explicit `apply: true`. Ingest
// runs the same fold scoped to its own upload.
healthDocsRouter.post("/dedupe", (req, res) => {
  const dryRun = !truthy(req.body?.apply ?? req.query.apply);
  const result = dedupeHealthDocuments({ dryRun });
  if (!dryRun && result.merged) {
    // Folded panels withdraw nothing, but the survivor's series changed shape:
    // re-derive so the connected brain reads the merged record, not the twins.
    try {
      deriveDirectives();
    } catch {
      /* the fold is done; the connected brain settles on the next daily pass */
    }
  }
  res.json(result);
});

healthDocsRouter.get("/", (req, res) => res.json(listHealthDocuments(req.query.limit ? Number(req.query.limit) : 50)));

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
  privateNoStore(res);
  res.setHeader("Content-Type", isAcceptedMime(row.mime) ? row.mime : "application/octet-stream");
  res.setHeader("Content-Disposition", inline ? "inline" : "attachment");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(filePath)
    .on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "read failed" });
    })
    .pipe(res);
});

// Create the durable study shell first; files can then arrive sequentially over
// separate bounded requests without pretending each page/image is a new record.
healthDocsRouter.post("/imaging", (req, res) => {
  const b = req.body ?? {};
  const docDate = b.doc_date == null ? null : String(b.doc_date).trim();
  if (docDate && !/^\d{4}-\d{2}-\d{2}$/.test(docDate))
    return res.status(400).json({ error: "doc_date must be YYYY-MM-DD" });
  // Provenance/source_doc_id are internal linkage fields populated only by the
  // MyChart-derived ingestion path; this public draft route intentionally whitelists.
  res.json(createImagingStudy(publicImagingDraftInput(b, docDate)));
});

healthDocsRouter.post("/:id/imaging-files", (req, res) => {
  const id = Number(req.params.id);
  const study = getImagingStudy(id);
  if (!study) return res.status(404).json({ error: "imaging study not found" });
  const b = req.body ?? {};
  const mime = String(b.mime ?? "").toLowerCase();
  if (!IMAGING_FILE_MIMES.has(mime))
    return res.status(400).json({ error: "mime must be image/jpeg, image/png, or application/pdf" });
  const buf = imagingBuffer(b.data_base64);
  if (!buf) return res.status(400).json({ error: "valid data_base64 required" });
  if (buf.length > MAX_IMAGING_FILE_BYTES) return res.status(413).json({ error: "file exceeds 15 MB" });
  if (!imagingMimeMatches(buf, mime)) return res.status(400).json({ error: "file contents do not match mime" });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const canonicalMime = mime === "image/jpg" ? "image/jpeg" : mime;
  const filePath = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.${extForMime(canonicalMime)}`);
  try {
    fs.writeFileSync(filePath, buf, { flag: "wx" });
    const file = addImagingStudyFile({
      study_id: id,
      original_name: b.original_name,
      mime: canonicalMime,
      file_path: filePath,
      size_bytes: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      source_kind: b.source_kind,
    });
    if (file.reused) fs.rmSync(filePath, { force: true });
    res.json(file);
  } catch (error: any) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
    res.status(400).json({ error: error?.message ?? "upload failed" });
  }
});

healthDocsRouter.get("/:id/imaging-files/:fileId", (req, res) => {
  const row = getImagingStudyFileRaw(Number(req.params.id), Number(req.params.fileId)) as any;
  const filePath = safeUploadPath(row?.file_path);
  if (!row || !filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "not found" });
  const inline = isInlineMime(row.mime);
  const filename = String(row.original_name ?? `imaging-file-${row.sequence}`)
    .replace(/[\r\n"\\]/g, "_")
    .slice(0, 180);
  privateNoStore(res);
  res.setHeader(
    "Content-Type",
    row.mime === "application/dicom"
      ? row.mime
      : IMAGING_FILE_MIMES.has(row.mime)
        ? row.mime
        : "application/octet-stream"
  );
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(filePath)
    .on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "read failed" });
    })
    .pipe(res);
});

healthDocsRouter.post("/:id/imaging-analyze", (req, res) => {
  const id = Number(req.params.id);
  const study = getImagingStudy(id) as any;
  if (!study) return res.status(404).json({ error: "imaging study not found" });
  if (!study.study_files?.length) return res.status(400).json({ error: "add at least one report or image file" });
  if (!getSettings().enrich_enabled) return res.status(409).json({ error: "analysis is disabled in settings" });
  if (["pending", "in_progress"].includes(study.enrichment_status)) return res.json(study); // idempotent enqueue
  setHealthDocEnrichStatus(id, "pending");
  import("../enrich.js").then((m) => m.enqueueEnrich("health", id)).catch(() => {});
  res.json(getImagingStudy(id));
});

healthDocsRouter.put("/:id/imaging-details", (req, res) => {
  const updated = correctImagingStudy(Number(req.params.id), req.body, req.body?.notes);
  if (!updated) return res.status(400).json({ error: "valid imaging structure required" });
  res.json(updated);
});

healthDocsRouter.post("/:id/imaging-confirm", (req, res) => {
  const updated = confirmImagingStudy(Number(req.params.id), req.body?.notes);
  if (!updated) return res.status(404).json({ error: "imaging study not found" });
  res.json(updated);
});

healthDocsRouter.put("/:id/imaging-recommendations/:recommendationId/status", (req, res) => {
  if (!isImagingRecommendationStatus(req.body?.status)) {
    return res.status(400).json({ error: "invalid imaging recommendation status" });
  }
  const updated = updateImagingRecommendationStatus(
    Number(req.params.id),
    req.params.recommendationId,
    req.body?.status
  );
  if (!updated) return res.status(404).json({ error: "study or recommendation not found" });
  res.json(updated);
});

healthDocsRouter.post("/", (req, res) => {
  const b = req.body ?? {};
  if (
    normalizeHealthDocumentKind(b.kind) === "imaging" ||
    inferHealthDocumentKind({
      kind: b.kind,
      original_name: b.original_name,
      summary: b.text,
      mime: b.mime,
    }) === "imaging"
  ) {
    return res.status(400).json({ error: "use /health-docs/imaging for imaging studies" });
  }
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
    try {
      deriveDirectives();
    } catch {
      /* keep the edit path resilient */
    }
    import("../enrich.js").then((m) => m.enqueueReviewRefresh()).catch(() => {});
  }
  res.json(updated);
});

// Re-run the agentic scan over a document's original file.
healthDocsRouter.post("/:id/reanalyze", (req, res) => {
  const row = getHealthDocumentRaw(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.kind === "imaging") {
    const study = getImagingStudy(Number(req.params.id)) as any;
    if (!study?.study_files?.length) return res.status(400).json({ error: "no study files to re-analyze" });
    if (!getSettings().enrich_enabled) return res.status(409).json({ error: "analysis is disabled in settings" });
    if (["pending", "in_progress"].includes(row.enrichment_status)) return res.json(study);
    setHealthDocEnrichStatus(Number(req.params.id), "pending");
    import("../enrich.js").then((m) => m.enqueueEnrich("health", Number(req.params.id))).catch(() => {});
    return res.json(getImagingStudy(Number(req.params.id)));
  }
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
    try {
      deriveDirectives();
    } catch {
      /* keep the confirm resilient */
    }
    import("../enrich.js").then((m) => m.enqueueReviewRefresh()).catch(() => {});
  }
  res.json(result.doc ?? getHealthDocument(id));
});

healthDocsRouter.delete("/:id", (req, res) => {
  const row = getHealthDocumentRaw(Number(req.params.id)) as any;
  if (row?.kind === "imaging") {
    const result = deleteImagingStudy(Number(req.params.id)) as any;
    return result.error ? res.status(500).json(result) : res.json(result);
  }
  const result = deleteHealthDocument(Number(req.params.id));
  if ((result as any).error) return res.status(500).json(result);
  // Removing a panel WITHDRAWS what it propagated: re-derive so directives grounded in
  // markers that no longer exist are soft-resolved instead of outliving their evidence.
  try {
    deriveDirectives();
  } catch {
    /* the document is already gone; the connected brain settles on the next daily pass */
  }
  const filePath = safeUploadPath(row?.file_path);
  if (filePath) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(`${filePath}-x`, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  res.json(result);
});
