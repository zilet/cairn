// The directive-engine overhaul (src/repo/propagation.ts + coach.ts): semantic
// identity across sources, cross-source suppression + cascade, Done vs Dismiss
// semantics, zero-churn diff-based derive, and measurement recency. These guard the
// production pathologies this round fixed: 1,200+ churned rows from clear-all+reinsert,
// the same directive Done'd repeatedly, and duplicate lipid cards across two sources.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "app_state");
});

const rowCount = () => Number(db.prepare(`SELECT COUNT(*) AS n FROM health_directives`).get().n);
const activeIds = () =>
  (db.prepare(`SELECT id FROM health_directives WHERE status = 'active' ORDER BY id`).all()).map((r) => r.id);
const statusOf = (id) => db.prepare(`SELECT status, status_at FROM health_directives WHERE id = ?`).get(id);
const activeMarkersWatch = (label) =>
  repo
    .listActiveDirectives()
    .filter((d) => d.source === "markers" && (d.marker || "") === label && d.domain === "watch");

// (a) --------------------------------------------------------------------------
test("derive is zero-churn: a second pass with unchanged inputs writes no rows", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  const first = repo.deriveDirectives();
  assert.ok(first.derived >= 2, "first pass inserts the mapped directives");
  const rowsAfterFirst = rowCount();
  const idsAfterFirst = activeIds();

  const second = repo.deriveDirectives();
  assert.equal(second.derived, 0, "second pass with identical inputs saves nothing");
  assert.equal(rowCount(), rowsAfterFirst, "no new rows inserted on the second pass");
  assert.deepEqual(activeIds(), idsAfterFirst, "the exact same active rows are kept untouched (ids stable)");
});

test("a changed marker updates the directive in place (id + created_at preserved), not churned", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const before = activeMarkersWatch("ApoB")[0];
  const createdAt = db.prepare(`SELECT created_at FROM health_directives WHERE id = ?`).get(before.id).created_at;

  // A newer reading with a different value → same directive_key, changed trigger
  // snapshot. Deliberately NOT materially worse: a materially worse draw is news and
  // resurfaces as a new row instead (owner ruling R1, covered in directiveChurn).
  seedHealthDoc("2026-03-01", [marker("ApoB", 123, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const after = activeMarkersWatch("ApoB")[0];
  assert.equal(after.id, before.id, "the row is updated in place, not replaced");
  assert.equal(
    db.prepare(`SELECT created_at FROM health_directives WHERE id = ?`).get(after.id).created_at,
    createdAt,
    "created_at is preserved through an in-place update"
  );
  assert.equal(after.trigger_value, 123, "the new trigger snapshot is written");
});

// (b) --------------------------------------------------------------------------
test("user Done, then re-derive the SAME data → no resurface", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const watch = activeMarkersWatch("ApoB")[0];
  repo.updateDirective(watch.id, { status: "resolved" }); // Done

  repo.deriveDirectives(); // unchanged marker snapshot
  assert.equal(activeMarkersWatch("ApoB").length, 0, "the Done'd recheck stays suppressed at the same reading");
  assert.equal(statusOf(watch.id).status, "resolved", "the original row remains resolved (never re-inserted)");
});

// (c) --------------------------------------------------------------------------
test("Done, then a NEWER still-off reading → resurfaces exactly once with resurfaced_from_id", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const watch = activeMarkersWatch("ApoB")[0];
  repo.updateDirective(watch.id, { status: "resolved" });

  seedHealthDoc("2026-03-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]); // newer date, still off
  repo.deriveDirectives();
  const back = activeMarkersWatch("ApoB");
  assert.equal(back.length, 1, "resurfaces exactly one active recheck");
  assert.equal(back[0].resurfaced_from_id, watch.id, "links back to the Done'd row");

  repo.deriveDirectives(); // same new data again
  assert.equal(activeMarkersWatch("ApoB").length, 1, "a repeat pass does NOT resurface a second copy");
});

// (d) --------------------------------------------------------------------------
test("Done on a markers-source row cascades to the health_review twin (same identity)", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const watch = activeMarkersWatch("ApoB")[0];
  assert.equal(watch.intent_key, "recheck", "the mapped ApoB watch directive is a recheck");

  // A health_review echo of the SAME concern (ApoB, watch, recheck-classified text).
  const twin = repo.addDirective({
    source: "health_review",
    domain: "watch",
    marker: "ApoB",
    directive: "Retest a full lipid panel in about 12 weeks and discuss it with your doctor.",
    status: "active",
  });
  assert.equal(twin.intent_key, "recheck", "the health_review echo classifies to the same intent");

  repo.updateDirective(watch.id, { status: "resolved" }); // one Done
  assert.equal(statusOf(twin.id).status, "resolved", "the twin is cascaded to resolved");
  assert.ok(statusOf(twin.id).status_at, "the twin carries a status_at (counts as handled)");
});

