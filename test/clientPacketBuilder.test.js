// packet-builder (packet-builder-{model,client,controller}.ts) and its composition in
// health-share-controller.ts, docs/V2-PLAN.md wave 3 ("a packet you can hand over").
// Section toggles ride the F3 segmented primitive; a section toggled off is absent from
// the live preview AND from every request the packet makes; the edited question list
// travels with the share; the informational, not-medical-advice line shows in every
// state; the lab flag and "outside optimal" stay two marks. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const CATALOG = [
  { id: "findings", label: "Findings to discuss" },
  { id: "visit_questions", label: "Questions for the visit" },
  { id: "body_composition", label: "Body composition" },
  { id: "panels", label: "Results by panel" },
  { id: "supplements", label: "Supplements" },
  { id: "sources", label: "Source documents" },
];
const DEFAULT = CATALOG.map((c) => c.id).filter((id) => id !== "sources");
const DISCLAIMER = "Informational, not medical advice.";
const PROPOSALS = [
  {
    id: "loop:synth-a",
    text: "Recheck Synthetic Marker A at the next draw?",
    source: "doctor_loop",
    basis: "Last read high.",
  },
  { id: "ask:7", text: "Is the synthetic plan still right?", source: "clinical_ask", basis: null },
];

const FINDING = {
  name: "Synthetic Marker A",
  unit: "u/L",
  value: 42,
  flag: "high",
  abnormal: true,
  inOptimal: false,
  latestDate: "2031-01-10",
};

// A stand-in for GET /api/health-report.json that parses ?sections= / ?questions= the
// way src/report.ts and src/domain/health/visit-questions.ts do.
function packet(path, { records = true } = {}) {
  const url = new URL(path, "http://x");
  const raw = url.searchParams.get("sections");
  let sections = DEFAULT;
  if (raw === "none") sections = [];
  else if (raw === "all") sections = CATALOG.map((c) => c.id);
  else if (raw) sections = CATALOG.map((c) => c.id).filter((id) => raw.split(",").includes(id));
  const asked = url.searchParams.has("questions") ? url.searchParams.getAll("questions").filter(Boolean) : null;
  const all = {
    findings: records ? [FINDING] : [],
    visit_questions: asked
      ? asked.map((text, i) => ({ id: `custom:${i + 1}`, text, source: "athlete", basis: null }))
      : PROPOSALS,
    bodyComp: null,
    groups: records
      ? [
          {
            key: "synthetic",
            label: "Synthetic Panel",
            markers: [{ name: "Synthetic Marker A" }, { name: "Synthetic Marker B" }],
          },
        ]
      : [],
    supplements: [{ name: "Synthetic Supplement", dose: "1 cap", frequency: "daily" }],
    sources: [{ date: "2031-01-10", kind: "lab", name: "synthetic.pdf" }],
  };
  const key = { body_composition: "bodyComp", panels: "groups" };
  const out = {
    subject: { name: null, sex: null, age: null, heightText: "", weightLb: null },
    generated: "2031-02-01",
    dateRange: records ? { from: "2030-06-01", to: "2031-01-10" } : null,
    sections,
    section_catalog: CATALOG.map((c) => ({ ...c, included: sections.includes(c.id) })),
    disclaimer: DISCLAIMER,
  };
  for (const id of sections) out[key[id] || id] = all[key[id] || id];
  return out;
}

function load(globals = {}) {
  return loadClientModule(
    [
      "html-utils",
      "date-utils",
      "ui-format",
      "ui-components",
      "ui-actions-client",
      "packet-builder-model",
      "packet-builder-client",
      "packet-builder-controller",
      "visit-questions-client",
      "visit-questions-controller",
      "records-slot",
      "health-share-controller",
    ],
    { globals }
  );
}

// Recording deps: `api` answers edited packets, `cachedApi` the default packet and the
// visit-question proposals; every path asked is kept.
function recorder({ records = true, fail = false } = {}) {
  const asked = [];
  const answer = (path) => {
    asked.push(path);
    if (fail) return Promise.reject(new Error("offline"));
    if (path.startsWith("/health/visit-questions"))
      return Promise.resolve({ as_of: "2031-02-01", questions: PROPOSALS, frame: "" });
    return Promise.resolve(packet(path, { records }));
  };
  return {
    asked,
    api: (path) => answer(path),
    cachedApi: (path) => answer(path),
    peekCached: () => null,
  };
}

