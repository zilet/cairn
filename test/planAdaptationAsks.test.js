// An asked return never re-asks (src/repo/plan-adaptation-asks.ts). A race adaptation
// made around pain asks for its return; left unanswered it comes back ONCE on the Brief
// (a pull item, never a notification), then settles to the safe default — the adaptation
// stays — recorded on the rows with the reason. An answer settles the rows at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adoptOrphanedDrafts,
  expirePlanAdaptations,
  thawParkedReviewDecisions,
} from "../dist/domain/brain/autonomy-service.js";
import {
  ASK_RESURFACE_AFTER_DAYS,
  ASK_SETTLE_AFTER_DAYS,
  askedAdaptationGroups,
  settleAskedAdaptations,
} from "../dist/repo/plan-adaptation-asks.js";
import { awaitingBrainDecisions } from "../dist/repo/brain-decisions.js";
import { answerBriefAsk, briefAsks } from "../dist/domain/today/brief-asks.js";
import { db, localDaysAgo, repo, savePlanDaySettled } from "./_seed.js";
import { runWithTimeZone } from "../dist/tz.js";

const UNTIL = localDaysAgo(-3);
const DAY_AFTER = localDaysAgo(-4);
const TODAY = localDaysAgo(0);
const MORNING = new Date(`${TODAY}T09:00:00`);
const day = (n) => localDaysAgo(-n);

