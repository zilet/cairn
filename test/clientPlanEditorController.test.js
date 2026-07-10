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

function hasClass(el, className) {
  return String(el.className || "").split(/\s+/).includes(className);
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.children = [];
    this.dataset = { ...(attrs.dataset || {}) };
    this.listeners = new Map();
    this.parentElement = null;
    this._innerHTML = "";
    this.id = attrs.id || "";
    this.value = attrs.value || "";
    this.className = attrs.className || "";
    this.textContent = "";
    this.disabled = Boolean(attrs.disabled);
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes('id="planedit"')) {
      this.append(new FakeElement("div", { id: "planedit" }));
      this.append(new FakeElement("button", { id: "addDay" }));
      this.append(new FakeElement("div", { id: "planstatus" }));
      return;
    }
    if (this.id === "planedit") this.parsePlanEditorHtml(this._innerHTML);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  parsePlanEditorHtml(html) {
    for (const match of html.matchAll(/data-editday="([^"]+)"/g)) {
      this.append(new FakeElement("button", { dataset: { editday: match[1] } }));
    }
    for (const match of html.matchAll(/data-trainday="([^"]+)"/g)) {
      this.append(new FakeElement("button", { dataset: { trainday: match[1] } }));
    }

    const dayBlocks = html.split(/(?=<div class="pday" data-d=")/g).filter((block) => block.startsWith('<div class="pday"'));
    for (const block of dayBlocks) {
      const dayIndex = block.match(/<div class="pday" data-d="([^"]+)"/)?.[1] || "0";
      const day = this.append(new FakeElement("div", { className: "pday", dataset: { d: dayIndex } }));
      this.appendInputMatches(day, block, ["pday-name", "pday-focus"]);
      this.appendButtons(day, block);

      const itemBlocks = block.split(/(?=<div class="pitem)/g).filter((part) => part.startsWith('<div class="pitem'));
      for (const itemBlock of itemBlocks) {
        const className = itemBlock.match(/<div class="([^"]*pitem[^"]*)"/)?.[1] || "pitem";
        const data = {
          d: itemBlock.match(/data-d="([^"]+)"/)?.[1] || dayIndex,
          i: itemBlock.match(/data-i="([^"]+)"/)?.[1] || "0",
          kind: itemBlock.match(/data-kind="([^"]+)"/)?.[1] || "strength",
        };
        const item = day.append(new FakeElement("div", { className, dataset: data }));
        this.appendInputMatches(item, itemBlock, ["pi-ex", "pi-km", "pi-min", "pi-zone", "pi-ivl", "pi-sets", "pi-lo", "pi-hi", "pi-tw", "pi-wu", "pi-note"]);
        this.appendButtons(item, itemBlock);
      }
    }
  }

  appendInputMatches(parent, html, classes) {
    for (const className of classes) {
      const match = html.match(new RegExp(`<input class="${className}"[^>]*value="([^"]*)"`, "m"));
      if (match) parent.append(new FakeInput("input", { className, value: decodeAttr(match[1]) }));
    }
  }

  appendButtons(parent, html) {
    for (const match of html.matchAll(/<button([^>]*)>/g)) {
      const attrs = match[1];
      const data = {};
      for (const dataMatch of attrs.matchAll(/data-([a-z]+)="([^"]*)"/g)) data[dataMatch[1]] = decodeAttr(dataMatch[2]);
      if (!Object.keys(data).length) continue;
      parent.append(new FakeElement("button", { dataset: data, disabled: /\bdisabled\b/.test(attrs) }));
    }
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  click() {
    const handler = this.listeners.get("click");
    return handler ? handler({ target: this, currentTarget: this }) : undefined;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    this.collect(selector, out);
    return out;
  }

  collect(selector, out) {
    if (this.matches(selector)) out.push(this);
    for (const child of this.children) child.collect(selector, out);
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return hasClass(this, selector.slice(1));
    const dataMatch = selector.match(/^\[data-([a-z]+)\]$/);
    if (dataMatch) return this.dataset[dataMatch[1]] != null;
    return false;
  }

  findData(key, value) {
    return this.querySelectorAll(`[data-${key}]`).find((el) => el.dataset[key] === value) || null;
  }
}

