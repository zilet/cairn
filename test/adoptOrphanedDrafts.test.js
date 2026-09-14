import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  adoptOrphanedDrafts,
  applyDueAnnouncedDecisions,
  applyMealPlanWithAutonomy,
  applyProposalWithAutonomy,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";
import { localDateISO } from "../dist/repo/shared.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The autonomy pass adopts orphaned drafts: a bounded, reversible change parked as a
// bare `draft` with no autonomy decision behind it (demoted by a since-fixed policy, or
// proposed in a since-elapsed budget week) is re-offered to the autonomy layer so the
// system adapts without the athlete. Deterministic, no agent, cheap enough to run every
// scheduler tick.

// createProposal stamps created_at = datetime('now'); rewrite it to a controlled instant
// so the 2-hour grace window is exercised deterministically regardless of the host tz
// (ISO-with-Z is parsed as UTC, matching Date.now()).
function backdateHours(id, hoursAgo) {
  const iso = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(iso, Number(id));
}

function backdateMinutes(id, minutesAgo) {
  const iso = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(iso, Number(id));
}

function nutritionDraft(instruction, kcal = 2200) {
  return repo.createProposal("stub", `auto: ${instruction}`, "", {
    kind: "nutrition_target",
    summary: "A small measured intake adjustment",
    nutrition: { target_kcal: kcal, protein_g: 170, reason: "The measured trend missed its expected band." },
  });
}

function chatTrainingDraft(summary, exercise, targetWeight) {
  return repo.createProposal("claude", `chat: ${summary}`, "", {
    summary,
    changes: [{ day_number: 1, exercise, target_weight: targetWeight, reason: summary }],
  });
}

// A recent same-kind veto (rejected/reverted within the veto window) with no side effects
// on the surprise budget (rejected decisions don't count toward it).
function seedRejectedNutritionVeto() {
  return repo.recordDecision({
    effective_date: null,
    kind: "nutrition_target",
    domain: "nutrition",
    summary: "A previously vetoed intake nudge",
    rationale: null,
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "rejected",
    autonomy_tier: "ask",
    risk_class: "low",
    reversible: false,
    context: null,
    action: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

test("adopts an orphaned bounded nutrition draft older than 2h under lead (quiet-apply)", () => {
  repo.setSettings({ lead_mode: "lead" });
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1, "the orphaned draft is adopted");

  const pending = repo.listBrainDecisions({ kind: "nutrition_target" });
  assert.equal(pending.length, 1, "exactly one nutrition decision now exists");
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].autonomy_tier, "quiet_apply");
  assert.equal(pending[0].source_ref_key, String(draft.id), "the decision points at the adopted draft");
});

test("after a recent same-kind veto the orphaned draft is adopted as ANNOUNCED, not quiet-applied", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedRejectedNutritionVeto();
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1);

  const announced = repo.listBrainDecisions({ status: "announced", kind: "nutrition_target" });
  assert.equal(announced.length, 1, "the adoption announced rather than quiet-applied");
  assert.equal(announced[0].autonomy_tier, "announce");
  assert.ok(announced[0].effective_date, "an announced change lands at a natural boundary");
  assert.equal(announced[0].source_ref_key, String(draft.id));
});

test("a draft younger than the 2h grace window is left untouched", () => {
  repo.setSettings({ lead_mode: "lead" });
  const draft = nutritionDraft("just proposed", 2250);
  backdateHours(draft.id, 0.25); // 15 minutes old — still mid-conversation

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 0, "a fresh draft is not adopted");
  assert.equal(repo.listBrainDecisions({ kind: "nutrition_target" }).length, 0, "no decision was recorded");
  assert.equal(repo.getProposal(draft.id).status, "draft", "it stays a plain draft");
});

test("under review_everything the layer holds at 'ask', so the draft stays a plain reviewable draft", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 0, "review posture holds it — no adoption");
  const decisions = repo.listBrainDecisions({ kind: "nutrition_target" });
  assert.equal(decisions.length, 1, "the explicit review reason is persisted");
  assert.equal(decisions[0].status, "review");
  assert.equal(decisions[0].context?.review_reason_code, "review_posture");
  assert.equal(repo.getProposal(draft.id).status, "draft", "it stays a reviewable draft for a later pass");
});

test("a draft already autonomy-owned is skipped — no second decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);
  // Route it through the autonomy layer once so it already carries a live decision.
  const first = applyProposalWithAutonomy(draft.id, { requested_tier: "quiet_apply" });
  assert.equal(first.pending, true);
  assert.ok(repo.getProposal(draft.id).autonomy, "the draft is now autonomy-owned");

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 0, "an already-owned draft is not re-adopted");
  assert.equal(repo.listBrainDecisions({ kind: "nutrition_target" }).length, 1, "still exactly one decision");
});

test("with two orphaned drafts of the same kind, only the newest is adopted", () => {
  repo.setSettings({ lead_mode: "lead" });
  const older = nutritionDraft("older nutrition response", 2240);
  const newer = nutritionDraft("newer nutrition response", 2260); // higher id → newest
  backdateHours(older.id, 5);
  backdateHours(newer.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1, "at most one adoption per kind per pass");

  const decisions = repo.listBrainDecisions({ kind: "nutrition_target" });
  assert.equal(decisions.length, 1, "only one decision was recorded");
  assert.equal(decisions[0].source_ref_key, String(newer.id), "the newest draft won");
  assert.equal(repo.getProposal(older.id).status, "draft", "the older draft is left for the supersede flows");
  assert.ok(!repo.getProposal(older.id).autonomy, "the older draft remains orphaned");
});

