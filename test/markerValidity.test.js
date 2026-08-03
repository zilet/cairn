// PER-MARKER temporal validity — how long a reading keeps describing the person.
//
// "Old" is not one number. A morning cortisol or a fasting glucose is a snapshot of that
// day; a lipid panel describes a season; a bone scan describes years; Lp(a) and blood type
// are set once and never move. So the aging clause, the uncertain flip, and the prompt's
// "honor these" split are all driven by the marker's CLASS (src/repo/marker-validity.ts),
// not by one blanket age rule.
//
// Everything below uses synthetic panels only.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker, isoDaysAgo } from "./_seed.js";
import { renderConnectedBrain } from "../dist/prompt/shared.js";

beforeEach(() => {
  resetTables(
    "health_documents",
    "health_directives",
    "health_directive_history",
    "app_state",
    "brain_decisions",
    "brain_expectations",
    "profile"
  );
});

const activeRows = () => repo.listActiveDirectives().filter((d) => d.source === "markers");
const forMarker = (label) => activeRows().filter((d) => d.marker === label);

// ---- 1. the classification itself (pure, no DB) ----

test("markers are classified by how fast they actually move", () => {
  // Lifelong: measured once, never doubted for age.
  assert.equal(repo.markerValidityClass("Lp(a)"), "genetic");
  assert.equal(repo.markerValidityClass("Lipoprotein(a)"), "genetic");
  assert.equal(repo.markerValidityClass("ABO Group and Rh Type"), "genetic");

  // Structural, multi-year.
  assert.equal(repo.markerValidityClass("Bone Mineral Density"), "slow");
  assert.equal(repo.markerValidityClass("Coronary Artery Calcium Score"), "slow");

  // State-dependent, day to day.
  assert.equal(repo.markerValidityClass("hs-CRP"), "fast");
  assert.equal(repo.markerValidityClass("Fasting glucose"), "fast");
  assert.equal(repo.markerValidityClass("Morning cortisol"), "fast");
  assert.equal(repo.markerValidityClass("Ferritin"), "fast");
  assert.equal(repo.markerValidityClass("Potassium"), "fast");
  assert.equal(repo.markerValidityClass("Systolic BP"), "fast");

  // The great majority — and the default.
  assert.equal(repo.markerValidityClass("ApoB"), "standard");
  assert.equal(repo.markerValidityClass("Vitamin D"), "standard");
  assert.equal(repo.markerValidityClass("HbA1c"), "standard");
});

test("an unmatched marker falls to standard — the behavior that existed before the table", () => {
  assert.equal(repo.markerValidityClass("Zorbulin"), "standard");
  assert.equal(repo.markerValidityClass(""), "standard");
  assert.equal(repo.markerValidityClass(null), "standard");
  const h = repo.markerValidityHorizons("Zorbulin");
  assert.deepEqual({ ...h }, { cls: "standard", note_days: 180, uncertain_days: 365 });
});

test("longest-match-wins keeps a slower analyte out of a shorter key's fast bucket", () => {
  // "insulin" is fast; IGF-1 is not insulin.
  assert.equal(repo.markerValidityClass("Insulin-Like Growth Factor 1"), "standard");
  assert.equal(repo.markerValidityClass("Fasting insulin"), "fast");
  // eAG averages ~3 months; a fasting glucose is one morning.
  assert.equal(repo.markerValidityClass("Estimated Average Glucose"), "standard");
  // TIBC turns over in weeks; serum iron is diurnal.
  assert.equal(repo.markerValidityClass("Total Iron Binding Capacity"), "standard");
  assert.equal(repo.markerValidityClass("Serum Iron"), "fast");
  assert.equal(repo.markerValidityClass("Transferrin Saturation"), "fast");
  // A coronary calcium SCORE must not inherit the serum-calcium class.
  assert.equal(repo.markerValidityClass("Calcium"), "fast");
  assert.equal(repo.markerValidityClass("Calcium Score (Agatston)"), "slow");
});

