// "Worse than last time" is an EVENT (owner rulings R1–R4).
//
// A lab panel that comes back FURTHER off-optimal used to land silently: the
// diff-based directive reconcile absorbed the new number into the row that was
// already there, the outcome annotations were pull-only so nobody computed them,
// the insight layer read the territory as already-said for 90 days, and the
// "next checkup" tile stayed quiet because a never-measured workup carried no date.
// These cover the four seams that make a worsening reading visible instead.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker, isoDaysAgo, tsDaysAgo } from "./_seed.js";
import { shouldEnqueueReviewRefresh } from "../dist/enrich.js";

beforeEach(() => {
  resetTables(
    "health_documents",
    "health_directives",
    "insights",
    "memory",
    "profile",
    "brain_decisions",
    "brain_expectations",
    "attention_schedule",
  );
});

function outcomeDecisions() {
  return db
    .prepare(`SELECT * FROM brain_decisions WHERE source = 'health_outcome' ORDER BY id`)
    .all()
    .map((row) => ({ ...row, context: JSON.parse(row.context_json || "{}") }));
}

// ---------------------------------------------------------------------------
// (a) a worsening re-measure: outcome recorded, directive refreshed + resurfaced,
//     brain observation written
// ---------------------------------------------------------------------------

test("a re-measured LDL that rose above its flagged trigger records a worsening outcome and a brain observation", () => {
  seedHealthDoc("2026-01-05", [marker("LDL-C", 173, { unit: "mg/dL", flag: "high" })]);
  const directive = repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "LDL-C",
    directive: "Hold the saturated-fat and fibre lever and recheck after a response window.",
    trigger_value: 173,
    trigger_side: "high",
    trigger_date: "2026-01-05",
    status: "active",
  });
  seedHealthDoc("2026-04-05", [marker("LDL-C", 186, { unit: "mg/dL", flag: "high" })]);

  const annotation = repo
    .healthOutcomeAnnotations()
    .annotations.find((x) => x.directive_id === directive.id);
  assert.ok(annotation, "the follow-up draw produces an outcome annotation");
  assert.equal(annotation.outcome, "worsening");
  assert.equal(repo.healthOutcomeEventReason(annotation), "worsening");

  const recorded = repo.recordHealthOutcomeEvents();
  assert.ok(recorded.observations >= 1, "a worsening outcome writes a brain observation");

  const decisions = outcomeDecisions();
  const row = decisions.find((d) => d.context.directive_id === directive.id);
  assert.ok(row, "the ledger carries the outcome event");
  assert.equal(row.context.event, "health_outcome");
  assert.equal(row.context.reason, "worsening");
  assert.equal(row.context.trigger_value, 173);
  assert.equal(row.context.follow_up_value, 186);
  assert.equal(row.effective_date, "2026-04-05", "dated by the DRAW, never by 'now'");
  assert.equal(row.risk_class, "clinical");
  assert.equal(row.autonomy_tier, "clinician");
  assert.equal(row.status, "observed");

  // Idempotent: every document in one upload batch may call it.
  const before = outcomeDecisions().length;
  repo.recordHealthOutcomeEvents();
  assert.equal(outcomeDecisions().length, before, "re-running the pass adds no duplicate rows");
});

test("an improving follow-up is not an event, and an unchanged one only past its own recheck window", () => {
  const improving = {
    directive_id: 1,
    directive_status: "active",
    marker: "LDL-C",
    outcome: "improving",
    trigger: { date: "2026-01-05", value: 186, unit: null, side: "high" },
    follow_up: { date: "2026-04-05", value: 150, unit: null, flag: null },
  };
  assert.equal(repo.healthOutcomeEventReason(improving), null);

  // LDL-C classifies `standard` (note_days 180), so 90 days unchanged is not yet news…
  const unchangedEarly = { ...improving, outcome: "unchanged", follow_up: { ...improving.follow_up, value: 185 } };
  assert.equal(repo.healthOutcomeEventReason(unchangedEarly), null);
  // …and a year of no movement is.
  const unchangedLate = {
    ...unchangedEarly,
    follow_up: { ...unchangedEarly.follow_up, date: "2027-01-05" },
  };
  assert.equal(repo.healthOutcomeEventReason(unchangedLate), "unchanged_past_recheck");

  // A directive the athlete waved off never becomes an event again.
  assert.equal(
    repo.healthOutcomeEventReason({ ...unchangedLate, directive_status: "dismissed" }),
    null,
  );
});