test("the selected orphan training intent lands alone, superseding stale training siblings but not nutrition", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "chest", [{ exercise: "ZOrphan Press", sets: 3, target_weight: 100 }]);
  const active = repo.getOrCreateSession(localDateISO(), null);
  const activeExercise = repo.upsertExercise({ name: "Z Active Mobility", muscle_group: "core" });
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, duration_sec, rir)
     VALUES (?, ?, 1, 30, 8)`
  ).run(active.id, activeExercise.id);
  const older = repo.createProposal("stub", "auto: older read", "", {
    summary: "Older training read",
    changes: [{ day_number: 1, exercise: "ZOrphan Press", target_weight: 102, reason: "older" }],
  });
  const freshMatching = repo.createProposal("stub", "auto: fresh in-flight read", "", {
    summary: "Fresh in-flight training read",
    changes: [{ day_number: 1, exercise: "ZOrphan Press", target_weight: 104, reason: "fresh" }],
  });
  const newer = repo.createProposal("stub", "auto: newer read", "", {
    summary: "Current training read",
    changes: [{ day_number: 1, exercise: "ZOrphan Press", target_weight: 105, reason: "current" }],
  });
  const chatRestructure = repo.createProposal("claude", "chat: restructure", "", {
    summary: "A current split discussed with the athlete",
    days: [{ day_number: 1, name: "Chat Push", focus: "chest", items: [] }],
  });
  const nutrition = nutritionDraft("separate nutrition response", 2250);
  backdateHours(older.id, 5);
  backdateHours(freshMatching.id, 0.25);
  backdateHours(newer.id, 3);
  backdateHours(nutrition.id, 3);

  const adopted = adoptOrphanedDrafts();
  assert.equal(adopted.adopted, 2, "one training and one nutrition intent are independently adopted");
  const trainingDecision = repo.listBrainDecisions({ domain: "training", limit: 10 })[0];
  assert.equal(trainingDecision.source_ref_key, String(newer.id), "newest training intent owns the boundary");

  const landed = applyDueAnnouncedDecisions(trainingDecision.effective_date);
  assert.ok(landed.applied.includes(trainingDecision.id));
  assert.equal(repo.getProposal(newer.id).status, "applied");
  assert.equal(repo.getProposal(older.id).status, "superseded", "older matching orphan alternative is retired");
  assert.equal(repo.getProposal(freshMatching.id).status, "draft", "fresh automatic work is never swept up");
  assert.equal(repo.getProposal(chatRestructure.id).status, "draft", "current chat restructure survives unrelated target cleanup");
  assert.notEqual(repo.getProposal(nutrition.id).status, "superseded", "nutrition remains its own intent");
});

test("lead repairs four same-intent legacy chat drafts through the newest eligible one without broad cleanup", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
    { exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 180 },
  ]);
  const sameIntent = [101, 102, 103, 105].map((weight, index) =>
    chatTrainingDraft(`bench reset ${index + 1}`, "Barbell Bench Press", weight)
  );
  for (let i = 0; i < sameIntent.length; i++) backdateHours(sameIntent[i].id, 6 - i);

  const unrelated = chatTrainingDraft("separate squat adjustment", "Back Squat", 185);
  const manual = repo.createProposal("coach", "manual athlete-authored bench note", "", {
    summary: "Manual bench option",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 107 }],
  });
  const automatic = repo.createProposal("stub", "auto: fresh bench read", "", {
    summary: "Fresh automatic bench read",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 108 }],
  });
  const freshMatching = chatTrainingDraft("fresh in-conversation bench reset", "Barbell Bench Press", 110);
  backdateHours(unrelated.id, 3);
  backdateHours(manual.id, 5);
  backdateHours(automatic.id, 0.25);
  backdateHours(freshMatching.id, 0.25);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 2, "the newest eligible bench intent and the independent old squat intent are owned");
  assert.equal(repo.getPlanDay(1).items.find((item) => item.exercise === "Barbell Bench Press").target_weight, 105);
  assert.equal(repo.getPlanDay(1).items.find((item) => item.exercise === "Back Squat").target_weight, 185);
  assert.equal(repo.getProposal(sameIntent[3].id).status, "applied", "the newest eligible same-intent chat draft owns the change");
  for (const older of sameIntent.slice(0, 3)) {
    assert.equal(repo.getProposal(older.id).status, "superseded", "only exact older chat siblings are retired");
  }
  assert.notEqual(repo.getProposal(unrelated.id).status, "superseded", "an unrelated chat intent is not cleanup collateral");
  assert.equal(repo.getProposal(freshMatching.id).status, "draft", "fresh same-intent chat work remains in conversation");
  assert.equal(repo.getProposal(manual.id).status, "draft", "manual/user-authored drafts are never adopted or swept");
  assert.equal(repo.getProposal(automatic.id).status, "draft", "fresh automatic work survives chat cleanup");
});

test("lead repairs the exact four-proposal Pi burst through its newest quality-valid normalized candidate", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 },
    { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  repo.savePlanDay(3, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 180 },
  ]);

  // Mirrors copied-Pi proposals 40-43: four agents iterated different day-2
  // change lists over eleven minutes under one immutable legacy instruction.
  const attempts = [
    repo.createProposal("claude", "background: chat signal", "", {
      summary: "Add flat Barbell Bench Press and skip redundant Incline Bench Press.",
      changes: [
        { day_number: 2, exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 105 },
        { day_number: 2, exercise: "Incline Bench Press", sets: 0 },
      ],
    }),
    repo.createProposal("codex", "background: chat signal", "", {
      summary: "Use flat Barbell Bench Press; skip the extra Incline Bench Press.",
      changes: [
        { day_number: 2, exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 107 },
        { day_number: 2, exercise: "Incline Bench Press", sets: 0 },
      ],
    }),
    repo.createProposal("grok", "background: chat signal", "", {
      summary: "Reset week: add flat Barbell Bench Press and skip redundant Incline Bench Press.",
      changes: [
        { day_number: 2, exercise: "Barbell Bench Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 110 },
        { day_number: 2, exercise: "Incline Bench Press", sets: 0 },
      ],
    }),
    repo.createProposal("antigravity", "background: chat signal", "", {
      summary: "Add flat Barbell Bench Press; mark redundant Incline Bench Press to skip.",
      changes: [
        { day_number: 2, exercise: "Barbell Bench Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 112 },
        { day_number: 2, exercise: "Incline Bench Press", sets: 1 },
      ],
    }),
  ];
  [191, 187, 184, 180].forEach((minutes, index) => backdateMinutes(attempts[index].id, minutes));

  const unrelatedInstruction = repo.createProposal("claude", "background: separate chat analysis", "", {
    summary: "Unrelated historical analysis",
    changes: [{ day_number: 2, exercise: "Barbell Bench Press", target_weight: 101 }],
  });
  backdateHours(unrelatedInstruction.id, 4);
  const manual = repo.createProposal("coach", "manual athlete option", "", {
    summary: "Manual lower-day option",
    changes: [{ day_number: 3, exercise: "Back Squat", target_weight: 185 }],
  });
  backdateHours(manual.id, 4);
  const freshBackground = repo.createProposal("codex", "background: chat signal", "", {
    summary: "Fresh lower-day conversation",
    changes: [{ day_number: 3, exercise: "Back Squat", target_weight: 182 }],
  });
  backdateMinutes(freshBackground.id, 15);

  assert.ok(
    ![...repo.todayAgenda().primary, ...repo.todayAgenda().more].some((item) => item.id === "draft-proposals"),
    "the copied Pi burst is never pushed back as a generic Today Review wall",
  );
  const beforeInvalid43 = repo.getPlanDay(2);
  const direct43 = applyProposalWithAutonomy(attempts[3].id, {
    requested_tier: "quiet_apply",
    explicit_user_request: true,
  });
  assert.equal(direct43.ok, false, "#43 remains invalid under the current quality contract");
  assert.ok(direct43.quality.errors.some((entry) => entry.code === "duplicate_press_angle"));
  assert.deepEqual(repo.getPlanDay(2), beforeInvalid43, "#43's failed quality check leaves no partial plan mutation");
  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1, "only the one eligible legacy retry burst is adopted");
  assert.equal(repo.getProposal(attempts[2].id).status, "applied", "invalid newest #43 falls back to normalized valid #42");
  for (const sibling of [attempts[0], attempts[1], attempts[3]]) {
    assert.equal(repo.getProposal(sibling.id).status, "superseded", "all other originals in the owned burst are accounted for");
  }
  const stored42 = repo.getProposal(attempts[2].id);
  assert.equal(stored42.parsed.changes[1].sets, 0, "the original historical payload is not rewritten");
  assert.equal(stored42.parsed.changes[1].remove, undefined);
  const appliedDecision = repo.listBrainDecisions({ status: "applied", domain: "training", limit: 20 })
    .find((decision) => decision.source_ref_key === String(attempts[2].id));
  assert.equal(appliedDecision.context.legacy_migration.code, "legacy_background_sets_zero_to_remove");
  assert.deepEqual(appliedDecision.context.legacy_migration.source_burst_proposal_ids, attempts.map((attempt) => attempt.id));
  const day2 = repo.getPlanDay(2);
  assert.ok(day2.items.some((item) => item.exercise === "Barbell Bench Press"), "the selected flat barbell press lands");
  assert.ok(day2.items.some((item) => item.exercise === "Incline Dumbbell Bench Press"), "one incline dumbbell press remains");
  assert.ok(!day2.items.some((item) => item.exercise === "Incline Bench Press"), "the duplicate incline press is explicitly removed");
  assert.equal(repo.getProposal(unrelatedInstruction.id).status, "draft", "a different background instruction is not legacy provenance");
  assert.equal(repo.getProposal(manual.id).status, "draft", "manual work is untouched");
  assert.equal(repo.getProposal(freshBackground.id).status, "draft", "fresh background chat stays in conversation");
});

test("an owned newer background-chat burst does not block an older separate burst of the same day and kind", () => {
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  const olderBucket = repo.createProposal("claude", "background: chat signal", "", {
    summary: "Older independent retry bucket",
    changes: [{ day_number: 2, exercise: "Barbell Bench Press", target_weight: 102 }],
  });
  const newerOwned = repo.createProposal("codex", "background: chat signal", "", {
    summary: "Newer already-owned retry bucket",
    changes: [{ day_number: 2, exercise: "Barbell Bench Press", target_weight: 104 }],
  });
  backdateHours(olderBucket.id, 6);
  backdateHours(newerOwned.id, 3);
  repo.setSettings({ lead_mode: "announce_first" });
  const owned = applyProposalWithAutonomy(newerOwned.id, { requested_tier: "quiet_apply", explicit_user_request: true });
  assert.equal(owned.decision.status, "announced");

  repo.setSettings({ lead_mode: "lead" });
  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1, "the older time bucket remains independently evaluable");
  assert.equal(repo.getProposal(olderBucket.id).status, "applied");
  assert.equal(repo.getProposal(newerOwned.id).autonomy.status, "announced", "the owned newer bucket is not duplicated or displaced");
});

// The production regression this file exists for: created_at is written by SQLite's
// datetime('now') — "YYYY-MM-DD HH:MM:SS", UTC, NO zone marker. A raw Date.parse reads
// that as LOCAL time, so under a non-UTC process TZ (the deployment runs in the
// athlete's zone) a 4-hour-old draft computed as minutes old and sat under the 2-hour
// grace gate forever. The gate must parse DB text as UTC regardless of process TZ, so
// this case pins it in a SUBPROCESS with a non-UTC TZ and a real SQLite-format stamp.
test("the grace gate ages SQLite-format UTC timestamps correctly under a non-UTC process TZ", () => {
  withTzSubprocess((_dataDir) => {
    const repoUrl = JSON.stringify(pathToFileURL(path.join(root, "dist", "repo.js")).href);
    const dbUrl = JSON.stringify(pathToFileURL(path.join(root, "dist", "db.js")).href);
    const autonomyUrl = JSON.stringify(pathToFileURL(path.join(root, "dist", "domain", "brain", "autonomy-service.js")).href);
    const lines = [
      `import * as repo from ${repoUrl};`,
      `import { db } from ${dbUrl};`,
      `import { adoptOrphanedDrafts } from ${autonomyUrl};`,
      'repo.setSettings({ lead_mode: "lead" });',
      'const draft = repo.createProposal("stub", "auto: weekly nutrition response", "", {',
      '  kind: "nutrition_target",',
      '  summary: "A small measured intake adjustment",',
      '  nutrition: { target_kcal: 2250, protein_g: 170, reason: "trend missed band" },',
      "});",
      "// Stamp EXACTLY what datetime('now') writes: UTC, space-separated, zone-less — 3h ago.",
      'const stamp = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");',
      'db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(stamp, Number(draft.id));',
      "const result = adoptOrphanedDrafts();",
      'process.stdout.write("===RESULT===" + JSON.stringify({ adopted: result.adopted }));',
    ];
    return lines.join("\n");
  });
});

function withTzSubprocess(buildScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-adopt-tz-"));
  try {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", buildScript(dir)], {
      cwd: root,
      env: {
        ...process.env,
        TZ: "America/New_York", // mirrors the deployment: a non-UTC athlete zone
        DATA_DIR: dir,
        DB_PATH: path.join(dir, "cairn.db"),
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const idx = res.stdout.lastIndexOf("===RESULT===");
    assert.notEqual(idx, -1, `result marker missing in subprocess stdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.slice(idx + "===RESULT===".length));
    assert.equal(parsed.adopted, 1, "a 3h-old SQLite-stamped draft must clear the 2h grace gate in any TZ");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a refused draft re-opens when training evidence moves, not only when the hour rolls over", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  assert.equal(adoptOrphanedDrafts().adopted, 0, "review posture refuses it");
  // The first refusal stamps the picture as it was BEFORE the review decision it is about
  // to insert existed, so the sweep after it necessarily re-derives once; the stamp only
  // settles on the second pass. Sweep twice so this test is about the evidence, not that.
  adoptOrphanedDrafts();
  const held = repo.listBrainDecisions({ kind: "nutrition_target" })[0];
  const firstStamp = held?.context?.adopt_attempted_signature;
  assert.ok(firstStamp, "the refusal recorded the picture it was made under");

  // A marker only a RE-DERIVATION overwrites. The skip path never touches the receipt.
  const stale = "2000-01-01T00:00:00.000Z";
  repo.patchBrainDecision(held.id, { context: { ...held.context, adopt_attempted_at: stale } });

  adoptOrphanedDrafts();
  const unchanged = repo.listBrainDecisions({ kind: "nutrition_target" })[0];
  assert.equal(unchanged.context?.adopt_attempted_at, stale, "the same picture yields the same answer, uncomputed");
  assert.equal(unchanged.context?.adopt_attempted_signature, firstStamp);

  // Evidence the sweep signature cannot see: a logged set is neither a proposal nor a
  // decision, and it flips no status — yet it is exactly the kind of thing that clears a
  // fuel hold and makes yesterday's refusal wrong. The training backstop in the stamp is
  // what carries it, so the very next sweep re-derives instead of waiting out the hour.
  repo.logSetByName({ exercise: "Orphan Refusal Row", weight: 95, reps: 8, date: localDateISO() });

  adoptOrphanedDrafts();
  const reopened = repo.listBrainDecisions({ kind: "nutrition_target" })[0];
  assert.notEqual(reopened.context?.adopt_attempted_at, stale, "the refusal was re-derived on the next sweep");
  assert.notEqual(
    reopened.context?.adopt_attempted_signature,
    firstStamp,
    "under a picture that has genuinely moved"
  );
});

