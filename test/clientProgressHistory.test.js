import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgressHistory() {
  const context = {
    Date,
    Math,
    Number,
    Object,
    String,
    fmtDur(seconds) {
      const value = Number(seconds) || 0;
      return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
    },
    fmtK(value) {
      return `K${value}`;
    },
    fmtShortDate(value) {
      return `short ${value}`;
    },
    fmtWeight(value) {
      return String(value);
    },
    setsTonnage(sets) {
      return (sets || []).reduce((sum, set) => sum + (Number(set.weight) || 0) * (Number(set.reps) || 0), 0);
    },
    stagger(index) {
      return `--i:${index}`;
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-history-model-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-history-render-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-history-client.js"), "utf8"), context);
  return context.CairnProgressHistory;
}

test("progress history session card renders safely", () => {
  const history = loadProgressHistory();
  const html = history.sessionCardHtml(
    {
      id: '42" onclick="bad',
      date: "2026-06-29",
      title: "Upper <A>",
      duration_min: 47,
      notes: "Felt <good>",
      sets: [
        { exercise: "Bench <press>", weight: 100, reps: 5 },
        { exercise: "Bench <press>", weight: 110, reps: 5 },
        { exercise: "Plank <core>", duration_sec: 90 },
      ],
    },
    3,
  );

  assert.match(html, /data-sessid="42&quot; onclick=&quot;bad"/);
  assert.match(html, /aria-label="Edit Monday session"/);
  assert.match(html, /short 2026-06-29 · Upper &lt;A&gt;/);
  assert.match(html, /Bench &lt;press&gt;/);
  assert.match(html, /100×5/);
  assert.match(html, /hist-best">110×5/);
  assert.match(html, /Plank &lt;core&gt;/);
  assert.match(html, /1:30/);
  assert.match(html, /K1050 lb/);
  assert.match(html, /47 min/);
  assert.match(html, /3 sets/);
  assert.match(html, /“Felt &lt;good&gt;”/);
  assert.match(html, /--i:3/);
  assert.doesNotMatch(html, /onclick="bad|<A>|<press>|<core>|<good>/);
});

test("progress history handles empty sessions and number coercion", () => {
  const history = loadProgressHistory();
  const html = history.sessionCardHtml({ id: 7, date: "2026-06-30", sets: [] }, 1);

  assert.match(html, /No sets/);
  assert.match(html, /0 sets/);
  assert.equal(history.numOrNull(""), null);
  assert.equal(history.numOrNull(null), null);
  assert.equal(history.numOrNull("12.5"), 12.5);
  assert.equal(history.numOrNull("bad"), null);
});