function sectionGroup(host, id) {
  return host.querySelector(`[data-packet-sec="${id}"]`);
}

async function leaveOut(host, id) {
  await sectionGroup(host, id).querySelector('[data-packet-section="off"]').click();
  await flush();
}

test("query: defaults send nothing; none, an empty question list and encoding are explicit", () => {
  const M = load().CairnPacketBuilderModel;
  assert.equal(M.query({ sections: null, questions: null }), "");
  assert.equal(M.query({ sections: [], questions: null }), "?sections=none");
  assert.equal(M.query({ sections: ["findings", "panels"], questions: null }), "?sections=findings%2Cpanels");
  assert.equal(M.query({ sections: null, questions: [] }), "?questions=");
  assert.equal(M.query({ sections: null, questions: ["A & B?", "C"] }), "?questions=A%20%26%20B%3F&questions=C");
  const options = M.catalog(packet("/x"));
  assert.deepEqual(
    M.toggle(options, ["panels", "findings"], "supplements", true),
    ["findings", "panels", "supplements"],
    "a toggle keeps the catalog's order"
  );
  assert.deepEqual(M.toggle(options, DEFAULT, "panels", false), [
    "findings",
    "visit_questions",
    "body_composition",
    "supplements",
  ]);
});

test("the preview words a printed-range-only value apart from the lab's own flag", () => {
  const win = load();
  const report = packet("/x");
  report.findings = [
    { ...FINDING, name: "Synthetic Marker E", flag: null, lab_flagged: true, labRange: "out", labRangeSide: "low", labRangeBasis: "printed_range", outside_optimal: true },
  ];
  const model = win.CairnPacketBuilderModel.previewModel(report);
  const host = renderHtml(win.CairnPacketBuilder.previewHtml(model, { enter: true }), { document: win.document });
  const row = host.querySelector('[data-packet-pv="findings"] .packet-row');
  assert.equal(row.querySelector(".packet-flag").textContent, "Below the lab's range");
  assert.ok(row.querySelector(".packet-flag-range"), "outlined, not the lab's own flag chip");
  assert.equal(row.querySelector(".packet-opt"), null, "the range mark stands alone, as the packet prints it");
});

test("the preview marks a row as the packet does: the lab flag alone, else outside-optimal; escapes caller text, never a score", () => {
  const win = load();
  const report = packet("/x");
  report.findings = [
    FINDING,
    { ...FINDING, name: "<b>Synthetic</b>", flag: null, inOptimal: true },
    { ...FINDING, name: "Synthetic Marker C", flag: null, abnormal: false, inOptimal: false },
    // The named JSON fields win over the older ones: `abnormal` is never read.
    { ...FINDING, name: "Synthetic Marker D", abnormal: true, lab_flagged: false, outside_optimal: true },
  ];
  const model = win.CairnPacketBuilderModel.previewModel(report);
  const host = renderHtml(win.CairnPacketBuilder.previewHtml(model, { enter: true }), { document: win.document });
  const rows = host.querySelectorAll('[data-packet-pv="findings"] .packet-row');
  assert.equal(rows.length, 4);
  assert.equal(rows[3].querySelector(".packet-flag"), null, "lab_flagged: false is never a lab mark");
  assert.equal(rows[3].querySelector(".packet-opt").textContent, "Outside optimal");
  assert.equal(rows[0].querySelector(".packet-flag").textContent, "Lab: high");
  assert.equal(
    rows[0].querySelector(".packet-opt"),
    null,
    "a lab-flagged row carries the lab's flag alone, as the packet prints it"
  );
  assert.equal(rows[1].querySelector(".packet-flag"), null, "no lab flag, no mark");
  assert.equal(rows[1].querySelector(".packet-opt"), null);
  assert.equal(rows[2].querySelector(".packet-flag"), null, "not flagged by the lab");
  assert.equal(rows[2].querySelector(".packet-opt").textContent, "Outside optimal", "a separate mark, never the lab's");
  assert.equal(rows[1].querySelector("b"), null, "caller text is text, never markup");
  assert.equal(rows[1].querySelector(".packet-row-title").textContent, "<b>Synthetic</b>");
  const order = host.querySelectorAll(".packet-pv-sec").map((s) => s.dataset.packetPv);
  assert.deepEqual(order, DEFAULT, "the packet's own section order");
  assert.equal(host.querySelector('[data-packet-pv="visit_questions"] ol.packet-rows').children.length, 2);
  assert.doesNotMatch(host.textContent, /impact|score|\/\s*100/i);
});

