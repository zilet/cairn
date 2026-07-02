// Wave H item 4 — medication ⇄ lab interaction awareness. Medications are captured (only)
// as clinical_facts (kind 'medication') on uploaded health records; repo.activeMedications
// reads them (there is NO meds CRUD). When a marker is still off-optimal in the direction a
// med it targets should move it — LDL still high on a statin — the connected brain folds a
// "still off despite <med> → discuss dose/adherence/add-on" clause into ONE directive, so it
// reasons WITH the treatment instead of a naive untreated "cut saturated fat". INFORMATIONAL.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile");
});

// Seed a lab panel that also carries a MyChart-style medication list.
function seedPanelWithMeds(markers, meds) {
  return repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-06-30",
    enrichment_status: "done",
    parsed_json: { markers, clinical_facts: meds.map((m) => ({ kind: "medication", ...m })) },
  });
}

const augmented = (d) => /you're already on/i.test(String(d.directive || ""));

test("activeMedications reads the med list and drops discontinued/inactive entries", () => {
  seedPanelWithMeds([], [
    { name: "Atorvastatin 40mg", status: "active" },
    { name: "Metoprolol", status: "discontinued" },
    { name: "Lisinopril", status: null },
  ]);
  const meds = repo.activeMedications().map((m) => m.name).sort();
  assert.deepEqual(meds, ["Atorvastatin 40mg", "Lisinopril"]);
});

test("medsTreatingZone only matches the direction the med treats", () => {
  const statin = [{ name: "Atorvastatin" }];
  assert.equal(repo.medsTreatingZone("LDL-C", "high", statin)?.label, "a statin");
  assert.equal(repo.medsTreatingZone("LDL-C", "low", statin), null, "a statin doesn't 'treat' a low LDL");
  assert.equal(repo.medsTreatingZone("HbA1c", "high", [{ name: "Metformin" }])?.label, "metformin");
  assert.equal(repo.medsTreatingZone("Systolic BP", "high", [{ name: "Lisinopril 10mg" }])?.label, "a blood-pressure medication");
  assert.equal(repo.medsTreatingZone("LDL-C", "high", [{ name: "Ibuprofen" }]), null, "an unrelated med doesn't match");
});

test("LDL still high on a statin reasons WITH the med (dose/adherence, not just diet)", () => {
  seedPanelWithMeds(
    [marker("LDL-C", 150, { unit: "mg/dL", flag: "high" }), marker("ApoB", 115, { unit: "mg/dL", flag: "high" })],
    [{ name: "Atorvastatin 40mg", status: "active" }],
  );
  repo.deriveDirectives();
  const active = repo.listActiveDirectives();
  const ldlWatch = active.find((d) => d.marker === "LDL-C" && d.domain === "watch");
  assert.ok(ldlWatch, "LDL-C watch directive exists");
  assert.ok(augmented(ldlWatch), "the watch directive names the statin");
  assert.match(ldlWatch.directive, /Atorvastatin/);
  assert.match(ldlWatch.directive, /dose|adherence|add-on/i);
  assert.equal(!!ldlWatch.uncertain, true, "med reasoning is a softer, uncertain nudge");
});

test("the med note lands on exactly ONE directive per marker (not repeated across domains)", () => {
  seedPanelWithMeds(
    [marker("LDL-C", 150, { unit: "mg/dL", flag: "high" })],
    [{ name: "Rosuvastatin", status: "active" }],
  );
  repo.deriveDirectives();
  const ldl = repo.listActiveDirectives().filter((d) => d.marker === "LDL-C");
  assert.equal(ldl.filter(augmented).length, 1, "exactly one LDL directive carries the med note");
  // the nutrition lever is still present but NOT rewritten (lifestyle still helps).
  const nut = ldl.find((d) => d.domain === "nutrition");
  assert.ok(nut && !augmented(nut), "the nutrition directive is left untouched");
});

test("no medication → no augmentation (control)", () => {
  seedHealthDoc("2026-06-30", [marker("LDL-C", 150, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  assert.equal(repo.listActiveDirectives().some(augmented), false, "nothing reasons about a med when none is recorded");
});

test("an on-target marker on the med gets NO med note (only fires when still off-optimal)", () => {
  seedPanelWithMeds(
    [marker("LDL-C", 70, { unit: "mg/dL" })], // within the optimal band
    [{ name: "Atorvastatin 40mg", status: "active" }],
  );
  repo.deriveDirectives();
  assert.equal(repo.listActiveDirectives().some((d) => d.marker === "LDL-C"), false, "an at-target LDL fires nothing at all");
});
