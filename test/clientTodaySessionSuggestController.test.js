import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function decodeAttr(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set(
      String(owner.className || "")
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  add(...names) {
    for (const name of names) if (name) this.names.add(name);
    this.sync();
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
    this.sync();
  }

  contains(name) {
    return this.names.has(name);
  }

  sync() {
    this.owner.className = [...this.names].join(" ");
  }
}

class FakeStyle {
  constructor() {
    this.removed = [];
  }

  removeProperty(name) {
    this.removed.push(name);
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this.dataset = { ...(attrs.dataset || {}) };
    this.value = attrs.value || "";
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this._innerHTML = "";
    this.focusCount = 0;
    this.scrolls = [];
    this.attributes = new Map();
    this.disabled = false;
    this.textContent = attrs.textContent || "";
  }

  get isConnected() {
    return Boolean(this.parentElement);
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes("sug-card")) this.addChild(new FakeElement("section", { className: "sug-card" }));
    if (this._innerHTML.includes("sug-save-status"))
      this.addChild(new FakeElement("div", { className: "sug-save-status" }));
    if (this._innerHTML.includes("job-cap")) this.addChild(new FakeElement("div", { className: "job-cap" }));
    if (this._innerHTML.includes("sug-prompt")) this.addChild(new FakeElement("input", { className: "sug-prompt" }));
    if (this._innerHTML.includes("data-sugbuild"))
      this.addChild(new FakeElement("button", { dataset: { sugbuild: "" } }));
    if (this._innerHTML.includes("data-sugcancel"))
      this.addChild(new FakeElement("button", { dataset: { sugcancel: "" } }));
    for (const match of this._innerHTML.matchAll(/data-vibe="([^"]*)"/g)) {
      this.addChild(new FakeElement("button", { dataset: { vibe: decodeAttr(match[1]) } }));
    }
    for (const match of this._innerHTML.matchAll(/data-sugaction="([^"]*)"/g)) {
      this.addChild(new FakeElement("button", { dataset: { sugaction: decodeAttr(match[1]) } }));
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({ target: this, currentTarget: this, preventDefault() {}, key: undefined, ...event });
    }
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.focusCount += 1;
  }

  scrollIntoView(options) {
    this.scrolls.push(options);
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === "[data-sugbuild]") return Object.hasOwn(this.dataset, "sugbuild");
    if (selector === "[data-sugcancel]") return Object.hasOwn(this.dataset, "sugcancel");
    if (selector === "[data-vibe]") return Object.hasOwn(this.dataset, "vibe");
    if (selector === "[data-sugaction]") return Object.hasOwn(this.dataset, "sugaction");
    return false;
  }

  querySelector(selector) {
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    if (this.matches(selector)) out.push(this);
    for (const child of this.children) out.push(...child.querySelectorAll(selector));
    return out;
  }
}