test("toggles are the F3 segmented primitive: one labelled group per section, aria-pressed on both choices", () => {
  const win = load();
  const options = win.CairnPacketBuilderModel.catalog(packet("/x"));
  const host = renderHtml(win.CairnPacketBuilder.togglesHtml(options, DEFAULT), { document: win.document });
  const groups = host.querySelectorAll('[role="group"][data-packet-sec]');
  assert.equal(groups.length, CATALOG.length);
  const sources = sectionGroup(host, "sources");
  assert.equal(sources.getAttribute("aria-label"), "Source documents");
  assert.equal(sources.querySelector('[data-packet-section="off"]').getAttribute("aria-pressed"), "true");
  assert.equal(sources.querySelector('[data-packet-section="on"]').getAttribute("aria-pressed"), "false");
  for (const btn of host.querySelectorAll("button")) assert.equal(btn.getAttribute("type"), "button");
});

test("a section toggled off leaves the preview and every request; the share carries it", async () => {
  const win = load();
  const deps = recorder();
  const shared = [];
  const host = createHost(win.document);
  const teardown = win.CairnPacketBuilderController.mount(host, {
    ...deps,
    onShare: (kind, query) => shared.push([kind, query]),
  });
  await flush();
  assert.ok(host.querySelector('[data-packet-pv="panels"]'), "panels print by default");
  assert.equal(host.querySelector("[data-packet-disclaimer]").textContent, DISCLAIMER);

  await leaveOut(host, "panels");
  const last = deps.asked.at(-1);
  assert.match(last, /^\/health-report\.json\?sections=/);
  assert.doesNotMatch(decodeURIComponent(last), /panels/, "the request no longer names the section");
  assert.equal(host.querySelector('[data-packet-pv="panels"]'), null, "absent from the preview");
  assert.ok(host.querySelector('[data-packet-pv="findings"]'), "the rest stays");
  const group = sectionGroup(host, "panels");
  assert.equal(group.querySelector('[data-packet-section="off"]').getAttribute("aria-pressed"), "true");
  assert.ok(group.querySelector('[data-packet-section="off"]').classList.contains("active"));

  await host.querySelector("[data-packet-open]").click();
  await host.querySelector("[data-packet-text]").click();
  assert.equal(shared.length, 2);
  assert.deepEqual(
    shared.map(([kind]) => kind),
    ["open", "text"]
  );
  for (const [, query] of shared) {
    assert.match(query, /sections=/);
    assert.doesNotMatch(decodeURIComponent(query), /panels/);
  }
  assert.equal(host.querySelector("[data-packet-disclaimer]").textContent, DISCLAIMER, "the line never leaves");
  teardown();
});

test("every section off is header-only; the line still shows", async () => {
  const win = load();
  const deps = recorder();
  const host = createHost(win.document);
  win.CairnPacketBuilderController.mount(host, { ...deps, onShare() {} });
  await flush();
  for (const id of DEFAULT) await leaveOut(host, id);
  assert.equal(deps.asked.at(-1), "/health-report.json?sections=none");
  assert.equal(host.querySelectorAll(".packet-pv-sec").length, 0);
  assert.match(host.querySelector("[data-packet-preview]").textContent, /Every section is left out/);
  assert.equal(host.querySelector("[data-packet-disclaimer]").textContent, DISCLAIMER);
});

test("the questions editor lives only while its section is in", async () => {
  const win = load();
  const deps = recorder();
  const host = createHost(win.document);
  const mounts = [];
  win.CairnPacketBuilderController.mount(host, {
    ...deps,
    onShare() {},
    mountQuestions: (slot) => {
      mounts.push(slot);
      slot.innerHTML = "<p>questions</p>";
      return () => mounts.push("down");
    },
  });
  await flush();
  const slot = host.querySelector("[data-packet-questions-slot]");
  assert.equal(mounts.length, 1);
  assert.equal(slot.hasAttribute("hidden"), false);
  await leaveOut(host, "visit_questions");
  assert.equal(slot.hasAttribute("hidden"), true);
  assert.equal(mounts.length, 1, "hidden, not remounted");
});

