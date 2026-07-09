// Health-synthesis staleness (src/repo/health-focus.ts getHealthSynthesisView) used
// to notice ONLY a newer health document landing. The cached synthesis reads the
// WHOLE picture — training, recovery, directives, injuries — so it should also
// offer a re-read when THAT picture has meaningfully moved since it was written,
// even with no new labs. `computeHealthDriftSignature()` snapshots that picture at
// save time (stamped as `drift_sig`); `getHealthSynthesisView()` recomputes it now
// and compares with conservative, threshold-biased rules (see the doc comment in
// health-focus.ts) — this is a PULL affordance (docs/VISION.md), so a false-positive
// "re-read" is itself a constitution violation and every trigger here is deliberately
// hard to hit by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedHealthDoc, seedWeight, seedTrainingDay, marker, localDaysAgo } from "./_seed.js";

test("computeHealthDriftSignature never throws on an empty DB and returns the calm floor", () => {
  const sig = repo.computeHealthDriftSignature();
  assert.ok(sig, "returns a signature, not null, on a pristine DB");
  assert.deepEqual(sig.directive_keys, []);
  assert.equal(sig.latest_review_id, null);
  assert.equal(sig.session_count, 0);
  assert.equal(sig.weight_bucket, "none");
  assert.deepEqual(sig.injury_ids, []);
});

test("no cached synthesis → not stale, no reason", () => {
  const view = repo.getHealthSynthesisView();
  assert.equal(view.synthesis, null);
  assert.equal(view.stale, false);
  assert.equal(view.stale_reason, null);
});

test("doc-date staleness is preserved exactly (new labs → stale, reason 'new_labs')", () => {
  seedHealthDoc(localDaysAgo(10), [marker("ApoB", 70, { unit: "mg/dL" })]); // clean, in-optimal
  repo.saveHealthSynthesis({ headline: "Clean picture", source_doc_at: repo.newestHealthDocDate() });

  // Nothing newer yet — not stale.
  let view = repo.getHealthSynthesisView();
  assert.equal(view.stale, false);
  assert.equal(view.stale_reason, null);

  // A later document lands — the pre-existing doc-date check must still fire.
  seedHealthDoc(localDaysAgo(1), [marker("ApoB", 70, { unit: "mg/dL" })]);
  view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true);
  assert.equal(view.stale_reason, "new_labs");
});

test("legacy synthesis without drift_sig never reads stale from drift", () => {
  // Simulate a synthesis written by the pre-drift code: no `drift_sig` key at all.
  repo.setAppState(
    "health_synthesis",
    JSON.stringify({ headline: "Old-shape synthesis", generated_at: "2020-01-01T00:00:00.000Z" })
  );

  // Pile up conditions that WOULD trigger every drift component if a signature existed.
  for (let i = 0; i < 10; i++) seedTrainingDay(localDaysAgo(i));
  repo.addHealthReview({ headline: "Recent review", focus: [{ title: "Something" }] }, "stub");
  repo.addContextEvent({ kind: "injury", title: "New injury", start_date: localDaysAgo(0) });

  const view = repo.getHealthSynthesisView();
  assert.equal(view.stale, false, "no signature to compare against → can't tell → not stale");
  assert.equal(view.stale_reason, null);
});

