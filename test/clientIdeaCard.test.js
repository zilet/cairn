// Idea cards (idea-card-client/-controller.ts, docs/V2-PLAN.md wave 2). Three ideas
// from the athlete's own staples (GET /api/fuel/ideas), protein first, each with the
// server's own reason. An idea is never shown as eaten or as a plan: "Start from this"
// hands its prefill to the host (which fills the composer — nothing is logged), and
// "Another idea" swaps one card in place for a staple not yet shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const DATE = "2026-04-25";

function load() {
  return loadClientModule(["html-utils", "ui-actions-client", "idea-card-client", "idea-card-controller"]);
}

function idea(key, overrides = {}) {
  return {
    key: `${key}@1`,
    title: key,
    portion: 1,
    portion_words: "your usual portion",
    kcal: 420,
    protein_g: 38,
    carbs_g: 30,
    fat_g: 12,
    fiber_g: 2,
    fits_band: true,
    why: `About 38 g protein toward the 90 g still to go, and it fits the 900 kcal your weight held at.`,
    prefill: key,
    times_logged: 6,
    last_logged: "2026-04-20",
    source: "staple",
    ...overrides,
  };
}

function ideas(list = [idea("Greek yogurt"), idea("Chicken wrap"), idea("Salmon rice")]) {
  return {
    kind: "ideas",
    date: DATE,
    protein_anchor: { protein_g: 170, source: "formula", words: "" },
    today_so_far: { kcal: 900, protein_g: 80, fiber_g: 10, state: "in progress" },
    room: { protein_g: 90, energy_kcal: 900, energy_bound: "observed_ceiling" },
    band_status: "ok",
    ideas: list,
    words: "Ideas from your own staples, not a plan. Nothing is logged until you log it.",
  };
}

// ---------- renderer ----------

test("an idea reads as an idea: protein first, the server's reason, two plain actions", () => {
  const win = load();
  const host = renderHtml(win.CairnIdeaCard.ideasHtml(ideas(), { reveal: true }), { document: win.document });
  const cards = host.querySelectorAll(".idea-card");
  assert.equal(cards.length, 3);
  const first = cards[0];
  assert.equal(first.querySelector(".idea-card-kind").textContent, "Idea");
  assert.equal(first.querySelector(".idea-card-title").textContent, "Greek yogurt");
  assert.equal(first.querySelector(".idea-card-nums").textContent, "38 g protein · 30 g carbs · 12 g fat · ~420 kcal");
  assert.match(first.querySelector(".idea-card-why").textContent, /toward the 90 g still to go/);
  const buttons = first.querySelectorAll("button").map((b) => [b.getAttribute("type"), b.textContent]);
  assert.deepEqual(buttons, [
    ["button", "Start from this"],
    ["button", "Another idea"],
  ]);
  assert.match(host.querySelector(".idea-cards-words").textContent, /not a plan/);
  // Never eaten, never a plan: no done state, no check, no log button.
  for (const card of cards) assert.doesNotMatch(card.textContent, /\beaten\b|✓|\blog it\b|Use this plan|planned/i);
  assert.equal(host.querySelector("[data-mlog], [data-fooditem]"), null);
  assert.equal(cards[1].style.getPropertyValue("--i"), "2", "the first paint staggers in");
});

test("an idea's numbers are its own macros: no zero protein on a melon, fiber when it is a real source", () => {
  const win = load();
  const nums = win.CairnIdeaCard.numsText;
  assert.equal(
    nums(idea("Cantaloupe", { kcal: 9, protein_g: 0, carbs_g: 2, fat_g: 0, fiber_g: 0 })),
    "2 g carbs · ~9 kcal"
  );
  assert.equal(
    nums(idea("Apple crumble", { kcal: 174, protein_g: 3, carbs_g: 28, fat_g: 6, fiber_g: 4 })),
    "3 g protein · 28 g carbs · 6 g fat · 4 g fiber · ~174 kcal"
  );
  assert.equal(nums(idea("Unknown", { kcal: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null })), "");
});

test("no staples yet: the server's line, and no empty cards", () => {
  const win = load();
  const data = { ...ideas([]), words: "No staples to build ideas from yet. They appear once a few meals repeat." };
  const host = renderHtml(win.CairnIdeaCard.ideasHtml(data), { document: win.document });
  assert.equal(host.querySelector(".idea-card"), null);
  assert.match(host.querySelector(".idea-cards-words").textContent, /No staples to build ideas from yet/);
});

test("hostile text comes back as text", () => {
  const win = load();
  const host = renderHtml(
    win.CairnIdeaCard.ideasHtml(ideas([idea("<b>x</b>", { why: "<img src=x>", portion_words: "<i>p</i>" })])),
    { document: win.document }
  );
  assert.equal(host.querySelector("b"), null);
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.querySelector("i"), null);
  assert.equal(host.querySelector(".idea-card-title").textContent, "<b>x</b>");
});

// ---------- controller ----------

