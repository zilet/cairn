import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadPlanEnduranceClient() {
  const context = {
    Array,
    Object,
    String,
    runTargetText: (run) => `${run.target_distance_km || 0} km @ ${run.target_zone || "easy"}`,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-client.js"), "utf8"), context);
  return context.CairnPlanEndurance;
}

test("plan endurance helper renders the current race phase ramp", () => {
  const endurance = loadPlanEnduranceClient();

  assert.equal(endurance.rampHtml({ mode: "standing", phase: "build" }), "");
  const html = endurance.rampHtml({ mode: "race", phase: "build" });
  assert.match(html, /The ramp to race day/);
  assert.match(html, /class="ramp-step is-done"/);
  assert.match(html, /class="ramp-step is-current"/);
  assert.match(html, /You're here/);
  assert.match(html, /--i:1/);
});

test("plan endurance helper chooses race and standing presets", () => {
  const endurance = loadPlanEnduranceClient();
  const race = endurance.presets({ mode: "race" }).map((item) => item.t);
  const standing = endurance.presets({ mode: "standing" }).map((item) => item.t);

  assert.equal(JSON.stringify(race), '["Plan this week\'s runs","Progress my long run","Ease back — feeling flat"]');
  assert.equal(JSON.stringify(standing), '["Plan this week\'s runs","Keep me race-ready","Ease back this week"]');
});

test("plan endurance draft card escapes runs and preserves apply controls", () => {
  const endurance = loadPlanEnduranceClient();
  const html = endurance.draftCardHtml({
    id: '12" onclick="bad',
    agent: "auto <coach>",
    parsed: {
      summary: "Build week <steady>",
      cardio: [
        {
          day_number: "3",
          label: "Tempo <run>",
          target_distance_km: 8,
          target_zone: "Z3 <controlled>",
          reason: "race prep <now>",
        },
      ],
    },
  });

  assert.match(html, /auto &lt;coach&gt; · #12" onclick="bad/);
  assert.match(html, /Build week &lt;steady&gt;/);
  assert.match(html, /Tempo &lt;run&gt;/);
  assert.match(html, /8 km @ Z3 &lt;controlled&gt;/);
  assert.match(html, /race prep &lt;now&gt;/);
  assert.match(html, /data-egapply="12&quot; onclick=&quot;bad"/);
  assert.match(html, /data-egdiscard="12&quot; onclick=&quot;bad"/);
  assert.doesNotMatch(html, /<coach>|<steady>|<run>|data-egapply="12" onclick|data-egdiscard="12" onclick/);
});

test("plan endurance orchestration uses the rolling agenda and movable anchor language", () => {
  const source = readFileSync(join(root, "src/client/plan-endurance-client.ts"), "utf8");
  assert.match(source, /api\(`\/training-agenda\?date=/);
  assert.match(source, /trainingAgendaCard\(agenda\)/);
  assert.match(source, /Suggested anchor/);
  assert.match(source, /movable weekly intentions/);
  assert.doesNotMatch(source, /each run lands on its day|>Day \$\{|tempo on Thursday/);
});
