// openSession.test.js — today's open session is ONE server-owned fact: the Today
// aggregate's `open_session`, the strength line, the conflicts that carry the owner,
// and the discard of an accidental empty session all read the same derivation.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../dist/mcp.js";
import { dayCoachRouter } from "../dist/routes/day-coach.js";
import { openSessionOn } from "../dist/repo/open-session.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { todayAggregate } from "../dist/domain/today/today-surface.js";
import { dayRecord } from "../dist/domain/today/day-record.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { todayStones } from "../dist/domain/today/today-stones.js";
import { previewAdaptiveDailySessionUseCase } from "../dist/domain/training/adaptive-session-use-case.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { db, localDaysAgo, repo } from "./_seed.js";

const TODAY = localDaysAgo(0);
// The PWA's empty "Open session" door (today-screen.ts openSession): a zero-item override.
const OPEN_SESSION = {
  name: "Open session",
  focus: "Choose as you go",
  why: "A blank session for whatever feels useful today.",
  est_minutes: null,
  items: [],
};
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow }));

beforeEach(() => {
  repo.savePlanDay(1, "Push", "Shoulders, chest & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  repo.savePlanDay(2, "Pull", "Back, biceps & rear delts", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
  repo.setProfile({ strength_schedule: { days: EVERY_DAY, source: "athlete", updated_at: TODAY } });
});

function read(kind) {
  return {
    kind,
    headline: "x",
    why: "y",
    focus: null,
    est_minutes: null,
    signals: {},
    source: "deterministic",
    override: null,
  };
}

function chosenCard(name = "Upper Body & Core") {
  return {
    name,
    why: "The athlete wrote this one.",
    items: [{ exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 12 }],
  };
}

function routerRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const request = { method, url, originalUrl: url, body, query: {}, headers: {} };
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, body: value });
        return this;
      },
    };
    dayCoachRouter.handle(request, response, (error) => reject(error ?? new Error(`unhandled ${method} ${url}`)));
  });
}

