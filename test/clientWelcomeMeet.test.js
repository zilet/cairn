// The welcome's Meet stage, driven (welcome-meet-controller.ts + welcome-meet-run.ts):
// the coach's reply and the starting fuel paint the moment the job's phase meta carries
// them — before the week — and the week arrives last; the person can leave while the
// week composes and the job keeps running (the week then refreshes Today); a job a
// restart interrupted says so calmly and Try again re-sends the same words, whether the
// stream, a poll, or a reload is what finds out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeTimers, createHost, fire, flush, loadClientModule } from "./_dom.mjs";

const MODULES = [
  "html-utils",
  "ui-stone-model",
  "ui-stone",
  "welcome-model",
  "welcome-client",
  "welcome-meet-run",
  "welcome-meet-controller",
  "first-week-client",
];
const PROVIDER = {
  name: "claude",
  label: "Claude",
  plan: "Claude Pro or Max",
  usable: true,
  present: true,
  installable: true,
  canLogin: true,
  configured: true,
  signedIn: true,
};
const REPLY =
  "Longevity, muscle and staying supple: a good, durable aim. Two or three sessions a week is plenty to build on.";
const WORDS = "General longevity, keeping muscle mass, staying movable, flexible.. 2-3 times a week";

function setup({ list = [], jobs = {}, stored = null } = {}) {
  const timers = createFakeTimers();
  const rec = { enqueued: [], streams: [], torn: 0, apis: [], invalidated: [], rendered: [], skipped: 0, toasts: [] };
  // The app's first-week status (GET /api/welcome/first-week), as the test sets it.
  const firstWeek = { status: { state: "none", job_id: null, days: [], week_state: null, final: true } };
  const win = loadClientModule(MODULES, {
    globals: {
      ...timers,
      reducedMotion: () => true,
      matchMedia: () => ({ matches: false }),
      api: async (path) => {
        rec.apis.push(path);
        if (path === "/agent-jobs") return { ok: true, jobs: list };
        if (path === "/welcome/first-week") return firstWeek.status;
        if (path === "/welcome/first-week/seen") {
          firstWeek.status = { ...firstWeek.status, state: "none", final: true };
          return firstWeek.status;
        }
        const m = /^\/agent-jobs\/(\d+)$/.exec(path);
        if (m) return { ok: true, job: jobs[m[1]] ?? null };
        throw new Error(`unexpected ${path}`);
      },
      enqueueJob: async (path, body) => {
        rec.enqueued.push({ path, body });
        return { ok: true, job: { id: 41 + rec.enqueued.length } };
      },
      openJobStream: (id, handlers) => rec.streams.push({ id, handlers }),
      teardownJobs: () => {
        rec.torn += 1;
      },
      thinkingCaption: (el, script) => {
        if (el) el.textContent = `(${script})`;
        return () => {};
      },
      CairnCoachLink: { invalidate: () => rec.invalidated.push("coach-link") },
      CairnWriteInvalidation: { invalidateWrite: (name) => rec.invalidated.push(name) },
      renderTab: (tab) => rec.rendered.push(tab),
      toast: (message, opts) => rec.toasts.push({ message, action: opts?.action ?? null }),
      state: { tab: "today" },
    },
  });
  if (stored) win.localStorage.setItem("cairn.welcome.job", JSON.stringify(stored));
  const host = createHost(win.document, { html: win.CairnWelcomeClient.meetHtml(PROVIDER) });
  const unmount = win.CairnWelcomeMeet.mount(host, {
    provider: PROVIDER,
    onReconnect: () => {},
    onDone: () => {},
    onSkip: () => {
      rec.skipped += 1;
    },
  });
  return { win, host, timers, rec, unmount, jobs, firstWeek };
}

async function settle(times = 4) {
  for (let i = 0; i < times; i++) await flush();
}

async function send(ctx, text = WORDS) {
  const input = ctx.host.querySelector(".wel-text");
  input.value = text;
  await fire(ctx.host.querySelector(".wel-compose"), "submit");
  await settle();
}

// The log, in order, as short tokens: what a person sees from the top down.
function transcript(host) {
  return [...host.querySelector(".wel-log").children].map((el) => {
    if (el.matches(".is-you")) return "you";
    if (el.matches(".is-fail")) return "fail";
    if (el.matches(".is-working")) return `working:${el.getAttribute("data-wel-working")}`;
    if (el.matches("[data-wel-fuel]")) return "fuel";
    if (el.matches(".wel-reveal")) return "week";
    return el.textContent.includes(REPLY) ? "reply" : "coach";
  });
}

