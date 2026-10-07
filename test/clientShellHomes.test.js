// The five-home shell (v2 wave 5, stream A): the tab bar is Today / Train / Horizon /
// Ask / You, the manifest shortcuts speak the v2 grammar, the once-per-home "what
// moved here" line, and the placeholder You and Horizon landings the shell ships so
// the app is whole before streams B and C fill them. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHost, createStorage, loadClientModule } from "./_dom.mjs";
import { BUNDLES, CLIENT_OUTPUTS } from "../scripts/build-client.mjs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

function loadRoutes() {
  const context = { window: {}, URL, URLSearchParams };
  vm.runInNewContext(read("public/js/route-state.js"), context);
  return context.window.CairnRoutes;
}

test("the tab bar is five homes, in the order muscle memory already knows", () => {
  const html = read("public/index.html");
  const nav = html.slice(html.indexOf('<nav class="tabbar"'), html.indexOf("</nav>"));
  const buttons = [...nav.matchAll(/<button class="tab[^"]*" data-tab="([a-z]+)" aria-label="([^"]+)"/g)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.deepEqual(buttons, [
    ["today", "Today"],
    ["train", "Train"],
    ["horizon", "Horizon"],
    ["ask", "Ask"],
    ["you", "You"],
  ]);
  assert.ok(buttons.length <= 5, "the acceptance bound: five items or fewer");
  // Every button names a real home the route contract knows.
  const routes = loadRoutes();
  assert.deepEqual(
    buttons.map(([home]) => home),
    [...routes.homes]
  );
  // The moved-here line lives in the shell header, outside #view.
  assert.match(html, /<header>[\s\S]*<p id="movedNote" class="moved-note" hidden><\/p>[\s\S]*<\/header>/);
});

test("manifest shortcuts open v2 homes directly, never through a redirect", () => {
  const manifest = JSON.parse(read("public/manifest.json"));
  const routes = loadRoutes();
  const urls = manifest.shortcuts.map((s) => s.url);
  assert.deepEqual(urls, [
    "/app/today?source=shortcut",
    "/app/ask?source=shortcut",
    "/app/train/sessions?source=shortcut",
  ]);
  for (const url of urls) assert.equal(routes.parseRoute(url).legacy, false, url);
  assert.equal(manifest.shortcuts[1].short_name, "Ask");
  assert.equal(manifest.shortcuts[2].name, "Train history");
});

test("streams B, C and D find their file slots already registered", () => {
  const outputs = new Set(CLIENT_OUTPUTS.map((o) => o.source));
  const bundleOf = (file) => BUNDLES.find((b) => b.inputs.includes(file));
  // You paints as fast as Today (eager); Horizon and the Ask thread's ripple card
  // ride their homes' lazy bundles, injected on first navigation and warmed on idle.
  const slots = {
    "public/js/bundle-02-today.js": {
      lazy: undefined,
      stems: [
        "cairn-stack-model",
        "cairn-stack-client",
        "cairn-stack-controller",
        "stone-detail-model",
        "stone-detail-client",
        "stone-detail-controller",
        "you-screen",
      ],
    },
    "public/js/bundle-09-horizon.js": {
      lazy: "horizon",
      stems: ["horizon-model", "horizon-labs-model", "horizon-week-client", "horizon-week-controller", "horizon-terrain-client", "horizon-chart-client", "horizon-client", "horizon-controller", "horizon-screen"],
    },
    // The shared time objects ride the calendar bundle horizon (and today-ahead, train) depend on.
    "public/js/bundle-12-calendar.js": {
      lazy: "calendar",
      stems: ["week-model", "week-strip-client", "milestone-row-model", "milestone-row-client", "goal-row-model", "goal-row-client", "frame-line-client"],
    },
    "public/js/bundle-10-ask.js": {
      lazy: "ask",
      stems: ["ripple-card-model", "ripple-card-client", "ripple-card-controller"],
    },
  };
  for (const [bundle, { lazy, stems }] of Object.entries(slots)) {
    for (const stem of stems) {
      assert.ok(outputs.has(`src/client/${stem}.ts`), `${stem} is a client output`);
      const owner = bundleOf(`public/js/${stem}.js`);
      assert.equal(owner?.output, bundle, `${stem} rides ${bundle}`);
      assert.equal(owner.lazy, lazy, `${stem} is ${lazy ? `lazy (${lazy})` : "eager"}`);
    }
  }
});

function loadMovedNote(initial = {}) {
  const storage = createStorage(initial);
  const win = loadClientModule(["html-utils", "app-moved-note"], { globals: { localStorage: storage } });
  const header = createHost(win.document, { tag: "header" });
  header.innerHTML = `<p id="movedNote" class="moved-note" hidden></p>`;
  win.document.body.appendChild(header);
  return { win, storage, el: win.document.getElementById("movedNote") };
}

test("the moved-here line shows once per home, on its landing, for a device that knew the old tabs", () => {
  const { win, storage, el } = loadMovedNote({ "cairn.brief.v1": "{}" });
  const note = win.CairnMovedNote;

  note.sync("you", "you");
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /Health, About you and Settings now live in You\./);
  assert.equal(storage.getItem(note.STAMP_KEY), "upgraded");

  // A sub-view under the same home is not the landing: the line steps aside.
  note.sync("stand", "you");
  assert.equal(el.hidden, true);

  // Dismissed once, gone for good on that home, still offered on the others.
  note.sync("you", "you");
  el.querySelector("[data-moved-dismiss]").click();
  assert.equal(el.hidden, true);
  assert.equal(storage.getItem(`${note.DISMISS_PREFIX}you`), "1");
  note.sync("you", "you");
  assert.equal(el.hidden, true);
  note.sync("chat", "ask");
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /Coach is now Ask/);
});

