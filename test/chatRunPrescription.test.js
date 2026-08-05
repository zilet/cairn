// Chat can prescribe a RUN, and every run receipt is read back out of the store.
//
// Two holes this file exists to keep closed:
//   1. Chat had no run vocabulary. "Make tomorrow's run 8k easy" could only be
//      expressed as a plan_update change, and applyPlanChange sees LIFTING items
//      only — so the request added a 3×8–12 exercise literally named "Easy run"
//      beside the untouched 5 km cardio row.
//   2. That fabricated movement then read back intact, so the server appended
//      "Saved and verified plan day 1" to a run that had never changed. The mirror
//      case lied the other way: a kind:'cardio' change DID land through
//      setWeeklyRuns, and the readback (which could not see cardio rows) told the
//      athlete their plan was unchanged.
//
// The agent never runs here — actions are hand-built and applied through the same
// applyChatActions the worker calls, exactly like test/chatTurns.test.js.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  applyChatActions,
  hasExplicitRunEditIntent,
  PLAN_NO_CHANGE_APPENDED_VARIANTS,
  reconcileChatPlanReply,
  reconcileChatRunReply,
  runZoneTag,
  verifyRunReadback,
} from "../dist/chatTurns.js";
import { getHrModel, hrZoneLabel } from "../dist/repo/hr-model.js";
import { runZones } from "../dist/repo/run-progression.js";
import { localDateISO } from "../dist/repo/shared.js";

const ASK = "Make tomorrow's run 8k easy.";

// A run's day_number is a Monday-anchored slot in THIS week, and set_run refuses a slot
// whose date has already gone by. So the fixtures live on TODAY's slot — the whole file
// then reads the same on any weekday instead of passing only on a Monday.
function weekSlotFor(dateISO) {
  const day = new Date(`${dateISO}T00:00:00Z`).getUTCDay();
  return ((day + 6) % 7) + 1;
}
const DAY = weekSlotFor(localDateISO());
// A second, unrelated plan day for the "one run per turn" case. It is never written to,
// so it only has to be a different number.
const OTHER_DAY = DAY === 3 ? 4 : 3;

beforeEach(() => {
  resetTables(
    "chat_turns",
    "chat_messages",
    "plan_proposals",
    "brain_decisions",
    "plan_items",
    "plan_days",
    "exercises",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "hr_model_state"
  );
  repo.setSettings({ lead_mode: "lead" });
});

function seedRunDay(runs = [{ label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" }]) {
  repo.savePlanDay(DAY, "Run + core", "Endurance", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
    ...runs.map((run) => ({
      kind: "cardio",
      exercise: run.label,
      target_distance_km: run.target_distance_km ?? null,
      target_duration_min: run.target_duration_min ?? null,
      target_zone: run.target_zone ?? null,
    })),
  ]);
}

function planRuns(dayNumber = DAY) {
  return repo.getPlanDay(dayNumber).items.filter((item) => item.kind === "cardio");
}

function planLifts(dayNumber = DAY) {
  return repo.getPlanDay(dayNumber).items.filter((item) => item.kind !== "cardio");
}

function setRun(action, message = ASK) {
  return applyChatActions({ actions: [{ type: "set_run", ...action }] }, { agent: "stub", message });
}

// ── the run action ───────────────────────────────────────────────────────────

test("set_run writes the run through the shared cardio writer and verifies it against the store", () => {
  seedRunDay();
  const out = setRun({ day_number: DAY, kind: "easy", distance_km: 8, reason: "athlete asked for a longer easy run" });

  const result = out.applied[0].result;
  assert.equal(out.applied[0].type, "set_run");
  assert.equal(result.persisted, true, "an athlete-requested single run is a bounded direct write");
  assert.equal(result.verified, true);
  assert.equal(result.tier, "quiet_apply");
  assert.deepEqual(result.verification.mismatches, []);

  const runs = planRuns();
  assert.equal(runs.length, 1, "the day's run was replaced, not duplicated");
  assert.equal(runs[0].target_distance_km, 8);
  assert.equal(runs[0].note, "Easy run", "a cardio row carries its label in the note column");
  assert.equal(planLifts().length, 1, "lifting on that day is untouched");
  assert.equal(planLifts()[0].exercise, "Back Squat");

  // It went through the proposal path every other adaptation uses.
  const proposal = repo.getProposal(result.proposal_id);
  assert.equal(proposal.status, "applied");
  assert.equal(proposal.parsed.cardio.length, 1, "the payload is a cardio[] the run writer owns");
  assert.equal(proposal.parsed.changes, undefined, "a run is never expressed as a lifting change");
});

test("a distance-only change keeps the run's zone, and a stated dose retires the other one", () => {
  seedRunDay([{ label: "Easy run", target_duration_min: 45, target_zone: "Z2 (142–148 bpm)" }]);
  setRun({ day_number: DAY, distance_km: 8 });

  const run = planRuns()[0];
  assert.equal(run.target_distance_km, 8);
  assert.equal(run.target_duration_min, null, "8k over a 45-minute run must not store as '8 km for 45 minutes'");
  assert.equal(run.target_zone, "Z2 (142–148 bpm)", "an unstated zone carries forward");
});

test("other runs on the same day survive an edit to one of them", () => {
  seedRunDay([
    { label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { label: "Strides", target_duration_min: 10, target_zone: "Z4 (157–164 bpm)" },
  ]);
  const out = setRun({ day_number: DAY, match_label: "Easy run", distance_km: 8 });

  assert.equal(out.applied[0].result.verified, true);
  const runs = planRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.note === "Easy run").target_distance_km, 8);
  const strides = runs.find((run) => run.note === "Strides");
  assert.equal(strides.target_duration_min, 10, "the untouched run keeps its dose");
  assert.equal(strides.target_zone, "Z4 (157–164 bpm)", "and its zone");
});

