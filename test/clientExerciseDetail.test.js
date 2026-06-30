import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

function loadExerciseDetail() {
  const context = { Object, String, RegExp, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/exercise-detail-client.js"), "utf8"), context);
  return context.CairnExerciseDetail;
}

test("exercise detail explanation picks deterministic movement cues", () => {
  const detail = loadExerciseDetail();

  assert.match(detail.explanation({ name: "Romanian Deadlift" }).move, /Push the hips back/);
  assert.match(detail.explanation({ name: "Cable Row" }).feel, /Mid-back and lats/);
  assert.match(detail.explanation({ muscle_group: "posterior chain" }).setup, /Soft knees/);
  assert.match(detail.explanation({ name: "Unknown movement" }).move, /Move deliberately/);
});

test("exercise detail explanation HTML escapes exercise names and rows", () => {
  const detail = loadExerciseDetail();
  const html = detail.explanationHtml(
    { name: `Press "heavy" <unsafe>` },
    {
      setup: `Brace <ribs>`,
      move: `Press & pause`,
      feel: `Shoulders > ego`,
      avoid: `No "pinch"`,
    }
  );

  assert.match(html, /class="detail-section ex-explain"/);
  assert.match(html, /data-exercise="Press &quot;heavy&quot; &lt;unsafe&gt;"/);
  assert.match(html, /Brace &lt;ribs&gt;/);
  assert.match(html, /Press &amp; pause/);
  assert.match(html, /Shoulders &gt; ego/);
  assert.match(html, /No "pinch"/);
  assert.doesNotMatch(html, /<unsafe>|<ribs>/);
});

test("exercise detail validates agent explanation payloads conservatively", () => {
  const detail = loadExerciseDetail();

  assert.equal(detail.validExplanationPayload(null), false);
  assert.equal(detail.validExplanationPayload({ ok: true, explanation: { setup: "set", move: "move" } }), false);
  assert.equal(detail.validExplanationPayload({ ok: false, explanation: { setup: "set", move: "move", feel: "feel" } }), false);
  assert.equal(detail.validExplanationPayload({ ok: true, explanation: { setup: "set", move: "move", feel: "feel" } }), true);
});