const fuelPhase = { status: "running", meta: { step: "fuel", reply: REPLY } };
const weekPhase = {
  status: "running",
  meta: {
    step: "week",
    reply: REPLY,
    fuel: { target_kcal: 2210, protein_g: 150 },
    fuel_state: "set",
    detail: "composing your first week",
  },
};
const result = {
  ok: true,
  reply: REPLY,
  week: [
    { dow: 1, day_number: 1, name: "Full body A" },
    { dow: 4, day_number: 2, name: "Full body B" },
  ],
  week_state: "applied",
  fuel: { target_kcal: 2210, protein_g: 150 },
  fuel_state: "set",
};

test("the reply, then the fuel, paint as they land — the week comes last, and nothing repeats", async () => {
  const ctx = setup();
  await settle();
  await send(ctx);
  assert.deepEqual(
    ctx.rec.enqueued.map((e) => e.body.text),
    [WORDS]
  );
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "working:understand"]);
  const [{ handlers }] = ctx.rec.streams;

  handlers.onPhase(fuelPhase);
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "reply"], "the reply is its own bubble the moment it exists");

  handlers.onPhase(weekPhase);
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "reply", "fuel", "working:week"]);
  const fuel = ctx.host.querySelector("[data-wel-fuel]");
  assert.match(fuel.textContent, /About 2,200 kcal a day, with around 150 g of protein/);
  assert.match(fuel.textContent, /yours to change anytime/);
  assert.doesNotMatch(fuel.textContent, /score|\/100|%/);
  assert.match(
    ctx.host.querySelector(".is-working .wel-cap").textContent,
    /Composing your first week/,
    "the composer's words show as the second line"
  );
  assert.ok(ctx.host.querySelector("[data-wel-leave]"), "the person can go and look around while the week composes");
  assert.equal(ctx.host.querySelector(".wel-compose"), null, "the composer gives way while the week is built");

  handlers.onPhase(weekPhase); // a repeat snapshot changes nothing
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "reply", "fuel", "working:week"]);

  handlers.onDone(result);
  assert.deepEqual(
    transcript(ctx.host),
    ["coach", "you", "reply", "fuel", "week"],
    "the week replaces the working line, after the fuel"
  );
  assert.equal(ctx.host.querySelectorAll(".wel-reveal .wel-wk").length, 2);
  assert.equal(ctx.host.querySelector(".wel-reveal #welFuelH"), null, "the fuel is not said twice");
  assert.ok(ctx.host.querySelector("[data-wel-today]"));
  assert.ok(ctx.rec.invalidated.includes("proposal_apply"), "the plan reads the week makes stale are dropped");
});

test("a result with no live phases still paints reply, fuel, then week", async () => {
  const ctx = setup();
  await settle();
  await send(ctx);
  ctx.rec.streams[0].handlers.onDone(result);
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "reply", "fuel", "week"]);
});

test("an interrupted job says so calmly, and Try again re-sends the same words on a clean slate", async () => {
  const ctx = setup();
  await settle();
  await send(ctx);
  const { handlers } = ctx.rec.streams[0];
  handlers.onPhase(weekPhase);
  handlers.onError("interrupted by a restart");
  const fail = ctx.host.querySelector(".is-fail");
  assert.match(fail.textContent, /interrupted/);
  assert.doesNotMatch(fail.textContent, /went wrong|error/i);
  assert.ok(ctx.host.querySelector(".wel-compose"), "the composer is back");
  assert.equal(ctx.host.querySelector(".is-working"), null, "no spinner left behind");

  await fire(fail.querySelector("[data-wel-retry]"), "click");
  await settle();
  assert.deepEqual(
    ctx.rec.enqueued.map((e) => e.body.text),
    [WORDS, WORDS],
    "the same words, again"
  );
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "working:understand"], "the cut-short run is cleared");
});

test("when the stream goes quiet for good, a light read still finds the interruption — no spinner forever", async () => {
  const ctx = setup();
  await settle();
  await send(ctx);
  ctx.jobs["42"] = { id: 42, kind: "welcome", status: "error", error: "interrupted by a restart" };
  ctx.timers.tick(15000);
  await settle();
  assert.match(ctx.host.querySelector(".is-fail").textContent, /interrupted/);
  assert.equal(ctx.host.querySelector(".is-working"), null);
});