test("an ambiguous run edit is refused, not guessed at", () => {
  seedRunDay([
    { label: "Morning run", target_distance_km: 5 },
    { label: "Evening run", target_distance_km: 4 },
  ]);
  const out = setRun({ day_number: DAY, distance_km: 8 });

  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.persisted, false);
  assert.match(result.error, /didn't say which one/);
  assert.deepEqual(
    planRuns().map((run) => run.target_distance_km),
    [5, 4],
    "nothing was written"
  );
});

test("an invented day number never quietly becomes a new training day", () => {
  seedRunDay();
  const before = repo.getPlan().length;
  const out = setRun({ day_number: 9, distance_km: 8 });

  assert.equal(out.applied[0].result.ok, false);
  assert.match(out.applied[0].result.error, /no day 9/);
  assert.equal(repo.getPlan().length, before, "the plan gained no day");
});

test("one run per turn — a whole week of runs stays a proposal", () => {
  seedRunDay();
  repo.savePlanDay(OTHER_DAY, "Run", "Endurance", [{ kind: "cardio", exercise: "Long run", target_distance_km: 12 }]);
  const out = applyChatActions(
    {
      actions: [
        { type: "set_run", day_number: DAY, distance_km: 8 },
        { type: "set_run", day_number: OTHER_DAY, distance_km: 18 },
      ],
    },
    { agent: "stub", message: "Rebuild my running week: make tomorrow 8k and the long run 18k." }
  );

  assert.equal(out.applied[0].result.verified, true);
  assert.equal(out.applied[1].result.ok, false);
  assert.match(out.applied[1].result.error, /run plan/);
  assert.equal(planRuns(OTHER_DAY)[0].target_distance_km, 12, "the second run was never written");
});

test("a food-only turn cannot move a run", () => {
  seedRunDay();
  const out = setRun({ day_number: DAY, distance_km: 8 }, "Had a chicken burrito bowl for lunch, maybe 700 calories.");
  assert.equal(out.applied.length, 0);
  assert.equal(planRuns()[0].target_distance_km, 5);
});

// ── the zone speaks the athlete's own physiology ──────────────────────────────

