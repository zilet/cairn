// A Today × sticks. Before, the dismissal only wrote evidence (surface_dismissals)
// that no producer read, so the card came back the next day. Each dismissible card
// without an acknowledgement of its own now holds it its own way
// (today-agenda.ts holdTodayAgendaDismissal):
//   - goal-checkin: its own 14-day cooldown (dismissGoalCheckin);
//   - sensor-recheck / measurement-request-<need>: the attention ladder is released
//     until the episode ends (a reading / the measurement lands);
//   - since-last / standing-momentum: keyed on what the card says, back when it
//     says something new;
// and a card with its own Hold or ack (an announced change, a plan decision) is never
// hidden by it. Synthetic fixtures only. Deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo, seedHealthDoc, marker, seedWeight } from "./_seed.js";
import { holdTodayAgendaDismissal, todayAgenda } from "../dist/repo/today-agenda.js";
import { sensorRecheckCandidate } from "../dist/repo/sensor-recheck.js";
import { measurementRequestCandidate } from "../dist/repo/measurement-request.js";
import { localDateISO, addDaysISO } from "../dist/repo/shared.js";

const today = () => localDateISO();

test("goal check-in: the × starts its own cooldown", () => {
  repo.setProfile({ age: 35, height_cm: 180, weight_lb: 185, activity_factor: 1.5, goal_mode: "maintain" });
  assert.equal(repo.goalCheckinCandidate(localDaysAgo(200)), null, "seed: last checked long ago");
  assert.ok(repo.goalCheckinCandidate(), "precondition: the backstop check-in fires");
  assert.equal(holdTodayAgendaDismissal("goal-checkin"), true);
  assert.equal(repo.goalCheckinCandidate(), null, "dismissed: quiet through its cooldown");
});

test("sensor recheck: the × releases the offer until a new reading lands", () => {
  for (const daysAgo of [42, 46, 50, 55, 60, 66, 72, 80, 92, 104, 118, 130]) {
    repo.recordDailyMetrics("apple", localDaysAgo(daysAgo), { hrv_ms: 52, resting_hr: 54, sleep_min: 430 });
  }
  assert.ok(sensorRecheckCandidate(), "precondition: the offer is live");
  assert.equal(holdTodayAgendaDismissal("sensor-recheck"), true);
  assert.equal(sensorRecheckCandidate(), null, "dismissed: quiet");
  assert.equal(sensorRecheckCandidate(addDaysISO(today(), 60)), null, "and it stays quiet, not just for a day");
  assert.equal(repo.getAttentionSchedule("recovery:sensor-recheck").tier, "released");
});

test("measurement request: the × releases that need until the measurement lands", () => {
  repo.setProfile({
    sex: "male",
    age: 44,
    height_cm: 178,
    weight_lb: 168,
    goal_weight_lb: 164,
    goal_mode: "lose",
    activity_factor: 1.5,
  });
  repo.logWeight(168, addDaysISO(today(), -20));
  const card = measurementRequestCandidate(today());
  assert.equal(card?.id, "measurement-request-weigh-in", "precondition: the weigh-in ask is live");
  assert.equal(holdTodayAgendaDismissal(card.id), true);
  assert.equal(measurementRequestCandidate(today()), null);
  assert.equal(measurementRequestCandidate(addDaysISO(today(), 40)), null, "no ladder step brings it back");
  assert.equal(holdTodayAgendaDismissal("measurement-request-body-measurement"), false, "a need that is not live holds nothing");
});

test("since-last: the × holds while the card says the same thing, and it returns with news", () => {
  const sqlAgo = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
  repo.setAppState("today_last_seen_at", sqlAgo(2 * 60 * 60 * 1000));
  seedHealthDoc("2026-06-23", [marker("ApoB", 88, { unit: "mg/dL" })], "bloodwork");
  const ids = () => {
    const agenda = todayAgenda(today(), { markIntroduced: false });
    return [...agenda.primary, ...agenda.more].map((c) => c.id);
  };
  assert.ok(ids().includes("since-last"), "precondition: the continuity card shows");
  assert.equal(holdTodayAgendaDismissal("since-last"), true);
  assert.ok(!ids().includes("since-last"), "dismissed: it stays off while its fact is the same");
  // Something new since the same stamp changes what the card says: it comes back.
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, date: localDaysAgo(1) }); // a lift day since the stamp
  const after = repo.sinceLastLookedCandidate();
  assert.ok(after, "precondition: the card still has something to say");
  assert.ok(ids().includes("since-last"), `a card that says something new returns: ${after.title} / ${after.body ?? ""}`);
});

test("a lab recheck × holds only for its ladder's own cooldown, never releases it", () => {
  repo.upsertAttentionSchedule({
    signal_key: "marker:apob",
    domain: "health",
    tier: "active",
    next_due: addDaysISO(today(), -60),
    last_checked: addDaysISO(today(), -120),
    reason: "a marker past its recheck window",
    release_condition: "a new reading",
    source: "markers",
    state: {},
  });
  const card = measurementRequestCandidate(today());
  assert.equal(card?.id, "measurement-request-lab-recheck", "precondition: the lab recheck ask is live");
  assert.equal(holdTodayAgendaDismissal(card.id), true);
  const entry = repo.getAttentionSchedule("measurement-request:lab-recheck");
  assert.notEqual(entry.tier, "released", "health-adjacent: never released by a ×");
  assert.ok(entry.next_due > today(), "quiet for the ladder's own cooldown");
  assert.equal(measurementRequestCandidate(today()), null);
  assert.ok(measurementRequestCandidate(addDaysISO(entry.next_due, 1)), "and back when the cooldown ends");
});

test("standing momentum: the × holds while the same wins stand, whatever the numbers do", () => {
  repo.setProfile({ age: 40, height_cm: 180, weight_lb: 200, goal_weight_lb: 180, goal_mode: "lose", activity_factor: 1.5 });
  const weighIns = (start) => {
    for (let i = 0; i <= 28; i += 2) seedWeight(localDaysAgo(28 - i), start - i * 0.1);
  };
  weighIns(200);
  const ids = () => {
    const agenda = todayAgenda(today(), { markIntroduced: false });
    return [...agenda.primary, ...agenda.more].map((c) => c.id);
  };
  assert.ok(ids().includes("standing-momentum"), "precondition: a steady loss reads as momentum");
  assert.equal(holdTodayAgendaDismissal("standing-momentum"), true);
  assert.ok(!ids().includes("standing-momentum"));
  seedWeight(today(), 196.2); // the weekly rate moves; the win is the same kind
  assert.ok(!ids().includes("standing-momentum"), "a moved number is not a new fact");
});

test("an announced change and a plan decision are never hidden by a ×", () => {
  assert.equal(holdTodayAgendaDismissal("announced-decision-12"), false);
  assert.equal(holdTodayAgendaDismissal("draft-proposals"), false);
  assert.equal(holdTodayAgendaDismissal("health-focus"), false);
  const ids = () => {
    const agenda = todayAgenda(today(), { markIntroduced: false });
    return [...agenda.primary, ...agenda.more].map((c) => c.id);
  };
  // Nothing fact-keyed was dismissed, so nothing is filtered from the agenda.
  const before = ids();
  db.prepare(`INSERT INTO surface_dismissals (surface, item_key, date) VALUES ('today_agenda', 'announced-decision-12', ?)`).run(
    today()
  );
  assert.deepEqual(ids(), before);
});
