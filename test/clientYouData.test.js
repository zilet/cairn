// "Your data" on the You home (you-data-client / you-data-controller, composed by
// you-screen): one row per source off GET /api/health/data-coverage — a dot in its stone
// hue, the name, what it holds, a freshness date or a dawn "Add"/"Connect" — then a soft
// well of at most two gaps. Every word is the server's, every string escaped. "+ Add"
// opens a sheet whose File / Photo / Paste hand off to Records' own upload, and a file
// dropped on the card takes the same path. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, fire, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const MODULES = ["html-utils", "ui-actions-client", "you-data-client", "you-data-controller"];

function row(key, label, holds, extra = {}) {
  return {
    key,
    label,
    holds,
    state: "present",
    cta: null,
    date: "2026-05-02",
    date_words: "May 2",
    synced_at: null,
    quiet: false,
    doc_id: null,
    opens: "records",
    ...extra,
  };
}

function read(overrides = {}) {
  return {
    as_of: "2026-06-10",
    rows: [
      row("labs", "Labs", "2 blood draws", { doc_id: 7 }),
      row("scans", "Scans", "CT scan", { date_words: "Apr 30", doc_id: 9 }),
      row("garmin", "Garmin", "Sleep, heart rate and activities", {
        opens: "sources",
        synced_at: "2026-06-10T08:00:00Z",
        date_words: "today",
      }),
      row("apple_health", "Apple Health", "Sleep, steps and heart rate", {
        opens: "sources",
        state: "absent",
        cta: "Connect",
        date: null,
        date_words: null,
      }),
      row("body", "Body", "DEXA scans", { opens: "body", date_words: "Feb 1", quiet: false }),
    ],
    gaps: [
      {
        key: "panel:lipids",
        subject: "ApoB and LDL-C",
        why: "When it suits you, a recheck would help the team.",
        action: "checkup",
        action_label: "See checkup",
      },
      { key: "labs:none", subject: "A blood panel", why: "One panel helps.", action: "add", action_label: "Add one" },
    ],
    frame: "What Cairn reads about you.",
    ...overrides,
  };
}

function load(globals = {}) {
  return loadClientModule(MODULES, { globals });
}

test("the card: one row per source, its hue, what it holds, and how fresh it is", () => {
  const win = load();
  const host = renderHtml(win.CairnYouData.html(read(), { relTime: () => "2h ago" }));
  assert.equal(host.querySelector(".you-data-h").textContent, "Your data");
  assert.ok(host.querySelector("[data-you-data-add]"), "one + Add");
  const rows = host.querySelectorAll(".you-data-row");
  assert.deepEqual(
    rows.map((r) => r.getAttribute("data-you-data-open")),
    ["labs", "scans", "garmin", "apple_health", "body"]
  );
  assert.deepEqual(
    host.querySelectorAll(".you-data-dot").map((d) => d.getAttribute("class")),
    [
      "you-data-dot stone-heart",
      "you-data-dot stone-strength",
      "you-data-dot stone-endurance",
      "you-data-dot stone-recovery",
      "you-data-dot stone-body",
    ]
  );
  assert.equal(rows[0].querySelector(".you-data-holds").textContent, "2 blood draws");
  assert.equal(rows[0].querySelector(".you-data-when").textContent, "May 2");
  assert.equal(rows[2].querySelector(".you-data-when").textContent, "synced 2h ago", "a live wearable shows its clock");
  assert.ok(rows[3].classList.contains("is-absent"), "not connected: the hollow dot");
  assert.equal(rows[3].querySelector(".you-data-cta").textContent, "Connect");
  assert.equal(rows[3].querySelector(".you-data-when"), null, "no date where there is nothing yet");
  assert.match(rows[3].getAttribute("aria-label"), /Apple Health, Sleep, steps and heart rate, Connect/);
  assert.equal(
    host.querySelector(".you-data-dot").getAttribute("aria-hidden"),
    "true",
    "the dot is never the only signal"
  );
});

test("the gaps: a soft well of at most two, each a subject, a sentence and a link; hidden when there are none", () => {
  const win = load();
  const many = read({
    gaps: [
      ...read().gaps,
      { key: "x", subject: "Third", why: "Never shown.", action: "sources", action_label: "Open" },
    ],
  });
  const host = renderHtml(win.CairnYouData.html(many));
  assert.equal(host.querySelector(".you-data-gaps-h").textContent, "Would sharpen your reads");
  const gaps = host.querySelectorAll(".you-data-gap");
  assert.equal(gaps.length, 2, "never more than two");
  assert.equal(gaps[0].querySelector(".you-data-gap-s").textContent, "ApoB and LDL-C");
  assert.equal(gaps[0].querySelector(".you-data-gap-go").textContent, "See checkup");
  assert.doesNotMatch(host.textContent, /Third/);

  const calm = renderHtml(win.CairnYouData.html(read({ gaps: [] })));
  assert.equal(calm.querySelector(".you-data-gaps"), null, "nothing to sharpen: no list at all");
});

