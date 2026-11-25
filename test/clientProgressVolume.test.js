import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadVolume() {
  const context = { Object, String, Set };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-volume-client.js"), "utf8"), context);
  return context.CairnProgressVolume;
}

test("progress volume balance renders calm chips safely", () => {
  const volume = loadVolume();
  const html = volume.volBalanceHtml({
    groups: [{ group: "core" }, { group: "quads" }],
    due: ["hamstrings", "back", "chest", "shoulders", "biceps<script>"],
    over: ["calves"],
    broad_low: true,
    summary: "Volume is light <overall>",
  });

  assert.match(html, /Balance/);
  assert.match(html, /Volume is light &lt;overall&gt;/);
  assert.match(html, /Hamstrings/);
  assert.match(html, /\+1 more/);
  assert.match(html, /Calves/);
  assert.match(html, />grip</);
  assert.doesNotMatch(html, /<overall>|<script>/);
  assert.equal(volume.capWord("forearms"), "Forearms");
});

test("progress volume balance stays quiet with no meaningful read", () => {
  const volume = loadVolume();

  assert.equal(volume.volBalanceHtml(null), "");
  assert.equal(volume.volBalanceHtml({ groups: [] }), "");
  assert.equal(volume.volBalanceHtml({ groups: [{ group: "core" }, { group: "forearms" }] }), "");
});

test("progress volume footnote prints the server's sentence, escaped, only when present", () => {
  const volume = loadVolume();
  const html = volume.ungroupedNoteHtml({ ungrouped_note: "Sled Push (5 sets) is not filed yet." });
  assert.match(html, /class="vol-ungrouped"/);
  assert.match(html, /Sled Push \(5 sets\) is not filed yet\./);
  assert.match(volume.ungroupedNoteHtml({ ungrouped_note: "<b>x</b>" }), /&lt;b&gt;x&lt;\/b&gt;/);
  assert.equal(volume.ungroupedNoteHtml({ ungrouped_note: null }), "");
  assert.equal(volume.ungroupedNoteHtml({}), "");
  assert.equal(volume.ungroupedNoteHtml(null), "");
});
