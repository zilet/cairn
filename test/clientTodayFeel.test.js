import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument, createFakeTimers, createHost, loadClientModule } from "./_dom.mjs";

// Today "feel" (v2 wave 7): a tap is answered in the same frame and never rebuilds
// Today under the finger; a same-date rewrite keeps what is on screen; a view
// transition never freezes the screen for a network round trip; and one app-wide
// keyboard state keeps the tab bar off the composer.

// A MutationObserver the harness DOM does not have: it hears innerHTML writes on the
// elements it observes (the only mutation the slot hold listens for), delivered as a
// microtask the way a browser delivers records.
function installMutationObserver(win) {
  const proto = Object.getPrototypeOf(win.document.createElement("div"));
  const desc =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), "innerHTML") ||
    Object.getOwnPropertyDescriptor(proto, "innerHTML");
  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
    }
    observe(target) {
      this.targets.push(target);
      if (!target.__observers) {
        target.__observers = new Set();
        Object.defineProperty(target, "innerHTML", {
          configurable: true,
          get() {
            return desc.get.call(this);
          },
          set(value) {
            desc.set.call(this, value);
            for (const o of [...this.__observers])
              queueMicrotask(() => o.targets.includes(this) && o.cb([{ type: "childList", target: this }]));
          },
        });
      }
      target.__observers.add(this);
    }
    disconnect() {
      for (const t of this.targets) t.__observers?.delete(this);
      this.targets = [];
    }
  }
  win.MutationObserver = FakeMutationObserver;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
// Values made inside the sandbox realm compare by structure, not prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------- the slot hold ----------

