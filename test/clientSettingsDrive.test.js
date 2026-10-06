// Settings → Automation: the training drive card (settings-drive-client.ts renderer +
// settings-drive-controller.ts). Steady / Push, always dated; it shows the drive IN FORCE
// (a lapsed push reads steady with its end said, so Push opens a NEW stance), and writes
// only through PUT /api/training-drive — never the Settings save bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, fire, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-10-06";

function load(globals = {}) {
  return loadClientModule(["html-utils", "settings-drive-client", "settings-drive-controller"], { globals });
}

const NEVER = [
  "A rest-grade readiness reading",
  "Any symptom or injury you've reported <b>",
];
const OPENS = ["Up to two heavier top sets, on different lifts that are moving", "A strong top set can earn the next load"];

function read(overrides = {}) {
  return {
    date: TODAY,
    drive: "steady",
    standing: "steady",
    stance: null,
    ended: null,
    licenses: [],
    never_overrides: NEVER,
    push_opens: OPENS,
    today: null,
    offer: null,
    ...overrides,
  };
}

function activeRead(overrides = {}) {
  return read({
    drive: "push",
    standing: "push",
    stance: {
      since: TODAY,
      until: "2026-10-31",
      scope: "date",
      words: "I can push <harder>",
      days_left: 25,
      decision_id: 41,
      line: "Pushing through Oct 31, as you asked on Oct 6.",
    },
    licenses: OPENS,
    ...overrides,
  });
}

const lapsedRead = (overrides = {}) =>
  read({
    standing: "push",
    ended: { until: "2026-10-03", line: "Your push ran through Oct 3; the drive is back where it was. Say the word to start another." },
    ...overrides,
  });

function ui(win, overrides = {}) {
  return { ...win.CairnSettingsDrive.initialUi(), status: "ready", ...overrides };
}

function card(win, r, u) {
  return renderHtml(win.CairnSettingsDrive.cardHtml(r, u), { document: win.document });
}

const pressed = (host, value) => host.querySelector(`[data-drive-pick="${value}"]`).getAttribute("aria-pressed");

// ---------- the renderer: four honest states ----------

test("steady: Steady is pressed, the usual rhythm is said, and the fold names what Push opens", () => {
  const win = load();
  const host = card(win, read(), ui(win));
  assert.equal(win.CairnSettingsDrive.driveView(read()), "steady");
  assert.equal(pressed(host, "steady"), "true");
  assert.equal(pressed(host, "push"), "false");
  assert.equal(host.querySelector(".drive-seg").getAttribute("role"), "group");
  assert.match(host.querySelector(".drive-state").textContent, /usual rhythm/);
  assert.equal(host.querySelector("[data-drive-end]"), null, "nothing to end");
  const opens = host.querySelectorAll(".drive-list-opens li");
  assert.equal(opens.length, 2, "push_opens is shown even though nothing is open while steady");
  const never = host.querySelectorAll(".drive-list-never li");
  assert.equal(never.length, 2);
  assert.equal(never[1].textContent, "Any symptom or injury you've reported <b>", "escaped, never markup");
  assert.equal(host.querySelector(".drive-list-never b"), null);
  assert.doesNotMatch(host.textContent, /\b\d+\s*\/\s*100\b|score/i);
});

test("active: the stance line, days left, the athlete's words (escaped), Change the end and End push", () => {
  const win = load();
  const host = card(win, activeRead(), ui(win));
  assert.equal(pressed(host, "push"), "true");
  assert.match(host.querySelector(".drive-k").textContent, /Push is on · 25 days left/);
  assert.equal(host.querySelector(".drive-line").textContent, "Pushing through Oct 31, as you asked on Oct 6.");
  assert.match(host.querySelector(".drive-said").textContent, /You said “I can push <harder>”/);
  assert.equal(host.querySelector(".drive-said harder"), null);
  assert.ok(host.querySelector("[data-drive-compose]"));
  assert.equal(host.querySelector("[data-drive-end]").textContent, "End push");
  assert.match(host.querySelector(".drive-state").getAttribute("aria-live"), /polite/);
});

test("active on its last day says so", () => {
  const win = load();
  const r = activeRead();
  r.stance.days_left = 0;
  assert.match(card(win, r, ui(win)).querySelector(".drive-k").textContent, /last day today/);
});

test("lapsed: the EFFECTIVE drive (steady) is pressed and the end is said — not the stale standing Push", () => {
  const win = load();
  const r = lapsedRead();
  assert.equal(win.CairnSettingsDrive.driveView(r), "lapsed");
  const host = card(win, r, ui(win));
  assert.equal(pressed(host, "steady"), "true");
  assert.equal(pressed(host, "push"), "false");
  assert.match(host.querySelector(".drive-line").textContent, /ran through Oct 3/);
  // Past the week the end is news, standing push with steady in force still reads as lapsed.
  const quiet = card(win, lapsedRead({ ended: null }), ui(win));
  assert.match(quiet.querySelector(".drive-line").textContent, /run its course/);
});

