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
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

const RECOVERY = {
  line: "If you feel like moving, any of these counts — none of them is required.",
  options: [
    { label: "Easy spin", detail: "Zone 1 pace, 20–30 minutes.", minutes: 25 },
    { label: "Mobility", detail: "10–15 minutes for your hips and hamstrings.", minutes: 12 },
  ],
};

test("Today Brief renders a quiet rest line and never consolation-workout options", () => {
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
  assert.match(html, /Take it easy &lt;script&gt;alert\(1\)&lt;\/script&gt; today\./);
  assert.doesNotMatch(html, /brief-recovery-opt|data-recovery-opt/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /Easy <spin>|Easy &lt;spin&gt;/);
});

test("Today Brief rest recovery options are not the one action", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {}, recovery: RECOVERY },
    { isToday: true }
  );

  assert.match(html, /brief-recovery-line/);
  assert.doesNotMatch(html, /brief-recovery-opt|data-recovery-opt/);
});

test("Today Brief recovery option payload never becomes a tap target", () => {
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
  assert.match(html, /Only if you feel like it\./);
  assert.doesNotMatch(html, /data-recovery-opt|data-recovery-min/);
});

test("Today Brief renders no recovery menu on an easy day when the read carries none", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "easy", headline: "Easy today", why: "Keep it light.", signals: {} },
    { isToday: true }
  );
  assert.doesNotMatch(html, /brief-recovery/);
});

test("Today Brief never renders a recovery menu on an easy or train day even if the payload carries one", () => {
  const brief = loadTodayBrief();
  const easy = brief.briefHtml(
    { kind: "easy", headline: "Easy today", why: "Keep it light.", signals: {}, recovery: RECOVERY },
    { isToday: true }
  );
  const train = brief.briefHtml(
    { kind: "train", headline: "Push day", why: "Recovered and ready.", signals: {}, recovery: RECOVERY },
    { isToday: true }
  );
  assert.doesNotMatch(easy, /brief-recovery/);
  assert.doesNotMatch(train, /brief-recovery/);
});

test("todayBriefMateriallyDiffers tracks the rest line, not a consolation menu", () => {
  const brief = loadTodayBrief();
  const base = { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {} };
  const a = { ...base, recovery: RECOVERY };
  const b = { ...base, recovery: { ...RECOVERY, options: [RECOVERY.options[0]] } };
  const c = { ...base, recovery: { ...RECOVERY, line: "A quieter rest line." } };

  assert.equal(brief.materiallyDiffers(a, a), false);
  assert.equal(brief.materiallyDiffers(a, b), false, "unrendered consolation options are not content");
  assert.equal(brief.materiallyDiffers(a, c), true);
});
