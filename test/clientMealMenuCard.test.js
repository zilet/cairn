// "This week's menu" on Today → Fuel (meal-menu-card-client.ts + -controller.ts, the
// lazy meals bundle). The card shows TODAY's planned meals from the current week — a
// kept week first, else the newest draft, labelled as ideas to look over — never lists
// a week whose saved food constraints changed under it, and opens the week menu. With
// no week it offers the one ask, wired to the existing meal_plan draft job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule } from "./_dom.mjs";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEDNESDAY = { getDay: () => 3 };

// An adequate week (the planner's own rule): 7 days, each day's meals on target.
function week({ id = 1, status = "accepted", dayNames = DAYS, extra = {}, parsedExtra = {} } = {}) {
  return {
    id,
    status,
    week_of: "2026-09-28",
    parsed: {
      daily_kcal: 2000,
      daily_protein_g: 150,
      days: dayNames.map((day) => ({
        day,
        meals: [
          { name: "Greek <yogurt> bowl", items: ["yogurt", "berries"], kcal: 500, protein_g: 40 },
          { name: "Salmon rice plate", items: ["salmon", "rice"], kcal: 700, protein_g: 50 },
          { name: "Chicken stew", items: "chicken, beans", kcal: 800, protein_g: 60 },
        ],
      })),
      ...parsedExtra,
    },
    ...extra,
  };
}

function load({ peek = null, fetched = [], current = () => true } = {}) {
  const calls = { drafts: 0, open: [], fetches: 0 };
  let answer = fetched;
  const win = loadClientModule(
    [
      "html-utils",
      "ui-components",
      "ui-actions-client",
      "decision-undo-client",
      "meal-row-client",
      "meal-plan-upcoming-client",
      "meal-plan-client",
      "meal-menu-card-client",
      "meal-menu-card-controller",
    ],
    {
      globals: {
        art: (_kind, text) => `<svg data-art="${String(text).replace(/[<>"&]/g, "")}"></svg>`,
        artImg: (_kind, _text, className, svg) => `<span class="artile ${className}">${svg}</span>`,
        stagger: (i) => `--i:${i}`,
        skelLines: () => `<div class="skel"></div>`,
        statusBadge: (s) => `<span>${s}</span>`,
        verifiedBadgeHtml: () => "",
        MEALS_KEY: "meals:plans",
        peekCached: (key) => (key === "meals:plans" && peek ? { data: peek, fresh: false } : null),
        cachedApi: async (path, { key, onUpgrade } = {}) => {
          calls.fetches += 1;
          assert.equal(path, "/mealplans?limit=12");
          assert.equal(key, "meals:plans", "one cache with the week menu and the history fold");
          const data = answer;
          onUpgrade?.(data, { changed: JSON.stringify(data) !== JSON.stringify(peek) });
          return data;
        },
        CairnMealPlannerJobs: { draftWeeklyMeals: () => (calls.drafts += 1) },
      },
    }
  );
  const host = createHost(win.document);
  const mount = () =>
    win.CairnMealMenuCardController.mount(host, {
      isCurrent: current,
      openMenu: (focus) => calls.open.push(focus),
    });
  return {
    win,
    host,
    calls,
    mount,
    setAnswer: (next) => {
      answer = next;
    },
  };
}

