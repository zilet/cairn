import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeClassList {
  constructor(owner, calls) {
    this.owner = owner;
    this.calls = calls;
  }

  add(name) {
    this.calls.push(["class.add", this.owner, name]);
  }

  remove(name) {
    this.calls.push(["class.remove", this.owner, name]);
  }

  toggle(name, on) {
    this.calls.push(["class.toggle", this.owner, name, on]);
  }
}

class FakeElement {
  constructor(name, calls, dataset = {}) {
    this.name = name;
    this.calls = calls;
    this.className = "";
    this.classList = new FakeClassList(name, calls);
    this.dataset = dataset;
    this.disabled = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this._innerHTML = "";
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
    this.calls.push(["listen", this.name, type]);
  }

  appendChild(child) {
    this.calls.push(["appendChild", this.name, child.name]);
  }

  click() {
    return Promise.resolve(this.listeners.get("click")?.());
  }

  focus() {
    this.calls.push(["focus", this.name]);
  }

  remove() {
    this.calls.push(["remove", this.name]);
  }

  querySelector(selector) {
    if (selector === ".job-cap" && this._innerHTML.includes("job-cap")) return new FakeElement("job-cap", this.calls);
    return null;
  }

  querySelectorAll() {
    return [];
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.calls.push(["innerHTML", this.name, String(value).slice(0, 24)]);
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

class FakeModal extends FakeElement {
  constructor(calls) {
    super("modal", calls);
    this.age = new FakeElement("obAge", calls);
    this.goal = new FakeElement("obGoal", calls);
    this.intro = new FakeElement("obIntro", calls);
    this.skip = new FakeElement("obSkip", calls);
    this.start = new FakeElement("obStart", calls);
    this.status = new FakeElement("obStatus", calls);
    this.dayButtons = [3, 4, 5, 6].map((days) => new FakeElement(`day-${days}`, calls, { dpw: String(days) }));
    this.discButtons = ["strength", "endurance", "hybrid"].map((disc) => new FakeElement(`disc-${disc}`, calls, { disc }));
  }

  querySelector(selector) {
    const map = {
      "#obAge": this.age,
      "#obGoal": this.goal,
      "#obIntro": this.intro,
      "#obSkip": this.skip,
      "#obStart": this.start,
      "#obStatus": this.status,
    };
    return map[selector] || null;
  }

  querySelectorAll(selector) {
    if (selector === "#obDays [data-dpw]" || selector === "#obDays .segbtn") return this.dayButtons;
    if (selector === "#obDisc [data-disc]" || selector === "#obDisc .segbtn") return this.discButtons;
    return [];
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadOnboarding(apiHandler = async () => ({ settings: { onboarded: true, art_enabled: true } })) {
  const source = readFileSync(new URL("../public/js/app-onboarding.js", import.meta.url), "utf8");
  const calls = [];
  const modal = new FakeModal(calls);
  const tabToday = new FakeElement("tab-today", calls, { tab: "today" });
  const tabPlan = new FakeElement("tab-plan", calls, { tab: "plan" });
  const body = new FakeElement("body", calls);
  body.dataset = {};
  const context = {
    CairnUi: {
      jobCaptionHtml: () => '<span class="job-cap"></span>',
    },
    api: async (path, opts) => {
      calls.push(["api", path, opts?.method || "GET", opts?.body || ""]);
      return apiHandler(path, opts);
    },
    artEnabled: true,
    document: {
      body,
      createElement: () => modal,
      querySelector: (selector) => selector === '.tab[data-tab="today"]' ? tabToday : null,
      querySelectorAll: (selector) => selector === ".tab" ? [tabToday, tabPlan] : [],
    },
    globalThis: null,
    hideSaveBar: () => calls.push(["hideSaveBar"]),
    reducedMotion: () => false,
    renderToday: () => calls.push(["renderToday"]),
    setDiscipline: (discipline) => calls.push(["setDiscipline", discipline]),
    setTimeout: (fn, ms) => {
      calls.push(["setTimeout", ms]);
      fn();
    },
    state: {
      day: 7,
      dayPicked: true,
      plan: [{ day_number: 1 }],
      tab: "plan",
    },
    swrInvalidate: (key) => calls.push(["swrInvalidate", key]),
    thinkingCaption: (el, op) => calls.push(["thinkingCaption", el.name, op]),
    toast: (message) => calls.push(["toast", message]),
    window: {},
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-onboarding.js" });
  return { calls, context, modal, tabToday };
}

test("onboarding opens first-run modal and refreshes art setting", async () => {
  const env = loadOnboarding(async () => ({ settings: { onboarded: false, art_enabled: false } }));

  assert.equal(typeof env.context.maybeOnboard, "function");
  assert.equal(typeof env.context.window.maybeOnboard, "function");
  await env.context.maybeOnboard();

  assert.equal(env.context.artEnabled, false);
  assert.ok(env.calls.some((call) => call[0] === "appendChild" && call[2] === "modal"));
  assert.ok(env.calls.some((call) => call[0] === "focus" && call[1] === "obAge"));
});

test("onboarding skip persists the structured discipline and enters Today cleanly", async () => {
  const env = loadOnboarding();
  env.context.openOnboarding();
  await env.modal.discButtons[1].click();
  await env.modal.skip.click();

  assert.deepEqual(plain(env.calls.filter(([kind]) => kind === "api")), [
    ["api", "/profile", "PUT", JSON.stringify({ primary_discipline: "endurance" })],
    ["api", "/settings", "PUT", JSON.stringify({ onboarded: true })],
  ]);
  assert.equal(env.context.state.tab, "today");
  assert.deepEqual(plain(env.context.state.plan), []);
  assert.equal(env.context.state.day, null);
  assert.equal(env.context.state.dayPicked, false);
  assert.ok(env.calls.some(([kind]) => kind === "hideSaveBar"));
  assert.ok(env.calls.some(([kind]) => kind === "renderToday"));
});

test("onboarding start composes the intro and shows calm progress", async () => {
  const env = loadOnboarding();
  env.context.openOnboarding();
  env.modal.age.value = "42";
  env.modal.goal.value = "build muscle";
  env.modal.intro.value = "Vegetarian, sore left ankle.";
  await env.modal.dayButtons[3].click();
  await env.modal.discButtons[2].click();
  await env.modal.start.click();

  const onboard = env.calls.find((call) => call[0] === "api" && call[1] === "/onboard");
  assert.ok(onboard, "onboard call is made");
  assert.deepEqual(JSON.parse(onboard[3]), {
    text: "I'm 42. I train about 6 days a week. I train both strength and endurance (hybrid). My main goal is to build muscle. Vegetarian, sore left ankle.",
  });
  assert.equal(env.modal.start.disabled, true);
  assert.equal(env.modal.start.textContent, "GETTING TO KNOW YOU…");
  assert.ok(env.calls.some(([kind]) => kind === "thinkingCaption"));
  assert.ok(env.calls.some((call) => call[0] === "toast" && call[1] === "You're all set"));
});
