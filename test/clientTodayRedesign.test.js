// The redesigned Today's renderers (docs/DESIGN.md "Today"): the one Horizon glance
// line under the Brief (today-path-client), the overnight digest (today-digest-client),
// This week's strip / gauges / sparkline (today-week-client), the one new connection
// (today-horizon-client), and the today-ahead controller that mounts them. The Path
// card, Coming up and the progress board left Today for Horizon (docs/IA.md); the goal
// board is Horizon's (horizon-client, tested here too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-10-02"; // a Friday

function path(overrides = {}) {
  return {
    as_of: TODAY,
    trail_start: "2026-09-04",
    race: {
      event: "Cambridge <Half>",
      distance_label: "Half marathon",
      date: "2026-11-01",
      days_to_race: 30,
      estimate_sec: 6896,
      target_sec: 7200,
      target_raw: "sub-2:00",
      trend_delta_sec: -720,
      since: "2026-09-04",
      fit: "fits",
    },
    weight: {
      mode: "lose",
      current_lb: 159.8,
      current_date: TODAY,
      goal_lb: 154,
      goal_date: "2026-11-15",
      trend_lb_wk: -0.76,
      needed_lb_wk: -0.92,
      points: [
        { date: "2026-09-20", weight_lb: 161.2 },
        { date: "2026-09-26", weight_lb: 160.4 },
        { date: TODAY, weight_lb: 159.8 },
      ],
    },
    anchor: { exercise: "Deadlift", est_1rm: 285, target_est_1rm: 340, lb_per_week: 4.2, projection_weeks: [11, 22] },
    milestones: [
      {
        date: "2026-10-04",
        end_date: null,
        label: "Long run · 11.8 km",
        kind: "long_run",
        detail: "Easy, 6:21–6:51 /km.",
      },
      {
        date: "2026-10-12",
        end_date: "2026-10-18",
        label: "Peak week · 34 km, a new high",
        kind: "peak_week",
        detail: null,
      },
      {
        date: "2026-11-01",
        end_date: null,
        label: "Cambridge <Half>",
        kind: "race",
        detail: "Now reading 1:54:56, inside sub-2:00.",
      },
      { date: "2026-11-15", end_date: null, label: "Goal weight · 154 lb", kind: "goal", detail: null },
      {
        date: "2026-11-16",
        end_date: "2026-11-20",
        label: "Checkup week · blood draw",
        kind: "checkup",
        detail: "One morning draw covers it.",
      },
    ],
    lever: { kind: "weight", text: "Weight is a little <behind> the line." },
    focus: "lipids & recomposition",
    board: [
      {
        key: "race",
        id: "race",
        label: "Half marathon",
        start_text: "2:06:56",
        now_text: "1:54:56",
        goal_text: "2:00:00",
        progress: 1,
        reached: true,
        note: "Past your target.",
        direction: null,
        movement: 1,
      },
      {
        key: "weight",
        id: "weight",
        label: "Weight",
        start_text: "184.3 lb",
        now_text: "159.8 lb",
        goal_text: "154 lb",
        progress: 0.8,
        reached: false,
        note: "24.5 lb down since Jun 2",
        direction: null,
        movement: 0.1,
      },
      {
        key: "marker",
        id: "marker:apob",
        label: "ApoB",
        start_text: null,
        now_text: "134 mg/dL",
        goal_text: null,
        progress: null,
        reached: false,
        note: "Falling · Recheck opens Nov 16",
        direction: "toward",
        movement: 0,
      },
    ],
    week: { km_planned: 33, km_logged: 22.3, long_km: 11.8, phase: "Sharpen" },
    frame: {
      headline: "30 days to Cambridge <Half>",
      line: "Sharpen · block week 5 of 6",
      glance: { line: "30 days to Cambridge <Half> · Sharpen, wk 5 of 6", href: "/app/horizon" },
    },
    ...overrides,
  };
}