const LOWER = [
  { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 155 },
  { exercise: "Lying Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 70 },
];

function lowerNames() {
  return (repo.getPlanDay(2)?.items ?? []).map((item) => item.exercise);
}

/** The pain-tied race adaptation, past its end, asked for its return (asked today). */
function askedReturn() {
  repo.setSettings({ lead_mode: "lead" });
  savePlanDaySettled(1, "Push A", "Chest and shoulders", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  savePlanDaySettled(2, "Lower", "The week's one leg day", LOWER);
  const proposal = repo.createProposal("stub", "background: chat signal", "", {
    summary: "Rest the squat for the race",
    rationale: "Knee pain on deep squats.",
    changes: [
      {
        day_number: 2,
        exercise: "Back Squat",
        remove: true,
        until: UNTIL,
        reason: "Knee pain on deep squats; resting it for the race",
      },
    ],
  });
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.asked.length, 1);
  assert.ok(outcome.ask, "the return is asked");
  return { proposalId: Number(outcome.ask.source_ref_key), decisionId: Number(outcome.ask.id) };
}

function rowStatus() {
  return db.prepare(`SELECT status, resolution_note FROM plan_adaptations`).get();
}

test("an unanswered ask comes back once on the Brief, then settles to keeping the adaptation", () => {
  const { proposalId } = askedReturn();
  assert.equal(askedAdaptationGroups().length, 1);
  assert.equal(askedAdaptationGroups()[0].proposal_id, proposalId);

  // Before its window: quiet. Nothing on the Brief, nothing settled.
  assert.deepEqual(settleAskedAdaptations(day(1)), { restored: [], kept: [], settled: [], resurfaced: [] });
  assert.equal(briefAsks({ date: day(1), now: MORNING }).asks.length, 0);

  // At its resurface day it is stamped for that one day's Brief…
  const resurface = day(ASK_RESURFACE_AFTER_DAYS);
  assert.deepEqual(settleAskedAdaptations(resurface).resurfaced, [proposalId]);
  const onBrief = briefAsks({ date: resurface, now: MORNING }).asks;
  assert.equal(onBrief.length, 1);
  assert.equal(onBrief[0].kind, "adaptation_return");
  assert.equal(onBrief[0].key, `adaptation_return:${proposalId}`);
  assert.match(onBrief[0].question, /bring Back Squat back to the regular plan\?/);
  assert.deepEqual(
    onBrief[0].answers.map((a) => a.key),
    ["bring_back", "keep"]
  );
  assert.doesNotMatch(onBrief[0].question + onBrief[0].detail, /remov|dropp|you must/i);

  // …and only that day: the next day's pass does not stamp it again, the Brief is quiet.
  assert.deepEqual(settleAskedAdaptations(day(ASK_RESURFACE_AFTER_DAYS + 1)).resurfaced, []);
  assert.equal(
    briefAsks({ date: day(ASK_RESURFACE_AFTER_DAYS + 1), now: MORNING }).asks.length,
    0,
    "back once, never again"
  );
  assert.equal(rowStatus().status, "asked");

  // Past its window it settles: the adaptation stays, the draft and its hold are set aside.
  const settled = settleAskedAdaptations(day(ASK_SETTLE_AFTER_DAYS));
  assert.equal(settled.settled.length, 1);
  const row = rowStatus();
  assert.equal(row.status, "kept");
  assert.match(row.resolution_note, /stays as it is/);
  assert.match(row.resolution_note, /whenever you ask/);
  assert.equal(lowerNames().includes("Back Squat"), false, "the safe default keeps the change made around pain");
  assert.equal(repo.getProposal(proposalId).status, "superseded");
  assert.equal(
    awaitingBrainDecisions().some((d) => String(d.summary ?? "").includes("Back Squat")),
    false,
    "nothing waits on the athlete any more"
  );
  // Idempotent: a later pass finds nothing, and nothing is ever asked again.
  assert.deepEqual(settleAskedAdaptations(day(ASK_SETTLE_AFTER_DAYS + 1)), {
    restored: [],
    kept: [],
    settled: [],
    resurfaced: [],
  });
  assert.equal(expirePlanAdaptations(day(ASK_SETTLE_AFTER_DAYS + 1)).ask ?? null, null);
});

test("'keep it' on the Brief discards the return and records the athlete's own answer", () => {
  const { proposalId } = askedReturn();
  settleAskedAdaptations(day(ASK_RESURFACE_AFTER_DAYS));
  const result = answerBriefAsk({
    key: `adaptation_return:${proposalId}`,
    answer: "keep",
    date: day(ASK_RESURFACE_AFTER_DAYS),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(repo.getProposal(proposalId).status, "discarded");
  const row = rowStatus();
  assert.equal(row.status, "kept");
  assert.match(row.resolution_note, /You chose to keep it/);
  assert.equal(lowerNames().includes("Back Squat"), false);
  assert.equal(answerBriefAsk({ key: `adaptation_return:${proposalId}`, answer: "keep" }).ok, false, "answered once");
});

test("'bring it back' applies the held return and the rows say the yes landed it", () => {
  const { proposalId } = askedReturn();
  const result = answerBriefAsk({ key: `adaptation_return:${proposalId}`, answer: "bring_back", date: TODAY });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(lowerNames().includes("Back Squat"), true, "the squat is back on the day");
  assert.equal(rowStatus().status, "restored");
  assert.equal(askedAdaptationGroups().length, 0);
});

test("an ask answered elsewhere (the draft applied by hand) settles its rows on the next pass", () => {
  const { proposalId } = askedReturn();
  assert.equal(repo.applyProposal(proposalId).ok, true);
  const outcome = settleAskedAdaptations(day(1));
  assert.equal(outcome.restored.length, 1);
  assert.equal(rowStatus().status, "restored");
});

test("the thaw never re-offers or applies an asked return: its hold is a floor the settle pass owns", () => {
  const { proposalId, decisionId } = askedReturn();
  const hold = () => db.prepare(`SELECT status, context_json FROM brain_decisions WHERE id = ?`).get(decisionId);
  assert.equal(JSON.parse(hold().context_json).review_reason_code, "adaptation_return_ask");
  // Lead mode, where a plain requested_review hold is re-read by policy: this one is not.
  for (const mode of ["lead", "announce_first"]) {
    repo.setSettings({ lead_mode: mode });
    thawParkedReviewDecisions(mode);
    adoptOrphanedDrafts();
  }
  assert.equal(hold().status, "review", "the ask still waits on the athlete");
  assert.equal(repo.getProposal(proposalId).status, "draft", "never adopted or re-filed");
  assert.equal(lowerNames().includes("Back Squat"), false, "the return made around pain never lands by itself");
  assert.equal(rowStatus().status, "asked");
  // The Brief still owns it: it comes back on its day, and the athlete's yes lands it.
  settleAskedAdaptations(day(ASK_RESURFACE_AFTER_DAYS));
  assert.equal(briefAsks({ date: day(ASK_RESURFACE_AFTER_DAYS), now: MORNING }).asks.length, 1);
});

// ---------- review fixes (wave 2) ----------

test("'bring it back' that the plan refuses says so: no false 'back to the regular plan', the ask stays", () => {
  const { proposalId } = askedReturn();
  repo.deletePlanDay(2); // the day the return lands on is gone: the apply refuses
  const result = answerBriefAsk({ key: `adaptation_return:${proposalId}`, answer: "bring_back", date: TODAY });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.error && !/Back to the regular plan/.test(result.error));
  assert.equal("message" in result, false);
  assert.notEqual(repo.getProposal(proposalId).status, "applied");
});

test("an adaptation_return key answers only an asked return — never any other draft by its id", () => {
  askedReturn();
  const other = repo.createProposal("stub", "an unrelated draft", "", {
    summary: "Raise the bench",
    rationale: "Top of the range.",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }],
  });
  const result = answerBriefAsk({ key: `adaptation_return:${other.id}`, answer: "bring_back", date: TODAY });
  assert.equal(result.ok, false);
  assert.equal(repo.getProposal(Number(other.id)).status, "draft", "untouched");
  assert.equal(
    repo.getPlanDay(1).items.find((i) => i.exercise === "Barbell Bench Press").target_weight,
    135,
    "nothing applied"
  );
  assert.equal(answerBriefAsk({ key: `adaptation_return:${other.id}`, answer: "keep" }).ok, false);
  assert.equal(repo.getProposal(Number(other.id)).status, "draft");
});

test("the day an ask went up is the athlete's local day, not the UTC stamp's", () => {
  askedReturn();
  // 02:00 UTC on the 21st is still the evening of the 20th in Los Angeles.
  db.prepare(`UPDATE plan_adaptations SET resolved_at = '2026-10-21 02:00:00' WHERE status = 'asked'`).run();
  const [group] = runWithTimeZone("America/Los_Angeles", () => askedAdaptationGroups());
  assert.equal(group.asked_on, "2026-10-20");
});