test("a synthesized cluster name carries its durable story, not its most volatile member", () => {
  // The lipid+inflammation cluster's advice is lipid advice; the hs-CRP in the name must
  // not age it out (the same rule CHRONIC_GUARD_RE already enforces for acute decay), and
  // the Lp(a) in it must not make the whole thing lifelong.
  assert.equal(repo.markerValidityClass("ApoB+LDL-C+Lp(a)+hs-CRP+Triglycerides"), "standard");
  assert.equal(repo.markerValidityClass("low ferritin+low hemoglobin+low MCV"), "standard");
  // All-genetic stays genetic.
  assert.equal(repo.markerValidityClass("Lp(a)+ABO Group"), "genetic");
  // The DEGENERATE pair the CV cluster can reach on its own (minHits 2): a genetic member
  // floors the cluster at standard, so the story does not expire on hs-CRP's week-to-week
  // clock — which is exactly the string CHRONIC_GUARD_RE refuses to age out.
  assert.equal(repo.markerValidityClass("Lp(a)+hs-CRP"), "standard");
  // …but it does NOT become lifelong either — the modifiable half still re-derives.
  assert.notEqual(repo.markerValidityClass("Lp(a)+hs-CRP"), "genetic");
  // No genetic member → the plain longest-lived rule still applies.
  assert.equal(repo.markerValidityClass("hs-CRP+Fasting glucose"), "fast");
});

test("the glycemic and cardiac snapshots read fast, the 3-month averages do not", () => {
  assert.equal(repo.markerValidityClass("HOMA-IR"), "fast");
  assert.equal(repo.markerValidityClass("C-Peptide"), "fast");
  assert.equal(repo.markerValidityClass("Troponin I"), "fast");
  assert.equal(repo.markerValidityClass("NT-proBNP"), "fast");
  assert.equal(repo.markerValidityClass("Hemoglobin A1c"), "standard");
  assert.equal(repo.markerValidityClass("Fructosamine"), "standard");
  // Zone LABELS the engine actually stores, which the long spellings miss.
  assert.equal(repo.markerValidityClass("CO2"), "fast");
  assert.equal(repo.markerValidityClass("MPV"), "fast");
  assert.equal(repo.markerValidityClass("Absolute NRBC"), "fast");
  // The red LINE turns over with the ~120-day red-cell lifespan — months, not weeks.
  for (const n of ["Hemoglobin", "Hematocrit", "MCV", "MCH", "MCHC", "RDW", "RBC"]) {
    assert.equal(repo.markerValidityClass(n), "standard", `${n} reads as standard`);
  }
});

test("each class carries its own two horizons, and genetic has no demotion at all", () => {
  assert.equal(repo.markerValidityHorizons("Lp(a)").uncertain_days, null);
  assert.equal(repo.markerValidityHorizons("Bone Mineral Density").uncertain_days, 730);
  assert.equal(repo.markerValidityHorizons("ApoB").uncertain_days, 365);
  assert.equal(repo.markerValidityHorizons("hs-CRP").uncertain_days, 180);

  // The demotion test every surface shares.
  assert.equal(repo.readingPastValidity("Lp(a)", 3000), false, "age alone never retires a genetic marker");
  assert.equal(repo.readingPastValidity("Bone Mineral Density", 400), false);
  assert.equal(repo.readingPastValidity("Bone Mineral Density", 800), true);
  assert.equal(repo.readingPastValidity("ApoB", 200), false);
  assert.equal(repo.readingPastValidity("ApoB", 400), true);
  assert.equal(repo.readingPastValidity("Fasting glucose", 100), false);
  assert.equal(repo.readingPastValidity("Fasting glucose", 200), true);
  assert.equal(repo.readingPastValidity("ApoB", null), false, "no reading date → no verdict");
});

// ---- 2. derivation: the clause and the uncertain flip follow the class ----

test("a genetic marker is never softened by age — at two years it reads as confirmation", () => {
  seedHealthDoc(isoDaysAgo(730), [marker("Lp(a)", 180, { unit: "nmol/L", flag: "high" })]);
  repo.deriveDirectives();
  const rows = forMarker("Lp(a)");
  assert.ok(rows.length > 0, "a high Lp(a) still propagates at two years");
  const cited = rows.filter((d) => d.citation && !String(d.directive).includes("Because Lp(a)"));
  assert.ok(cited.length > 0, "the cited watch directive is there to judge confidence on");
  for (const d of cited) {
    assert.equal(!!d.uncertain, false, "a genetic finding keeps its confidence at two years");
  }
  for (const d of rows) {
    assert.match(String(d.rationale), /set by genetics/, "the age reads as reassurance");
    assert.match(String(d.rationale), /confirmatory re-test/);
    assert.doesNotMatch(String(d.rationale), /a recheck would confirm it still holds/);
  }
});

