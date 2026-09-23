// Chat can NOT prescribe a single run, and it says so instead of writing anything.
//
// Runs are no longer plan items (migration 110): every run — easy, quality, long —
// comes from the athlete's stated run days and is sized by the run engine each week
// (weeklyRunPlan / the rolling agenda). Nothing stores one run's dose for chat to edit,
// so a `set_run` action, or a plan_update change that is really a run, is REFUSED in a
// rotating phrasing (RUN_EDIT_REFUSAL_VARIANTS) that points at the thing the athlete
// CAN change — which days they run. The holes this file used to guard stay closed:
//   1. An un-kinded run in plan_update ("Easy run", 8 km) never becomes a fabricated
//      3×8–12 LIFTING movement that then reads back as verified.
//   2. No receipt claims a run write that did not happen — the model's prose that says
//      "I've updated your run" is replaced by the server's honest account.
// And a mixed turn still lands its strength half.
//
// The agent never runs here — actions are hand-built and applied through the same
// applyChatActions the worker calls, exactly like test/chatTurns.test.js.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import * as chatTurns from "../dist/chatTurns.js";
import {
  applyChatActions,
  CARDIO_REMOVAL_REFUSAL_VARIANTS,
  hasExplicitRunEditIntent,
  planRunEdits,
  reconcileChatPlanReply,
  reconcileChatRunReply,
  RUN_EDIT_REFUSAL_VARIANTS,
} from "../dist/chatTurns.js";
import { localDateISO } from "../dist/repo/shared.js";

const ASK = "Make tomorrow's run 8k easy.";

// A Monday-anchored slot in THIS week; the plan day the fixtures live on.
function weekSlotFor(dateISO) {
  const day = new Date(`${dateISO}T00:00:00Z`).getUTCDay();
  return ((day + 6) % 7) + 1;
}
const DAY = weekSlotFor(localDateISO());
const OTHER_DAY = DAY === 3 ? 4 : 3;

beforeEach(() => {
  resetTables(
    "chat_turns",
    "chat_messages",
    "plan_proposals",
    "brain_decisions",
    "plan_items",
    "plan_days",
    "exercises"
  );
  repo.setSettings({ lead_mode: "lead" });
});

