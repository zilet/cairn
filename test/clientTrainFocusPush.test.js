// Train → "Where to focus": the push stance strip (focus.push, the same read the Brief
// carries) and the "What moved" arrows reading a change's own `direction` when the
// server sends one, falling back to the evidence-label match when it does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadClientModule, renderHtml } from "./_dom.mjs";

function load() {
  return loadClientModule(
    ["html-utils", "ui-feedback-client", "coaching-focus-render-client", "coaching-focus-client", "train-focus-card-client"],
    { globals: { state: {}, view: { querySelector: () => null }, api: async () => null, activateTab: () => {} } }
  );
}

function push(overrides = {}) {
  return {
    date: "2026-10-06",
    drive: "push",
    standing: "push",
    stance: {
      since: "2026-10-01",
      until: "2026-11-15",
      scope: "date",
      words: "push me",
      days_left: 40,
      decision_id: 3,
      line: "Pushing through Nov 15, as you asked on Oct 1.",
    },
    ended: null,
    licenses: [],
    never_overrides: [],
    today: { date: "2026-10-06", reaching: false, reach_hosts: 0, holding: [], line: null },
    offer: null,
    ...overrides,
  };
}

function strip(win, focus) {
  return renderHtml(win.cfocusPushHtml(focus), { document: win.document });
}

test("active push: 'Push · through Nov 15' and the read's own why-not-more line", () => {
  const win = load();
  const host = strip(win, {
    push: push({
      today: {
        date: "2026-10-06",
        reaching: false,
        reach_hosts: 0,
        holding: [{ code: "signal", words: "a short night" }],
        line: "Push is on. Today it gives way to one thing: a short <night>.",
      },
    }),
  });
  const el = host.querySelector(".tfc-push");
  assert.equal(el.getAttribute("role"), "note");
  assert.equal(host.querySelector(".tfc-push-k").textContent, "Push");
  assert.equal(host.querySelector(".tfc-push-until").textContent, "through Nov 15");
  assert.equal(host.querySelector(".tfc-push-line").textContent, "Push is on. Today it gives way to one thing: a short <night>.");
  assert.equal(host.querySelector(".tfc-push-line night"), null, "escaped");
});

test("with no line, what is holding today is named in its own words", () => {
  const win = load();
  const host = strip(win, {
    push: push({
      today: {
        date: "2026-10-06",
        reaching: false,
        reach_hosts: 0,
        holding: [
          { code: "deload", words: "a deload your loaded weeks earned" },
          { code: "soreness", words: "the soreness you <reported>" },
          { code: "fueling", words: "a third never shown" },
        ],
        line: null,
      },
    }),
  });
  const line = host.querySelector(".tfc-push-line").textContent;
  assert.equal(line, "Holding it today: a deload your loaded weeks earned · the soreness you <reported>.");
  assert.doesNotMatch(line, /third never shown/);
});

test("nothing holding: the stance's own line; an undated standing push says so", () => {
  const win = load();
  assert.equal(
    strip(win, { push: push() }).querySelector(".tfc-push-line").textContent,
    "Pushing through Nov 15, as you asked on Oct 1."
  );
  const open = strip(win, { push: push({ stance: null, today: null }) });
  assert.equal(open.querySelector(".tfc-push-until").textContent, "no end date");
  assert.equal(open.querySelector(".tfc-push-line"), null);
});

test("ended (lapsed) push: one quiet line; steady with nothing to say and no push: nothing", () => {
  const win = load();
  const ended = strip(win, {
    push: push({ drive: "steady", stance: null, today: null, ended: { until: "2026-10-03", line: "The push you asked for ended on Oct 3. Ask again any time." } }),
  });
  assert.ok(ended.querySelector(".tfc-push.is-ended"));
  assert.match(ended.querySelector(".tfc-push-line").textContent, /ended on Oct 3/);
  assert.equal(win.cfocusPushHtml({ push: push({ drive: "steady", stance: null, today: null }) }), "");
  assert.equal(win.cfocusPushHtml({}), "");
  assert.equal(win.cfocusPushHtml({ push: null }), "");
});

