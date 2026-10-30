// The You home (v2 wave 5 stream B): the cairn-stack (cairn-stack-model/-client/
// -controller), the stone detail (stone-detail-model/-client/-controller) and the You
// landing that composes them (you-screen). Six stones off GET /api/today/stones, each
// word printed verbatim, a tone mapped to a class, a stone opening its own detail and
// the detail linking to the stone's homes — the decade view from Heart only — with one
// settle entrance that reduced motion skips, and nothing that reads as a score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeEvent, createHost, fire, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATE = "2026-09-26";

const STACK = ["html-utils", "ui-actions-client", "ui-stone-model", "ui-stone", "cairn-stack-model", "cairn-stack-client", "cairn-stack-controller"];
const DETAIL = [...STACK, "stone-detail-model", "stone-detail-client", "stone-detail-controller"];

function stone(key, label, word, tone, line = null) {
  // The server's target is the pebble strip's; the You home never follows it.
  return { key, label, word, tone, line, target: { tab: "progress", section: "overview" } };
}

function read(overrides = {}) {
  const stones = [
    stone("strength", "Strength", "planned", "ok", "Upper day is on the plan."),
    stone("endurance", "Endurance", "building", "ok"),
    stone("fuel", "Fuel", "in progress", "quiet"),
    stone("recovery", "Recovery", "quiet", "quiet"),
    stone("body", "Body", "on course", "ok"),
    stone("heart", "Heart", "worth noting", "watch", "One lab finding is worth a look."),
  ];
  return { date: DATE, stones, ...overrides };
}