// ---- A DEAD PREMISE IS RETIRED, AND A HELD DRAFT IS ASKED ABOUT ONCE ----------
//
// Live rows 26419 + 26760 both held plan_proposal 111 — "swap Decline Bench Press for
// Chest Dips" — long after the plan was restructured and Decline Bench Press had left it
// entirely. Two failures in one: the sweep kept re-offering a draft whose subject was
// gone, and each held pass whose refusal signature had MOVED (a clinical ceiling one
// week, a stale snapshot the next) recorded a second review row, so "Waiting on you"
// showed the athlete the same dead swap twice.

const CHAT_CLINICAL_PROVENANCE = { server_owned: true, source: "chat_clinical_detection", signals: ["injury"] };

function swapDraft(from, to, dayNumber = 2) {
  return repo.createProposal("claude", `chat: rotate ${from} out`, "", {
    summary: `Swap ${from} for ${to} on day ${dayNumber}`,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
    changes: [{ day_number: dayNumber, swap: { from, to }, reason: "the athlete reported chest pain" }],
  });
}

function reviewHoldsFor(proposalId) {
  return repo
    .listBrainDecisions({ status: "review", limit: 100 })
    .filter((d) => d.source_ref_type === "plan_proposal" && d.source_ref_key === String(proposalId));
}

