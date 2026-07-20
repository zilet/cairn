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

function loadTodaySessionSuggest() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    escHtml,
    escAttr,
    fmtDur: (seconds) => `${seconds}s`,
    stagger: (index) => `--i:${index}`,
    art: (kind, text) => `<svg data-art="${escAttr(kind)}:${escAttr(text)}"></svg>`,
    artImg: (kind, text, className, svg) =>
      `<span class="${escAttr(className)}" data-kind="${escAttr(kind)}" data-text="${escAttr(text)}">${svg || ""}</span>`,
    CairnProposal: {
      verifiedBadgeHtml: (verified) => verified ? `<span class="verified">${escHtml(JSON.stringify(verified))}</span>` : "",
    },
    CairnUi: {
      jobCaptionHtml: ({ tag = "div", className = "job-cap" } = {}) => `<${tag} class="${className}"></${tag}>`,
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-suggest-client.js"), "utf8"), context);
  return context.CairnTodaySessionSuggest;
}

test("Today session suggestion card renders escaped suggested items", () => {
  const suggest = loadTodaySessionSuggest();
  const html = suggest.cardHtml({
    name: "Upper <pull>",
    focus: "Rows & rear delts",
    why: "fresh enough <today>",
    est_minutes: 38.4,
    notes: "Keep one rep <in reserve>",
    items: [
      { exercise: "Pull-up <assisted>", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30, note: "smooth reps <only>" },
      { exercise: "Dead hang", mode: "timed", sets: 2, target_seconds: 45 },
      { exercise: "Push-up", sets: 2, rep_low: 12, rep_high: 12, target_weight: null },
    ],
  }, { checked: true, adjustments: ["protein <floor>"] });

  assert.match(html, /A session for today · 38 min/);
  assert.match(html, /Upper &lt;pull&gt;/);
  assert.match(html, /Rows &amp; rear delts/);
  assert.match(html, /fresh enough &lt;today&gt;/);
  assert.match(html, /Pull-up &lt;assisted&gt;/);
  assert.match(html, /3 × 6–8 · 30 assist/);
  assert.match(html, /2 × 45s/);
  assert.match(html, /2 × 12 · BW/);
  assert.match(html, />Use this session</);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, />Log these</);
  assert.match(html, /protein &lt;floor&gt;/);
  assert.doesNotMatch(html, /Upper <pull>|smooth reps <only>|protein <floor>/);
});

test("Today session suggestion helper renders empty, loading, failure, and composer states", () => {
  const suggest = loadTodaySessionSuggest();

  assert.match(suggest.cardHtml({ items: [] }), /No exercises came back/);
  assert.match(suggest.loadingHtml(), /sug-loading/);
  assert.match(suggest.loadingHtml(), /job-cap/);
  assert.match(suggest.failureHtml({ agent_status: "unconfigured" }), /connect one in Settings/);
  assert.match(suggest.failureHtml({}), /may be offline/);

  const composer = suggest.composerHtml(["low <impact>", "30 min"]);
  assert.match(composer, /aria-label="Describe the session you want"/);
  assert.match(composer, /data-vibe="low &lt;impact&gt;"/);
  assert.match(composer, /low &lt;impact&gt;/);
  assert.doesNotMatch(composer, /low <impact>/);
  assert.equal(JSON.stringify(suggest.SESSION_VIBES.slice(0, 2)), JSON.stringify(["easier on the legs", "30 min"]));
});
