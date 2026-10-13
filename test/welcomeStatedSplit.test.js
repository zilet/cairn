// The split they NAMED binds the first week (a real-provider walk of the welcome: the
// person said "upper/lower, Mon/Tue/Thu/Fri", and once a race was in the same message
// the composer wrote three upper days and one "Lower — Strength").
//
//   - the onboarding contract captures the split in their words and it rides the stated
//     strength schedule (kept across a weekday-only update, cleared only by split:null);
//   - the composer's prompt carries it as a binding STATED SPLIT line, and the welcome
//     hands the composer the person's WHOLE message (240 characters cut the split off
//     whenever a race came first);
//   - plan quality flags a week that departs from it — a warning, never a refusal — and
//     only for a split whose words actually name parts (no guessing at "a bro split").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repo } from "./_seed.js";
import { applyOnboardParsed, emptyOnboardApplied } from "../dist/coachOps.js";
import { getStrengthSchedule, setProfile } from "../dist/repo/profile.js";
import { splitParts, statedSplitIssues } from "../dist/repo/stated-split.js";
import { validateTrainingPlan } from "../dist/repo/plan-quality.js";
import { buildOnboardPrompt } from "../dist/prompt/program.js";
import { buildWeekComposePrompt } from "../dist/prompt/coach.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SENTINEL = "===CAIRN_TEST_RESULT===";

const day = (day_number, name, exercise = "Barbell Bench Press") => ({
  day_number,
  name,
  focus: name.toLowerCase(),
  items: [{ exercise, sets: 3, rep_low: 6, rep_high: 10 }],
});

test("splitParts reads only the words a split is named by", () => {
  assert.deepEqual(splitParts("upper/lower"), ["upper", "lower"]);
  assert.deepEqual(splitParts("Upper body / lower body split"), ["upper", "lower"]);
  assert.deepEqual(splitParts("upper-lower"), ["upper", "lower"]);
  assert.deepEqual(splitParts("push, pull and legs"), ["push", "pull", "legs"]);
  assert.deepEqual(splitParts("PPL"), ["push", "pull", "legs"]);
  assert.deepEqual(splitParts("full body"), ["full"]);
  assert.deepEqual(splitParts("full-body"), ["full"]);
  assert.equal(splitParts("a bro split"), null, "not a word a split is checked by");
  assert.equal(splitParts("upper/chest"), null, "one unknown part and nothing is checked");
  assert.equal(splitParts(""), null);
  assert.equal(splitParts(null), null);
});

test("a week that departs from the stated split is named; one that keeps it is not", () => {
  const walked = [day(1, "Upper A"), day(2, "Upper B"), day(4, "Lower — Strength", "Back Squat"), day(5, "Upper C")];
  const issues = statedSplitIssues(walked, "upper/lower");
  assert.ok(issues.length >= 1, "three upper and one lower is not an upper/lower split");
  assert.ok(issues.every((i) => i.code === "stated_split"));
  const kept = [day(1, "Upper"), day(2, "Lower", "Back Squat"), day(4, "Upper"), day(5, "Lower", "Deadlift")];
  assert.deepEqual(statedSplitIssues(kept, "upper/lower"), []);
  const stray = statedSplitIssues([day(1, "Upper"), day(2, "Arms")], "upper/lower");
  assert.ok(
    stray.some((i) => i.day_number === 2),
    "a day that is no part of the split is named"
  );
  assert.deepEqual(statedSplitIssues(walked, "a bro split"), [], "unreadable words check nothing");
  assert.deepEqual(statedSplitIssues(walked, null), []);
});

test("plan quality carries the split as a warning, never a refusal", () => {
  const walked = [day(1, "Upper A"), day(2, "Upper B"), day(4, "Lower", "Back Squat"), day(5, "Upper C")];
  const report = validateTrainingPlan(walked, { statedSplit: "upper/lower" });
  assert.ok(report.warnings.some((w) => w.code === "stated_split"));
  assert.ok(!report.errors.some((e) => e.code === "stated_split"));
  assert.ok(!validateTrainingPlan(walked).warnings.some((w) => w.code === "stated_split"), "no split, no check");
});

test("onboarding stores the named split on the stated lifting week, in their words", () => {
  const applied = emptyOnboardApplied();
  applyOnboardParsed({ lift_days: [1, 2, 4, 5], lift_split: "upper/lower" }, applied);
  assert.equal(getStrengthSchedule().split, "upper/lower");
  assert.deepEqual(applied.lift_days, [1, 2, 4, 5]);
  assert.equal(applied.lift_split, "upper/lower");
  // A weekday-only update keeps the split; an explicit null clears it.
  setProfile({ strength_schedule: { days: [{ dow: 1 }, { dow: 3 }, { dow: 5 }] } });
  assert.equal(getStrengthSchedule().split, "upper/lower");
  setProfile({ strength_schedule: { days: [{ dow: 1 }, { dow: 3 }, { dow: 5 }], split: null } });
  assert.equal(getStrengthSchedule().split, undefined);
});

