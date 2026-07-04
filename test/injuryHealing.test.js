// Injuries heal over time (Wave B / B1). A minor injury gets a short expected
// recovery window; past that window, with the affected area TRAINED since, it's
// LIKELY-RESOLVED — it stops gating the day-read/conductor as a hard constraint,
// without ever hard-deleting the record. An explicit resolve closes it outright.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay, localDaysAgo } from "./_seed.js";

beforeEach(() => resetTables("context_events", "sessions", "logged_sets", "exercises", "day_reads"));

test("addContextEvent defaults a short healing window for a minor injury", () => {
  const ev = repo.addContextEvent({ kind: "injury", title: "Foot sole cuts", meta: { severity: "mild" } });
  assert.equal(ev.expected_recovery_days, 5, "a mild injury defaults to a 5-day window");
  const sev = repo.addContextEvent({ kind: "injury", title: "Hamstring strain", meta: { severity: "severe" } });
  assert.equal(sev.expected_recovery_days, 42, "a severe injury lingers longer");
  const none = repo.addContextEvent({ kind: "injury", title: "Tweaked something" });
  assert.equal(none.expected_recovery_days, 7, "no severity → a short-ish default week");
});

test("defaultInjuryWindow maps severity to a window", () => {
  assert.equal(repo.defaultInjuryWindow("mild"), 5);
  assert.equal(repo.defaultInjuryWindow("moderate"), 14);
  assert.equal(repo.defaultInjuryWindow("severe"), 42);
  assert.equal(repo.defaultInjuryWindow(null), 7);
});

test("an injury past its window with resumed training no longer hard-gates", () => {
  // A knee injury 15 days ago, mild → a 5-day window that closed 10 days ago.
  const ev = repo.addContextEvent({
    kind: "injury",
    title: "Knee pain",
    start_date: localDaysAgo(15),
    meta: { area: "knee", severity: "mild" },
  });
  // Training on the knee-loading area (Test Squat → legs) resumed 3 days ago — after
  // the window closed.
  seedTrainingDay(localDaysAgo(3));

  const healing = repo.contextEventHealing(ev);
  assert.equal(healing.past_window, true, "past its expected recovery window");
  assert.equal(healing.trained_since, true, "the injured area was trained after the window");
  assert.equal(healing.likely_resolved, true, "→ likely resolved (a soft note, not a gate)");

  // The active-context effect no longer eases load for it, and it's not surfaced as a
  // hard injury impact — but the RECORD still exists (never hard-deleted).
  const eff = repo.activeContextEffect();
  assert.equal(eff.reduce_load, false, "a likely-resolved injury stops easing load");
  const impacts = repo.getInjuryImpacts();
  assert.equal(impacts.count, 0, "a likely-resolved injury generates no hard exercise gates");
  assert.ok(repo.getContextEvent(ev.id), "the record is not hard-deleted");
});

test("a past-window injury with NO resumed training still gates + asks to confirm", () => {
  const ev = repo.addContextEvent({
    kind: "injury",
    title: "Knee pain",
    start_date: localDaysAgo(15),
    meta: { area: "knee", severity: "mild" },
  });
  // No training logged after the window → not decayed (they may have stopped BECAUSE
  // of it), so it still eases load, but it's surfaced for a gentle one-time confirm.
  const healing = repo.contextEventHealing(ev);
  assert.equal(healing.past_window, true);
  assert.equal(healing.likely_resolved, false, "no resumed training → not auto-decayed");

  const eff = repo.activeContextEffect();
  assert.equal(eff.reduce_load, true, "still eases load until confirmed");
  assert.equal(eff.resolve_candidates.length, 1, "surfaced for a gentle 'still bothering you?'");
  assert.equal(eff.resolve_candidates[0].id, ev.id);
});

test("an explicit resolve closes an injury without deleting it", () => {
  const ev = repo.addContextEvent({
    kind: "injury",
    title: "Rolled ankle",
    start_date: localDaysAgo(1), // fresh, still well within its window
    meta: { area: "ankle", severity: "moderate" },
  });
  assert.equal(repo.activeContextEffect().reduce_load, true, "an active fresh injury eases load");

  const resolved = repo.resolveContextEvent(ev.id);
  assert.ok(resolved.resolved_at, "resolved_at is stamped");

  // No longer in the active set / no longer eases load — but still on the full timeline.
  const active = repo.listContextEvents({ activeOnly: true });
  assert.equal(active.some((e) => e.id === ev.id), false, "resolved → out of the active set");
  assert.equal(repo.activeContextEffect().reduce_load, false, "resolved → stops easing load");
  const all = repo.listContextEvents({ activeOnly: false });
  assert.equal(all.some((e) => e.id === ev.id), true, "still present in the full timeline");
  assert.ok(repo.getContextEvent(ev.id), "the record is preserved, not deleted");
});