function loadPath() {
  return loadClientModule(["html-utils", "ui-format", "today-path-client"]).CairnTodayPath;
}

function loadAhead(globals = {}) {
  return loadClientModule(
    [
      "html-utils",
      "ui-format",
      "ui-actions-client",
      "decision-undo-client",
      "today-worth-client",
      "today-digest-client",
      "today-week-client",
      "today-horizon-client",
      "today-ahead-controller",
      // The strip's chips are the day view's (the calendar bundle today-ahead depends on).
      "day-detail-model",
      "day-glance-model",
      "day-detail-run-client",
      "day-detail-client",
      "day-glance-view",
      "day-detail-controller",
      "drill-controller",
      "today-strip-client",
      "today-strip-controller",
      "today-push-client",
      "today-push-controller",
    ],
    { globals }
  );
}

test("Today's road ahead is ONE glance line into Horizon, the server's own words, escaped", () => {
  const api = loadPath();
  const host = renderHtml(api.glanceHtml(path()));
  const link = host.querySelector("a.tglance[data-tpath-goals]");
  assert.ok(link, "the glance line");
  assert.equal(link.getAttribute("href"), "/app/horizon");
  assert.equal(link.querySelector(".tglance-t").textContent, "30 days to Cambridge <Half> · Sharpen, wk 5 of 6");
  assert.equal(link.querySelector(".tglance-go").textContent, "›");
  assert.doesNotMatch(api.glanceHtml(path()), /<Half>/, "server strings never open markup");
  // The Path card's parts left Today: no trail, no threads, no lever, no "All goals".
  assert.doesNotMatch(api.glanceHtml(path()), /tpath-svg|tpath-thread|lever|All goals|1:54:56/);
  assert.equal(api.cardHtml, undefined, "the Path card is gone");
  // Nothing to glance at: nothing painted (the slot collapses).
  assert.equal(api.glanceHtml(null), "");
  assert.equal(api.glanceHtml(path({ frame: null })), "");
  assert.equal(api.glanceHtml(path({ frame: { headline: null, line: null, glance: null } })), "");
});

test("the glance line opens Horizon through the app's own tab switch; a modified click keeps the href", async () => {
  const win = loadClientModule(["html-utils", "ui-format", "ui-actions-client", "today-path-client", "today-path-controller"]);
  const host = createHost(win.document, { html: "" });
  let opened = 0;
  win.CairnTodayPathController.mount(host, {
    date: TODAY,
    peek: () => ({ data: path(), fresh: true }),
    load: async () => path(),
    openHorizon: () => {
      opened += 1;
    },
  });
  await flush();
  const link = host.querySelector("[data-tpath-goals]");
  assert.ok(link, "the line painted");
  const plain = new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(plain);
  assert.equal(opened, 1);
  assert.equal(plain.defaultPrevented, true, "the app's own tab switch, not a page load");
  const modified = new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
  link.dispatchEvent(modified);
  assert.equal(opened, 1, "a modified click is the browser's (a new tab)");
  assert.equal(modified.defaultPrevented, false);
  // A re-mount on the same slot leaves exactly one listener.
  win.CairnTodayPathController.mount(host, {
    date: TODAY,
    peek: () => ({ data: path(), fresh: true }),
    load: async () => path(),
    openHorizon: () => {
      opened += 1;
    },
  });
  await flush();
  host.querySelector("[data-tpath-goals]").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(opened, 2);
});

function digestMove(exercise, from, to, reason = null) {
  return { exercise, direction: "up", from_text: from, to_text: to, reason };
}