test("a kept week lists today's meals: slot, name, what is in it, plain kcal, and food art", () => {
  const { win } = load();
  const card = win.CairnMealMenuCard;
  const model = card.model([week()], WEDNESDAY);
  assert.equal(model.kind, "week");
  assert.equal(model.status, "kept");
  assert.equal(model.dayName, "Wednesday");
  const html = card.cardHtml(model);
  assert.match(html, /This week's menu/);
  assert.match(html, /<span class="mmenu-today">Today<\/span> · Wednesday/);
  for (const slot of ["Breakfast", "Lunch", "Dinner"]) assert.match(html, new RegExp(`mmenu-slot">${slot}<`));
  assert.match(html, /Greek &lt;yogurt&gt; bowl/);
  assert.doesNotMatch(html, /Greek <yogurt>/);
  assert.match(html, /yogurt, berries/);
  assert.match(html, /chicken, beans/);
  assert.match(html, />700<span class="mmenu-unit"> kcal<\/span>/);
  assert.match(html, /class="artile artile-sm mmenu-art"/);
  assert.match(html, /data-mmenu-open="week">See the week/);
  assert.doesNotMatch(html, /mp-badge/, "a kept week carries no state word");
  // The draft status host rides along so a running draft reattaches here.
  assert.match(html, /id="mealDraftStatus"/);
  assert.doesNotMatch(html, /id="mealDraftBtn"/);
});

test("a meal named only for its slot says it once: what is in it becomes the name", () => {
  const { win } = load();
  const card = win.CairnMealMenuCard;
  const plan = week();
  for (const day of plan.parsed.days) day.meals[0] = { name: "Breakfast", items: ["tofu scramble", "spinach"], kcal: 500, protein_g: 40 };
  const html = card.cardHtml(card.model([plan], WEDNESDAY));
  assert.match(html, /mmenu-slot">Breakfast<\/span>\s*<span class="mmenu-name">tofu scramble, spinach<\/span>/);
  assert.doesNotMatch(html, /mmenu-name">Breakfast</);
});

test("a draft is the menu only when nothing is kept, and it says it is ideas to look over", () => {
  const { win } = load();
  const card = win.CairnMealMenuCard;
  const kept = week({ id: 1 });
  const draft = week({ id: 2, status: "draft" });
  assert.equal(card.model([draft, kept], WEDNESDAY).status, "kept", "a kept week wins over a newer draft");
  const model = card.model([draft], WEDNESDAY);
  assert.equal(model.status, "review");
  const html = card.cardHtml(model);
  assert.match(html, /mp-badge draft">to look over/);
  assert.match(html, /Ideas to look over\. Nothing changes unless you keep them\./);

  const scheduled = card.model([week({ id: 3, status: "draft", extra: { autonomy: { status: "announced" } } })], WEDNESDAY);
  assert.equal(scheduled.status, "coming");
  assert.match(card.cardHtml(scheduled), /mp-badge ok">coming/);
});

test("a week whose saved constraints changed lists none of its meals", () => {
  const { win } = load();
  const card = win.CairnMealMenuCard;
  const plan = week({ parsedExtra: { constraint_state: { status: "refresh_needed" } } });
  const html = card.cardHtml(card.model([plan], WEDNESDAY));
  assert.match(html, /needs a fresh draft/);
  assert.doesNotMatch(html, /Salmon rice plate|mmenu-list/);
  assert.match(html, /See the week/, "the week menu is where the fresh draft is asked for");
});

test("a week with no day for today says so calmly and points at the week", () => {
  const { win } = load();
  const card = win.CairnMealMenuCard;
  const html = card.cardHtml(card.model([week({ dayNames: DAYS.slice(0, 5) })], { getDay: () => 0 }));
  assert.match(html, /Nothing on the menu for today/);
  assert.doesNotMatch(html, /mmenu-list/);
});

test("no week: one ask for a week of meals, on the existing draft job's button and status ids", () => {
  const { win } = load();
  const card = win.CairnMealMenuCard;
  assert.deepEqual(JSON.parse(JSON.stringify(card.model([]))), { kind: "empty" });
  // An inadequate legacy draft is never shown as a current week.
  assert.equal(card.model([{ id: 9, status: "draft", parsed: { daily_kcal: 2000, daily_protein_g: 150, days: [] } }]).kind, "empty");
  const html = card.cardHtml(card.model([]));
  assert.match(html, /No menu this week yet/);
  assert.match(html, /<button id="mealDraftBtn" class="pillbtn pill-accent mmenu-draft" type="button" data-mmenu-draft>Ask the team for a week of meals<\/button>/);
  assert.match(html, /id="mealDraftStatus"/);
});

test("the controller paints a warm peek at once, upgrades on change, and wires open and draft", async () => {
  const { host, calls, mount } = load({ peek: [week()], fetched: [week({ id: 2, status: "draft" })] });
  const handle = mount();
  assert.ok(host.querySelector(".mmenu"), "the warm peek paints synchronously");
  await flush();
  assert.equal(calls.fetches, 1);
  assert.match(host.innerHTML, /to look over/, "the changed revalidate repaints");

  host.querySelector('[data-mmenu-open="week"]').click();
  host.querySelector(".mmenu-row").click();
  assert.deepEqual(calls.open, ["week", "today"]);

  // A second mount on the same slot replaces the first: one tap, one open.
  mount();
  await flush();
  calls.open.length = 0;
  host.querySelector('[data-mmenu-open="week"]').click();
  assert.deepEqual(calls.open, ["week"]);
  handle();
});

test("ready settles only once the card has really painted, so a draft reattaches to its status host", async () => {
  const { host, mount } = load({ fetched: [] });
  const handle = mount();
  assert.ok(host.querySelector(".mmenu-skel"), "a cold mount is still the skeleton");
  await handle.ready;
  assert.ok(host.querySelector("#mealDraftStatus"), "the painted card carries the draft status host");
  assert.equal(host.querySelector(".mmenu-skel"), null);
});

test("the empty card's ask runs the existing weekly draft", async () => {
  const { host, calls, mount } = load({ fetched: [] });
  mount();
  assert.ok(host.querySelector(".mmenu-skel"), "a cold mount holds the card's place");
  await flush();
  host.querySelector("[data-mmenu-draft]").click();
  assert.equal(calls.drafts, 1);
});

test("refresh repaints in place; a card whose Fuel paint is stale writes nothing", async () => {
  let live = true;
  const { host, mount, setAnswer } = load({ fetched: [], current: () => live });
  const handle = mount();
  await flush();
  assert.match(host.innerHTML, /No menu this week yet/);
  setAnswer([week()]);
  await handle.refresh();
  assert.match(host.innerHTML, /Salmon rice plate/);
  live = false;
  setAnswer([]);
  await handle.refresh();
  assert.match(host.innerHTML, /Salmon rice plate/, "a stale card is left alone");
});

test("the menu renders collapsed behind an accessible summary, and remembers an open choice", async () => {
  const { win, host, mount } = load({ peek: [week()], fetched: [week()] });
  const card = win.CairnMealMenuCard;
  const html = card.cardHtml(card.model([week()], WEDNESDAY));
  assert.match(html, /<details class="mmenu-details" data-mmenu-details>/, "closed by default");
  assert.match(html, /<summary class="mmenu-summary">[\s\S]*This week's menu[\s\S]*Today · 3 meals · ~2,000 kcal/);
  mount();
  await flush();
  const details = host.querySelector("[data-mmenu-details]");
  assert.equal(details.open, false);
  assert.ok(details.querySelector("summary"), "a native summary is the toggle");
  assert.ok(host.querySelector("#mealDraftStatus"), "the draft status host stays outside the fold");
  details.open = true;
  details.dispatchEvent(new win.Event("toggle"));
  assert.equal(win.localStorage.getItem("cairn.fuel.menuOpen"), "1");
  assert.match(card.cardHtml(card.model([week()], WEDNESDAY)), /data-mmenu-details open>/);
});
