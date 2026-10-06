// The training drive on Today (today-push-{client,controller}.ts, lazy today-ahead):
// the quiet push line under the Brief's why, its "why not more" holds as chips that
// open the Brief's own "tap to see why", and the coach's push offer as a calm pull card
// answered in one tap — optimistic but truthful (a refusal puts the question back, a yes
// is re-read), with the stance's Undo in a toast and "not now" remembered. Nothing at
// all when the read carries no push. Every string escaped; never a score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-10-06";

function load(globals = {}) {
  return loadClientModule(
    ["html-utils", "ui-actions-client", "decision-undo-controller", "today-push-client", "today-push-controller"],
    { globals }
  );
}

function offer(over = {}) {
  return {
    decision_id: 41,
    offered_on: TODAY,
    evidence: ["Bench Press and Back Squat keep stepping up <on> what you complete", "Three clean weeks"],
    line: "You're carrying this well — want to open the throttle for the next two weeks?",
    until: "2026-10-19",
    accept_label: "Push me for two weeks",
    dismiss_label: "Not now",
    ...over,
  };
}

function drive(over = {}) {
  return {
    date: TODAY,
    drive: "push",
    standing: "steady",
    stance: {
      since: "2026-10-01",
      until: "2026-11-15",
      scope: "date",
      words: "push me",
      days_left: 40,
      decision_id: 7,
      line: "Pushing through Nov 15, as you asked on Oct 1.",
    },
    ended: null,
    licenses: [],
    never_overrides: [],
    today: {
      date: TODAY,
      reaching: false,
      reach_hosts: 0,
      holding: [
        { code: "quiet_day", words: "Your sleep ran short of your usual" },
        { code: "signal", words: "a short night and last night's HRV, outside your usual band" },
        { code: "recovering_group", words: "chest <b> is still deeply recovering, so the heavier look waits" },
        { code: "lift_hold", words: "Bench Press: two sessions under the top of the range" },
      ],
      line: "Push is on. Today it gives way to one thing: a short night.",
    },
    offer: null,
    ...over,
  };
}

test("the push line: 'Push · until Nov 15 — holding today:' with at most three plain chips, escaped", () => {
  const w = load();
  const host = renderHtml(w.CairnTodayPush.stateHtml(drive(), "easy"));
  assert.equal(host.querySelector(".tpush-line").textContent, "Push until Nov 15 — holding today:");
  const chips = [...host.querySelectorAll("button.tpush-chip")];
  // The day's own quiet read is the why above (said once): not a chip while anything else holds.
  assert.deepEqual(
    chips.map((c) => c.textContent),
    ["short night", "HRV", "chest <b> still recovering"]
  );
  assert.ok(chips.every((c) => c.getAttribute("type") === "button" && c.getAttribute("aria-expanded") === "false"));
  assert.match(chips[0].getAttribute("aria-label"), /a short night and last night's HRV/);
  assert.equal(host.querySelector(".tpush-chip b"), null, "escaped");
  assert.doesNotMatch(host.innerHTML, /\d+\s*\/\s*100|score/i);
});

test("the push line says the reach when the day has room, and the quiet day alone becomes the chip", () => {
  const w = load();
  const reaching = drive({ today: { date: TODAY, reaching: true, reach_hosts: 2, holding: [], line: null } });
  const host = renderHtml(w.CairnTodayPush.stateHtml(reaching, "train"));
  assert.equal(host.querySelector(".tpush-line").textContent, "Push until Nov 15 — room for two heavier top sets today");
  assert.equal(host.querySelector(".tpush-chip"), null);
  const quiet = drive({
    today: { date: TODAY, reaching: false, reach_hosts: 0, holding: [{ code: "quiet_day", words: "Rest reads right" }], line: "x" },
  });
  assert.equal(w.CairnTodayPush.chipsOf(quiet, "rest").map((c) => c.label).join("|"), "today reads rest");
});

test("nothing at all without push: no read, a steady drive; a stance that ran out is said once", () => {
  const w = load();
  assert.equal(w.CairnTodayPush.stateHtml(null), "");
  assert.equal(w.CairnTodayPush.stateHtml(drive({ drive: "steady", stance: null, today: null })), "");
  const ended = w.CairnTodayPush.stateHtml(
    drive({ drive: "steady", stance: null, today: null, ended: { until: "2026-10-05", line: "Your push ran <out>." } })
  );
  assert.match(ended, /Your push ran &lt;out&gt;\./);
  assert.equal(w.CairnTodayPush.offerHtml(null), "");
  assert.equal(w.CairnTodayPush.offerHtml({ ...offer(), decision_id: "x" }), "", "a malformed offer is no offer");
  assert.equal(w.CairnTodayPush.whyHtml(drive({ drive: "steady" })), "");
});

test("the offer card: the question, the evidence, how long it runs, two real buttons — escaped", () => {
  const w = load();
  const host = renderHtml(w.CairnTodayPush.offerHtml(offer({ line: "Open the <throttle>?" })));
  const card = host.querySelector("section.tpush-offer");
  assert.equal(card.getAttribute("data-tpush-offer"), "41");
  assert.equal(host.querySelector(".tpush-offer-q").textContent, "Open the <throttle>?");
  assert.equal(host.querySelectorAll(".tpush-offer-ev li").length, 2);
  assert.match(host.querySelector(".tpush-offer-ev").textContent, /stepping up <on> what/);
  assert.match(host.querySelector(".tpush-offer-until").textContent, /through Oct 19/);
  assert.equal(host.querySelector("[data-tpush-accept]").textContent, "Push me for two weeks");
  assert.equal(host.querySelector("[data-tpush-dismiss]").textContent, "Not now");
  assert.equal(host.querySelector(".tpush-offer-q throttle"), null, "escaped");
});

function briefHost(w) {
  const view = createHost(w.document, {
    html: `<section class="brief"><p class="brief-why">why</p><button class="brief-why-more" data-briefwhy aria-expanded="false">tap to see why</button><div id="todayPushSlot"></div><div id="todayPushOfferSlot"></div></section>`,
  });
  // The eager Brief's own "tap to see why" (today-brief-actions-client.ts), as it behaves.
  const btn = view.querySelector("[data-briefwhy]");
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    if (open) view.querySelector(".brief-why-panel")?.remove();
    else btn.insertAdjacentHTML("beforebegin", `<div class="brief-why-panel"><p class="brief-signals">signals</p></div>`);
  });
  return view;
}

