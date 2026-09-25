import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutonomyTier } from "../dist/brain/autonomy.js";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  newRequestTellBudget,
  thawParkedReviewDecisions,
} from "../dist/domain/brain/autonomy-service.js";
import { db } from "../dist/db.js";
import * as repo from "../dist/repo.js";

// THE ATHLETE'S OWN REQUEST IS THEIR DECISION (2026-09-25 ruling). Live: a chat "rebuild
// today's session" (brain_decisions 27177) went out as an announcement on a demoted
// domain, went stale at its boundary, and was set aside at the 04:00 sweep — and nobody
// told the athlete. A request applies (floors and the plan-quality check still hold), and
// when it cannot land the athlete hears why, in chat, once.

function seedDay(items) {
  repo.savePlanDay(1, "Push", "chest", items);
}

function chatDraft(summary, changes) {
  return repo.createProposal("chat", "chat: plan edit", "", { summary, changes });
}

test("a veto-rate demotion never turns the athlete's own request into a heads-up", () => {
  const base = {
    kind: "exercise_rotation",
    risk_class: "low",
    reversible: true,
    lead_mode: "lead",
    domain_demoted: true,
  };
  assert.equal(decideAutonomyTier(base).tier, "announce", "the coach's own initiative is still reined in");
  assert.equal(decideAutonomyTier({ ...base, explicit_user_request: true }).tier, "quiet_apply");
  // The floors do not move for a request.
  assert.equal(decideAutonomyTier({ ...base, explicit_user_request: true, clinical: true }).tier, "clinician");
  assert.equal(decideAutonomyTier({ ...base, explicit_user_request: true, user_locked: true }).tier, "ask");
});

