// symptom-links.ts — the deterministic symptom → off-marker reasoning engine. A
// logged symptom (a context_event / check-in note) connects to a plausibly-related
// out-of-range marker sitting in the same window, as ONE quiet clinician-referral
// note. CONSTITUTION: informational not diagnostic, never invents a value, [] when
// nothing co-occurs, and the KB is directional (a symptom links to the clinically
// plausible side of off-optimal).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "context_events", "blood_pressure_readings", "checkins");
});

// A minimal prioritized-marker shape (exactly what findOffMarker reads), so these
// stay fully offline + directionally controlled.
const mk = (name, value, { unit = null, flag = null, in_optimal = false } = {}) => ({
  name, unit, in_optimal, latest: { value, flag },
});
const ev = (over = {}) => ({ kind: "life_event", title: null, detail: null, start_date: null, end_date: null, meta: null, archived: 0, ...over });

test("links a blurry-vision note to an elevated blood pressure (the headline gap)", () => {
  const links = repo.symptomMarkerLinks({
    events: [ev({ title: "Head blurriness on walks" })],
    markers: [mk("Systolic BP", 144, { unit: "mmHg", flag: "high" })],
    includeCheckins: false,
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].symptom, "blurry vision");
  assert.equal(links[0].markers[0].name, "Systolic BP");
  assert.equal(links[0].markers[0].side, "high");
  assert.equal(links[0].markers[0].value, 144);
  assert.equal(links[0].symptom_source, "context_event");
  // Informational, never diagnostic (constitution).
  assert.match(links[0].note, /clinician/i);
  assert.match(links[0].note, /blurry vision/);
  assert.doesNotMatch(links[0].note, /you have|diagnos|disease/i);
  // No score anywhere in the link.
  for (const m of links[0].markers) assert.ok(!("score" in m) && !("grade" in m));
});

test("links ongoing fatigue to low ferritin (directional, low-side)", () => {
  const links = repo.symptomMarkerLinks({
    events: [ev({ title: "Wiped out lately", detail: "no energy, always tired" })],
    markers: [mk("Ferritin", 18, { unit: "ng/mL", flag: "low" })],
    includeCheckins: false,
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].symptom, "ongoing fatigue");
  assert.equal(links[0].markers[0].name, "Ferritin");
  assert.equal(links[0].markers[0].side, "low");
  assert.match(links[0].note, /low Ferritin/);
});

test("a symptom with no related off-marker stays silent", () => {
  const links = repo.symptomMarkerLinks({
    events: [ev({ title: "leg cramps after the long run" })],
    markers: [mk("Magnesium", 2.3, { unit: "mg/dL", flag: "normal", in_optimal: true })],
    includeCheckins: false,
  });
  assert.deepEqual(links, []);
});

test("an off-marker with no symptom mention stays silent", () => {
  const links = repo.symptomMarkerLinks({
    events: [ev({ title: "Easy bike ride", detail: "felt great" })],
    markers: [mk("Ferritin", 18, { flag: "low" })],
    includeCheckins: false,
  });
  assert.deepEqual(links, []);
});

test("directional guard: a HIGH magnesium does NOT link to cramps (a low-side symptom)", () => {
  const links = repo.symptomMarkerLinks({
    events: [ev({ title: "bad leg cramps" })],
    markers: [mk("Magnesium", 3.2, { unit: "mg/dL", flag: "high" })],
    includeCheckins: false,
  });
  assert.deepEqual(links, []);
});

test("a LOW magnesium DOES link to cramps", () => {
  const links = repo.symptomMarkerLinks({
    events: [ev({ title: "bad leg cramps" })],
    markers: [mk("Magnesium", 1.5, { unit: "mg/dL", flag: "low" })],
    includeCheckins: false,
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].symptom, "muscle cramps");
  assert.equal(links[0].markers[0].side, "low");
});

test("reads a check-in note as a symptom source", () => {
  const links = repo.symptomMarkerLinks({
    events: [],
    checkins: [{ date: "2026-06-20", note: "tingling in my feet again" }],
    markers: [mk("Vitamin B12", 250, { unit: "pg/mL", flag: "low" })],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].symptom, "tingling or numbness");
  assert.equal(links[0].symptom_source, "checkin");
  assert.equal(links[0].symptom_source_date, "2026-06-20");
});

test("never invents a value: with no markers there are no links", () => {
  const links = repo.symptomMarkerLinks({ events: [ev({ title: "dizzy and blurry" })], markers: [], includeCheckins: false });
  assert.deepEqual(links, []);
});

test("emits one link per distinct symptom and honors the cap", () => {
  const markers = [
    mk("Ferritin", 18, { flag: "low" }),
    mk("Systolic BP", 145, { unit: "mmHg", flag: "high" }),
  ];
  const events = [
    ev({ title: "constantly tired", start_date: "2026-06-22" }),
    ev({ title: "lots of headaches", start_date: "2026-06-23" }),
  ];
  const all = repo.symptomMarkerLinks({ events, markers, includeCheckins: false });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((l) => l.symptom).sort(), ["headaches", "ongoing fatigue"]);
  const capped = repo.symptomMarkerLinks({ events, markers, includeCheckins: false, max: 1 });
  assert.equal(capped.length, 1);
});

test("DB-backed: a blurriness note + a 144/95 BP reading connect end-to-end", () => {
  repo.addBloodPressureReading({ measured_at: "2026-06-24T08:00", systolic: 144, diastolic: 95 });
  repo.addContextEvent({ kind: "life_event", title: "Head blurriness on walks" });
  const links = repo.symptomMarkerLinks({ date: "2026-06-24" });
  const blurry = links.find((l) => l.symptom === "blurry vision");
  assert.ok(blurry, "the symptom links to the elevated BP through the real readings");
  assert.ok(blurry.markers.some((m) => m.name === "Systolic BP" && m.side === "high"));
  assert.match(blurry.note, /clinician/i);
});
