// records-search (records-search-{model,client,controller}.ts, docs/V2-PLAN.md wave 3):
// the Records catalog extracted from stand-screen.ts. Grouping modes on the F3
// segmented control — "Out of range first" keyed on the LAB flag (outside optimal is
// its own section, never merged into the flag), "By panel" in MARKER_GROUPS order,
// "Newest" by draw date — over the existing name search, which also reaches documents,
// visit notes and body readings through GET /api/records/search. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeTimers, createHost, createStorage, flush, loadClientModule, renderHtml } from "./_dom.mjs";
import { markerGroup, markerGroupRank, presentGroups } from "../dist/repo/propagation-data.js";
import { labRangeFields } from "../dist/repo/lab-range.js";

const MODULES = [
  "date-utils",
  "ui-format",
  "html-utils",
  "ui-components",
  "ui-reads",
  "ui-chart",
  "ui-actions-client",
  "health-evidence-client",
  "health-marker-order-client",
  "health-client",
  "health-picture-client",
  "health-markers-client",
  "marker-row-client",
  "records-search-model",
  "records-search-client",
  "records-search-controller",
];

function load() {
  return loadClientModule(MODULES, {
    globals: {
      stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
      reducedMotion: () => true,
      requestAnimationFrame: () => 1,
    },
  });
}

// A synthetic marker whose group comes from the server's own classifier.
function mk(
  name,
  { value = 50, date = "2031-03-02", flag = "normal", inOptimal = true, optimal = null, reference = null } = {}
) {
  const g = markerGroup(name);
  const row = {
    key: name.toLowerCase().replace(/\W+/g, "-"),
    name,
    unit: "u",
    group: g.key,
    group_label: g.label,
    latest: { value, date, flag, doc_id: 1 },
    in_optimal: inOptimal,
    optimal,
    reference,
    reference_source: reference ? "source_lab" : null,
    points: [{ value, date, flag }],
  };
  // The server's own lab-range read, as GET /api/markers/priority carries it — the page
  // never derives it.
  return { ...row, ...labRangeFields(row) };
}

// Deliberately NOT in clinical order: the server's `groups` array is what orders panels.
function catalog() {
  const markers = [
    mk("Synthetic TSH"),
    mk("Synthetic Glucose", { value: 130, flag: "high", inOptimal: false, optimal: { low: 70, high: 90 } }),
    mk("Synthetic Ferritin", { value: 180, inOptimal: false, optimal: { low: 40, high: 150 }, date: "2031-01-10" }),
    mk("Synthetic ALT", { date: "2030-11-05" }),
    mk("Synthetic Sodium", { value: 130, flag: null, reference: { low: 135, high: 145 }, date: "2030-11-05" }),
    mk("Synthetic Vitamin D", { date: "2031-01-10" }),
  ];
  return { markers, groups: presentGroups(markers) };
}

// Values built inside the sandbox are another realm's arrays; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

// The real GET /api/records/search shape (ClientRecordsSearchRead), synthetic content.
const searchRead = (sections) => ({
  q: "x",
  group: "out_of_range",
  as_of: "2031-03-02",
  sections,
  counts: {},
  frame: "",
});
const docHit = (id, title, date, type = "document") => ({
  type,
  id: `doc:${id}`,
  doc_id: id,
  kind: type === "visit_note" ? "visit_note" : "lab_report",
  kind_label: type === "visit_note" ? "Visit note" : "Lab report",
  title,
  date,
  summary: null,
  snippet: null,
  marker_count: 0,
});
const bodyHit = (site, label, value, unit, date) => ({
  type: "body",
  id: `body:${site}`,
  label,
  unit,
  value,
  date,
  count: 1,
});
const sectionKeys = (model) => plain(model.sections.map((s) => s.key));
const names = (section) => plain(section.markers.map((m) => m.name));

// ---------- model ----------

test("By panel follows MARKER_GROUPS order, whatever order the markers arrive in", () => {
  const win = load();
  const data = catalog();
  const model = win.CairnRecordsSearchModel.sectionsModel({ ...data, mode: "panel" });
  const keys = sectionKeys(model);
  const expected = [...new Set(data.markers.map((m) => m.group))].sort(
    (a, b) => markerGroupRank(a) - markerGroupRank(b)
  );
  assert.deepEqual(keys, expected, "panels land in MARKER_GROUPS order");
  assert.ok(model.sections.every((s) => s.kind === "panel"));
  assert.equal(model.total, 6);
  assert.equal(model.shown, 6);
});