test("a worsening reading resurfaces its directive as a NEW row rather than overwriting the old one in place", () => {
  seedHealthDoc("2026-01-05", [marker("LDL-C", 173, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const first = repo
    .listDirectives()
    .find((d) => d.source === "markers" && String(d.marker || "").includes("LDL"));
  assert.ok(first, "the flagged panel derives an LDL directive");
  assert.equal(first.trigger_value, 173);

  seedHealthDoc("2026-04-05", [marker("LDL-C", 210, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();

  const superseded = repo.getDirective(first.id);
  assert.equal(superseded.status, "resolved", "the stale row is soft-resolved");
  assert.equal(superseded.status_at, null, "a machine resolve never stamps user feedback");

  const fresh = repo
    .listDirectives()
    .find((d) => d.source === "markers" && String(d.marker || "").includes("LDL"));
  assert.ok(fresh, "an active LDL directive still stands");
  assert.notEqual(fresh.id, first.id, "it is a NEW row, so it resurfaces at the top of the list");
  assert.equal(fresh.trigger_value, 210, "carrying the new reading");
  assert.equal(fresh.trigger_date, "2026-04-05");
  assert.equal(fresh.resurfaced_from_id, first.id);

  // Idempotent: re-deriving against the SAME panel resurfaces nothing.
  repo.deriveDirectives();
  const again = repo
    .listDirectives()
    .find((d) => d.source === "markers" && String(d.marker || "").includes("LDL"));
  assert.equal(again.id, fresh.id, "the same draw is not news twice");
});

// ---------------------------------------------------------------------------
// (b) a worsening outcome breaks the 90-day territorial dedupe
// ---------------------------------------------------------------------------

function sayConnection(key, daysAgo) {
  const row = repo.addInsight({
    kind: "connection",
    text: "Your cholesterol picture tracks with how much dietary fibre you get in.",
    rationale: "A dated association across the last two panels.",
    intent_key: key,
  });
  db.prepare(`UPDATE insights SET created_at = ? WHERE id = ?`).run(tsDaysAgo(daysAgo), row.id);
  return row;
}

test("a cholesterol connection said 20 days ago stays deduped until the panel comes back worse", () => {
  const key = "labs.lipids~nutrition.fibre:same";
  assert.ok(repo.splitInsightIntentKey(key), "fixture key is in the vocabulary");
  sayConnection(key, 20);

  // No outcome on file yet — the territory reads as already-said.
  assert.equal(repo.isDuplicateInsightIntent(key, repo.insightIntentCorpus().keys), true);

  // Now a lipid marker is re-measured WORSE, after the day the connection was said.
  seedHealthDoc(isoDaysAgo(120), [marker("LDL-C", 173, { unit: "mg/dL", flag: "high" })]);
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "LDL-C",
    directive: "Hold the fibre lever and recheck after a response window.",
    trigger_value: 173,
    trigger_side: "high",
    trigger_date: isoDaysAgo(120),
    status: "active",
  });
  seedHealthDoc(isoDaysAgo(3), [marker("LDL-C", 186, { unit: "mg/dL", flag: "high" })]);

  const epochs = repo.healthOutcomeEvidenceEpochs();
  assert.ok(
    epochs.some((e) => e.facet === "labs.lipids" && e.at === isoDaysAgo(3)),
    "the worsening draw becomes a dated epoch on the lipids facet",
  );
  assert.equal(
    repo.isDuplicateInsightIntent(key, repo.insightIntentCorpus().keys),
    false,
    "the connection may be spoken again",
  );
});

test("an epoch that predates the insight does not reopen it, and a thumbs-down stays sticky", () => {
  const key = "labs.lipids~nutrition.fibre:same";
  const epochs = [{ facet: "labs.lipids", at: isoDaysAgo(40) }];
  assert.equal(repo.intentKeySupersededByEvidence(key, tsDaysAgo(20), epochs), false);
  assert.equal(
    repo.intentKeySupersededByEvidence(key, tsDaysAgo(20), [{ facet: "labs.lipids", at: isoDaysAgo(3) }]),
    true,
  );
  // A facet the key does not name never reopens it.
  assert.equal(
    repo.intentKeySupersededByEvidence(key, tsDaysAgo(20), [{ facet: "labs.thyroid", at: isoDaysAgo(3) }]),
    false,
  );

  // Thumbs-down is territorial: the athlete waved the CONNECTION off, and a new
  // draw does not un-wave it.
  const row = sayConnection(key, 20);
  repo.updateInsight(row.id, { feedback: "down" });
  seedHealthDoc(isoDaysAgo(120), [marker("LDL-C", 173, { unit: "mg/dL", flag: "high" })]);
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "LDL-C",
    directive: "Hold the fibre lever and recheck after a response window.",
    trigger_value: 173,
    trigger_side: "high",
    trigger_date: isoDaysAgo(120),
    status: "active",
  });
  seedHealthDoc(isoDaysAgo(3), [marker("LDL-C", 186, { unit: "mg/dL", flag: "high" })]);
  assert.equal(repo.isDuplicateInsightIntent(key, repo.insightIntentCorpus().keys), true);
});

// A panel is DATED when the blood was drawn but only becomes knowable when the PDF is
// ingested, routinely days later. Dating the epoch by the draw alone re-suppressed
// exactly the insights this feature exists to reopen.
function seedWorseningLipidPanel(triggerDaysAgo, followUpDaysAgo) {
  seedHealthDoc(isoDaysAgo(triggerDaysAgo), [marker("LDL-C", 173, { unit: "mg/dL", flag: "high" })]);
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "LDL-C",
    directive: "Hold the fibre lever and recheck after a response window.",
    trigger_value: 173,
    trigger_side: "high",
    trigger_date: isoDaysAgo(triggerDaysAgo),
    status: "active",
  });
  seedHealthDoc(isoDaysAgo(followUpDaysAgo), [marker("LDL-C", 186, { unit: "mg/dL", flag: "high" })]);
}

