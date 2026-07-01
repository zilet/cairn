import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthPicture() {
  const context = {
    console,
    Date,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    String,
    JSON,
    stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
  };
  context.window = context;
  for (const file of [
    "public/js/date-utils.js",
    "public/js/html-utils.js",
    "public/js/ui-components.js",
    "public/js/health-evidence-client.js",
    "public/js/health-client.js",
    "public/js/health-picture-client.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return context.CairnHealthPicture;
}

test("health picture parses review payloads defensively", () => {
  const picture = loadHealthPicture();

  assert.equal(picture.parsedReview(null), null);
  assert.equal(picture.parsedReview({ error: "failed", parsed: { headline: "Nope" } }), null);
  assert.equal(picture.parsedReview({ parsed: "{not json" }), null);
  assert.equal(picture.parsedReview({ parsed: JSON.stringify({ headline: "Ready" }) }).headline, "Ready");
  assert.equal(picture.parsedReview({ parsed: { headline: "Object payload" } }).headline, "Object payload");
});

test("health picture status dots map clinical flags to stable classes", () => {
  const picture = loadHealthPicture();

  assert.equal(picture.healthDotClass("low"), "hdot-warn");
  assert.equal(picture.healthDotClass("HIGH"), "hdot-warn");
  assert.equal(picture.healthDotClass("critical"), "hdot-warn");
  assert.equal(picture.healthDotClass("ok"), "hdot-ok");
  assert.equal(picture.healthDotClass("normal"), "hdot-ok");
  assert.equal(picture.healthDotClass("watch"), "hdot-watch");
  assert.equal(picture.healthDotClass(""), "hdot-mute");
});

test("health picture empty and build cards preserve calls to action", () => {
  const picture = loadHealthPicture();

  const busy = picture.reviewBusyHtml();
  assert.match(busy, /reviewing/);
  assert.match(busy, /Reading every record and trend/);

  const hero = picture.healthHeroHtml('<div class="hpic-err">Try again</div>');
  assert.match(hero, /Build your whole picture/);
  assert.match(hero, /<svg/);
  assert.match(hero, /id="hHeroShare"/);
  assert.match(hero, /Try again/);

  const single = picture.buildPictureHtml("", 1);
  assert.match(single, /One review across your document/);
  assert.match(single, /id="hRevBtn"/);

  const many = picture.buildPictureHtml("", 3);
  assert.match(many, /One review across all 3 documents/);
});

test("health picture review renderer escapes agent output and stale refresh state", () => {
  const picture = loadHealthPicture();
  const html = picture.reviewHtml(
    {
      created_at: "2026-06-30T04:00:00Z",
      agent: "coach <bot>",
      parsed: {
        headline: "ApoB <watch> on 2026-06-01",
        focus: [{ title: "Lower ApoB <risk>", why: "measured on 2026-06-01", action: "add fiber <daily>" }],
        watchlist: [{ marker: "LDL <bad>", status: "high", why: "recorded on 2026-06-01", action: "retest <soon>" }],
        wins: ["VO2 held <steady>"],
        followups: [{ what: "Discuss with clinician <pcp>", when: "next visit <soon>" }],
        training_impact: "Keep hard days modest <for now>",
        nutrition_impact: "Fiber up <slowly>",
      },
    },
    true,
    '<div class="hpic-err">Retry later</div>',
  );

  assert.match(html, /This week's focus/);
  assert.match(html, /Watchlist/);
  assert.match(html, /Going well/);
  assert.match(html, /Follow-ups/);
  assert.match(html, /Training/);
  assert.match(html, /Nutrition/);
  assert.match(html, /hpic-refresh-stale/);
  assert.match(html, /New results/);
  assert.match(html, /coach &lt;bot&gt;/);
  assert.match(html, /Retry later/);
  assert.doesNotMatch(html, /<watch>|<risk>|<bad>|<steady>|<pcp>|<for now>|<slowly>|<bot>/);
});