function loadController({ reduced = false } = {}) {
  const rootEl = new FakeElement("section");
  const slot = rootEl.addChild(new FakeElement("div", { id: "sugSlot" }));
  const requests = [];
  const captions = [];
  const countUps = [];
  const collapses = [];
  const toasts = [];
  const appended = [];
  const reveals = [];
  const context = {
    Element: FakeElement,
    HTMLElement: FakeElement,
    Object,
    Promise,
    String,
    window: null,
    globalThis: null,
    setTimeout: (fn) => fn(),
    CairnTodaySessionSuggest: {
      composerHtml: () =>
        `<div class="sug-composer"><input class="sug-prompt"><button data-vibe="upper body"></button><button data-sugbuild></button><button data-sugcancel></button></div>`,
      loadingHtml: () => `<div class="sug-card sug-loading"><div class="job-cap"></div></div>`,
      cardHtml: (session) =>
        `<section class="sug-card"><h3>${session?.name || "Session"}</h3><button data-sugaction="use">Use this session</button><button data-sugaction="dismiss"></button><div class="sug-save-status"></div></section>`,
      failureHtml: () => `<section class="sug-card"><button data-sugaction="retry"></button></section>`,
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-suggest-controller.js"), "utf8"), context);
  const deps = {
    root: rootEl,
    state: { logDate: "2026-06-30", suggestedSession: null },
    api: async (path, options) => {
      requests.push({ path, options });
      return {
        ok: true,
        daily_session: { id: 9, date: "2026-06-30", source: "agent_suggest", items: [] },
        session: { id: 4, date: "2026-06-30", daily_session: { id: 9 } },
      };
    },
    storeCached: (key, data) => requests.push({ store: key, data }),
    invalidate: (key) => requests.push({ invalidate: key }),
    openSession: async (date, options) => {
      requests.push({ openSession: date, options });
      return true;
    },
    runOp: async (kind, body, options) => {
      requests.push({ kind, body, options });
      return { queued: true };
    },
    thinkingCaption: (el, op) => {
      captions.push({ el, op });
      return () => captions.push({ stopped: true });
    },
    runCountUps: (el) => countUps.push(el),
    collapseEl: (el, done) => {
      collapses.push(el);
      if (done) done();
    },
    reducedMotion: () => reduced,
    toast: (message) => toasts.push(message),
  };
  return {
    controller: context.CairnTodaySessionSuggestController,
    rootEl,
    slot,
    deps,
    requests,
    captions,
    countUps,
    collapses,
    toasts,
    appended,
    reveals,
  };
}

test("Today session-suggest controller submits composer constraints and guards duplicates", async () => {
  const harness = loadController();

  harness.controller.revealSessionComposer(harness.deps);
  const input = harness.slot.querySelector(".sug-prompt");
  assert.equal(input.focusCount, 1);
  harness.slot.querySelector("[data-vibe]").click();
  assert.equal(input.value, "upper body");

  harness.slot.querySelector("[data-sugbuild]").click();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].kind, "session_suggest");
  // train_anyway rides with every PWA ask: tapping "ask for a session" IS the
  // intent to train, and it has to be on the JOB for acceptance to keep the
  // movements on a rest day (a no-op on a train day).
  assert.deepEqual(plain(harness.requests[0].body), {
    date: "2026-06-30",
    train_anyway: true,
    constraints: "upper body",
  });
  assert.match(harness.slot.innerHTML, /sug-loading/);

  await harness.controller.askForSession({}, harness.deps);
  assert.deepEqual(harness.toasts, ["Already drafting a session…"]);
});

test("Today session-suggest controller persists the full suggestion before opening Session", async () => {
  const harness = loadController({ reduced: true });
  const options = harness.controller.sessionSuggestOpOpts(harness.deps);

  options.render(
    {
      ok: true,
      verified: { checked: true },
      session: {
        name: "Quick upper",
        focus: "Push",
        why: "Fresh upper body",
        est_minutes: 35,
        items: [
          { exercise: "Push-up", sets: 2, rep_low: 8, rep_high: 12, target_weight: 20, note: "smooth" },
          { exercise: "Dead hang", mode: "timed", sets: 2, target_seconds: 45 },
        ],
      },
      agent: "codex",
      tried: ["codex"],
    },
    { id: 145 }
  );

  assert.equal(harness.deps.state.suggestedSession.name, "Quick upper");
  assert.equal(harness.countUps[0], harness.slot);
  assert.deepEqual(plain(harness.slot.scrolls[0]), { behavior: "auto", block: "nearest" });

  const use = harness.slot.querySelectorAll("[data-sugaction]").find((button) => button.dataset.sugaction === "use");
  use.click();
  await new Promise((resolve) => setImmediate(resolve));

  const open = harness.requests.find((request) => request.openSession === "2026-06-30");
  assert.equal(open.options.source, "agent_suggest");
  assert.equal(open.options.agentJobId, 145);
  assert.deepEqual(plain(open.options.constraints), {});
  assert.deepEqual(plain(open.options.provenance), {
    verification: "verified_agent_job",
    operation: "session_suggest",
    agent_job_id: 145,
    agent: "codex",
    tried: ["codex"],
    verified: { checked: true },
  });
  assert.equal(open.options.replace, true);
  assert.equal(Object.hasOwn(open.options, "session"), false, "server reloads the canonical job result");
  assert.equal(
    harness.requests.some((request) => request.path === "/daily-session/prepare"),
    false
  );
  assert.deepEqual(plain(harness.reveals), []);
  assert.deepEqual(plain(harness.appended), []);
  assert.equal(harness.deps.state.suggestedSession, null);
  assert.deepEqual(harness.toasts, ["Saved for today — it will be here when you come back"]);
  assert.equal(harness.slot.innerHTML, "");
});