test("open: a standing push with no end date asks for one", () => {
  const win = load();
  const r = read({ drive: "push", standing: "push", licenses: OPENS });
  assert.equal(win.CairnSettingsDrive.driveView(r), "open");
  const host = card(win, r, ui(win));
  assert.match(host.querySelector(".drive-k").textContent, /no end date/);
  assert.equal(host.querySelector("[data-drive-compose]").textContent, "Set an end");
});

test("the coach's open offer never renders here — Today owns that ask", () => {
  const win = load();
  const r = read({
    offer: {
      decision_id: 9,
      offered_on: TODAY,
      evidence: ["Bench keeps stepping up"],
      line: "You're carrying this well. Want to open the throttle?",
      until: "2026-10-19",
      accept_label: "Push me for two weeks",
      dismiss_label: "Not now",
    },
  });
  const host = card(win, r, ui(win));
  assert.doesNotMatch(host.textContent, /open the throttle|Push me for two weeks/);
});

test("an unreadable payload is a calm retry, and loading is a polite status", () => {
  const win = load();
  const bad = card(win, { drive: "maximum" }, ui(win));
  assert.ok(bad.querySelector("[data-drive-retry]"));
  const wait = card(win, null, win.CairnSettingsDrive.initialUi());
  assert.equal(wait.querySelector(".drive-wait").getAttribute("role"), "status");
});

test("the chooser: four ends, the confirm names the date, and a far date is refused", () => {
  const win = load();
  const D = win.CairnSettingsDrive;
  assert.equal(D.untilFor("two_weeks", TODAY), "2026-10-19");
  assert.equal(D.untilFor("four_weeks", TODAY), "2026-11-02");
  assert.equal(D.untilFor("block", TODAY), null, "the server resolves the block's end");
  assert.equal(D.untilFor("date", TODAY, "2026-10-05"), null, "the past is refused");
  assert.equal(D.untilFor("date", TODAY, "2027-03-01"), null, "past the twelve-week cap");
  assert.equal(D.untilFor("date", TODAY, "2026-11-15"), "2026-11-15");
  assert.deepEqual(JSON.parse(JSON.stringify(D.pushBody(ui(win, { choice: "block", words: "  " }), TODAY))), {
    drive: "push",
    scope: "block",
    words: null,
  });
  const composing = card(win, read(), ui(win, { composing: true }));
  assert.equal(pressed(composing, "push"), "true", "choosing Push shows Push while the end is picked");
  assert.equal(composing.querySelectorAll("[data-drive-until]").length, 4);
  assert.equal(composing.querySelector("[data-drive-go]").disabled, true, "no end chosen yet");
  assert.equal(composing.querySelector("[data-drive-go]").textContent, "Choose an end");
  const picked = card(win, read(), ui(win, { composing: true, choice: "two_weeks", words: `"quoted" <i>` }));
  assert.equal(picked.querySelector('[data-drive-until="two_weeks"]').getAttribute("aria-pressed"), "true");
  assert.equal(picked.querySelector("[data-drive-go]").textContent, "Push through Oct 19");
  assert.equal(picked.querySelector("#driveWords").value, `"quoted" <i>`);
  const dated = card(win, read(), ui(win, { composing: true, choice: "date" }));
  const input = dated.querySelector("#driveDate");
  assert.equal(input.getAttribute("min"), TODAY);
  assert.equal(input.getAttribute("max"), "2026-12-29");
  assert.equal(dated.querySelector("[data-drive-go]").textContent, "Pick a last day");
});

// ---------- the controller: loads, writes through PUT /training-drive only ----------