test("an epoch is dated by when the panel was INGESTED, not by the draw it happened on", () => {
  const key = "labs.lipids~nutrition.fibre:same";
  // Said three days ago — AFTER the draw six days ago, but before the upload today.
  sayConnection(key, 3);
  seedWorseningLipidPanel(120, 6);

  // Before anything is recorded there is no ledger row, so the epoch falls back to the
  // draw — the pure path is unchanged.
  assert.equal(
    repo.healthOutcomeEvidenceEpochs().find((e) => e.facet === "labs.lipids").at,
    isoDaysAgo(6),
    "with nothing recorded the epoch still reads as the draw date",
  );

  // Ingest happens now: recordHealthOutcomeEvents writes the observation the app learned.
  assert.ok(repo.recordHealthOutcomeEvents().observations >= 1);
  const epoch = repo.healthOutcomeEvidenceEpochs().find((e) => e.facet === "labs.lipids");
  assert.ok(epoch.at > isoDaysAgo(6), "the epoch moves forward to the day the app learned it");
  assert.equal(
    repo.isDuplicateInsightIntent(key, repo.insightIntentCorpus().keys),
    false,
    "a connection said between the draw and the upload could not have known — it reopens",
  );
});

test("an insight said AFTER the panel was ingested stays deduped", () => {
  const key = "labs.lipids~nutrition.fibre:same";
  seedWorseningLipidPanel(120, 6);
  assert.ok(repo.recordHealthOutcomeEvents().observations >= 1);
  // Said now, with the ingested panel already on file.
  repo.addInsight({
    kind: "connection",
    text: "Your cholesterol picture tracks with how much dietary fibre you get in.",
    rationale: "A dated association across the last two panels.",
    intent_key: key,
  });
  assert.equal(
    repo.isDuplicateInsightIntent(key, repo.insightIntentCorpus().keys),
    true,
    "the connection already knew about the worse panel",
  );
});

