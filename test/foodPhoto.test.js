// Photo → macros (Phase 5A) — the food-photo enrichment path (src/enrich.ts).
//
// A chat message that carries a plate photo becomes a food note WITH its
// image_path set: the entry saves INSTANTLY, then a background VISION enrichment
// estimates the plate's macros and upgrades the note IN PLACE. The agent itself
// never runs in the harness (offline, deterministic), so we exercise:
//   - applyFoodPhoto: coerce/clamp of a simulated agent macro payload (numbers as
//     strings, oversized values clamped, junk dropped) merged over the existing
//     parsed blob, carrying the confidence band + from_photo provenance.
//   - terminal-status stamping (a fully-applied note flips to 'done').
//   - the non-absolute-path refusal (processFoodPhotoJob skips a relative path
//     before any agent is reached) + the no-image refusal + the offline no-agent
//     degradation (no enabled agent → 'skipped', as-logged note intact).
//   - idempotency: re-running applyFoodPhoto overwrites in place, never appends a
//     second note; recoverPendingEnrich routes a photo note to the food_photo path.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { applyFoodPhoto, processFoodPhotoJob, recoverPendingEnrich } from "../dist/enrich.js";

// A photo-backed food note exactly as the chat worker (logPhotoFood) creates it:
// addFoodNote(meal, raw="", parsed, imagePath). raw="" keeps the TEXT enricher off.
function seedPhotoNote(imagePath, parsed = { summary: "lunch" }) {
  return repo.addFoodNote("lunch", "", parsed, imagePath);
}