test("Today session-suggest save failure retains the complete actionable card", async () => {
  const harness = loadController();
  harness.deps.openSession = async () => {
    harness.toasts.push("Already logging a different session.");
    return false;
  };
  const options = harness.controller.sessionSuggestOpOpts(harness.deps, { constraints: "30 minutes" });
  options.render({
    ok: true,
    session: {
      name: "Short strength",
      why: "Fits the time available",
      items: [{ exercise: "Deadlift", sets: 3, rep_low: 4, rep_high: 6, target_weight: 205 }],
    },
  });

  const use = harness.slot.querySelectorAll("[data-sugaction]").find((button) => button.dataset.sugaction === "use");
  use.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.deps.state.suggestedSession.name, "Short strength");
  assert.match(harness.slot.innerHTML, /Short strength/);
  assert.equal(use.disabled, false);
  assert.equal(use.dataset.busy, "");
  assert.deepEqual(harness.toasts, ["Already logging a different session."]);
});

test("daily-session prepare coordinator serializes a date and marks an older result stale", async () => {
  const harness = loadController();
  const coordinator = harness.controller.createPrepareCoordinator();
  const order = [];
  let finishFirst;
  const first = coordinator.run(
    "2026-06-30",
    () =>
      new Promise((resolve) => {
        order.push("first-start");
        finishFirst = () => resolve("first");
      })
  );
  const second = coordinator.run("2026-06-30", async () => {
    order.push("second-start");
    return "second";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"], "newer intent waits so it lands last on the server");
  finishFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "second-start"]);
  assert.equal(firstResult.current, false, "older response cannot enter or paint");
  assert.equal(secondResult.current, true);
  assert.equal(secondResult.value, "second");
});

test("daily-session prepare coordinator lets only the newest cross-date intent become authoritative", async () => {
  const harness = loadController();
  const coordinator = harness.controller.createPrepareCoordinator();
  let finishFirst;
  const first = coordinator.run(
    "2026-06-30",
    () => new Promise((resolve) => {
      finishFirst = () => resolve("older-date");
    })
  );
  const second = coordinator.run("2026-07-01", async () => "newer-date");

  const secondResult = await second;
  finishFirst();
  const firstResult = await first;

  assert.equal(secondResult.current, true);
  assert.equal(secondResult.value, "newer-date");
  assert.equal(firstResult.current, false, "a late response for another date cannot navigate or paint");
});

test("cached active composition reopens only for a continuation, never an explicit replacement", () => {
  const harness = loadController();
  const daily = { id: 8, status: "active", session_id: 4, source: "athlete_override", items: [] };
  const session = { id: 4, date: "2026-06-30", sets: [], daily_session: daily };

  const continuation = harness.controller.cachedContinuation(session, null, false);
  assert.equal(continuation.reused, true);
  assert.equal(continuation.staged, false);
  assert.equal(continuation.daily_session.id, 8);
  assert.equal(continuation.session.daily_session.id, 8);
  assert.equal(harness.controller.cachedContinuation(session, null, true), null);
  assert.equal(
    harness.controller.cachedContinuation(null, daily, false),
    null,
    "offline reopen needs the paired cached log session"
  );
});

