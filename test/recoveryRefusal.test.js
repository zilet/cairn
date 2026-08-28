// A recovery week the athlete refused stays refused for the block — unless genuinely
// NEW safety-grade information arrives. These tests pin the narrow shape of the
// clinical arm: which health directives are news the refusal could not have answered,
// and which are old news restated or a lab lever that says nothing about training.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, resetTables } from "./_seed.js";
import {
  newSafetyGradeSignalSince,
  recoveryWeekMayBeAnnounced,
  recoveryWeekRefusedOn,
} from "../dist/repo/recovery-refusal.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const today = () => localDateISO();
const since = () => addDaysISO(today(), -3);

beforeEach(() => {
  resetTables("health_directives", "brain_decisions", "checkins", "sessions", "training_symptom_events", "context_events");
});

function directive(fields = {}) {
  const row = {
    source: "markers",
    domain: "nutrition",
    marker: "LDL-C",
    directive: "Cut saturated fat and raise soluble fiber.",
    rationale: "Lipid lever.",
    uncertain: 0,
    status: "active",
    resurfaced_from_id: null,
    created_at: `${addDaysISO(today(), -1)} 09:00:00`,
    ...fields,
  };
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive, rationale, uncertain, status, resurfaced_from_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.source,
    row.domain,
    row.marker,
    row.directive,
    row.rationale,
    row.uncertain,
    row.status,
    row.resurfaced_from_id,
    row.created_at
  );
}

test("a lab-lever directive is not safety-grade news about training", () => {
  assert.equal(newSafetyGradeSignalSince(since()), false, "an empty slate reopens nothing");

  directive({ domain: "nutrition" });
  assert.equal(newSafetyGradeSignalSince(since()), false, "a nutrition lipid lever says nothing about this week's training");

  resetTables("health_directives");
  directive({ domain: "watch" });
  assert.equal(newSafetyGradeSignalSince(since()), false, "nor does a watch/recheck reminder");
});

test("a RESURFACED training directive is old news restated, not a reopening", () => {
  // A worsening panel re-INSERTS a previously handled directive with a fresh
  // created_at. That new timestamp must not undo an unrelated training refusal.
  directive({
    domain: "training",
    directive: "Hold endurance volume while this anemia pattern is present.",
    resurfaced_from_id: 4321,
  });
  assert.equal(newSafetyGradeSignalSince(since()), false);
});

test("an UNCERTAIN training directive is a softer nudge, never a floor", () => {
  directive({
    domain: "training",
    directive: "Keep regular aerobic work in the week.",
    uncertain: 1,
  });
  assert.equal(newSafetyGradeSignalSince(since()), false);
});

test("a fresh, firm TRAINING directive does reopen the question", () => {
  directive({
    domain: "training",
    marker: "Ferritin",
    directive: "Hold endurance volume and keep easy days easy until iron recovers.",
  });
  assert.equal(newSafetyGradeSignalSince(since()), true, "a clinical constraint on training is news");
});

test("a directive derived BEFORE the refusal is something the athlete already answered", () => {
  directive({
    domain: "training",
    directive: "Hold endurance volume until iron recovers.",
    created_at: `${addDaysISO(today(), -10)} 09:00:00`,
  });
  assert.equal(newSafetyGradeSignalSince(since()), false);
});

// End to end: the refusal stands through a lab upload's resurfaced lipid news, and
// yields to a genuine training-clinical finding.
test("recoveryWeekMayBeAnnounced: a resurfaced lipid directive does not undo the refusal", () => {
  const refusedOn = addDaysISO(today(), -3);
  db.prepare(
    `INSERT INTO brain_decisions (effective_date, kind, domain, summary, status, autonomy_tier, risk_class, context_json, created_at)
     VALUES (?, 'training_structure', 'recovery', 'Recovery week', 'canceled', 'announce', 'structural', ?, ?)`
  ).run(
    refusedOn,
    JSON.stringify({ held_by_user: true, held_by_user_on: refusedOn }),
    `${refusedOn} 08:00:00`
  );

  assert.deepEqual(recoveryWeekMayBeAnnounced(today()), { allowed: false, refused_on: refusedOn });

  directive({ domain: "nutrition" });
  directive({ domain: "training", directive: "Keep regular aerobic work.", uncertain: 1 });
  directive({ domain: "training", directive: "Hold endurance volume.", resurfaced_from_id: 99 });
  assert.equal(
    recoveryWeekMayBeAnnounced(today()).allowed,
    false,
    "lab news restated is not the athlete's question being reopened"
  );

  directive({ domain: "training", source: "health_review", marker: "Ferritin", directive: "Hold endurance volume until iron recovers." });
  assert.equal(recoveryWeekMayBeAnnounced(today()).allowed, true, "a firm clinical training constraint reopens it");
});

test("the newest refusal wins, not the newest proposal", () => {
  // The stale ask was PROPOSED most recently but refused a month ago; the older ask
  // was refused yesterday. Ordering by created_at returned the stale refusal and aged
  // the athlete's actual "no" out of the block early.
  const old = addDaysISO(today(), -40);
  const recent = addDaysISO(today(), -1);
  db.prepare(
    `INSERT INTO brain_decisions (effective_date, kind, domain, summary, status, autonomy_tier, risk_class, context_json, created_at)
     VALUES (?, 'training_structure', 'recovery', 'Older ask, refused yesterday', 'canceled', 'announce', 'structural', ?, ?)`
  ).run(old, JSON.stringify({ held_by_user: true, held_by_user_on: recent }), `${old} 08:00:00`);
  db.prepare(
    `INSERT INTO brain_decisions (effective_date, kind, domain, summary, status, autonomy_tier, risk_class, context_json, created_at)
     VALUES (?, 'training_structure', 'recovery', 'Newer ask, refused long ago', 'canceled', 'announce', 'structural', ?, ?)`
  ).run(recent, JSON.stringify({ held_by_user: true, held_by_user_on: old }), `${recent} 08:00:00`);

  assert.equal(recoveryWeekRefusedOn(today()), recent, "the newest refusal date is the one on record");
});