test("a swap whose `from` exercise has left the plan retires the draft and every review row that held it", () => {
  repo.setSettings({ lead_mode: "lead" });
  // The plan as it stands AFTER the restructure: Decline Bench Press is nowhere on it.
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips");
  const held = applyProposalWithAutonomy(draft.id, {
    clinical: true,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
  });
  assert.equal(held.review_required, true, "the clinical swap is held for the athlete");
  // The second live row: a duplicate hold from a later pass, exactly as the ledger held it.
  const duplicate = repo.recordDecision({
    effective_date: null,
    kind: "exercise_rotation",
    domain: "training",
    summary: "Swap Decline Bench Press for Chest Dips on day 2",
    rationale: null,
    source: "claude",
    source_ref_type: "plan_proposal",
    source_ref_key: String(draft.id),
    status: "review",
    autonomy_tier: "clinician",
    risk_class: "clinical",
    reversible: false,
    context: { review_required: true, review_reason_code: "stale_snapshot", clinical: true },
    action: { proposal_id: draft.id, review_reason_code: "stale_snapshot" },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
  assert.equal(reviewHoldsFor(draft.id).length, 2, "the ledger starts from the live two-row state");
  backdateHours(draft.id, 3);

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.retired, 1, "the sweep retired the draft whose premise had left the plan");
  assert.equal(repo.getProposal(draft.id).status, "superseded", "the dead draft is retired");
  assert.deepEqual(reviewHoldsFor(draft.id), [], "nothing is left waiting on the athlete");

  for (const id of [held.decision.id, duplicate.id]) {
    const closed = repo.getBrainDecision(id);
    assert.equal(closed.status, "superseded", "every review row that held it is closed");
    assert.equal(closed.context.retire_reason, "premise_gone", "each closed row says why it stopped asking");
    assert.deepEqual(closed.context.retired_movements, ["Decline Bench Press"]);
    assert.match(closed.context.retired_explanation, /no longer in your plan/);
    assert.equal(closed.context.review_required, false);
  }

  const receipt = repo
    .listBrainDecisions({ status: "superseded", limit: 50 })
    .find((d) => d.context?.review_reason_code === "premise_gone");
  assert.ok(receipt, "a receipt a person can read was filed");
  assert.equal(receipt.source_ref_key, String(draft.id));
  assert.equal(receipt.action.outcome, "superseded_premise_gone");
  assert.deepEqual(receipt.action.missing_movements, ["Decline Bench Press"]);
  assert.match(receipt.rationale, /Decline Bench Press is no longer in your plan/);
});

test("a swap whose `from` exercise is still on the plan is left exactly where it was", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Decline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips");
  const held = applyProposalWithAutonomy(draft.id, {
    clinical: true,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
  });
  backdateHours(draft.id, 3);

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.retired, 0, "a live premise is never retired");
  assert.equal(repo.getProposal(draft.id).status, "draft", "the draft stays live");
  assert.equal(repo.getBrainDecision(held.decision.id).status, "review", "the athlete's question stands");
});

