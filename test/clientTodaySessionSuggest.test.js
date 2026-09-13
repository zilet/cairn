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
      { exercise: "Push-up", sets: 2, rep_low: 12, rep_high: 12, target_weight: null, load_basis: "bodyweight" },
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

test("open load prints nothing, bodyweight still prints BW, and a top_set shares one tile", () => {
  const suggest = loadTodaySessionSuggest();
  const html = suggest.cardHtml({
    name: "Pull",
    why: "A re-test day.",
    items: [
      {
        exercise: "Barbell Bent-Over Row",
        sets: 2,
        rep_low: 6,
        rep_high: 6,
        target_weight: 135,
        load_basis: "loaded",
        top_set: { sets: 1, reps: 3, rir: 1, note: "one strong triple" },
      },
    ],
  });

  assert.match(html, /1 × 3 top set · RIR 1/);
  assert.match(html, /2 × 6 · 135 lb/);
  assert.match(html, /one strong triple/);
  assert.equal((html.match(/class="sug-item /g) || []).length, 1, "top set + back-off share one tile");
  assert.equal((html.match(/sug-item-name/g) || []).length, 1);

  const openHtml = suggest.itemHtml({
    exercise: "Cable Row",
    sets: 3,
    rep_low: 8,
    rep_high: 10,
    target_weight: null,
    load_basis: "open",
  });
  assert.match(openHtml, /3 × 8–10/);
  assert.doesNotMatch(openHtml, /BW/);

  const bwHtml = suggest.itemHtml({
    exercise: "Neutral-Grip Pull-Up",
    sets: 3,
    rep_low: 6,
    rep_high: 8,
    target_weight: null,
    load_basis: "bodyweight",
  });
  assert.match(bwHtml, /3 × 6–8 · BW/);
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