test("leaving while the week composes keeps the job; the app's first-week card follows it and Today refreshes once it lands", async () => {
  const ctx = setup();
  await settle();
  await send(ctx);
  ctx.rec.streams[0].handlers.onPhase(weekPhase);
  ctx.firstWeek.status = { state: "building", job_id: 42, days: [], week_state: null, final: false };
  await fire(ctx.host.querySelector("[data-wel-leave]"), "click");
  assert.equal(ctx.rec.skipped, 1, "the welcome closes (marked onboarded)");
  ctx.unmount();
  await settle();
  assert.ok(!ctx.rec.apis.some((p) => /cancel/.test(p)), "nothing stops the job");
  assert.equal(ctx.win.CairnFirstWeek.building(), true, "the app now follows the week");

  ctx.firstWeek.status = { ...ctx.firstWeek.status, days: [result.week[0]] };
  ctx.timers.tick(4000);
  await settle();
  assert.equal(ctx.rec.rendered.length, 0, "nothing repaints while the week is still composing");
  assert.equal(ctx.rec.toasts.length, 0);

  ctx.firstWeek.status = { state: "ready", job_id: 42, days: result.week, week_state: "applied", final: false };
  ctx.timers.tick(4000);
  await settle();
  assert.ok(ctx.rec.invalidated.includes("proposal_apply"));
  assert.deepEqual(ctx.rec.rendered, ["today"], "Today repaints with the week on it");
  assert.deepEqual(ctx.rec.toasts, [{ message: "Your first week is ready", action: "See it" }], "said once, in-app");
  assert.ok(ctx.rec.apis.includes("/welcome/first-week/seen"), "and marked said, so the next open stays quiet");
});

test("streamed days paint as rows under the working line, each once, before the week is done", async () => {
  const ctx = setup();
  await settle();
  await send(ctx);
  const { handlers } = ctx.rec.streams[0];
  handlers.onPhase(weekPhase);
  assert.equal(ctx.host.querySelector(".wel-week-live"), null, "no list until a day exists");
  const one = { ...weekPhase.meta, days_so_far: [result.week[0]] };
  handlers.onPhase({ status: "running", meta: one });
  const rows = () => [...ctx.host.querySelectorAll(".is-working .wel-week-live .wel-wk")].map((li) => li.textContent);
  assert.deepEqual(rows(), ["MonFull body A"]);
  const first = ctx.host.querySelector(".wel-week-live .wel-wk");
  handlers.onPhase({ status: "running", meta: { ...one, days_so_far: result.week } });
  assert.deepEqual(rows(), ["MonFull body A", "ThuFull body B"]);
  assert.equal(ctx.host.querySelector(".wel-week-live .wel-wk"), first, "a day already shown is not painted again");
  handlers.onPhase({ status: "running", meta: { ...one, days_so_far: result.week } });
  assert.equal(rows().length, 2, "a repeat snapshot adds nothing");
  assert.ok(
    ctx.host.querySelector(".wel-week-live").innerHTML.includes("Full body B"),
    "rows are escaped text from the meta"
  );
  handlers.onDone(result);
  assert.equal(ctx.host.querySelector(".wel-week-live"), null, "the reveal replaces the preview");
  assert.equal(ctx.host.querySelectorAll(".wel-reveal .wel-wk").length, 2);
  assert.ok(ctx.rec.apis.includes("/welcome/first-week/seen"), "watched land here: the app says nothing more");
});

test("a reload mid-week re-attaches and repaints what already landed from the job's meta", async () => {
  const ctx = setup({
    list: [{ id: 7, kind: "welcome", status: "running", input: { text: WORDS }, meta: weekPhase.meta }],
  });
  await settle();
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "reply", "fuel", "working:week"]);
  assert.equal(ctx.rec.streams[0].id, "7");
  assert.ok(ctx.host.querySelector("[data-wel-leave]"));
});

test("a reload after a restart names the interruption and offers Try again with the same words", async () => {
  const ctx = setup({
    stored: { id: "9", text: WORDS },
    jobs: { 9: { id: 9, kind: "welcome", status: "error", error: "interrupted by a restart" } },
  });
  await settle();
  assert.deepEqual(transcript(ctx.host), ["coach", "you", "fail"]);
  await fire(ctx.host.querySelector("[data-wel-retry]"), "click");
  await settle();
  assert.deepEqual(
    ctx.rec.enqueued.map((e) => e.body.text),
    [WORDS]
  );
});
