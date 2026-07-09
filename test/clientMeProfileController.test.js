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

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.classes = new Set(String(element.className || "").split(/\s+/).filter(Boolean));
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.classes.has(name) : Boolean(force);
    if (on) this.classes.add(name);
    else this.classes.delete(name);
    this.element.className = [...this.classes].join(" ");
    return on;
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.children = [];
    this.dataset = attrs.dataset ? { ...attrs.dataset } : {};
    this.listeners = new Map();
    this.parentElement = null;
    this.style = {};
    this.id = attrs.id || "";
    this.value = attrs.value || "";
    this.textContent = attrs.textContent || "";
    this.className = attrs.className || "";
    this.classList = new FakeClassList(this);
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    this.parseProfileHtml();
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    const calls = [];
    for (const handler of this.listeners.get("click") || []) {
      calls.push(handler({ target: this, currentTarget: this, preventDefault() {} }));
    }
    return calls.at(-1);
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector === "[data-disc]") return Object.hasOwn(this.dataset, "disc");
    if (selector === "[data-sex]") return Object.hasOwn(this.dataset, "sex");
    if (selector === "[data-egmode]") return Object.hasOwn(this.dataset, "egmode");
    if (selector === "[data-goalmode]") return Object.hasOwn(this.dataset, "goalmode");
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
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

  parseProfileHtml() {
    if (!this._innerHTML.includes('id="profFields"')) return;
    const idElements = new Map();
    const ensure = (id, tag = "div", attrs = {}) => {
      if (idElements.has(id)) return idElements.get(id);
      const el = new FakeElement(tag, { ...attrs, id });
      idElements.set(id, el);
      this.appendChild(el);
      return el;
    };

    for (const match of this._innerHTML.matchAll(/<([a-z]+)[^>]*\sid="([^"]+)"[^>]*>/g)) {
      ensure(match[2], match[1]);
    }
    for (const match of this._innerHTML.matchAll(/<input\s+[^>]*id="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
      ensure(match[1], "input").value = decodeAttr(match[2]);
    }
    const about = this._innerHTML.match(/<textarea\s+[^>]*id="about_me"[^>]*>([\s\S]*?)<\/textarea>/);
    if (about) ensure("about_me", "textarea").value = decodeAttr(about[1]);

    this.attachButtons("sexSeg", "sex", ["female", "male"]);
    this.attachButtons("discSeg", "disc", ["strength", "endurance", "hybrid"]);
    this.attachButtons("endGoalMode", "egmode", ["none", "race", "standing"]);
    this.attachButtons("goalModeSeg", "goalmode", ["lose", "maintain", "gain"]);
  }

  attachButtons(containerId, datasetKey, values) {
    const container = this.querySelector(`#${containerId}`);
    if (!container) return;
    for (const value of values) {
      const pattern = new RegExp(`<button[^>]*class="([^"]*)"[^>]*data-${datasetKey}="${value}"`, "i");
      const match = this._innerHTML.match(pattern);
      const button = new FakeElement("button", {
        className: match?.[1] || "segbtn",
        dataset: { [datasetKey]: value },
      });
      container.appendChild(button);
    }
  }
}

