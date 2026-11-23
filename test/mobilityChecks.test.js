// Mobility self-checks: a few short field tests the athlete repeats, read only against
// their own earlier readings (src/repo/mobility-checks.ts). Logging (per side), the latest
// per check, a direction that needs a reading three weeks older and clears the check's
// smallest meaningful change, the lower-is-better words, the invite states, practice days
// off logged mobility sets, the athlete's length units, REST and MCP round trips, and the
// chat action landing one row per side.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";
import {
  deleteMobilityCheck,
  listMobilityChecks,
  logMobilityCheck,
  MOBILITY_CHECKS,
  MOBILITY_FIRST_INVITE,
  mobilityPracticeDays,
  mobilityStanding,
  resolveMobilityCheckKey,
} from "../dist/repo/mobility-checks.js";
import { normalizeChatActions, renderChatActionPromptProse, CHAT_ACTION_TYPES } from "../dist/chatActions.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { bodyMetricsRouter } from "../dist/routes/body-metrics.js";
import { registerBodyMetricsTools } from "../dist/surfaces/mcp/body-metrics.js";

const today = () => localDaysAgo(0);

beforeEach(() => {
  resetTables("mobility_checks", "logged_sets", "sessions");
  repo.setSettings({ run_units: "km" });
});

function rowCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM mobility_checks`).get().n;
}

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", bodyMetricsRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

function mcpTools() {
  const tools = new Map();
  registerBodyMetricsTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  return async (name, args) => JSON.parse((await tools.get(name)(args)).content[0].text);
}

test("the catalog is one table: key, label, unit, side rule, direction, how-to, smallest change", () => {
  assert.deepEqual(
    MOBILITY_CHECKS.map((c) => c.key),
    ["ankle_knee_to_wall", "toe_touch", "shoulder_back_scratch", "deep_squat_hold"]
  );
  for (const c of MOBILITY_CHECKS) {
    assert.ok(c.how_to.length > 40, `${c.key} has a how-to`);
    assert.ok(c.smallest_change > 0, `${c.key} has a smallest meaningful change`);
    assert.ok(c.better === "more" || c.better === "less");
  }
  assert.equal(MOBILITY_CHECKS.find((c) => c.key === "toe_touch").better, "less");
  assert.equal(resolveMobilityCheckKey("knee to wall"), "ankle_knee_to_wall");
  assert.equal(resolveMobilityCheckKey("Back scratch"), "shoulder_back_scratch");
  assert.equal(resolveMobilityCheckKey("hip 90/90"), null);
});

test("an empty record reads unavailable and carries the first invite", () => {
  const read = mobilityStanding(today());
  assert.deepEqual(read, { available: false, checks: [], practice_days_4wk: 0, invite: MOBILITY_FIRST_INVITE });
  assert.match(read.invite, /ankles, hamstrings, shoulders, a deep squat/);
});

test("a per-side check needs a side; each side is its own row", () => {
  const missing = logMobilityCheck({ check: "ankle_knee_to_wall", value: 9 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /left or right/);
  assert.equal(rowCount(), 0);

  const left = logMobilityCheck({ check: "knee to wall", side: "L", value: 9 });
  const right = logMobilityCheck({ check: "ankle_knee_to_wall", side: "right", value: 11, unit: "cm" });
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(left.check.side, "left");
  assert.equal(left.check.label, "Ankle, left");
  assert.equal(left.check.value_text, "9 cm");
  assert.equal(right.check.unit, "cm");

  // A side on a two-sided-at-once check is ignored, not stored.
  const toe = logMobilityCheck({ check: "toe_touch", side: "left", value: 4 });
  assert.equal(toe.check.side, null);

  const read = mobilityStanding(today());
  assert.equal(read.available, true);
  assert.deepEqual(
    read.checks.map((c) => c.id),
    ["ankle_knee_to_wall:left", "ankle_knee_to_wall:right", "toe_touch"]
  );
  assert.equal(read.invite, null);
});

test("refused readings: unknown check, no number, out of bounds, wrong unit, future date", () => {
  assert.equal(logMobilityCheck({ check: "hip_90_90", value: 3 }).ok, false);
  assert.equal(logMobilityCheck({ check: "toe_touch" }).ok, false);
  assert.equal(logMobilityCheck({ check: "ankle_knee_to_wall", side: "left", value: 90 }).ok, false);
  assert.equal(logMobilityCheck({ check: "toe_touch", value: 5, unit: "s" }).ok, false);
  assert.equal(logMobilityCheck({ check: "toe_touch", value: 5, date: "2999-01-01" }).ok, false);
  assert.equal(rowCount(), 0);
});

test("the latest reading per check and side leads; one reading has no direction", () => {
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "left", value: 8, date: localDaysAgo(10) });
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "left", value: 12, date: localDaysAgo(2) });
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "right", value: 10, date: localDaysAgo(2) });
  const read = mobilityStanding(today());
  const left = read.checks.find((c) => c.id === "ankle_knee_to_wall:left");
  const right = read.checks.find((c) => c.id === "ankle_knee_to_wall:right");
  assert.equal(left.now_text, "12 cm");
  assert.equal(left.date, localDaysAgo(2));
  // Eight days apart is noise, not a trend: no direction even though it moved 4 cm.
  assert.equal(left.direction, null);
  assert.equal(left.move_words, null);
  assert.equal(right.direction, null);
});

test("a direction needs a reading three weeks older and must clear the smallest meaningful change", () => {
  // Ankle: smallest change 1.5 cm. A 1 cm move over a month holds.
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "left", value: 9, date: localDaysAgo(35) });
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "left", value: 10, date: localDaysAgo(1) });
  // A 2 cm move over a month reads better, against the FIRST reading.
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "right", value: 8, date: localDaysAgo(40) });
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "right", value: 9, date: localDaysAgo(20) });
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "right", value: 10, date: localDaysAgo(1) });
  const read = mobilityStanding(today());
  const left = read.checks.find((c) => c.id === "ankle_knee_to_wall:left");
  const right = read.checks.find((c) => c.id === "ankle_knee_to_wall:right");
  assert.equal(left.direction, "holding");
  assert.match(left.move_words, /^about the same as [A-Z][a-z]{2} \d{1,2}/);
  assert.equal(right.direction, "better");
  assert.match(right.move_words, /^2 cm more than [A-Z][a-z]{2} \d{1,2}/);

  // Less range reads worse, said plainly.
  logMobilityCheck({ check: "deep_squat_hold", value: 45, date: localDaysAgo(30) });
  logMobilityCheck({ check: "deep_squat_hold", value: 20, date: localDaysAgo(1) });
  const squat = mobilityStanding(today()).checks.find((c) => c.id === "deep_squat_hold");
  assert.equal(squat.direction, "worse");
  assert.equal(squat.now_text, "20 s, heels down");
  assert.match(squat.move_words, /^25 s shorter than /);
});

test("lower is more range on the toe touch, and past the floor is negative", () => {
  logMobilityCheck({ check: "toe_touch", value: 12, date: localDaysAgo(30) });
  logMobilityCheck({ check: "toe_touch", value: -3, date: localDaysAgo(1) });
  const toe = mobilityStanding(today()).checks.find((c) => c.id === "toe_touch");
  assert.equal(toe.direction, "better");
  assert.equal(toe.now_text, "3 cm past the floor");
  assert.match(toe.move_words, /^15 cm more reach than /);

  resetTables("mobility_checks");
  logMobilityCheck({ check: "toe_touch", value: 2, date: localDaysAgo(30) });
  logMobilityCheck({ check: "toe_touch", value: 8, date: localDaysAgo(1) });
  const worse = mobilityStanding(today()).checks.find((c) => c.id === "toe_touch");
  assert.equal(worse.direction, "worse");
  assert.equal(worse.now_text, "8 cm from the floor");
  assert.match(worse.move_words, /^6 cm less reach than /);
});

test("back scratch words: a gap is minus, an overlap plus; the untimed squat reads reached", () => {
  assert.equal(logMobilityCheck({ check: "back_scratch", side: "right", value: -5 }).check.value_text, "5 cm gap");
  assert.equal(logMobilityCheck({ check: "back_scratch", side: "left", value: 0 }).check.value_text, "Fingertips touch");
  assert.equal(logMobilityCheck({ check: "back_scratch", side: "left", value: 3 }).check.value_text, "3 cm overlap");
  assert.equal(logMobilityCheck({ check: "deep_squat", reached: true }).check.value_text, "Heels down, untimed");
  assert.equal(logMobilityCheck({ check: "deep_squat", reached: false }).check.value_text, "Heels lift");

  resetTables("mobility_checks");
  logMobilityCheck({ check: "deep_squat", reached: false, date: localDaysAgo(28) });
  logMobilityCheck({ check: "deep_squat", reached: true, date: localDaysAgo(0) });
  const squat = mobilityStanding(today()).checks[0];
  assert.equal(squat.direction, "better");
  assert.match(squat.move_words, /^heels down now, not on /);
});

test("invite: none, then an offer to repeat once the latest check is over eight weeks old", () => {
  logMobilityCheck({ check: "toe_touch", value: 6, date: localDaysAgo(70) });
  const stale = mobilityStanding(today());
  assert.equal(stale.available, true);
  assert.match(stale.invite, /^Your last mobility checks were on [A-Z][a-z]{2} \d{1,2}/);
  assert.match(stale.invite, /Tell the coach when you have ten minutes\.$/);
  assert.doesNotMatch(stale.invite, /\b(?:must|should)\b/);

  logMobilityCheck({ check: "deep_squat_hold", value: 30, date: localDaysAgo(3) });
  assert.equal(mobilityStanding(today()).invite, null);
});

test("practice days count distinct days with a logged mobility set in the last four weeks", () => {
  repo.upsertExercise({ name: "Couch Stretch", muscle_group: "mobility", mode: "timed" });
  repo.upsertExercise({ name: "Test Squat", muscle_group: "legs" });
  repo.logSetByName({ date: localDaysAgo(2), exercise: "Couch Stretch", duration_sec: 60, exercise_mode: "timed" });
  repo.logSetByName({ date: localDaysAgo(2), exercise: "Couch Stretch", duration_sec: 60, exercise_mode: "timed" });
  repo.logSetByName({ date: localDaysAgo(9), exercise: "Ankle Rocker", reps: 10 });
  repo.logSetByName({ date: localDaysAgo(40), exercise: "Couch Stretch", duration_sec: 60, exercise_mode: "timed" });
  repo.logSetByName({ date: localDaysAgo(5), exercise: "Test Squat", weight: 185, reps: 5 });
  assert.equal(mobilityPracticeDays(today()), 2);
  assert.equal(mobilityStanding(today()).practice_days_4wk, 2);
});

test("lengths are said in inches when the athlete reads distances in miles (stored in cm)", () => {
  repo.setSettings({ run_units: "mi" });
  const row = logMobilityCheck({ check: "ankle_knee_to_wall", side: "left", value: 4, unit: "in" });
  assert.equal(row.ok, true);
  assert.equal(row.check.value, 10.2);
  assert.equal(row.check.unit, "cm");
  assert.equal(row.check.value_text, "4 in");
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "right", value: 9, date: localDaysAgo(30) });
  logMobilityCheck({ check: "ankle_knee_to_wall", side: "right", value: 14, date: localDaysAgo(0) });
  const right = mobilityStanding(today()).checks.find((c) => c.id === "ankle_knee_to_wall:right");
  assert.equal(right.now_text, "5.5 in");
  assert.match(right.move_words, /^2 in more than /);
});

test("list and delete", () => {
  const a = logMobilityCheck({ check: "toe_touch", value: 6, date: localDaysAgo(3) });
  logMobilityCheck({ check: "deep_squat_hold", value: 40, date: localDaysAgo(1) });
  const all = listMobilityChecks();
  assert.deepEqual(
    all.checks.map((c) => c.check_key),
    ["deep_squat_hold", "toe_touch"]
  );
  assert.equal(all.catalog.length, MOBILITY_CHECKS.length);
  assert.equal(listMobilityChecks({ check_key: "toe touch" }).checks.length, 1);
  assert.deepEqual(deleteMobilityCheck(a.check.id), { ok: true, id: a.check.id });
  assert.equal(deleteMobilityCheck(a.check.id).code, "not_found");
  assert.equal(deleteMobilityCheck(0).code, "invalid_id");
  assert.equal(rowCount(), 1);
});

test("REST round trip: POST, GET, standing, DELETE", async () => {
  await withServer(async (base) => {
    const post = await fetch(`${base}/api/mobility-checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ check: "toe_touch", value: 7 }),
    });
    assert.equal(post.status, 200);
    const posted = await post.json();
    assert.equal(posted.ok, true);
    assert.equal(posted.check.source, "user");

    const bad = await fetch(`${base}/api/mobility-checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ check: "ankle_knee_to_wall", value: 7 }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).ok, false);

    const list = await (await fetch(`${base}/api/mobility-checks?check=toe_touch`)).json();
    assert.equal(list.checks.length, 1);
    assert.equal(list.checks[0].value_text, "7 cm from the floor");

    const standing = await (await fetch(`${base}/api/mobility-standing`)).json();
    assert.equal(standing.available, true);
    assert.equal(standing.checks[0].id, "toe_touch");

    const del = await (await fetch(`${base}/api/mobility-checks/${posted.check.id}`, { method: "DELETE" })).json();
    assert.deepEqual(del, { ok: true, id: posted.check.id });
    const after = await (await fetch(`${base}/api/mobility-standing`)).json();
    assert.equal(after.available, false);
  });
});

test("MCP tools wrap the same repo functions", async () => {
  const call = mcpTools();
  const logged = await call("log_mobility_check", { check: "shoulder_back_scratch", side: "left", value: -4 });
  assert.equal(logged.ok, true);
  assert.equal(logged.check.source, "chat");
  const listed = await call("list_mobility_checks", {});
  assert.equal(listed.checks.length, 1);
  const standing = await call("get_mobility_standing", {});
  assert.equal(standing.checks[0].now_text, "4 cm gap");
  assert.deepEqual(await call("delete_mobility_check", { id: logged.check.id }), { ok: true, id: logged.check.id });
});

test("chat: one action per side normalizes to two; the catalog's how-to rides the action's guidance", () => {
  assert.ok(CHAT_ACTION_TYPES.includes("log_mobility_check"));
  const actions = normalizeChatActions([
    { type: "log_mobility_check", check: "knee_to_wall", side: "left", value: 9, unit: "cm" },
    { type: "log_mobility_check", check: "ankle_knee_to_wall", side: "right", value: "11", unit: "cm" },
    // Dropped at the boundary: a per-side check with no side, and a reading with no number.
    { type: "log_mobility_check", check: "ankle_knee_to_wall", value: 10 },
    { type: "log_mobility_check", check: "toe_touch" },
  ]);
  assert.equal(actions.length, 2);
  assert.deepEqual(
    actions.map((a) => [a.check_key, a.side, a.value]),
    [
      ["ankle_knee_to_wall", "left", 9],
      ["ankle_knee_to_wall", "right", 11],
    ]
  );

  const prose = renderChatActionPromptProse();
  assert.match(prose, /log_mobility_check records one mobility self-check reading/);
  for (const c of MOBILITY_CHECKS) assert.ok(prose.includes(c.how_to), `${c.key} how-to is in the prompt`);
});

// Needs the one `case "log_mobility_check"` in chatTurns.ts applyChatActions.
test("chat: applyChatActions lands one row per side, sourced from chat", () => {
  const { applied } = applyChatActions(
    {
      actions: [
        { type: "log_mobility_check", check: "knee_to_wall", side: "left", value: 9, unit: "cm" },
        { type: "log_mobility_check", check: "knee_to_wall", side: "right", value: 11, unit: "cm" },
      ],
    },
    { agent: "stub", message: "knee to wall is 9 cm left, 11 right" }
  );
  assert.deepEqual(
    applied.map((a) => [a.type, a.result?.ok]),
    [
      ["log_mobility_check", true],
      ["log_mobility_check", true],
    ]
  );
  const rows = db.prepare(`SELECT side, value, source FROM mobility_checks ORDER BY side`).all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { side: "left", value: 9, source: "chat" },
      { side: "right", value: 11, source: "chat" },
    ]
  );
});