test("the offer never renders on Train — the Brief owns that ask", () => {
  const win = load();
  const html = win.cfocusPushHtml({
    push: push({
      drive: "steady",
      stance: null,
      today: null,
      offer: { decision_id: 1, offered_on: "2026-10-06", evidence: [], line: "Want to open the throttle?", until: "2026-10-19", accept_label: "Push me", dismiss_label: "Not now" },
    }),
  });
  assert.equal(html, "");
});

function card(win, focus) {
  return renderHtml(win.CairnCoachingFocus.coachingFocusHtml(focus, { variant: "overview" }), { document: win.document });
}

const base = {
  available: true,
  headline: "",
  lead: { domain: "training", title: "Break the plateau", why: "w", move: "Rotate incline press" },
  parallel: [],
  later: [],
  connections: [],
  retest: null,
  horizon_weeks: null,
};

test("the card carries the push strip under the lead", () => {
  const win = load();
  const host = card(win, { ...base, push: push() });
  const html = host.innerHTML;
  assert.ok(host.querySelector(".tfc-push"));
  assert.ok(html.indexOf("tfc-hero") < html.indexOf("tfc-push"), "under the lead, never above it");
});

test("What moved: a change's own direction wins; absent, the evidence label still decides", () => {
  const win = load();
  const host = card(win, {
    ...base,
    evidence: [{ domain: "training", label: "Bench e1RM", value: "92 kg", direction: "up", note: null, as_of: null }],
    changed_since: [
      { domain: "body", kind: "weight", text: "Weight eased 1 kg", since: "since Mon", direction: "down" },
      { domain: "training", kind: "new_best", text: "New best: Bench e1RM 92 kg", since: null },
      { domain: "running", kind: "run_volume", text: "Run volume held", since: null, direction: null },
      { domain: "training", kind: "new_best", text: "Bench e1RM steady", since: null, direction: "steady" },
    ],
  });
  const marks = host.querySelectorAll(".tfc-moved-item .tfc-dir");
  assert.equal(marks.length, 3, "at most three rows");
  assert.equal(marks[0].getAttribute("aria-label"), "down", "the server's own direction");
  assert.equal(marks[1].getAttribute("aria-label"), "up", "fallback: the evidence label it names");
  assert.equal(marks[2].getAttribute("aria-label"), null, "no direction and no evidence match: a quiet dot");
  assert.equal(marks[2].getAttribute("aria-hidden"), "true");
});

test("What moved: an ISO `since` reads as a short date, and every row is the same arrow · text · date shape", () => {
  const win = load();
  const host = card(win, {
    ...base,
    changed_since: [
      {
        domain: "training",
        kind: "new_best",
        text: "New bests this week: Farmer's Carry 70 lb × 45 s, Neutral-Grip Pull-Up 4 × 8, and Reverse Pec Deck.",
        since: "2026-09-30",
        direction: "up",
      },
      { domain: "body", kind: "weight", text: "Weight eased 1 lb", since: "2026-10-01", direction: "down" },
      { domain: "running", kind: "run_volume", text: "Run volume held", since: "since <Mon>", direction: "steady" },
    ],
  });
  const rows = [...host.querySelectorAll(".tfc-moved-item")];
  assert.equal(rows.length, 3);
  for (const row of rows) {
    // One shape per row: the arrow, the text, then the quiet date — the arrow never alone.
    const kids = [...row.children].map((el) => el.className.split(" ")[0]);
    assert.deepEqual(kids, ["tfc-dir", "tfc-moved-text", "tfc-moved-since"]);
  }
  const dates = rows.map((row) => row.querySelector(".tfc-moved-since").textContent);
  assert.deepEqual(dates, ["Sep 30", "Oct 1", "since <Mon>"], "an ISO date is a short date; other words stay as said");
  assert.doesNotMatch(host.innerHTML, /2026-09-30|2026-10-01/, "no raw ISO date reaches the card");
  // The row is a three-column grid (arrow, wrapping text, date), not a wrapping flex row
  // that can strand the arrow on a line of its own.
  const css = readFileSync(new URL("../src/styles/train/overview.css", import.meta.url), "utf8");
  assert.match(css, /\.tfc-moved-item\{display:grid;grid-template-columns:1\.2em minmax\(0,1fr\) auto;/);
  assert.doesNotMatch(css, /\.tfc-moved-item,\.tfc-ev\{display:flex/);
});