test("Out of range first keys on the lab's range; outside optimal is its own section", () => {
  const win = load();
  const model = win.CairnRecordsSearchModel.sectionsModel({ ...catalog(), mode: "outrange" });
  const [first, second, ...rest] = model.sections;
  assert.equal(first.key, "lab_out_of_range", "the server search's own section key");
  assert.equal(first.label, "Outside the lab's range");
  // Glucose carries the lab's HIGH; Sodium sits below the lab's printed range.
  assert.deepEqual(names(first).sort(), ["Synthetic Glucose", "Synthetic Sodium"]);
  assert.equal(second.key, "outside_optimal");
  assert.equal(second.label, "Outside optimal");
  assert.deepEqual(names(second), ["Synthetic Ferritin"], "lab-normal but off optimal: never in the flag section");
  // Glucose is off optimal too, but it is listed once, under the lab flag.
  assert.equal(model.sections.flatMap((s) => s.markers).filter((m) => m.name === "Synthetic Glucose").length, 1);
  // Everything else follows by panel, still in MARKER_GROUPS order.
  const panelKeys = rest.map((s) => s.key);
  assert.deepEqual(
    panelKeys,
    [...panelKeys].sort((a, b) => markerGroupRank(a) - markerGroupRank(b))
  );
  assert.ok(rest.every((s) => s.kind === "panel"));
});

test("the page reads the lab's range off the row; it never re-derives it from the printed range", () => {
  const win = load();
  const sodium = mk("Synthetic Sodium", { value: 130, flag: null, reference: { low: 135, high: 145 } });
  assert.equal(sodium.lab_out_of_range, true, "fixture: the server calls it out of range");
  // A row without the server's read (an older cached body) carries no lab claim at all,
  // even though its printed range would say "low" — the rule lives on the server only.
  const { lab_out_of_range: _o, lab_out_of_range_side: _s, lab_range: _r, ...bare } = sodium;
  const model = win.CairnRecordsSearchModel.sectionsModel({
    markers: [sodium, { ...bare, key: "bare", name: "Synthetic Sodium Bare" }],
    groups: presentGroups([sodium]),
    mode: "outrange",
  });
  assert.deepEqual(names(model.sections[0]), ["Synthetic Sodium"]);
  assert.equal(win.CairnHealthMarkers.labFlagWord(sodium), "low");
  assert.equal(win.CairnHealthMarkers.labFlagWord(bare), "");
});

test("Newest groups by draw date, newest first", () => {
  const win = load();
  const model = win.CairnRecordsSearchModel.sectionsModel({ ...catalog(), mode: "newest" });
  assert.deepEqual(plain(model.sections.map((s) => s.label)), ["2031-03-02", "2031-01-10", "2030-11-05"]);
  assert.deepEqual(names(model.sections[1]).sort(), ["Synthetic Ferritin", "Synthetic Vitamin D"]);
});

test("search narrows by name or panel, and a domain scope keeps only its panels", () => {
  const win = load();
  const M = win.CairnRecordsSearchModel;
  const byName = M.sectionsModel({ ...catalog(), mode: "panel", q: "  ferr " });
  assert.equal(byName.shown, 1);
  assert.equal(byName.total, 6);
  const byPanel = M.sectionsModel({ ...catalog(), mode: "panel", q: "thyroid" });
  assert.deepEqual(plain(byPanel.sections.flatMap(names)), ["Synthetic TSH"]);
  const scoped = M.sectionsModel({ ...catalog(), mode: "panel", scope: ["iron", "vitamins"] });
  assert.equal(scoped.total, 2);
  assert.deepEqual(sectionKeys(scoped), ["iron", "vitamins"]);
});

