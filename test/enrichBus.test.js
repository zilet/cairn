import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { onEnrichEvent, emitEnrichTransition, isEnrichActive, isEnrichTerminal } from "../dist/enrichBus.js";

// The pure decision the SSE handler makes: keep streaming only while a row is
// actively enriching; everything else is terminal (the handler ends after the
// snapshot / the current transition). Mirrors the client's enrichmentActive().
test("isEnrichActive / isEnrichTerminal: only pending + in_progress keep a stream open", () => {
  for (const active of ["pending", "in_progress"]) {
    assert.equal(isEnrichActive(active), true, `${active} is active`);
    assert.equal(isEnrichTerminal(active), false, `${active} is not terminal`);
  }
  for (const done of ["done", "failed", "skipped", "pending_confirm", null, undefined, ""]) {
    assert.equal(isEnrichActive(done), false, `${String(done)} is not active`);
    assert.equal(isEnrichTerminal(done), true, `${String(done)} is terminal`);
  }
});

test("emitEnrichTransition delivers the row + derived status to a subscriber, and unsubscribe stops it", () => {
  const seen = [];
  const off = onEnrichEvent("activity", 42, (e) => seen.push(e));

  emitEnrichTransition("activity", 42, { id: 42, enrichment_status: "in_progress", type: "run" });
  emitEnrichTransition("activity", 42, { id: 42, enrichment_status: "done", type: "run", duration_min: 30 });

  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((e) => e.status),
    ["in_progress", "done"]
  );
  assert.equal(seen[0].kind, "activity");
  assert.equal(seen[0].id, 42);
  assert.equal(seen[1].row.duration_min, 30, "carries the fresh row payload");

  off();
  emitEnrichTransition("activity", 42, { id: 42, enrichment_status: "failed" });
  assert.equal(seen.length, 2, "no events after unsubscribe");
});

test("subscriptions are isolated by kind AND id (activity#7 never hears food#7)", () => {
  const act = [];
  const food = [];
  const offA = onEnrichEvent("activity", 7, (e) => act.push(e));
  const offF = onEnrichEvent("food", 7, (e) => food.push(e));

  emitEnrichTransition("food", 7, { id: 7, enrichment_status: "done" });
  emitEnrichTransition("activity", 9, { id: 9, enrichment_status: "done" }); // different id

  assert.equal(food.length, 1);
  assert.equal(act.length, 0, "wrong kind never delivered");
  offA();
  offF();
});

test("a null/deleted row emits a terminal (null) status so a subscriber can never wait forever", () => {
  const seen = [];
  const off = onEnrichEvent("food", 5, (e) => seen.push(e));
  emitEnrichTransition("food", 5, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, null);
  assert.equal(isEnrichTerminal(seen[0].status), true);
  off();
});

// The emit is wired into the repo status SETTERS — the choke point every write
// flows through. This proves the queue path (and any caller) wakes a subscriber
// with the FRESH public row, not a stale one.
test("setFoodNoteEnrichStatus emits the fresh hydrated public row", () => {
  repo.setSettings({ enrich_enabled: false }); // no background queue in the way
  const note = repo.addFoodNote("lunch", "chicken and rice", { kcal: 500, protein_g: 40 });
  const seen = [];
  const off = onEnrichEvent("food", note.id, (e) => seen.push(e));

  repo.setFoodNoteEnrichStatus(note.id, "in_progress");
  repo.setFoodNoteEnrichStatus(note.id, "done");
  off();

  assert.equal(seen.length, 2);
  assert.equal(seen[0].status, "in_progress");
  assert.equal(seen[1].status, "done");
  assert.equal(seen[1].row.enrichment_status, "done");
  assert.equal(seen[1].row.parsed.kcal, 500, "hydrated parsed blob rides along");
});

// A health doc's public shape must NEVER leak the raw file_path — the SSE handler
// streams getHealthDocument, so the emitted row must be the public one too.
test("setHealthDocEnrichStatus emits the PUBLIC health-doc shape (no file_path)", () => {
  repo.setSettings({ enrich_enabled: false });
  const doc = repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-07-01",
    original_name: "labs.pdf",
    mime: "application/pdf",
    file_path: "/some/absolute/uploads/labs.pdf",
    enrichment_status: "pending",
  });
  const seen = [];
  const off = onEnrichEvent("health", doc.id, (e) => seen.push(e));

  repo.setHealthDocEnrichStatus(doc.id, "done");
  off();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, "done");
  assert.ok(seen[0].row && typeof seen[0].row === "object");
  assert.equal("file_path" in seen[0].row, false, "public shape must not carry file_path");
});

// The manual food correction stamps enrichment_status 'done' OUTSIDE the queue/
// setter (a direct UPDATE). It must still emit, or a Fuel-card SSE watcher would
// wait forever on a row it just corrected.
test("updateFoodNote (out-of-queue manual edit) emits a terminal transition", () => {
  repo.setSettings({ enrich_enabled: false });
  const note = repo.addFoodNote("dinner", "big salad", { kcal: 100 });
  repo.setFoodNoteEnrichStatus(note.id, "pending"); // pretend it's mid-enrich
  const seen = [];
  const off = onEnrichEvent("food", note.id, (e) => seen.push(e));

  repo.updateFoodNote(note.id, { kcal: 321 });
  off();

  assert.ok(seen.length >= 1);
  const last = seen[seen.length - 1];
  assert.equal(last.status, "done");
  assert.equal(last.row.parsed.kcal, 321);
});