class FakeInput extends FakeElement {}
class FakeTextArea extends FakeElement {}

function loadPlanEditorController(plan) {
  const view = new FakeElement("main");
  const documentEl = new FakeElement("document");
  const requests = [];
  const invalidations = [];
  const openSessionCalls = [];
  let dirtyCount = 0;
  let saveOptions = null;
  const context = {
    openSession: (date) => { openSessionCalls.push(date); },
    localISO: () => "2026-07-10",
    Array,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    encodeURIComponent,
    console,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    window: null,
    document: documentEl,
    location: { host: "example.test" },
    headerTitle: new FakeElement("h1"),
    view,
    state: { tab: "plan", plan: [] },
    pollToken: 0,
    PLAN_HANDLERS: {},
    $: (selector) => view.querySelector(selector) || documentEl.querySelector(selector),
    peekCached: (key) => key === "plan" ? { data: plan, fresh: true } : null,
    cachedApi: () => Promise.resolve(plan),
    markRefreshing: () => {},
    segSkeleton: () => "<div>loading</div>",
    segBar: () => "<nav></nav>",
    planSeg: () => [],
    wireSeg: () => {},
    withToken: (path) => path,
    wireGuides: () => {},
    isCardioItem: (item) => item && item.kind === "cardio",
    cardioIntervalNote: (interval) => (interval && interval.note) || "",
    cardioArtPhrase: (item) => item.note || "run",
    cardioLabel: (item) => item.note || "Cardio",
    cardioDescription: (item) => item.description || "",
    cardioPrescription: (item) => item.prescription || "45 min Z2",
    art: () => "<svg></svg>",
    artImg: () => "",
    fmtDur: (seconds) => `${Math.round(Number(seconds) / 60)}m`,
    fmtWeight: (weight) => `${Number(weight)} lb`,
    stagger: (index) => `--i:${index}`,
    mountSaveBar: (options) => {
      saveOptions = options;
      return {
        markDirty: () => { dirtyCount += 1; },
        save: () => options.onSave(),
      };
    },
    api: async (path, opts) => {
      requests.push({ path, opts });
      return {};
    },
    swrInvalidate: (key) => invalidations.push(key),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-editor-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-editor-form-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-editor-controller.js"), "utf8"), context);
  return {
    context,
    view,
    requests,
    invalidations,
    openSessionCalls,
    get dirtyCount() { return dirtyCount; },
    get saveOptions() { return saveOptions; },
  };
}

test("plan editor controller wires edit add reorder and save payload", async () => {
  const harness = loadPlanEditorController([
    {
      day_number: 1,
      name: "Upper",
      focus: "Push",
      items: [
        { kind: "strength", exercise: "Bench", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 },
        { kind: "strength", exercise: "Squat", sets: 4, rep_low: 6, rep_high: 8, target_weight: 225 },
      ],
    },
  ]);

  await harness.context.renderPlanEditor();
  harness.view.querySelector("[data-editday]").click();
  harness.view.querySelector(".pday-name").value = "Upper edited";
  harness.view.querySelector(".pday-focus").value = "Strength";
  harness.view.querySelector("[data-additem]").click();

  const added = harness.view.querySelectorAll(".pitem").at(-1);
  added.querySelector(".pi-ex").value = "Pull-up";
  added.querySelector(".pi-sets").value = "3";
  added.querySelector(".pi-lo").value = "8";
  added.querySelector(".pi-hi").value = "10";
  harness.view.querySelector("#planedit").findData("upitem", "0:2").click();

  assert.equal(harness.dirtyCount, 2);
  assert.ok(harness.saveOptions);
  assert.equal(await harness.saveOptions.onSave(), true);

  const put = harness.requests.find((request) => request.path === "/plan");
  assert.equal(put.opts.method, "PUT");
  assert.deepEqual(JSON.parse(put.opts.body), {
    days: [
      {
        day_number: 1,
        name: "Upper edited",
        focus: "Strength",
        items: [
          { kind: "strength", exercise: "Bench", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185, note: null, warmup_sets: null, target_seconds: null },
          { kind: "strength", exercise: "Pull-up", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, note: null, warmup_sets: null, target_seconds: null },
          { kind: "strength", exercise: "Squat", sets: 4, rep_low: 6, rep_high: 8, target_weight: 225, note: null, warmup_sets: null, target_seconds: null },
        ],
      },
    ],
  });
  assert.deepEqual(harness.invalidations, ["plan"]);
});

test("plan editor controller serializes cardio and filters blank rows", () => {
  const harness = loadPlanEditorController([]);
  const days = harness.context.CairnPlanEditorController.serializeDays([
    {
      day_number: 8,
      name: "",
      focus: "",
      items: [
        { kind: "strength", exercise: "  " },
        { kind: "strength", exercise: " Row ", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, note: " controlled ", warmup_sets: null },
        { kind: "cardio", note: "  ", target_zone: " ", target_distance_km: null, target_duration_min: null, interval_note: "ignored" },
        { kind: "cardio", note: "Tempo", target_zone: "Z3", target_distance_km: 6, target_duration_min: 35, interval_note: "4 x 3 min" },
      ],
    },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(days)), [
    {
      day_number: 1,
      name: "Day 1",
      focus: null,
      items: [
        { kind: "strength", exercise: "Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, note: "controlled", warmup_sets: null, target_seconds: null },
        { kind: "cardio", note: "Tempo", target_distance_km: 6, target_duration_min: 35, target_zone: "Z3", interval: { note: "4 x 3 min" } },
      ],
    },
  ]);
});

test("the Plan recovery banner announces a reshaped week — drafted asks, applied informs, null stays silent", () => {
  const harness = loadPlanEditorController([]);
  const banner = harness.context.CairnPlanEditorController.planRecoveryBannerHtml;

  // Drafted: actionable — review it, nothing changed yet.
  const drafted = banner({ state: "drafted", proposal_id: 4, summary: "Working sets <halved>, same movements." });
  assert.match(drafted, /YOUR RECOVERY WEEK/);
  assert.match(drafted, /nothing changes until you review/i);
  assert.match(drafted, /id="planRecoveryReview"/, "one tap to Drafts");
  assert.match(drafted, /Working sets &lt;halved&gt;/, "the coach's summary, escaped");

  // Applied: a calm heads-up — what this week is, what changed, when building resumes.
  const applied = banner({ state: "applied", applied_on: "2026-07-10", until: "2026-07-17", summary: "Volume −50% across all days." });
  assert.match(applied, /RECOVERY WEEK/);
  assert.match(applied, /deliberately lighter/i);
  assert.match(applied, /Volume −50% across all days\./);
  assert.match(applied, /Back to building around/i);
  assert.doesNotMatch(applied, /planRecoveryReview/, "nothing to review — it's running");

  // Null / malformed: the plan renders untouched.
  assert.equal(banner(null), "");
  assert.equal(banner({ state: "someday" }), "");
});

test("plan editor controller 'Train this day' starts logging the selected day today", async () => {
  const harness = loadPlanEditorController([
    { day_number: 1, name: "Upper", focus: "Push", items: [{ kind: "strength", exercise: "Bench", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }] },
    { day_number: 4, name: "Lower", focus: "Squat", items: [{ kind: "strength", exercise: "Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 245 }] },
  ]);

  await harness.context.renderPlanEditor();

  // The second day's "Train this day" preselects that plan day (day_number 4),
  // marks the pick explicit, and opens the isolated Session surface for today.
  const trainButtons = harness.view.querySelectorAll("[data-trainday]");
  assert.equal(trainButtons.length, 2, "one Train this day per plan day");
  trainButtons[1].click();

  assert.equal(harness.context.state.day, 4);
  assert.equal(harness.context.state.dayPicked, true);
  assert.deepEqual(harness.openSessionCalls, ["2026-07-10"], "opens the Session surface logged against today");
});