test("a swap the plan still carries on a DIFFERENT day keeps its premise — renumbering is not removal", () => {
  repo.setSettings({ lead_mode: "lead" });
  // The restructure moved the lift from day 2 to day 3; the draft still names day 2.
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  repo.savePlanDay(3, "Chest", "chest", [
    { exercise: "Decline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips", 2);
  backdateHours(draft.id, 3);

  assert.equal(adoptOrphanedDrafts().retired, 0, "the movement is still on the plan, so the question stands");
  assert.equal(repo.getProposal(draft.id).status, "draft");
});

test("an empty plan is never the evidence that a movement was dropped", () => {
  repo.setSettings({ lead_mode: "lead" });
  const draft = swapDraft("Decline Bench Press", "Chest Dips");
  backdateHours(draft.id, 3);

  assert.equal(adoptOrphanedDrafts().retired, 0, "no plan to read says nothing about what left it");
  assert.equal(repo.getProposal(draft.id).status, "draft");
});

test("a mixed draft keeps its live half — only an all-premise payload is retired", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  const draft = repo.createProposal("claude", "chat: rebuild the press slot", "", {
    summary: "Drop the decline press and add a flat barbell press",
    changes: [
      { day_number: 2, exercise: "Decline Bench Press", remove: true },
      { day_number: 2, exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 105 },
    ],
  });
  backdateHours(draft.id, 3);

  assert.equal(adoptOrphanedDrafts().retired, 0, "the add half would still do something");
  assert.notEqual(repo.getProposal(draft.id).status, "superseded");
});

test("two successive held passes on one draft leave exactly ONE row waiting on the athlete", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Decline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips");

  // Pass 1 — the chat turn routes it in the athlete's own current turn, so the freshness
  // gate is skipped and the clinical ceiling is what holds it.
  const first = applyProposalWithAutonomy(draft.id, {
    clinical: true,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
    explicit_user_request: true,
  });
  assert.equal(first.review_reason_code, "clinical_ceiling");
  // The plan moves underneath the draft, leaving its compare-and-set snapshot behind.
  // The swap's own subject is untouched — only the reason the next pass refuses.
  repo.savePlanDay(3, "Pull", "back", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
  ]);
  // Pass 2 — the later autonomous sweep reaches the same draft, and its refusal SIGNATURE
  // has moved: no explicit request, so the compare-and-set gate answers first.
  const second = applyProposalWithAutonomy(draft.id, {});
  assert.equal(second.review_reason_code, "stale_snapshot", "the refusal genuinely moved between passes");

  const holds = reviewHoldsFor(draft.id);
  assert.equal(holds.length, 1, "the same draft is never asked about twice");
  assert.equal(holds[0].id, first.decision.id, "the original ask keeps its place in the queue");
  assert.equal(holds[0].context.review_reason_code, "stale_snapshot", "refreshed in place with today's reason");
  assert.equal(holds[0].autonomy_tier, "clinician", "and a refresh never loosens the clinician floor");
  assert.equal(holds[0].context.clinical, true);
});

