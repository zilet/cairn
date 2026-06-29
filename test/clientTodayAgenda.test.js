import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

function loadTodayAgendaClient() {
  const context = {
    Math,
    Number,
    String,
    escHtml,
    escAttr,
    stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-agenda-client.js"), "utf8"), context);
  return context.CairnTodayAgenda;
}

test("Today agenda skips unknown client cards and caps primary cards at two", () => {
  const agenda = loadTodayAgendaClient();
  const buckets = agenda.renderableBuckets({
    primary: [
      { id: "future", kind: "future", tier: "primary", priority: 9, client_card: "future-card" },
      { id: "fuel", kind: "fuel", tier: "primary", priority: 8, client_card: "fuel" },
      { id: "week", kind: "week", tier: "primary", priority: 7, client_card: "week-ahead" },
      { id: "generic", kind: "since-last", tier: "primary", priority: 6, title: "Since last look" },
    ],
    more: [
      { id: "late", kind: "lately", tier: "more", priority: 5, client_card: "lately" },
    ],
  });

  assert.deepEqual(Array.from(buckets.primary, (c) => c.id), ["fuel", "week"]);
  assert.deepEqual(Array.from(buckets.more, (c) => c.id), ["generic", "late"]);
});

test("Today generic agenda cards escape text, actions, and attributes", () => {
  const agenda = loadTodayAgendaClient();
  const html = agenda.genericCardHtml({
    id: `card"1`,
    kind: "life<event>",
    tier: "primary",
    priority: 1,
    kicker: "<kicker>",
    title: "Check <this>",
    body: `Body "quote" & more`,
    action: { label: "Open <now>", kind: `tab:"bad"` },
    dismissible: true,
  }, 0);

  assert.match(html, /data-agenda-card="card&quot;1"/);
  assert.match(html, /data-agenda-kind="life&lt;event&gt;"/);
  assert.match(html, /&lt;kicker&gt;/);
  assert.match(html, /Check &lt;this&gt;/);
  assert.match(html, /Body "quote" &amp; more/);
  assert.match(html, /data-agenda-act="tab:&quot;bad&quot;"/);
  assert.match(html, /Open &lt;now&gt;/);
});

test("Today rail HTML collects generic cards and uses one quiet more disclosure", () => {
  const agenda = loadTodayAgendaClient();
  const pending = [];
  const html = agenda.railHtml({
    primary: [
      { id: "fuel", kind: "fuel", tier: "primary", priority: 5, client_card: "fuel" },
      { id: "week", kind: "week", tier: "primary", priority: 4, client_card: "week-ahead" },
      { id: "generic", kind: "since-last", tier: "primary", priority: 3, title: "New signal" },
    ],
    more: [
      { id: "late", kind: "lately", tier: "more", priority: 2, client_card: "lately" },
    ],
  }, pending);

  assert.match(html, /id="fuelSlot"/);
  assert.match(html, /id="weekAheadSlot"/);
  assert.match(html, /2 more/);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "generic");
});

test("Today fuel card stays quiet when empty and links only to review/edit", () => {
  const agenda = loadTodayAgendaClient();
  assert.equal(agenda.fuelCardHtml({ count: 0, totals: {}, entries: [], date: "2026-06-29", target: null, remaining: null }), "");

  const html = agenda.fuelCardHtml({
    count: 2,
    date: "2026-06-29",
    totals: { kcal: 1220, protein_g: 97, carbs_g: 120, fat_g: 42, fiber_g: 12 },
    entries: [],
    target: { kcal: 2400, protein_g: 180, mode: "maintain" },
    remaining: { kcal: 1180, protein_g: 83 },
  });

  assert.match(html, /id="fuelCard"/);
  assert.match(html, /Review &amp; edit today's food/);
  assert.match(html, /Today's fuel · 2 items/);
  assert.match(html, /data-cu="1220"/);
  assert.doesNotMatch(html, /chat|log something/i);
});
