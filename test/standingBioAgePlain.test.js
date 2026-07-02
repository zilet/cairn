// Bio-age as PLAIN LANGUAGE, not a number (src/repo/standing.ts). The Standing hero
// used to render a bold bio-age NUMBER and, when no lab bio-age existed, a FABRICATED
// composite (signal_age) shown AS a number — a constitution violation (no scores on
// the athlete). The hero now leads with direction + a plain-language read; the
// composite is NEVER surfaced as the hero number. A deterministic Levine PhenoAge can
// anchor direction from the panel, presented in plain language only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile", "bodyweight_log", "blood_pressure_readings");
});

const HEALTHY_PANEL = [
  { name: "Albumin", latest: { value: 4.7 } },
  { name: "Creatinine", latest: { value: 0.9 } },
  { name: "Glucose", latest: { value: 85 } },
  { name: "hs-CRP", latest: { value: 0.3 } },
  { name: "Lymphocyte %", latest: { value: 35 } },
  { name: "MCV", latest: { value: 88 } },
  { name: "RDW", latest: { value: 12.5 } },
  { name: "Alkaline Phosphatase", latest: { value: 55 } },
  { name: "WBC", latest: { value: 5.0 } },
];
const UNHEALTHY_PANEL = [
  { name: "Albumin", latest: { value: 3.6 } },
  { name: "Creatinine", latest: { value: 1.4 } },
  { name: "Glucose", latest: { value: 145 } },
  { name: "hs-CRP", latest: { value: 8 } },
  { name: "Lymphocyte %", latest: { value: 12 } },
  { name: "MCV", latest: { value: 96 } },
  { name: "RDW", latest: { value: 16 } },
  { name: "Alkaline Phosphatase", latest: { value: 150 } },
  { name: "WBC", latest: { value: 9 } },
];

test("levinePhenoAge: a healthy panel reads YOUNGER than calendar age", () => {
  const p = repo.levinePhenoAge(HEALTHY_PANEL, 50);
  assert.ok(p, "computes with a full panel");
  assert.equal(p.direction, "younger");
  assert.ok(p.value < 50);
  assert.ok(p.value >= 18 && p.value <= 120, "plausible");
  assert.match(p.note, /younger|in line/i);
});

test("levinePhenoAge: an unhealthy panel reads OLDER than calendar age", () => {
  const p = repo.levinePhenoAge(UNHEALTHY_PANEL, 40);
  assert.ok(p);
  assert.equal(p.direction, "older");
  assert.ok(p.value > 40);
});

test("levinePhenoAge: a partial panel returns null (never fabricates)", () => {
  assert.equal(repo.levinePhenoAge([{ name: "Albumin", latest: { value: 4.5 } }], 45), null);
  assert.equal(repo.levinePhenoAge(HEALTHY_PANEL, null), null, "no calendar age → null");
});

test("the hero NEVER surfaces the fabricated composite as a number", () => {
  // A sparse panel: no lab bio-age marker and not enough for a PhenoAge. The composite
  // (signal_age) may still be computed for the full-read, but the hero's biological_age
  // must be null — the client renders a plain-language read, not a fabricated number.
  repo.setProfile({ sex: "male", age: 45 });
  seedHealthDoc("2026-06-01", [marker("ApoB", 70, { unit: "mg/dL", flag: "normal" })]);
  const s = repo.healthStanding();
  assert.equal(s.hero.biological_age, null, "no real measure → no hero number");
  assert.equal(s.hero.biological_age_source, "estimate");
  assert.notEqual(s.hero.direction, undefined);
});

test("a deterministic PhenoAge anchors the hero in plain language (no lab bio-age)", () => {
  repo.setProfile({ sex: "male", age: 50 });
  seedHealthDoc("2026-06-01", HEALTHY_PANEL.map((m) => marker(m.name, m.latest.value)));
  const s = repo.healthStanding();
  assert.equal(s.hero.biological_age_source, "phenoage");
  assert.ok(typeof s.hero.biological_age === "number", "a real PhenoAge value backs it");
  assert.ok(s.pheno_age && s.pheno_age.direction, "pheno_age payload present");
  assert.ok(typeof s.hero.bio_read === "string" && s.hero.bio_read.length > 0, "plain-language read for the hero");
  assert.doesNotMatch(String(s.hero.bio_read), /\b\d{2,3}\b/, "the plain-language read carries NO age number");
});

test("a lab-reported biological age still leads the hero, framed by direction", () => {
  repo.setProfile({ sex: "male", age: 45 });
  seedHealthDoc("2026-06-01", [marker("Biological Age", 39)]);
  const s = repo.healthStanding();
  assert.equal(s.hero.biological_age, 39, "the athlete's own lab number is the anchor");
  assert.equal(s.hero.biological_age_source, "lab");
  assert.equal(s.hero.direction, "younger");
  assert.ok(typeof s.hero.bio_read === "string" && /biological age/i.test(s.hero.bio_read));
  // The hero anchor is the LAB value, sourced as "lab" — not the composite. (The
  // composite signal_age remains in the payload for the full read, unsurfaced.)
  assert.equal(s.hero.biological_age_source, "lab");
});