test("an announced request whose picture drifted still lands at its boundary", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedDay([{ exercise: "ZReq Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }]);
  const proposal = chatDraft("Press up to 105 on day 1", [
    { day_number: 1, exercise: "ZReq Press", target_weight: 105 },
  ]);
  const scheduled = applyProposalWithAutonomy(Number(proposal.id), {
    requested_tier: "announce",
    explicit_user_request: true,
  });
  assert.equal(scheduled.decision.status, "announced");
  // The plan moves after they asked (another day is edited): the compare-and-set snapshot drifts.
  repo.savePlanDay(2, "Pull", "back", [{ exercise: "ZReq Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 90 }]);

  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [scheduled.decision.id], "their word is the decision; drift does not retire it");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 105);
  const landed = repo.getBrainDecision(scheduled.decision.id);
  assert.equal(landed.status, "applied");
  assert.ok(Array.isArray(landed.context.boundary_drift_tolerated), "the drift is on the record, not a reason to park");
  assert.equal(repo.awaitingBrainDecisions().length, 0);
});

test("a request the plan refuses at its boundary is answered in chat, never parked or silently set aside", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedDay([{ exercise: "ZReq Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }]);
  const proposal = chatDraft("Swap ZReq Press for ZReq Dumbbell Press", [
    { day_number: 1, swap: { from: "ZReq Press", to: "ZReq Dumbbell Press" } },
  ]);
  const scheduled = applyProposalWithAutonomy(Number(proposal.id), {
    requested_tier: "announce",
    explicit_user_request: true,
  });
  assert.equal(scheduled.decision.status, "announced");
  // The movement the swap takes out leaves the plan before the boundary.
  seedDay([{ exercise: "ZReq Fly", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30 }]);
  const before = repo.listChatMessages(50).length;

  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, []);
  const ended = repo.getBrainDecision(scheduled.decision.id);
  assert.notEqual(ended.status, "review", "a refusal the athlete cannot act on never waits on them");
  assert.equal(ended.status, "rejected");
  assert.equal(repo.getProposal(Number(proposal.id)).status, "superseded", "no sweep re-offers the same refusal");
  const messages = repo.listChatMessages(50);
  assert.equal(messages.length, before + 1, "the athlete is told, once");
  const told = messages[messages.length - 1];
  assert.equal(told.role, "assistant");
  assert.match(told.content, /didn't land/);
  assert.match(told.content, /Swap ZReq Press for ZReq Dumbbell Press/);
  assert.ok(ended.context.athlete_told_at, "stamped so a later sweep stays quiet");
  assert.equal(repo.awaitingBrainDecisions().length, 0);

  // Idempotent: another pass over the same day says nothing more.
  applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.equal(repo.listChatMessages(50).length, before + 1);
});

// Only the PLAN's refusal retires a request and tells the athlete. A locked database says
// nothing about what they asked for: node:sqlite raises a plain Error carrying only
// `code: 'ERR_SQLITE_ERROR'`, so a message-shaped test cannot tell the two apart.
test("a transient database error at the boundary parks the request — never retired, never 'the plan refused it'", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedDay([{ exercise: "ZReq Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }]);
  const proposal = chatDraft("Press up to 105 on day 1", [
    { day_number: 1, exercise: "ZReq Press", target_weight: 105 },
  ]);
  const scheduled = applyProposalWithAutonomy(Number(proposal.id), {
    requested_tier: "announce",
    explicit_user_request: true,
  });
  assert.equal(scheduled.decision.status, "announced");
  const before = repo.listChatMessages(50).length;

  db.exec(
    `CREATE TRIGGER zreq_locked BEFORE UPDATE ON plan_items BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`
  );
  try {
    const due = applyDueAnnouncedDecisions(scheduled.effective_date);
    assert.deepEqual(due.applied, []);
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS zreq_locked`);
  }
  const parked = repo.getBrainDecision(scheduled.decision.id);
  assert.equal(parked.status, "review", "parked for a retry, exactly as before");
  assert.equal(parked.context.boundary_outcome, "apply_threw");
  assert.notEqual(parked.context.athlete_request_refused, true);
  assert.equal(repo.getProposal(Number(proposal.id)).status, "draft", "the request itself is still live");
  assert.equal(repo.listChatMessages(50).length, before, "nobody is told a lock was the plan's answer");
});

// ---- the thaw answers what is still current, never in a burst ----

const sqlAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

// A chat request the older pass left parked at review, `days` old.
function parkedRequest(summary, days, targetWeight) {
  const proposal = chatDraft(summary, [{ day_number: 1, exercise: "ZReq Press", target_weight: targetWeight }]);
  const held = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "ask" });
  assert.equal(held.decision.status, "review");
  repo.patchBrainDecision(Number(held.decision.id), {
    context: { ...held.decision.context, explicit_user_request: true, thaw_attempted: true, thaw_pass: 1 },
  });
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(sqlAgo(days), proposal.id);
  return { proposalId: Number(proposal.id), decisionId: Number(held.decision.id) };
}

test("the first thaw after a deploy tells at most two recent requests and closes weeks-old ones silently", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedDay([{ exercise: "ZReq Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }]);
  // Three that just crossed their 7-day ceiling, and one from over a month ago.
  const recent = [
    parkedRequest("Press to 101 on day 1", 8, 101),
    parkedRequest("Press to 102 on day 1", 8, 102),
    parkedRequest("Press to 103 on day 1", 8, 103),
  ];
  const old = parkedRequest("Press to 104 on day 1", 40, 104);
  const before = repo.listChatMessages(50).length;

  const thaw = thawParkedReviewDecisions("lead");
  assert.equal(thaw.superseded, 4, "every aged request is closed with its receipt");
  for (const { proposalId } of [...recent, old]) assert.equal(repo.getProposal(proposalId).status, "superseded");

  const told = repo.listChatMessages(50).slice(before);
  assert.equal(told.length, 2, "no burst: at most two tells a sweep");
  assert.ok(told.every((m) => /didn't land/.test(m.content)));
  assert.ok(!told.some((m) => /Press to 104/.test(m.content)), "a month-old request is not news");

  const contexts = [...recent, old].map(({ decisionId }) => repo.getBrainDecision(decisionId).context);
  assert.equal(contexts.filter((c) => c.athlete_told_at).length, 2);
  assert.equal(contexts.filter((c) => c.athlete_not_told === "sweep_cap").length, 1);
  assert.equal(repo.getBrainDecision(old.decisionId).context.athlete_not_told, "request_not_current");

  // Strictly once per decision: another sweep says nothing more.
  thawParkedReviewDecisions("lead");
  assert.equal(repo.listChatMessages(50).length, before + 2);
});

// An announced request of the athlete's, `days` old by the time its boundary comes.
function announcedRequest(summary, days, targetWeight) {
  const proposal = chatDraft(summary, [{ day_number: 1, exercise: "ZReq Press", target_weight: targetWeight }]);
  const scheduled = applyProposalWithAutonomy(Number(proposal.id), {
    requested_tier: "announce",
    explicit_user_request: true,
  });
  assert.equal(scheduled.decision.status, "announced");
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(sqlAgo(days), proposal.id);
  return { proposalId: Number(proposal.id), decisionId: Number(scheduled.decision.id), due: scheduled.effective_date };
}

test("the first boundary after a deploy tells at most two aged requests and closes older ones silently", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedDay([{ exercise: "ZReq Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }]);
  // Three that just crossed their 7-day ceiling, and two from over a month ago.
  const recent = [
    announcedRequest("Press to 101 on day 1", 8, 101),
    announcedRequest("Press to 102 on day 1", 8, 102),
    announcedRequest("Press to 103 on day 1", 8, 103),
  ];
  const old = [announcedRequest("Press to 104 on day 1", 40, 104), announcedRequest("Press to 99 on day 1", 45, 99)];
  const before = repo.listChatMessages(50).length;

  const due = applyDueAnnouncedDecisions(recent[0].due);
  assert.deepEqual(due.applied, [], "every one of them waited past its ceiling");
  for (const { proposalId, decisionId } of [...recent, ...old]) {
    assert.equal(repo.getProposal(proposalId).status, "superseded", "each is closed with its receipt");
    assert.equal(repo.getBrainDecision(decisionId).context.boundary_outcome, "stale_proposal");
  }
  const told = repo.listChatMessages(50).slice(before);
  assert.equal(told.length, 2, "no burst: at most two tells a sweep");
  assert.ok(told.every((m) => /didn't land/.test(m.content)));
  assert.ok(!told.some((m) => /Press to (104|99)/.test(m.content)), "a month-old request is not news");

  const contexts = [...recent, ...old].map(({ decisionId }) => repo.getBrainDecision(decisionId).context);
  assert.equal(contexts.filter((c) => c.athlete_told_at).length, 2);
  assert.equal(contexts.filter((c) => c.athlete_not_told === "sweep_cap").length, 1);
  for (const { decisionId } of old)
    assert.equal(repo.getBrainDecision(decisionId).context.athlete_not_told, "request_not_current");

  // Strictly once per decision: another pass says nothing more.
  applyDueAnnouncedDecisions(recent[0].due);
  assert.equal(repo.listChatMessages(50).length, before + 2);
});

test("the thaw and the boundary pass share one tell budget per tick", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedDay([{ exercise: "ZReq Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }]);
  parkedRequest("Press to 101 on day 1", 8, 101);
  parkedRequest("Press to 102 on day 1", 8, 102);
  const aged = announcedRequest("Press to 103 on day 1", 8, 103);
  const before = repo.listChatMessages(50).length;

  const tells = newRequestTellBudget();
  thawParkedReviewDecisions("lead", { tells });
  applyDueAnnouncedDecisions(aged.due, { tells });
  assert.equal(repo.listChatMessages(50).length, before + 2, "two for the whole tick, not two per pass");
  assert.equal(repo.getBrainDecision(aged.decisionId).context.athlete_not_told, "sweep_cap");
});
