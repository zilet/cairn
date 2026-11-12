// v2 wave 7, "Today is Home": any day that is not today is a read-only destination.
//
// GET /api/day-record (get_day_record) composes a PAST day's record — the session, its
// runs and rides, the food summary, a weigh-in, the day read that stood — and a FUTURE
// day's preview — the planned lift, the planned run, what is already known — from reads
// that already own those facts. Absent is absent, never low; nothing is a score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo, seedIntake, seedTrainingDay, seedWeight } from "./_seed.js";
import { dayRecord, dayRecordDate } from "../dist/domain/today/day-record.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { seedDemo } from "../dist/demoSeed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { currentAgentHealth, recordAgentRun } from "../dist/repo/agent-telemetry.js";
import { todayRouter } from "../dist/routes/today.js";
import { registerDailyDriverTools } from "../dist/surfaces/mcp/daily-driver.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";

function assertNoScore(record) {
  assert.doesNotMatch(JSON.stringify(record), /"(?:score|grade|percent|percentile|impact_score)"/i);
  assert.equal(violatesReadingGrammar(record.line), null, `line "${record.line}"`);
}

test("a past day reads back its record: the session, a run, the food, a weigh-in", () => {
  const date = localDaysAgo(2);
  seedTrainingDay(date);
  repo.addActivity({ type: "run", date, distance_km: 6.2, duration_min: 35, source: "manual" });
  // Two meals with stated times across the day: the day reads complete.
  seedIntake(2, 900, { protein_g: 60, carbs_g: 90, fat_g: 25, summary: "Oats & eggs" }, { eatenAt: "08:00" });
  seedIntake(2, 1100, { protein_g: 70, carbs_g: 110, fat_g: 35, summary: "Chicken & rice" }, { eatenAt: "19:00" });
  seedWeight(date, 184.6);

  const record = dayRecord(date);
  assert.equal(record.relation, "past");
  assert.equal(record.today, localDateISO());
  assert.ok(record.session, "the session is on the record");
  assert.equal(record.session.sets, 4);
  assert.deepEqual(
    record.session.movements.map((m) => [m.name, m.sets, m.best]),
    [["Test Squat", 4, "185 × 5"]]
  );
  assert.equal(record.activities.length, 1);
  assert.equal(record.activities[0].run, true);
  assert.equal(record.activities[0].distance_km, 6.2);
  assert.equal(record.intake.entries, 2);
  assert.equal(record.intake.kcal, 2000);
  assert.equal(record.intake.protein_g, 130);
  assert.deepEqual(
    record.intake.meals.map((m) => m.summary),
    ["Oats & eggs", "Chicken & rice"]
  );
  assert.equal(record.weight_lb, 184.6);
  assert.match(record.line, /, and a run\.$/);
  // A past day has no plan half.
  assert.equal(record.lift, null);
  assert.equal(record.run, null);
  assert.equal(record.rest, false);
  assertNoScore(record);
});

test("a past day with nothing logged says so, and its intake is absent, never low", () => {
  const record = dayRecord(localDaysAgo(3));
  assert.equal(record.relation, "past");
  assert.equal(record.session, null);
  assert.deepEqual(record.activities, []);
  assert.equal(record.intake, null, "no food logged is unknown, not zero");
  assert.equal(record.line, "Nothing was logged this day.");
  assertNoScore(record);
});

test("a partial food day never speaks a sum an entry did not carry", () => {
  const date = localDaysAgo(1);
  seedIntake(1, 600, { summary: "Toast" }, { eatenAt: "08:00" });
  // A second meal with no protein estimate: the protein sum is not known.
  seedIntake(1, 500, { protein_g: 30, summary: "Wrap" });
  const record = dayRecord(date);
  assert.equal(record.intake.kcal, 1100);
  assert.equal(record.intake.protein_g, null);
  // Only a STATED time is shown; the unstated one never wears its write time.
  assert.equal(record.intake.meals.find((m) => m.summary === "Wrap").logged_at, null);
});

test("a rest day with food or a weigh-in logged never says nothing was logged", () => {
  const date = localDaysAgo(1);
  seedIntake(1, 900, { protein_g: 60, summary: "Oats & eggs" }, { eatenAt: "08:00" });
  seedIntake(1, 700, { protein_g: 50, summary: "Salmon bowl" }, { eatenAt: "19:00" });
  const fed = dayRecord(date);
  assert.equal(fed.session, null);
  assert.deepEqual(fed.activities, []);
  assert.equal(fed.intake.entries, 2);
  assert.doesNotMatch(fed.line, /nothing/i, `line "${fed.line}"`);
  assert.equal(fed.line, "A rest day.");
  assertNoScore(fed);

  const weighed = localDaysAgo(4);
  seedWeight(weighed, 183.2);
  const record = dayRecord(weighed);
  assert.equal(record.intake, null);
  assert.equal(record.weight_lb, 183.2);
  assert.equal(record.line, "A rest day.");
});