let activitySeq = 0;
function garminSource() {
  const existing = db.prepare(`SELECT id FROM garmin_sources LIMIT 1`).get();
  if (existing) return existing.id;
  return Number(
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'run-zone-test')`).run().lastInsertRowid
  );
}
function shift(days) {
  return new Date(Date.parse(`${localDateISO()}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
}
function logRun({ daysAgo, minutes, km, avgHr, maxHr }) {
  activitySeq += 1;
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, date, type, name, duration_min, moving_min, distance_km, avg_hr, max_hr)
     VALUES (?, ?, ?, 'running', 'Run', ?, ?, ?, ?, ?)`
  ).run(garminSource(), `run-zone-${activitySeq}`, shift(daysAgo), minutes, minutes, km, avgHr, maxHr);
}
// The athlete the personal model exists for: observed max 182, a sustained 54
// minutes averaging 163 — an easy ceiling well above any population band.
function seedPersonalHrModel() {
  logRun({ daysAgo: 12, minutes: 42, km: 8.5, avgHr: 149, maxHr: 182 });
  logRun({ daysAgo: 26, minutes: 30, km: 6, avgHr: 152, maxHr: 180 });
  logRun({ daysAgo: 40, minutes: 28, km: 5.5, avgHr: 147, maxHr: 179 });
  logRun({ daysAgo: 20, minutes: 54, km: 11, avgHr: 163, maxHr: 179 });
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, resting_hr) VALUES (?, ?, 53)`).run(
    garminSource(),
    shift(1)
  );
}

test("a prescribed zone carries the athlete's OWN band, never the age formula's", () => {
  repo.setProfile({ age: 40 }); // makes the population formula available — and unused
  seedPersonalHrModel();
  seedRunDay([{ label: "Easy run", target_distance_km: 5 }]);

  const model = getHrModel();
  assert.notEqual(model.confidence, "insufficient", "the personal model has enough running to speak");
  setRun({ day_number: DAY, distance_km: 8, zone: "z2" });

  const stored = planRuns()[0].target_zone;
  assert.equal(stored, hrZoneLabel("z2", model), "the stored band is the personal model's");
  assert.match(stored, /^Z2 \(\d+–\d+ bpm\)$/);
  // runZones() itself now resolves through the personal model (the round's
  // one-Z2-everywhere fix), so the population comparison must ask for the raw
  // formula explicitly.
  const formulaBand = runZones({ model: null }).zones.find((zone) => zone.zone === "Z2");
  assert.ok(formulaBand, "the age formula would have had an answer");
  assert.notEqual(
    stored,
    `Z2 (${formulaBand.low_bpm}–${formulaBand.high_bpm} bpm)`,
    "and it is NOT the population band"
  );
});

test("a rendered zone tag is re-derived from the model, never trusted as text", () => {
  seedPersonalHrModel();
  seedRunDay([{ label: "Easy run", target_distance_km: 5 }]);
  applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "8k easy",
          // A stale/borrowed band the model typed out. Only the KEY survives.
          changes: [
            {
              day_number: DAY,
              kind: "cardio",
              label: "Easy run",
              target_distance_km: 8,
              target_zone: "Z2 (128–140 bpm)",
            },
          ],
        },
      ],
    },
    { agent: "stub", message: ASK }
  );
  assert.equal(planRuns()[0].target_zone, hrZoneLabel("z2", getHrModel()));
});

test("with too little running to model, the zone stays a bare key rather than borrowing a formula", () => {
  repo.setProfile({ age: 40 });
  seedRunDay([{ label: "Easy run", target_distance_km: 5 }]);
  assert.equal(getHrModel().confidence, "insufficient");

  assert.equal(runZoneTag("z2"), "Z2");
  setRun({ day_number: DAY, distance_km: 8, zone: "z2" });
  assert.equal(planRuns()[0].target_zone, "Z2", "no invented bpm band");
});

// ── the readback is the truth ─────────────────────────────────────────────────