test("every string is escaped, and a read that is not a coverage read renders nothing", () => {
  const win = load();
  const hostile = read({
    rows: [row("labs", "<b>Labs</b>", "<img src=x>", { date_words: "<i>May</i>" })],
    gaps: [{ key: "k", subject: "<b>s</b>", why: "<script>x</script>", action: "checkup", action_label: "<u>go</u>" }],
  });
  const host = renderHtml(win.CairnYouData.html(hostile));
  assert.equal(host.querySelector("b"), null);
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.querySelector("script"), null);
  assert.equal(host.querySelector(".you-data-label").textContent, "<b>Labs</b>");
  assert.equal(win.CairnYouData.html({ date: "2026-06-10", stones: [] }), "", "a stones read is not this read");
  assert.equal(win.CairnYouData.html(null), "");
  assert.equal(win.CairnYouData.html({ rows: [] }), "");
});

function sheetStub(win) {
  const opened = [];
  win.CairnUiSheet = {
    open(options) {
      const sheet = win.document.createElement("div");
      sheet.innerHTML = options.html;
      win.document.body.appendChild(sheet);
      const handle = {
        sheet,
        closed: false,
        close() {
          handle.closed = true;
          sheet.remove();
        },
      };
      opened.push({ options, handle });
      return handle;
    },
  };
  return opened;
}

function mount(win, { warm = null, respond = () => Promise.resolve(read()) } = {}) {
  const calls = { loads: [], rows: [], gaps: [], files: [], pastes: 0, sources: 0 };
  const host = createHost(win.document);
  const teardown = win.CairnYouDataController.mount(host, {
    peek: () => (warm ? { data: warm, fresh: true } : null),
    load: (path, options) => {
      calls.loads.push([path, options.key]);
      return respond();
    },
    relTime: () => "5m ago",
    openRow: (r) => calls.rows.push(r.key),
    openGap: (g) => calls.gaps.push(g.key),
    addFiles: (files) => calls.files.push(files.map((f) => f.name)),
    addPaste: () => calls.pastes++,
    openSources: () => calls.sources++,
  });
  return { host, calls, teardown };
}

test("the controller: skeleton, then the card under its memory-only key; rows and gaps go where they live", async () => {
  const win = load();
  const opened = sheetStub(win);
  const { host, calls } = mount(win);
  assert.ok(host.querySelector(".you-data-card.is-loading"), "a cold open shows the card's skeleton");
  await flush();
  assert.deepEqual(calls.loads, [["/health/data-coverage", "health:data-coverage"]]);
  assert.match(calls.loads[0][1], /^health:/, "health data stays in memory, never on disk");
  assert.equal(host.querySelectorAll(".you-data-row").length, 5);

  await host.querySelector('[data-you-data-open="scans"]').click();
  await host.querySelector('[data-you-data-open="apple_health"]').click();
  assert.deepEqual(calls.rows, ["scans", "apple_health"]);
  await host.querySelector('[data-you-data-gap="panel:lipids"]').click();
  assert.deepEqual(calls.gaps, ["panel:lipids"]);
  await host.querySelector('[data-you-data-gap="labs:none"]').click();
  assert.equal(opened.length, 1, "an 'add' gap opens the Add sheet rather than navigating");
  assert.deepEqual(calls.gaps, ["panel:lipids"]);
});

test("a cold read that fails collapses the slot; a warm card survives a failed revalidation", async () => {
  const win = load();
  const cold = mount(win, { respond: () => Promise.reject(new Error("offline")) });
  await flush();
  assert.equal(cold.host.innerHTML, "");
  const warm = mount(win, { warm: read(), respond: () => Promise.reject(new Error("offline")) });
  await flush();
  assert.equal(warm.host.querySelectorAll(".you-data-row").length, 5);
});

