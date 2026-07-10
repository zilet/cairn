import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthLearned() {
  const context = {
    Array,
    Object,
    String,
    absDate: (iso) => `abs ${iso}`,
    relAge: (iso) => `age ${iso}`,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  const source = readFileSync(join(root, "src/client/health-learned-client.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, context);
  return context.CairnHealthLearned;
}

test("health learned item renderer escapes content and date attributes", () => {
  const learned = loadHealthLearned();

  const html = learned.learnedItemHtml(
    {
      when: "2026-06-01<script>",
      title: "Goal <lean>",
      detail: "Protein improved <daily>",
      source: "memory <agent>",
    },
    2,
  );

  assert.match(html, /Goal &lt;lean&gt;/);
  assert.match(html, /Protein improved &lt;daily&gt;/);
  assert.match(html, /memory &lt;agent&gt;/);
  assert.match(html, /title="abs 2026-06-01&lt;script&gt;"/);
  assert.match(html, /age 2026-06-01&lt;script&gt;/);
  assert.match(html, /--i:3/);
  assert.doesNotMatch(html, /<lean>|<daily>|<agent>|<script>/);
});

test("health learned timeline groups known item kinds and stays pull-only", () => {
  const learned = loadHealthLearned();

  const html = learned.learnedTimelineHtml({
    items: [
      { kind: "applied", title: "Plan <change>", detail: "Accepted <hold>" },
      { kind: "directive", title: "Labs <linked>", detail: "Mention <clinician>" },
      { kind: "memory", title: "Constraint <known>", detail: "Travel <week>" },
      { kind: "learning", title: "Outcome <read>", detail: "Sleep helped <session>" },
      { kind: "outcome", title: "Expected <result>", detail: "Learned <response>" },
      { kind: "unknown", title: "Hidden <item>", detail: "Should not render" },
    ],
  });

  assert.match(html, /Understood about you/);
  assert.match(html, /What we tried, and how it went/);
  assert.match(html, /Decisions, expectations and outcomes/);
  assert.match(html, /Connections it made/);
  assert.match(html, /Plan changes you accepted/);
  assert.match(html, /Curate these in Memory/);
  assert.match(html, /Constraint &lt;known&gt;/);
  assert.match(html, /Outcome &lt;read&gt;/);
  assert.match(html, /Expected &lt;result&gt;/);
  assert.match(html, /Labs &lt;linked&gt;/);
  assert.match(html, /Plan &lt;change&gt;/);
  assert.doesNotMatch(html, /Hidden|<known>|<read>|<result>|<linked>|<change>/);
  assert.equal(learned.LEARNED_GROUPS.length, 5);
});

test("health learned timeline renders a quiet empty state", () => {
  const learned = loadHealthLearned();

  const html = learned.learnedTimelineHtml({ items: [] });

  assert.match(html, /A quiet record of what Cairn has come to understand/);
  assert.match(html, /Nothing learned yet/);
  assert.doesNotMatch(html, /learnedToMemory/);
});