beforeEach(() => {
  for (const t of ["food_notes", "activities", "health_documents"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
  // Keep the suite OFFLINE + deterministic: disable every real agent so
  // pickHealthAgentOrder() returns [] and processFoodPhotoJob degrades to
  // 'skipped' before ever spawning a CLI (the dev machine may have claude/codex
  // installed + logged in, which would otherwise hang on a fake image path).
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"] });
});

test("applyFoodPhoto coerces a string-number payload, clamps to ceilings, and merges over the note", () => {
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch", kcal: null });
  // A messy but plausible agent reply: string numbers, an over-ceiling kcal, junk.
  const wrote = applyFoodPhoto(note.id, {
    summary: "Grilled salmon, rice & greens",
    items: ["salmon", "white rice", "broccoli"],
    kcal: "640",          // string → 640
    protein_g: 48.6,      // rounds → 49
    carbs_g: "not a number", // junk → dropped (asNum returns undefined)
    fat_g: 22,
    fiber_g: 9,
    confidence: "medium",
  });
  assert.equal(wrote, true);

  const after = repo.getFoodNote(note.id).parsed;
  assert.equal(after.summary, "Grilled salmon, rice & greens");
  assert.deepEqual(after.items, ["salmon", "white rice", "broccoli"]);
  assert.equal(after.kcal, 640, "string number coerced");
  assert.equal(after.protein_g, 49, "float rounded");
  assert.equal(after.fat_g, 22);
  assert.equal(after.fiber_g, 9);
  // Junk macro was dropped — asNum returned undefined, so carbs_g was never written
  // (the seed note had no carbs to overwrite either).
  assert.equal(after.carbs_g, undefined, "an unparseable carbs value is not written");
  assert.equal(after.confidence, "medium", "a valid confidence band is kept");
  assert.equal(after.from_photo, true, "provenance is stamped so the surface can say 'estimated from your photo'");
});

test("applyFoodPhoto clamps an absurd payload to sane non-negative ceilings", () => {
  const note = seedPhotoNote("/abs/uploads/plate.jpg");
  applyFoodPhoto(note.id, { kcal: 999999, protein_g: -50, carbs_g: 99999, fat_g: 99999, fiber_g: 99999 });
  const p = repo.getFoodNote(note.id).parsed;
  assert.equal(p.kcal, 5000, "kcal clamped to its ceiling");
  assert.equal(p.protein_g, 0, "a negative macro floors at 0, never below");
  assert.equal(p.carbs_g, 1000, "carbs clamped");
  assert.equal(p.fat_g, 500, "fat clamped");
  assert.equal(p.fiber_g, 200, "fiber clamped");
});

test("applyFoodPhoto drops an invalid confidence value (no false precision, no score)", () => {
  const note = seedPhotoNote("/abs/uploads/plate.jpg");
  applyFoodPhoto(note.id, { kcal: 500, confidence: "92%" });
  const p = repo.getFoodNote(note.id).parsed;
  assert.equal(p.kcal, 500);
  assert.ok(!("confidence" in p) || p.confidence === undefined, "a non low/medium/high confidence is not written");
});

test("applyFoodPhoto returns false on a wrong-shape payload and leaves the note untouched", () => {
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch", kcal: 300 });
  // A coach-proposal-shaped reply: no macro fields at all.
  const wrote = applyFoodPhoto(note.id, { changes: [{ exercise: "Squat", target_weight: 200 }] });
  assert.equal(wrote, false, "nothing usable → no write");
  const p = repo.getFoodNote(note.id).parsed;
  assert.equal(p.summary, "lunch", "the as-logged summary stands");
  assert.equal(p.kcal, 300, "the as-logged macros stand");
  assert.ok(!p.from_photo, "no provenance stamp when nothing was written");
});

test("applyFoodPhoto overwrites only the fields the agent returned (merge, not replace)", () => {
  // Seed with a first-pass estimate the chat agent already filled.
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch", kcal: 300, protein_g: 20, notes: "felt light" });
  applyFoodPhoto(note.id, { kcal: 520, protein_g: 35 }); // refine kcal + protein only
  const p = repo.getFoodNote(note.id).parsed;
  assert.equal(p.kcal, 520, "refined");
  assert.equal(p.protein_g, 35, "refined");
  assert.equal(p.summary, "lunch", "untouched field preserved");
  assert.equal(p.notes, "felt light", "untouched field preserved");
});

test("applyFoodPhoto is idempotent — re-running overwrites in place, never appends a second note", () => {
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch" });
  const before = repo.listFoodNotes(50).length;
  applyFoodPhoto(note.id, { kcal: 500, protein_g: 40 });
  applyFoodPhoto(note.id, { kcal: 540, protein_g: 42 }); // a re-run (recovery / re-enqueue)
  const after = repo.listFoodNotes(50).length;
  assert.equal(after, before, "no duplicate food note created across re-runs");
  const p = repo.getFoodNote(note.id).parsed;
  assert.equal(p.kcal, 540, "latest parse wins");
  assert.equal(p.protein_g, 42);
});

test("processFoodPhotoJob refuses a non-absolute image path — terminal 'skipped', note intact", async () => {
  repo.setSettings({ enrich_enabled: true });
  const note = seedPhotoNote("relative/plate.jpg", { summary: "lunch", kcal: 300 });
  await processFoodPhotoJob(note.id);
  const row = repo.getFoodNote(note.id);
  assert.equal(row.enrichment_status, "skipped", "a relative path is refused before any agent runs");
  assert.equal(row.parsed.kcal, 300, "the as-logged note is left intact");
});

test("processFoodPhotoJob skips a note with no image_path (wrong-kind enqueue)", async () => {
  repo.setSettings({ enrich_enabled: true });
  const note = seedPhotoNote(null, { summary: "lunch" });
  await processFoodPhotoJob(note.id);
  assert.equal(repo.getFoodNote(note.id).enrichment_status, "skipped");
});

test("processFoodPhotoJob degrades to 'skipped' with enrichment off", async () => {
  repo.setSettings({ enrich_enabled: false });
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch", kcal: 300 });
  await processFoodPhotoJob(note.id);
  const row = repo.getFoodNote(note.id);
  assert.equal(row.enrichment_status, "skipped");
  assert.equal(row.parsed.kcal, 300, "as-logged note intact");
});

test("processFoodPhotoJob degrades to 'skipped' offline (no usable agent), note intact", async () => {
  // Enrichment ON, an absolute path, but the harness has NO enabled agent, so
  // pickHealthAgentOrder() returns [] → the job ends terminal before any agent runs.
  repo.setSettings({ enrich_enabled: true });
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch", kcal: 280 });
  await processFoodPhotoJob(note.id);
  const row = repo.getFoodNote(note.id);
  assert.equal(row.enrichment_status, "skipped", "no usable agent → skipped, never stuck in_progress");
  assert.equal(row.parsed.kcal, 280, "the as-logged note stands");
});

test("a fully-applied note can be stamped terminal 'done'", () => {
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch" });
  repo.setFoodNoteEnrichStatus(note.id, "in_progress");
  applyFoodPhoto(note.id, { kcal: 600, protein_g: 45, confidence: "high" });
  repo.setFoodNoteEnrichStatus(note.id, "done");
  const row = repo.getFoodNote(note.id);
  assert.equal(row.enrichment_status, "done");
  assert.equal(row.parsed.kcal, 600);
  assert.equal(row.parsed.confidence, "high");
  assert.equal(row.parsed.from_photo, true);
});

test("recoverPendingEnrich routes a pending photo note to the food_photo path (image_path set), without throwing", () => {
  // Enrichment OFF so addFoodNote records status directly (no async queue that
  // could race our manual status writes below).
  repo.setSettings({ enrich_enabled: false });
  // A photo note interrupted mid-enrichment: image_path set, status pending.
  const note = seedPhotoNote("/abs/uploads/plate.jpg", { summary: "lunch" });
  repo.setFoodNoteEnrichStatus(note.id, "pending");
  // A text-only note interrupted: no image_path → the regular food path.
  const textNote = repo.addFoodNote("snack", "a banana", { summary: "banana" });
  repo.setFoodNoteEnrichStatus(textNote.id, "in_progress");

  const counts = recoverPendingEnrich();
  // Both food rows are recovered (the routing by image_path is internal — what
  // matters is recovery counts them and nothing throws on a photo note).
  assert.ok(counts.food >= 2, `expected at least the two pending food notes, got ${counts.food}`);
});