// (e) --------------------------------------------------------------------------
test("a DISMISSED markers directive resurfaces only when the marker is materially worse", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 95, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const watch = activeMarkersWatch("ApoB")[0];
  repo.updateDirective(watch.id, { status: "dismissed" }); // stamps trigger from ApoB=95

  seedHealthDoc("2026-02-01", [marker("ApoB", 98, { unit: "mg/dL", flag: "high" })]); // not materially worse
  repo.deriveDirectives();
  assert.equal(activeMarkersWatch("ApoB").length, 0, "a near-identical value stays dismissed");

  seedHealthDoc("2026-05-01", [marker("ApoB", 150, { unit: "mg/dL", flag: "high" })]); // clearly worse
  repo.deriveDirectives();
  assert.equal(activeMarkersWatch("ApoB").length, 1, "a clear worsening resurfaces it");
});

// (f) --------------------------------------------------------------------------
test("generic long-tail honors Done/idempotence like the mapped path", () => {
  seedHealthDoc("2025-12-01", [marker("Potassium", 5.6, { unit: "mmol/L", flag: "high" })]);
  repo.deriveDirectives();
  const note = repo.listActiveDirectives().filter((d) => (d.marker || "") === "Potassium");
  assert.equal(note.length, 1, "one soft notice for a flagged, unmapped analyte");
  assert.equal(note[0].intent_key, "notice", "long-tail directives are classified as notice");

  const before = rowCount();
  repo.deriveDirectives();
  assert.equal(rowCount(), before, "re-derive is zero-churn for the long-tail too");

  repo.updateDirective(note[0].id, { status: "resolved" });
  repo.deriveDirectives();
  assert.equal(
    repo.listActiveDirectives().filter((d) => (d.marker || "") === "Potassium").length,
    0,
    "a Done'd long-tail note stays suppressed at the same reading"
  );
});

test("a cluster directive honors Done + zero-churn", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 90, { unit: "mg/dL", flag: "high" }),
    marker("hs-CRP", 4, { unit: "mg/L", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const cluster = repo.listActiveDirectives().filter((d) => (d.marker || "").includes("+") && d.domain === "watch");
  assert.ok(cluster.length >= 1, "the cardiovascular cluster fires one synthesized watch read");

  const before = rowCount();
  repo.deriveDirectives();
  assert.equal(rowCount(), before, "cluster re-derive is zero-churn");

  repo.updateDirective(cluster[0].id, { status: "resolved" });
  repo.deriveDirectives();
  const stillActive = repo
    .listActiveDirectives()
    .filter((d) => (d.marker || "") === cluster[0].marker && d.domain === "watch");
  assert.equal(stillActive.length, 0, "a Done'd cluster read stays suppressed at the same data");
});