test("offline staged preparation uses a local pairing identity and never fabricates server IDs", () => {
  const harness = loadController();
  const request = {
    date: "2026-06-30",
    source: "manual_plan",
    day_number: 2,
    replace: true,
    constraints: {},
    provenance: { entry: "pwa" },
  };
  const staged = harness.controller.stagedPrepareResponse({
    date: request.date,
    request,
    plan: [{
      id: 22,
      day_number: 2,
      name: "Upper",
      focus: "Push",
      items: [{ exercise: "Bench", sets: 3, rep_low: 5, rep_high: 8 }],
    }],
    selectedDay: 2,
    localPrepareId: "outbox-prepare-1",
  });

  assert.equal(staged.staged, true);
  assert.equal(staged.session._local_prepare_id, "outbox-prepare-1");
  assert.equal(staged.daily_session._local_prepare_id, "outbox-prepare-1");
  assert.equal(staged.session.daily_session._local_prepare_id, "outbox-prepare-1");
  assert.equal(Object.hasOwn(staged.session, "id"), false);
  assert.equal(Object.hasOwn(staged.daily_session, "id"), false);
  assert.equal(Object.hasOwn(staged.daily_session, "session_id"), false);
  assert.deepEqual(plain(staged.daily_session.items), [
    { exercise: "Bench", sets: 3, rep_low: 5, rep_high: 8, position: 0 },
  ]);
  const continued = harness.controller.cachedContinuation(
    staged.session,
    staged.daily_session,
    false,
    (id) => id === "outbox-prepare-1",
  );
  assert.equal(continued.staged, true);
  assert.equal(
    harness.controller.cachedContinuation(staged.session, staged.daily_session, false, () => false),
    null,
    "a staged cache without its live prepare prerequisite is a refused phantom",
  );
  assert.equal(
    harness.controller.cachedContinuation(
      { ...staged.session, _local_prepare_id: "different" },
      staged.daily_session,
      false
    ),
    null,
    "a staged composition can only reopen with its paired staged session"
  );
});

test("offline recovery freezes the accepted composition and its full context as an athlete override", () => {
  const harness = loadController();
  const accepted = {
    date: "2026-06-30",
    source: "manual_plan",
    plan_day_id: 22,
    title: "Upper",
    focus: "Push",
    why: "Explicit plan-day override: Day 2.",
    est_minutes: 42,
    constraints: { equipment: ["rack", "bench"], readiness: { shoulder: "easy" } },
    items: [{ position: 0, exercise: "Bench", sets: 3, interval: { work_sec: 30, rest_sec: 60 } }],
  };
  const recovery = harness.controller.snapshotRecovery(accepted, {
    date: accepted.date,
    source: "manual_plan",
    day_number: 2,
    replace: false,
    provenance: { entry: "today_launch" },
  });

  assert.deepEqual(plain(recovery), {
    body: {
      date: accepted.date,
      source: "athlete_override",
      session: {
        name: "Upper",
        focus: "Push",
        why: "Explicit plan-day override: Day 2.",
        est_minutes: 42,
        items: [{ position: 0, exercise: "Bench", sets: 3, interval: { work_sec: 30, rest_sec: 60 } }],
      },
      constraints: { equipment: ["rack", "bench"], readiness: { shoulder: "easy" } },
      provenance: {
        entry: "offline_snapshot_recovery",
        recovered_from_source: "manual_plan",
        plan_day_id: 22,
        recovered_from_entry: "today_launch",
        recovered_origin: {
          source: "manual_plan",
          plan_day_id: 22,
          entry: "today_launch",
        },
      },
      replace: true,
    },
    intent: {
      date: accepted.date,
      source: "athlete_override",
      plan_day_id: null,
      title: "Upper",
      focus: "Push",
      why: "Explicit plan-day override: Day 2.",
      est_minutes: 42,
      items: [{ position: 0, exercise: "Bench", sets: 3, interval: { work_sec: 30, rest_sec: 60 } }],
      constraints: { equipment: ["rack", "bench"], readiness: { shoulder: "easy" } },
      provenance: {
        entry: "offline_snapshot_recovery",
        recovered_from_source: "manual_plan",
        plan_day_id: 22,
        recovered_from_entry: "today_launch",
        recovered_origin: {
          source: "manual_plan",
          plan_day_id: 22,
          entry: "today_launch",
        },
      },
    },
  });

  accepted.items[0].exercise = "Plan changed later";
  accepted.items[0].interval.work_sec = 99;
  accepted.constraints.readiness.shoulder = "hard";
  assert.equal(recovery.body.session.items[0].exercise, "Bench");
  assert.equal(recovery.body.session.items[0].interval.work_sec, 30);
  assert.equal(recovery.body.constraints.readiness.shoulder, "easy");
  assert.equal(recovery.intent.items[0].exercise, "Bench");
});