function seedLiftDay(dayNumber = DAY) {
  repo.savePlanDay(dayNumber, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
}

function planItems(dayNumber = DAY) {
  return repo.getPlanDay(dayNumber)?.items || [];
}

const proposalCount = () => db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n;
const cardioItemCount = () => db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE kind = 'cardio'`).get().n;
const isRunEditRefusal = (text) => RUN_EDIT_REFUSAL_VARIANTS.includes(String(text));

function setRun(action, message = ASK) {
  return applyChatActions({ actions: [{ type: "set_run", ...action }] }, { agent: "stub", message });
}

function planUpdate(changes, message = "Adjust this week's runs.") {
  return applyChatActions(
    { actions: [{ type: "plan_update", summary: "run adjustments", changes }] },
    { agent: "stub", message }
  );
}

// ── the refusal itself ───────────────────────────────────────────────────────

test("every run-edit refusal phrasing points at the athlete's run days", () => {
  assert.ok(RUN_EDIT_REFUSAL_VARIANTS.length >= 2, "the refusal rotates like every repeating sentence");
  for (const variant of RUN_EDIT_REFUSAL_VARIANTS) {
    assert.match(variant, /run days|days you run/, variant);
    assert.doesNotMatch(variant, /Plan screen/, "the Plan screen no longer owns runs");
  }
});

test("the run readback and zone tagging went with the run writer", () => {
  assert.equal(chatTurns.verifyRunReadback, undefined);
  assert.equal(chatTurns.runZoneTag, undefined);
});

test("planRunEdits refuses every edit and plans no write", () => {
  const plan = planRunEdits([
    { day_number: DAY, distance_km: 8 },
    { day_number: OTHER_DAY, duration_min: 40 },
  ]);
  assert.deepEqual(plan.cardio, []);
  assert.deepEqual(plan.cardio_edits, []);
  assert.deepEqual(plan.expected, []);
  assert.equal(plan.errors.length, 2, "one refusal per requested edit");
  assert.ok(plan.errors.every(isRunEditRefusal));
});

// ── set_run ──────────────────────────────────────────────────────────────────

test("set_run is refused in words and writes nothing — no proposal, no plan row", () => {
  seedLiftDay();
  const out = setRun({ day_number: DAY, kind: "easy", distance_km: 8, reason: "athlete asked for a longer easy run" });

  assert.equal(out.applied[0].type, "set_run");
  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.persisted, false);
  assert.ok(isRunEditRefusal(result.error), `a RUN_EDIT_REFUSAL_VARIANTS phrasing (got: ${result.error})`);
  assert.deepEqual(result.verification.mismatches, ["not_applied"]);

  assert.equal(proposalCount(), 0, "no proposal is minted for a run");
  assert.equal(cardioItemCount(), 0, "no cardio row is written");
  assert.deepEqual(
    planItems().map((item) => item.exercise),
    ["Back Squat"],
    "lifting on that day is untouched"
  );
});

test("an invented day number is refused the same way and the plan gains no day", () => {
  seedLiftDay();
  const before = repo.getPlan().length;
  const out = setRun({ day_number: 9, distance_km: 8 });
  assert.equal(out.applied[0].result.ok, false);
  assert.ok(isRunEditRefusal(out.applied[0].result.error));
  assert.equal(repo.getPlan().length, before, "the plan gained no day");
});

test("a second set_run in one turn is refused too, and nothing is written", () => {
  seedLiftDay();
  const out = applyChatActions(
    {
      actions: [
        { type: "set_run", day_number: DAY, distance_km: 8 },
        { type: "set_run", day_number: OTHER_DAY, distance_km: 18 },
      ],
    },
    { agent: "stub", message: "Rebuild my running week: make tomorrow 8k and the long run 18k." }
  );
  assert.equal(out.applied.length, 2);
  assert.ok(out.applied.every((entry) => entry.result.ok === false && entry.result.persisted === false));
  assert.equal(proposalCount(), 0);
  assert.equal(cardioItemCount(), 0);
});

test("a review-everything posture changes nothing: the refusal is not a held draft", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedLiftDay();
  const result = setRun({ day_number: DAY, distance_km: 8 }).applied[0].result;
  assert.equal(result.ok, false);
  assert.notEqual(result.review_required, true, "there is nothing to review");
  assert.equal(proposalCount(), 0);
});

test("a food-only turn cannot touch running", () => {
  seedLiftDay();
  const out = setRun({ day_number: DAY, distance_km: 8 }, "Had a chicken burrito bowl for lunch, maybe 700 calories.");
  assert.equal(out.applied.length, 0);
});

// ── the receipt is the truth ─────────────────────────────────────────────────

test("a refused set_run replaces model prose that claimed success", () => {
  seedLiftDay();
  const out = setRun({ day_number: DAY, kind: "easy", distance_km: 8 });
  const reply = reconcileChatRunReply("I've updated tomorrow's run to 8k easy.", ASK, out.applied);
  assert.doesNotMatch(reply, /I've updated/);
  assert.doesNotMatch(reply, /Saved and verified/);
  assert.match(reply, /this week's runs are unchanged/i);
  assert.ok(reply.includes(out.applied[0].result.error), "and it carries the refusal's own words");
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

// ── plan_update: an endurance-shaped change is a run, and is refused ─────────

test("an un-kinded run in plan_update never becomes a fake lifting movement", () => {
  seedLiftDay();
  const out = planUpdate(
    [{ day_number: DAY, exercise: "Easy run", target_distance_km: 8, reason: "athlete asked" }],
    ASK
  );
  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.equal(result.persisted, false);
  assert.notEqual(result.verified, true);
  assert.ok(isRunEditRefusal(result.error), `refused as a run (got: ${result.error})`);
  assert.deepEqual(
    planItems().map((item) => item.exercise),
    ["Back Squat"],
    "no 3×8–12 exercise called 'Easy run' was invented"
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM exercises WHERE name = 'Easy run'`).get().n,
    0,
    "and no such exercise entered the canon"
  );
  assert.equal(proposalCount(), 0, "a run-only turn ends at the refusal, before any proposal exists");
});

