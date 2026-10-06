// The Program look-ahead on the client (program-week-{model,client,controller}.ts): the
// read shaped into rows a day, the rows into calm markup, and the slot filled from the
// SWR cache first. Today's lift is the server's one strength line, printed verbatim;
// every row opens its day through the app's one `data-open-day` opener; every caller
// string is escaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(extra = {}) {
  const mounts = [];
  const context = {
    Array,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    CairnUiActions: {
      mount(host, name, wire) {
        const entry = { host, name, actions: {}, torn: false, cleanup: null };
        entry.cleanup = wire({
          host,
          signal: {},
          delegate: (_type, actions) => Object.assign(entry.actions, actions),
        });
        mounts.push(entry);
        return () => {
          entry.torn = true;
          if (typeof entry.cleanup === "function") entry.cleanup();
        };
      },
    },
    ...extra,
  };
  context.window = context;
  for (const file of [
    "html-utils",
    "format-utils",
    "ui-format",
    "ui-reads",
    "program-week-model",
    "program-week-client",
    "program-week-controller",
  ]) {
    vm.runInNewContext(readFileSync(join(root, `public/js/${file}.js`), "utf8"), context);
  }
  context.mounts = mounts;
  return context;
}

const strengthLine = {
  date: "2026-10-06",
  day_number: 2,
  title: "Pull",
  focus: null,
  role: "strength",
  state: "not_started",
  suggestion: "easy",
  suggestion_label: "lighter today",
  caveat: "Keep it <easy> after a short night.",
  run_in: null,
  reshaped: false,
  original: [],
  text: "Pull · lighter today",
};

