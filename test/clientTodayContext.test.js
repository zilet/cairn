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

function loadTodayContext() {
  const context = {
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    escHtml,
    localISO: () => "2026-07-01",
  };
  context.window = context;
  // The injury banner nudge rotates through date-utils' pickDayVariant; load it as
  // the browser does, then pin the day so the rotation is deterministic here.
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  context.localISO = () => "2026-07-01";
  vm.runInNewContext(readFileSync(join(root, "public/js/today-context-client.js"), "utf8"), context);
  return context.CairnTodayContext;
}

test("Today context helper filters near-term events and escapes banner lines", () => {
  const todayContext = loadTodayContext();
  const events = [
    { kind: "life_event", title: "Race <later>", start_date: "2026-09-01" },
    { kind: "trip", title: "Travel", start_date: "2026-07-08", meta_json: '{"location":"NYC <work>"}' },
    { kind: "injury", title: "Knee", meta_json: { area: "left <knee>" } },
    { kind: "family_event", title: "Camp", start_date: "2026-06-29", end_date: "2026-07-03" },
    { kind: "trip", title: "Archived", archived: true, start_date: "2026-07-02" },
  ];

  assert.equal(todayContext.daysUntil("2026-07-02", "2026-07-01"), 1);
  assert.equal(todayContext.eventCountdown(1), "tomorrow");
  assert.equal(todayContext.eventCountdown(16), "in 2 weeks");
  assert.equal(todayContext.isNearTermContext(events[0], "2026-07-01"), false);
  assert.equal(todayContext.isNearTermContext(events[1], "2026-07-01"), true);

  const html = todayContext.contextBannerHtml(events, "2026-07-01");
  assert.match(html, /Travel to NYC &lt;work&gt; · in 7 days/);
  // The nudge after the injury title rotates by day (an open injury banners every
  // morning, so a fixed sentence would print for weeks) — assert the shape, and
  // that consecutive days really differ.
  assert.match(html, /Knee \(left &lt;knee&gt;\) — [a-z][^<]+/);
  assert.match(html, /Camp · now/);
  assert.doesNotMatch(html, /Race|Archived|<work>|<knee>/);

  const nudge = (day) => /Knee \(left &lt;knee&gt;\) — ([^<]+)/.exec(
    todayContext.contextBannerHtml([events[2]], day)
  )?.[1];
  assert.ok(nudge("2026-07-01"));
  assert.notEqual(nudge("2026-07-01"), nudge("2026-07-02"));
  assert.equal(nudge("2026-07-01"), nudge("2026-07-01"));
});

test("a resolved injury stops bannering on Today", () => {
  const todayContext = loadTodayContext();
  const healed = { kind: "injury", title: "Knee", resolved_at: "2026-06-20" };
  const open = { kind: "injury", title: "Shoulder" };

  assert.equal(todayContext.isNearTermContext(healed, "2026-07-01"), false);
  assert.equal(todayContext.isNearTermContext(open, "2026-07-01"), true);
  // Resolved TOMORROW is not resolved yet — it still speaks today.
  assert.equal(
    todayContext.isNearTermContext({ ...healed, resolved_at: "2026-07-02" }, "2026-07-01"),
    true
  );
  assert.doesNotMatch(todayContext.contextBannerHtml([healed], "2026-07-01"), /Knee/);
});

test("Today goal line stays calm and mode-aware", () => {
  const todayContext = loadTodayContext();

  assert.equal(todayContext.goalLineHtml({ goal_mode: "maintain", goal_weight_lb: 180, goal_date: "2026-08-01" }, 181, true, "2026-07-01"), "");
  assert.equal(todayContext.goalLineHtml({ goal_mode: "lose", goal_weight_lb: 180, goal_date: "2026-06-01" }, 181, true, "2026-07-01"), "");
  assert.equal(todayContext.goalLineHtml({ goal_mode: "lose", goal_weight_lb: 180, goal_date: "2026-08-01" }, 181, false, "2026-07-01"), "");

  const html = todayContext.goalLineHtml({ goal_mode: "gain", goal_weight_lb: 185, goal_date: "2026-07-08" }, "180 <now>", true, "2026-07-01");
  assert.match(html, /Building toward/);
  assert.match(html, /185 lb/);
  assert.match(html, /this week/);
  assert.match(html, /from 180 &lt;now&gt;/);
  assert.doesNotMatch(html, /180 <now>/);
});

test("Today health-focus banner prefers synthesis then lead moves", () => {
  const todayContext = loadTodayContext();

  const synthesis = todayContext.healthFocusBannerHtml({
    synthesis: { one_change: "Trim <fat> to help lipids" },
  });
  assert.match(synthesis, /Trim &lt;fat&gt; to help lipids/);
  assert.doesNotMatch(synthesis, /Trim <fat>/);

  const lead = todayContext.healthFocusBannerHtml({
    focus: { lead: { group: "ApoB", moves: { nutrition: "more fiber <daily>" } } },
  });
  assert.match(lead, /ApoB: more fiber &lt;daily&gt;/);
  assert.equal(todayContext.healthFocusBannerHtml({ focus: {} }), "");
});