test("a kind:'cardio' plan_update is refused and the plan reconciler does not claim it", () => {
  seedLiftDay();
  const out = planUpdate([{ day_number: DAY, kind: "cardio", label: "Easy run", target_distance_km: 8 }], ASK);
  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.ok(isRunEditRefusal(result.error));
  assert.equal(cardioItemCount(), 0);
  const reply = reconcileChatPlanReply("Taking that run to 8k.", ASK, out.applied, out.drafts);
  assert.doesNotMatch(reply, /Saved and verified/);
});

test("a mixed plan_update lands its strength half and reports the run refused", () => {
  seedLiftDay();
  const out = planUpdate(
    [
      { day_number: DAY, exercise: "Back Squat", target_weight: 175 },
      { day_number: DAY, kind: "cardio", label: "Easy run", target_distance_km: 8 },
    ],
    "Make today's squat 175 and the run 8k."
  );
  const result = out.applied[0].result;
  assert.equal(result.persisted, true, "the strength half was written");
  assert.equal(result.verified, false, "the turn did not do everything it was asked");
  assert.equal(result.verification.checks.length, 1, "the lifting change is checked as lifting");
  assert.deepEqual(result.verification.runs, [], "no run readback — nothing was written for the run");
  assert.equal(result.verification.errors.length, 1);
  assert.ok(isRunEditRefusal(result.verification.errors[0]));
  assert.equal(planItems().find((item) => item.exercise === "Back Squat").target_weight, 175);
  assert.equal(cardioItemCount(), 0);
});

test("the run reconciler stays quiet about a plan change that isn't a run", () => {
  seedLiftDay();
  const out = planUpdate([{ day_number: DAY, exercise: "Back Squat", target_weight: 175 }], "Drop today's squat to 175.");
  const reply = reconcileChatRunReply("Dropping the squat.", "Drop today's squat to 175.", out.applied);
  assert.equal(reply, "Dropping the squat.");
});

// ── removing a run ───────────────────────────────────────────────────────────

test("a cardio removal is refused in words that point at the run days", () => {
  for (const variant of CARDIO_REMOVAL_REFUSAL_VARIANTS) assert.match(variant(""), /run days|days you run/);
  seedLiftDay();
  const out = planUpdate([{ day_number: DAY, kind: "cardio", label: "Easy run", remove: true }], "Remove today's run.");

  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.error, /run days|days you run/);
  assert.doesNotMatch(result.error, /Plan screen/);
  assert.deepEqual(
    planItems().map((item) => item.exercise),
    ["Back Squat"],
    "the lifting day is untouched"
  );
  const reply = reconcileChatPlanReply("I've removed that run.", "Remove today's run.", out.applied, out.drafts);
  assert.doesNotMatch(reply, /I've removed/);
  assert.match(reply, /run days|days you run/);
});

test("a removal alongside a real change never rides in as a run edit", () => {
  seedLiftDay();
  const out = planUpdate(
    [
      { day_number: DAY, exercise: "Back Squat", target_weight: 175 },
      { day_number: DAY, kind: "cardio", label: "Easy run", remove: true },
    ],
    "Drop today's squat to 175 and remove the run."
  );

  const result = out.applied[0].result;
  assert.equal(result.verified, false, "the turn did not do everything it was asked");
  assert.equal(result.verification.errors.length, 1);
  assert.match(result.verification.errors[0], /run days|days you run/);
  assert.equal(planItems().find((item) => item.exercise === "Back Squat").target_weight, 175);
  assert.equal(cardioItemCount(), 0);
});