const hrefFor = (target) =>
  `/app/${target.tab}${target.section ? `/${target.section}` : ""}${target.id ? `?id=${target.id}` : ""}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recorder({ warm = null, respond = () => Promise.resolve(read()), reduced = false } = {}) {
  const loads = [];
  const opened = [];
  const navigations = [];
  const backs = [];
  return {
    loads,
    opened,
    navigations,
    backs,
    deps: {
      date: DATE,
      peek: () => (warm ? { data: warm, fresh: false } : null),
      load: (p, options) => {
        loads.push({ path: p, key: options?.key });
        return respond(p);
      },
      reducedMotion: () => reduced,
      hrefFor,
      openStone: (key) => opened.push(key),
      navigate: (target) => navigations.push(JSON.parse(JSON.stringify(target))),
      back: () => backs.push("you"),
    },
  };
}

// Arrays built inside the client sandbox belong to another realm; compare them as data.
const plain = (value) => JSON.parse(JSON.stringify(value));

const click = (init = {}) => new FakeEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });

// ---------- cairn-stack model + view ----------

test("six stones in the server's order, words verbatim, each opening its own detail", () => {
  const win = loadClientModule(STACK);
  const model = win.CairnStackModel.model(read(), { hrefFor });
  assert.deepEqual(
    plain(model.stones.map((s) => [s.key, s.word, s.href])),
    [
      ["strength", "planned", "/app/you/stone?id=strength"],
      ["endurance", "building", "/app/you/stone?id=endurance"],
      ["fuel", "in progress", "/app/you/stone?id=fuel"],
      ["recovery", "quiet", "/app/you/stone?id=recovery"],
      ["body", "on course", "/app/you/stone?id=body"],
      ["heart", "worth noting", "/app/you/stone?id=heart"],
    ]
  );
  assert.equal(win.CairnStackModel.keyFor(DATE), `today:stones:${DATE}`, "the pebble strip's own SWR key");
  assert.equal(win.CairnStackModel.pathFor(DATE), `/today/stones?date=${DATE}`);
});

test("the model never works a word out, clamps unknown tones to quiet, and drops non-reads", () => {
  const win = loadClientModule(STACK);
  const odd = read();
  odd.stones[0].word = "a server word the client has never seen";
  odd.stones[1].tone = "red";
  odd.stones[3].word = "";
  odd.stones[4].word = null;
  odd.stones.push(stone("heart", "Heart", "again", "ok"));
  const model = win.CairnStackModel.model(odd);
  assert.deepEqual(
    plain(model.stones.map((s) => [s.key, s.word, s.tone])),
    [
      ["strength", "a server word the client has never seen", "ok"],
      ["endurance", "building", "quiet"],
      ["fuel", "in progress", "quiet"],
      ["heart", "worth noting", "watch"],
    ],
    "a wordless stone is left off, a repeated key counts once"
  );
  assert.equal(model.stones[0].href, null, "no link without a route builder");
  assert.equal(win.CairnStackModel.model(null), null);
  assert.equal(win.CairnStackModel.model({ date: DATE }), null);
});

test("the stack: a six-stone pile the base widest, and one row per stone with its word and line", () => {
  const win = loadClientModule(STACK);
  const html = win.CairnStack.html(win.CairnStackModel.model(read(), { hrefFor }), { enter: true });
  const host = renderHtml(html, { document: win.document });
  const pile = host.querySelector(".cairn-stack-pile");
  assert.equal(pile.getAttribute("aria-hidden"), "true", "the pile is the picture; the rows are the controls");
  const rocks = pile.querySelectorAll(".cairn-stack-rock");
  assert.equal(rocks.length, 6);
  assert.deepEqual(
    rocks.map((r) => r.getAttribute("style")),
    ["--i:5", "--i:4", "--i:3", "--i:2", "--i:1", "--i:0"],
    "painted base-first so each upper stone sits in front; --i keeps the top-first position, so Heart is the base"
  );
  assert.deepEqual(
    rocks.map((r) => ["ok", "watch", "quiet"].find((t) => r.classList.contains(`cairn-stack-${t}`))),
    ["watch", "ok", "quiet", "quiet", "ok", "ok"]
  );
  assert.equal(host.querySelector(".cairn-stack").classList.contains("is-entering"), true);
  const rows = host.querySelectorAll("a.cairn-stack-row");
  assert.deepEqual(
    rows.map((a) => a.getAttribute("href")),
    read().stones.map((s) => `/app/you/stone?id=${s.key}`)
  );
  assert.deepEqual(
    host.querySelectorAll(".cairn-stack-word").map((el) => el.textContent),
    ["planned", "building", "in progress", "quiet", "on course", "worth noting"]
  );
  assert.equal(rows[0].getAttribute("aria-label"), "Strength: planned. Upper day is on the plan.");
  assert.equal(rows[3].getAttribute("aria-label"), "Recovery: quiet");
  assert.equal(host.querySelectorAll(".cairn-stack-line").length, 2, "a line only where the server wrote one");
  assert.deepEqual(
    pile.querySelectorAll(".stack-pile-word").map((el) => el.textContent),
    ["planned", "building", "in progress", "quiet", "on course", "worth noting"],
    "the pile names each stone beside it, in the server's words"
  );
  assert.equal(pile.querySelectorAll(".stack-pile-leader").length, 6);
  assert.equal(pile.querySelectorAll(".stack-pile-flag").length, 1, "only the watch stone carries the dawn mark");
});

test("the stack never reads as a score, and hostile server text stays text", () => {
  const win = loadClientModule(STACK);
  const html = win.CairnStack.html(win.CairnStackModel.model(read(), { hrefFor }));
  const host = renderHtml(html, { document: win.document });
  assert.doesNotMatch(host.textContent, /\d/, "no number anywhere in the stack");
  assert.doesNotMatch(html, /\bscore\b|\/100|%|grade|badge/i);
  assert.doesNotMatch(html, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i, "tone travels as a class, never a colour");

  const hostile = read();
  hostile.stones[0].word = "<b>bold</b>";
  hostile.stones[0].label = '<img src=x onerror="1">';
  hostile.stones[0].line = '"><script>1</script>';
  hostile.stones[1].key = '"><i>k</i>';
  const bad = renderHtml(win.CairnStack.html(win.CairnStackModel.model(hostile, { hrefFor })), {
    document: win.document,
  });
  assert.equal(bad.querySelector("b"), null);
  assert.equal(bad.querySelector("img"), null);
  assert.equal(bad.querySelector("script"), null);
  assert.equal(bad.querySelector("i"), null);
  assert.equal(bad.querySelector(".cairn-stack-word").textContent, "<b>bold</b>");
});

test("no stones, no stack; the skeleton is the stack's shape and says nothing", () => {
  const win = loadClientModule(STACK);
  assert.equal(win.CairnStack.html(win.CairnStackModel.model({ date: DATE, stones: [] })), "");
  assert.equal(win.CairnStack.html(null), "");
  const skel = renderHtml(win.CairnStack.skeletonHtml(), { document: win.document });
  assert.equal(skel.querySelectorAll(".cairn-stack-rock").length, 6);
  assert.equal(skel.querySelectorAll(".cairn-stack-item").length, 6);
  assert.equal(skel.querySelector(".cairn-stack").getAttribute("aria-busy"), "true");
  assert.equal(skel.textContent.trim(), "");
});

// ---------- cairn-stack controller ----------

test("a warm cache paints at once under the pebble strip's key, settling once per day", async () => {
  const win = loadClientModule(STACK);
  const host = createHost(win.document);
  const rec = recorder({ warm: read() });
  win.CairnStackController.mount(host, rec.deps);
  const stack = host.querySelector(".cairn-stack");
  assert.ok(stack, "painted synchronously from the cache");
  assert.equal(stack.classList.contains("is-entering"), true, "the first stack of the morning settles");
  assert.deepEqual(rec.loads, [{ path: `/today/stones?date=${DATE}`, key: `today:stones:${DATE}` }]);
  await flush();
  assert.equal(host.querySelector(".cairn-stack"), stack, "an unchanged revalidation never repaints");

  const again = createHost(win.document);
  win.CairnStackController.mount(again, recorder({ warm: read() }).deps);
  assert.equal(again.querySelector(".cairn-stack").classList.contains("is-entering"), false, "once, never again");
});

test("reduced motion builds the cairn already standing", async () => {
  const win = loadClientModule(STACK);
  const host = createHost(win.document);
  win.CairnStackController.mount(host, recorder({ reduced: true }).deps);
  await flush();
  assert.ok(host.querySelector(".cairn-stack"));
  assert.equal(host.querySelector(".cairn-stack").classList.contains("is-entering"), false);
});

test("a cold mount shows the skeleton, then the server's stack; a failed cold read collapses quietly", async () => {
  const win = loadClientModule(STACK);
  const host = createHost(win.document);
  const gate = deferred();
  win.CairnStackController.mount(host, recorder({ respond: () => gate.promise }).deps);
  assert.ok(host.querySelector(".cairn-stack-skel"));
  gate.resolve(read());
  await flush();
  assert.equal(host.querySelector(".cairn-stack-skel"), null);
  assert.equal(host.querySelectorAll(".cairn-stack-row").length, 6);

  const cold = createHost(win.document);
  win.CairnStackController.mount(cold, recorder({ respond: () => Promise.reject(new Error("offline")) }).deps);
  await flush();
  assert.equal(cold.innerHTML, "", "never an error line, never a retry to tap");

  const warm = createHost(win.document);
  win.CairnStackController.mount(
    warm,
    recorder({ warm: read(), respond: () => Promise.reject(new Error("offline")) }).deps
  );
  await flush();
  assert.equal(warm.querySelectorAll(".cairn-stack-row").length, 6, "a warm stack stands through a failure");
});

test("a row or a stone in the pile opens that stone's detail; a modified click stays native", async () => {
  const win = loadClientModule(STACK);
  const host = createHost(win.document);
  const rec = recorder({ warm: read() });
  win.CairnStackController.mount(host, rec.deps);
  const event = click();
  await fire(host.querySelector('a[data-cairn-stack-go="heart"] .cairn-stack-word'), event);
  assert.equal(event.defaultPrevented, true);
  await fire(host.querySelector('.cairn-stack-rock[data-cairn-stack-go="fuel"]'), click());
  const modified = click({ metaKey: true });
  await fire(host.querySelector('a[data-cairn-stack-go="body"]'), modified);
  assert.equal(modified.defaultPrevented, false);
  assert.deepEqual(rec.opened, ["heart", "fuel"]);
});

// ---------- stone detail ----------

test("each stone links to its homes; the decade view is Heart's and nobody else's", () => {
  const win = loadClientModule(DETAIL);
  const homes = win.CairnStoneDetailModel.STONE_HOMES;
  const flat = (key) =>
    plain(homes[key]).map((h) => `${h.target.tab}/${h.target.section ?? ""}${h.target.id ? `?id=${h.target.id}` : ""}`);
  assert.deepEqual(plain(Object.keys(homes)), ["strength", "endurance", "fuel", "recovery", "body", "heart"]);
  assert.deepEqual(flat("strength"), ["progress/overview", "plan/edit"]);
  assert.deepEqual(flat("endurance"), ["plan/endurance", "progress/endurance"]);
  // Today's food has one home, Train › Intake (today first, then the weeks).
  assert.deepEqual(flat("fuel"), ["progress/intake", "progress/energy"]);
  assert.deepEqual(flat("recovery"), ["stand/recovery"]);
  assert.deepEqual(flat("body"), ["stand/body", "progress/weight", "progress/measurements"]);
  assert.deepEqual(flat("heart"), ["stand/", "stand/domain?id=heart", "stand/age"]);
  const withAge = Object.keys(homes).filter((key) => flat(key).includes("stand/age"));
  assert.deepEqual(withAge, ["heart"]);
});

test("every stone home is a section the router knows", async () => {
  const { CLIENT_ROUTE_DEFINITIONS } = await import("../dist/contracts/client-routes.js");
  const win = loadClientModule(DETAIL);
  for (const [key, list] of Object.entries(win.CairnStoneDetailModel.STONE_HOMES)) {
    for (const h of list) {
      assert.ok(CLIENT_ROUTE_DEFINITIONS.tabs.includes(h.target.tab), `${key}: ${h.target.tab} is a view`);
      if (h.target.section)
        assert.ok(
          CLIENT_ROUTE_DEFINITIONS.sections[h.target.tab].includes(h.target.section),
          `${key}: ${h.target.tab}/${h.target.section} is a section`
        );
    }
  }
});

test("the detail model: the server's stone verbatim, the name before the read, null for a non-stone", () => {
  const win = loadClientModule(DETAIL);
  const m = win.CairnStoneDetailModel.model("heart", read(), { hrefFor });
  assert.equal(m.name, "Heart");
  assert.equal(m.stone.word, "worth noting");
  assert.equal(m.stone.tone, "watch");
  assert.deepEqual(
    plain(m.links.map((l) => l.href)),
    ["/app/stand", "/app/stand/domain?id=heart", "/app/stand/age"]
  );
  const renamed = read();
  renamed.stones[5].label = "Heart and circulation";
  assert.equal(win.CairnStoneDetailModel.model("heart", renamed).name, "Heart and circulation", "the server's name wins");
  const bare = win.CairnStoneDetailModel.model("fuel", null);
  assert.equal(bare.stone, null);
  assert.equal(bare.name, "Fuel");
  assert.equal(bare.links.length, 2, "the homes need no read");
  assert.equal(win.CairnStoneDetailModel.model("toString", read()), null);
  assert.equal(win.CairnStoneDetailModel.model("spleen", read()), null);
  assert.equal(win.CairnStoneDetailModel.isStone("heart"), true);
  assert.equal(win.CairnStoneDetailModel.isStone("__proto__"), false);
});

test("the detail paints its name and homes before the read, then the word and line in its tone", async () => {
  const win = loadClientModule(DETAIL);
  const host = createHost(win.document);
  const gate = deferred();
  const rec = recorder({ respond: () => gate.promise });
  win.CairnStoneDetailController.mount(host, { ...rec.deps, stone: "heart" });
  assert.equal(host.querySelector(".stone-detail-h").textContent, "Heart");
  assert.equal(host.querySelectorAll(".stone-detail-link").length, 3);
  assert.ok(host.querySelector(".stone-detail-ghost"), "a ghost where the word will land");
  gate.resolve(read());
  await flush();
  assert.equal(host.querySelector(".stone-detail-ghost"), null);
  assert.equal(host.querySelector(".stone-detail-word").textContent, "worth noting");
  assert.equal(host.querySelector(".stone-detail-line").textContent, "One lab finding is worth a look.");
  const article = host.querySelector(".stone-detail");
  assert.equal(article.classList.contains("cairn-stack-watch"), true);
  assert.equal(article.classList.contains("is-entering"), true, "the stone settles when it takes its tone");
  assert.doesNotMatch(host.textContent, /\d/);
  assert.equal(host.querySelector("[data-home-back]").textContent, "‹ You");
});

test("a failed read keeps the name and homes and says nothing; reduced motion skips the settle", async () => {
  const win = loadClientModule(DETAIL);
  const host = createHost(win.document);
  win.CairnStoneDetailController.mount(host, {
    ...recorder({ respond: () => Promise.reject(new Error("offline")) }).deps,
    stone: "body",
  });
  await flush();
  assert.equal(host.querySelector(".stone-detail-ghost"), null);
  assert.equal(host.querySelector(".stone-detail-word"), null);
  assert.equal(host.querySelector(".stone-detail-h").textContent, "Body");
  assert.equal(host.querySelectorAll(".stone-detail-link").length, 3);

  const still = createHost(win.document);
  win.CairnStoneDetailController.mount(still, { ...recorder({ reduced: true }).deps, stone: "recovery" });
  await flush();
  assert.equal(still.querySelector(".stone-detail").classList.contains("is-entering"), false);
});

test("a home tap navigates to its route; the step back returns to You; modified clicks stay native", async () => {
  const win = loadClientModule(DETAIL);
  const host = createHost(win.document);
  const rec = recorder({ warm: read() });
  win.CairnStoneDetailController.mount(host, { ...rec.deps, stone: "heart" });
  const event = click();
  await fire(host.querySelector('[data-stone-detail-go="domain"] .set-you-t'), event);
  assert.equal(event.defaultPrevented, true);
  await fire(host.querySelector('[data-stone-detail-go="age"]'), click({ ctrlKey: true }));
  await fire(host.querySelector("[data-home-back]"), click());
  assert.deepEqual(rec.navigations, [{ tab: "stand", section: "domain", id: "heart" }]);
  assert.deepEqual(rec.backs, ["you"]);
});

test("the detail switches between the six and names the stones it moves with, each in its own word", async () => {
  const win = loadClientModule(DETAIL);
  const host = createHost(win.document);
  const rec = recorder({ warm: read() });
  win.CairnStoneDetailController.mount(host, { ...rec.deps, stone: "heart" });
  const chips = host.querySelectorAll(".stone-detail-chip");
  assert.equal(chips.length, 6);
  assert.deepEqual(
    chips.filter((c) => c.getAttribute("aria-current") === "page").map((c) => c.getAttribute("data-stone-detail-open")),
    ["heart"]
  );
  assert.deepEqual(
    host.querySelectorAll(".stone-detail-peer").map((p) => p.getAttribute("data-stone-detail-open")),
    ["body", "endurance", "fuel"]
  );
  assert.deepEqual(
    host.querySelectorAll(".stone-detail-pword").map((w) => w.textContent),
    ["on course", "building", "in progress"],
    "a peer speaks the server's word, never one worked out here"
  );
  await fire(host.querySelector('.stone-detail-peer[data-stone-detail-open="fuel"]'), click());
  await fire(host.querySelector('.stone-detail-chip[data-stone-detail-open="heart"]'), click());
  assert.deepEqual(rec.navigations, [{ tab: "you", section: "stone", id: "fuel" }], "the open stone's own chip goes nowhere");
});

// ---------- the You landing ----------

function loadYou(stateOverrides = {}) {
  const tabs = [];
  const replaced = [];
  const state = { standSeg: "markers", standDomain: "lipids", meSeg: "profile", setSeg: "sources", ...stateOverrides };
  const win = loadClientModule([...DETAIL, "you-screen"], {
    globals: {
      state,
      headerTitle: { textContent: "" },
      activateTab: (name) => tabs.push(name),
      localISO: () => DATE,
      peekCached: () => ({ data: read(), fresh: true }),
      cachedApi: () => Promise.resolve(read()),
      reducedMotion: () => true,
      routeApi: () => ({ routeToUrl: hrefFor }),
      applyRouteState: (route) => {
        state.applied = JSON.parse(JSON.stringify(route));
        return route.tab;
      },
      syncRouteFromState: (mode) => replaced.push(mode),
    },
  });
  win.view = createHost(win.document);
  return { win, tabs, state, replaced };
}

test("the You landing leads with one voice line and the search, then the whole cairn, then Health, About you and Settings", async () => {
  const { win, tabs, state } = loadYou();
  win.renderYou();
  assert.equal(win.headerTitle.textContent, "You");
  const landing = win.view.querySelector(".you-landing");
  assert.equal(landing.children[0].className, "you-lede reveal", "one calm voice line leads");
  const search = landing.children[0].querySelector(".you-search");
  assert.equal(search.getAttribute("data-you-view"), "stand");
  assert.equal(search.getAttribute("data-you-section"), "markers", "the search opens the searchable markers");
  assert.equal(landing.children[1].className, "you-cairn", "the stack follows");
  assert.ok(landing.children[1].querySelector(".cairn-stack"));
  assert.equal(win.view.querySelectorAll(".cairn-stack-row").length, 6);
  assert.deepEqual(
    win.view.querySelectorAll(".you-group-h").map((h) => h.textContent),
    ["Health", "About you", "Settings"]
  );
  assert.match(win.view.textContent, /Health: where you stand/);
  assert.match(win.view.textContent, /Add labs or scan/);
  assert.match(win.view.textContent, /Doctor packet/, "the packet is one tap from You");
  assert.doesNotMatch(win.view.textContent, /\bStand\b/, "Stand reads as Health in athlete-facing copy");

  await fire(win.view.querySelector('a[data-cairn-stack-go="heart"]'), click());
  assert.equal(state.youSeg, "stone");
  assert.equal(state.youStone, "heart");
  assert.deepEqual(tabs, ["you"]);
});

test("a stone route renders its detail; a home tap routes like a deep link and forgets the stone", async () => {
  const { win, tabs, state } = loadYou({ youSeg: "stone", youStone: "fuel" });
  win.renderYou();
  assert.equal(win.view.querySelector(".stone-detail-h").textContent, "Fuel");
  assert.equal(win.view.querySelector(".cairn-stack"), null);
  await fire(win.view.querySelector('[data-stone-detail-go="intake"]'), click());
  assert.deepEqual(state.applied, {
    tab: "progress",
    section: "intake",
    healthSection: null,
    date: null,
    id: null,
    session: null,
    jump: null,
  });
  assert.equal(state.youSeg, null);
  assert.equal(state.youStone, null);
  assert.deepEqual(tabs, ["progress"]);
});

test("an unknown stone is the landing, rewritten in place; the You tab always reopens the landing", () => {
  const { win, state, replaced } = loadYou({ youSeg: "stone", youStone: "spleen" });
  win.renderYou();
  assert.ok(win.view.querySelector(".you-landing"));
  assert.equal(state.youSeg, null);
  assert.deepEqual(replaced, ["replace"]);

  state.youSeg = "stone";
  state.youStone = "heart";
  const tab = win.document.createElement("button");
  tab.className = "tab";
  tab.setAttribute("data-tab", "you");
  win.document.body.appendChild(tab);
  tab.click();
  assert.equal(state.youSeg, null);
  assert.equal(state.youStone, null);

  // Leaving through any other tab forgets the stone too, so a later '‹ You' opens
  // the landing rather than a stale stone detail.
  state.youSeg = "stone";
  state.youStone = "heart";
  const today = win.document.createElement("button");
  today.className = "tab";
  today.setAttribute("data-tab", "today");
  win.document.body.appendChild(today);
  today.click();
  assert.equal(state.youSeg, null);
  assert.equal(state.youStone, null);
});

// ---------- the homes around You ----------

test("Health is Health: its title, its steps back, and no decade tile on its overview", () => {
  const stand = readFileSync(path.join(ROOT, "src/client/stand-screen.ts"), "utf8");
  assert.match(stand, /headerTitle\.textContent = "Health"/);
  assert.doesNotMatch(stand, /‹ Stand/);
  assert.match(stand, /homeBackHtml\("you", "You"\)/, "the overview steps back to You");
  assert.doesNotMatch(stand, /data-age\b/, "the decade view has no tile on the Health overview");
  assert.match(stand, /data-back-heart>‹ Heart/, "the decade view steps back to Heart");
});

test("About you and Settings step back to You", () => {
  // One shared rule (ui-shell) leads every About-you bar with the step back; Profile and
  // Memory (me-health-screen), Life and Family (me-records-screen) all route through it.
  const shell = readFileSync(path.join(ROOT, "src/client/ui-shell.ts"), "utf8");
  assert.match(shell, /function aboutYouSegBar[\s\S]*?homeBackHtml\("you", "You"\)/);
  const me = readFileSync(path.join(ROOT, "src/client/me-health-screen.ts"), "utf8");
  assert.match(me, /segBar: aboutYouSegBar/);
  assert.match(me, /wireSeg: aboutYouWireSeg/);
  const records = readFileSync(path.join(ROOT, "src/client/me-records-screen.ts"), "utf8");
  for (const fn of ["lifeControllerDeps", "familyControllerDeps"]) {
    const body = records.slice(records.indexOf(`function ${fn}`));
    const deps = body.slice(0, body.indexOf("\n}\n"));
    assert.match(deps, /segBar: aboutYouSegBar/, `${fn} steps back to You`);
    assert.match(deps, /wireSeg: aboutYouWireSeg/, `${fn} wires the step back`);
  }
  const settings = readFileSync(path.join(ROOT, "src/client/settings-screen.ts"), "utf8");
  assert.match(settings, /homeBackHtml\("you", "You"\)/);
  assert.doesNotMatch(settings, /renderYouSlice/, "the old You slice is the You landing now");
});
