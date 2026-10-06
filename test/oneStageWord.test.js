// ONE stage word per week (docs/IA.md contract test 5). A week used to be "Sharpen" on
// Today's path, "Build week" on the day page and the look-ahead, and its own phrase on
// Train. Every surface now names the week through the stage vocabulary
// (src/repo/stage-words.ts) read by weekStage() (src/repo/week-stage.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { planLookAhead } from "../dist/domain/training/plan-look-ahead.js";
import { weekRead } from "../dist/domain/training/week-read.js";
import { raceBuild } from "../dist/repo/race-build.js";
import { getCoachingFocus } from "../dist/repo/coach.js";
import { coachingFocus } from "../dist/repo/coaching-focus.js";
import { todayPath } from "../dist/repo/today-path.js";
import { weekStage, weekFrameLine, rungStage } from "../dist/repo/week-stage.js";
import { STAGE_WORD, STAGE_WEEK_WORD, stageKeyOf, stageKeyOfBlockPhase } from "../dist/repo/stage-words.js";
import { localDateISO } from "../dist/repo/shared.js";

const NOW = new Date("2026-09-22T12:00:00");

test("the vocabulary: a build rung speaks as its phase, every other rung as its kind", () => {
  assert.equal(stageKeyOf("build", "base"), "base");
  assert.equal(stageKeyOf("build", "build"), "build");
  assert.equal(stageKeyOf("build", "sharpen"), "sharpen");
  assert.equal(stageKeyOf("build", "taper"), "taper");
  assert.equal(stageKeyOf("down", "sharpen"), "down");
  assert.equal(stageKeyOf("peak", "sharpen"), "peak");
  assert.equal(stageKeyOf("taper", "taper"), "taper");
  assert.equal(stageKeyOf("race", "taper"), "race");
  assert.equal(stageKeyOf("nonsense", "nonsense"), null);
  assert.equal(stageKeyOfBlockPhase("intensification"), "sharpen");
  assert.equal(stageKeyOfBlockPhase("deload"), "down");
  for (const key of Object.keys(STAGE_WORD)) assert.ok(STAGE_WEEK_WORD[key].startsWith(STAGE_WORD[key].split(" ")[0]));
});

test("the conductor's block line leads with the week's stage word, and says a set-aside deload once", () => {
  const line = coachingFocus({
    programBlock: { phase: "accumulation", week_of: "week 3 of 5" },
    weekStage: { word: "Build", week_word: "Build week" },
  }).block_line;
  assert.equal(line, "Build · Week 3 of 5 — building volume.");
  const skipped = coachingFocus({
    programBlock: { phase: "intensification", week_of: "week 6 of 6", scheduled_deload_skipped: true },
    weekStage: { word: "Sharpen" },
  });
  assert.ok(skipped.block_line.startsWith("Sharpen · Week 6 of 6 — the scheduled deload is set aside"));
  // The line says the set-aside; the decision beside it never says it again.
  assert.doesNotMatch(skipped.block.decision, /set aside/i);
  // Without a stage the line keeps its old shape.
  assert.equal(
    coachingFocus({ programBlock: { phase: "accumulation", week_of: "week 3 of 5" } }).block_line,
    "Week 3 of 5 — building volume."
  );
});

test("every surface names this week with the one stage word", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Riverside Half", date: "2026-10-18", distance_km: 21.1, target: "sub-1:45" },
  });
  const today = localDateISO();
  const build = raceBuild(today);
  const stage = weekStage(today, { build });
  assert.ok(stage, "a dated race names the week");
  assert.equal(stage.source, "race");

  // The race build's own rows carry it.
  const current = build.weeks.find((w) => w.current);
  assert.equal(current.stage_word, stage.week_word);
  assert.equal(rungStage(current).key, stage.key);
  for (const w of build.weeks) assert.equal(w.stage_word, rungStage(w).week_word);

  // Today's path and the frame.
  assert.equal(todayPath(today).week?.phase ?? stage.word, stage.word);
  const frame = weekFrameLine(today, { build });
  assert.equal(frame.stage.word, stage.word);
  assert.ok(frame.line.startsWith(stage.word));
  assert.equal(weekRead(today).frame.stage.word, stage.word);

  // The day page and the look-ahead tag the week with its week word.
  const day = dayDetail(today);
  if (day.week.race) {
    assert.equal(day.week.race.word, stage.week_word);
    assert.equal(day.week.race.stage, stage.key);
  }
  const mark = planLookAhead().weeks[0].markers.find((m) => m.kind === "race_build");
  if (mark) assert.equal(mark.word, stage.week_word);

  // The conductor's block line leads with it.
  const focus = getCoachingFocus();
  if (focus.block_line) assert.ok(focus.block_line.startsWith(`${stage.word} · `), focus.block_line);

  // No other stage word for this week leaks into those surfaces' week names.
  const others = Object.values(STAGE_WEEK_WORD).filter((w) => w !== stage.week_word);
  for (const word of others) {
    if (day.week.race) assert.notEqual(day.week.race.word, word);
    if (mark) assert.notEqual(mark.word, word);
  }
});
