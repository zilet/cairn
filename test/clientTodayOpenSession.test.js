// Today's open session (src/client/today-open-session-client.ts): the one server fact every
// surface prints and decides on, and the small rules around it — the conflict owner a 409
// carries, the chosen-day Brief, the quiet discard door, and the past-day session that
// looking at a day must never leave behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument, createHost, loadClientModule, renderHtml } from "./_dom.mjs";

const DATE = "2026-11-12";

const open = (extra = {}) => ({
  daily_session_id: 7,
  session_id: 9,
  source: "athlete_override",
  plan_day_id: null,
  title: "Pull",
  set_count: 0,
  started: false,
  chosen: true,
  action: "start",
  label: "Start Pull",
  ...extra,
});

function load(globals = {}) {
  const store = new Map();
  const swr = {
    peekCached: (key) => (store.has(key) ? { data: store.get(key), fresh: true } : null),
    swrSet: (key, data) => store.set(key, data),
    swrInvalidate: (key) => {
      store.delete(key);
      invalidated.push(key);
    },
  };
  const invalidated = [];
  const win = loadClientModule(["html-utils", "today-open-session-client", "today-open-session-discard-client"], { globals: { ...swr, ...globals } });
  return { win, store, invalidated, S: win.CairnTodayOpenSession };
}

const owner = (extra = {}) => ({ daily_session_id: 7, session_id: 9, source: "athlete_override", title: "Pull", set_count: 0, started: false, ...extra });

function prepared(id = 7) {
  return {
    ok: true,
    daily_session: { id, status: "active", source: "athlete_override" },
    session: { id: 9, date: DATE, sets: [] },
  };
}

// ---- 3. the conflict dead end: no tap ends on a toast with nowhere to go ----

// A re-read of /today the stubbed api answers: the aggregate shape the loader checks.
const aggregate = (openSession = null) => ({ date: DATE, plan: [], open_session: openSession });

function deps(extra = {}) {
  const log = { asked: [], said: [], entered: [], refreshed: 0 };
  return {
    log,
    deps: {
      prepare: async (body) => {
        log.asked.push({ ...body });
        return { current: true, ok: true, value: prepared(body.expected_active_id) };
      },
      enter: (date, response) => log.entered.push([date, response ? response.daily_session.id : null]),
      say: (message) => log.said.push(message),
      refresh: () => (log.refreshed += 1),
      ...extra,
    },
  };
}

test("a conflict that names its owner opens that session by id, then says so once in plain words", async () => {
  const { S, store } = load();
  const { deps: d, log } = deps();
  const ok = await S.openOwned(DATE, owner({ title: "Pull <A>" }), d, true);
  assert.equal(ok, true);
  assert.deepEqual(log.asked, [{ date: DATE, expected_active_id: 7 }], "the assertion path, by the owner's id");
  assert.deepEqual(log.entered, [[DATE, 7]]);
  assert.deepEqual(log.said, ["Pull <A> is already open — here it is."]);
  // The way out is reachable in this exact flow: an unstarted session shows its Discard door.
  assert.equal(store.get(S.key(DATE)).started, false);
  assert.match(S.discardHtml(DATE, store.get(S.key(DATE))), /id="sessDiscard"/);
});

test("an owner the app opened itself says nothing; the empty Open session is 'Your session'", async () => {
  const { S } = load();
  const quiet = deps();
  await S.openOwned(DATE, owner(), quiet.deps);
  assert.deepEqual(quiet.log.said, []);
  const named = deps();
  await S.openOwned(DATE, owner({ title: "Open session" }), named.deps, true);
  assert.deepEqual(named.log.said, ["Your session is already open — here it is."]);
});

test("a legacy owner with no composition is opened by re-sending the PLAIN prepare, and its answer is used", async () => {
  const { S } = load();
  const { deps: d, log } = deps({
    prepare: async (body) => (log.asked.push({ ...body }), { current: true, ok: true, value: prepared(31) }),
  });
  const ok = await S.openOwned(DATE, owner({ daily_session_id: null, source: null, started: true, set_count: 4 }), d, true);
  assert.equal(ok, true);
  assert.deepEqual(log.asked, [{ date: DATE }], "no replace, no fingerprint, no expected_active_id");
  assert.deepEqual(log.entered, [[DATE, 31]], "the adopted composition's own answer opens");
  assert.match(log.said[0], /already open/);
});

