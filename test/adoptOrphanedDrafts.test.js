import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adoptOrphanedDrafts, applyDueAnnouncedDecisions, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
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