test("verifyRunReadback reports a run that never landed as failed", () => {
  seedRunDay();
  const missing = verifyRunReadback(DAY, {
    label: "Easy run",
    target_distance_km: 8,
    target_duration_min: null,
    target_zone: "Z2 (142–148 bpm)",
    interval: null,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.mismatches, ["distance_km"], "the store still says 5 km");

  const gone = verifyRunReadback(DAY, {
    label: "Tempo",
    target_distance_km: 8,
    target_duration_min: null,
    target_zone: null,
    interval: null,
  });
  assert.equal(gone.ok, false);
  assert.deepEqual(gone.mismatches, ["run"]);

  const lostLifting = verifyRunReadback(
    DAY,
    {
      label: "Easy run",
      target_distance_km: 5,
      target_duration_min: null,
      target_zone: "Z2 (142–148 bpm)",
      interval: null,
    },
    4
  );
  assert.equal(lostLifting.ok, false);
  assert.deepEqual(lostLifting.mismatches, ["strength_work"], "a run that cost the day its lifting is not a success");
});

test("a failed run write replaces model prose that claimed success", () => {
  const claimed = "I've updated tomorrow's run to 8k easy.";
  const failed = reconcileChatRunReply(claimed, ASK, [
    {
      type: "set_run",
      result: {
        ok: false,
        verified: false,
        persisted: false,
        error: "day 1 carries 2 runs and the request didn't say which one",
        verification: { ok: false, day_number: DAY, mismatches: ["not_applied"], run: null },
      },
    },
  ]);
  assert.doesNotMatch(failed, /I've updated/);
  assert.match(failed, /not live/);
  assert.match(failed, /unchanged/);
  assert.match(failed, /didn't say which one/);
});

test("the verified receipt is composed from the stored run, and names the day", () => {
  seedRunDay();
  const out = setRun({ day_number: DAY, kind: "easy", distance_km: 8 });
  const reply = reconcileChatRunReply("I'll take tomorrow's easy run out to 8k.", ASK, out.applied);
  assert.match(reply, /Saved and verified/);
  assert.match(reply, new RegExp(`day ${DAY}: Easy run · 8 km`));
  assert.match(reply, /lifting on that day is untouched/i);
});

test("an unbacked run claim is corrected when nothing was written", () => {
  const reply = reconcileChatRunReply("I've set tomorrow's run to 8k.", ASK, []);
  // The wording rotates by day (RUN_NOT_SAVED_VARIANTS); the FACT does not.
  assert.match(reply, /this week's runs are unchanged/i);
  // Ordinary coaching prose about running is left alone.
  assert.equal(
    reconcileChatRunReply("Tomorrow's run should feel conversational.", ASK, []),
    "Tomorrow's run should feel conversational."
  );
});

test("hasExplicitRunEditIntent separates an instruction from a question", () => {
  assert.equal(hasExplicitRunEditIntent(ASK), true);
  assert.equal(hasExplicitRunEditIntent("Drop Thursday's tempo to 6k"), true);
  assert.equal(hasExplicitRunEditIntent("Should I make tomorrow's run 8k?"), false);
  assert.equal(hasExplicitRunEditIntent("My knee hurt on today's run."), false);
});

// ── the false-verified hole ──────────────────────────────────────────────────

test("a run sent through plan_update no longer becomes a fake lifting movement that verifies", () => {
  seedRunDay();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "8k easy",
          changes: [{ day_number: DAY, exercise: "Easy run", target_distance_km: 8, reason: "athlete asked" }],
        },
      ],
    },
    { agent: "stub", message: ASK }
  );

  const result = out.applied[0].result;
  assert.equal(result.verified, true);
  assert.equal(planRuns().length, 1);
  assert.equal(planRuns()[0].target_distance_km, 8, "the request reached the actual run");
  assert.deepEqual(
    planLifts().map((item) => item.exercise),
    ["Back Squat"],
    "no 3×8–12 exercise called 'Easy run' was invented"
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM exercises WHERE name = 'Easy run'`).get().n,
    0,
    "and no such exercise entered the canon"
  );
});

test("a kind:'cardio' plan_update verifies instead of denying a write that landed", () => {
  seedRunDay();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "8k easy",
          changes: [{ day_number: DAY, kind: "cardio", label: "Easy run", target_distance_km: 8 }],
        },
      ],
    },
    { agent: "stub", message: ASK }
  );

  assert.equal(out.applied[0].result.verified, true, "the run landed, so the receipt says so");
  assert.equal(planRuns()[0].target_distance_km, 8);
  assert.equal(planRuns()[0].target_zone, "Z2 (142–148 bpm)", "and the zone survived the edit");
  const reply = reconcileChatPlanReply("Taking that run to 8k.", ASK, out.applied, out.drafts);
  assert.doesNotMatch(reply, /couldn't verify/);
  assert.match(reply, /Saved and verified/);
});

test("a mixed plan_update verifies its lifting and its run separately", () => {
  seedRunDay();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "lighter squat, longer run",
          changes: [
            { day_number: DAY, exercise: "Back Squat", target_weight: 175 },
            { day_number: DAY, kind: "cardio", label: "Easy run", target_distance_km: 8 },
          ],
        },
      ],
    },
    { agent: "stub", message: "Make today's squat 175 and the run 8k." }
  );

  const result = out.applied[0].result;
  assert.equal(result.verified, true);
  assert.equal(result.verification.checks.length, 1, "the lifting change is still checked as lifting");
  assert.equal(result.verification.runs.length, 1, "and the run as a run");
  assert.equal(planLifts()[0].target_weight, 175);
  assert.equal(planRuns()[0].target_distance_km, 8);
});

test("the run reconciler stays quiet about a plan change that isn't a run", () => {
  seedRunDay();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "lighter squat",
          changes: [{ day_number: DAY, exercise: "Back Squat", target_weight: 175 }],
        },
      ],
    },
    { agent: "stub", message: "Drop today's squat to 175." }
  );
  const reply = reconcileChatRunReply("Dropping the squat.", "Drop today's squat to 175.", out.applied);
  assert.equal(reply, "Dropping the squat.");
});

test("a run edit does not draw 'No plan change was saved' from the plan reconciler", () => {
  seedRunDay();
  const out = setRun({ day_number: DAY, distance_km: 8 });
  const planReply = reconcileChatPlanReply("I'll take that run out to 8k.", ASK, out.applied, out.drafts);
  // The appended note rotates, so exclude the WHOLE set, not one phrasing of it.
  for (const variant of PLAN_NO_CHANGE_APPENDED_VARIANTS) {
    assert.ok(!planReply.includes(variant), variant);
  }
  assert.doesNotMatch(planReply, /no plan change was saved/i);
  const full = reconcileChatRunReply(planReply, ASK, out.applied);
  assert.match(full, /Saved and verified/);
});

// ── autonomy posture ─────────────────────────────────────────────────────────

test("a review-everything posture holds the run and the receipt refuses to claim it", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedRunDay();
  const out = setRun({ day_number: DAY, distance_km: 8 });

  const result = out.applied[0].result;
  assert.equal(result.verified, false);
  assert.equal(result.persisted, false);
  assert.equal(result.review_required, true);
  assert.equal(planRuns()[0].target_distance_km, 5, "the stored run is unchanged");
  const reply = reconcileChatRunReply("I've moved that run to 8k.", ASK, out.applied);
  assert.doesNotMatch(reply, /I've moved/);
  assert.match(reply, /held for review/);
});

// ── a waiting proposal carries the EDIT, not a snapshot of the day ────────────
//
// A held or scheduled run proposal lands LATER, and setWeeklyRuns replaces a day's
// cardio wholesale. A payload built as "here is the whole day as it looked when I
// wrote this" therefore silently reverts every other run edited in the meantime.

test("a waiting run proposal folds its edit onto the day as it stands at apply time", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedRunDay([
    { label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { label: "Strides", target_duration_min: 10, target_zone: "Z4 (157–164 bpm)" },
  ]);
  const held = setRun({ day_number: DAY, match_label: "Easy run", distance_km: 8 });
  const proposalId = held.applied[0].result.proposal_id;
  assert.equal(held.applied[0].result.persisted, false, "the posture holds it as a draft");

  // The athlete edits the OTHER run on that day while the proposal waits.
  repo.setWeeklyRuns([
    { day_number: DAY, label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { day_number: DAY, label: "Strides", target_duration_min: 15, target_zone: "Z4 (157–164 bpm)" },
  ]);

  const applied = repo.applyProposal(proposalId);
  assert.equal(applied.ok, true);

  const runs = planRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.note === "Easy run").target_distance_km, 8, "the waiting edit landed");
  assert.equal(
    runs.find((run) => run.note === "Strides").target_duration_min,
    15,
    "and the edit made while it waited was not reverted by a stale snapshot"
  );
  const payload = repo.getProposal(proposalId).parsed.cardio;
  assert.equal(payload.length, 1, "the payload carries the ONE edit, not a copy of the day");
  assert.equal(payload[0].cardio_edit, true);
});

test("an unmarked cardio payload still replaces the day's runs wholesale", () => {
  seedRunDay([
    { label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { label: "Strides", target_duration_min: 10, target_zone: "Z4 (157–164 bpm)" },
  ]);
  // What the Monday tick and a run-plan proposal emit: the day's runs, as given.
  const proposal = repo.createProposal("stub", "weekly runs", "", {
    summary: "this week's runs",
    cardio: [{ day_number: DAY, kind: "cardio", label: "Long run", target_distance_km: 16 }],
  });
  assert.equal(repo.applyProposal(proposal.id).ok, true);

  const runs = planRuns();
  assert.deepEqual(
    runs.map((run) => run.note),
    ["Long run"],
    "the entries ARE the day's runs — the prior two are replaced, not merged onto"
  );
  assert.equal(planLifts().length, 1, "and lifting is still untouched");
});

// ── the week that already happened ───────────────────────────────────────────

test("a run day that has already gone by this week is refused, not rewritten", () => {
  if (DAY === 1) {
    // It is Monday: no slot in this week has passed yet, so there is nothing to refuse.
    // Today's own slot is still editable, which is the half this branch can assert.
    seedRunDay();
    const out = setRun({ day_number: DAY, distance_km: 8 });
    assert.equal(out.applied[0].result.verified, true, "today's slot is still the week ahead");
    return;
  }
  const pastDay = DAY - 1;
  repo.savePlanDay(pastDay, "Run", "Endurance", [
    { kind: "cardio", exercise: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
  ]);
  const out = setRun({ day_number: pastDay, distance_km: 8 }, "Make Monday's run 8k.");

  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.equal(result.persisted, false);
  assert.match(result.error, /already went by/);
  assert.equal(planRuns(pastDay)[0].target_distance_km, 5, "what the week prescribed is left as it was");
  const reply = reconcileChatRunReply("I've moved that run out to 8k.", ASK, out.applied);
  assert.doesNotMatch(reply, /I've moved/);
  assert.match(reply, /not live/);
  assert.match(reply, /already went by/);
});

test("adding a run to a lifting day still lands — it is bounded, and the athlete asked", () => {
  const liftDay = DAY < 7 ? DAY + 1 : DAY;
  repo.savePlanDay(liftDay, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const out = setRun({ day_number: liftDay, kind: "easy", distance_km: 6 }, "Add an easy 6k run to that day.");

  const result = out.applied[0].result;
  assert.equal(result.verified, true);
  assert.equal(planRuns(liftDay).length, 1);
  assert.equal(planRuns(liftDay)[0].target_distance_km, 6);
  assert.equal(planRuns(liftDay)[0].note, "Easy run");
  assert.equal(planLifts(liftDay).length, 1, "the lifting day keeps its lifting");
});

// ── removing a run ───────────────────────────────────────────────────────────

test("a cardio removal is refused in words instead of verifying a no-op", () => {
  seedRunDay();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "drop the run",
          changes: [{ day_number: DAY, kind: "cardio", label: "Easy run", remove: true }],
        },
      ],
    },
    { agent: "stub", message: "Remove today's run." }
  );

  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.error, /Plan screen/);
  assert.equal(planRuns().length, 1, "the run is still on the day");
  assert.equal(planRuns()[0].target_distance_km, 5, "and untouched");
  const reply = reconcileChatPlanReply("I've removed that run.", "Remove today's run.", out.applied, out.drafts);
  assert.doesNotMatch(reply, /I've removed/);
  assert.match(reply, /Plan screen/);
});

test("a removal alongside a real change never rides in as a run edit", () => {
  seedRunDay();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "lighter squat, and drop the run",
          changes: [
            { day_number: DAY, exercise: "Back Squat", target_weight: 175 },
            { day_number: DAY, kind: "cardio", label: "Easy run", remove: true },
          ],
        },
      ],
    },
    { agent: "stub", message: "Drop today's squat to 175 and remove the run." }
  );

  const result = out.applied[0].result;
  assert.equal(result.verified, false, "the turn did not do everything it was asked");
  assert.deepEqual(result.verification.errors, [result.verification.errors[0]]);
  assert.match(result.verification.errors[0], /Plan screen/);
  assert.equal(planRuns().length, 1, "the run was neither removed nor quietly rewritten");
  assert.equal(planRuns()[0].target_distance_km, 5);
});

// ── the same guarantee on the plan_update path ───────────────────────────────
//
// set_run is not the only way a run edit reaches the run writer: a plan_update whose
// changes[] carries an endurance prescription is split out and routed to the same
// place. That proposal goes through autonomy too, so it can be held or scheduled —
// and it carried the same build-time snapshot until now. A plan_update may also
// carry SEVERAL run changes in one turn, across days or on one day.

function planUpdate(changes, message = "Adjust this week's runs.") {
  return applyChatActions(
    { actions: [{ type: "plan_update", summary: "run adjustments", changes }] },
    { agent: "stub", message }
  );
}

test("a waiting plan_update folds each run edit onto its day as that day stands at apply time", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedRunDay([
    { label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { label: "Strides", target_duration_min: 10, target_zone: "Z4 (157–164 bpm)" },
  ]);
  repo.savePlanDay(OTHER_DAY, "Long", "Endurance", [
    { kind: "cardio", exercise: "Long run", target_distance_km: 16, target_zone: "Z2 (142–148 bpm)" },
  ]);

  const out = planUpdate([
    { kind: "cardio", day_number: DAY, exercise: "Easy run", target_distance_km: 8 },
    { kind: "cardio", day_number: OTHER_DAY, exercise: "Long run", target_distance_km: 20 },
  ]);
  const result = out.applied[0].result;
  assert.equal(result.persisted, false, "the posture holds it as a draft");
  const proposalId = result.proposal_id;

  // The athlete edits an untouched run on one of those days while the proposal waits.
  repo.setWeeklyRuns([
    { day_number: DAY, label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { day_number: DAY, label: "Strides", target_duration_min: 15, target_zone: "Z4 (157–164 bpm)" },
  ]);

  assert.equal(repo.applyProposal(proposalId).ok, true);

  const runs = planRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.note === "Easy run").target_distance_km, 8, "the waiting edit landed");
  assert.equal(
    runs.find((run) => run.note === "Strides").target_duration_min,
    15,
    "and the edit made while it waited was not reverted by a stale snapshot"
  );
  assert.equal(planRuns(OTHER_DAY)[0].target_distance_km, 20, "the other day's edit landed too");

  const payload = repo.getProposal(proposalId).parsed.cardio;
  assert.equal(payload.length, 2, "one marked entry per edit, not a copy of each day");
  assert.ok(payload.every((entry) => entry.cardio_edit === true));
});

test("several run edits to ONE day in a single plan_update all land on that day", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedRunDay([
    { label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { label: "Strides", target_duration_min: 10, target_zone: "Z4 (157–164 bpm)" },
  ]);

  const out = planUpdate([
    { kind: "cardio", day_number: DAY, exercise: "Easy run", target_distance_km: 8 },
    { kind: "cardio", day_number: DAY, exercise: "Strides", target_duration_min: 20 },
  ]);
  const proposalId = out.applied[0].result.proposal_id;
  assert.equal(repo.getProposal(proposalId).parsed.cardio.length, 2);

  assert.equal(repo.applyProposal(proposalId).ok, true);

  const runs = planRuns();
  assert.equal(runs.length, 2, "the day still carries both runs — the second fold did not drop the first");
  assert.equal(runs.find((run) => run.note === "Easy run").target_distance_km, 8);
  assert.equal(runs.find((run) => run.note === "Strides").target_duration_min, 20);
  assert.equal(
    runs.find((run) => run.note === "Strides").target_zone,
    "Z4 (157–164 bpm)",
    "and an unstated zone still carries forward through the re-read"
  );
  assert.equal(planLifts().length, 1, "lifting on that day is untouched");
});

// The day EXISTS, so it was read before the edit was refused as ambiguous. Its runs
// are therefore sitting in the wholesale list even though nothing was edited — which
// is why the refusal has to be decided on the EDITS, not on that list.
test("a plan_update whose every run edit was refused writes nothing and says why", () => {
  seedRunDay([
    { label: "Easy run", target_distance_km: 5, target_zone: "Z2 (142–148 bpm)" },
    { label: "Strides", target_duration_min: 10, target_zone: "Z4 (157–164 bpm)" },
  ]);
  // Two runs on the day and nothing saying which one — guessing is what the refusal
  // exists to prevent.
  const out = planUpdate([{ kind: "cardio", day_number: DAY, target_distance_km: 8 }]);

  const result = out.applied[0].result;
  assert.equal(result.ok, false, "a wholly refused turn must not write a no-op day over its own refusal");
  assert.equal(result.persisted, false);
  assert.match(result.error, /didn't say which one/);
  assert.equal(result.verification.ok, false);

  const runs = planRuns();
  assert.equal(runs.length, 2, "the day is left exactly as it was");
  assert.equal(runs.find((run) => run.note === "Easy run").target_distance_km, 5);
  assert.equal(runs.find((run) => run.note === "Strides").target_duration_min, 10);
});