function harness(responses, { cached = null } = {}) {
  const calls = [];
  const toasts = [];
  const writes = [];
  const store = new Map(cached ? [["settings:drive", cached]] : []);
  const queue = [...responses];
  const win = load();
  const host = createHost(win.document, { html: "" });
  const deps = {
    root: host,
    api: async (path, opts = {}) => {
      calls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    toast: (message) => toasts.push(message),
    cache: { peek: (key) => store.get(key) ?? null, set: (key, value) => store.set(key, value) },
    onWrite: () => writes.push("training_drive"),
  };
  const handle = win.CairnSettingsDriveController.mount(deps);
  return { win, host, calls, toasts, writes, store, handle };
}

test("a lapsed push: tap Push, pick two weeks, say it, confirm → a NEW dated stance through PUT", async () => {
  const done = activeRead({ stance: { ...activeRead().stance, until: "2026-10-19", days_left: 13, words: "again" } });
  const h = harness([lapsedRead(), { ok: true, notes: [], decision_id: 77, read: done }]);
  await h.handle.ready;
  assert.equal(pressed(h.host, "steady"), "true", "lapsed reads steady");
  await h.host.querySelector('[data-drive-pick="push"]').click();
  assert.ok(h.host.querySelector(".drive-compose"), "Push opens the end chooser rather than doing nothing");
  await h.host.querySelector('[data-drive-until="two_weeks"]').click();
  const words = h.host.querySelector("#driveWords");
  words.value = "again";
  await fire(words, "input");
  await h.host.querySelector("[data-drive-go]").click();
  await flush();
  const put = h.calls.find((c) => c.method === "PUT");
  assert.equal(put.path, "/training-drive");
  assert.deepEqual(put.body, { drive: "push", until: "2026-10-19", words: "again" });
  assert.equal(h.calls.filter((c) => c.path === "/settings").length, 0, "never the generic settings save");
  assert.deepEqual(h.writes, ["training_drive"], "the drive's caches are dropped");
  assert.deepEqual(h.toasts, ["Push is on through Oct 19"]);
  assert.equal(pressed(h.host, "push"), "true");
  assert.match(h.host.querySelector(".drive-k").textContent, /13 days left/);
  assert.equal(h.store.get("settings:drive").stance.until, "2026-10-19", "the fresh read is the card's last-known copy");
});

test("End push asks once, then steps back to steady through the same door", async () => {
  const h = harness([activeRead(), { ok: true, decision_id: 78, read: read() }]);
  await h.handle.ready;
  await h.host.querySelector("[data-drive-end]").click();
  assert.match(h.host.querySelector(".drive-confirm").textContent, /Back to steady from today\?/);
  await h.host.querySelector("[data-drive-end-no]").click();
  assert.equal(h.host.querySelector(".drive-confirm"), null, "Keep pushing leaves it as it was");
  // Tapping Steady on an active push is the same ask.
  await h.host.querySelector('[data-drive-pick="steady"]').click();
  await h.host.querySelector("[data-drive-end-yes]").click();
  await flush();
  const put = h.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { drive: "steady" });
  assert.deepEqual(h.toasts, ["Back to steady"]);
  assert.equal(pressed(h.host, "steady"), "true");
});

test("a refusal is said in the server's words, nothing toasts, and the choice survives", async () => {
  const h = harness([read(), { ok: false, error: "until is already in the past — name today or a later day" }]);
  await h.handle.ready;
  await h.host.querySelector('[data-drive-pick="push"]').click();
  await h.host.querySelector('[data-drive-until="block"]').click();
  await h.host.querySelector("[data-drive-go]").click();
  await flush();
  assert.match(h.host.querySelector(".drive-err").textContent, /already in the past/);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.writes, []);
  assert.ok(h.host.querySelector(".drive-compose"), "still choosing");
  assert.equal(h.host.querySelector('[data-drive-until="block"]').getAttribute("aria-pressed"), "true");
});

test("offline: the write fails calmly and nothing changed", async () => {
  const h = harness([read(), new Error("offline")]);
  await h.handle.ready;
  await h.host.querySelector('[data-drive-pick="push"]').click();
  await h.host.querySelector('[data-drive-until="four_weeks"]').click();
  await h.host.querySelector("[data-drive-go]").click();
  await flush();
  assert.match(h.host.querySelector(".drive-err").textContent, /Nothing changed/);
  assert.equal(pressed(h.host, "push"), "true");
});

test("the last-known read paints before the fetch lands; a failed load keeps it", async () => {
  const h = harness([new Error("offline")], { cached: activeRead() });
  assert.match(h.host.querySelector(".drive-line").textContent, /Pushing through Oct 31/, "painted from cache at once");
  await h.handle.ready;
  assert.match(h.host.querySelector(".drive-line").textContent, /Pushing through Oct 31/);
});

test("nothing cached and the load fails: a retry, which loads", async () => {
  const h = harness([new Error("offline"), read()]);
  await h.handle.ready;
  const retry = h.host.querySelector("[data-drive-retry]");
  assert.ok(retry);
  await retry.click();
  await flush();
  assert.equal(pressed(h.host, "steady"), "true");
});

test("a picked date updates the confirm without re-rendering the field", async () => {
  const h = harness([read()]);
  await h.handle.ready;
  await h.host.querySelector('[data-drive-pick="push"]').click();
  await h.host.querySelector('[data-drive-until="date"]').click();
  const input = h.host.querySelector("#driveDate");
  input.value = "2026-11-15";
  await fire(input, "change");
  assert.equal(h.host.querySelector("#driveDate"), input, "the same field, focus kept");
  const go = h.host.querySelector("[data-drive-go]");
  assert.equal(go.disabled, false);
  assert.equal(go.textContent, "Push through Nov 15");
});