test("accept: optimistic 'Opening the throttle…', POST with the offer's id, re-read, and the stance's Undo in a toast", async () => {
  const calls = [];
  const toasts = [];
  const writes = [];
  let refreshed = 0;
  let answer;
  const w = load({ CairnWriteInvalidation: { invalidateWrite: (n) => writes.push(n) } });
  const view = briefHost(w);
  w.CairnTodayPushController.mount(view, { kind: "train", push: drive({ drive: "steady", stance: null, today: null, offer: offer() }) }, {
    api: (path, init) => {
      calls.push([path, init?.method, init?.body]);
      if (path.startsWith("/brain/decisions/")) return Promise.resolve({ ok: true });
      return new Promise((resolve) => (answer = resolve));
    },
    toast: (m, o) => toasts.push([m, o]),
    refresh: () => {
      refreshed += 1;
    },
  });
  const slot = view.querySelector("#todayPushOfferSlot");
  assert.ok(slot.querySelector(".tpush-offer"));
  const pending = slot.querySelector("[data-tpush-accept]").click();
  await flush();
  assert.match(slot.querySelector(".tpush-offer-said").textContent, /Opening the throttle through Oct 19/);
  assert.deepEqual(calls[0], ["/training-drive/offer/accept", "POST", JSON.stringify({ decision_id: 41 })]);
  answer({ ok: true, decision_id: 77, read: { stance: { until: "2026-10-19" } } });
  await pending;
  await flush();
  assert.equal(slot.innerHTML, "", "the card gives way; the re-read paints the push line");
  assert.deepEqual(writes, ["push_offer_accept"]);
  assert.equal(refreshed, 1);
  const [message, opts] = toasts[0];
  assert.equal(message, "Push is on through Oct 19");
  assert.equal(opts.action, "Undo");
  await opts.onAction();
  await flush();
  assert.equal(calls[1][0], "/brain/decisions/77/revert", "Undo reverts the stance's own ledger row");
});

test("accept refused: the question stands exactly as it was, with the server's words", async () => {
  const toasts = [];
  let refreshed = 0;
  const w = load({ CairnWriteInvalidation: { invalidateWrite: () => {} } });
  const view = briefHost(w);
  w.CairnTodayPushController.mount(view, { kind: "train", push: drive({ drive: "steady", today: null, offer: offer() }) }, {
    api: async () => ({ ok: false, error: "That offer has closed." }),
    toast: (m) => toasts.push(m),
    refresh: () => refreshed++,
  });
  const slot = view.querySelector("#todayPushOfferSlot");
  await slot.querySelector("[data-tpush-accept]").click();
  await flush();
  assert.ok(slot.querySelector("section.tpush-offer [data-tpush-accept]"), "the card is back");
  assert.deepEqual(toasts, ["That offer has closed."]);
  assert.equal(refreshed, 0);
});