test("regeneration follows the DETERMINISTIC clinician floor, not a conductor's bare risk_class", () => {
  repo.setSettings({ lead_mode: "lead" });
  const asOf = localDateISO();
  // A deterministic producer's draft — mechanically re-runnable, so a stale one is
  // rewritten rather than asked about.
  const draft = repo.createProposal("auto-progression", "day 1 progression", "", {
    summary: "A routine day 1 target step",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 102, reason: "reps met the top" }],
  });
  // The plan moves after the draft was written, so its compare-and-set snapshot is stale
  // by the time the boundary reads it — the ending that asks whether to regenerate.
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  // A conductor wrote `risk_class:'clinical'` over an ordinary target step. Nothing in the
  // row is clinical: no server mark, no diagnosis, no medication, no dose.
  const announced = repo.recordDecision({
    effective_date: asOf,
    kind: "training_target",
    domain: "training",
    summary: "A routine day 1 target step",
    rationale: "The last two sessions finished at the top of the prescribed range.",
    source: "auto-progression",
    source_ref_type: "plan_proposal",
    source_ref_key: String(draft.id),
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "clinical",
    reversible: false,
    context: { natural_boundary: true },
    action: { proposal_id: draft.id },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;

  const due = applyDueAnnouncedDecisions(asOf);
  assert.ok(
    due.regenerated.includes(announced.id),
    "a self-attested clinical label does not put an ordinary target step on the floor"
  );
});

test("a held draft too old to sit in the newest-50 window is still retired when its premise goes", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips");
  const held = applyProposalWithAutonomy(draft.id, {
    clinical: true,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
  });
  backdateHours(draft.id, 72);
  // Push it out of the newest-50 proposal window the adoption loop walks. Only the
  // review-held read can still reach it — and a person is still being asked about it.
  for (let i = 0; i < 55; i++) nutritionDraft(`unrelated later draft ${i}`, 2200 + i);

  assert.equal(adoptOrphanedDrafts().retired, 1, "the ask a person can still see is reachable at any age");
  assert.equal(repo.getProposal(draft.id).status, "superseded");
  assert.equal(repo.getBrainDecision(held.decision.id).status, "superseded");
  assert.deepEqual(reviewHoldsFor(draft.id), []);
});

// ---- a hundred review rows is not a large ledger ---------------------------------
//
// `review` is a SHARED status. Every chat structure request sits there while the coach
// builds it, the thaw re-files the unanswered ones there, and every other hold in the
// queue competes for the same page. Both readers below used to walk the newest hundred
// review rows and filter in JS, so past that an older hold on one draft simply stopped
// existing for them: the premise-gone retirement left it open behind a dead draft, and
// the duplicate fold re-created the second ask it was written to prevent. Asked by
// proposal id, the depth of the queue stops mattering.