test("the server-search adapter reads the real search sections and leaves markers local", () => {
  const win = load();
  const M = win.CairnRecordsSearchModel;
  assert.equal(M.searchPath(" lipid ", "outrange"), "/records/search?q=lipid&group=out_of_range");
  const items = M.otherItems(
    searchRead([
      {
        key: "lab_flagged",
        label: "Flagged by the lab",
        hits: [{ type: "marker", id: "marker:glu", name: "Synthetic Glucose" }],
      },
      { key: "documents", label: "Documents", hits: [docHit(7, "Synthetic panel PDF", "2031-01-10")] },
      {
        key: "visit_notes",
        label: "Visit notes",
        hits: [{ ...docHit(8, "Synthetic visit note", "2031-02-01", "visit_note"), snippet: "…follow-up…" }],
      },
      { key: "body_readings", label: "Body readings", hits: [bodyHit("waist", "Waist", 80, "cm", "2031-02-02")] },
    ])
  );
  assert.deepEqual(plain(items.map((i) => [i.kind, i.id, i.title])), [
    ["body", "body:waist", "Waist"],
    ["note", "8", "Synthetic visit note"],
    ["document", "7", "Synthetic panel PDF"],
  ]);
  assert.deepEqual(plain(items[0]), {
    kind: "body",
    id: "body:waist",
    title: "Waist",
    date: "2031-02-02",
    detail: "80 cm",
  });
  assert.equal(items[1].detail, "…follow-up…", "a visit note's snippet is its detail");
  // "Newest" interleaves every kind in one section; a hit is still listed once.
  const newest = M.otherItems(
    searchRead([{ key: "newest", label: "Newest", hits: [docHit(7, "A", "2031-01-10"), docHit(7, "A", "2031-01-10")] }])
  );
  assert.equal(newest.length, 1);
  // A body that isn't a search result shows nothing (a 404 never gets here: api() throws).
  assert.equal(M.otherItems({ error: "not found" }), null);
  assert.equal(M.otherItems(null), null);
});

// ---------- renderer ----------

test("the sliding bar's labels fit three equal pills on a 360px screen", () => {
  const win = load();
  // Uppercase .68rem with .08em tracking runs ~8px a character; a third of a 360px
  // screen, less the gutters and the bar's own padding, leaves room for about 12.
  for (const [, label] of win.CairnRecordsSearchModel.MODES) {
    assert.ok(label.length <= 12, `"${label}" fits its pill`);
  }
});

test("the controls are one search field plus the grouping segmented control", () => {
  const win = load();
  const host = renderHtml(
    win.CairnRecordsSearch.shellHtml({ mode: "panel", searchable: true, placeholder: "Search…" }),
    {
      document: win.document,
    }
  );
  assert.ok(host.querySelector("input[data-records-q]"));
  const group = host.querySelector('[role="group"]');
  assert.equal(group.getAttribute("aria-label"), "Group records");
  const buttons = group.querySelectorAll("[data-records-group]");
  assert.deepEqual(
    buttons.map((b) => [b.dataset.recordsGroup, b.textContent, b.getAttribute("aria-pressed")]),
    [
      ["outrange", "Out of range", "false"],
      ["panel", "By panel", "true"],
      ["newest", "Newest", "false"],
    ]
  );
});