test("+ Add: three equal ways in and a row into Sources, each handing off and closing the sheet", async () => {
  const win = load();
  const opened = sheetStub(win);
  const { host, calls } = mount(win, { warm: read() });
  await host.querySelector("[data-you-data-add]").click();
  assert.equal(opened.length, 1);
  const { options, handle } = opened[0];
  assert.equal(options.labelledBy, "youAddH");
  const sheet = handle.sheet;
  assert.deepEqual(
    sheet.querySelectorAll(".you-add-opt").map((b) => b.textContent.trim()),
    ["File", "Photo", "Paste"]
  );
  assert.match(sheet.querySelector(".you-add-src").textContent, /Connect a source/);
  assert.equal(sheet.querySelector('[data-you-add-input="photo"]').getAttribute("capture"), "environment");

  // File: the picker opens inside the tap; a chosen file is handed to Records' upload.
  const input = sheet.querySelector('[data-you-add-input="file"]');
  let picked = 0;
  input.addEventListener("click", () => picked++);
  await sheet.querySelector('[data-you-add="file"]').click();
  assert.equal(picked, 1, "the hidden input is clicked within the gesture");
  input.files = [{ name: "panel.pdf" }];
  await fire(input, "change");
  assert.deepEqual(calls.files, [["panel.pdf"]]);
  assert.equal(handle.closed, true);

  await host.querySelector("[data-you-data-add]").click();
  await opened[1].handle.sheet.querySelector('[data-you-add="paste"]').click();
  assert.equal(calls.pastes, 1);
  assert.equal(opened[1].handle.closed, true);

  await host.querySelector("[data-you-data-add]").click();
  await opened[2].handle.sheet.querySelector('[data-you-add="sources"]').click();
  assert.equal(calls.sources, 1);
});

test("a file dropped on the card goes to the same upload", async () => {
  const win = load();
  sheetStub(win);
  const { host, calls } = mount(win, { warm: read() });
  const card = host.querySelector("[data-you-data-drop]");
  const dataTransfer = { types: ["Files"], files: [{ name: "scan.pdf" }] };
  await fire(card, "dragover", { dataTransfer });
  assert.ok(card.classList.contains("is-drop"), "the card lights while a file is over it");
  await fire(card, "drop", { dataTransfer });
  assert.equal(card.classList.contains("is-drop"), false);
  assert.deepEqual(calls.files, [["scan.pdf"]]);
});

// ---------- the hand-off, on the Records side (me-records-health-doc-controller) ----------

function loadRecords(state) {
  const seen = [];
  let win = null;
  class FakeTransfer {
    constructor() {
      this.list = [];
      this.items = { add: (file) => this.list.push(file) };
    }
    get files() {
      return this.list;
    }
  }
  win = loadClientModule(["me-records-health-doc-controller"], {
    globals: {
      File,
      DataTransfer: FakeTransfer,
      reducedMotion: () => true,
      peekCached: () => null,
      swrSet: () => {},
      CairnHealthRecords: {
        recordsTabHtml: () =>
          `<div class="hupload" id="hUploadBox"><input id="hFile" type="file" hidden><textarea id="hText"></textarea></div><div id="hlist"></div>`,
        recordsEmptyHtml: () => "",
        recordsListHtml: () => "",
      },
      // Records' own upload wiring runs BEFORE the hand-off, so its change handler is
      // the one that receives the files — here, a recorder in its place.
      CairnHealthDocUploadController: {
        wireUpload: () => {
          const input = win.document.querySelector("#hFile");
          input.addEventListener("change", () => seen.push([...input.files].map((f) => f.name)));
        },
      },
      CairnOffline: { isUnreachable: () => false },
    },
  });
  win.$ = (selector) => win.document.querySelector(selector);
  const host = createHost(win.document, { html: `<div id="hContent"></div>` });
  return { win, host, seen, deps: { state, api: () => Promise.resolve([]) } };
}

test("Records takes the hand-off once: picked files ride into its own file input, Paste focuses its text field", async () => {
  const picked = new File(["synthetic"], "panel.pdf", { type: "application/pdf" });
  const state = { tab: "stand", standSeg: "records", pendingRecordsAdd: { files: [picked] } };
  const rec = loadRecords(state);
  rec.win.CairnHealthRecordsController.render(rec.deps);
  await flush();
  assert.deepEqual(rec.seen, [["panel.pdf"]], "the upload's own change handler reads the picked file");
  assert.equal(state.pendingRecordsAdd, null, "one shot");

  rec.win.CairnHealthRecordsController.render(rec.deps);
  assert.deepEqual(rec.seen, [["panel.pdf"]], "a later paint hands nothing over again");

  state.pendingRecordsAdd = { paste: true };
  rec.win.CairnHealthRecordsController.render(rec.deps);
  assert.equal(rec.win.document.activeElement, rec.host.querySelector("#hText"), "Paste lands in the text field");
  assert.equal(state.pendingRecordsAdd, null);
});