// (g) --------------------------------------------------------------------------
test("a LEGACY user-resolved row without intent_key still suppresses", () => {
  // A row written before the intent_key column existed: intent_key NULL, resolved by the
  // user (status_at set), stamped from ApoB=120 on the same date the new reading carries.
  const legacyDirective =
    "Lower saturated fat (swap toward olive oil, nuts, oily fish) and add ~10g/day soluble fiber (oats, legumes, psyllium) to bring ApoB toward optimal.";
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive_key, intent_key, directive, status, status_at, trigger_value, trigger_side, trigger_date)
     VALUES ('markers', 'nutrition', 'ApoB', 'apob:nutrition:legacy', NULL, ?, 'resolved', '2025-12-02 10:00:00', 120, 'high', '2025-12-01')`
  ).run(legacyDirective);

  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const nut = repo
    .listActiveDirectives()
    .filter((d) => (d.marker || "") === "ApoB" && d.domain === "nutrition");
  assert.equal(nut.length, 0, "the legacy resolve suppresses the equivalent nutrition lever (intent classified on the fly)");
});

// recency ----------------------------------------------------------------------
test("a reading older than a year gets a staleness note and is softened to uncertain", () => {
  const old = new Date(Date.now() - 500 * 864e5).toISOString().slice(0, 10);
  seedHealthDoc(old, [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const nut = repo
    .listActiveDirectives()
    .find((d) => (d.marker || "") === "ApoB" && d.domain === "nutrition");
  assert.ok(nut, "the mapped nutrition directive is present");
  assert.match(nut.rationale, /months ago.*recheck would confirm/i, "a calm staleness clause is appended to the rationale");
  assert.equal(nut.uncertain, true, "a >1yr-old reading softens the directive to uncertain");
});

test("a recent reading carries NO staleness note", () => {
  seedHealthDoc("2026-07-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const nut = repo
    .listActiveDirectives()
    .find((d) => (d.marker || "") === "ApoB" && d.domain === "nutrition");
  assert.ok(nut && !/months ago/i.test(nut.rationale || ""), "a fresh reading has no age note");
});

// A directive that AGES IN PLACE — its source reading date is unchanged, only wall-clock
// time passes it past the staleness threshold — must re-derive (the age-bucket in the
// derive signature) AND persist the clause onto the SAME row (rationale/uncertain now in
// directiveContentUnchanged). Without either half the staleness clause is silently lost.
test("a directive whose reading ages past a year picks up staleness on the SAME row (no clock change to the doc)", () => {
  const D = "2025-06-01"; // the reading date never changes
  const realNow = Date.now;
  try {
    // Phase 1: today is ~30 days after the reading → fresh, no staleness.
    Date.now = () => Date.parse("2025-07-01T00:00:00Z");
    seedHealthDoc(D, [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
    repo.deriveDirectives();
    const fresh = repo
      .listActiveDirectives()
      .find((d) => (d.marker || "") === "ApoB" && d.domain === "nutrition");
    assert.ok(fresh, "the mapped nutrition directive exists while the reading is fresh");
    assert.ok(!/months ago/i.test(fresh.rationale || ""), "no staleness clause while fresh");
    const freshId = fresh.id;

    // Phase 2: today is now ~15 months after the SAME reading. Nothing about the marker's
    // value/flag/date moved — only time. The age-bucket must invalidate the signature so
    // the derive re-runs, and the reconcile must UPDATE the row in place (rationale +
    // uncertain), not treat it as unchanged.
    Date.now = () => Date.parse("2026-09-01T00:00:00Z");
    repo.deriveDirectives();
    const aged = repo
      .listActiveDirectives()
      .find((d) => (d.marker || "") === "ApoB" && d.domain === "nutrition");
    assert.ok(aged, "the directive is still present after aging");
    assert.equal(aged.id, freshId, "the SAME row is updated in place (id stable) — not churned");
    assert.match(
      aged.rationale,
      /months ago.*recheck would confirm/i,
      "the staleness clause is now persisted (signature did not short-circuit it away)"
    );
    assert.equal(aged.uncertain, true, "the aged directive is softened to uncertain");
  } finally {
    Date.now = realNow;
  }
});

// cross-source dedupe ----------------------------------------------------------
test("markers + health_review directives for the same identity collapse to one active card", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  // A health_review recheck echo of the same ApoB+watch+recheck concern.
  repo.addDirective({
    source: "health_review",
    domain: "watch",
    marker: "Apolipoprotein B",
    directive: "Retest lipids in ~12 weeks and review the trend with your doctor.",
    status: "active",
  });
  const watchCards = repo.listActiveDirectives().filter((d) => d.domain === "watch" && /apo/i.test(d.marker || ""));
  assert.equal(watchCards.length, 1, "the two sources read as ONE recheck card, not two");
});
