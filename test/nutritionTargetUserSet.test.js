// THE ATHLETE'S OWN NUMBER — POST /api/nutrition/target.
//
// Every other way a calorie target moves is Cairn's: the check-in's bounded step, a
// boundary apply, an undo restoring what was there. Until this route the athlete had
// no way to simply state what their target is, which meant the only lever they held
// over a drifting number was arguing with the coach about it.
//
// Drives the real router over loopback rather than calling the handler, so the express
// wiring, the body parsing and the status codes are all under test.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { nutritionRouter } from "../dist/routes/nutrition.js";
import { USER_TARGET_MAX_KCAL, USER_TARGET_MIN_KCAL } from "../dist/repo/nutrition.js";
import { localDateISO } from "../dist/repo/shared.js";
import { applyDueAnnouncedDecisions, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";

let server = null;
let base = "";

async function listener() {
  if (server) return base;
  const app = express();
  app.use(express.json());
  app.use("/api", nutritionRouter);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
  return base;
}

async function postTarget(body) {
  const url = await listener();
  const res = await fetch(`${url}/nutrition/target`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

after(() => server?.close());

beforeEach(() => {
  resetTables(
    "profile",
    "nutrition_targets",
    "brain_decisions",
    "brain_expectations",
    "plan_proposals",
    "attention_schedule",
    "journey_phases",
    "bodyweight_log",
    "app_state"
  );
});

test("a stated target is saved, effective today, stamped as the athlete's own", async () => {
  const { status, body } = await postTarget({ target_kcal: 2_250, protein_g: 180, note: "Back to where I was." });
  assert.equal(status, 200);
  assert.equal(body.target_kcal, 2_250);
  assert.equal(body.protein_g, 180);
  assert.equal(body.source, "user", "provenance the next check-in measures its step from");
  assert.equal(body.effective_date, localDateISO());
  assert.match(body.note, /Back to where I was\./);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2_250, "and it is the target in force");
});

test("optional macros are optional, and a bare kcal is enough", async () => {
  const { status, body } = await postTarget({ target_kcal: 2_400 });
  assert.equal(status, 200);
  assert.equal(body.target_kcal, 2_400);
  assert.equal(body.carbs_g, null);
  assert.equal(body.fat_g, null);
});

test("a number outside the sane band is refused with the reason, never clamped in silence", async () => {
  for (const kcal of [USER_TARGET_MIN_KCAL - 1, USER_TARGET_MAX_KCAL + 1, "lots", null]) {
    const { status, body } = await postTarget({ target_kcal: kcal });
    assert.equal(status, 400, `${kcal} is refused`);
    assert.match(body.error, /target_kcal/);
  }
  assert.equal(repo.getActiveNutritionTarget(), null, "and nothing was written");
});

test("the write goes through the same repo seam, so the ledger row still gets recorded", async () => {
  await postTarget({ target_kcal: 2_300 });
  const decisions = repo.listBrainDecisions({ kind: "nutrition_target", limit: 10 });
  assert.ok(decisions.length >= 1, "setNutritionTarget's own decision row is not bypassed");
});

// ---- the athlete outranks the machine ----------------------------------------
//
// A nutrition target waits for a natural food-day boundary rather than landing when it
// is decided, and that wait was a door the machine could come back through. State your
// own number today with a protective raise still queued, and tomorrow the boundary
// re-judges that raise against YOUR number and applies it — worse, it re-clamps it to
// measured maintenance first, so what overrules you arrives looking considered.
//
// An explicit user set now supersedes every queued automated change to the same metric.

async function queuedRaise(kcal) {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 168,
    start_weight_lb: 183,
    start_date: localDaysAgo(60),
    goal_mode: "lose",
    goal_weight_lb: 164,
  });
  const proposal = repo.createProposal("stub", "a protective step", "", {
    kind: "nutrition_target",
    summary: `A protective step to ${kcal} kcal`,
    nutrition: { target_kcal: kcal, protein_g: 175, reason: "Recent endurance load reads as under-fuelled." },
  });
  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.ok(["pending", "announced"].includes(scheduled.decision.status), "the change is genuinely waiting");
  return { proposal, scheduled };
}

test("stating your own target supersedes a change still waiting at the boundary", async () => {
  const { proposal, scheduled } = await queuedRaise(2_800);

  // Comfortably clear of the lean-safe floor, which still runs and may raise what lands
  // — that is a separate law, and letting it bind here would only blur this one.
  const { status, body } = await postTarget({ target_kcal: 2_400, note: "Dialling it back myself." });
  assert.equal(status, 200);
  assert.equal(body.target_kcal, 2_400);
  assert.equal(body.source, "user");

  const waiting = repo.getBrainDecision(scheduled.decision.id);
  assert.ok(
    !["pending", "announced"].includes(waiting.status),
    `the queued change no longer waits, got ${waiting.status}`
  );
  assert.equal(repo.getProposal(proposal.id).status, "superseded", "and the draft behind it is retired");

  const receipt = repo
    .listBrainDecisions({ kind: "nutrition_target", limit: 20 })
    .find((decision) => decision.context?.user_target_supersede_receipt === true);
  assert.ok(receipt, "a receipt says what was set aside and why");
  assert.equal(receipt.status, "superseded");
  assert.equal(receipt.context.superseded_pending_decision_id, scheduled.decision.id);
  assert.match(receipt.summary, /you set your own target/i);

  // The point of all of it: the next morning's boundary pass has nothing to land.
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [], "nothing is applied over the athlete's own number");
  assert.deepEqual(due.set_aside, [], "and there is nothing left to even set aside");
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2_400, "their number still stands");
});

test("a raise queued BELOW the athlete's number is superseded just the same", async () => {
  // The supersede is about who is speaking, not about which number is larger — a queued
  // change is retired whether it would have raised or lowered what the athlete chose.
  const { proposal, scheduled } = await queuedRaise(2_800);
  await postTarget({ target_kcal: 3_000 });
  assert.equal(repo.getProposal(proposal.id).status, "superseded");
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, []);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 3_000);
});

test("with nothing queued, setting a target is exactly the plain write it always was", async () => {
  const { status, body } = await postTarget({ target_kcal: 2_200, protein_g: 170 });
  assert.equal(status, 200);
  assert.equal(body.target_kcal, 2_200);
  assert.equal(body.protein_g, 170);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2_200);
  const receipts = repo
    .listBrainDecisions({ kind: "nutrition_target", limit: 20 })
    .filter((decision) => decision.context?.user_target_supersede_receipt === true);
  assert.equal(receipts.length, 0, "no supersede receipt is written when there was nothing to supersede");
});
