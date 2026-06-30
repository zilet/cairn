import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadMemoryClient() {
  const context = {
    Object,
    String,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/memory-client.js"), "utf8"), context);
  return context.CairnMemory;
}

test("memory helper renders kind options with optional selection", () => {
  const memory = loadMemoryClient();

  assert.equal(JSON.stringify(memory.MEM_KINDS), '["note","preference","constraint","goal","fact"]');
  const html = memory.memoryKindOptionsHtml("goal");
  assert.match(html, /value="goal" selected/);
  assert.match(html, /value="preference"/);
});

test("memory row renderer escapes remembered content and keeps controls stable", () => {
  const memory = loadMemoryClient();
  const html = memory.memoryRowHtml(
    {
      id: '7" onclick="bad',
      kind: "preference <food>",
      created_at: "2026-06-30T10:11:12.000Z",
      source: "agent <learned>",
      content: "I prefer salmon <after runs>",
    },
    3,
  );

  assert.match(html, /class="memrow reveal"/);
  assert.match(html, /style="--i:3"/);
  assert.match(html, /data-mem="7&quot; onclick=&quot;bad"/);
  assert.match(html, /preference &lt;food&gt;/);
  assert.match(html, /2026-06-30 · agent &lt;learned&gt;/);
  assert.match(html, /I prefer salmon &lt;after runs&gt;/);
  assert.match(html, /data-memedit/);
  assert.match(html, /data-memdel/);
  assert.doesNotMatch(html, /<food>|<learned>|<after runs>|onclick="bad/);
});