// A caller outside the DB path can thread the learned-at date it holds.
test("healthOutcomeEvidenceEpochs accepts a caller-supplied learnedAt when no ledger row exists", () => {
  seedWorseningLipidPanel(120, 6);
  const supplied = repo.healthOutcomeEvidenceEpochs(60, { learnedAt: isoDaysAgo(1) });
  assert.equal(supplied.find((e) => e.facet === "labs.lipids").at, isoDaysAgo(1));
  // Never earlier than the draw, and never a malformed value.
  assert.equal(
    repo.healthOutcomeEvidenceEpochs(60, { learnedAt: isoDaysAgo(30) }).find((e) => e.facet === "labs.lipids").at,
    isoDaysAgo(6),
  );
  assert.equal(
    repo.healthOutcomeEvidenceEpochs(60, { learnedAt: "not-a-date" }).find((e) => e.facet === "labs.lipids").at,
    isoDaysAgo(6),
  );
});

// ---------------------------------------------------------------------------
// (c) a missing workup a flagged marker warrants raises the tile
// ---------------------------------------------------------------------------

test("a flagged lipid with no ApoB / Lp(a) / hs-CRP on file surfaces those add-ons and raises the tile", () => {
  const asOf = isoDaysAgo(0);
  seedHealthDoc(isoDaysAgo(2), [marker("LDL-C", 186, { unit: "mg/dL", flag: "high" })]);

  const read = repo.nextCheckupRead({ asOf });
  assert.equal(read.has_content, true, "a warranted missing workup is enough to surface the read");
  const labels = read.upcoming.filter((i) => i.kind === "add").map((i) => i.label);
  for (const wanted of ["ApoB", "Lp(a)", "hs-CRP"]) {
    assert.ok(labels.includes(wanted), `${wanted} is offered as an add-on`);
  }
  const apob = read.upcoming.find((i) => i.label === "ApoB");
  assert.ok(apob.why.length > 0);
  assert.ok(!/score|grade|\b\d{1,3}\s*\/\s*100\b/i.test(apob.why), "no score, ever");
  assert.equal(apob.warranted, undefined, "internal ordering state never reaches the client contract");
  // Warranted add-ons sort ahead of the merely-never-measured ones.
  assert.deepEqual(labels.slice(0, 3).sort(), ["ApoB", "Lp(a)", "hs-CRP"].sort());
});

test("with nothing flagged, the same never-measured workups keep the tile quiet", () => {
  const asOf = isoDaysAgo(0);
  seedHealthDoc(isoDaysAgo(2), [marker("LDL-C", 80, { unit: "mg/dL", flag: "normal" })]);

  const read = repo.nextCheckupRead({ asOf });
  assert.equal(read.has_content, false, "pull, never push — an unflagged picture stays silent");
  const labels = read.upcoming.filter((i) => i.kind === "add").map((i) => i.label);
  assert.ok(labels.includes("ApoB"), "the add-on is still listed for anyone who opens the read");
});

// ---------------------------------------------------------------------------
// (d) one whole-picture review per ingest batch
// ---------------------------------------------------------------------------

test("a five-document upload batch enqueues exactly one whole-picture review", () => {
  const batch = 5;
  let enqueued = 0;
  let queued = false;
  for (let i = 1; i <= batch; i++) {
    // Documents drain serially; while any later one is still queued, this document's
    // review would be superseded before anyone read it.
    const stillPending = i < batch;
    if (shouldEnqueueReviewRefresh(queued, stillPending)) {
      enqueued++;
      queued = true;
    }
    queued = false; // the review job clears the latch when it starts
  }
  assert.equal(enqueued, 1, "fourteen reviews for one zip becomes one");
});

test("the review latch and the batch guard are independent reasons to hold off", () => {
  assert.equal(shouldEnqueueReviewRefresh(false, false), true);
  assert.equal(shouldEnqueueReviewRefresh(true, false), false, "one is already pending");
  assert.equal(shouldEnqueueReviewRefresh(false, true), false, "more of the batch is still coming");
  assert.equal(shouldEnqueueReviewRefresh(true, true), false);
  // Back-compat: the one-argument form is still the plain latch check.
  assert.equal(shouldEnqueueReviewRefresh(false), true);
  assert.equal(shouldEnqueueReviewRefresh(true), false);
});
