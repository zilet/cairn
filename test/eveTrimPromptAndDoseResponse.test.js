// Four small wiring pins:
//   - the agent-authored session prompt on a STANDING key-run eve names the trimmed
//     accessories as the only lifts losing a set, and keeps the compounds as written;
//   - a movement's learned response never reads another lift's work: a gym substitution's
//     dose and a dose logged before its card was adopted are skipped;
//   - the strength-capability surfaces say each in-plan unit carries its `next` lever;
//   - the daily decision's policy version moved with the stress decision's new shape, so a
//     decision stored under the old version is never served as today's.
// Synthetic fixtures; deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, repo } from "./_seed.js";
import { buildDailyCompositionPrompt } from "../dist/prompt.js";
import { recentMovementResponse } from "../dist/repo/training-response.js";
import { UNIT_SUBSTITUTE_KEY_PREFIX } from "../dist/repo/daily-reconciliation.js";
import { SUBSTITUTE_DOSE_KEY_PREFIX } from "../dist/repo/training-response.js";
import { DAILY_DECISION_POLICY_VERSION, getLatestDailySessionDecision } from "../dist/repo/daily-decision.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const day = (delta) => addDaysISO(localDateISO(), delta);

// ---- the standing eve, said to the agent by name ----------------------------------------

const eveEnvelope = (stress) => ({
  date: localDateISO(),
  kind: "train",
  template: { focus: "Lower" },
  muscles: { allowed: ["quads", "hamstrings"], required: [], reduced: ["quads", "hamstrings"], excluded: [] },
  caps: { volume: "normal", intensity: "normal", duration_min: 50 },
  candidates: [],
  stress,
});

test("the standing eve names its trimmed accessories as the only lifts losing a set; compounds stay as written", () => {
  const prompt = buildDailyCompositionPrompt(
    eveEnvelope({
      code: "key_run_eve",
      load_held: true,
      sole_reduced: ["quads", "hamstrings"],
      scope: "standing",
      trim_exercises: ["Leg Extension", "Seated Leg Curl"],
    })
  );
  assert.match(prompt, /Leg Extension, Seated Leg Curl are the ONLY lifts that lose a set today/);
  assert.match(prompt, /one set each, at the prescribed weight/);
  assert.match(prompt, /Every compound in quads, hamstrings \(a squat, a deadlift, a lunge\) stays exactly as written/);
  assert.doesNotMatch(prompt, /FEWER SETS, SAME WEIGHT/, "never the area-level trim on a standing eve");
  // The in-build eve keeps its area-level line.
  const inBuild = buildDailyCompositionPrompt(
    eveEnvelope({ code: "key_run_eve", load_held: true, sole_reduced: ["quads", "hamstrings"], hold_exercise: "Back Squat" })
  );
  assert.match(inBuild, /FEWER SETS, SAME WEIGHT \(a key run is close\): quads, hamstrings/);
  assert.match(inBuild, /Back Squat is the day's main lift/);
  assert.doesNotMatch(inBuild, /ONLY lifts that lose a set/);
});

// ---- the learned response reads only the lift's own doses --------------------------------

function storeOutcome(date, dose) {
  const session = repo.getOrCreateSession(date, null);
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Card fixture', '[]', ?)`
    )
    .run(session.id, date, `card-${session.id}-${Math.random()}`);
  const facts = {
    schema_version: 4,
    confidence: "high",
    skipped: [],
    dose_context: { comparable: true, non_comparable_reasons: [] },
    dose_evidence: [{ intent_key: "strength", challenge_verdict: "met", comparable: true, non_comparable_reasons: [], ...dose }],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, date, JSON.stringify(facts));
}

test("a dose logged before its card, or a substitute's dose, is never the planned lift's response", () => {
  assert.equal(SUBSTITUTE_DOSE_KEY_PREFIX, UNIT_SUBSTITUTE_KEY_PREFIX, "the restated prefix is the writer's");
  const key = "exercise:4242";
  storeOutcome(day(-9), { movement_key: key, exercise: "Back Squat" });
  // Logged before the card was adopted: the day is comparable, this dose is not the card's.
  storeOutcome(day(-5), {
    movement_key: key,
    exercise: "Back Squat",
    comparable: false,
    non_comparable_reasons: ["adopted_after_log"],
    adopted_after_log: true,
  });
  const read = recentMovementResponse(key, { intent_key: "strength" });
  assert.equal(read.considered_outcomes, 1, "the adopted-after-log dose is not considered");
  assert.equal(read.verdict, "insufficient", "one honest met dose is not yet an earned response");
  // A third, honest dose makes two: earned.
  storeOutcome(day(-2), { movement_key: key, exercise: "Back Squat" });
  assert.equal(recentMovementResponse(key, { intent_key: "strength" }).verdict, "earned_absorbed");
  // A slot another variant satisfied (a gym substitution), even one keyed as the planned
  // lift, is that variant's work: skipped.
  const planned = "exercise:77";
  for (const delta of [-8, -4])
    storeOutcome(day(delta), {
      movement_key: planned,
      exercise: "Back Squat",
      substituted_by: "Hack Squat",
      comparable: false,
      non_comparable_reasons: ["unit_substitute"],
    });
  const viaSubstitute = recentMovementResponse(planned, { intent_key: "strength" });
  assert.equal(viaSubstitute.considered_outcomes, 0);
  assert.equal(viaSubstitute.verdict, "insufficient");
});

// ---- the surfaces say the lever is there --------------------------------------------------

test("the strength-capability MCP tool and REST route say each in-plan unit carries its next lever", () => {
  const mcp = readFileSync(join(root, "src/surfaces/mcp/program.ts"), "utf8");
  const description = mcp.slice(mcp.indexOf('"get_strength_capability"'), mcp.indexOf('"get_test_week"'));
  assert.match(description, /carries its `next` lever/);
  const route = readFileSync(join(root, "src/routes/program.ts"), "utf8");
  assert.match(route, /in-plan unit the plateau ladder covers\s*\n\/\/ carries its `next` lever/);
});

// ---- the policy version moved with the stress decision's shape ----------------------------

test("a decision stored under the previous policy version is never served as the day's", () => {
  assert.equal(DAILY_DECISION_POLICY_VERSION, "daily_decision_v9");
  const date = day(0);
  db.prepare(
    `INSERT INTO daily_session_decisions (date, composition_id, policy_version, input_fingerprint, kind, envelope_json)
     VALUES (?, NULL, 'daily_decision_v8', 'fp-old', 'train', ?)`
  ).run(date, JSON.stringify({ date, kind: "train", policy_version: "daily_decision_v8", stress: { code: null } }));
  assert.equal(getLatestDailySessionDecision(date), null, "the old shape is not today's decision");
});