test("re-deriving directives with unchanged content does not flip stale (row ids churn, content doesn't)", () => {
  seedHealthDoc(localDaysAgo(5), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  repo.saveHealthSynthesis({ headline: "Lipids flagged", source_doc_at: repo.newestHealthDocDate() });

  let view = repo.getHealthSynthesisView();
  assert.equal(view.stale, false);

  // deriveDirectives() idempotently CLEARS + REWRITES the 'markers' source on every
  // call — same content gets brand-new autoincrement ids. That churn alone must
  // never read as drift (this is why the signature keys on directive_key, not id).
  const before = repo
    .listActiveDirectives()
    .map((d) => d.id)
    .sort();
  repo.deriveDirectives();
  const after = repo
    .listActiveDirectives()
    .map((d) => d.id)
    .sort();
  assert.notDeepEqual(before, after, "sanity: the ids really did change on re-derive");

  view = repo.getHealthSynthesisView();
  assert.equal(view.stale, false, "unchanged directive content must not flip stale");
  assert.equal(view.stale_reason, null);
});

test("a genuinely new directive family flips stale with reason 'drift'", () => {
  seedHealthDoc(localDaysAgo(5), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  repo.saveHealthSynthesis({ headline: "Lipids flagged", source_doc_at: repo.newestHealthDocDate() });
  assert.equal(repo.getHealthSynthesisView().stale, false);

  // A NEW off-optimal marker (different zone) — a real new directive family, not a re-derive.
  seedHealthDoc(localDaysAgo(5), [marker("Vitamin D 25-OH", 18, { unit: "ng/mL", flag: "low" })]);
  repo.deriveDirectives();

  const view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true);
  assert.equal(view.stale_reason, "drift");
});

test("a new whole-picture health review flips stale with reason 'drift'", () => {
  repo.saveHealthSynthesis({ headline: "Baseline", generated_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(repo.getHealthSynthesisView().stale, false);

  repo.addHealthReview({ headline: "Fresh review", focus: [{ title: "Something" }] }, "stub");

  const view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true);
  assert.equal(view.stale_reason, "drift");
});

test("training volume crossing a training-week (7+ new sessions) flips stale; a single new session does not", () => {
  for (let i = 0; i < 3; i++) seedTrainingDay(localDaysAgo(20 - i));
  repo.saveHealthSynthesis({ headline: "Baseline load", generated_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(repo.getHealthSynthesisView().stale, false);

  // Sub-threshold: one more session must not flag on its own.
  seedTrainingDay(localDaysAgo(1));
  let view = repo.getHealthSynthesisView();
  assert.equal(view.stale, false, "a single new session is normal, not a picture change");

  // Cross the ~week threshold (net +7 since baseline).
  for (let i = 2; i <= 7; i++) seedTrainingDay(localDaysAgo(i));
  view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true);
  assert.equal(view.stale_reason, "drift");
});

test("a bodyweight trend flip (down → up) flips stale; a 0.1 lb wiggle does not", () => {
  // Sharp downward trend over the window.
  seedWeight(localDaysAgo(10), 185);
  seedWeight(localDaysAgo(3), 170);
  repo.saveHealthSynthesis({ headline: "Trending down", generated_at: "2026-01-01T00:00:00.000Z" });
  const sig = repo.computeHealthDriftSignature();
  assert.equal(sig.weight_bucket, "down");
  assert.equal(repo.getHealthSynthesisView().stale, false);

  // A dramatic rebound decisively flips the least-squares slope to 'up'.
  seedWeight(localDaysAgo(0), 210);
  const view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true);
  assert.equal(view.stale_reason, "drift");
});

test("a flat trend with a tiny wiggle stays 'flat' and does not flip stale", () => {
  seedWeight(localDaysAgo(10), 170);
  seedWeight(localDaysAgo(3), 170);
  repo.saveHealthSynthesis({ headline: "Holding steady", generated_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(repo.computeHealthDriftSignature().weight_bucket, "flat");
  assert.equal(repo.getHealthSynthesisView().stale, false);

  seedWeight(localDaysAgo(0), 170.1); // a 0.1 lb wiggle
  assert.equal(repo.computeHealthDriftSignature().weight_bucket, "flat");
  const view = repo.getHealthSynthesisView();
  assert.equal(view.stale, false);
  assert.equal(view.stale_reason, null);
});

test("crossing the minimum-data floor alone (none → flat) is not itself a drift trigger", () => {
  // Only one point at save time → 'none' (not enough data to mean anything).
  seedWeight(localDaysAgo(3), 170);
  repo.saveHealthSynthesis({ headline: "Not enough data yet", generated_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(repo.computeHealthDriftSignature().weight_bucket, "none");

  // A second point crosses into 'flat' — real data now exists, but that alone
  // isn't a picture CHANGE worth a re-read.
  seedWeight(localDaysAgo(0), 170.05);
  assert.equal(repo.computeHealthDriftSignature().weight_bucket, "flat");
  const view = repo.getHealthSynthesisView();
  assert.equal(view.stale, false);
  assert.equal(view.stale_reason, null);
});

test("an injury opening flips stale with reason 'drift'; resolving it flips again", () => {
  repo.saveHealthSynthesis({ headline: "No open injuries", generated_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(repo.getHealthSynthesisView().stale, false);

  const created = repo.addContextEvent({ kind: "injury", title: "Tweaked lower back", start_date: localDaysAgo(0) });
  let view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true, "a newly opened injury is a picture change");
  assert.equal(view.stale_reason, "drift");

  // Re-baseline against the now-open injury, then resolve it — closing is a
  // picture change too.
  repo.saveHealthSynthesis({ headline: "Injury open", generated_at: "2026-01-02T00:00:00.000Z" });
  assert.equal(repo.getHealthSynthesisView().stale, false);
  repo.updateContextEvent(created.id, { resolved_at: localDaysAgo(0) });
  view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true, "resolving the injury is also a picture change");
  assert.equal(view.stale_reason, "drift");
});

test("new-labs staleness takes precedence over a concurrent drift condition", () => {
  seedHealthDoc(localDaysAgo(10), [marker("ApoB", 70, { unit: "mg/dL" })]);
  repo.saveHealthSynthesis({ headline: "Baseline", source_doc_at: repo.newestHealthDocDate() });
  assert.equal(repo.getHealthSynthesisView().stale, false);

  // Trigger BOTH a doc-date staleness and a drift condition at once.
  seedHealthDoc(localDaysAgo(1), [marker("ApoB", 70, { unit: "mg/dL" })]);
  repo.addContextEvent({ kind: "injury", title: "Also a picture change", start_date: localDaysAgo(0) });

  const view = repo.getHealthSynthesisView();
  assert.equal(view.stale, true);
  assert.equal(view.stale_reason, "new_labs", "the doc-date check is checked first and wins the reason");
});