function lookAhead(overrides = {}) {
  return {
    as_of: "2026-10-06",
    mode: "calendar",
    run_units: "km",
    strength_line: strengthLine,
    order: [],
    weeks: [
      {
        week_start: "2026-10-05",
        label: "This week",
        markers: [{ kind: "race_build", word: "Taper week", note: "Shorter <runs>" }],
        days: [
          {
            date: "2026-10-06",
            weekday: "Tue",
            today: true,
            lift: { title: "Pull", focus: null, lifts: ["Row", "Pulldown"], more: 0, done: false },
            run: null,
            rest: false,
            hard: false,
          },
          {
            date: "2026-10-07",
            weekday: "Wed",
            today: false,
            lift: { title: "Legs <A>", focus: "Lower", lifts: ["Back Squat", "RDL", "Leg Curl"], more: 2, done: false },
            run: { kind: "easy", label: "Easy run", km: 8.05, done: false },
            rest: false,
            hard: true,
          },
          { date: "2026-10-08", weekday: "Thu", today: false, lift: null, run: null, rest: true, hard: false },
        ],
      },
      {
        week_start: "2026-10-12",
        label: "Next week",
        markers: [{ kind: "recovery", word: "Recovery week", note: "Lands Tuesday" }],
        days: [
          {
            date: "2026-10-12",
            weekday: "Mon",
            today: false,
            lift: null,
            run: { kind: "long", label: "Long run", km: 16, done: false },
            rest: false,
            hard: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("the model shapes a row a day: today's line verbatim, key lifts, runs in the athlete's units", () => {
  const ctx = load();
  const view = ctx.CairnProgramWeekModel.programWeekModel(lookAhead({ run_units: "mi" }));
  assert.equal(view.mode, "calendar");
  assert.deepEqual(
    view.groups.map((g) => g.label),
    ["This week", "Next week"]
  );
  const [today, wed, thu] = view.groups[0].rows;
  assert.equal(today.today, true);
  assert.equal(today.line.text, "Pull · lighter today", "today's lift is the server's one line");
  assert.equal(today.weekday, "TUE");
  assert.equal(today.day, "6");
  assert.equal(wed.line, null, "only today speaks the strength line");
  assert.equal(wed.lift.title, "Legs <A>");
  assert.equal(wed.lift.lifts, "Back Squat · RDL · Leg Curl +2");
  assert.equal(wed.run.text, "Easy run · 5 mi", "km travel; miles print");
  assert.equal(wed.hard, true);
  assert.equal(thu.rest, true);
  assert.equal(view.groups[1].markers[0].word, "Recovery week");
});

test("a 'none' strength line keeps the plan day's name on today's row", () => {
  const ctx = load();
  const view = ctx.CairnProgramWeekModel.programWeekModel(
    lookAhead({ strength_line: { ...strengthLine, state: "none", text: "" } })
  );
  const today = view.groups[0].rows[0];
  assert.equal(today.line, null);
  assert.equal(today.lift.title, "Pull");
});

test("a reshaped today does not list the plan's movements against its own line", () => {
  const ctx = load();
  const view = ctx.CairnProgramWeekModel.programWeekModel(
    lookAhead({ strength_line: { ...strengthLine, reshaped: true, original: ["Row"] } })
  );
  assert.equal(view.groups[0].rows[0].lift.lifts, "");
});

test("the rows render as one calm list, escaped, each day one tap from its preview", () => {
  const ctx = load();
  const html = ctx.CairnProgramWeek.bodyHtml(ctx.CairnProgramWeekModel.programWeekModel(lookAhead()));
  assert.match(html, /<ol class="pahead-days" aria-label="This week, day by day">/);
  assert.match(html, /data-open-day="2026-10-06"[^>]*aria-current="date"/, "today is marked for assistive tech");
  assert.match(html, /class="pahead-day is-today"/);
  assert.match(html, /data-open-day="2026-10-07"/);
  assert.match(html, /data-open-day="2026-10-12"/);
  assert.match(html, /Pull · lighter today/, "the strength line, verbatim");
  assert.match(html, /Keep it &lt;easy&gt; after a short night\./, "its caveat, escaped");
  assert.match(html, /Legs &lt;A&gt;/);
  assert.match(html, /Shorter &lt;runs&gt;/);
  assert.match(html, /Back Squat · RDL · Leg Curl \+2/);
  assert.match(html, /Easy run · 8\.1 km/);
  assert.match(html, /<span class="pahead-rest">Rest<\/span>/);
  assert.match(html, /class="pahead-mark is-race_build">Taper week/);
  assert.match(html, /class="pahead-mark is-recovery">Recovery week/);
  assert.match(html, /A harder day/);
  assert.doesNotMatch(html, /<A>|<easy>|<runs>/, "no raw caller string reaches innerHTML");
  assert.doesNotMatch(html, /\d+\s*%|score|grade/i, "no scores");
});

test("the frame leads with the week and its one quiet door to the editor", () => {
  const ctx = load();
  const html = ctx.CairnProgramWeek.sectionHtml(ctx.CairnProgramWeek.skeletonHtml());
  assert.match(html, /<h2 class="pahead-title" id="paheadTitle">The week ahead<\/h2>/);
  assert.match(html, /data-train-leaf="plan">Edit plan<\/button>/, "the editor's own Train leaf");
  assert.match(html, /data-pahead-body[^>]*><div class="pahead-skel" aria-busy="true"/);
});

test("nothing planned, no calendar, or a failed read each say one calm line", () => {
  const ctx = load();
  const { programWeekModel } = ctx.CairnProgramWeekModel;
  const { bodyHtml } = ctx.CairnProgramWeek;
  const empty = bodyHtml(programWeekModel({ ...lookAhead(), mode: "empty", weeks: [] }));
  assert.match(empty, /Nothing planned yet\./);
  assert.match(empty, /data-pahead-edit>Build your plan</, "the editor door says what it opens");
  assert.match(empty, /data-pahead-ask/);
  const order = bodyHtml(
    programWeekModel({
      ...lookAhead(),
      mode: "order",
      weeks: [],
      order: [
        { title: "Push <1>", focus: null, lifts: ["Bench"], more: 1, done: false },
        { title: "Pull", focus: null, lifts: [], more: 0, done: false },
      ],
    })
  );
  assert.match(order, /No lifting weekdays are set yet/);
  // Chat is the lifting weekdays' only setter: the order mode offers it, prefilled.
  assert.match(order, /data-pahead-ask="The days I lift each week are: ">Tell the coach which days you lift</);
  assert.match(order, /Next<\/span>[\s\S]*Push &lt;1&gt;[\s\S]*Bench \+1/);
  assert.match(order, /Then<\/span>[\s\S]*Pull/);
  assert.match(bodyHtml(programWeekModel(null)), /couldn't be read just now/);
  assert.match(bodyHtml(programWeekModel({ error: "boom" })), /couldn't be read just now/);
});

function fakeHost() {
  const body = { innerHTML: "", firstElementChild: null };
  return {
    body,
    isConnected: true,
    querySelector(selector) {
      return selector === "[data-pahead-body]" ? body : null;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the controller paints the held read at once, then repaints only on a change", async () => {
  const ctx = load();
  const host = fakeHost();
  let upgrade = null;
  const asked = [];
  ctx.CairnProgramWeekController.mount(host, {
    peekCached: (key) => (key === "plan:look-ahead" ? { data: lookAhead(), fresh: false } : null),
    cachedApi: (path, options) => {
      asked.push([path, options.key]);
      upgrade = options.onUpgrade;
      return Promise.resolve(lookAhead());
    },
    editPlan() {},
    ask() {},
  });
  assert.deepEqual(asked, [["/plan/look-ahead", "plan:look-ahead"]]);
  assert.match(host.body.innerHTML, /Legs &lt;A&gt;/, "the warm paint, no skeleton");
  upgrade(lookAhead({ mode: "empty", weeks: [] }), { changed: false });
  assert.match(host.body.innerHTML, /Legs &lt;A&gt;/, "an unchanged read never repaints");
  upgrade(lookAhead({ mode: "empty", weeks: [] }), { changed: true });
  assert.match(host.body.innerHTML, /Nothing planned yet/);
  await flush();
});

test("a cold open shows the skeleton, then the read; a failed cold read says so", async () => {
  const ctx = load();
  const host = fakeHost();
  ctx.CairnProgramWeekController.mount(host, {
    peekCached: () => null,
    cachedApi: () => Promise.resolve(lookAhead()),
    editPlan() {},
    ask() {},
  });
  assert.match(host.body.innerHTML, /pahead-skel/);
  await flush();
  assert.match(host.body.innerHTML, /Pull · lighter today/);

  const failed = fakeHost();
  ctx.CairnProgramWeekController.mount(failed, {
    peekCached: () => null,
    cachedApi: () => Promise.reject(new Error("offline")),
    editPlan() {},
    ask() {},
  });
  await flush();
  assert.match(failed.body.innerHTML, /couldn't be read just now/);
});

test("the empty state's doors open the editor and Ask; a torn-down mount paints nothing", async () => {
  const ctx = load();
  const host = fakeHost();
  const opened = [];
  let resolve;
  const teardown = ctx.CairnProgramWeekController.mount(host, {
    peekCached: () => null,
    cachedApi: () => new Promise((r) => (resolve = r)),
    editPlan: () => opened.push("edit"),
    ask: (text) => opened.push(text ? `ask:${text}` : "ask"),
  });
  const mount = ctx.mounts.at(-1);
  assert.equal(mount.name, "pahead");
  mount.actions["pahead-edit"]();
  mount.actions["pahead-ask"]({ dataset: {} });
  mount.actions["pahead-ask"]({ dataset: { paheadAsk: "The days I lift each week are: " } });
  assert.deepEqual(opened, ["edit", "ask", "ask:The days I lift each week are: "]);
  teardown();
  resolve(lookAhead());
  await flush();
  assert.match(host.body.innerHTML, /pahead-skel/, "a stale read never lands after teardown");
});
