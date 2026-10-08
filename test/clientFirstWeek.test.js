// The welcome's first week outside the welcome (first-week-client.ts, eager): while it is
// being built, Today carries one calm card listing the days written so far, updated in
// place as they arrive; when it lands, ONE in-app notice says so and the server's
// one-shot marker is cleared; a person who closed the app meanwhile hears it once on the
// next open; the welcome itself watching it land says nothing more; and once the server
// says there is nothing to follow, the device stops asking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeTimers, createHost, createStorage, fire, flush, loadClientModule } from "./_dom.mjs";

const DAYS = [
  { dow: 1, day_number: 1, name: "Lower" },
  { dow: 3, day_number: 2, name: "Upper <b>push</b>" },
  { dow: 5, day_number: 3, name: "Full body" },
];

function setup({ status, welcomeOpen = false, done = false } = {}) {
  const timers = createFakeTimers();
  const rec = { apis: [], toasts: [], tabs: [], rendered: [], invalidated: [] };
  const server = { status: status ?? { state: "none", job_id: null, days: [], week_state: null, final: true } };
  const win = loadClientModule(["html-utils", "first-week-client"], {
    globals: {
      ...timers,
      api: async (path, opts) => {
        rec.apis.push(`${opts?.method ?? "GET"} ${path}`);
        if (path === "/welcome/first-week") return server.status;
        if (path === "/welcome/first-week/seen") {
          server.status = { state: "none", job_id: null, days: [], week_state: null, final: true };
          return server.status;
        }
        throw new Error(`unexpected ${path}`);
      },
      toast: (message, opts) => rec.toasts.push({ message, action: opts?.action ?? null, onAction: opts?.onAction }),
      activateTab: (name) => rec.tabs.push(name),
      renderTab: (tab) => rec.rendered.push(tab),
      CairnWriteInvalidation: { invalidateWrite: (name) => rec.invalidated.push(name) },
      CairnWelcome: { isOpen: () => welcomeOpen },
      state: { tab: "today" },
      localStorage: createStorage(done ? { "cairn.firstWeek.done": "1" } : {}),
    },
  });
  return { win, timers, rec, server };
}

async function settle(times = 4) {
  for (let i = 0; i < times; i++) await flush();
}

// Today's lead, as today-main-shell-client.ts writes it: the slot comes from slotHtml().
function today(ctx) {
  return createHost(ctx.win.document, { html: ctx.win.CairnFirstWeek.slotHtml() });
}

const rows = (host) => [...host.querySelectorAll(".fw-day")].map((li) => li.textContent);

test("Today's card lists the days as they arrive, in place, then the one notice says it is ready", async () => {
  const ctx = setup({ status: { state: "building", job_id: 7, days: [], week_state: null, final: false } });
  let host = today(ctx);
  assert.deepEqual(ctx.rec.apis, [], "painting the slot never asks: the boot's /agent-jobs list carries the status");
  ctx.win.CairnFirstWeek.ingest(ctx.server.status);
  await settle();
  assert.match(host.textContent, /Your first week is coming together/);
  assert.match(host.textContent, /first days are on their way/);
  assert.equal(ctx.win.CairnFirstWeek.building(), true);

  ctx.server.status = { ...ctx.server.status, days: DAYS.slice(0, 1) };
  ctx.timers.tick(4000);
  await settle();
  assert.deepEqual(rows(host), ["MonLower"]);
  const first = host.querySelector(".fw-day");

  ctx.server.status = { ...ctx.server.status, days: DAYS.slice(0, 2) };
  ctx.timers.tick(4000);
  await settle();
  assert.deepEqual(rows(host), ["MonLower", "WedUpper <b>push</b>"], "a name is text, never markup");
  assert.equal(host.querySelector(".fw-day"), first, "an arrived day is not re-painted");
  assert.equal(host.querySelector(".fw-day b"), null);
  assert.equal(host.querySelector("[data-fw-see]"), null, "read-only while it is built");
  assert.equal(ctx.rec.toasts.length, 0, "nothing is said while it is being built");

  // Today re-renders mid-build: the fresh slot paints straight from what is known.
  host = today(ctx);
  assert.deepEqual(rows(host), ["MonLower", "WedUpper <b>push</b>"]);

  ctx.server.status = { state: "ready", job_id: 7, days: DAYS, week_state: "applied", final: false };
  ctx.timers.tick(4000);
  await settle();
  assert.deepEqual(
    ctx.rec.toasts.map((t) => [t.message, t.action]),
    [["Your first week is ready", "See it"]]
  );
  assert.ok(ctx.rec.apis.includes("POST /welcome/first-week/seen"), "the one-shot marker is cleared");
  assert.ok(ctx.rec.invalidated.includes("proposal_apply"), "the plan reads it makes stale are dropped");
  assert.deepEqual(ctx.rec.rendered, ["today"]);
  assert.match(host.textContent, /Your first week is ready/);
  assert.equal(rows(host).length, 3);

  ctx.rec.toasts[0].onAction();
  assert.deepEqual(ctx.rec.tabs, ["train"], "the tap opens Train");
  assert.equal(host.querySelector(".fw-card"), null, "the card has done its job");

  const asked = ctx.rec.apis.length;
  ctx.timers.tick(60000);
  await settle();
  assert.equal(ctx.rec.apis.length, asked, "nothing polls once nothing is building");
  assert.equal(ctx.rec.toasts.length, 1, "said once");
});

