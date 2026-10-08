// Horizon's "behind you" weight line is Today's own path row, word for word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedWeight } from "./_seed.js";
import { weekRead } from "../dist/domain/training/week-read.js";
import { todayPath } from "../dist/repo/today-path.js";
import { seedDemo } from "../dist/demoSeed.js";
import { addDaysISO } from "../dist/lib/dates.js";

test("the journey's weight line is Today's path row, word for word", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-22T12:00:00") });
  seedDemo();
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Riverside Half", date: "2026-10-18", distance_km: 21.1, target: "sub-1:45" },
    goal_mode: "lose",
    start_weight_lb: 190,
    start_date: "2026-08-03",
    goal_weight_lb: 170,
  });
  const today = "2026-09-22";
  for (let i = 0; i < 6; i++) seedWeight(addDaysISO(today, -i * 3), 182 - i * 0.2);
  const row = todayPath(today).board.find((r) => r.key === "weight");
  assert.ok(row?.note && /down since/.test(row.note), `Today's row says ${row?.note}`);
  assert.equal(row.moved_words, row.note);
  const behind = weekRead().journey?.behind?.find((b) => b.key === "weight");
  assert.ok(behind, "the road carries a weight line");
  assert.equal(behind.words, row.note);
});
