import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function createContext() {
  const ctx = {
    window: null,
    globalThis: null,
    escHtml: (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    escAttr: (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    stagger: (n) => `--i:${Number(n) || 0}`,
    fmtWeight: (w) => {
      if (w === null || w === undefined) return "BW";
      const n = Number(w);
      return Number.isFinite(n) && n < 0 ? `${-n} assist` : `${w}`;
    },
    fmtDur: (sec) => {
      const s = Math.round(Number(sec) || 0);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    art: (kind, name) => `<svg data-art="${kind}:${name}"></svg>`,
    artImg: (kind, name, cls) => `<img class="${cls}" alt="${name}">`,
    CairnUi: {
      jobCaptionHtml: ({ tag = "div", className = "job-cap" } = {}) =>
        `<${tag} class="${className}"></${tag}>`,
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  for (const rel of [
    "public/js/session-additions-model.js",
    "public/js/session-additions-client.js",
    "public/js/session-additions-controller.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, rel), "utf8"), ctx);
  }
  return ctx;
}

test("CairnSessionAdditionsModel formats prescriptions, collects keys, and derives prefill", () => {
  const ctx = createContext();
  const model = ctx.CairnSessionAdditionsModel;

  assert.equal(model.exerciseKey("Face Pull — Rope!"), "face pull rope");
  assert.equal(
    model.rxSummary({ mode: "reps", sets: 3, rep_low: 10, rep_high: 12, target_weight: 55 }),
    "3 × 10–12 · 55"
  );
  assert.equal(
    model.rxSummary({ mode: "reps", sets: 3, rep_low: 8, rep_high: 10, target_weight: -30 }),
    "3 × 8–10 · 30 assist"
  );
  assert.equal(
    model.rxSummary({ mode: "reps", sets: 3, rep_low: 12, rep_high: 12, load_basis: "bodyweight" }),
    "3 × 12 · BW"
  );
  assert.equal(
    model.rxSummary({ mode: "timed", sets: 2, target_seconds: 45 }),
    "2 × 0:45"
  );

  const prefill = model.prefillFromSuggestion({
    mode: "reps",
    rep_low: 12,
    target_weight: null,
    last_set: { weight: 40, reps: 10 },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prefill)), {
    weight: 40,
    reps: 12,
    rir: null,
    duration_sec: null,
  });

  const fakeRoot = {
    querySelectorAll(selector) {
      if (selector === ".ex[data-card]") return [{ dataset: { card: "Bench Press" } }];
      if (selector === ".ex .logged .chip") return [{}, {}];
      return [];
    },
    querySelector(selector) {
      if (selector === ".session-title") return { textContent: "Push · Chest" };
      return null;
    },
  };
  const keys = model.collectCurrentExerciseKeys(fakeRoot);
  assert.equal(keys.has("bench press"), true);
  assert.match(model.sessionContextSummary(fakeRoot), /2 sets logged on Push/);
});

test("CairnSessionAdditionsClient renders escaped markup and Added state", () => {
  const ctx = createContext();
  const client = ctx.CairnSessionAdditionsClient;

  const sheet = client.sheetHtml({ subtitle: "2 sets logged on <Push>" });
  assert.match(sheet, /Add to this session/);
  assert.match(sheet, /2 sets logged on &lt;Push&gt;/);
  assert.match(sheet, /data-ideate-vibe="feeling strong"/);

  const html = client.resultsHtml({
    why: "Balances your <pressing> work.",
    addedKeys: new Set(["face pull"]),
    suggestions: [
      {
        exercise: "Face Pull",
        mode: "reps",
        sets: 3,
        rep_low: 12,
        rep_high: 15,
        target_weight: 35,
        fit: "Rear delts & posture",
      },
      {
        exercise: "Hammer Curl",
        mode: "reps",
        sets: 3,
        rep_low: 10,
        rep_high: 12,
        fit: "Extra arm work",
        note: "Control the lowering <slow>",
      },
    ],
  });

  assert.match(html, /Balances your &lt;pressing&gt; work\./);
  assert.match(html, /Control the lowering &lt;slow&gt;/);
  assert.match(html, /data-ideate-add="0" disabled>Added ✓<\/button>/);
  assert.match(html, /data-ideate-add="1">\+ Add<\/button>/);
});

test("CairnSessionAdditionsController handles Undo and skipped_duplicates without duplicating cards", async () => {
  const ctx = createContext();
  const makeEl = (tag) => ({
    tag,
    dataset: {},
    style: {},
    innerHTML: "",
    textContent: "",
    disabled: false,
    isConnected: true,
    children: [],
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      remove(c) { this.classes.delete(c); },
      toggle(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); },
    },
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    click() {
      for (const fn of this.listeners.get("click") || []) fn({ stopPropagation() {} });
    },
    querySelector(sel) {
      if (sel === ".logrow") return makeEl("div");
      if (sel === ".in-r") return null;
      if (sel === ".in-dur") return null;
      if (sel === ".in-w") return null;
      return null;
    },
    querySelectorAll() { return []; },
    before(node) { insertedCards.push(node); },
    remove() { removedCards.push(this); this.isConnected = false; },
    scrollIntoView() {},
  });

  const insertedCards = [];
  const removedCards = [];
  const slot = makeEl("div");
  const sheet = {
    querySelector(sel) {
      if (sel === ".ideate-slot") return slot;
      return null;
    },
    querySelectorAll() { return []; },
  };
  let addBtns = [];
  slot.querySelectorAll = (sel) => (sel === "[data-ideate-add]" ? addBtns : []);
  slot.querySelector = () => null;

  ctx.CairnUiSheet = { open: () => ({ sheet, close() {} }) };
  ctx.document = {
    createElement: () => ({
      innerHTML: "",
      content: { firstElementChild: makeEl("div") },
    }),
  };

  const toasts = [];
  const apiCalls = [];
  ctx.CairnSessionAdditionsController.open({
    root: { querySelector: () => makeEl("div"), querySelectorAll: () => [] },
    state: { logDate: "2026-06-15", exModes: {} },
    api: async (path, opts) => {
      apiCalls.push({ path, method: opts.method, body: JSON.parse(opts.body) });
      if (opts.method === "POST" && opts.body.includes("Face Pull")) {
        return {
          ok: true,
          daily_session: { id: 1, session_id: 2, items: [] },
          session: { id: 2, sets: [] },
          added: [{ exercise: "Face Pull", mode: "reps", sets: 3, rep_low: 12, rep_high: 15, added_mid_session: true }],
          skipped_duplicates: [],
        };
      }
      if (opts.method === "POST" && opts.body.includes("Hammer Curl")) {
        return {
          ok: true,
          daily_session: { id: 1, session_id: 2, items: [] },
          session: { id: 2, sets: [] },
          added: [],
          skipped_duplicates: ["Hammer Curl"],
        };
      }
      if (opts.method === "DELETE") {
        return { ok: true, removed: "Face Pull" };
      }
      return { ok: false };
    },
    runOp: async (_kind, _body, hooks) => {
      const b0 = makeEl("button");
      b0.dataset.ideateAdd = "0";
      const b1 = makeEl("button");
      b1.dataset.ideateAdd = "1";
      addBtns = [b0, b1];
      hooks.render(
        {
          ok: true,
          why: "Rounded accessories.",
          suggestions: [
            { exercise: "Face Pull", mode: "reps", sets: 3, rep_low: 12, rep_high: 15 },
            { exercise: "Hammer Curl", mode: "reps", sets: 3, rep_low: 10, rep_high: 12 },
          ],
        },
        { id: 42 }
      );
    },
    exCard: () => `<div class="ex"></div>`,
    wireGuides() {},
    wireLogRow() {},
    wireSkips() {},
    onCardInserted() {},
    invalidate() {},
    reducedMotion: () => true,
    toast: (message, options) => toasts.push({ message, options }),
    collapseEl: (_el, done) => done?.(),
  });

  await new Promise((r) => setTimeout(r, 0));
  addBtns[0].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(insertedCards.length, 1);
  assert.equal(addBtns[0].textContent, "Added ✓");
  assert.equal(toasts[0]?.options?.action, "Undo");

  // Duplicate on server inserts no second card.
  addBtns[1].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(insertedCards.length, 1);
  assert.equal(addBtns[1].textContent, "Added ✓");

  // Undo deletes server-side, removes card, and restores + Add.
  toasts[0].options.onAction();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(apiCalls.some((c) => c.method === "DELETE" && c.path === "/daily-session/items"), true);
  assert.equal(removedCards.length, 1);
  assert.equal(addBtns[0].textContent, "+ Add");
  assert.equal(addBtns[0].disabled, false);
});
