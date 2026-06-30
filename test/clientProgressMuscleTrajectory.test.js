import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadMuscleTrajectory() {
  const context = { Object, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-muscle-trajectory-client.js"), "utf8"), context);
  return context.CairnProgressMuscleTrajectory;
}

test("progress muscle trajectory renders rows safely", () => {
  const muscle = loadMuscleTrajectory();
  const html = muscle.muscleTrajectoryHtml({
    available: true,
    headline: "Upper body <focus>",
    groups: [
      {
        group: "chest",
        label: "Chest <press>",
        verdict: "stalling",
        lead_lift: "Bench <bar>",
        volume_band: "low",
        trend: "falling",
        stalled_signal: "Top set flat <2wk>",
        note: "Change angle <soon>",
        vary_options: [
          { name: "Incline press <db>", why: "upper chest <bias>" },
          { name: "Push-up" },
          { name: "Cable fly" },
          { name: "Extra option" },
        ],
      },
      { group: "back", verdict: "advancing", trend: "rising" },
    ],
  });

  assert.match(html, /Upper body &lt;focus&gt;/);
  assert.match(html, /pmus-watch/);
  assert.match(html, /Chest &lt;press&gt;/);
  assert.match(html, /Bench &lt;bar&gt;/);
  assert.match(html, /↓ falling/);
  assert.match(html, /title="upper chest &lt;bias&gt;"/);
  assert.match(html, /Incline press &lt;db&gt;/);
  assert.doesNotMatch(html, /Extra option/);
  assert.doesNotMatch(html, /<focus>|<press>|<bar>|<2wk>|<soon>|<db>/);
});

test("progress muscle trajectory exposes calm mappings and empty states", () => {
  const muscle = loadMuscleTrajectory();

  assert.equal(muscle.muscleVerdictTone("advancing"), "strong");
  assert.equal(muscle.muscleVerdictTone("stalling"), "watch");
  assert.equal(muscle.muscleVerdictTone("building"), "steady");
  assert.equal(muscle.muscleVerdictWord("maintaining"), "Holding");
  assert.equal(muscle.muscleTrendGlyph("stable"), "→");
  assert.equal(muscle.muscleTrajectoryHtml({ available: false, groups: [] }), "");
});

test("progress muscle trajectory loader hydrates active Program slot", async () => {
  const context = { Object, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-muscle-trajectory-client.js"), "utf8"), context);
  const slot = { isConnected: true, innerHTML: "" };
  context.state = { tab: "progress", progressSeg: "program" };
  context.view = {
    querySelector(selector) {
      return selector === "#progMuscleSlot" ? slot : null;
    },
  };
  context.api = async () => ({
    available: true,
    headline: "Groups <read>",
    groups: [{ group: "chest", label: "Chest <press>", verdict: "advancing" }],
  });

  await context.CairnProgressMuscleTrajectory.loadMuscleTrajectory();

  assert.match(slot.innerHTML, /Groups &lt;read&gt;/);
  assert.match(slot.innerHTML, /Chest &lt;press&gt;/);
  assert.doesNotMatch(slot.innerHTML, /<read>|<press>/);
});