test("agent suggestion recovery preserves constraints and labels its verified job origin", () => {
  const harness = loadController();
  const canonicalProvenance = {
    verification: "verified_agent_job",
    operation: "session_suggest",
    agent_job_id: 145,
    agent: "codex",
    tried: [{ agent: "codex", ok: true }],
    verified: { sources: 2 },
  };
  const recovery = harness.controller.snapshotRecovery({
    date: "2026-06-30",
    source: "agent_suggest",
    plan_day_id: null,
    title: "Coach session",
    focus: "Posterior chain",
    why: "Matches today's constraints.",
    est_minutes: 35,
    items: [{ position: 0, exercise: "Deadlift", sets: 3 }],
    constraints: { minutes: 35, equipment: "barbell" },
    provenance: canonicalProvenance,
  }, {
    date: "2026-06-30",
    source: "agent_suggest",
    agent_job_id: 145,
    constraints: { minutes: 35, equipment: "barbell" },
    provenance: canonicalProvenance,
    replace: true,
  });

  assert.equal(recovery.body.source, "athlete_override");
  assert.equal(recovery.body.replace, true);
  assert.deepEqual(plain(recovery.body.constraints), { minutes: 35, equipment: "barbell" });
  assert.deepEqual(plain(recovery.body.provenance.recovered_origin), {
    source: "agent_suggest",
    plan_day_id: null,
    verification: "verified_agent_job",
    operation: "session_suggest",
    agent_job_id: 145,
    agent: "codex",
    tried: [{ agent: "codex", ok: true }],
    verified: { sources: 2 },
  });
  assert.equal(Object.hasOwn(recovery.body.provenance, "source"), false);
  assert.equal(recovery.intent.provenance.recovered_from_source, "agent_suggest");
});

test("adaptive offline staging renders the selected plan day without promising a client day number", () => {
  const harness = loadController();
  const staged = harness.controller.stagedPrepareResponse({
    date: "2026-06-30",
    request: {
      date: "2026-06-30",
      source: "adaptive_plan",
      replace: false,
      constraints: {},
      provenance: { entry: "today_launch" },
    },
    plan: [{
      id: 22,
      day_number: 2,
      name: "Upper",
      focus: "Push",
      items: [{ exercise: "Bench", sets: 3 }],
    }],
    selectedDay: 2,
    localPrepareId: "adaptive-prepare",
  });

  assert.equal(staged.daily_session.plan_day_id, 22);
  assert.equal(staged.daily_session.title, "Upper");
  assert.equal(Object.hasOwn(staged.daily_session, "day_number"), false);
});

test("meaningful zero-set legacy sessions continue without preparation unless replacement is explicit", () => {
  const harness = loadController();
  const meaningful = [
    { skips: ["Squat"] },
    { skipped: 1 },
    { finished_at: "2026-06-30T15:00:00Z" },
    { duration_min: 0 },
    { notes: "Felt smooth" },
    { soreness: 0 },
    { performance: "steady" },
    { joint_pain: "left knee" },
    { garmin: {} },
  ];
  for (const evidence of meaningful) {
    const session = { date: "2026-06-30", sets: [], ...evidence };
    assert.equal(harness.controller.meaningfulLegacySession(session, false), true, JSON.stringify(evidence));
    assert.equal(harness.controller.meaningfulLegacySession(session, true), false, "explicit replacement still prepares");
  }
  assert.equal(
    harness.controller.meaningfulLegacySession({ date: "2026-06-30", sets: [], skips: [] }, false),
    false
  );
});

test("Today session-suggest controller reconnects loading state and clears on failure", () => {
  const harness = loadController();

  const handlers = harness.controller.reconnectSessionSuggest({ id: "job_1" }, harness.deps);
  assert.ok(handlers);
  assert.match(harness.slot.innerHTML, /sug-loading/);
  assert.equal(harness.captions[0].op, "session_suggest");
  assert.equal(harness.slot.classList.contains("is-thinking"), true);

  handlers.onError();
  assert.equal(harness.slot.classList.contains("is-thinking"), false);
  assert.deepEqual(harness.slot.style.removed, ["--frac"]);
  assert.match(harness.slot.innerHTML, /data-sugaction="retry"/);
  assert.deepEqual(harness.captions.at(-1), { stopped: true });
});
