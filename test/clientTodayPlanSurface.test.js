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

function loadTodayPlanSurface() {
  const context = { Object, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-client.js"), "utf8"), context);
  return context.CairnTodayPlanSurface;
}

// ---- lastSetLineHtml: the quiet "Last time: …" target line beside a not-yet-logged row ----

test("lastSetLineHtml wraps the formatted text in .ex-lastset and escapes it", () => {
  const surface = loadTodayPlanSurface();

  const html = surface.lastSetLineHtml(
    { weight: 165, reps: 10 },
    { escapeHtml: escHtml, lastSetLineText: () => "Last time: 165 × 10 · 3 days ago" },
  );

  assert.equal(html, '<div class="ex-lastset">Last time: 165 × 10 · 3 days ago</div>');
});

test("lastSetLineHtml escapes text coming from lastSetLineText", () => {
  const surface = loadTodayPlanSurface();

  const html = surface.lastSetLineHtml(
    {},
    { escapeHtml: escHtml, lastSetLineText: () => "Last time: <b>165</b> × 10" },
  );

  assert.match(html, /Last time: &lt;b&gt;165&lt;\/b&gt; × 10/);
  assert.doesNotMatch(html, /<b>165<\/b>/);
});

test("lastSetLineHtml renders nothing when there's no last-set text", () => {
  const surface = loadTodayPlanSurface();

  assert.equal(surface.lastSetLineHtml(null, { escapeHtml: escHtml, lastSetLineText: () => "" }), "");
  assert.equal(surface.lastSetLineHtml({ weight: 1, reps: 1 }, { escapeHtml: escHtml, lastSetLineText: () => "" }), "");
});

test("lastSetLineHtml renders nothing when the lastSetLineText dep isn't wired yet", () => {
  const surface = loadTodayPlanSurface();

  // Callers of planSurface() that haven't threaded lastSetLineText through yet still
  // typecheck (it's optional on TodayPlanSurfaceDeps) and get a clean no-render.
  assert.equal(surface.lastSetLineHtml({ weight: 165, reps: 10 }, { escapeHtml: escHtml }), "");
});