test("the digest: one line per lift with before → after, an Undo per single-lift change, and the one question", () => {
  const { CairnTodayDigest } = loadAhead();
  const digest = {
    as_of: TODAY,
    when: "Overnight",
    headline: "3 lifts moved",
    changes: [
      {
        id: 41,
        state: "applied",
        title: "Raised your targets on 2 lifts",
        status_line: "Landed today",
        new: true,
        undo: { available: true, label: "Restore previous targets" },
        moves: [
          digestMove("Romanian <Deadlift>", "205 lb", "210 lb", "205 × 10 earned it"),
          digestMove("Barbell Curl", "80 lb", "82.5 lb", "Capped the range twice"),
        ],
      },
      {
        id: 42,
        state: "applied",
        title: "Held your Back Squat target",
        status_line: "Landed today",
        new: true,
        undo: { available: true, label: "Restore previous Back Squat target" },
        moves: [{ exercise: "Back Squat", direction: "same", from_text: null, to_text: "185 lb", reason: "Bar speed held" }],
      },
    ],
  };
  const ask = {
    id: "draft-proposals",
    title: "A plan change is waiting",
    body: "Push the goal date to Dec 12?",
    action: { label: "Review", kind: "plan-coach", payload: { proposal_id: 77, count: 1 } },
  };
  const host = renderHtml(CairnTodayDigest.html(digest, ask));
  assert.equal(host.querySelector(".tdg-head .lbl").textContent, "Overnight · 3 lifts moved");
  const rows = host.querySelectorAll(".tdg-row");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector(".tdg-ex").textContent, "Romanian <Deadlift>");
  assert.equal(rows[0].querySelector(".tdg-from").textContent, "205 lb");
  assert.equal(rows[0].querySelector(".tdg-to").textContent, "210 lb");
  assert.equal(rows[0].querySelector(".tdg-arrow").textContent, "↑");
  // The explanation rides the FIRST row only; every other row is the one line.
  assert.equal(rows[0].querySelector("small").textContent, "205 × 10 earned it");
  assert.equal(rows[1].querySelector("small"), null);
  assert.equal(rows[2].querySelector("small"), null);
  // A two-lift change has ONE Undo, named by the server; a one-lift change keeps its own.
  assert.equal(rows[0].querySelector("[data-tdg-undo]"), null);
  assert.equal(host.querySelector(".tdg-undo-row [data-tdg-undo]").textContent, "Restore previous targets");
  const single = rows[2].querySelector("[data-tdg-undo]");
  assert.equal(single.textContent, "Undo");
  assert.equal(single.getAttribute("data-tdg-undo"), "42");
  assert.equal(single.getAttribute("title"), "Restore previous Back Squat target");
  // Nothing set aside is printed on Today; that housekeeping lives in Changes.
  assert.equal(host.querySelector(".tdg-retired"), null);
  assert.doesNotMatch(host.textContent, /Set aside/);
  // The one genuine ask, answered inline.
  assert.equal(host.querySelector(".tdg-ask-q").textContent, "Push the goal date to Dec 12?");
  assert.equal(host.querySelector("[data-tdg-apply]").getAttribute("data-tdg-apply"), "77");
  assert.equal(host.querySelector("[data-tdg-keep]").getAttribute("data-tdg-keep"), "77");
  assert.ok(host.querySelector("[data-tdg-talk]"));
  assert.equal(host.querySelector("[data-tdg-all]").textContent, "All changes", "nothing held back: the plain link");
});