test("a brand-new device never sees a line about tabs it never knew", () => {
  const { win, storage, el } = loadMovedNote({ "cairn.diagnostics.v1": "[]" });
  win.CairnMovedNote.sync("today", "today");
  assert.equal(el.hidden, true);
  assert.equal(storage.getItem(win.CairnMovedNote.STAMP_KEY), "fresh");
  // The verdict is kept: state written later does not turn a new device into an old one.
  storage.setItem("cairn.brief.v1", "{}");
  win.CairnMovedNote.sync("today", "today");
  assert.equal(el.hidden, true);
});

test("the moved-here line works with no storage at all", () => {
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    get length() {
      throw new Error("blocked");
    },
    key() {
      throw new Error("blocked");
    },
  };
  const note = loadClientModule(["html-utils", "app-moved-note"], {
    globals: { localStorage: throwing },
  }).CairnMovedNote;
  assert.equal(note.noteFor("you", "you", throwing), null, "no storage reads as a new device: nothing shown");
  assert.doesNotThrow(() => note.dismiss("you", throwing));
});

test("every home's moved-here line is calm prose on that home's landing view", () => {
  const { win } = loadMovedNote();
  const routes = loadRoutes();
  const notes = win.CairnMovedNote.NOTES;
  assert.deepEqual(Object.keys(notes), [...routes.homes]);
  for (const [home, { view, section, text }] of Object.entries(notes)) {
    assert.equal(routes.viewFor(home), view, `${home}'s line sits on its landing view`);
    if (section) assert.ok(routes.routeDefinitions.sections[view].includes(section), `${home}'s section is one ${view} knows`);
    assert.doesNotMatch(text, /\d|%|score|must|!/i, `${home}: no numbers, no gate, no shouting`);
  }
  // Train's line is about Program, so it names that section of the progress view.
  assert.equal(notes.train.section, "program");
});

