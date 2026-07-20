// Chat as a first-class lab path (Wave I items 1 & 2). A SUBSTANTIAL pasted panel is a
// big write, so it follows propose→apply: it becomes a pending_confirm draft the user
// confirms, and confirming routes it through the completeness-first, Claude-first health
// ingest (item 1) — NOT the round-robin chat agent. A small inline mention still applies
// directly. The agent never runs in the harness, so we exercise the deterministic
// draft-vs-direct split + the confirm state machine offline.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { applyChatActions, isSubstantialLabPaste, CHAT_LAB_CONFIRM_MIN } from "../dist/chatTurns.js";
import { CHAT_LOG_HEALTH_KIND_SCHEMA, normalizeChatAction } from "../dist/chatActions.js";

beforeEach(() => {
  for (const t of ["health_documents", "health_directives", "chat_messages", "chat_turns", "memory"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
});

// A bulk value-per-line paste (what a Function Health / MyChart export looks like).
function bulkPasteMessage() {
  return [
    "LDL Cholesterol", "128 mg/dL",
    "HDL Cholesterol", "52 mg/dL",
    "Triglycerides", "96 mg/dL",
    "ApoB", "98 mg/dL",
    "Glucose, Fasting", "88 mg/dL",
    "Hemoglobin A1c", "5.4 %",
    "Ferritin", "120 ng/mL",
    "Vitamin D", "42 ng/mL",
    "TSH", "1.8 uIU/mL",
    "hs-CRP", "0.6 mg/L",
  ].join("\n");
}

function bulkMarkers() {
  return [
    { name: "LDL-C", value: 128, unit: "mg/dL", flag: "high" },
    { name: "HDL-C", value: 52, unit: "mg/dL", flag: "normal" },
    { name: "Triglycerides", value: 96, unit: "mg/dL", flag: "normal" },
    { name: "ApoB", value: 98, unit: "mg/dL", flag: "high" },
    { name: "Fasting glucose", value: 88, unit: "mg/dL", flag: "normal" },
    { name: "HbA1c", value: 5.4, unit: "%", flag: "normal" },
    { name: "Ferritin", value: 120, unit: "ng/mL", flag: "normal" },
    { name: "Vitamin D", value: 42, unit: "ng/mL", flag: "normal" },
    { name: "TSH", value: 1.8, unit: "uIU/mL", flag: "normal" },
    { name: "hs-CRP", value: 0.6, unit: "mg/L", flag: "normal" },
  ];
}

test("isSubstantialLabPaste: a bulk value-per-line paste clears the bar; a one-liner does not", () => {
  assert.equal(isSubstantialLabPaste(bulkPasteMessage()), true, "many value lines → substantial");
  assert.equal(isSubstantialLabPaste("my ldl was 90"), false, "an inline mention is not");
  // The agent's own marker count is a secondary signal (covers a one-line-per-marker paste
  // the line estimator misses).
  const many = Array.from({ length: CHAT_LAB_CONFIRM_MIN }, () => ({ name: "X", value: 1 }));
  assert.equal(isSubstantialLabPaste("short text", many.length), true, "enough extracted markers → substantial");
  assert.equal(isSubstantialLabPaste("short text", 2), false, "a couple markers is not");
});

test("a substantial pasted panel becomes a pending_confirm DRAFT — nothing writes to Health yet", () => {
  const { applied, drafts, labConfirms } = applyChatActions(
    { actions: [{ type: "log_health", kind: "bloodwork", summary: "recent panel", markers: bulkMarkers() }] },
    { agent: "stub", message: bulkPasteMessage() },
  );
  assert.deepEqual(applied, [], "nothing applied immediately");
  assert.deepEqual(drafts, [], "not a plan draft");
  assert.equal(labConfirms.length, 1, "one lab confirm draft is offered");
  assert.equal(typeof labConfirms[0].id, "number");
  assert.ok(labConfirms[0].marker_estimate >= CHAT_LAB_CONFIRM_MIN, "the estimate is surfaced");

  // The markers must NOT be in the trend view yet (propose→apply — nothing committed).
  assert.equal(repo.getMarkerHistory().markers.length, 0, "no markers leak before confirm");
  // And the pending draft is hidden from the Records list until confirmed.
  assert.equal(repo.listHealthDocuments().length, 0, "the pending draft does not clutter Records");
  // But the row exists as a pending_confirm draft (with the raw text on disk to re-ingest).
  const raw = repo.getHealthDocumentRaw(labConfirms[0].id);
  assert.equal(raw.enrichment_status, "pending_confirm");
  assert.equal(raw.mime, "text/plain");
  assert.ok(raw.file_path, "the raw paste is persisted to re-ingest on confirm");
});

test("confirming with a reachable transcriber routes to the health ingest queue (item 1), not inline apply", () => {
  const { labConfirms } = applyChatActions(
    { actions: [{ type: "log_health", kind: "bloodwork", markers: bulkMarkers() }] },
    { agent: "stub", message: bulkPasteMessage() },
  );
  const id = labConfirms[0].id;
  // Inject a reachable faithful transcriber (enrichment on + a usable health agent).
  const res = repo.confirmPendingLab(id, { enrichOn: true, hasAgent: true });
  assert.equal(res.ok, true);
  assert.equal(res.enqueue, true, "hands off to the completeness-first, Claude-first health ingest");
  assert.equal(res.committed, false, "markers are NOT committed inline — the ingest transcribes them");
  assert.equal(repo.getHealthDocumentRaw(id).enrichment_status, "pending", "flipped to the health enrich queue's pending state");
  // The pure routing decision the confirm rests on.
  assert.equal(repo.labConfirmCanTranscribe(true, true), true);
  assert.equal(repo.labConfirmCanTranscribe(false, true), false, "enrichment off → cannot transcribe");
  assert.equal(repo.labConfirmCanTranscribe(true, false), false, "no agent → cannot transcribe");
});

test("confirming with NO transcriber gracefully commits the chat agent's inline markers", () => {
  const { labConfirms } = applyChatActions(
    { actions: [{ type: "log_health", kind: "bloodwork", summary: "recent panel", markers: bulkMarkers() }] },
    { agent: "stub", message: bulkPasteMessage() },
  );
  const id = labConfirms[0].id;
  const res = repo.confirmPendingLab(id, { enrichOn: false, hasAgent: false });
  assert.equal(res.ok, true);
  assert.equal(res.committed, true, "degrade path committed the inline markers so results aren't lost");
  assert.equal(res.enqueue, false);
  assert.equal(repo.getHealthDocumentRaw(id).enrichment_status, "done");
  // Now the markers ARE in the trend view and the doc shows in Records.
  const hist = repo.getMarkerHistory();
  assert.ok(hist.markers.some((m) => /apob/i.test(m.name)), "committed markers reach the trend view");
  assert.ok(repo.listHealthDocuments().some((d) => d.id === id), "the confirmed doc appears in Records");
});

test("confirmPendingLab is idempotent and 404-safe", () => {
  assert.deepEqual(repo.confirmPendingLab(999999), { ok: false, reason: "not found" });
  const { labConfirms } = applyChatActions(
    { actions: [{ type: "log_health", kind: "bloodwork", markers: bulkMarkers() }] },
    { agent: "stub", message: bulkPasteMessage() },
  );
  const id = labConfirms[0].id;
  repo.confirmPendingLab(id, { enrichOn: false, hasAgent: false }); // → done
  const again = repo.confirmPendingLab(id, { enrichOn: true, hasAgent: true });
  assert.equal(again.ok, true, "a non-pending_confirm doc is returned unchanged");
  assert.equal(again.enqueue, false, "no re-enqueue");
  assert.equal(repo.getHealthDocumentRaw(id).enrichment_status, "done", "stays committed");
});

test("a small inline lab mention still applies directly (no confirm friction)", () => {
  const { applied, labConfirms } = applyChatActions(
    { actions: [{ type: "log_health", kind: "bloodwork", summary: "ldl 90", markers: [{ name: "LDL-C", value: 90, unit: "mg/dL", flag: "normal" }] }] },
    { agent: "stub", message: "my ldl came back at 90" },
  );
  assert.equal(labConfirms.length, 0, "not a bulk paste → no draft");
  assert.equal(applied.length, 1, "applied immediately");
  assert.equal(applied[0].type, "log_health");
  assert.ok(repo.getMarkerHistory().markers.some((m) => /ldl/i.test(m.name)), "the single marker is live at once");
});

test("chat log_health excludes imaging from schema, normalization, and application", () => {
  assert.doesNotMatch(CHAT_LOG_HEALTH_KIND_SCHEMA, /(?:^|\|)imaging(?:\||$)/);
  assert.equal(normalizeChatAction({ type: "log_health", kind: "imaging", summary: "forged" }), null);
  assert.equal(normalizeChatAction({ type: "log_health", kind: "MRI", summary: "forged alias" }), null);
  assert.equal(normalizeChatAction({ type: "log_health", kind: "x-ray", summary: "forged alias" }), null);
  assert.equal(normalizeChatAction({ type: "log_health", kind: "not-a-real-kind" }), null);
  assert.equal(normalizeChatAction({ type: "log_health" }), null);
  assert.equal(normalizeChatAction({ type: "log_health", kind: "DEXA", markers: [] }).kind, "dexa");

  const before = repo.listHealthDocuments().length;
  for (const kind of ["imaging", "MRI", "x-ray", "radiology"]) {
    const out = applyChatActions(
      { actions: [{ type: "log_health", kind, summary: "must use Records imaging flow", markers: [] }] },
      { agent: "stub", message: "Here is my imaging report." },
    );
    assert.deepEqual(out.applied, [], `${kind} was rejected before the health-document write path`);
  }
  assert.equal(repo.listHealthDocuments().length, before, "no malformed imaging health_documents row was created");
});