async function mcpHarness() {
  const server = buildMcpServer();
  const client = new Client({ name: "open-session-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const toolJson = (result) => JSON.parse(result.content[0].text);
const sessionCount = (date) => db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE date = ?`).get(date).n;

test("(a) an empty Open session override is open, chosen, and offered as Start", () => {
  const prepared = repo.prepareDailySession({ date: TODAY, source: "athlete_override", session: OPEN_SESSION });
  const open = todayAggregate(TODAY).open_session;
  assert.deepEqual(open, {
    daily_session_id: prepared.daily_session.id,
    session_id: Number(prepared.session_id),
    source: "athlete_override",
    plan_day_id: open.plan_day_id,
    title: "Open session",
    set_count: 0,
    started: false,
    chosen: true,
    action: "start",
    label: "Start your session",
  });
  assert.deepEqual(openSessionOn(TODAY), open, "the aggregate carries the one derivation");
});

test("(b) a train-anyway adaptive session with no sets stays on Today under a rest read", () => {
  repo.saveDayRead(TODAY, read("rest"));
  const prepared = repo.prepareDailySession({ date: TODAY, source: "adaptive_plan", train_anyway: true });
  assert.equal(prepared.daily_session.provenance.choice, "training_by_choice");
  const open = openSessionOn(TODAY);
  assert.equal(open.source, "adaptive_plan");
  assert.equal(open.chosen, true);
  assert.equal(open.started, false);
  assert.equal(open.set_count, 0);
  assert.equal(open.action, "start");
  assert.ok(open.title === "Push" || open.title === "Pull", open.title);
  assert.equal(open.label, `Start ${open.title}`);

  // The strength line names that session — never "rest suggested" beside a chosen one.
  const line = todayStrengthLine(TODAY);
  assert.equal(line.title, open.title);
  assert.equal(line.state, "not_started");
  assert.equal(line.suggestion, null);
  assert.equal(line.suggestion_label, null);
  assert.ok(line.caveat, "the read survives as a caveat");
  assert.ok(line.caveat.includes(open.title), line.caveat);
  assert.match(line.caveat, /\bchose\b|your call/);
  assert.doesNotMatch(line.caveat, /rest suggested|still yours if you want it/);
  assert.ok(!violatesReadingGrammar(line.caveat), line.caveat);

  // Every surface consumes the line's field: the week strip's today cell and the day view.
  const week = planWeek(TODAY);
  const todayCell = week.days.find((cell) => cell.status === "today" && cell.date === TODAY);
  assert.ok(!todayCell?.suggestion, JSON.stringify(todayCell?.suggestion));
  const detail = dayDetail(TODAY, { today: TODAY });
  assert.ok(!detail?.lift?.suggestion, JSON.stringify(detail?.lift?.suggestion));
  const stone = todayStones(TODAY).stones.find((s) => s.key === "strength");
  assert.equal(stone.tone, "ok", JSON.stringify(stone));
  assert.equal(stone.line, line.text, "the stone prints the line, not the rest caveat");

  // Without the athlete's choice the same read stays a suggestion.
  db.prepare(`DELETE FROM daily_session_compositions`).run();
  assert.equal(todayStrengthLine(TODAY).suggestion, "rest");
});

test("a session chosen on the calendar's rest day names the session, not the rest day", () => {
  const otherDow = (new Date(`${TODAY}T12:00:00Z`).getUTCDay() + 3) % 7;
  repo.setProfile({ strength_schedule: { days: [{ dow: otherDow }], source: "athlete", updated_at: TODAY } });
  assert.equal(todayStrengthLine(TODAY).state, "rest_day", "precondition: the calendar reads rest");
  repo.saveDayRead(TODAY, read("rest"));
  repo.prepareDailySession({ date: TODAY, source: "manual_plan", day_number: 2 });
  const open = openSessionOn(TODAY);
  assert.equal(open.chosen, true);
  assert.equal(open.label, "Start Pull");
  const line = todayStrengthLine(TODAY);
  assert.equal(line.title, "Pull");
  assert.equal(line.state, "not_started");
  assert.equal(line.role, "strength");
  assert.equal(line.suggestion, null);
  assert.equal(line.text, "Pull · not started");
  const cell = planWeek(TODAY).days.find((day) => day.date === TODAY);
  assert.equal(cell?.plan_day?.name, "Pull", JSON.stringify(cell));
  assert.ok(!cell.suggestion);
});

test("(c) a started session is open, offered as Continue", () => {
  repo.prepareDailySession({ date: TODAY, source: "manual_plan", day_number: 2 });
  repo.logSetByName({ date: TODAY, exercise: "Barbell Row", weight: 115, reps: 8, day_number: 2 });
  const open = openSessionOn(TODAY);
  assert.equal(open.source, "manual_plan");
  assert.equal(open.title, "Pull");
  assert.equal(open.set_count, 1);
  assert.equal(open.started, true);
  assert.equal(open.chosen, true);
  assert.equal(open.action, "continue");
  assert.equal(open.label, "Continue Pull");
  assert.equal(todayStrengthLine(TODAY).state, "in_progress");
});

test("(d) a finished session is not open", () => {
  const prepared = repo.prepareDailySession({ date: TODAY, source: "manual_plan", day_number: 1 });
  repo.logSetByName({ date: TODAY, exercise: "Bench Press", weight: 135, reps: 5, day_number: 1 });
  repo.finishSession(Number(prepared.session_id));
  assert.equal(openSessionOn(TODAY), null);
  assert.equal(todayAggregate(TODAY).open_session, null);
  assert.equal(todayStrengthLine(TODAY).state, "logged");
});

test("a plain adaptive session the athlete only opened is open but not chosen", () => {
  repo.prepareDailySession({ date: TODAY, source: "adaptive_plan" });
  const open = openSessionOn(TODAY);
  assert.equal(open.source, "adaptive_plan");
  assert.equal(open.chosen, false);
  assert.equal(open.action, "start");
});

test("conflict bodies carry the owner on REST and MCP", async () => {
  const date = "2032-05-04";
  const created = await routerRequest("POST", "/daily-session/prepare", {
    date,
    source: "athlete_override",
    session: chosenCard(),
  });
  assert.equal(created.status, 200);
  const preview = previewAdaptiveDailySessionUseCase({ date });

  // An adaptive request never silently replaces the athlete's itemful chosen card.
  const conflict = await routerRequest("POST", "/daily-session/prepare", {
    date,
    source: "adaptive_plan",
    expected_input_fingerprint: preview.input_fingerprint,
    replace: true,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "daily_session_active_changed");
  assert.deepEqual(conflict.body.owner, {
    daily_session_id: created.body.daily_session.id,
    session_id: created.body.session.id,
    source: "athlete_override",
    title: "Upper Body & Core",
    set_count: 0,
    started: false,
  });
  const noToken = await routerRequest("POST", "/daily-session/prepare", {
    date,
    source: "adaptive_plan",
    replace: true,
  });
  assert.equal(noToken.status, 409, "the same rule holds without a preview token");
  assert.equal(noToken.body.owner.daily_session_id, created.body.daily_session.id);
  assert.equal(repo.getActiveDailySession(date).id, created.body.daily_session.id);

  repo.logSetByName({ date, exercise: "Chest-Supported Row", weight: 40, reps: 10 });
  const locked = await routerRequest("POST", "/daily-session/prepare", {
    date,
    source: "athlete_override",
    replace: true,
    session: chosenCard("Something else"),
  });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "daily_session_locked");
  assert.equal(locked.body.owner.session_id, created.body.session.id);
  assert.equal(locked.body.owner.set_count, 1);
  assert.equal(locked.body.owner.started, true);

  const { client, server } = await mcpHarness();
  try {
    const mcpLocked = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date, source: "athlete_override", replace: true, session: chosenCard("Something else") },
      })
    );
    assert.equal(mcpLocked.code, "daily_session_locked");
    assert.deepEqual(mcpLocked.owner, locked.body.owner);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an empty owner never blocks a fingerprinted replace; without replace it is the conflict", async () => {
  const date = "2032-05-05";
  const empty = repo.prepareDailySession({ date, source: "athlete_override", session: OPEN_SESSION });
  const preview = previewAdaptiveDailySessionUseCase({ date });

  const held = await routerRequest("POST", "/daily-session/prepare", {
    date,
    source: "adaptive_plan",
    expected_input_fingerprint: preview.input_fingerprint,
  });
  assert.equal(held.status, 409);
  assert.equal(held.body.code, "daily_session_active_changed");
  assert.equal(held.body.owner.daily_session_id, empty.daily_session.id);
  assert.equal(held.body.owner.started, false);

  const replaced = await routerRequest("POST", "/daily-session/prepare", {
    date,
    source: "adaptive_plan",
    expected_input_fingerprint: preview.input_fingerprint,
    replace: true,
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.daily_session.source, "adaptive_plan");
  assert.equal(replaced.body.session.id, Number(empty.session_id), "the empty session row is reused");
  assert.equal(
    db.prepare(`SELECT status FROM daily_session_compositions WHERE id = ?`).get(empty.daily_session.id).status,
    "superseded"
  );

  // The preview token still guards a stale candidate before any ownership question.
  repo.savePlanDay(1, "Push", "Changed", [{ exercise: "Bench Press", sets: 2, rep_low: 8, rep_high: 10 }]);
  repo.savePlanDay(2, "Pull", "Changed", [{ exercise: "Barbell Row", sets: 2, rep_low: 8, rep_high: 10 }]);
  const stale = await routerRequest("POST", "/daily-session/prepare", {
    date,
    source: "adaptive_plan",
    expected_input_fingerprint: preview.input_fingerprint,
    replace: true,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "daily_session_preview_stale");
});

test("discard frees the date of an empty session and refuses a started one", async () => {
  const date = "2032-05-06";
  const empty = repo.prepareDailySession({ date, source: "athlete_override", session: OPEN_SESSION });
  repo.skipExercise("Bench Press", date);

  const bad = await routerRequest("POST", "/daily-session/discard", { date });
  assert.equal(bad.status, 400);
  const stale = await routerRequest("POST", "/daily-session/discard", {
    date,
    expected_active_id: empty.daily_session.id + 99,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "daily_session_changed");
  assert.equal(stale.body.owner.daily_session_id, empty.daily_session.id);

  const discarded = await routerRequest("POST", "/daily-session/discard", {
    date,
    expected_active_id: empty.daily_session.id,
  });
  assert.equal(discarded.status, 200);
  assert.deepEqual(discarded.body, {
    ok: true,
    date,
    discarded: true,
    daily_session_id: empty.daily_session.id,
    session_id: Number(empty.session_id),
  });
  assert.equal(sessionCount(date), 0, "the zero-set session row is gone");
  assert.equal(repo.getActiveDailySession(date), null);
  assert.equal(openSessionOn(date), null);
  assert.equal(repo.getSessionByDate(date), null, "nothing resurrects the shell on the next read");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM session_skips WHERE session_id = ?`).get(empty.session_id).n, 0);

  const again = await routerRequest("POST", "/daily-session/discard", {
    date,
    expected_active_id: empty.daily_session.id,
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "daily_session_missing");

  // A fresh prepare on the freed date mints a new session.
  const fresh = repo.prepareDailySession({ date, source: "athlete_override", session: chosenCard() });
  assert.notEqual(Number(fresh.session_id), Number(empty.session_id));
  repo.logSetByName({ date, exercise: "Chest-Supported Row", weight: 40, reps: 10 });

  const { client, server } = await mcpHarness();
  try {
    const refused = toolJson(
      await client.callTool({
        name: "discard_daily_session",
        arguments: { date, expected_active_id: fresh.daily_session.id },
      })
    );
    assert.equal(refused.code, "daily_session_locked");
    assert.equal(refused.owner.started, true);
    assert.equal(refused.owner.set_count, 1);
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(sessionCount(date), 1, "logged work is never deleted");
  assert.equal(repo.getActiveDailySession(date).id, fresh.daily_session.id);
});

test("reading a past day mints no session row", () => {
  const past = localDaysAgo(3);
  assert.equal(sessionCount(past), 0);
  dayRecord(past, { today: TODAY });
  dayDetail(past, { today: TODAY });
  todayAggregate(past);
  todayStrengthLine(past);
  openSessionOn(past);
  planWeek(past);
  assert.equal(sessionCount(past), 0, "a read never creates a session");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions WHERE date = ?`).get(past).n, 0);
});