test("a week that landed while the app was closed is said once on the next open, wherever it opened", async () => {
  const ctx = setup({ status: { state: "ready", job_id: 3, days: DAYS, week_state: "draft", final: false } });
  ctx.win.CairnFirstWeek.ingest(ctx.server.status); // the boot's /agent-jobs list carried it
  await settle();
  assert.equal(ctx.rec.toasts.length, 1);
  assert.equal(ctx.rec.toasts[0].message, "Your first week is ready");
  assert.deepEqual(ctx.rec.rendered, [], "it was not built in front of us: nothing to repaint");
  ctx.rec.toasts[0].onAction();
  assert.deepEqual(ctx.rec.tabs, ["today"], "a drafted week waits for its yes on Today");

  // The next open: the server has nothing owed, so the device stops asking.
  const next = setup({ status: ctx.server.status });
  next.win.CairnFirstWeek.ingest(next.server.status);
  await settle();
  assert.equal(next.rec.toasts.length, 0);
  assert.equal(next.win.localStorage.getItem("cairn.firstWeek.done"), "1");
  const again = setup({ done: true });
  again.timers.tick(5000);
  today(again);
  await settle();
  assert.deepEqual(again.rec.apis, [], "a device that knows there is nothing to follow never asks");
});

test("the welcome watching it land says nothing more, and a failed week is said calmly once", async () => {
  const open = setup({
    welcomeOpen: true,
    status: { state: "ready", job_id: 5, days: DAYS, week_state: "applied", final: false },
  });
  open.win.CairnFirstWeek.ingest(open.server.status);
  await settle();
  assert.equal(open.rec.toasts.length, 0, "no notice over the welcome that showed it");
  assert.ok(open.rec.apis.includes("POST /welcome/first-week/seen"));

  const failed = setup({ status: { state: "failed", job_id: 6, days: [], week_state: "failed", final: false } });
  failed.win.CairnFirstWeek.ingest(failed.server.status);
  await settle();
  assert.equal(failed.rec.toasts.length, 1);
  assert.match(failed.rec.toasts[0].message, /couldn't put your first week together/);
  assert.equal(failed.rec.toasts[0].action, null);
});

test("leaving the welcome mid-week starts the card at once, and 'See it' on the card opens Train", async () => {
  const ctx = setup({ done: true });
  ctx.server.status = { state: "building", job_id: 9, days: DAYS.slice(0, 1), week_state: null, final: false };
  ctx.win.CairnFirstWeek.track();
  assert.equal(ctx.win.localStorage.getItem("cairn.firstWeek.done"), null, "a new week to follow");
  await settle();
  const host = today(ctx);
  assert.deepEqual(rows(host), ["MonLower"]);
  ctx.server.status = { state: "ready", job_id: 9, days: DAYS, week_state: "announced", final: false };
  ctx.timers.tick(4000);
  await settle();
  await fire(host.querySelector("[data-fw-see]"), "click");
  assert.deepEqual(ctx.rec.tabs, ["train"]);
});