test("cold start paints a skeleton; a failure is one calm line with Try again, and the line stays", async () => {
  const win = load();
  const deps = recorder();
  const net = { down: true };
  const host = createHost(win.document);
  win.CairnPacketBuilderController.mount(host, {
    ...deps,
    cachedApi: (path) => (net.down ? Promise.reject(new Error("offline")) : deps.cachedApi(path)),
    onShare() {},
  });
  assert.ok(host.querySelector("[data-packet-preview] .skel-card"), "skeleton on a true cold start");
  await flush();
  assert.match(host.querySelector("[data-packet-preview]").textContent, /Couldn't build the preview just now/);
  assert.equal(host.querySelector("[data-packet-disclaimer]").textContent, DISCLAIMER);
  assert.ok(host.querySelector("[data-packet-open]"), "the packet can still be opened");
  net.down = false;
  await host.querySelector("[data-packet-retry]").click();
  await flush();
  assert.ok(host.querySelector('[data-packet-pv="findings"]'), "Try again paints the preview");
  assert.ok(host.querySelector('[data-packet-sec="panels"]'), "and the toggles");
});

test("a warm SWR peek paints at once with no skeleton", () => {
  const win = load();
  const deps = recorder();
  const host = createHost(win.document);
  win.CairnPacketBuilderController.mount(host, {
    ...deps,
    peekCached: (key) => (key === "health:packet" ? { data: packet("/x"), fresh: false } : null),
    onShare() {},
  });
  assert.equal(host.querySelector("[data-packet-preview] .skel-card"), null);
  assert.ok(host.querySelector('[data-packet-pv="findings"]'));
  assert.ok(host.querySelector(".packet-paper.settle-in"), "the first paint settles in once");
});

test("a stale answer never paints over a newer selection", async () => {
  const win = load();
  const deps = recorder();
  const pending = [];
  const host = createHost(win.document);
  win.CairnPacketBuilderController.mount(host, {
    ...deps,
    api: (path) =>
      new Promise((resolve) => {
        pending.push(() => resolve(packet(path)));
      }),
    onShare() {},
  });
  await flush();
  await leaveOut(host, "panels");
  await leaveOut(host, "findings");
  assert.equal(pending.length, 2);
  pending[1]();
  await flush();
  pending[0]();
  await flush();
  assert.equal(host.querySelector('[data-packet-pv="panels"]'), null);
  assert.equal(host.querySelector('[data-packet-pv="findings"]'), null, "the older answer (findings in) was dropped");
});

test("nothing to hand over: one empty state whose action goes to Records", async () => {
  const win = load();
  const deps = recorder({ records: false });
  const host = createHost(win.document);
  let added = 0;
  win.CairnPacketBuilderController.mount(host, { ...deps, onShare() {}, onAdd: () => added++ });
  await flush();
  assert.match(host.querySelector(".empty-state-line").textContent, /Nothing to share yet/);
  assert.equal(host.querySelector("[data-packet-toggles]"), null);
  assert.equal(
    host.querySelector("[data-packet-disclaimer]").textContent,
    DISCLAIMER,
    "the informational line shows in the empty state too"
  );
  await host.querySelector("[data-packet-add]").click();
  assert.equal(added, 1);
});

test("a cached empty packet is never final: the default read revalidates and records rebuild the builder", async () => {
  const win = load();
  const deps = recorder();
  const host = createHost(win.document);
  let peeks = 0;
  win.CairnPacketBuilderController.mount(host, {
    ...deps,
    // An empty packet cached before an upload, stale by now.
    peekCached: (key) => {
      if (key !== "health:packet") return null;
      peeks++;
      return { data: packet("/x", { records: false }), fresh: false };
    },
    onShare() {},
  });
  assert.equal(peeks, 1);
  assert.match(host.querySelector(".empty-state-line").textContent, /Nothing to share yet/, "the peek paints at once");
  assert.equal(host.querySelector("[data-packet-disclaimer]").textContent, DISCLAIMER);
  await flush();
  assert.equal(deps.asked.filter((p) => p === "/health-report.json").length, 1, "one default read went out");
  assert.equal(host.querySelector(".empty-state-line"), null, "the empty state gave way");
  assert.ok(host.querySelector('[data-packet-pv="findings"]'), "the preview painted");
  assert.ok(host.querySelector('[data-packet-sec="panels"]'), "the toggles painted");
  assert.match(host.querySelector("[data-packet-status]").textContent, /sections? in the packet/);
  assert.equal(host.querySelector("[data-packet-disclaimer]").textContent, DISCLAIMER);
  // The rebuilt shell is live: a toggle still asks for the edited packet.
  await leaveOut(host, "panels");
  assert.equal(host.querySelector('[data-packet-pv="panels"]'), null);
  assert.ok(deps.asked.some((p) => p.startsWith("/health-report.json?sections=")));
});

// ---- the composition in health-share-controller.ts ----

function shareDeps(win, deps, calls) {
  return {
    root: win.document,
    api: deps.api,
    cachedApi: deps.cachedApi,
    peekCached: deps.peekCached,
    swrInvalidate: () => {},
    toast: (m) => calls.toasts.push(m),
    btnBusy: () => () => {},
    downloadFile: (href) => calls.downloads.push(href),
    select: (sel) => win.document.querySelector(sel),
    stagger: (i) => `--i:${i ?? 0}`,
    switchHealthSeg: (seg, opts) => calls.segs.push([seg, opts]),
    withToken: (url) => `${url}${url.includes("?") ? "&" : "?"}token=t`,
    // api-core's openResourceLink, recorded: the tab opens, then lands on the path.
    openResourceLink: async (path, mode = "tab") => {
      (calls.links ||= []).push({ path, mode });
      if (mode === "download") return calls.downloads.push(path);
      const tab = win.open("", "_blank");
      tab.opener = null;
      tab.location.href = path;
    },
    reducedMotion: () => false,
    openCheckup: () => {},
  };
}

// cachedApi as swr-cache.ts runs it for a cold key: the network answer arrives through onUpgrade.
function upgrading(data) {
  return async (_path, opts = {}) => {
    opts.onUpgrade?.(data, { changed: true });
    return data;
  };
}

function shareWindow() {
  const tabs = [];
  const win = load({
    open: () => {
      const tab = { opener: {}, location: { href: "" } };
      tabs.push(tab);
      return tab;
    },
    skelLines: () => `<div class="skel-card"></div>`,
  });
  return { win, tabs };
}

test("the share controller registers the packet slot; sharing carries the sections and the edited questions", async () => {
  const { win, tabs } = shareWindow();
  assert.equal(win.CairnRecordsSlot.has("packet"), true);
  const deps = recorder();
  const calls = { toasts: [], downloads: [], segs: [] };
  const host = createHost(win.document);
  const teardown = win.CairnRecordsSlot.mount("packet", host, shareDeps(win, deps, calls));
  await flush();
  assert.ok(host.querySelector(".vq-item"), "visit questions mounted in the builder's sub-slot");

  await leaveOut(host, "supplements");
  // Remove the first proposed question, add one of the athlete's own.
  await host.querySelector('[data-vq-remove="loop:synth-a"]').click();
  await flush();
  const input = host.querySelector("[data-vq-input]");
  input.value = "Synthetic question of my own?";
  await host.querySelector("[data-vq-add]").click();
  await flush();

  const preview = host.querySelector('[data-packet-pv="visit_questions"]');
  assert.deepEqual(
    preview.querySelectorAll(".packet-row-title").map((el) => el.textContent),
    ["Is the synthetic plan still right?", "Synthetic question of my own?"],
    "the preview prints the edited list"
  );
  assert.equal(host.querySelector('[data-packet-pv="supplements"]'), null);

  await host.querySelector("[data-packet-open]").click();
  assert.equal(tabs.length, 1);
  const opened = new URL(tabs[0].location.href, "http://x");
  assert.equal(opened.pathname, "/api/health-report");
  assert.equal(tabs[0].opener, null, "the report tab cannot reach back");
  assert.doesNotMatch(opened.searchParams.get("sections"), /supplements/);
  assert.deepEqual(opened.searchParams.getAll("questions"), [
    "Is the synthetic plan still right?",
    "Synthetic question of my own?",
  ]);
  assert.equal(opened.searchParams.get("token"), null, "never the master token: a signed link instead");
  assert.deepEqual(calls.links.map((l) => l.mode), ["tab"], "the report rides a signed resource link");

  await host.querySelector("[data-packet-text]").click();
  assert.deepEqual(calls.links.map((l) => l.mode), ["tab", "download"]);
  const text = new URL(calls.downloads[0], "http://x");
  assert.equal(text.pathname, "/api/health-report.txt");
  assert.deepEqual(text.searchParams.getAll("questions"), [
    "Is the synthetic plan still right?",
    "Synthetic question of my own?",
  ]);
  assert.doesNotMatch(text.searchParams.get("sections"), /supplements/);
  assert.deepEqual(calls.toasts, ["Packet downloaded as text"]);
  teardown();
});

test("with the packet slot present, Share keeps only export and hygiene; without it, the one-button report", async () => {
  const { win, tabs } = shareWindow();
  const calls = { toasts: [], downloads: [], segs: [] };
  const markers = { markers: [{ key: "a", name: "Synthetic Marker A" }], groups: [{ key: "synthetic" }] };
  const base = {
    api: async () => ({ ok: true, aligned: 0 }),
    cachedApi: upgrading(markers),
    peekCached: () => null,
  };

  const slotted = createHost(win.document, {
    html: `<div data-slot="packet"><p>builder</p></div><div id="hContent"></div>`,
  });
  win.CairnHealthShareController.render({ ...shareDeps(win, base, calls), root: slotted });
  await flush();
  assert.equal(slotted.querySelector("#hReportBtn"), null, "the builder holds the report");
  assert.ok(slotted.querySelector("#hExportBtn"));
  assert.ok(slotted.querySelector("#hAlignBtn"));
  slotted.remove();

  const legacy = createHost(win.document, { html: `<div id="hContent"></div>` });
  win.CairnHealthShareController.render({ ...shareDeps(win, base, calls), root: legacy });
  await flush();
  await legacy.querySelector("#hReportBtn").click();
  assert.equal(new URL(tabs[0].location.href, "http://x").pathname, "/api/health-report");
});

test("with the packet slot present and no markers, Share leaves the empty state to the builder", async () => {
  const { win } = shareWindow();
  const calls = { toasts: [], downloads: [], segs: [] };
  const host = createHost(win.document, { html: `<div data-slot="packet"></div><div id="hContent"></div>` });
  const deps = { api: async () => null, cachedApi: upgrading({ markers: [], groups: [] }), peekCached: () => null };
  win.CairnHealthShareController.render({ ...shareDeps(win, deps, calls), root: host });
  await flush();
  assert.equal(host.querySelector("#hContent").innerHTML, "");
});

test("the cold skeleton holds the final shape: six toggle rows and the questions' box; a failure lets the box go", async () => {
  const win = load();
  const deps = recorder();
  const host = createHost(win.document);
  const gate = {};
  win.CairnPacketBuilderController.mount(host, {
    ...deps,
    cachedApi: (path) =>
      path.startsWith("/health/visit-questions")
        ? deps.cachedApi(path)
        : new Promise((resolve, reject) => Object.assign(gate, { resolve, reject })),
    onShare() {},
  });
  // One toggle-shaped row per section of the server's fixed catalog, not three lines.
  assert.equal(host.querySelectorAll("[data-packet-toggles] .packet-toggle-skel").length, CATALOG.length);
  assert.ok(host.querySelector("[data-packet-questions-slot] .vq-skel"), "the questions' box is held");
  gate.reject(new Error("offline"));
  await flush();
  assert.equal(host.querySelector(".vq-skel"), null, "nothing is coming to fill a held box after a failure");
  assert.equal(host.querySelector(".packet-toggle-skel"), null);
});

test("the real toggles and questions land where the skeleton stood", async () => {
  const win = load();
  const deps = recorder();
  const host = createHost(win.document);
  const mountQuestions = (slot, onChange) =>
    win.CairnVisitQuestionsController.mount(slot, { cachedApi: deps.cachedApi, peekCached: deps.peekCached, onChange });
  win.CairnPacketBuilderController.mount(host, { ...deps, mountQuestions, onShare() {} });
  await flush();
  await flush();
  assert.equal(host.querySelectorAll(".packet-toggle-skel").length, 0);
  assert.equal(host.querySelectorAll("[data-packet-toggles] .packet-toggle").length, CATALOG.length);
  assert.ok(!host.querySelector(".vq-skel"), "the held box gave way to the questions");
  assert.ok(host.querySelector("[data-packet-questions-slot] .vq"));

  // With no questions component to mount, the held box does not linger.
  const bare = createHost(win.document);
  win.CairnPacketBuilderController.mount(bare, { ...deps, onShare() {} });
  await flush();
  await flush();
  assert.ok(!bare.querySelector(".vq-skel"));
});