function loadSlotHold(timers = createFakeTimers()) {
  const win = loadClientModule("today-slot-hold", {
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  installMutationObserver(win);
  return { hold: win.CairnTodaySlotHold, document: win.document, timers };
}

const FRAME = (rail = `<aside class="today-rail" aria-busy="true"></aside>`) =>
  `<div class="today-wrap"><main><div id="ctxEvents"></div><div id="cfocusSlot"></div><details class="brief-around"><summary>Around</summary></details></main>${rail}</div>`;

test("a same-date rewrite keeps each async slot's content, inert, instead of blanking it", async () => {
  const { hold, document } = loadSlotHold();
  const root = createHost(document, {
    html: FRAME(
      `<aside class="today-rail"><div id="weeklySlot"><section class="weekly-card settle-in">Week read</section></div></aside>`
    ),
  });
  root.querySelector("#ctxEvents").innerHTML = `<div class="ctx reveal">Lisbon in 9 days</div>`;
  root.querySelector("details.brief-around").open = true;

  const snapshot = hold.capture(root);
  root.innerHTML = FRAME(); // the rewrite: every slot empty again
  const filled = hold.apply(root, snapshot, { rail: true });

  const ctx = root.querySelector("#ctxEvents");
  assert.equal(filled, 2, "the context line and the whole rail are held");
  assert.match(ctx.innerHTML, /Lisbon in 9 days/, "the slot shows what it showed");
  assert.ok(
    ctx.hasAttribute("data-held") && ctx.hasAttribute("inert"),
    "held copies are inert — their listeners are gone"
  );
  assert.match(root.querySelector(".today-rail").innerHTML, /Week read/);
  assert.equal(root.querySelector("details.brief-around").open, true, "an open fold stays open");
  assert.equal(root.querySelector("#cfocusSlot").innerHTML, "", "an empty slot stays empty");
});

test("the loader's own write releases the hold; an identical write stays quiet, a new one animates", async () => {
  const { hold, document } = loadSlotHold();
  const root = createHost(document, { html: FRAME() });
  root.querySelector("#ctxEvents").innerHTML = `<div class="ctx reveal">Lisbon</div>`;
  root.querySelector("#cfocusSlot").innerHTML = `<div class="thread">Block thread</div>`;
  const snapshot = hold.capture(root);
  root.innerHTML = FRAME();
  hold.apply(root, snapshot);

  const ctx = root.querySelector("#ctxEvents");
  const cfocus = root.querySelector("#cfocusSlot");
  ctx.innerHTML = `<div class="ctx reveal">Lisbon</div>`; // same card back
  cfocus.innerHTML = `<div class="thread">A new thread</div>`; // a real change
  await flush();

  assert.equal(ctx.hasAttribute("data-held"), false, "released");
  assert.equal(ctx.hasAttribute("inert"), false);
  assert.ok(ctx.classList.contains("slot-quiet"), "an unchanged card never re-plays its entrance");
  assert.equal(cfocus.hasAttribute("data-held"), false);
  assert.equal(cfocus.classList.contains("slot-quiet"), false, "a changed card animates as designed");

  ctx.innerHTML = `<div class="ctx reveal">Porto next</div>`;
  await flush();
  assert.equal(ctx.classList.contains("slot-quiet"), false, "the next genuine change gets its entrance back");
});

test("a held slot nobody writes back expires into the empty slot it would have been", async () => {
  const { hold, document, timers } = loadSlotHold();
  const root = createHost(document, { html: FRAME() });
  root.querySelector("#ctxEvents").innerHTML = `<div>stale</div>`;
  const snapshot = hold.capture(root);
  root.innerHTML = FRAME();
  hold.apply(root, snapshot);
  assert.equal(hold.heldCount(root), 1);
  timers.tick(hold.EXPIRE_MS + 1);
  assert.equal(root.querySelector("#ctxEvents").innerHTML, "");
  assert.equal(hold.heldCount(root), 0);
});

test("a card that counts up or grows late is still the SAME card: quiet, and its numbers snap", async () => {
  const { hold, document } = loadSlotHold();
  const root = createHost(document, { html: FRAME() });
  // What the athlete saw: the numeral already counted up, the wins already inserted.
  root.querySelector("#ctxEvents").innerHTML =
    `<div class="wearstrip reveal"><span class="wear-n" data-cu="8421" data-cufmt="k">8,421</span>` +
    `<div class="weekly-wins" data-late><span>Wins</span></div></div>`;
  const snapshot = hold.capture(root);
  root.innerHTML = FRAME();
  hold.apply(root, snapshot);

  const ctx = root.querySelector("#ctxEvents");
  // The loader writes its card the way it always does: "0", no wins yet.
  ctx.innerHTML = `<div class="wearstrip reveal"><span class="wear-n" data-cu="8421" data-cufmt="k">0</span></div>`;
  assert.equal(hold.quiet(ctx.querySelector("[data-cu]")), true, "runCountUps snaps it instead of recounting");
  await flush();
  assert.ok(ctx.classList.contains("slot-quiet"), "no entrance re-played for an unchanged card");
  assert.equal(hold.quiet(ctx.querySelector("[data-cu]")), true, "still quiet until the next genuine write");

  ctx.innerHTML = `<div class="wearstrip reveal"><span class="wear-n" data-cu="9100" data-cufmt="k">0</span></div>`;
  assert.equal(hold.quiet(ctx.querySelector("[data-cu]")), false, "a changed number counts up as designed");
  await flush();
  assert.equal(ctx.classList.contains("slot-quiet"), false);

  const other = createHost(document, { html: FRAME() });
  other.querySelector("#ctxEvents").innerHTML = `<span data-cu="5">5</span>`;
  const snap2 = hold.capture(other);
  other.innerHTML = FRAME();
  hold.apply(other, snap2);
  other.querySelector("#ctxEvents").innerHTML = `<span data-cu="6">0</span>`;
  assert.equal(hold.quiet(other.querySelector("[data-cu]")), false, "a different value is a real change");
});

test("a failed read settles the hold at once: a plain card stays live, one with controls clears", () => {
  const { hold, document } = loadSlotHold();
  const root = createHost(document, { html: FRAME() });
  root.querySelector("#ctxEvents").innerHTML = `<div class="wearstrip">8,421 steps</div>`;
  root.querySelector("#cfocusSlot").innerHTML =
    `<div class="thread"><button type="button">Plan the week</button></div>`;
  const snapshot = hold.capture(root);
  root.innerHTML = FRAME();
  hold.apply(root, snapshot);

  const ctx = root.querySelector("#ctxEvents");
  const cfocus = root.querySelector("#cfocusSlot");
  hold.settleFailed(ctx);
  hold.settleFailed(cfocus);
  assert.match(ctx.innerHTML, /8,421 steps/, "a control-free card keeps standing");
  assert.equal(ctx.hasAttribute("inert"), false, "and is live again, not a dead copy");
  assert.equal(cfocus.innerHTML, "", "a card whose buttons lost their listeners never lingers inert");
  assert.equal(hold.heldCount(root), 0, "decided now, not EXPIRE_MS later");
});

test("the hold never covers a slot the agenda moves or the frame paints itself", () => {
  const { hold } = loadSlotHold();
  for (const id of ["attentionLead", "changesLineSlot", "todayFuelSlot", "todayRunSlot", "checkinSlot"]) {
    assert.equal(hold.SLOT_IDS.includes(id), false, `${id} is not held`);
  }
});

// ---------- the fueling follow-through chip ----------

function loadRailLoaders(timers) {
  const win = loadClientModule("today-rail-loaders-client", {
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  return win;
}

function fuelingDeps(document, api) {
  const root = createHost(document, { html: `<div id="fuelingSlot"></div>` });
  const toasts = [];
  const deps = {
    root,
    state: { tab: "today", logDate: "2026-09-29" },
    api,
    activateTab: () => {},
    gotoChatWith: () => {},
    toast: (message) => toasts.push(message),
    escapeHtml: (value) => String(value ?? ""),
    invalidate: () => {},
    refreshToday: async () => {},
    runCountUps: () => {},
  };
  return { deps, slot: root.querySelector("#fuelingSlot"), toasts };
}

test("a fueling tap marks the choice in the same frame, before the network answers, then folds in place", async () => {
  const timers = createFakeTimers();
  const win = loadRailLoaders(timers);
  let answer;
  const posted = new Promise((resolve) => {
    answer = resolve;
  });
  const { deps, slot } = fuelingDeps(win.document, (path) =>
    path === "/nutrition/fueling-followup" ? Promise.resolve({ due: true }) : posted
  );
  await win.CairnTodayRailLoaders.loadFuelingFollowup(deps);

  const steady = slot.querySelector('.fueling-opt[data-energy="2"]');
  const done = steady.click();
  // Same frame: nothing awaited yet.
  assert.ok(steady.classList.contains("is-picked"), "the tapped option is marked at once");
  assert.equal(steady.getAttribute("aria-pressed"), "true");
  assert.ok(
    [...slot.querySelectorAll(".fueling-opt")].every((b) => b.disabled),
    "a second tap cannot double-post"
  );
  assert.match(slot.innerHTML, /How's fueling feeling/, "the card has not been swapped yet");

  timers.tick(500); // the short beat
  await flush();
  assert.match(slot.innerHTML, /fueling-done/, "folds into the acknowledgement while the POST is still out");
  answer({ ok: true });
  await done;
  assert.match(slot.innerHTML, /Noted/);
});

test("a fueling tap on a dead connection is queued, and a refusal brings the options back", async () => {
  const timers = createFakeTimers();
  const win = loadRailLoaders(timers);
  const queued = [];
  win.outboxEnqueue = async (kind, path, body) => {
    queued.push({ kind, path, body });
    return { id: "x" };
  };
  win.CairnApiCache = { isTransientApiFailure: (e) => e && e.kind === "network" };

  const offline = fuelingDeps(win.document, (path) =>
    path === "/nutrition/fueling-followup" ? Promise.resolve({ due: true }) : Promise.reject({ kind: "network" })
  );
  await win.CairnTodayRailLoaders.loadFuelingFollowup(offline.deps);
  const tapOffline = offline.slot.querySelector('.fueling-opt[data-energy="1"]').click();
  timers.tick(500);
  await tapOffline;
  assert.deepEqual(plain(queued), [{ kind: "fueling", path: "/nutrition/fueling-feedback", body: { energy: 1 } }]);
  assert.match(offline.slot.innerHTML, /fueling-done/, "the answer stands — it syncs on reconnect");

  const refused = fuelingDeps(win.document, (path) =>
    path === "/nutrition/fueling-followup"
      ? Promise.resolve({ due: true })
      : Promise.reject({ kind: "http", status: 400 })
  );
  await win.CairnTodayRailLoaders.loadFuelingFollowup(refused.deps);
  const tapRefused = refused.slot.querySelector('.fueling-opt[data-energy="3"]').click();
  timers.tick(500);
  await tapRefused;
  assert.equal(refused.slot.querySelectorAll(".fueling-opt").length, 3, "the options come back");
  assert.equal(refused.slot.querySelector(".fueling-opt.is-picked"), null);
  assert.deepEqual(plain(refused.toasts), ["Couldn't save that — try again."]);
});

test("a fueling read is dated to the day it was asked, and an answered card never enters the instant paint", async () => {
  const timers = createFakeTimers();
  const win = loadRailLoaders(timers);
  win.localISO = () => "2026-09-29";
  const queued = [];
  win.outboxEnqueue = async (kind, path, body) => {
    queued.push({ kind, path, body });
    return { id: "x" };
  };
  win.CairnApiCache = { isTransientApiFailure: (e) => e && e.kind === "network" };
  const { deps, slot } = fuelingDeps(win.document, (path) =>
    path === "/nutrition/fueling-followup" ? Promise.resolve({ due: true }) : Promise.reject({ kind: "network" })
  );
  await win.CairnTodayRailLoaders.loadFuelingFollowup(deps);
  const tap = slot.querySelector('.fueling-opt[data-energy="2"]').click();
  assert.ok(slot.querySelector(".fueling-card").hasAttribute("data-ephemeral"), "picked: left out of the snapshot");
  timers.tick(500);
  await tap;
  assert.deepEqual(plain(queued[0].body), { date: "2026-09-29", energy: 2 }, "a replay after midnight keeps its day");
  assert.ok(slot.querySelector(".fueling-done").hasAttribute("data-ephemeral"), "the acknowledgement is one-off too");
});

test("a failed rail read releases its held card at once", async () => {
  const timers = createFakeTimers();
  const win = loadRailLoaders(timers);
  const settled = [];
  win.CairnTodaySlotHold = { settleFailed: (el) => settled.push(el.id) };
  const { deps } = fuelingDeps(win.document, () => Promise.reject(new Error("offline")));
  await win.CairnTodayRailLoaders.loadFuelingFollowup(deps);
  assert.deepEqual(plain(settled), ["fuelingSlot"]);
});

// ---------- the Brief reconciles in place after a check-in ----------

function loadBriefController({ read, painted }) {
  const document = createDocument();
  const win = loadClientModule(["today-brief-cache-client", "today-brief-controller"], {
    document,
    globals: {
      CairnTodayBrief: {
        provisionalRead: () => ({ kind: "train", headline: "…", _provisional: true }),
        briefHtml: (r) =>
          `<section class="brief"><h2>${r.headline}</h2><div id="checkinSlot" class="checkin-slot"></div></section>`,
        materiallyDiffers: (a, b) => a.headline !== b.headline || a.kind !== b.kind,
        signalsText: () => "",
        kind: (r) => r.kind,
        updatedInnerHtml: () => "",
      },
      CairnTodayBriefActionsClient: {
        wireBriefActions: () => {},
        offlineDismissed: () => false,
        tradeRefusedOn: () => false,
      },
    },
  });
  const root = createHost(document, {
    html: `<div class="today-wrap"><section class="brief"><h2>${painted.headline}</h2><div id="checkinSlot" class="checkin-slot"><div class="checkin-form">form</div></div></section></div>`,
  });
  const calls = { api: [], renders: [] };
  const deps = {
    root,
    state: {
      tab: "today",
      logDate: "2026-09-29",
      brief: { date: "2026-09-29", override: "", read: painted },
      plan: [],
    },
    api: async (path) => {
      calls.api.push(path);
      return read;
    },
    invalidate: () => {},
    renderToday: (opts) => {
      calls.renders.push(opts);
    },
    withViewTransition: (fn) => fn(),
    runOp: async () => null,
    runCountUps: () => {},
    reducedMotion: () => true,
    collapseEl: () => {},
    activateTab: () => {},
    toast: () => {},
    localISO: () => "2026-09-29",
    escapeHtml: (v) => String(v ?? ""),
    loadTrainingProvenance: () => {},
    revealPlanThen: () => {},
    revealSessionComposer: () => {},
    askForSession: () => {},
  };
  return { controller: win.CairnTodayBriefController, deps, root, calls, win };
}

test("a check-in reconciles the Brief in place: same read touches nothing, never a Today rebuild", async () => {
  const same = { kind: "rest", headline: "Today is for resting." };
  const h = loadBriefController({ read: same, painted: same });
  const brief = h.root.querySelector(".brief");
  await h.controller.refreshBriefInPlace(h.deps);
  assert.deepEqual(h.calls.api, ["/today-read?date=2026-09-29&agent=auto"]);
  assert.equal(h.root.querySelector(".brief"), brief, "the Brief node is untouched");
  assert.deepEqual(h.calls.renders, [], "no renderToday");
});

test("a changed read rewrites only the Brief, and carries the check-in node across", async () => {
  const h = loadBriefController({
    painted: { kind: "rest", headline: "Today is for resting." },
    read: { kind: "rest", headline: "Rest, and an easy walk if it feels good." },
  });
  const slot = h.root.querySelector("#checkinSlot");
  await h.controller.refreshBriefInPlace(h.deps);
  assert.match(h.root.querySelector(".brief").textContent, /easy walk/);
  assert.equal(h.root.querySelector("#checkinSlot"), slot, "the same check-in node — marks and listeners intact");
  assert.deepEqual(h.calls.renders, []);
});

test("a changed kind of day earns one QUIET soft repaint; an active steer is left alone", async () => {
  const kind = loadBriefController({
    painted: { kind: "rest", headline: "Rest." },
    read: { kind: "easy", headline: "An easy day." },
  });
  await kind.controller.refreshBriefInPlace(kind.deps);
  assert.deepEqual(plain(kind.calls.renders), [{ soft: true }]);

  const steered = loadBriefController({
    painted: { kind: "easy", headline: "Short." },
    read: { kind: "train", headline: "Go." },
  });
  steered.deps.state.brief.override = "short on time";
  await steered.controller.refreshBriefInPlace(steered.deps);
  assert.deepEqual(steered.calls.api, [], "the steer is not re-asked");
  assert.deepEqual(steered.calls.renders, []);
});

// ---------- view transitions never freeze the screen on a network swap ----------

test("a view transition releases rendering within its frame budget while a slow swap keeps going", async () => {
  const timers = createFakeTimers();
  const win = loadClientModule("ui-view-transitions-client", {
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  let callbackSettled = false;
  win.document.startViewTransition = (cb) => {
    const updateCallbackDone = Promise.resolve(cb()).then(() => {
      callbackSettled = true;
    });
    return { updateCallbackDone, finished: updateCallbackDone, ready: Promise.resolve() };
  };
  const view = win.document.createElement("main");
  const vt = win.CairnUiViewTransitions.create({ view, reducedMotion: () => false });
  let finishSwap;
  const swap = new Promise((resolve) => {
    finishSwap = resolve;
  });
  let whole = false;
  const result = vt
    .withViewTransition(() => swap)
    .then(() => {
      whole = true;
    });

  await flush();
  assert.equal(callbackSettled, false, "inside the budget the transition may hold the frame");
  timers.tick(200);
  await flush();
  assert.equal(callbackSettled, true, "past the budget rendering resumes — the swap is still pending");
  assert.equal(whole, false, "callers still wait for the whole swap");
  finishSwap("painted");
  await result;
  assert.equal(whole, true);
});

// ---------- one app-wide keyboard state ----------

test("the keyboard is up only for a focused text field, real geometry, and no pinch zoom", () => {
  const win = loadClientModule("app-mobile-viewport");
  const { keyboardUpState } = win.CairnKeyboardState;
  assert.equal(keyboardUpState({ geometryOpen: true, textFocused: true, scale: 1 }), true);
  assert.equal(
    keyboardUpState({ geometryOpen: true, textFocused: false, scale: 1 }),
    false,
    "a zoom or toolbar without a field is not a keyboard"
  );
  assert.equal(
    keyboardUpState({ geometryOpen: false, textFocused: true, scale: 1 }),
    false,
    "a focus that summoned no keyboard never moves the bar"
  );
  assert.equal(
    keyboardUpState({ geometryOpen: true, textFocused: true, scale: 1.8 }),
    false,
    "pinch zoom shrinks the viewport like a keyboard"
  );
});

// The focused-field reveal geometry (keyboard, occluders, nested scrollers) lives in
// test/clientFocusReveal.test.js.

// ---------- the SWR soft repaint waits for the athlete's hands ----------

test("a background soft repaint waits while the athlete is touching the screen", async () => {
  const timers = createFakeTimers();
  let now = 1_000_000;
  const clock = { now: () => now };
  const win = loadClientModule("today-data-loader", {
    globals: {
      setTimeout: (fn, ms) =>
        timers.setTimeout(() => {
          now += ms;
          fn();
        }, ms),
      clearTimeout: timers.clearTimeout,
      Date: Object.assign(() => {}, { now: clock.now }),
    },
  });
  const renders = [];
  const root = createHost(win.document, { html: `<div class="today-wrap"></div>` });
  const result = { revalidations: [Promise.resolve()], changed: () => true, token: 1 };
  win.document.dispatchEvent(new win.Event("pointerdown"));
  win.CairnTodayDataLoader.scheduleSoftRepaint(result, {
    root,
    state: { tab: "today" },
    isCurrentPoll: () => true,
    renderToday: (opts) => renders.push(opts),
  });
  // A pointerdown right now (the listener is armed by the first schedule).
  win.document.dispatchEvent(new win.Event("pointerdown"));
  await flush();
  assert.deepEqual(renders, [], "not under a finger that just touched down");
  timers.tick(2000);
  await flush();
  assert.deepEqual(plain(renders), [{ soft: true }], "lands once the hands are off");
});

// ---------- a Today painted for another date never stands in for this one ----------

test("Today stamps each write with its date and never shows another date's Today while this one loads", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/client/today-screen.ts", import.meta.url), "utf8");
  assert.match(source, /todayView\.querySelector\("\.today-wrap"\)\?\.setAttribute\("data-date", enteredDate\)/);
  assert.match(source, /paintedDate && paintedDate !== enteredDate[\s\S]{0,200}todayView\.innerHTML = skeleton\(\)/);
  // The quiet same-date rewrite holds slots only for THIS date's surface.
  assert.match(
    source,
    /const sameDateOnScreen =\s*!!todayView\.querySelector\("\.today-wrap"\) && \(paintedSnapshot \|\| todayPaintedRealFor === enteredDate\)/
  );
});

test("a tap that settles in place re-saves the instant paint, and leaving Today saves first", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/client/today-screen.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(!todayView\.contains\(target\)\) \{\s*if \(todaySnapshotTimer\) saveHydratedNow\(\);/,
    "a click outside Today (it may be leaving) flushes a pending save"
  );
  assert.match(
    source,
    /else if \(target\?\.closest\?\.\("button"\)\) scheduleHydratedSave\(TODAY_SNAPSHOT_TAP_MS\)/,
    "a tap inside Today only reschedules — never serializes on the tap's own path"
  );
  assert.match(source, /visibilityState === "hidden"\) saveHydratedNow\(\)/);
  assert.match(source, /querySelectorAll\("\[data-ephemeral\]"\)\.forEach\(\(el\) => el\.remove\(\)\)/);
});
