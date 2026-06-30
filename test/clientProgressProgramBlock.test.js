import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgramBlockClient() {
  const context = {
    JSON,
    Number,
    Object,
    String,
    phaseWord(phase) {
      return phase === "base" ? "Base" : String(phase || "");
    },
    swrInvalidate() {},
    toast() {},
    armDelete(_button, onConfirm) {
      onConfirm();
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-program-block-client.js"), "utf8"), context);
  return context;
}

test("progress program block renders active block safely", () => {
  const context = loadProgramBlockClient();
  const blocks = context.CairnProgressProgramBlock;
  const html = blocks.activeBlockHtml({
    id: '42" onclick="bad',
    focus: "strength",
    phase: "base",
    week_index: 2,
    total_weeks: 5,
    goal: "Build squat <goal>",
  });

  assert.match(html, /Current block/);
  assert.match(html, /week 2 of 5/);
  assert.match(html, /Build squat &lt;goal&gt;/);
  assert.match(html, /Strength · Base/);
  assert.match(html, /data-blockadvance="42&quot; onclick=&quot;bad"/);
  assert.doesNotMatch(html, /<goal>|onclick="bad/);
});

test("progress program block start composer renders expected controls", () => {
  const context = loadProgramBlockClient();
  const blocks = context.CairnProgressProgramBlock;

  assert.equal(blocks.blockFocusWord("hypertrophy"), "Hypertrophy");
  assert.equal(blocks.blockFocusWord("endurance-base"), "Endurance base");
  assert.equal(blocks.blockFocusWord("unknown"), "unknown");

  const html = blocks.startBlockHtml();
  assert.match(html, /data-blockstart/);
  assert.match(html, /data-blockcreate/);
  assert.match(html, /value="strength"/);
  assert.match(html, /value="peak"/);
});

test("progress program block loader hydrates active and start states", async () => {
  const context = loadProgramBlockClient();
  const slot = {
    isConnected: true,
    innerHTML: "",
    querySelector() {
      return null;
    },
  };
  context.state = { tab: "progress" };
  context.view = {
    querySelector(selector) {
      return selector === "#progBlockSlot" ? slot : null;
    },
  };
  context.api = async () => ({
    id: 1,
    focus: "hypertrophy",
    phase: "base",
    week_index: 1,
    total_weeks: 4,
    goal: "Grow <safe>",
  });

  await context.CairnProgressProgramBlock.loadProgramBlock();
  assert.match(slot.innerHTML, /Grow &lt;safe&gt;/);
  assert.match(slot.innerHTML, /Hypertrophy · Base/);

  context.api = async () => null;
  await context.CairnProgressProgramBlock.loadProgramBlock();
  assert.match(slot.innerHTML, /data-blockstart/);
});