test("the day read that stood is on a past day's record", () => {
  const date = localDaysAgo(2);
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, signals, source, computed_at) VALUES (?, 'train', ?, ?, '{}', 'deterministic', datetime('now'))`
  ).run(date, "A strong Pull day.", "Sleep held and the back is due.");
  const record = dayRecord(date);
  assert.deepEqual(record.read, {
    kind: "train",
    headline: "A strong Pull day.",
    why: "Sleep held and the back is due.",
  });
});

test("a future day previews the plan strip's own week: the planned lift and run", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-22T12:00:00") });
  seedDemo();
  const today = localDateISO();
  const week = planWeek(today);
  const ahead = week.days.filter((d) => d.date && d.date > today);
  assert.ok(ahead.length, "the demo week has days ahead of today");
  for (const day of ahead) {
    const record = dayRecord(day.date);
    assert.equal(record.relation, "future");
    assert.equal(record.session, null, "a future day has no log half");
    assert.equal(record.intake, null);
    const lift = day.plan_day && day.plan_day.role === "strength" ? day.plan_day.name : null;
    assert.equal(record.lift?.title ?? null, lift, `${day.date}: the lift the strip shows`);
    assert.equal(record.run?.km ?? null, day.run ? day.run.km : null, `${day.date}: the run the strip shows`);
    assert.equal(record.rest, !record.lift && !record.run);
    assert.ok(record.line.endsWith("."), record.line);
    assert.doesNotMatch(record.line, /, and (?!a |an )/, "a run is spoken with its article");
    assert.doesNotMatch(record.line, /^A [AEIOU]/, 'a vowel-led lift takes "An"');
    assertNoScore(record);
  }
});

test('a vowel-led lift name takes its article: "An Upper A day."', (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-22T12:00:00") });
  seedDemo();
  db.prepare("UPDATE plan_days SET name = 'Upper A'").run();
  const today = localDateISO();
  const liftOnly = planWeek(today).days.filter(
    (d) => d.date && d.date > today && d.plan_day?.role === "strength" && !d.run
  );
  assert.ok(liftOnly.length, "the demo week has a lift-only day ahead");
  for (const day of liftOnly) assert.equal(dayRecord(day.date).line, "An Upper A day.");
});

test("dayRecordDate takes only a real calendar day", () => {
  assert.equal(dayRecordDate("2026-09-28"), "2026-09-28");
  assert.equal(dayRecordDate("2026-02-30"), null);
  assert.equal(dayRecordDate("yesterday"), null);
  assert.equal(dayRecordDate(undefined), null);
});

test("GET /api/day-record and get_day_record answer the same record; a bad date is a 400", async () => {
  const date = localDaysAgo(2);
  seedTrainingDay(date);
  let handler = null;
  for (const layer of todayRouter.stack) {
    if (layer.route?.path === "/day-record" && layer.route.methods.get) handler = layer.route.stack.at(-1).handle;
  }
  assert.ok(handler, "GET /day-record is routed");
  const rest = await new Promise((resolve) => handler({ query: { date } }, { json: resolve }));
  const tools = new Map();
  registerDailyDriverTools({ tool: (n, _d, _s, h) => tools.set(n, h) });
  const mcp = JSON.parse((await tools.get("get_day_record")({ date })).content[0].text);
  assert.deepEqual(mcp, rest);
  assert.equal(rest.relation, "past");

  let status = 200;
  const bad = await new Promise((resolve) =>
    handler({ query: { date: "nope" } }, { status: (s) => ((status = s), { json: resolve }), json: resolve })
  );
  assert.equal(status, 400);
  assert.match(bad.error, /date/);
});

test("where the agent layer stands NOW: the newest attempt decides, and a later success clears a failure", () => {
  db.prepare(`DELETE FROM agent_runs`).run();
  assert.equal(currentAgentHealth().state, "idle");
  const run = (ok, error_class = null) =>
    recordAgentRun({ op: "day_read", agent: "claude", ok, parsed: ok, latency_ms: 10, tried_json: false, error_class });
  run(true);
  assert.equal(currentAgentHealth().state, "ok");
  run(false, "auth_required");
  run(false, "auth_required");
  const failing = currentAgentHealth();
  assert.equal(failing.state, "failing");
  assert.ok(failing.failing_since, "it names when the trouble began");
  assert.ok(failing.last_ok_at, "and the last good run");
  run(true);
  const healed = currentAgentHealth();
  assert.equal(healed.state, "ok", "one good run clears it — nothing to dismiss");
  assert.equal(healed.failing_since, null);
});

test("a failed 'Say hello' probe is telemetry, never the agent layer's health", () => {
  db.prepare(`DELETE FROM agent_runs`).run();
  const run = (op, ok, error_class = null) =>
    recordAgentRun({ op, agent: "codex", ok, parsed: ok, latency_ms: 10, tried_json: false, error_class });
  run("agent_hello", false, "auth_required");
  assert.equal(currentAgentHealth().state, "idle", "a hello alone is no coaching attempt");
  run("day_read", true);
  run("agent_hello", false, "auth_required");
  const health = currentAgentHealth();
  assert.equal(health.state, "ok", "a new CLI's failed hello does not mark the layer failing");
  assert.equal(health.error_class, null);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE op = 'agent_hello'`).get().n,
    2,
    "the hello rows stay for the stats"
  );
  run("insight", false, "timeout");
  run("agent_hello", true);
  const failing = currentAgentHealth();
  assert.equal(failing.state, "failing", "and a hello that worked does not mask a coaching failure");
  assert.equal(failing.error_class, "timeout");
});