function harness({ peek = null, read = () => ideas(), another = () => ideas() } = {}) {
  const win = load();
  const store = new Map();
  if (peek) store.set(`fuel:ideas:${DATE}`, { data: peek, fresh: true });
  const reads = [];
  const calls = [];
  const started = [];
  const deps = {
    date: DATE,
    hour: () => 13,
    peekCached: (key) => store.get(key) ?? null,
    cachedApi: async (path, options) => {
      reads.push(path);
      const data = await read();
      store.set(options.key, { data, fresh: true });
      return data;
    },
    swrInvalidate: (key) => store.delete(key),
    reducedMotion: () => false,
    api: async (path) => {
      calls.push(path);
      return another(path);
    },
    onStart: (prefill, row) => started.push([prefill, row.key]),
  };
  const host = createHost(win.document);
  const handle = win.CairnIdeaCardController.mount(host, deps);
  return { win, host, handle, reads, calls, started };
}

test("it reads the day's ideas with the device hour, never waiting on an agent", async () => {
  const h = harness();
  await flush();
  assert.deepEqual(h.reads, [`/fuel/ideas?date=${DATE}&hour=13`]);
  assert.equal(h.host.querySelectorAll(".idea-card").length, 3);
});

test("Start from this hands the prefill to the host and sends nothing", async () => {
  const h = harness({ peek: ideas() });
  await h.host.querySelectorAll("[data-idea-card-start]")[1].click();
  assert.deepEqual(h.started, [["Chicken wrap", "Chicken wrap@1"]]);
  assert.deepEqual(h.calls, [], "no request of any kind");
});

test("Another idea swaps that one card for a staple not yet shown", async () => {
  const h = harness({
    peek: ideas(),
    another: () => ideas([idea("Chicken wrap"), idea("Salmon rice"), idea("Cottage cheese")]),
  });
  await flush();
  const before = h.host.querySelectorAll(".idea-card");
  await before[0].querySelector("[data-idea-card-another]").click();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0], /exclude=Greek%20yogurt%401%2CChicken%20wrap%401%2CSalmon%20rice%401/);
  const after = h.host.querySelectorAll(".idea-card");
  assert.deepEqual(
    after.map((c) => c.querySelector(".idea-card-title").textContent),
    ["Cottage cheese", "Chicken wrap", "Salmon rice"]
  );
  assert.equal(after[1], before[1], "the other cards keep their nodes");
  assert.ok(after[0].classList.contains("settle-in"));
  assert.equal(h.win.document.activeElement, after[0].querySelector("[data-idea-card-another]"));
  await after[0].querySelector("[data-idea-card-start]").click();
  assert.deepEqual(h.started, [["Cottage cheese", "Cottage cheese@1"]]);
});

test("when no other staple is left, the card stays and says so in one line", async () => {
  const h = harness({ peek: ideas(), another: () => ideas() });
  const card = h.host.querySelector(".idea-card");
  const btn = card.querySelector("[data-idea-card-another]");
  await btn.click();
  await flush();
  assert.equal(h.host.querySelector(".idea-card"), card);
  assert.equal(card.querySelector(".idea-card-status").textContent, "No other staple to offer here yet.");
  assert.equal(btn.disabled, true);
});

test("a cold start shimmers, a failed read says so, and Try again reads once more", async () => {
  let fail = true;
  const h = harness({
    read: () => {
      if (fail) throw new Error("offline");
      return ideas();
    },
  });
  await flush();
  assert.match(h.host.textContent, /couldn't be read just now/);
  fail = false;
  await h.host.querySelector("[data-idea-cards-retry]").click();
  await flush();
  assert.equal(h.host.querySelectorAll(".idea-card").length, 3);
});

test("refresh re-reads after a log", async () => {
  let list = ideas();
  const h = harness({ read: () => list });
  await flush();
  list = ideas([idea("Salmon rice")]);
  await h.handle.refresh();
  await flush();
  assert.equal(h.reads.length, 2);
  assert.deepEqual(
    h.host.querySelectorAll(".idea-card-title").map((t) => t.textContent),
    ["Salmon rice"]
  );
});

test("a pairing and the room words are said once, escaped, and only when present", () => {
  const win = load();
  const data = ideas([
    idea("Chicken", { with: { title: "Rice", kcal: 200, carbs_g: 44, words: "With rice <b>, about 200 kcal more." } }),
    idea("Yogurt"),
  ]);
  data.room_words = "Today's number is bigger for the long run; after one of these about 1,010 kcal is still open.";
  const host = renderHtml(win.CairnIdeaCard.ideasHtml(data), { document: win.document });
  const withs = host.querySelectorAll(".idea-card-with");
  assert.equal(withs.length, 1);
  assert.equal(withs[0].textContent, "With rice <b>, about 200 kcal more.");
  assert.equal(host.querySelectorAll(".idea-card-with b").length, 0, "escaped, never markup");
  assert.match(host.querySelector(".idea-cards-room").textContent, /about 1,010 kcal is still open/);
  const plain = renderHtml(win.CairnIdeaCard.ideasHtml(ideas()), { document: win.document });
  assert.equal(plain.querySelector(".idea-card-with"), null);
  assert.equal(plain.querySelector(".idea-cards-room"), null);
});