test("results render sections in model order, rows as marker-row, hostile text as text", () => {
  const win = load();
  const data = catalog();
  data.markers[0].name = "<b>Synthetic TSH</b>";
  const model = win.CairnRecordsSearchModel.sectionsModel({ ...data, mode: "outrange" });
  const host = renderHtml(win.CairnRecordsSearch.resultsHtml(model), { document: win.document });
  const sections = host.querySelectorAll("[data-records-section]");
  assert.deepEqual(
    sections.map((s) => s.dataset.recordsSection),
    sectionKeys(model)
  );
  assert.match(sections[0].querySelector(".hmk-grouphead").textContent, /Outside the lab's range/);
  assert.equal(sections[0].querySelectorAll(".hmk").length, 2);
  assert.equal(host.querySelector("b"), null);
});

test("empty states: nothing yet says what fills it; no match offers to clear", () => {
  const win = load();
  const R = win.CairnRecordsSearch;
  const none = renderHtml(R.resultsHtml({ sections: [], total: 0, shown: 0 }, { canAdd: true }), {
    document: win.document,
  });
  assert.match(none.textContent, /Add a lab report or scan/);
  assert.ok(none.querySelector("[data-records-add]"));
  const miss = renderHtml(R.resultsHtml({ sections: [], total: 4, shown: 0 }, { q: "<zz>" }), {
    document: win.document,
  });
  assert.match(miss.textContent, /No markers match “<zz>”/);
  assert.ok(miss.querySelector("button[data-records-clear]"));
});

// ---------- controller ----------

function harness({
  seed = catalog(),
  fetchCatalog = () => catalog(),
  search = () => searchRead([]),
  storage,
  peek = null,
} = {}) {
  const win = load();
  const timers = createFakeTimers();
  const reads = [];
  const calls = [];
  const asked = [];
  const opened = [];
  const deps = {
    api: async (path) => {
      calls.push(path);
      return search(path);
    },
    cachedApi: async (path) => {
      reads.push(path);
      return fetchCatalog();
    },
    peekCached: () => peek,
    storage: storage ?? createStorage(),
    seed,
    searchRecords: true,
    timers,
    askCoach: (q) => asked.push(q),
    onOpenRecord: (item) => opened.push(plain(item)),
  };
  const host = createHost(win.document);
  const teardown = win.CairnRecordsSearchController.mount(host, deps);
  return { win, host, deps, timers, reads, calls, asked, opened, teardown };
}

const sectionOrder = (host) => host.querySelectorAll("[data-records-section]").map((s) => s.dataset.recordsSection);

test("it paints from the screen's warm catalog at once, then revalidates through SWR", async () => {
  const h = harness();
  assert.equal(sectionOrder(h.host)[0], "lab_out_of_range", "Out of range first is the default");
  await flush();
  assert.deepEqual(h.reads, ["/markers/priority"]);
});

test("switching the grouping repaints in place, presses the button, and remembers it", async () => {
  const storage = createStorage();
  const h = harness({ storage });
  await flush();
  const input = h.host.querySelector("[data-records-q]");
  await h.host.querySelector('[data-records-group="panel"]').click();
  const panel = h.host.querySelector('[data-records-group="panel"]');
  assert.equal(panel.getAttribute("aria-pressed"), "true");
  assert.equal(h.host.querySelector('[data-records-group="outrange"]').getAttribute("aria-pressed"), "false");
  assert.equal(h.host.querySelector(".records-seg").style.getPropertyValue("--segi"), "1");
  const expected = [...new Set(catalog().markers.map((m) => m.group))].sort(
    (a, b) => markerGroupRank(a) - markerGroupRank(b)
  );
  assert.deepEqual(sectionOrder(h.host), expected);
  assert.equal(h.host.querySelector("[data-records-q]"), input, "the controls are not repainted");
  assert.equal(storage.getItem("cairn.records.group"), "panel");
  // A new mount reads the remembered mode.
  const again = harness({ storage });
  assert.equal(again.host.querySelector('[data-records-group="panel"]').getAttribute("aria-pressed"), "true");
});

test("typing narrows markers at once and asks the server search once, after a pause", async () => {
  const h = harness({
    search: () =>
      searchRead([
        { key: "documents", label: "Documents", hits: [docHit(9, "Synthetic thyroid panel PDF", "2031-01-10")] },
      ]),
  });
  await flush();
  const input = h.host.querySelector("[data-records-q]");
  input.focus();
  input.value = "t";
  await input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  input.value = "tsh";
  await input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  assert.equal(h.host.querySelectorAll(".hmk").length, 1, "markers narrow on every keystroke");
  assert.equal(h.host.querySelector("[data-records-status]").textContent, "1 of 6 markers");
  assert.equal(h.win.document.activeElement, input, "focus stays in the field");
  assert.deepEqual(h.calls, [], "the server is not asked per keystroke");
  h.timers.tick(250);
  await flush();
  assert.deepEqual(h.calls, ["/records/search?q=tsh&group=out_of_range"]);
  const hit = h.host.querySelector("[data-records-open]");
  assert.match(hit.textContent, /Synthetic thyroid panel PDF/);
  await hit.click();
  assert.deepEqual(h.opened, [{ kind: "document", id: "9" }]);
});

test("a superseded server answer is dropped, and a failed one is one calm line", async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  let n = 0;
  const h = harness({
    search: () => {
      n++;
      if (n === 1) return slow;
      throw new Error("offline");
    },
  });
  await flush();
  const input = h.host.querySelector("[data-records-q]");
  input.value = "gl";
  await input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  h.timers.tick(250);
  input.value = "glu";
  await input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  h.timers.tick(250);
  await flush();
  assert.match(h.host.querySelector("[data-records-other]").textContent, /couldn't be searched just now/);
  release(searchRead([{ key: "documents", label: "Documents", hits: [docHit(1, "Stale answer", "2031-01-10")] }]));
  await flush();
  assert.doesNotMatch(h.host.textContent, /Stale answer/, "the older answer never paints");
});

test("a server without records search (a thrown 404) shows nothing extra, never the failure line", async () => {
  const h = harness({
    search: () => {
      throw Object.assign(new Error("http: Not Found"), { kind: "http", status: 404 });
    },
  });
  await flush();
  const input = h.host.querySelector("[data-records-q]");
  input.value = "ld";
  await input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  h.timers.tick(250);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(h.host.querySelector("[data-records-other]").textContent, /couldn't be searched/);
  assert.equal(h.host.querySelectorAll("[data-records-open]").length, 0);
});

test("switching the grouping while a query shows asks the server again under the new mode", async () => {
  const h = harness();
  await flush();
  const input = h.host.querySelector("[data-records-q]");
  input.value = "tsh";
  await input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  h.timers.tick(250);
  await flush();
  await h.host.querySelector('[data-records-group="newest"]').click();
  h.timers.tick(250);
  await flush();
  assert.deepEqual(h.calls, ["/records/search?q=tsh&group=out_of_range", "/records/search?q=tsh&group=newest"]);
});

test("the screen's seed outranks a warm SWR peek; the peek only stands in without one", async () => {
  const stale = { markers: [mk("Synthetic Stale Marker")], groups: [] };
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const seeded = harness({ peek: { data: stale }, fetchCatalog: () => pending });
  assert.equal(seeded.host.querySelectorAll(".hmk").length, 6, "the fresher seed paints");
  assert.doesNotMatch(seeded.host.textContent, /Synthetic Stale Marker/);
  const cold = harness({ seed: null, peek: { data: stale }, fetchCatalog: () => pending });
  assert.match(cold.host.textContent, /Synthetic Stale Marker/, "no seed: the warm peek paints at once");
  release(catalog());
  await flush();
});

test("a row expands in place and Ask the coach hands its grounded question over", async () => {
  const h = harness();
  const toggle = h.host.querySelector("[data-hmk-toggle]");
  await toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(toggle.closest(".hmk").classList.contains("open"));
  await h.host.querySelector(".hmk-ask").click();
  assert.equal(h.asked.length, 1);
  assert.match(h.asked[0], /Synthetic/);
});

test("clear search empties the field, restores every marker, and keeps focus", async () => {
  const h = harness();
  const input = h.host.querySelector("[data-records-q]");
  input.value = "zzz";
  await input.dispatchEvent(new h.win.Event("input", { bubbles: true }));
  assert.equal(h.host.querySelectorAll(".hmk").length, 0);
  await h.host.querySelector("[data-records-clear]").click();
  assert.equal(input.value, "");
  assert.equal(h.host.querySelectorAll(".hmk").length, 6);
  assert.equal(h.win.document.activeElement, input);
});

test("cold start: skeleton, then an error with a retry that recovers", async () => {
  let fail = true;
  const h = harness({
    seed: null,
    fetchCatalog: () => {
      if (fail) throw new Error("offline");
      return catalog();
    },
  });
  assert.ok(h.host.querySelector(".records-skel"), "a skeleton, not a spinner, on a cold start");
  await flush();
  assert.match(h.host.textContent, /couldn't be read just now/);
  fail = false;
  await h.host.querySelector("[data-records-retry]").click();
  await flush();
  assert.equal(h.host.querySelectorAll(".hmk").length, 6);
});

test("mounting twice on one host leaves one listener; the teardown leaves none", async () => {
  const h = harness();
  const second = h.win.CairnRecordsSearchController.mount(h.host, h.deps);
  await h.host.querySelector(".hmk-ask").click();
  assert.equal(h.asked.length, 1, "one tap, one hand-off");
  second();
  await h.host.querySelector(".hmk-ask").click();
  assert.equal(h.asked.length, 1, "after teardown nothing fires");
});