test("the digest shows at most three lifts; the rest are counted on the Changes link, and every shown Undo stays", () => {
  const { CairnTodayDigest } = loadAhead();
  assert.equal(CairnTodayDigest.MAX_ROWS, 3);
  const digest = {
    as_of: TODAY,
    when: "Overnight",
    headline: "5 lifts moved",
    changes: [
      {
        id: 61,
        state: "applied",
        title: "Raised your targets on 4 lifts",
        status_line: "Landed today",
        new: true,
        undo: { available: true, label: "Restore previous targets" },
        moves: [
          digestMove("Bench Press", "185 lb", "190 lb", "Capped 8 reps on every set"),
          digestMove("Barbell Row", "135 lb", "140 lb", "Earned it"),
          digestMove("Lat Pulldown", "120 lb", "125 lb", "Earned it"),
          digestMove("Barbell Curl", "60 lb", "65 lb", "Earned it"),
        ],
      },
      {
        id: 62,
        state: "applied",
        title: "Raised your Back Squat target",
        status_line: "Landed today",
        new: true,
        undo: { available: true, label: "Restore previous Back Squat target" },
        moves: [digestMove("Back Squat", "185 lb", "190 lb", "Earned it")],
      },
    ],
  };
  const host = renderHtml(CairnTodayDigest.html(digest, null));
  const rows = host.querySelectorAll(".tdg-row");
  assert.equal(rows.length, 3, "three lines, never the whole night");
  assert.deepEqual(
    rows.map((row) => row.querySelector(".tdg-ex").textContent),
    ["Bench Press", "Barbell Row", "Lat Pulldown"]
  );
  assert.equal(rows[0].querySelector("small").textContent, "Capped 8 reps on every set");
  assert.equal(host.querySelectorAll(".tdg-row small").length, 1, "one explanation, on the first row");
  // The partly shown change keeps its one whole-change restore; the change past the cap
  // waits in Changes with its own Undo.
  const undos = host.querySelectorAll("[data-tdg-undo]");
  assert.equal(undos.length, 1);
  assert.equal(undos[0].getAttribute("data-tdg-undo"), "61");
  assert.equal(undos[0].textContent, "Restore previous targets");
  assert.equal(host.querySelector("[data-tdg-all]").textContent, "+2 more in Changes");
});

test("the digest's \"+N more\" counts the server's total, not just the capped list it was sent", () => {
  const { CairnTodayDigest } = loadAhead();
  const change = (id, name) => ({
    id,
    state: "applied",
    title: `Raised your ${name} target`,
    status_line: "Landed today",
    new: true,
    undo: { available: true, label: `Restore previous ${name} target` },
    moves: [digestMove(name, "100 lb", "105 lb", "Earned it")],
  });
  const digest = {
    as_of: TODAY,
    when: "Overnight",
    headline: "11 lifts moved",
    total_rows: 11,
    changes: [change(71, "Bench Press"), change(72, "Barbell Row"), change(73, "Back Squat"), change(74, "Curl")],
  };
  const host = renderHtml(CairnTodayDigest.html(digest, null));
  assert.equal(host.querySelectorAll(".tdg-row").length, 3);
  assert.equal(host.querySelector("[data-tdg-all]").textContent, "+8 more in Changes");
  // An older server with no total still counts what it sent.
  const { total_rows: _omit, ...legacy } = digest;
  const legacyHost = renderHtml(CairnTodayDigest.html(legacy, null));
  assert.equal(legacyHost.querySelector("[data-tdg-all]").textContent, "+1 more in Changes");
});

test("the digest is omitted when the team changed nothing and asks nothing", () => {
  const { CairnTodayDigest } = loadAhead();
  assert.equal(CairnTodayDigest.html({ as_of: TODAY, when: "Lately", headline: null, changes: [] }, null), "");
  assert.equal(CairnTodayDigest.html(null, null), "");
});