function loadController() {
  const rootEl = new FakeElement("section");
  const context = {
    Array,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/me-profile-form-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/me-profile-controller.js"), "utf8"), context);
  return { context, rootEl };
}

function profileHarness(overrides = {}) {
  const { context, rootEl } = loadController();
  const requests = [];
  const toasts = [];
  const invalidations = [];
  const activatedTabs = [];
  const goalFlags = [];
  let dirty = 0;
  let saved = null;
  let wireCount = 0;
  let pollInvalidations = 0;
  let renderCount = 0;
  let discipline = overrides.discipline || "strength";
  const headerTitle = new FakeElement("h1");
  const state = {};
  const profile = overrides.profile || {
    name: "Alex <R>",
    age: 41,
    height_cm: 181,
    weight_lb: 180,
    goal_weight_lb: 178,
    goal_date: "2026-09-01",
    activity_factor: 1.55,
    goal_mode: "maintain",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal_json: JSON.stringify({ mode: "standing", label: "10k-ready", distance_km: 10, weekly_km: 30 }),
    about_me: "Fast mornings <work>",
  };
  const goal = overrides.goal || {
    tdee: 2800,
    goal_mode: "maintain",
    message: "On track",
    requested: { aggressive: false },
    recommended: { target_intake_kcal: 2800, protein_g: 170 },
  };
  const deps = {
    root: rootEl,
    state,
    segments: [["profile", "Profile"]],
    handlers: { profile: () => {} },
    headerTitle,
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (path === "/profile" && opts?.method === "PUT") {
        saved = JSON.parse(opts.body);
        return { ok: true };
      }
      if (path === "/profile") return profile;
      if (path === "/goal") return goal;
      return {};
    },
    activateTab: (tab) => activatedTabs.push(tab),
    escapeAttr: escapeHtml,
    escapeHtml,
    inputValue: (selector, source = rootEl) => source.querySelector(selector)?.value ?? "",
    invalidatePoll: () => { pollInvalidations += 1; },
    mountSaveBar: (options) => {
      deps.saveOptions = options;
      return { markDirty: () => { dirty += 1; } };
    },
    numberValue: (selector, source = rootEl) => {
      const raw = source.querySelector(selector)?.value ?? "";
      const value = Number(raw);
      return raw !== "" && Number.isFinite(value) ? value : null;
    },
    primaryDiscipline: () => discipline,
    renderMe: () => { renderCount += 1; },
    renderProfile: () => "discarded",
    segBar: (active) => `<nav data-active="${active}"></nav>`,
    segSkeleton: (active) => `<section data-skeleton="${active}"></section>`,
    setDiscipline: (value) => {
      if (typeof value === "string" && value) discipline = value;
      return discipline;
    },
    setEnduranceGoalSet: (value) => goalFlags.push(value),
    skeletonSwap: async (update) => { update(); },
    swrInvalidate: (key) => invalidations.push(key),
    textAreaValue: (selector, source = rootEl) => source.querySelector(selector)?.value ?? "",
    toast: (message) => toasts.push(message),
    wireSeg: () => { wireCount += 1; },
    select: (selector) => rootEl.querySelector(selector),
  };
  return {
    context,
    rootEl,
    deps,
    headerTitle,
    requests,
    toasts,
    invalidations,
    activatedTabs,
    goalFlags,
    state,
    get dirty() { return dirty; },
    get saved() { return saved; },
    get wireCount() { return wireCount; },
    get pollInvalidations() { return pollInvalidations; },
    get renderCount() { return renderCount; },
  };
}

test("Me Profile controller renders profile state and wires segmented controls", async () => {
  const harness = profileHarness();

  await harness.context.CairnMeProfileController.renderProfile(harness.deps);

  assert.equal(harness.headerTitle.textContent, "Profile");
  assert.equal(harness.state.meSeg, "profile");
  assert.equal(harness.pollInvalidations, 1);
  assert.deepEqual(harness.requests.map((request) => request.path), ["/profile", "/goal"]);
  assert.equal(harness.goalFlags.at(-1), true);
  assert.equal(harness.wireCount, 1);
  assert.match(harness.rootEl.innerHTML, /Alex &lt;R&gt;/);
  assert.match(harness.rootEl.innerHTML, /Goal check/);

  harness.rootEl.querySelectorAll("[data-disc]").find((button) => button.dataset.disc === "strength").click();
  assert.equal(harness.rootEl.querySelector("#endSportField").style.display, "none");

  harness.rootEl.querySelectorAll("[data-egmode]").find((button) => button.dataset.egmode === "race").click();
  assert.equal(harness.rootEl.querySelector("#egRace").style.display, "");
  assert.equal(harness.rootEl.querySelector("#egStanding").style.display, "none");
  assert.equal(harness.rootEl.querySelector("#egShared").style.display, "");

  harness.rootEl.querySelectorAll("[data-goalmode]").find((button) => button.dataset.goalmode === "gain").click();
  assert.equal(harness.rootEl.querySelector("#goalTargetFields").style.display, "");
  assert.equal(harness.rootEl.querySelector("#goalMaintainNote").style.display, "none");
  assert.equal(harness.dirty, 3);

  harness.rootEl.querySelector("#profToToday").click();
  harness.rootEl.querySelector("#profToProgress").click();
  assert.deepEqual(harness.activatedTabs, ["today", "progress"]);
});