function seedStandingStructureRequests(count) {
  for (let i = 0; i < count; i++) {
    const request = `move my long run to Saturday (${i})`;
    repo.recordDecision({
      effective_date: null,
      kind: "training_structure",
      domain: "training",
      summary: request,
      rationale: request,
      source: "chat",
      source_ref_type: null,
      source_ref_key: null,
      status: "review",
      autonomy_tier: "ask",
      risk_class: "moderate",
      reversible: false,
      context: { review_required: true, requested_in_chat: true, athlete_request: request },
      action: { kind: "training_structure_request", request },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  }
}

// Read straight off the ledger, never through the reader under test.
function liveHoldIdsFor(proposalId) {
  return db
    .prepare(
      `SELECT id FROM brain_decisions
        WHERE status = 'review' AND source_ref_type = 'plan_proposal' AND source_ref_key = ?
        ORDER BY id ASC`
    )
    .all(String(proposalId))
    .map((row) => Number(row.id));
}

test("a hold buried under a hundred newer review rows is still retired when its premise goes", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips");
  const held = applyProposalWithAutonomy(draft.id, {
    clinical: true,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
  });
  assert.equal(held.review_required, true, "the clinical swap is held for the athlete");
  backdateHours(draft.id, 3);
  // Standing chat requests, every one of them newer than the hold.
  seedStandingStructureRequests(120);
  assert.equal(
    repo.listBrainDecisions({ status: "review", limit: 100 }).some((d) => d.id === held.decision.id),
    false,
    "the hold is genuinely off the page the old reader walked"
  );

  assert.equal(adoptOrphanedDrafts().retired, 1, "a buried ask is still reachable by proposal id");
  assert.equal(repo.getProposal(draft.id).status, "superseded", "the dead draft is retired");
  const closed = repo.getBrainDecision(held.decision.id);
  assert.equal(closed.status, "superseded", "the buried hold stops asking");
  assert.equal(closed.context.review_required, false, "it no longer reads as waiting on the athlete");
  assert.equal(closed.context.retire_reason, "premise_gone", "and it says why it stopped");
  assert.deepEqual(liveHoldIdsFor(draft.id), [], "nothing is left open behind the dead draft");
});

test("a later refusal folds into the buried hold instead of stacking a second ask", () => {
  repo.setSettings({ lead_mode: "lead" });
  // The premise is alive here: this draft is still a real question, it just already has
  // a row in the queue.
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Decline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips");
  // The ask the athlete has been looking at, from an earlier pass whose refusal signature
  // was DIFFERENT — which is exactly why the decision fingerprint cannot catch the
  // duplicate, and why the proposal id has to.
  const first = repo.recordDecision({
    effective_date: null,
    kind: "exercise_rotation",
    domain: "training",
    summary: "Swap Decline Bench Press for Chest Dips on day 2",
    rationale: null,
    source: "claude",
    source_ref_type: "plan_proposal",
    source_ref_key: String(draft.id),
    status: "review",
    autonomy_tier: "clinician",
    risk_class: "clinical",
    reversible: false,
    context: { review_required: true, review_reason_code: "domain_policy", clinical: true },
    action: { proposal_id: draft.id, review_reason_code: "domain_policy" },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
  seedStandingStructureRequests(120);

  const held = applyProposalWithAutonomy(draft.id, {
    clinical: true,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
  });
  assert.equal(held.review_required, true, "the clinical swap is still held for the athlete");
  assert.equal(held.decision.id, first.id, "today's refusal refreshed the ask already in the queue");
  assert.deepEqual(liveHoldIdsFor(draft.id), [first.id], "one open ask per draft, however deep it sits");
});

// ---- A QUESTION OUTLIVES THE DRAFT IT ASKED ABOUT BY ONE SWEEP ----------------
//
// Live row 25815: an announce-tier meal-plan decision parked at `review` by an apply
// error ("Mon totals 1800 kcal, outside the ±100 kcal rounding tolerance around the
// coordinated 1950 kcal target"), pointing at meal_plans 20. Four weeks later the
// athlete had accepted plan 30 and plan 20 was `superseded` — and the row was still in
// "Waiting on you", asking about a week that no longer existed. Nothing swept it: the
// thaw leaves a parked pending change exactly where it is, and the premise pass reads
// plan_proposals exercise targets only.

const APPLY_ERROR =
  "Mon totals 1800 kcal, outside the ±100 kcal rounding tolerance around the coordinated 1950 kcal target.";

function mealWeek(summary, kcal = 2200) {
  return {
    summary,
    daily_kcal: kcal,
    daily_protein_g: 175,
    days: Array.from({ length: 7 }, (_, index) => ({
      day: `Day ${index + 1}`,
      meals: [
        { name: `${summary} breakfast`, items: "eggs and oats", kcal: 800, protein_g: 70, carbs_g: 65, fat_g: 18 },
        {
          name: `${summary} dinner`,
          items: "salmon and potatoes",
          kcal: kcal - 800,
          protein_g: 105,
          carbs_g: 80,
          fat_g: 24,
        },
      ],
    })),
  };
}

// Exactly what applyDueAnnouncedDecisions' own parkForReview writes when the apply throws.
function parkWithApplyError(decisionId) {
  return repo.patchBrainDecision(Number(decisionId), {
    status: "review",
    reversible: false,
    context: {
      ...(repo.getBrainDecision(Number(decisionId)).context ?? {}),
      review_required: true,
      apply_error: APPLY_ERROR,
      boundary_outcome: "apply_threw",
    },
  });
}

// A stranded meal-plan hold in the live shape: announced for its boundary, parked there
// by a failed apply, still naming its own week.
function strandedMealPlanHold() {
  const current = repo.createMealPlan("stub", "", mealWeek("Current", 2250));
  repo.acceptMealPlan(current.id);
  const stranded = repo.createMealPlan("stub", "", mealWeek("Stranded", 2300));
  const scheduled = applyMealPlanWithAutonomy(stranded.id);
  assert.equal(scheduled.announced, true, "the week is announced for its natural boundary");
  parkWithApplyError(scheduled.decision.id);
  return { plan: stranded, decision: scheduled.decision };
}

function retirementReceipt() {
  return repo
    .listBrainDecisions({ status: "superseded", limit: 50 })
    .find((d) => d.context?.review_reason_code === "source_superseded");
}

test("a meal-plan hold parked by an apply error is closed once a newer week has been accepted", () => {
  repo.setSettings({ lead_mode: "lead" });
  const { plan, decision } = strandedMealPlanHold();

  // The newer week the athlete accepted. `acceptMealPlan` retires its siblings with ONE
  // bulk UPDATE over meal_plans — no per-row status call — so nothing cascades to the
  // ledger and the hold above is left naming a week that has ended.
  const newer = repo.createMealPlan("stub", "", mealWeek("Newer", 2200));
  repo.acceptMealPlan(newer.id);
  assert.equal(repo.getMealPlan(plan.id).status, "superseded", "the week it asked about is gone");
  assert.equal(repo.getBrainDecision(decision.id).status, "review", "and the question outlived it");

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.closed, 1, "the sweep closed the question behind the retired week");

  const closed = repo.getBrainDecision(decision.id);
  assert.equal(closed.status, "superseded", "nothing is left waiting on the athlete");
  assert.equal(closed.context.review_required, false);
  assert.equal(closed.context.retire_reason, "source_superseded");
  assert.equal(closed.context.retired_source_status, "superseded");
  assert.match(closed.context.retired_explanation, /newer meal plan has since been accepted/);
  assert.equal(closed.context.apply_error, APPLY_ERROR, "why it parked is kept, not rewritten");

  const landing = repo
    .listBrainDecisions({ status: "applied", kind: "meal_plan", limit: 20 })
    .find((d) => d.source_ref_key === String(newer.id));
  assert.ok(landing, "the newer week landed through its own decision");
  assert.equal(closed.superseded_by, landing.id, "the closed row says what took its place");

  const receipt = retirementReceipt();
  assert.ok(receipt, "a receipt a person can read was filed");
  assert.equal(receipt.source_ref_type, "meal_plan");
  assert.equal(receipt.source_ref_key, String(plan.id));
  assert.equal(receipt.action.meal_plan_id, plan.id);
  assert.equal(receipt.action.outcome, "closed_source_superseded");
  assert.equal(receipt.action.source_status, "superseded");
  assert.equal(receipt.action.superseded_by_decision_id, landing.id);
  assert.equal(receipt.context.superseded_review_decision_id, decision.id);
  assert.match(receipt.rationale, /newer meal plan has since been accepted/);
});

test("the same hold is left exactly where it is while its week is still a draft", () => {
  repo.setSettings({ lead_mode: "lead" });
  const { plan, decision } = strandedMealPlanHold();
  assert.equal(repo.getMealPlan(plan.id).status, "draft");

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.closed, 0, "a live draft is never closed out from under the athlete");

  const held = repo.getBrainDecision(decision.id);
  assert.equal(held.status, "review", "the question stands");
  assert.equal(held.context.review_required, true);
  assert.equal(held.context.apply_error, APPLY_ERROR, "the thaw still leaves a pending change untouched");
  assert.equal(held.context.retire_reason, undefined);
  assert.equal(held.context.thaw_attempted, undefined);
  assert.ok(!retirementReceipt(), "no receipt is filed for a week that is still waiting");
});

test("a hold on a meal plan the athlete accepted by hand closes against what actually happened", () => {
  repo.setSettings({ lead_mode: "lead" });
  const { plan, decision } = strandedMealPlanHold();
  repo.acceptMealPlan(plan.id);

  assert.equal(adoptOrphanedDrafts().closed, 1);
  const closed = repo.getBrainDecision(decision.id);
  assert.equal(closed.status, "superseded");
  assert.equal(closed.context.retired_source_status, "accepted");
  assert.match(closed.context.retired_explanation, /already the week you are on/);
});

test("a plan-proposal hold is closed when a bulk supersede retires its draft behind the ledger's back", () => {
  repo.setSettings({ lead_mode: "lead" });
  // The movement is still on the plan, so the premise pass has nothing to say here —
  // what ended is the DRAFT, not its subject.
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Decline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  const draft = swapDraft("Decline Bench Press", "Chest Dips");
  const held = applyProposalWithAutonomy(draft.id, {
    clinical: true,
    clinical_provenance: CHAT_CLINICAL_PROVENANCE,
  });
  assert.equal(held.review_required, true, "the clinical swap is held for the athlete");
  // The leak: a bulk UPDATE retires the draft without going through setProposalStatus,
  // so nothing supersedes the hold that names it.
  db.prepare("UPDATE plan_proposals SET status = 'superseded' WHERE id = ?").run(Number(draft.id));
  backdateHours(draft.id, 3);

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.retired, 0, "the premise pass walks live drafts only");
  assert.equal(sweep.closed, 1, "the hold behind the retired draft is closed");
  assert.deepEqual(liveHoldIdsFor(draft.id), [], "nothing is left waiting on the athlete");

  const closed = repo.getBrainDecision(held.decision.id);
  assert.equal(closed.status, "superseded");
  assert.equal(closed.context.retire_reason, "source_superseded");
  assert.equal(closed.context.retired_source_status, "superseded");
  assert.match(closed.context.retired_explanation, /newer draft has since taken/);

  const receipt = retirementReceipt();
  assert.ok(receipt, "the same receipt the meal-plan path files");
  assert.equal(receipt.source_ref_type, "plan_proposal");
  assert.equal(receipt.action.proposal_id, draft.id);
  assert.equal(receipt.action.outcome, "closed_source_superseded");
});

test("a standing structure request names no draft, so the ended-source pass never touches it", () => {
  // `review_everything` shuts the thaw off entirely, so this pass is the only one that
  // could reach these rows — and it must not.
  repo.setSettings({ lead_mode: "review_everything" });
  seedStandingStructureRequests(3);
  const before = db
    .prepare(`SELECT id, status, context_json FROM brain_decisions WHERE kind = 'training_structure' ORDER BY id ASC`)
    .all();
  assert.equal(before.length, 3);

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.closed, 0, "an ask with no draft behind it is not a question about a draft");

  const after = db
    .prepare(`SELECT id, status, context_json FROM brain_decisions WHERE kind = 'training_structure' ORDER BY id ASC`)
    .all();
  assert.deepEqual(after, before, "the athlete's standing ask is still waiting on them, untouched");
});