test("not now: gone at once, remembered on this device, POSTed; a refusal brings it back", async () => {
  const calls = [];
  const toasts = [];
  const w = load({ CairnWriteInvalidation: { invalidateWrite: (n) => calls.push(["write", n]) } });
  const read = { kind: "train", push: drive({ drive: "steady", today: null, offer: offer() }) };
  const view = briefHost(w);
  let ok = true;
  const deps = {
    api: async (path) => {
      calls.push([path]);
      return ok ? { ok: true, decision_id: 41 } : { ok: false, error: "Try again later." };
    },
    toast: (m) => toasts.push(m),
    refresh: () => {},
  };
  w.CairnTodayPushController.mount(view, read, deps);
  const slot = view.querySelector("#todayPushOfferSlot");
  await slot.querySelector("[data-tpush-dismiss]").click();
  await flush();
  assert.equal(slot.innerHTML, "");
  assert.deepEqual(calls, [["/training-drive/offer/dismiss"], ["write", "push_offer_dismiss"]]);
  assert.match(toasts[0], /won't ask again/);
  // A cached read that still carries the offer never paints the question again.
  w.CairnTodayPushController.repaint(view, read);
  assert.equal(slot.innerHTML, "");
  assert.match(w.localStorage.getItem(w.CairnTodayPushController.DISMISSED_KEY), /41/);
  // A refused "not now" (a fresh offer id) brings the card back and forgets it.
  ok = false;
  const next = { kind: "train", push: drive({ drive: "steady", today: null, offer: offer({ decision_id: 52 }) }) };
  w.CairnTodayPushController.repaint(view, next);
  await slot.querySelector("[data-tpush-dismiss]").click();
  await flush();
  assert.ok(slot.querySelector("[data-tpush-dismiss]"));
  assert.doesNotMatch(w.localStorage.getItem(w.CairnTodayPushController.DISMISSED_KEY), /52/);
  assert.equal(toasts.at(-1), "Try again later.");
});

test("a holding chip opens the Brief's own 'tap to see why', where every hold is said in full", async () => {
  const w = load();
  const view = briefHost(w);
  w.CairnTodayPushController.mount(view, { kind: "easy", push: drive() }, { api: async () => ({}), toast: () => {}, refresh: () => {} });
  const chip = view.querySelector("[data-tpush-why]");
  await chip.click();
  const why = view.querySelector("[data-briefwhy]");
  assert.equal(why.getAttribute("aria-expanded"), "true");
  assert.ok([...view.querySelectorAll("[data-tpush-why]")].every((c) => c.getAttribute("aria-expanded") === "true"));
  const section = view.querySelector(".brief-why-panel [data-tpush-panel]");
  assert.ok(section, "the push section sits in the why panel");
  assert.match(section.textContent, /Push is on\. Today it gives way to one thing: a short night\./);
  // Every hold in full — except the day's own quiet read, which IS the why above it.
  assert.equal(section.querySelectorAll("li").length, 3);
  assert.doesNotMatch(section.textContent, /Your sleep ran short of your usual/);
  assert.equal(section.querySelector("b"), null, "escaped");
  // Closing the why closes the chips with it.
  await view.querySelector("[data-tpush-why]").click();
  assert.equal(why.getAttribute("aria-expanded"), "false");
  assert.equal(view.querySelector("[data-tpush-why]").getAttribute("aria-expanded"), "false");
});

test("the Brief's in-place upgrade repaints the push into the fresh Brief's slots; a placeholder read leaves them", () => {
  const w = load();
  const deps = { api: async () => ({}), toast: () => {}, refresh: () => {} };
  const view = briefHost(w);
  // Before the bundle's first mount there is nothing to repaint with: a no-op.
  w.CairnTodayPushController.repaint(view, { kind: "easy", push: drive() });
  assert.equal(view.querySelector("#todayPushSlot").innerHTML, "");
  w.CairnTodayPushController.mount(view, { kind: "train", push: null }, deps);
  assert.equal(view.querySelector("#todayPushSlot").innerHTML, "");
  // The swap: fresh, empty slots; the controller's repaint fills them from the new read.
  view.querySelector(".brief").innerHTML = `<div id="todayPushSlot"></div><div id="todayPushOfferSlot"></div>`;
  w.CairnTodayPushController.repaint(view, { kind: "easy", push: drive() });
  assert.ok(view.querySelector("#todayPushSlot .tpush-line"));
  w.CairnTodayPushController.repaint(view, { _provisional: true, kind: "train" });
  assert.ok(view.querySelector("#todayPushSlot .tpush-line"), "a placeholder read says nothing about the drive");
});
