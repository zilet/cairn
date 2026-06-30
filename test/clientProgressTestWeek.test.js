import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadTestWeekClient() {
  const context = { Object, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-test-week-client.js"), "utf8"), context);
  return context;
}

test("progress test week banner renders safely", () => {
  const context = loadTestWeekClient();
  const testWeek = context.CairnProgressTestWeek;
  const html = testWeek.testWeekBannerHtml({
    due: true,
    why: "Heavy set data is stale <old>",
    key_lifts: ["Squat <bar>", "", "Deadlift <pull>"],
  });

  assert.match(html, /A test week is about due/);
  assert.match(html, /Heavy set data is stale &lt;old&gt;/);
  assert.match(html, /Squat &lt;bar&gt;/);
  assert.match(html, /Deadlift &lt;pull&gt;/);
  assert.doesNotMatch(html, /<old>|<bar>|<pull>/);
});

test("progress test week banner handles empty reads", () => {
  const context = loadTestWeekClient();
  const testWeek = context.CairnProgressTestWeek;

  assert.equal(testWeek.testWeekBannerHtml(null), "");
  assert.match(testWeek.testWeekBannerHtml({ due: true, key_lifts: [] }), /A test week is about due/);
});

test("progress test week loader hydrates and clears the slot", async () => {
  const context = loadTestWeekClient();
  const slot = { isConnected: true, innerHTML: "old" };
  context.state = { tab: "progress", progressSeg: "program" };
  context.view = {
    querySelector(selector) {
      return selector === "#progTestSlot" ? slot : null;
    },
  };
  context.api = async () => ({ due: true, why: "Retest <soon>", key_lifts: ["Bench <press>"] });

  await context.CairnProgressTestWeek.loadTestWeek();

  assert.match(slot.innerHTML, /Retest &lt;soon&gt;/);
  assert.match(slot.innerHTML, /Bench &lt;press&gt;/);

  context.api = async () => ({ due: false });
  await context.CairnProgressTestWeek.loadTestWeek();
  assert.equal(slot.innerHTML, "");
});