test("Me Profile controller saves the typed payload and invalidates dependent surfaces", async () => {
  const harness = profileHarness({ profile: { primary_discipline: "strength", endurance_goal_json: null } });

  await harness.context.CairnMeProfileController.renderProfile(harness.deps);
  harness.rootEl.querySelector("#name").value = "Milos";
  harness.rootEl.querySelector("#age").value = "42";
  harness.rootEl.querySelector("#height_cm").value = "182.5";
  harness.rootEl.querySelector("#weight_lb").value = "181.2";
  harness.rootEl.querySelector("#goal_weight_lb").value = "188";
  harness.rootEl.querySelector("#goal_date").value = "2026-12-01";
  harness.rootEl.querySelector("#activity_factor").value = "1.6";
  harness.rootEl.querySelector("#endurance_sport").value = "running";
  harness.rootEl.querySelector("#eg_label").value = "10k-ready";
  harness.rootEl.querySelector("#eg_distance").value = "10";
  harness.rootEl.querySelector("#eg_weekly_km").value = "35";
  harness.rootEl.querySelector("#about_me").value = "Train around family";
  harness.rootEl.querySelector("#allergies").value = "nuts";
  harness.rootEl.querySelector("#dietary_restrictions").value = "pescatarian";
  harness.rootEl.querySelectorAll("[data-disc]").find((button) => button.dataset.disc === "hybrid").click();
  harness.rootEl.querySelectorAll("[data-egmode]").find((button) => button.dataset.egmode === "standing").click();
  harness.rootEl.querySelectorAll("[data-goalmode]").find((button) => button.dataset.goalmode === "gain").click();
  harness.rootEl.querySelectorAll("[data-sex]").find((button) => button.dataset.sex === "female").click();

  assert.equal(await harness.deps.saveOptions.onSave(), true);

  assert.equal(harness.requests.at(-1).path, "/profile");
  assert.equal(harness.requests.at(-1).opts.method, "PUT");
  assert.deepEqual(harness.saved, {
    name: "Milos",
    age: 42,
    sex: "female",
    height_cm: 182.5,
    weight_lb: 181.2,
    goal_weight_lb: 188,
    goal_date: "2026-12-01",
    activity_factor: 1.6,
    goal_mode: "gain",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "standing", label: "10k-ready", distance_km: 10, weekly_km: 35 },
    about_me: "Train around family",
    allergies: "nuts",
    dietary_restrictions: "pescatarian",
    smoking: null,
    bp_treated: null,
    statin: null,
  });
  assert.deepEqual(harness.invalidations, ["profile", "stats", "progress:weight", "progress:energy"]);
  assert.equal(harness.goalFlags.at(-1), true);
  assert.equal(harness.toasts.at(-1), "Your running plan now lives in Plan → Endurance");
  assert.equal(harness.renderCount, 1);
});

test("Me Profile controller does not clear an existing race goal when the date is missing", async () => {
  const harness = profileHarness({
    profile: {
      primary_discipline: "endurance",
      endurance_goal_json: JSON.stringify({ mode: "race", date: "2026-10-01", event: "Half" }),
    },
  });

  await harness.context.CairnMeProfileController.renderProfile(harness.deps);
  harness.rootEl.querySelector("#eg_date").value = "";

  assert.equal(await harness.deps.saveOptions.onSave(), true);

  assert.equal(Object.hasOwn(harness.saved, "endurance_goal"), false);
  assert.equal(harness.toasts.at(-1), "Add a race date to save your race goal");
  assert.deepEqual(harness.goalFlags, [true]);
});