test("a split with no weekdays named is remembered in their words, not hung on invented days", () => {
  const applied = emptyOnboardApplied();
  applyOnboardParsed({ lift_split: "push/pull/legs" }, applied);
  assert.equal(getStrengthSchedule(), null, "no lifting week invented");
  assert.equal(applied.lift_split, "push/pull/legs");
  assert.ok(repo.listMemory().some((m) => /push\/pull\/legs/.test(m.content)));
});

test("the onboarding contract asks for the split, and the composer is bound to it", () => {
  const onboard = buildOnboardPrompt("Upper/lower, Mon Tue Thu Fri.", { welcome: true, today: "2026-10-13" });
  assert.match(onboard, /"lift_split"/);
  applyOnboardParsed({ lift_days: [1, 2, 4, 5], lift_split: "upper/lower" }, emptyOnboardApplied());
  const prompt = buildWeekComposePrompt("first week");
  assert.match(prompt, /STATED SPLIT: "upper\/lower"/);
  assert.match(prompt, /two upper days and two lower days/);
  assert.match(prompt, /never the split/);
});

// ---------- the welcome hands the composer the whole message ----------

test("welcome: a split said after a long race sentence still reaches the composer", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-split-"));
  try {
    const reply = {
      about_me: "Training for a half marathon while lifting an upper/lower split.",
      profile: {},
      goal: "maintain",
      lift_days: [1, 2, 4, 5],
      lift_split: "upper/lower",
      endurance_goal: null,
      endurance_schedule: null,
      supplements: [],
      memories: [],
      context_events: [],
      movement_considerations: [],
      welcome_reply: "Thanks, that's a clear picture. I'm putting a first week and a starting food target in place.",
      fuel_start: null,
      summary: "A first week.",
      days: [day(1, "Upper"), day(2, "Lower", "Back Squat"), day(4, "Upper"), day(5, "Lower", "Deadlift")],
    };
    const replyFile = path.join(dataDir, "reply.json");
    fs.writeFileSync(replyFile, JSON.stringify(reply));
    const prompts = path.join(dataDir, "prompts");
    fs.mkdirSync(prompts);
    // A short prompt arrives as the shell's $0, a long one on stdin: keep each one, then
    // answer with the canned reply.
    const command = `n=$(ls '${prompts}' | wc -l | tr -d ' '); { printf '%s' "$0"; cat; } > '${prompts}'/$n.txt; cat '${replyFile}'`;
    const configPath = path.join(dataDir, "agents.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        coach: { command: "sh", args: ["-c", command, "{prompt}"], input: "arg", env_required: [], label: "Claude" },
      })
    );
    const race =
      "I'm training for a half marathon on November 15th and I'd really like to break 1:50 this time around — it's my second one, the first went fine but I faded badly in the last few kilometres, so this block I want to build the endurance properly and stay healthy all the way to the start line. ";
    const text = `${race}For lifting I do an upper/lower split on Monday, Tuesday, Thursday and Friday.`;
    assert.ok(text.indexOf("upper/lower") > 240, "the split sits past the old 240-character cut");
    const url = (rel) => JSON.stringify(pathToFileURL(path.join(root, "dist", rel)).href);
    const runner = [
      `import * as repo from ${url("repo.js")};`,
      `import * as ops from ${url("coachOps.js")};`,
      "const out = await (async () => {",
      `  repo.setSettings({ lead_mode: "lead" });`,
      `  const result = await ops.welcomeCoach("coach", ${JSON.stringify(text)});`,
      "  return { ok: result.ok, week_state: result.week_state, applied: result.applied, follow_up: result.follow_up ?? null };",
      "})();",
      `process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(out));`,
      "process.exit(0);",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: { ...process.env, AGENTS_CONFIG: configPath, DATA_DIR: dataDir, DB_PATH: path.join(dataDir, "cairn.db") },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf(SENTINEL) + SENTINEL.length));
    assert.equal(out.ok, true);
    assert.equal(out.applied.lift_split, "upper/lower");
    assert.deepEqual(
      out.follow_up?.asks,
      ["days"],
      "a race was mentioned and no run days said: the one follow-up asks them"
    );
    const composed = fs
      .readdirSync(prompts)
      .map((f) => fs.readFileSync(path.join(prompts, f), "utf8"))
      .find((p) => /FIRST training week/.test(p));
    assert.ok(composed, "the composer was asked");
    const task = composed.slice(composed.indexOf("TASK:"));
    assert.match(task, /upper\/lower split on Monday, Tuesday, Thursday and Friday/, "the whole message is the task");
    assert.match(composed, /STATED SPLIT: "upper\/lower"/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
