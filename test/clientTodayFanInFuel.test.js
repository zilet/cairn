// The Today open, client side: the Fuel glance under the Brief asks for its day and its
// ideas through the real request layer (api-core.ts) after primeFanIn (today-prefetch.ts)
// registered the /today fan-in — so a fan-in that carries both answers the glance with
// no request of its own, and one that came back without a path leaves only that path to
// its own request. Counted at fetch, the one place a round trip can happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { runApiClientModules } from "./_apiClientModules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATE = "2026-09-26";
const NOW = new Date(`${DATE}T10:20:00`).getTime();
const AGGREGATE = `/today?date=${DATE}&surface=today`;
const DAY = `/nutrition/day?date=${DATE}`;
const IDEAS = `/fuel/ideas?date=${DATE}&hour=10`;

const day = {
  entries: [{ id: 1 }],
  count: 1,
  totals: { protein_g: 40, kcal: 600 },
  known: { protein_g: true, kcal: true },
  target: { protein_g: 160, kcal: 2400 },
};
const ideas = { kind: "ideas", ideas: [{ title: "Greek yogurt bowl", protein_g: 30, kcal: 350 }] };

function load(responses) {
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [NOW]));
    }
    static now() {
      return NOW;
    }
  }
  const urls = [];
  const element = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    appendChild: (child) => child,
    querySelector: () => null,
    addEventListener() {},
  });
  const context = {
    Date: FakeDate,
    document: {
      body: element(),
      head: element(),
      querySelector: () => null,
      getElementById: () => null,
      createElement: element,
    },
    window: { addEventListener() {}, prompt: () => "" },
    navigator: { onLine: true },
    location: { reload() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/New_York" }) }) },
    encodeURIComponent,
    Promise,
    escHtml: (value) => String(value ?? ""),
    escAttr: (value) => String(value ?? ""),
    fetch: async (url) => {
      urls.push(url);
      const body = url === `/api${AGGREGATE}` ? { date: DATE, responses } : { own: url };
      return { status: 200, headers: { get: () => null }, json: async () => body };
    },
  };
  runApiClientModules(context);
  for (const file of ["today-data-loader", "today-prefetch", "today-fuel-glance-client"]) {
    vm.runInNewContext(readFileSync(join(root, `public/js/${file}.js`), "utf8"), context, { filename: `${file}.js` });
  }
  return { context, urls };
}

function openToday(context) {
  context.CairnTodayPrefetch.primeFanIn(DATE, { api: context.api, localISO: () => DATE });
  const host = { innerHTML: "", isConnected: true, addEventListener() {}, removeEventListener() {}, remove() {} };
  const asked = [];
  context.CairnTodayFuelGlance.mount(host, {
    date: DATE,
    peek: () => null,
    load: (path) => {
      asked.push(path);
      return context.api(path);
    },
    open() {},
  });
  return { host, asked };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("the Fuel glance takes its day and its ideas from the Today fan-in: one request for the open", async () => {
  const { context, urls } = load({ [DAY]: day, [IDEAS]: ideas });
  const { host, asked } = openToday(context);
  await settle();
  assert.deepEqual([...asked].sort(), [DAY, IDEAS].sort(), "the glance asks with the paths the fan-in carries");
  assert.deepEqual(urls, [`/api${AGGREGATE}`], "no request beside the fan-in");
  assert.ok(host.innerHTML.includes("40 / 160 g"), "the day painted from the primed body");
  assert.ok(host.innerHTML.includes("Greek yogurt bowl"), "the idea painted from the primed body");
});

test("a fan-in that came back without one path leaves only that read to its own request", async () => {
  const { context, urls } = load({ [DAY]: day });
  openToday(context);
  await settle();
  assert.deepEqual(urls, [`/api${AGGREGATE}`, `/api${IDEAS}`]);
});
