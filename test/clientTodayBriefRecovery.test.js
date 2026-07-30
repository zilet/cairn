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
