import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceAttentionState,
  applyAttentionObservation,
  getAttentionSchedule,
  listDueAttention,
} from "../dist/repo/attention.js";

const policy = {
  signal_class: "marker:ferritin",
  domain: "health",
  source: "markers",
  active_days: 70,
  confirming_days: 42,
  surveillance_initial_days: 90,
  surveillance_multiplier: 2,
  surveillance_max_days: 180,
  surveillance_checks_before_release: 1,
  reason: "Ferritin is being actively corrected; recheck after the expected iron-response window.",
  release_condition: "Ferritin optimal through confirmation and surveillance with no active iron intervention.",
};

function essential(entry) {
  assert.ok(entry.reason, `${entry.tier} has reason`);
  assert.ok(entry.release_condition, `${entry.tier} has release_condition`);
  return {
    tier: entry.tier,
    next_due: entry.next_due,
    last_checked: entry.last_checked,
    reason: entry.reason,
    release_condition: entry.release_condition,
    clean_checks: entry.state.clean_checks,
    confirming_checks: entry.state.confirming_checks,
    surveillance_checks: entry.state.surveillance_checks,
    surveillance_interval_days: entry.state.surveillance_interval_days,
  };
}

test("attention state machine goes active -> confirming -> surveillance -> released -> reactivation", () => {
  const active = advanceAttentionState({
    signal_key: "marker:ferritin",
    policy,
    observation: {
      checked_at: "2026-01-01",
      status: "flagged",
      reason: "Ferritin is below optimal and an iron intervention is active.",
    },
  });
  assert.deepEqual(essential(active), {
    tier: "active",
    next_due: "2026-03-12",
    last_checked: "2026-01-01",
    reason: "Ferritin is below optimal and an iron intervention is active.",
    release_condition: policy.release_condition,
    clean_checks: 0,
    confirming_checks: 0,
    surveillance_checks: 0,
    surveillance_interval_days: 90,
  });

  const confirming = advanceAttentionState({
    signal_key: "marker:ferritin",
    policy,
    previous: active,
    observation: { checked_at: "2026-03-12", status: "optimal" },
  });
  assert.deepEqual(essential(confirming), {
    tier: "confirming",
    next_due: "2026-04-23",
    last_checked: "2026-03-12",
    reason: "The result is clean now; confirm it holds before stretching the interval.",
    release_condition: policy.release_condition,
    clean_checks: 1,
    confirming_checks: 1,
    surveillance_checks: 0,
    surveillance_interval_days: 90,
  });

  const surveillance = advanceAttentionState({
    signal_key: "marker:ferritin",
    policy,
    previous: confirming,
    observation: { checked_at: "2026-04-23", status: "stable" },
  });
  assert.deepEqual(essential(surveillance), {
    tier: "surveillance",
    next_due: "2026-07-22",
    last_checked: "2026-04-23",
    reason: "The clean result held, so the next check can stretch instead of staying on a fixed cadence.",
    release_condition: policy.release_condition,
    clean_checks: 2,
    confirming_checks: 2,
    surveillance_checks: 0,
    surveillance_interval_days: 90,
  });

  const released = advanceAttentionState({
    signal_key: "marker:ferritin",
    policy,
    previous: surveillance,
    observation: { checked_at: "2026-07-22", status: "stable" },
  });
  assert.deepEqual(essential(released), {
    tier: "released",
    next_due: null,
    last_checked: "2026-07-22",
    reason: "This signal is stable and clean with no active lever, so it goes quiet until new data or symptoms bring it back.",
    release_condition: policy.release_condition,
    clean_checks: 3,
    confirming_checks: 2,
    surveillance_checks: 1,
    surveillance_interval_days: 180,
  });

  const reactivated = advanceAttentionState({
    signal_key: "marker:ferritin",
    policy,
    previous: released,
    observation: {
      checked_at: "2026-08-01",
      status: "stable",
      event: "symptom",
    },
  });
  assert.deepEqual(essential(reactivated), {
    tier: "active",
    next_due: "2026-10-10",
    last_checked: "2026-08-01",
    reason: "A related symptom was reported, so this signal re-enters active follow-up.",
    release_condition: policy.release_condition,
    clean_checks: 0,
    confirming_checks: 0,
    surveillance_checks: 0,
    surveillance_interval_days: 90,
  });
});

test("attention schedule persists rows and released entries are never due", () => {
  const active = applyAttentionObservation({
    signal_key: "marker:ferritin",
    policy,
    observation: { checked_at: "2026-01-01", status: "flagged" },
  });
  assert.equal(active.tier, "active");
  assert.equal(listDueAttention("2026-03-12").length, 1);

  let next = active;
  for (const checked_at of ["2026-03-12", "2026-04-23", "2026-07-22"]) {
    next = applyAttentionObservation({
      signal_key: "marker:ferritin",
      policy,
      observation: { checked_at, status: "optimal" },
    });
  }

  assert.equal(next.tier, "released");
  assert.equal(next.next_due, null);
  assert.ok(next.reason);
  assert.ok(next.release_condition);
  assert.equal(listDueAttention("2028-01-01").length, 0);

  const stored = getAttentionSchedule("marker:ferritin");
  assert.equal(stored.tier, "released");
  assert.equal(stored.next_due, null);
});