test("ONE week view on Today, a GLANCE: the stones strip is gone, and What's ahead carries the days, no counts", () => {
  const { CairnTodayWeek, CairnTodayStrip } = loadAhead();
  const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", TODAY, "2026-10-03", "2026-10-04"].map(
    (date) => ({ date, weekday: null, dow: null, status: "rest", plan_day: null, session: null, run: null, hard: false })
  );
  days[0].session = { id: 1, title: "Push", date: days[0].date, finished: true };
  days[4].plan_day = { day_number: 2, name: "Pull", focus: null, purpose: null, day_type: "training", role: "lift", out_of_order: false };
  assert.equal(CairnTodayWeek.stripHtml, undefined, "the stones strip left Today");
  assert.equal(CairnTodayWeek.kmNote, undefined);
  const progress = { lift_days_done: 1, lift_days_planned: 5, runs_done: 1, run_km: 6, longest_run_km: 6, runs_open: [], prs: 2, line: null };
  const host = renderHtml(CairnTodayStrip.stripHtml({ days, progress, summary: "One of five lifting days in." }, TODAY, null, { block: "Recovery week · day <2> of 7" }));
  assert.equal(host.querySelectorAll("button.tstrip-day").length, 7);
  assert.equal(host.querySelector("[data-tstrip-block]").textContent, "Recovery week · day <2> of 7");
  assert.equal(host.querySelector(".tstrip-block b"), null, "escaped");
  // The week's sentence and counts are Horizon's: never a tally line on Today.
  assert.equal(host.querySelector(".tstrip-tally"), null);
  assert.doesNotMatch(host.textContent, /lifting days|new best|One of five/);
  assert.equal(CairnTodayStrip.stripHtml({ days: days.slice(0, 5), progress }, TODAY), "", "no strip outside calendar mode");
});

test("the bodyweight sparkline draws the weigh-ins over a dotted goal line, and the week's small lines", () => {
  const { CairnTodayWeek } = loadAhead();
  const svg = CairnTodayWeek.sparkSvg(path().weight.points, 154);
  assert.match(svg, /<line class="tspark-goal"/);
  assert.match(svg, /<polyline class="tspark-line" points="[\d., ]+"/);
  assert.equal(CairnTodayWeek.sparkSvg([{ date: TODAY, weight_lb: 160 }], 154), "");
  assert.equal(CairnTodayWeek.blockLine, undefined, "the stage words are the server's (the glance line)");
});

test("Coming up left Today: the road ahead is Horizon's, one glance line away", () => {
  const { CairnTodayHorizon } = loadAhead();
  assert.equal(CairnTodayHorizon.horizonHtml, undefined);
});

test("the new connection: one sentence at Today's foot, only when new; the progress board is not on Today", () => {
  const { CairnTodayHorizon } = loadAhead();
  const html = CairnTodayHorizon.connectionHtml({
    kind: "connection",
    status: "new",
    text: "Long runs follow good sleep. More detail here.",
  });
  const host = renderHtml(html);
  assert.match(host.querySelector(".thd-insight").textContent, /Long runs follow good sleep\./);
  assert.doesNotMatch(host.querySelector(".thd-insight").textContent, /More detail/);
  assert.equal(host.querySelector(".thd-row"), null, "no progress board on Today");
  assert.equal(CairnTodayHorizon.connectionHtml({ kind: "connection", status: "seen", text: "Old news." }), "");
  assert.equal(CairnTodayHorizon.connectionHtml(null), "");
  assert.equal(CairnTodayHorizon.boardHtml, undefined, "Where you're heading left Today");
});

test("All goals on Horizon's goal line: a track per thread with numbers at the ends, the marker's direction", () => {
  const { CairnHorizon } = loadClientModule(["html-utils", "ui-format", "horizon-client"]);
  const html = CairnHorizon.goalsBoardHtml(path());
  const host = renderHtml(html);
  assert.equal(host.querySelector(".thd-mast .lbl").textContent, "All goals");
  const rows = host.querySelectorAll(".thd-row");
  assert.equal(rows.length, 3);
  assert.match(rows[0].querySelector(".thd-top").textContent, /Half marathon2:06:56 → 1:54:56 · goal 2:00:00/);
  assert.equal(rows[0].querySelector(".thd-fill").getAttribute("style"), "--w:100%");
  assert.ok(rows[0].querySelector(".thd-fill.is-reached"));
  assert.equal(rows[1].querySelector(".thd-fill").getAttribute("style"), "--w:80%");
  assert.match(rows[1].querySelector("small").textContent, /24\.5 lb down since Jun 2/);
  assert.equal(rows[2].querySelector(".thd-track"), null, "a marker row has a direction, not a track");
  assert.ok(rows[2].querySelector(".thd-dir.is-toward"));
  assert.match(rows[2].textContent, /ApoB134 mg\/dL/);
  assert.doesNotMatch(html, /\d+\s*\/\s*100|score/i);
  assert.equal(CairnHorizon.goalsBoardHtml(path({ board: [] })), "");
  assert.equal(CairnHorizon.goalsBoardHtml(null), "");
});

