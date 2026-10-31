import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// A tiny element: `[data-*]` lookups resolve against the markup last written to it,
// each one a stable child until the next innerHTML write.
class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.listeners = new Map();
    this.disabled = false;
    this.isConnected = true;
    this.style = {};
    this._html = "";
    this._kids = new Map();
  }

  set innerHTML(value) {
    this._html = String(value ?? "");
    this._kids = new Map();
  }

  get innerHTML() {
    return this._html;
  }

  get textContent() {
    return this._html.replace(/<[^>]*>/g, "");
  }

  querySelector(selector) {
    const attr = selector.match(/^\[(data-[\w-]+)\]$/);
    if (!attr || !this._html.includes(attr[1])) return null;
    if (!this._kids.has(selector)) this._kids.set(selector, new FakeElement());
    return this._kids.get(selector);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  setAttribute() {}

  click() {
    for (const handler of this.listeners.get("click") || []) handler({ target: this, preventDefault() {} });
  }
}

function load() {
  const slot = new FakeElement("hDedupe");
  const context = {
    Object,
    Array,
    Number,
    String,
    JSON,
    Set,
    Map,
    Promise,
    document: { querySelector: (selector) => (selector === "#hDedupe" ? slot : null) },
    absDate: (iso) => `on ${iso}`,
    CairnHealthDocs: { healthKindLabel: (kind) => (kind === "bloodwork" ? "Bloodwork" : String(kind)) },
    CairnUi: {
      jobCaptionHtml: (opts) => `<div class="${opts.className}" role="status">${opts.text || ""}</div>`,
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/records-dedupe-client.js"), "utf8"), context);
  return { context, slot, dedupe: context.CairnRecordsDedupe };
}

function harness(plan, { applyResult } = {}) {
  const loaded = load();
  const ops = [];
  const requests = [];
  const merges = [];
  const deps = {
    api: async (path, opts) => {
      requests.push({ path, opts });
      return applyResult ?? { ok: true, dry_run: false, merged: 1, clusters: [] };
    },
    runOp: async (kind, body, opts) => {
      ops.push({ kind, body, opts });
      if (plan === "fail") opts.onFail?.(null);
      else if (opts.isFail(plan)) opts.onFail?.(plan);
      else opts.render(plan);
      return undefined;
    },
    onMerged: (_result, merged) => merges.push(merged),
  };
  loaded.dedupe.mount(loaded.slot, deps);
  const panel = () => loaded.slot.querySelector("[data-hdedupe-panel]");
  return { ...loaded, deps, ops, requests, merges, panel };
}

const emptyPlan = {
  ok: true,
  dry_run: true,
  scanned: 4,
  merged: 0,
  clusters: [],
  judgement: { candidates: 0, asked: 0, judged: 0, agent: null, skipped: "no_candidates" },
};

const clusterPlan = {
  ok: true,
  dry_run: true,
  scanned: 6,
  merged: 2,
  clusters: [
    {
      date: "2026-05-01",
      survivor: {
        id: 10,
        kind: "bloodwork",
        doc_date: "2026-05-01",
        markers: 22,
        label: "Spring panel <script>alert(1)</script>",
      },
      merged: [
        { id: 11, kind: "bloodwork", doc_date: "2026-05-01", markers: 20, source_doc_id: 3, file: true, label: null },
      ],
      added_markers: 2,
      rule: "same_draw",
      reason: "Same draw date & the readings agree <b>exactly</b>",
      removes_note: "Merging also removes a duplicate uploaded file <i>x</i>",
      superseded: [
        { name: "BMI", value: 24.1, unit: "kg/m2", from_doc_id: 10, replaced_by_doc_id: 11 },
        { name: "BMI", value: 24.1, unit: "kg/m2", from_doc_id: 10, replaced_by_doc_id: 11 },
      ],
    },
  ],
  judgement: { candidates: 1, asked: 0, judged: 0, agent: null, skipped: "no_agent" },
};

test("the control renders one quiet button and an empty plan slot", () => {
  const { slot } = harness(emptyPlan);
  assert.match(slot.innerHTML, /data-hdedupe-check[^>]*>Check for duplicates</);
  assert.equal(slot.querySelector("[data-hdedupe-panel]").innerHTML, "");
});

test("checking runs the durable dedupe job and an empty plan reads as a calm line", async () => {
  const h = harness(emptyPlan);
  h.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();

  assert.equal(h.ops.length, 1);
  assert.equal(h.ops[0].kind, "health_dedupe_check");
  assert.deepEqual({ ...h.ops[0].body }, { judge: true });
  assert.equal(h.ops[0].opts.path, "/health-docs/dedupe");
  assert.equal(h.ops[0].opts.caption, "health_dedupe_check");
  assert.match(h.panel().innerHTML, /No duplicates — every record is filed once\./);
  assert.doesNotMatch(h.panel().innerHTML, /data-hdedupe-apply/);
  assert.doesNotMatch(h.panel().innerHTML, /connected AI/);
});

test("a plan with clusters names each record, prints the reason, and escapes every string", async () => {
  const h = harness(clusterPlan);
  h.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();
  const html = h.panel().innerHTML;

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Spring panel &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // A merged record with no label falls back to its kind and date.
  assert.match(html, /Bloodwork · on 2026-05-01<\/span> folds into/);
  assert.match(html, /Same draw date &amp; the readings agree &lt;b&gt;exactly&lt;\/b&gt;/);
  assert.match(html, /Keeps the later export's reading for BMI\./);
  // what the merge deletes besides the record, said in plain words (escaped)
  assert.match(html, /Merging also removes a duplicate uploaded file &lt;i&gt;x&lt;\/i&gt;/);
  assert.doesNotMatch(html, /BMI and BMI/);
  assert.match(html, /One record looks filed twice\./);
  assert.match(html, /that needs a connected AI/);
  assert.match(html, /data-hdedupe-apply[^>]*>Merge these</);
  assert.match(html, /data-hdedupe-dismiss[^>]*>Not now</);
});

test("Merge these posts {apply:true} with the clusters on screen, confirms calmly, and refreshes", async () => {
  const h = harness(clusterPlan);
  h.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();
  h.panel().querySelector("[data-hdedupe-apply]").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, "/health-docs/dedupe");
  assert.equal(h.requests[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(h.requests[0].opts.body), {
    apply: true,
    clusters: [{ survivor: 10, merged: [11], rule: "same_draw" }],
  });
  assert.match(h.panel().innerHTML, /Merged 1 record\./);
  assert.deepEqual(h.merges, [1]);
});

test("Not now clears the plan without merging anything", async () => {
  const h = harness(clusterPlan);
  h.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();
  h.panel().querySelector("[data-hdedupe-dismiss]").click();
  assert.equal(h.panel().innerHTML, "");
  assert.equal(h.requests.length, 0);
});

test("a failed check or merge is a quiet line, never an error dump", async () => {
  const failed = harness("fail");
  failed.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();
  assert.match(failed.panel().innerHTML, /Couldn't check your records just now — they're unchanged\./);

  const refused = harness({ ok: false, error: "boom" });
  refused.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();
  assert.match(refused.panel().innerHTML, /Couldn't check your records just now/);
  assert.doesNotMatch(refused.panel().innerHTML, /boom/);

  const badMerge = harness(clusterPlan, { applyResult: { ok: false, error: "locked" } });
  badMerge.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();
  badMerge.panel().querySelector("[data-hdedupe-apply]").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(badMerge.panel().innerHTML, /Couldn't merge them just now — your records are unchanged\./);
  assert.doesNotMatch(badMerge.panel().innerHTML, /locked/);
  assert.deepEqual(badMerge.merges, []);
});

test("records that changed since the check merge nothing and ask for a fresh check", async () => {
  const h = harness(clusterPlan, {
    applyResult: { ok: false, changed: true, error: "Your records changed since the check." },
  });
  h.slot.querySelector("[data-hdedupe-check]").click();
  await Promise.resolve();
  h.panel().querySelector("[data-hdedupe-apply]").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.panel().innerHTML, /Your records changed since the check — check again/);
  assert.deepEqual(h.merges, []);
});

test("a check still running after a reload reattaches only while the slot is mounted", () => {
  const h = harness(emptyPlan);
  const handlers = h.context.reconnectHealthDedupeCheck({ id: "j1", kind: "health_dedupe_check" });
  assert.ok(handlers);
  assert.match(h.panel().innerHTML, /Looking through your records/);
  handlers.onDone(clusterPlan);
  assert.match(h.panel().innerHTML, /Merge these/);

  const cold = load();
  assert.equal(cold.context.reconnectHealthDedupeCheck({ id: "j2" }), null);
});
