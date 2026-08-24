import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(join(root, "public/styles.css"), "utf8");
const design = readFileSync(join(root, "docs/DESIGN.md"), "utf8");

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

test("Today agenda skips unknown client cards and keeps primary empty", () => {
  const agenda = loadTodayAgendaClient();
  const buckets = agenda.renderableBuckets({
    primary: [
      { id: "future", kind: "future", tier: "primary", priority: 9, client_card: "future-card" },
      { id: "fuel", kind: "fuel", tier: "primary", priority: 8, client_card: "fuel" },
      { id: "week", kind: "week", tier: "primary", priority: 7, client_card: "week-ahead" },
      { id: "generic", kind: "since-last", tier: "primary", priority: 6, title: "Since last look" },
    ],
    more: [{ id: "late", kind: "lately", tier: "more", priority: 5, client_card: "lately" }],
  });

  assert.deepEqual(Array.from(buckets.primary, (c) => c.id), []);
  assert.deepEqual(
    Array.from(buckets.more, (c) => c.id),
    ["fuel", "week", "generic", "late"]
  );
});

test("Today generic agenda cards escape text, actions, and attributes", () => {
  const agenda = loadTodayAgendaClient();
  const html = agenda.genericCardHtml(
    {
      id: `card"1`,
      kind: "life<event>",
      tier: "primary",
      priority: 1,
      kicker: "<kicker>",
      title: "Check <this>",
      body: `Body "quote" & more`,
      action: { label: "Open <now>", kind: `tab:"bad"` },
      dismissible: true,
    },
    0
  );

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
  const html = agenda.railHtml(
    {
      primary: [
        { id: "fuel", kind: "fuel", tier: "primary", priority: 5, client_card: "fuel" },
        { id: "week", kind: "week", tier: "primary", priority: 4, client_card: "week-ahead" },
        { id: "generic", kind: "since-last", tier: "primary", priority: 3, title: "New signal" },
      ],
      more: [{ id: "late", kind: "lately", tier: "more", priority: 2, client_card: "lately" }],
    },
    pending
  );

  assert.match(html, /id="fuelSlot"/);
  assert.match(html, /id="weekAheadSlot"/);
  assert.match(html, /class="today-rail card-stack"/);
  assert.match(html, /class="fuel-slot card-stack-item"/);
  assert.match(html, /class="today-more card-stack-item"/);
  assert.match(html, /class="today-more-body card-stack"/);
  assert.match(html, /4 more/);
  assert.doesNotMatch(html, /rail-mast/);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "generic");
});

test("Today rail card spacing is stack-owned and documented", () => {
  assert.match(styles, /--space-card:\s*10px/);
  assert.match(styles, /\.card-stack\{display:flex;flex-direction:column;gap:var\(--space-card\)\}/);
  assert.match(styles, /\.card-stack>\.card-stack-item:empty\{display:none\}/);
  assert.match(design, /\.card-stack` \/ `\.card-stack-item`/);
  assert.match(design, /card\s+components must not supply inter-card margins/i);
});

test("Today fuel card stays quiet when empty and links only to review/edit", () => {
  const agenda = loadTodayAgendaClient();
  assert.equal(
    agenda.fuelCardHtml({ count: 0, totals: {}, entries: [], date: "2026-06-29", target: null, remaining: null }),
    ""
  );

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
  assert.match(html, /data-cu="97">0<\/span><span class="fuel-unit">g P/);
  assert.match(html, /120g C/);
  assert.match(html, /42g F/);
  assert.match(html, /12g fiber/);
  assert.doesNotMatch(html, /chat|log something/i);

  const partial = agenda.fuelCardHtml({
    count: 1,
    date: "2026-06-29",
    totals: { kcal: 500, protein_g: 0, carbs_g: 0, fat_g: 18, fiber_g: 0 },
    known: { kcal: true, protein_g: false, carbs_g: false, fat_g: true, fiber_g: false },
    entries: [],
    target: null,
    remaining: null,
  });
  assert.match(partial, /&mdash;/);
  assert.doesNotMatch(partial, /0g P|0g C|0g fiber/);
});

test("client buckets collapse server primary into more (Brief + one action)", () => {
  const agenda = loadTodayAgendaClient();
  // Even if a server still names an inline card, the client keeps primary empty
  // so the daily open is the Brief plus one action.
  const buckets = agenda.renderableBuckets({
    primary: [{ id: "health-focus", kind: "health", tier: "primary", priority: 80, title: "Iron is the priority." }],
    more: [
      { id: "weekly-read", kind: "weekly", tier: "more", priority: 54, client_card: "weekly-read" },
      { id: "lately", kind: "lately", tier: "more", priority: 20, client_card: "lately" },
    ],
  });
  assert.deepEqual(Array.from(buckets.primary, (c) => c.id), []);
  assert.deepEqual(
    Array.from(buckets.more, (c) => c.id),
    ["health-focus", "weekly-read", "lately"]
  );

  const skew = agenda.renderableBuckets({
    primary: [
      { id: "future", kind: "future", tier: "primary", priority: 90, client_card: "future-card" },
      { id: "fuel", kind: "fuel", tier: "primary", priority: 8, client_card: "fuel" },
    ],
    more: [{ id: "lately", kind: "lately", tier: "more", priority: 5, client_card: "lately" }],
  });
  assert.deepEqual(Array.from(skew.primary, (c) => c.id), []);
  assert.deepEqual(
    Array.from(skew.more, (c) => c.id),
    ["fuel", "lately"]
  );
});

test("the disclosure whispers when something genuinely new waits inside", () => {
  const agenda = loadTodayAgendaClient();
  const pending = [];
  const html = agenda.railHtml(
    {
      primary: [{ id: "health-focus", kind: "health", tier: "primary", priority: 80, title: "Iron leads." }],
      more: [
        { id: "weekly-read", kind: "weekly", tier: "more", priority: 54, client_card: "weekly-read", waiting: true },
        { id: "lately", kind: "lately", tier: "more", priority: 20, client_card: "lately" },
      ],
    },
    pending
  );
  assert.match(html, /today-more-new/);
  assert.match(html, /· one new inside/);

  // No waiting items → no whisper.
  const quiet = agenda.railHtml(
    {
      primary: [],
      more: [{ id: "lately", kind: "lately", tier: "more", priority: 20, client_card: "lately" }],
    },
    []
  );
  assert.doesNotMatch(quiet, /today-more-new/);
});