test("the moved-here line sits on the one section it is about, never its siblings in the same view", () => {
  const { win, el } = loadMovedNote({ "cairn.brief.v1": "{}" });
  const note = win.CairnMovedNote;

  // Train: Program, Fuel and Body are all sections of the one "progress" view. The
  // plan line belongs to Program only; on Fuel it would point at the wrong thing.
  note.sync("progress", "train", "program");
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /Your plan now lives in Train, under Program\./);
  for (const section of ["overview", "intake", "energy", "weight", "measurements", "sessions", null]) {
    note.sync("progress", "train", section);
    assert.equal(el.hidden, true, `no plan line on Train's ${section ?? "bare"} section`);
  }

  // A home whose line names no section shows it on the bare landing only: a stone
  // detail under You, or Horizon's goal line, is not the landing.
  note.sync("you", "you", "stone");
  assert.equal(el.hidden, true);
  note.sync("you", "you", null);
  assert.equal(el.hidden, false);
  note.sync("horizon", "horizon", "goal");
  assert.equal(el.hidden, true);
  note.sync("horizon", "horizon");
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /race build now lives in Horizon/);

  assert.equal(note.noteFor("progress", "train", null, "program"), null, "no storage still reads as a new device");
});

function loadYou() {
  const tabs = [];
  const state = { standSeg: "markers", standDomain: "lipids", meSeg: "profile", setSeg: "sources" };
  const modules = ["html-utils", "ui-actions-client", "ui-stone-model", "ui-stone", "cairn-stack-model", "cairn-stack-client", "cairn-stack-controller"];
  modules.push("stone-detail-model", "stone-detail-client", "stone-detail-controller", "you-screen");
  const win = loadClientModule(modules, {
    globals: {
      state,
      headerTitle: { textContent: "" },
      activateTab: (name) => tabs.push(name),
      // The cairn-stack's read (its own tests live in clientCairnStack.test.js).
      localISO: () => "2026-09-26",
      peekCached: () => null,
      cachedApi: () => new Promise(() => {}),
      reducedMotion: () => true,
      routeApi: () => null,
    },
  });
  win.view = createHost(win.document);
  return { win, tabs, state };
}

test("the You landing lists Health, About you and Settings and opens each where it lives", () => {
  const { win, tabs, state } = loadYou();
  win.renderYou();
  assert.equal(win.headerTitle.textContent, "You");
  const headings = [...win.view.querySelectorAll(".you-group-h")].map((h) => h.textContent);
  assert.deepEqual(headings, ["Health", "About you", "Settings"]);
  assert.match(win.view.textContent, /Health: where you stand/);
  assert.doesNotMatch(win.view.textContent, /Stand\b(?!ing)/, "Stand reads as Health in athlete-facing copy");

  win.view.querySelector('[data-you-view="stand"][data-you-section=""]').click();
  assert.equal(state.standSeg, null, "the Health row opens the overview");
  assert.equal(state.standDomain, null);
  win.view.querySelector('[data-you-view="me"][data-you-section="family"]').click();
  assert.equal(state.meSeg, "family");
  win.view.querySelector('[data-you-view="settings"][data-you-section="data"]').click();
  assert.equal(state.setSeg, "data");
  assert.deepEqual(tabs, ["stand", "me", "settings"]);
});

// The Horizon landing itself (the timeline, its lanes and the goal section) is
// covered by test/clientHorizon.test.js.

// The moved-here line never squeezes a header's controls: it is a quiet full-width
// line of its own, and a header that carries controls (Ask's Changes / history /
// fresh-start cluster, appended into <header>) puts them on the TITLE's row with the
// line below them, never beside or under them.
test("the moved-here line is a quiet full-width line below a header's controls", () => {
  const css = read("public/styles.css");
  const rule = (selector) => {
    const at = css.indexOf(`${selector}{`);
    assert.ok(at >= 0, `${selector} is styled`);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(".moved-note"), /display:block/);
  assert.match(rule(".moved-note"), /font-size:var\(--text-xs\)/);
  assert.match(rule(".moved-note-dismiss"), /min-height:44px/, "Got it stays a 44px target");
  assert.match(rule("header:has(> .hdr-chat-actions)"), /display:grid/);
  assert.match(rule("header:has(> .hdr-chat-actions) > .hdr-chat-actions"), /position:static;grid-column:2;grid-row:1/);
  assert.match(rule("header:has(> .hdr-chat-actions) > .moved-note"), /grid-column:1 \/ -1;grid-row:2/);
  // The cluster is appended to <header> itself, which is what the grid keys on.
  assert.match(read("src/client/chat-header-controller.ts"), /document\.querySelector\("header"\)!\.appendChild\(wrap\)/);
});
