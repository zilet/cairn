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

// ---- sessionHeadHtml: the W4.2 purpose line ----

const sessionHeadDeps = { escapeHtml: escHtml, cardioLabel: () => "", cardioPrescription: () => "" };

test("sessionHeadHtml renders the day's purpose as a quiet line under the title, escaped", () => {
  const surface = loadTodayPlanSurface();

  const html = surface.sessionHeadHtml(
    {
      isRunDay: false,
      isToday: true,
      cardioItems: [],
      day: { name: "Lower body", focus: "Squat", purpose: "part of the block's <base>-building work" },
      exDone: 0,
      exTotal: 4,
      hasSyncedCardioToday: false,
    },
    sessionHeadDeps,
  );

  assert.match(html, /class="session-purpose">part of the block's &lt;base&gt;-building work<\/p>/);
});

test("sessionHeadHtml renders no purpose line when the program state couldn't ground one", () => {
  const surface = loadTodayPlanSurface();

  const html = surface.sessionHeadHtml(
    {
      isRunDay: false,
      isToday: true,
      cardioItems: [],
      day: { name: "Lower body", focus: "Squat", purpose: null },
      exDone: 0,
      exTotal: 4,
      hasSyncedCardioToday: false,
    },
    sessionHeadDeps,
  );

  assert.doesNotMatch(html, /session-purpose/);
});

// ---- daySwitchHtml: the pill that says what it is offering before it is tapped ----

const PLAN = [
  { day_number: 1, name: "Upper A" },
  { day_number: 4, name: "Lower B" },
];

test("daySwitchHtml captions and dims a day whose work is mostly still recovering", () => {
  const surface = loadTodayPlanSurface();

  const html = surface.daySwitchHtml(PLAN, 1, { escapeHtml: escHtml }, {
    4: { recovering_groups: ["quads", "hamstrings", "calves"], mostly_recovering: true },
  });

  assert.match(html, /class="daybtn recovering" data-day="4"/);
  assert.match(html, /<span class="daybtn-cap">legs recovering<\/span>/);
  // A hint, never a gate: the pill keeps every affordance it had.
  assert.doesNotMatch(html, /disabled/);
  // The day that is fine says nothing at all.
  assert.match(html, /class="daybtn active" data-day="1">1 · Upper A<\/button>/);
});

test("daySwitchHtml names the areas when they are not all legs, and escapes them", () => {
  const surface = loadTodayPlanSurface();

  const html = surface.daySwitchHtml(PLAN, 4, { escapeHtml: escHtml }, {
    4: { recovering_groups: ["chest", "<b>rear delts</b>"], mostly_recovering: true },
  });

  assert.match(html, /chest and &lt;b&gt;rear delts&lt;\/b&gt; recovering/);
  assert.doesNotMatch(html, /<b>rear delts<\/b>/);
});

test("daySwitchHtml renders the plain pills when no recovery read is available", () => {
  const surface = loadTodayPlanSurface();

  const bare = surface.daySwitchHtml(PLAN, 1, { escapeHtml: escHtml });
  const empty = surface.daySwitchHtml(PLAN, 1, { escapeHtml: escHtml }, {
    4: { recovering_groups: ["quads"], mostly_recovering: false },
  });

  assert.equal(bare, empty);
  assert.doesNotMatch(bare, /daybtn-cap|recovering/);
});
