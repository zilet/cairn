import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the weekly/connection card module (an IIFE that publishes its surface on
// globalThis.CairnCaptureReadCards) into a shared VM context, the way it runs in
// the bundle. Run `npm run client:build` first — these load the BUILT output.
function loadCards() {
  const esc = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const context = {
    Array,
    Boolean,
    Date,
    Intl,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    document: { querySelectorAll: () => [] },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-cards-client.js"), "utf8"), context);
  context.__esc = esc;
  return context;
}

// The agentic weekly read + a fully-populated team-week digest (every section,
// including a connections/insights entry we expect the weekly card to DROP).
function weeklyIns(overrides = {}) {
  return {
    id: 7,
    kind: "weekly_read",
    text: "Solid week — training held while the cut kept moving.",
    next_step: "Add one easy aerobic day.",
    rationale: "Recovery had room to spare.",
    status: "seen",
    created_at: "2026-07-14T00:00:00Z",
    ...overrides,
  };
}

function teamFixture() {
  return {
    lead: "Your team kept the plan steady.",
    did: [{ domain: "training", label: "Training", changes: [{ text: "held squat volume", specialist: "strength" }] }],
    flagged: [{ text: "A lipid recheck is due." }],
    watching: [{ text: "Sleep through the travel week.", through: "2026-07-20" }],
    landed: [{ text: "The deload landed as expected.", verdict: "aligned" }],
    insights: [{ text: "Sleep dips track your mileage ramps." }],
  };
}

function makeTarget(ifbButtons = []) {
  let html = "";
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value);
    },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === "[data-ifb]" ? ifbButtons : []),
  };
}

function makeButton(ifb) {
  const button = { dataset: { ifb }, _click: null };
  button.addEventListener = (_evt, cb) => {
    button._click = cb;
  };
  return button;
}

function baseDeps(ctx, calls) {
  return {
    api: (path, opts) => {
      calls.push({ path, opts });
      return Promise.resolve({});
    },
    toast: () => {},
    collapseEl: (_el, done) => {
      if (done) done();
    },
    escapeHtml: ctx.__esc,
    weekRangeLabel: () => "Jul 8–14",
  };
}

test("weekly default card folds the team detail and drops the connections section", () => {
  const ctx = loadCards();
  const target = makeTarget();
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(target, weeklyIns(), baseDeps(ctx, []), teamFixture());
  const html = target.innerHTML;
  // HERO: the read + the one change well are present.
  assert.match(html, /weekly-text/);
  assert.match(html, /One change/);
  // DEPTH: the team-week detail sits behind a native, COLLAPSED fold.
  assert.match(html, /<details class="weekly-depth"/);
  const openTag = /<details[^>]*>/.exec(html)[0];
  assert.doesNotMatch(openTag, /\bopen\b/);
  assert.match(html, /Week in review/); // a real team section lives in the fold
  // The connections section (and its text) is removed — the #insightSlot card owns it.
  assert.doesNotMatch(html, /Connections worth a look/);
  assert.doesNotMatch(html, /Sleep dips track your mileage ramps/);
});

test("weekly acked variant is compact — quiet line + One change chip, no full read", () => {
  const ctx = loadCards();
  const target = makeTarget();
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(target, weeklyIns({ feedback: "up" }), baseDeps(ctx, []), teamFixture());
  const html = target.innerHTML;
  assert.match(html, /weekly-acked/);
  assert.match(html, /The week, read/);
  // The One change persists as a lasting chip.
  assert.match(html, /Add one easy aerobic day/);
  assert.match(html, /data-weekly-expand/); // re-expand affordance for the current view
  // The full agentic read is NOT rendered in the compact state.
  assert.doesNotMatch(html, /Solid week/);
  assert.doesNotMatch(html, /weekly-text/);
});