test("the today-ahead controller fills each slot from its read and answers an ask inline", async () => {
  const calls = [];
  const toasts = [];
  let refreshed = 0;
  const win = loadAhead();
  const host = createHost(win.document, {
    html: `<section class="brief"><div id="todayPushSlot"></div><div id="todayStripSlot"></div><div id="todayPushOfferSlot"></div></section><div id="todayDigestSlot"></div><span id="tweekSpark"></span><div id="tweekGauges"></div><div id="todayHeadingSlot"></div>`,
  });
  const weekDays = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", TODAY, "2026-10-03", "2026-10-04"].map((date) => ({
    date,
    weekday: null,
    dow: null,
    status: "upcoming",
    plan_day: null,
    session: null,
    run: null,
    hard: false,
  }));
  const reads = {
    [`/today-path?date=${TODAY}`]: path(),
    [`/today-digest?date=${TODAY}`]: { as_of: TODAY, when: "Overnight", headline: null, changes: [] },
    "/plan/week": {
      days: weekDays,
      progress: { lift_days_done: 2, lift_days_planned: 4, runs_done: 1, run_km: 22.3, longest_run_km: 11.8, runs_open: [], prs: 0, line: null },
    },
    "/recovery/baseline": { dimensions: [] },
    "/insights": [{ id: 3, kind: "connection", status: "new", text: "Long runs follow good sleep." }],
  };
  const ask = {
    id: "draft-proposals",
    title: "A plan change is waiting",
    body: "Push the goal date?",
    action: { kind: "plan-coach", label: "Review", payload: { proposal_id: 9, count: 1 } },
  };
  win.CairnTodayAhead.mount(host, {
    date: TODAY,
    read: { periodization_context: { program_block: { week_index: 5, total_weeks: 6 }, recovery_overlay: { day_index: 3, total_days: 7 } } },
    agenda: async () => ({ primary: [ask], more: [] }),
    peek: () => null,
    load: async (p) => reads[p],
    api: async (p, init) => {
      calls.push([p, init?.method]);
      return { ok: true };
    },
    toast: (m) => toasts.push(m),
    gotoChatWith: () => {},
    openChanges: () => {},
    openPlanCoach: () => {},
    refreshToday: () => {
      refreshed += 1;
    },
    invalidate: () => {},
  });
  await flush();
  await flush();
  // The strip is a glance: a running recovery week is its only header note (the stage
  // and block week ride the Horizon glance line), and it carries no tally line.
  assert.equal(host.querySelector("#todayStripSlot [data-tstrip-block]").textContent, "Recovery week · day 3 of 7");
  assert.equal(host.querySelector("#todayStripSlot .tstrip-tally"), null);
  assert.ok(host.querySelector("#tweekSpark svg.tspark"));
  assert.equal(host.querySelector(".thz"), null, "Coming up left Today");
  assert.ok(host.querySelector("#todayHeadingSlot .thd-insight"), "the one new connection");
  assert.equal(host.querySelector("#todayHeadingSlot .thd-row"), null, "no progress board on Today");
  // No push read: the push line and the offer stay empty (collapsed).
  assert.equal(host.querySelector("#todayPushSlot").innerHTML, "");
  assert.equal(host.querySelector("#todayPushOfferSlot").innerHTML, "");
  const apply = host.querySelector("[data-tdg-apply]");
  assert.ok(apply, "the ask landed once the agenda did");
  await apply.click();
  await flush();
  assert.deepEqual(calls, [["/proposals/9/apply", "POST"]]);
  assert.deepEqual(toasts, ["Done — your plan has it"]);
  assert.equal(refreshed, 1);
});