test("an owner that changed again is followed, never in a loop", async () => {
  const { S } = load({ api: async () => aggregate(null) });
  const moved = (id) => ({ ok: false, code: "daily_session_active_changed", error: "changed <raw>", owner: owner({ daily_session_id: id }) });
  const one = deps({
    prepare: async (body) => (body.expected_active_id === 7 ? { current: true, ok: true, value: moved(8) } : { current: true, ok: true, value: prepared(8) }),
  });
  assert.equal(await S.openOwned(DATE, owner(), one.deps, true), true);
  assert.deepEqual(one.log.entered, [[DATE, 8]]);

  let calls = 0;
  const loop = deps({
    prepare: async () => {
      calls += 1;
      return { current: true, ok: true, value: moved(7 + calls) };
    },
  });
  assert.equal(await S.openOwned(DATE, owner(), loop.deps, true), false);
  assert.ok(calls <= 3, "a bounded number of follows");
  assert.equal(loop.log.entered.length, 0);
  assert.equal(loop.log.said.length, 1, "one calm line");
  assert.doesNotMatch(loop.log.said[0], /raw|daily_session/);
  assert.equal(loop.log.refreshed, 1, "and Today repaints to the truth");
});

test("no owner / session gone / unreachable: re-read today, open what is there, else repaint with one calm line", async () => {
  // Today now has an open session (another device made it): it opens.
  const found = load({ api: async (path) => (path.startsWith("/today?date=") ? aggregate(open({ daily_session_id: 12 })) : assert.fail(path)) });
  const a = deps();
  assert.equal(await found.S.recover(DATE, a.deps), true);
  assert.deepEqual(a.log.asked, [{ date: DATE, expected_active_id: 12 }]);
  assert.match(a.log.said[0], /Pull is already open/);

  // Nothing open any more: the screen repaints, once, with a calm line.
  const none = load({ api: async () => aggregate(null) });
  none.store.set(none.S.key(DATE), open());
  const b = deps();
  assert.equal(await none.S.recover(DATE, b.deps), false);
  assert.equal(b.log.refreshed, 1);
  assert.equal(b.log.said.length, 1);
  assert.equal(none.store.get(none.S.key(DATE)), null, "the stale open session is dropped");

  // Unreachable: still a repaint and one line, never an unchanged screen.
  const down = load({ api: async () => { throw new Error("offline"); } });
  const c = deps();
  assert.equal(await down.S.recover(DATE, c.deps), false);
  assert.equal(c.log.refreshed, 1);
  assert.match(c.log.said[0], /Couldn't reach/);
  // ...and what is saved on this device stays: nothing was learned, so nothing is forgotten.
  down.store.set(`today:session:${DATE}`, { id: 9, _staged_offline: true });
  down.store.set(down.S.key(DATE), open());
  down.invalidated.length = 0;
  await down.S.recover(DATE, deps().deps);
  assert.deepEqual(down.store.get(`today:session:${DATE}`), { id: 9, _staged_offline: true });
  assert.ok(down.store.get(down.S.key(DATE)));
  assert.equal(down.invalidated.length, 0);
});

test("resolveConflict: owner opens it; every other session conflict re-reads; anything else is not its business", async () => {
  const { S } = load({ api: async () => aggregate(null) });
  const withOwner = deps();
  assert.equal(await S.resolveConflict(DATE, { ok: false, code: "daily_session_locked", error: "x", owner: owner({ started: true }) }, withOwner.deps), true);
  assert.deepEqual(withOwner.log.asked, [{ date: DATE, expected_active_id: 7 }]);
  for (const code of ["daily_session_active_changed", "daily_session_locked", "daily_session_changed", "daily_session_missing"]) {
    const bare = deps();
    assert.equal(await S.resolveConflict(DATE, { ok: false, code, error: "x" }, bare.deps), false, code);
    assert.equal(bare.log.refreshed, 1, code);
    assert.equal(bare.log.said.some((m) => /x$/.test(m)), false, "never the raw error");
  }
  assert.equal(S.resolveConflict(DATE, { ok: false, code: "validation", error: "x" }, deps().deps), null);
  assert.equal(S.resolveConflict(DATE, { ok: true }, deps().deps), null);
});

test("settle: every refusal ends somewhere true — an owner opens, anything else says one calm line and repaints", async () => {
  const { S } = load({ api: async () => aggregate(null) });
  const known = deps();
  assert.equal(await S.settle(DATE, { ok: false, code: "daily_session_locked", owner: owner({ started: true }) }, known.deps), true);
  for (const code of ["daily_session_invalid", "daily_session_session_missing", "daily_session_preview_stale", undefined]) {
    const d = deps();
    assert.equal(await S.settle(DATE, { ok: false, code, error: "raw <engine> text" }, d.deps), false, String(code));
    assert.equal(d.log.said.length, 1, String(code));
    assert.doesNotMatch(d.log.said[0], /raw|engine|daily_session/);
    assert.equal(d.log.refreshed, 1, String(code));
  }
});

test("ownerOf reads a real owner, with or without a composition id", () => {
  const { S } = load();
  assert.equal(S.ownerOf({ ok: false, code: "daily_session_locked", owner: owner() }).daily_session_id, 7);
  assert.equal(S.ownerOf({ owner: owner({ daily_session_id: null }) }).session_id, 9, "a legacy row is still an owner");
  assert.equal(S.ownerOf({ ok: false, code: "daily_session_locked" }), null);
  assert.equal(S.ownerOf(null), null);
});

// ---- point 4: stale local state never causes the conflict ----

test("adopt: the receipt button's call shape opens the open session instead of preparing a second", async () => {
  const { S, store } = load();
  store.set(S.key(DATE), open({ started: true, action: "continue", label: "Continue Pull" }));
  store.set(`today:aggregate:${DATE}`, { date: DATE });
  const opened = [];
  // change-receipt-client.ts: openSession(date, { source: "adaptive_plan", provenance: { entry: "chat_receipt" } })
  const receipt = { source: "adaptive_plan", provenance: { entry: "chat_receipt" } };
  const result = await S.adopt(DATE, receipt, async (own, announce) => (opened.push([own.daily_session_id, announce]), true));
  assert.equal(result, true);
  assert.deepEqual(opened, [[7, false]], "reuse, quietly: the athlete asked for exactly this");
  // Nothing open: the request goes ahead.
  assert.equal(await load().S.adopt(DATE, receipt, async () => assert.fail("nothing to open")), null);
});

test("adopt: Train anyway / a replace reads the date fresh and opens a chosen or started session", async () => {
  const asked = [];
  const { S } = load({ api: async (path) => (asked.push(path), aggregate(open({ chosen: true }))) });
  const opened = [];
  const trainAnyway = { source: "adaptive_plan", trainAnyway: true, replace: true, provenance: { entry: "train_anyway" } };
  assert.equal(await S.adopt(DATE, trainAnyway, async (own, announce) => (opened.push([own.daily_session_id, announce]), true)), true);
  assert.deepEqual(asked, [`/today?date=${DATE}`], "a fresh read, not the cache");
  assert.deepEqual(opened, [[7, true]], "and the athlete is told it was already there");

  // An unchosen, unstarted adaptive session is replaceable: the request goes ahead.
  const idle = load({ api: async () => aggregate(open({ chosen: false, source: "adaptive_plan" })) });
  assert.equal(await idle.S.adopt(DATE, trainAnyway, async () => assert.fail("replaceable")), null);
  // …and a stale cached "chosen" never beats the fresh answer.
  idle.store.set(idle.S.key(DATE), open({ chosen: true }));
  assert.equal(await idle.S.adopt(DATE, trainAnyway, async () => assert.fail("replaceable")), null);
});

test("adopt: a request that names what it wants (an agent job, a manual pick) is never redirected to the old owner", async () => {
  const { S, store } = load({ api: async () => aggregate(open()) });
  store.set(S.key(DATE), open());
  const never = async () => assert.fail("deliberate");
  const useThis = { source: "agent_suggest", agentJobId: 55, replace: true, provenance: { operation: "session_suggest" } };
  assert.equal(await S.adopt(DATE, useThis, never), null, "Use this session");
  assert.equal(await S.adopt(DATE, { source: "manual_plan", replace: true }, never), null, "a manual pick with no day yet");
});

test("adopt: pending is shown while it reads the date, and cleared however it ends", async () => {
  const { S } = load({ api: async () => aggregate(open()) });
  const states = [];
  await S.adopt(DATE, { source: "adaptive_plan", replace: true, trainAnyway: true }, async () => true, (on) => states.push(on));
  assert.deepEqual(states, [true, false]);
});

test("adopt: a pick of a plan day or a built session is a deliberate change and goes through", async () => {
  const { S, store } = load({ api: async () => aggregate(open()) });
  store.set(S.key(DATE), open());
  const never = async () => assert.fail("deliberate");
  assert.equal(await S.adopt(DATE, { source: "manual_plan", dayNumber: 3, replace: true }, never), null);
  assert.equal(await S.adopt(DATE, { source: "agent_suggest", session: { items: [] } }, never), null);
});

test("adopt: an unreachable read falls back to what is cached", async () => {
  const { S, store } = load({ api: async () => { throw new Error("offline"); } });
  store.set(`today:aggregate:${DATE}`, { date: DATE });
  store.set(S.key(DATE), open({ started: true }));
  const opened = [];
  assert.equal(await S.adopt(DATE, { source: "adaptive_plan", preview: { fingerprint: "f" } }, async (own) => (opened.push(own.daily_session_id), true)), true);
  assert.deepEqual(opened, [7]);
});

test("remember: a session the app just made is open at once, so its Discard door shows", () => {
  const { S, store } = load();
  S.remember(DATE, { id: 21, source: "adaptive_plan", title: "Pull" }, { id: 30, sets: [] });
  const read = store.get(S.key(DATE));
  assert.equal(read.daily_session_id, 21);
  assert.equal(read.label, "Start Pull");
  assert.match(S.discardHtml(DATE, read), /data-id="21"/);
  S.remember(DATE, { id: 21, source: "adaptive_plan", title: "Open session" }, { id: 30, sets: [{ id: 1 }] });
  assert.equal(store.get(S.key(DATE)).label, "Continue your session");
  assert.equal(S.discardHtml(DATE, store.get(S.key(DATE))), "");
  // A staged local session (no server id yet) is not an open session.
  store.delete(S.key(DATE));
  S.remember(DATE, { id: "local-1" }, {});
  assert.equal(store.has(S.key(DATE)), false);
});


// ---- 4. discard ----

test("the Discard door is drawn only for a session nothing has been done on", () => {
  const { S } = load();
  assert.equal(S.canDiscard(open({ started: false })), true);
  assert.equal(S.canDiscard(open({ started: true })), false);
  assert.equal(S.canDiscard(null), false);
  const html = S.discardHtml(DATE, open({ daily_session_id: 7 }));
  const host = renderHtml(html, { document: createDocument() });
  const button = host.querySelector("#sessDiscard");
  assert.equal(button.textContent, "Discard this session");
  assert.equal(button.dataset.id, "7");
  assert.equal(button.dataset.date, DATE);
  assert.ok(button.classList.contains("linkbtn"), "a quiet text action, not a button");
  assert.equal(S.discardHtml(DATE, open({ started: true })), "");
  assert.equal(S.discardHtml(DATE, null), "");
});

test("discard posts the id it holds, forgets the date and returns to Today", async () => {
  const { S, store, invalidated } = load();
  store.set(`today:open:${DATE}`, open());
  const calls = [];
  let done = 0;
  const gone = await S.discard(DATE, 7, {
    api: async (path, init) => {
      calls.push([path, JSON.parse(init.body)]);
      return { ok: true, discarded: true, daily_session_id: 7, session_id: 9, date: DATE };
    },
    say: (message) => assert.fail("quiet on success: " + message),
    done: () => (done += 1),
  });
  assert.equal(gone, true);
  assert.deepEqual(calls, [["/daily-session/discard", { date: DATE, expected_active_id: 7 }]]);
  assert.equal(done, 1);
  assert.equal(store.get(`today:open:${DATE}`), null, "no open session is left to print");
  assert.ok(invalidated.includes(`today:session:${DATE}`));
  assert.ok(invalidated.includes(`today:aggregate:${DATE}`));
});

test("a session that has logged work is kept, and the athlete is told so plainly", async () => {
  const { S } = load();
  const said = [];
  const gone = await S.discard(DATE, 7, {
    api: async () => ({ ok: false, code: "daily_session_locked", error: "locked <sql>", owner: owner({ started: true }) }),
    say: (message) => said.push(message),
    done: () => assert.fail("a kept session does not leave"),
  });
  assert.equal(gone, false);
  assert.equal(said.length, 1);
  assert.match(said[0], /work logged/);
  assert.match(said[0], /not lost|stays/);
  assert.doesNotMatch(said[0], /sql|locked/i);
});

test("a session already gone counts as discarded", async () => {
  const { S } = load();
  let done = 0;
  const gone = await S.discard(DATE, 7, {
    api: async () => ({ ok: false, code: "daily_session_missing", error: "none" }),
    say: () => assert.fail("quiet"),
    done: () => (done += 1),
  });
  assert.equal(gone, true);
  assert.equal(done, 1);
});

test("the wired Discard button disables itself while working and comes back after a refusal", async () => {
  const { S, win } = load();
  const doc = win.document;
  const root = createHost(doc);
  root.innerHTML = S.discardHtml(DATE, open());
  const said = [];
  S.wireDiscard(root, {
    api: async () => ({ ok: false, code: "daily_session_locked", error: "x" }),
    say: (message) => said.push(message),
    done: () => assert.fail("kept"),
  });
  const button = root.querySelector("#sessDiscard");
  await button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(said.length, 1);
  assert.equal(button.disabled, false, "free again after a refusal");
});

// ---- 5. looking at a past day mints nothing that lasts ----

test("leaving a past day's session with nothing logged drops it; a started one stays", async () => {
  const posts = [];
  const win = load({
    api: async (path, init) => {
      posts.push([path, JSON.parse(init.body)]);
      return posts.length === 1 ? { ok: true, discarded: true } : { ok: false, code: "daily_session_locked", error: "x" };
    },
  });
  win.store.set(`today:daily-session:${DATE}`, { id: 41 });
  win.S.markPastDay(DATE, true);
  await win.S.leavePastDay();
  assert.deepEqual(posts, [["/daily-session/discard", { date: DATE, expected_active_id: 41 }]]);

  // A second leave asks nothing: the marker is spent.
  await win.S.leavePastDay();
  assert.equal(posts.length, 1);

  // A session with logged work answers `locked`: nothing is said, nothing is lost.
  win.store.set(`today:daily-session:${DATE}`, { id: 42 });
  win.S.markPastDay(DATE, true);
  await win.S.leavePastDay();
  assert.equal(posts.length, 2);
  assert.equal(win.store.get(`today:daily-session:${DATE}`).id, 42, "a kept session stays cached");
});

test("a past day is marked only when this tap minted its session, and never discarded while a write for it is queued", async () => {
  const posts = [];
  const queued = [{ kind: "set", session_date: DATE, body: { date: DATE } }];
  const { S, store } = load({ api: async (...args) => posts.push(args), CairnOutbox: { list: () => queued } });
  store.set(`today:daily-session:${DATE}`, { id: 41 });
  S.markPastDay(DATE, false);
  await S.leavePastDay();
  assert.deepEqual(posts, [], "an existing session the tap did not create is never dropped");
  S.markPastDay(DATE, true);
  await S.leavePastDay();
  assert.deepEqual(posts, [], "a queued set for the date holds the discard back");
  queued.length = 0;
  S.markPastDay(DATE, true);
  await S.leavePastDay();
  assert.equal(posts.length, 1);
});

test("leaving with no remembered past day, or no known id, asks the server nothing", async () => {
  const posts = [];
  const { S } = load({ api: async (...args) => posts.push(args) });
  await S.leavePastDay();
  S.markPastDay(DATE, true);
  await S.leavePastDay();
  assert.deepEqual(posts, []);
});

// ---- the Brief of a chosen day, the rest trade ----

test("a chosen session on a quiet read is the day; anything else leaves the read alone", () => {
  const { S } = load();
  const rest = { kind: "rest", headline: "Rest day", why: "Take it easy", focus: "recovery", est_minutes: 30 };
  const chosen = S.briefRead(rest, open({ chosen: true }));
  assert.equal(chosen.kind, "train");
  assert.equal(chosen.headline, "Pull");
  assert.equal(chosen.why, "");
  assert.equal(chosen.focus, null);
  assert.equal(chosen.est_minutes, 30, "the rest of the read rides along");
  assert.equal(rest.kind, "rest", "the server's read is never mutated");
  assert.equal(S.briefRead(rest, open({ chosen: false })), rest);
  assert.equal(S.briefRead(rest, null), rest);
  const train = { kind: "train", headline: "Go" };
  assert.equal(S.briefRead(train, open({ chosen: true })), train);
  const said = S.briefRead(train, open({ chosen: true, headline: "Full upper is on today." }));
  assert.equal(said.headline, "Full upper is on today.", "the server's chosen-session headline is printed verbatim");
  assert.equal(train.headline, "Go");
  assert.equal(S.briefRead(train, open({ chosen: false, headline: "x" })), train);
  const done = { kind: "done", headline: "Done" };
  assert.equal(S.briefRead(done, open({ chosen: true })), done);
  assert.equal(S.briefRead(null, open()), null);
});

test("a trade answer opens the session only when the server says train_anyway", () => {
  const { S } = load();
  assert.equal(S.tradeOpensSession({ ok: true, train_anyway: true, read: {} }), true);
  assert.equal(S.tradeOpensSession({ ok: true, read: {} }), false);
  assert.equal(S.tradeOpensSession({ ok: false, train_anyway: true }), true, "the flag is the server's word");
  assert.equal(S.tradeOpensSession(null), false);
});

test("a cached open session is trusted only while the date's aggregate still stands (a write drops it)", () => {
  const { S, store } = load();
  store.set(S.key(DATE), open());
  assert.equal(S.cached(DATE), null, "no aggregate: a write since means the id may be stale");
  store.set(`today:aggregate:${DATE}`, { date: DATE });
  assert.equal(S.cached(DATE).daily_session_id, 7);
});

test("the cached open session is the date's own, and only a real one", () => {
  const { S, store } = load();
  store.set(`today:aggregate:${DATE}`, { date: DATE });
  assert.equal(S.cached(DATE), null);
  store.set(S.key(DATE), open());
  assert.equal(S.cached(DATE).label, "Start Pull");
  store.set(S.key(DATE), null);
  assert.equal(S.cached(DATE), null);
  assert.equal(S.key(DATE), `today:open:${DATE}`);
});

// ---- the launch card, the shell ----

test("the launch card's one action is the open session's label, and liveness is the server's", () => {
  const win = loadClientModule(["html-utils", "today-session-launch-client"], {
    globals: { CairnTodayBrief: { distinctLine: (text, ...others) => (others.includes(text) ? "" : text) } },
  });
  const base = { day: null, exDone: 0, exTotal: 0, isToday: true, hasLoggedSets: false, isRunDay: false, read: null };
  const card = (opts) => renderHtml(win.CairnTodaySessionLaunch.cardHtml({ ...base, ...opts }, null), { document: win.document });
  const idle = card({ open: open({ label: "Start Pull & co" }) });
  assert.equal(idle.querySelector(".sess-launch-cta").textContent.replace(/\s+/g, " ").trim(), "Start Pull & co →");
  assert.equal(idle.querySelector(".sess-launch-title").textContent, "Pull");
  const live = card({ open: open({ started: true, action: "continue", label: "Continue Pull" }) });
  assert.match(live.querySelector(".sess-launch-cta").textContent, /^Continue Pull/);
  // No server fact: the card keeps its own words.
  assert.match(card({}).querySelector(".sess-launch-cta").textContent, /^Start/);
  // The server's "started" overrules a local set count that disagrees.
  assert.equal(win.CairnTodaySessionLaunch.facts({ ...base, hasLoggedSets: true, open: open() }).started, false);
  assert.equal(win.CairnTodaySessionLaunch.facts({ ...base, open: open({ action: "continue", started: true }) }).started, true);
});

test("the session shell carries the Discard door only when it is handed one", () => {
  const win = loadClientModule(["html-utils", "session-snapshot-client", "today-open-session-client", "today-open-session-discard-client"]);
  const meta = { fresh: false, kicker: "TODAY", dayName: "Pull", dayFocus: "", exDone: 0, exTotal: 0 };
  const withDoor = renderHtml(
    win.CairnSessionSnapshot.shellHtml("<p>list</p>", { ...meta, discardHtml: win.CairnTodayOpenSession.discardHtml(DATE, open()) }),
    { document: win.document }
  );
  assert.ok(withDoor.querySelector(".sess-body #sessDiscard"));
  const without = renderHtml(
    win.CairnSessionSnapshot.shellHtml("<p>list</p>", { ...meta, discardHtml: win.CairnTodayOpenSession.discardHtml(DATE, open({ started: true })) }),
    { document: win.document }
  );
  assert.equal(without.querySelector("#sessDiscard"), null);
});

// ---- a session row logged outside any composition (chat, MCP, the watch) ----

test("legacyOpen: unfinished logged sets with no composition read as a session to continue, never a watch-owned day", () => {
  const { S } = load();
  const today = (session, line = { title: "Lower A" }) => ({ session, strength_line: line, open_session: null });
  const read = S.legacyOpen(today({ id: 5, sets: [{ id: 1 }], finished_at: null }));
  assert.equal(read.label, "Continue Lower A");
  assert.equal(read.daily_session_id, 0, "no composition to assert: a tap sends the plain open, which adopts the row");
  assert.equal(read.started, true);
  assert.equal(read.chosen, true, "logging is the athlete's own act");
  assert.equal(S.legacyOpen(today({ id: 5, sets: [{ id: 1 }], finished_at: null }, null)).label, "Continue your session");
  assert.equal(S.legacyOpen(today({ id: 5, sets: [] })), null, "nothing logged");
  assert.equal(S.legacyOpen(today({ id: 5, sets: [{ id: 1 }], finished_at: "2026-11-12 10:00:00" })), null, "finished");
  assert.equal(S.legacyOpen(today({ id: 5, sets: [{ id: 1 }], garmin: { id: 3 } })), null, "the watch's day is inbound-only");
  assert.equal(S.legacyOpen(today(null)), null);
  // It is never trusted as an asserted id.
  const second = load();
  second.store.set(second.S.key(DATE), read);
  second.store.set(`today:aggregate:${DATE}`, {});
  assert.equal(second.S.cached(DATE), null);
});

// ---- a session logged without a card is adopted by the plain prepare ----

const legacyRow = (extra = {}) => ({ id: 9, date: DATE, title: "Press", sets: [{ exercise: "Overhead Press" }], ...extra });

test("an open row with sets and no composition opens through the plain prepare, which adopts it", async () => {
  const { S } = load();
  assert.equal(S.legacyAdoptable(legacyRow()), true);
  for (const closed of [{ finished_at: "2026-11-12T15:00:00Z" }, { garmin: {} }, { daily_session: { id: 3 } }, { sets: [] }]) {
    assert.equal(S.legacyAdoptable(legacyRow(closed)), false);
  }
  const { deps: d, log } = deps({
    prepare: async (body) => {
      log2.asked.push({ ...body });
      return { current: true, ok: true, value: { ...prepared(31), session: { id: 9, date: DATE, sets: [{ exercise: "Overhead Press" }] } } };
    },
  });
  const log2 = { asked: [] };
  const saved = [];
  const taken = await S.adoptLegacy(DATE, legacyRow(), d, () => saved.push("saved"));
  assert.equal(taken, true);
  assert.deepEqual(log2.asked, [{ date: DATE }], "plain prepare: no replace, no fingerprint, no id");
  assert.deepEqual(log.entered, [[DATE, 31]], "entered with the adopted composition");
  assert.deepEqual(saved, []);
});

test("an unadoptable row is left to the caller; an unreachable Cairn opens the saved log as it was", async () => {
  const { S } = load();
  const { deps: d } = deps();
  assert.equal(await S.adoptLegacy(DATE, legacyRow({ finished_at: "x" }), d, () => {}), null);
  const saved = [];
  const { deps: down, log } = deps({ prepare: async () => ({ current: true, ok: false, error: new Error("offline") }) });
  assert.equal(await S.adoptLegacy(DATE, legacyRow(), down, () => saved.push("saved")), true);
  assert.deepEqual(saved, ["saved"]);
  assert.deepEqual(log.entered, [], "nothing was learned, nothing is entered by the prepare");
});
