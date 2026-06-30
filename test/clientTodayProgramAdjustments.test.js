import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escAttr(value) {
  return escHtml(value).replaceAll('"', "&quot;");
}

function loadTodayProgramAdjustments() {
  const context = { Array, Math, Object, RegExp, String, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-program-adjustments-client.js"), "utf8"), context);
  return context.CairnTodayProgramAdjustments;
}

test("Today program adjustments render rail card safely with collapsed extras", () => {
  const adjustments = loadTodayProgramAdjustments();
  const rows = [
    { kind: "gap", title: "Core <gap>", why: "Low <volume>", group: "core", suggestions: ["Plank <hard>", "Carry"] },
    { kind: "balance", title: "Chest running high", why: "Pressing stacked up", group: "chest" },
    { kind: "balance", title: "Quads are light", group: "quads", programmed: true, suggestions: ["Back squat", "Split squat"] },
    { kind: "deload", title: "Ease squat", exercise: "Back squat <heavy>" },
    { recovering: true, title: "Hamstrings recovering", group: "hamstrings" },
  ];

  const html = adjustments.bannerHtml(rows);
  assert.match(html, /What changed/);
  assert.match(html, /id="adjustAll"/);
  assert.match(html, /Core &lt;gap&gt;/);
  assert.match(html, /Low &lt;volume&gt;/);
  assert.match(html, /Plank &lt;hard&gt;/);
  assert.match(html, /In your plan/);
  assert.match(html, /Plan around it →/);
  assert.match(html, /adjust-extra/);
  assert.match(html, /\+2 more in your program/);
  assert.match(html, /data-req="Add some core work to my plan \(e.g. Plank &lt;hard&gt;, Carry\)/);
  assert.match(html, /data-req="Ease off Back squat &lt;heavy&gt; next session/);
  assert.doesNotMatch(html, /Core <gap>|Low <volume>|Plank <hard>|Back squat <heavy>/);
  assert.equal(adjustments.extraCount(rows), 2);
});

test("Today program adjustment plan requests preserve coach intent", () => {
  const adjustments = loadTodayProgramAdjustments();

  assert.match(adjustments.planRequest({ recovering: true, group: "quads" }), /Plan my next session around fresher muscles/);
  assert.match(adjustments.planRequest({ kind: "gap", group: "core", suggestions: ["carry"] }), /Add some core work/);
  assert.match(
    adjustments.planRequest({ kind: "balance", group: "quads", programmed: true, suggestions: ["Squat"] }),
    /don't add more quads work/
  );
  assert.match(
    adjustments.planRequest({ kind: "progression", title: "Rotate bench", exercise: "Bench press" }),
    /Rotate Bench press/
  );
  assert.equal(adjustments.planRequest(null), "Help me adjust my plan.");
  assert.equal(adjustments.bannerHtml([]), "");
});