test("weeklyFeedbackBody: 'Got it' acknowledges (up + seen), 'Not useful' dismisses (down + dismissed)", () => {
  const ctx = loadCards();
  // Round-trip through JSON so the VM realm's Object prototype doesn't trip strict deepEqual.
  const body = (dir) => JSON.parse(JSON.stringify(ctx.CairnCaptureReadCards.weeklyFeedbackBody(dir)));
  assert.deepEqual(body("up"), { feedback: "up", status: "seen" });
  assert.deepEqual(body("down"), { feedback: "down", status: "dismissed" });
  // Any non-up path is the "Not useful" dismissal (defensive default).
  assert.deepEqual(body(undefined), { feedback: "down", status: "dismissed" });
});

test("'Got it' wiring PUTs up+seen and settles to the compact card (not dismissed)", () => {
  const ctx = loadCards();
  const calls = [];
  const up = makeButton("up");
  const target = makeTarget([up, makeButton("down")]);
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(target, weeklyIns(), baseDeps(ctx, calls), teamFixture());
  up._click();
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/insights\/7$/);
  assert.equal(calls[0].opts.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { feedback: "up", status: "seen" });
  // The card persists compactly rather than being destroyed for the week.
  assert.match(target.innerHTML, /weekly-acked/);
});

test("'Not useful' wiring PUTs down+dismissed and clears the card for the week", () => {
  const ctx = loadCards();
  const calls = [];
  const down = makeButton("down");
  const target = makeTarget([makeButton("up"), down]);
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(target, weeklyIns(), baseDeps(ctx, calls), teamFixture());
  down._click();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { feedback: "down", status: "dismissed" });
  assert.equal(target.innerHTML, "");
});

// ---- staleness (pull-only "Moved on" affordance) ----

// A target that also serves the re-read control so we can assert its wiring.
function makeStaleTarget(rereadBtn) {
  let html = "";
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value);
    },
    querySelector: (sel) => (sel === "[data-weekly-reread]" ? rereadBtn : null),
    querySelectorAll: () => [],
  };
}

test("stale weekly card shows the Moved-on note + re-read tap in place of the one change", () => {
  const ctx = loadCards();
  const target = makeStaleTarget(null);
  const stale = weeklyIns({
    stale: true,
    stale_note: "This was the week's read when it was written — your training has moved since.",
    next_step: null, // the server defangs the one change when stale
  });
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(target, stale, baseDeps(ctx, []), teamFixture());
  const html = target.innerHTML;
  assert.match(html, /weekly-card-stale/);
  assert.match(html, /weekly-stale-chip/);
  assert.match(html, /Moved on/);
  assert.match(html, /your training has moved since/);
  assert.match(html, /data-weekly-reread/);
  // The stale read no longer asserts a "One change" action.
  assert.doesNotMatch(html, /One change/);
});

test("stale takes precedence over the acked-compact form (re-read stays reachable)", () => {
  const ctx = loadCards();
  const target = makeStaleTarget(null);
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(
    target,
    weeklyIns({ feedback: "up", stale: true, stale_note: "Things moved.", next_step: null }),
    baseDeps(ctx, []),
    teamFixture(),
  );
  const html = target.innerHTML;
  assert.doesNotMatch(html, /weekly-acked/); // not the settled compact line
  assert.match(html, /weekly-stale/);
  assert.match(html, /data-weekly-reread/);
});

test("re-read tap invokes deps.rereadWeekly", () => {
  const ctx = loadCards();
  const rereadBtn = makeButton("reread");
  const target = makeStaleTarget(rereadBtn);
  let rereadCalls = 0;
  const deps = { ...baseDeps(ctx, []), rereadWeekly: () => (rereadCalls += 1) };
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(
    target,
    weeklyIns({ stale: true, stale_note: "Moved.", next_step: null }),
    deps,
    teamFixture(),
  );
  rereadBtn._click();
  assert.equal(rereadCalls, 1);
});

test("a fresh (non-stale) weekly card renders normally with no Moved-on affordance", () => {
  const ctx = loadCards();
  const target = makeStaleTarget(null);
  ctx.CairnCaptureReadCards.renderWeeklyInSlot(target, weeklyIns(), baseDeps(ctx, []), teamFixture());
  const html = target.innerHTML;
  assert.doesNotMatch(html, /weekly-card-stale/);
  assert.doesNotMatch(html, /Moved on/);
  assert.doesNotMatch(html, /data-weekly-reread/);
  assert.match(html, /One change/);
});
