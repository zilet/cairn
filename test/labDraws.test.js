// One row per draw (src/repo/lab-draws.ts). One lab draw reaches the record as the
// uploaded file plus the panels a CCDA import split out of it, so a list that drew one
// row per document showed "Aug 24 · Bloodwork" three times on the Season. The draws read
// is one row per (kind, date) — survivor the uploaded source — served at
// GET /api/health-docs/draws and list_lab_draws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { labDraws } from "../dist/repo/lab-draws.js";
import { healthDocsRouter } from "../dist/routes/health-docs.js";

function insertDoc({ kind, doc_date, source_doc_id = null, summary = "" }) {
  const info = db
    .prepare(
      `INSERT INTO health_documents (kind, doc_date, source_doc_id, summary, enrichment_status, created_at)
       VALUES (?, ?, ?, ?, 'done', datetime('now'))`
    )
    .run(kind, doc_date, source_doc_id, summary);
  return Number(info.lastInsertRowid);
}

test("one draw, three documents: one row, the upload first", () => {
  const upload = insertDoc({ kind: "bloodwork", doc_date: "2025-08-24", summary: "MyChart export" });
  const results = insertDoc({ kind: "bloodwork", doc_date: "2025-08-24", source_doc_id: upload, summary: "CCDA results" });
  const vitals = insertDoc({ kind: "bloodwork", doc_date: "2025-08-24", source_doc_id: upload, summary: "CCDA vitals" });
  const dexa = insertDoc({ kind: "dexa", doc_date: "2025-08-24" });
  insertDoc({ kind: "bloodwork", doc_date: "2026-03-02" });
  insertDoc({ kind: "other", doc_date: "2026-03-02" });

  const rows = labDraws({ today: "2026-10-06" });
  const aug = rows.filter((r) => r.date === "2025-08-24" && r.kind === "bloodwork");
  assert.equal(aug.length, 1, "one bloodwork row for the Aug 24 draw");
  assert.equal(aug[0].doc_id, upload, "the uploaded source opens");
  assert.deepEqual(new Set(aug[0].doc_ids), new Set([upload, results, vitals]));
  assert.equal(aug[0].date_words, "Aug 24, 2025");
  assert.equal(aug[0].label, "Bloodwork");
  assert.ok(rows.some((r) => r.kind === "dexa" && r.doc_id === dexa), "a scan the same day is its own row");
  assert.ok(!rows.some((r) => r.kind === "other"), "only the labs-and-scans kinds");
  assert.deepEqual(
    rows.map((r) => r.date),
    [...rows.map((r) => r.date)].sort().reverse(),
    "newest first"
  );
  const keys = rows.map((r) => `${r.kind}|${r.date}`);
  assert.equal(new Set(keys).size, keys.length, "never the same draw twice");
});

test("GET /health-docs/draws answers the same rows", async () => {
  insertDoc({ kind: "bloodwork", doc_date: "2025-08-24" });
  insertDoc({ kind: "bloodwork", doc_date: "2025-08-24" });
  const layer = healthDocsRouter.stack.find((l) => l.route?.path === "/draws" && l.route.methods.get);
  assert.ok(layer, "routed");
  const paths = healthDocsRouter.stack.filter((l) => l.route?.methods.get).map((l) => l.route.path);
  assert.ok(paths.indexOf("/draws") < paths.indexOf("/:id"), "ahead of /:id");
  const body = await new Promise((resolve) => layer.route.stack.at(-1).handle({ query: {} }, { json: resolve }));
  assert.equal(body.filter((r) => r.date === "2025-08-24").length, 1);
});