test("at ~200 days a fast marker is a snapshot while a standard one is still the best on file", () => {
  seedHealthDoc(isoDaysAgo(200), [
    marker("Fasting Glucose", 118, { unit: "mg/dL", flag: "high" }),
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();

  const glucose = forMarker("Fasting glucose");
  assert.ok(glucose.length > 0, "the glucose panel propagated");
  for (const d of glucose) {
    assert.match(String(d.rationale), /moves week to week/, "the fast clause landed");
    assert.equal(!!d.uncertain, true, "past 180 days a fast marker softens to uncertain");
  }

  const apob = forMarker("ApoB");
  assert.ok(apob.length > 0, "the ApoB panel propagated");
  const citedApoB = apob.filter((d) => d.citation);
  assert.ok(citedApoB.length > 0);
  for (const d of apob) {
    assert.match(String(d.rationale), /still the most recent one on file/, "the standard note landed");
    assert.doesNotMatch(String(d.rationale), /moves week to week/);
  }
  for (const d of citedApoB) {
    assert.equal(!!d.uncertain, false, "200 days does not soften a standard marker");
  }
});

test("an unclassified marker ages exactly like a standard one", () => {
  seedHealthDoc(isoDaysAgo(200), [marker("Zorbulin", 42, { unit: "U/L", flag: "high" })]);
  repo.deriveDirectives();
  const rows = activeRows().filter((d) => String(d.marker).toLowerCase().includes("zorbulin"));
  assert.ok(rows.length > 0, "an unmapped flagged marker still surfaces as a soft watch note");
  for (const d of rows) {
    assert.match(String(d.rationale), /still the most recent one on file/);
    assert.doesNotMatch(String(d.rationale), /moves week to week/);
  }
});

// ---- 3. the coach's "honor these" split ----

test("the prompt honors what is current and reads the rest as informational", () => {
  seedHealthDoc(isoDaysAgo(200), [
    marker("Fasting Glucose", 118, { unit: "mg/dL", flag: "high" }),
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const block = renderConnectedBrain({ directives: repo.listActiveDirectives() });
  const [honored, aged] = (() => {
    const i = block.indexOf("FINDINGS FROM AN OLD READING");
    assert.ok(i > 0, "the old-reading block rendered");
    return [block.slice(0, i), block.slice(i)];
  })();
  assert.match(honored, /honor these/);
  assert.match(honored, /ApoB/, "a 200-day-old ApoB is still current for its kind of marker");
  assert.doesNotMatch(honored, /Fasting glucose/, "a 200-day-old fasting glucose is not");
  assert.match(aged, /Fasting glucose/);
  assert.match(aged, /INFORMATIONAL ONLY/);
});

test("a genetic finding stays in 'honor these' however old the draw", () => {
  seedHealthDoc(isoDaysAgo(1500), [marker("Lp(a)", 180, { unit: "nmol/L", flag: "high" })]);
  repo.deriveDirectives();
  const annotated = repo.annotateDirectiveFreshness(repo.listActiveDirectives());
  assert.ok(annotated.length > 0);
  for (const d of annotated) {
    assert.equal(d.validity_class, "genetic");
    assert.equal(d.past_validity, false);
  }
  const block = renderConnectedBrain({ directives: repo.listActiveDirectives() });
  assert.doesNotMatch(block, /FINDINGS FROM AN OLD READING/);
  assert.match(block, /honor these/);
});

test("a directive with no reading date is never retired by the age of the ROW", () => {
  // An agent-emitted review directive that resolved no marker context carries no
  // trigger_date. Aging it by created_at would retire it on evidence nobody measured —
  // and make the prompt print a reading date that does not exist.
  const row = repo.addDirective({
    source: "health_review",
    domain: "watch",
    marker: "Fasting glucose", // fast class: 180 days would demote it if created_at counted
    directive: "Keep an eye on fasting glucose with your doctor.",
    rationale: "From the last review.",
    status: "active",
  });
  db.prepare("UPDATE health_directives SET created_at = ?, trigger_date = NULL WHERE id = ?").run(
    "2024-01-01 09:00:00",
    row.id
  );
  const [d] = repo.annotateDirectiveFreshness(repo.listActiveDirectives());
  assert.equal(d.validity_class, "fast");
  assert.ok(d.age_days > 365, "the ROW is old (created_at still ages it, as before)");
  assert.equal(d.reading_age_days, null, "…but there is no reading to be old");
  assert.equal(d.past_validity, false, "so it is not retired by class");
  const block = renderConnectedBrain({ directives: repo.listActiveDirectives() });
  assert.match(block, /honor these/);
  assert.doesNotMatch(block, /FINDINGS FROM AN OLD READING/);
  assert.doesNotMatch(block, /reading ~\d+ months? ago/, "no reading age is invented");
});

test("the AGING ACUTE block invents no reading age either", () => {
  // Same defect class as above, in the block the past-window one was modeled on: an acute
  // directive with no trigger_date and no resolvable marker history has no draw to date.
  const row = repo.addDirective({
    source: "health_review",
    domain: "training",
    marker: "hs-CRP",
    directive: "Keep intensity moderate while inflammation is up.",
    rationale: "From the last review.",
    status: "active",
  });
  db.prepare("UPDATE health_directives SET created_at = ?, trigger_date = NULL WHERE id = ?").run(
    "2023-01-01 09:00:00",
    row.id
  );
  const [d] = repo.annotateDirectiveFreshness(repo.listActiveDirectives());
  assert.equal(d.acute, true);
  assert.equal(d.stale, true, "the row still ages out of the honored block, as before");
  assert.equal(d.reading_age_days, null);
  const block = renderConnectedBrain({ directives: repo.listActiveDirectives() });
  assert.match(block, /AGING LAB FINDINGS/);
  assert.match(block, /point-in-time; recheck before it shapes anything/, "the caveat stands on its own");
  assert.doesNotMatch(block, /reading ~\d+ week/, "no reading age is invented");
});

// ---- 4. the tiering the athlete reads (health focus) ----

test("past-window evidence never becomes the priority right now", () => {
  seedHealthDoc(isoDaysAgo(200), [marker("Fasting Glucose", 118, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const focus = repo.healthFocus();
  assert.equal(focus.act_now, 0, "a 200-day-old fasting glucose does not earn act-now");
  assert.doesNotMatch(focus.headline, /priority right now/);
  const glucose = focus.priorities.find((p) => /Glucose/i.test(p.group));
  assert.ok(glucose, "the group is still surfaced — quietly");
  assert.equal(glucose.tier, "track");
  assert.match(glucose.why, /older than this kind of marker stays current for/);
  // …and the prompt it feeds never shouts ACT NOW above the block that says don't act.
  const block = renderConnectedBrain({ directives: repo.listActiveDirectives(), health_focus: focus });
  assert.doesNotMatch(block, /ACT NOW/);
  assert.match(block, /FINDINGS FROM AN OLD READING/);
});

test("a mixed group leads on its CURRENT evidence and never names the aged reading", () => {
  // The athlete reads this clause. A 200-day-old fasting glucose (fast class, past window)
  // sitting beside a current HbA1c must not be spoken of as part of today's picture —
  // that would name, in the Brief's own voice, evidence the informational block on the
  // same page says not to act on.
  seedHealthDoc(isoDaysAgo(200), [marker("Fasting Glucose", 118, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc(isoDaysAgo(10), [marker("Hemoglobin A1c", 5.9, { unit: "%", flag: "high" })]);
  repo.deriveDirectives();
  const focus = repo.healthFocus();
  const metabolic = focus.priorities.find((p) => /Metabolic/i.test(p.group));
  assert.ok(metabolic, "both markers land in the metabolic group");
  assert.ok(metabolic.markers.some((n) => /A1c/i.test(n)) && metabolic.markers.some((n) => /Glucose/i.test(n)));
  assert.doesNotMatch(metabolic.why, /glucose/i, "the aged draw is not named in the athlete-facing clause");
  assert.match(metabolic.why, /A1c/i, "the current finding is");
  assert.doesNotMatch(metabolic.why, /sit off together/, "one current marker is not a compounding picture");
  // The lab DID flag the old glucose — that fact stays reported, it just earns nothing.
  assert.equal(metabolic.flagged, true);
});

test("…while the SAME finding drawn recently still leads", () => {
  seedHealthDoc(isoDaysAgo(20), [marker("Fasting Glucose", 118, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const focus = repo.healthFocus();
  assert.ok(focus.act_now >= 1, "a current flagged glucose is act-now — the demotion is what changed");
  assert.match(focus.headline, /priority right now/);
});

// ---- 5. class-driven text is still zero-churn ----

test("re-deriving a class-aged panel churns zero rows", () => {
  seedHealthDoc(isoDaysAgo(400), [
    marker("Fasting Glucose", 118, { unit: "mg/dL", flag: "high" }),
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 180, { unit: "nmol/L", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const snapshot = () =>
    repo.listDirectives({ all: true }).map((d) => ({
      id: d.id,
      status: d.status,
      key: d.directive_key,
      uncertain: !!d.uncertain,
      rationale: d.rationale,
    }));
  const first = snapshot();
  assert.ok(first.length > 0);
  for (let pass = 0; pass < 3; pass++) {
    repo.setAppState("directive_derive_sig", ""); // defeat the short-circuit — the reconcile itself must hold still
    repo.deriveDirectives();
  }
  assert.deepEqual(snapshot(), first, "a class-driven age note is applied once, never re-applied");
});

// ---- 6. lockstep: the clause's own inputs are in the derive signature ----
//
// The short-circuit skips the whole pass when the signature is unchanged, so any input the
// age clause reads must be folded into it. These two panels are the cases a per-ZONE fold
// cannot see: a synthesized cluster crosses its horizon on its OWN anchor, and a flagged
// marker with no optimal zone never reaches offMarkers at all. In both, the marker values
// and dates are frozen — only the clock moves — so a passing assertion can only come from
// the age fold.
const at = (iso) => Date.parse(`${iso}T12:00:00Z`);

test("a CLUSTER crossing its horizon moves the signature on the day it crosses", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(at("2026-08-03")) });
  // Lp(a) 180d + hs-CRP 194d: the CV cluster fires (minHits 2) and anchors on Lp(a).
  // Neither member's own band or month bucket moves overnight — Lp(a) is genetic (band 0
  // until a year) and hs-CRP is already past its 180-day fast horizon — but the cluster is
  // `standard` and crosses 180 days tonight.
  seedHealthDoc(isoDaysAgo(180), [marker("Lp(a)", 180, { unit: "nmol/L", flag: "high" })]);
  seedHealthDoc(isoDaysAgo(194), [marker("hs-CRP", 6, { unit: "mg/L", flag: "high" })]);
  repo.deriveDirectives();
  const cluster = () => repo.listActiveDirectives().filter((d) => String(d.marker).includes("+"));
  assert.ok(cluster().length > 0, "the cardiovascular cluster fired");
  assert.equal(repo.markerValidityClass(cluster()[0].marker), "standard");
  assert.ok(
    cluster().every((d) => !String(d.rationale).includes("months old")),
    "at exactly 180 days the cluster carries no age note yet"
  );
  const sig = repo.getAppState("directive_derive_sig");
  assert.equal(repo.deriveDirectives().derived, 0, "a second pass the same day short-circuits");
  assert.equal(repo.getAppState("directive_derive_sig"), sig);

  t.mock.timers.setTime(at("2026-08-04")); // the anchor is now 181 days old
  repo.deriveDirectives();
  assert.notEqual(repo.getAppState("directive_derive_sig"), sig, "the signature moved with the clause");
  assert.ok(
    cluster().every((d) => String(d.rationale).includes("still the most recent one on file")),
    "and the cluster reworded on the day it crossed, not weeks later"
  );
});

test("a flagged marker with NO optimal zone crosses its horizon on time too", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(at("2026-08-03")) });
  seedHealthDoc(isoDaysAgo(180), [marker("Zorbulin", 42, { unit: "U/L", flag: "high" })]);
  repo.deriveDirectives();
  const rows = () => repo.listActiveDirectives().filter((d) => /zorbulin/i.test(String(d.marker)));
  assert.ok(rows().length > 0, "the generic long-tail note exists");
  assert.ok(!String(rows()[0].rationale).includes("months old"), "no age note at exactly 180 days");
  const sig = repo.getAppState("directive_derive_sig");
  assert.equal(repo.deriveDirectives().derived, 0);

  t.mock.timers.setTime(at("2026-08-04"));
  repo.deriveDirectives();
  assert.notEqual(repo.getAppState("directive_derive_sig"), sig, "a zone-less marker's age moves the signature");
  assert.match(String(rows()[0].rationale), /still the most recent one on file/);
});
