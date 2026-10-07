// Client-side rendering of the guided recovery menu (Track D). Same vm-load
// harness as test/clientTodayBrief.test.js — rebuild the client
// (npm run client:build) before running this file directly.
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

function loadTodayBrief() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    escHtml,
    escAttr,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-run-leg-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-signals-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

const RECOVERY = {
  line: "If you feel like moving, any of these counts — none of them is required.",
  options: [
    { label: "Easy spin", detail: "Zone 1 pace, 20–30 minutes.", minutes: 25 },
    { label: "Mobility", detail: "10–15 minutes for your hips and hamstrings.", minutes: 12 },
  ],
};

test("Today Brief renders the recovery menu on a rest day with escaped content", () => {
  const brief = loadTodayBrief();
  const hostileRecovery = {
    line: "Take it easy <script>alert(1)</script> today.",
    options: [{ label: "Easy <spin>", detail: "20 min & <b>chill</b>", minutes: 20 }],
  };
  const html = brief.briefHtml(
    { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {}, recovery: hostileRecovery },
    { isToday: true }
  );

  assert.match(html, /brief-recovery/);
  assert.match(html, /brief-recovery-line/);
  assert.match(html, /brief-recovery-opt/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /Easy <spin>/);
  assert.doesNotMatch(html, /20 min & <b>/);
  assert.match(html, /Easy &lt;spin&gt;/);
  assert.match(html, /20 min &amp; &lt;b&gt;chill&lt;\/b&gt;/);
  assert.match(html, /brief-recovery-opt-mins">· 20 min<\/span>/, "renders the option's minutes");
});

test("Today Brief recovery options are tappable and carry their own request", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {}, recovery: RECOVERY },
    { isToday: true }
  );

  // Each option is a real button, not a div — one tap asks for exactly this
  // session. The label/minutes/detail ride on the element so the handler never has
  // to parse the rendered copy back into a request.
  assert.match(html, /<button type="button" class="brief-recovery-opt"/);
  assert.match(html, /data-recovery-opt="Mobility"/);
  assert.match(html, /data-recovery-min="12"/);
  assert.match(html, /data-recovery-detail="10–15 minutes for your hips and hamstrings\."/);
  assert.equal((html.match(/data-recovery-opt=/g) || []).length, 2, "every option is tappable");
});

test("Today Brief recovery option with no minutes omits the minutes hook", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "rest",
      headline: "Rest today",
      why: "Nothing stacked up.",
      signals: {},
      recovery: { line: "Only if you feel like it.", options: [{ label: "Mobility", detail: "As long as you like.", minutes: null }] },
    },
    { isToday: true }
  );
  assert.match(html, /data-recovery-opt="Mobility"/);
  assert.doesNotMatch(html, /data-recovery-min=/);
});

test("Today Brief renders no recovery menu on an easy day when the read carries none", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "easy", headline: "Easy today", why: "Keep it light.", signals: {} },
    { isToday: true }
  );
  assert.doesNotMatch(html, /brief-recovery/);
});

test("Today Brief never renders a recovery menu on a train day even if the payload carries one", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "train", headline: "Push day", why: "Recovered and ready.", signals: {}, recovery: RECOVERY },
    { isToday: true }
  );
  assert.doesNotMatch(html, /brief-recovery/);
});

test("todayBriefMateriallyDiffers is true when only the recovery menu changed", () => {
  const brief = loadTodayBrief();
  const base = { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {} };
  const a = { ...base, recovery: RECOVERY };
  const b = { ...base, recovery: { ...RECOVERY, options: [RECOVERY.options[0]] } };

  assert.equal(brief.materiallyDiffers(a, a), false);
  assert.equal(brief.materiallyDiffers(a, b), true);
});

const RUN_LEG = {
  line: "You've already run today, and Lower <A> is mostly legs. Want to shift it?",
  options: [
    { key: "upper", label: "Upper instead", focus: "upper body", constraints: "already ran today — spare the legs" },
    { key: "lighter", label: "Lighter legs", focus: "Squat & quads", constraints: "already ran today — lighter leg session" },
    { key: "rest", label: "Rest", focus: null, constraints: null },
  ],
};

test("todayBriefMateriallyDiffers is true when only the run-before-leg-day choice changed", () => {
  const brief = loadTodayBrief();
  const base = { kind: "train", headline: "Today", why: "", signals: {} };
  assert.equal(brief.materiallyDiffers(base, { ...base, run_leg_choice: RUN_LEG }), true);
  assert.equal(brief.materiallyDiffers({ ...base, run_leg_choice: RUN_LEG }, { ...base, run_leg_choice: RUN_LEG }), false);
});

// A session accepted on another device changes only the lift line; a cached Brief
// that ignored it kept printing the plan day over the choice.
test("todayBriefMateriallyDiffers is true when only the strength line changed", () => {
  const brief = loadTodayBrief();
  const base = { kind: "train", headline: "Today", why: "", signals: {} };
  const plan = { ...base, strength_line: { text: "Run in · Squat & quads still open" } };
  const chosen = { ...base, strength_line: { text: "Run in · Upper Body & Core still open" } };
  assert.equal(brief.materiallyDiffers(plan, chosen), true);
  assert.equal(brief.materiallyDiffers(chosen, { ...chosen }), false);
});

test("Today Brief offers the run-before-leg-day choice today, escaped, on any read kind", () => {
  const brief = loadTodayBrief();
  for (const kind of ["train", "easy", "done"]) {
    const html = brief.briefHtml({ kind, headline: "Today", why: "", signals: {}, run_leg_choice: RUN_LEG }, { isToday: true });
    assert.match(html, /brief-runleg/, `kind=${kind}`);
    assert.match(html, /Lower &lt;A&gt; is mostly legs/);
    assert.match(html, /data-runleg="upper" data-runleg-focus="upper body" data-runleg-constraints="already ran today — spare the legs"/);
    assert.match(html, /data-runleg="lighter" data-runleg-focus="Squat &amp; quads"/);
    assert.match(html, /data-override="rest — already ran today, my legs need the recovery"/);
  }
});

test("Today Brief hides the run-before-leg-day choice on another day or when the server sends none", () => {
  const brief = loadTodayBrief();
  const read = { kind: "train", headline: "Today", why: "", signals: {}, run_leg_choice: RUN_LEG };
  assert.doesNotMatch(brief.briefHtml(read, { isToday: false }), /brief-runleg/);
  assert.doesNotMatch(brief.briefHtml({ ...read, run_leg_choice: null }, { isToday: true }), /brief-runleg/);
});
