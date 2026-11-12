// The REQUEST-SCOPED read memo (src/repo/request-memo.ts): inside one /api or /mcp
// request a pure read is computed once per (key, unchanged database) and every caller
// gets its own copy. These pin the half that keeps it honest — a memoized read must
// answer exactly what a recompute would:
//   - outside a snapshot scope nothing is memoized (the scheduler, scripts, tests);
//   - any row written on the connection retires every entry read before it;
//   - only a declared bookkeeping write (memoNeutralWrite) leaves entries standing;
//   - a value that consulted a re-entrancy guard is served only under that guard state;
//   - a caller mutating its copy never changes what the next caller reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import {
  copyDeep,
  copyFlat,
  memoKey,
  memoNeutralWrite,
  registerMemoGuard,
  requestMemo,
} from "../dist/repo/request-memo.js";
import { daysBetweenISO } from "../dist/lib/dates.js";
import { withSqliteSavepoint } from "../dist/repo/sqlite-savepoint.js";
import { resolveExerciseName } from "../dist/repo/exercise-canon.js";
import { recentWorkingWeight } from "../dist/repo/exercises.js";
import { planDayProgression } from "../dist/repo/progression.js";
import { createAgentJob, createWeekAheadAgentJob } from "../dist/repo/chat.js";
import { getProgress } from "../dist/repo/sessions.js";
import { flexibleTrainingAgenda } from "../dist/repo/flexible-training-agenda.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { estimateExpenditure } from "../dist/repo/expenditure.js";
import { recoverySessionDose } from "../dist/repo/training-read.js";
import { localDateISO } from "../dist/repo/shared.js";

function counter() {
  let n = 0;
  return {
    read: () => {
      n += 1;
      return { n, nested: { list: [1, 2] } };
    },
    get count() {
      return n;
    },
  };
}

test("outside a snapshot scope every call computes", () => {
  const c = counter();
  requestMemo("test:outside", c.read, copyDeep);
  requestMemo("test:outside", c.read, copyDeep);
  assert.equal(c.count, 2);
});

test("inside a scope a read computes once and every caller gets its own copy", () => {
  const c = counter();
  runWithBrainSnapshot(() => {
    const first = requestMemo("test:once", c.read, copyDeep);
    first.nested.list.push(99);
    first.n = -1;
    const second = requestMemo("test:once", c.read, copyDeep);
    assert.equal(c.count, 1);
    assert.deepEqual(second, { n: 1, nested: { list: [1, 2] } });
    assert.notEqual(second, first);
  });
});

test("a row written on the connection retires the entry; a neutral write does not", () => {
  const c = counter();
  runWithBrainSnapshot(() => {
    requestMemo("test:writes", c.read, copyDeep);
    db.prepare(`INSERT INTO app_state (key, value) VALUES ('request_memo_test', 'a')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    requestMemo("test:writes", c.read, copyDeep);
    assert.equal(c.count, 2, "a write must force a recompute");
    memoNeutralWrite(() => db.prepare(`UPDATE app_state SET value = 'b' WHERE key = 'request_memo_test'`).run());
    requestMemo("test:writes", c.read, copyDeep);
    assert.equal(c.count, 2, "a declared bookkeeping write leaves the entry standing");
    db.prepare(`UPDATE app_state SET value = 'c' WHERE key = 'request_memo_test'`).run();
    requestMemo("test:writes", c.read, copyDeep);
    assert.equal(c.count, 3, "an ordinary write after a neutral one still retires it");
  });
});

test("a ROLLBACK retires entries read inside the undone unit (total_changes never goes back down)", () => {
  const countRows = () => db.prepare(`SELECT count(*) AS n FROM app_state WHERE key = 'request_memo_rb'`).get().n;
  runWithBrainSnapshot(() => {
    assert.throws(() =>
      withSqliteSavepoint("memo_rollback", () => {
        db.prepare(`INSERT INTO app_state (key, value) VALUES ('request_memo_rb', 'x')`).run();
        assert.equal(requestMemo("test:rollback", countRows, copyFlat), 1, "read inside the unit sees its row");
        throw new Error("undo");
      })
    );
    assert.equal(countRows(), 0, "the row is gone");
    assert.equal(requestMemo("test:rollback", countRows, copyFlat), 0, "the memo must recompute, not serve a phantom");

    // A hand-written ROLLBACK TO (not through withSqliteSavepoint) counts too.
    db.exec("SAVEPOINT memo_raw_rb");
    db.prepare(`INSERT INTO app_state (key, value) VALUES ('request_memo_rb', 'y')`).run();
    assert.equal(requestMemo("test:rollback-raw", countRows, copyFlat), 1);
    db.exec("ROLLBACK TO memo_raw_rb");
    db.exec("RELEASE memo_raw_rb");
    assert.equal(requestMemo("test:rollback-raw", countRows, copyFlat), 0);
  });
});

test("resolveExerciseName never serves an exercise a rolled-back import created", () => {
  runWithBrainSnapshot(() => {
    let createdId = null;
    assert.throws(() =>
      withSqliteSavepoint("garmin_import_like", () => {
        createdId = repo.findOrCreateExercise("Rollback Phantom Lift", "chest").id;
        assert.equal(resolveExerciseName("Rollback Phantom Lift").exercise_id, createdId);
        throw new Error("import failed after creating the exercise");
      })
    );
    assert.ok(createdId != null);
    assert.equal(resolveExerciseName("Rollback Phantom Lift").exercise_id, null, "the deleted id is not served");
  });
});

test("recentWorkingWeight with an unkeyable argument computes rather than sharing one memo slot", () => {
  const ex = repo.findOrCreateExercise("Memo Key Bench", "chest");
  for (const [date, weight] of [
    ["2031-05-10", 100],
    ["2031-05-15", 120],
  ]) {
    const sess = repo.getOrCreateSession(date, null);
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, 5)`).run(
      sess.id,
      ex.id,
      weight
    );
  }
  runWithBrainSnapshot(() => {
    // String objects are not plain values, so memoKey refuses them; two different
    // cutoffs must not land on one "recent_working_weight:null" entry.
    assert.equal(recentWorkingWeight("Memo Key Bench", 3, new String("2031-05-12")), 100);
    assert.equal(recentWorkingWeight("Memo Key Bench", 3, new String("2031-05-20")), 120);
  });
});

test("a value that consulted a re-entrancy guard is only served under the same guard state", () => {
  let active = false;
  let reads = 0;
  registerMemoGuard(() => ({ active, reads }));
  const guarded = () => {
    reads += 1;
    return active ? "inside" : "outside";
  };
  let computes = 0;
  const read = () => {
    computes += 1;
    return guarded();
  };
  runWithBrainSnapshot(() => {
    assert.equal(requestMemo("test:guard", read, copyFlat), "outside");
    active = true;
    assert.equal(requestMemo("test:guard", read, copyFlat), "inside");
    active = false;
    assert.equal(requestMemo("test:guard", read, copyFlat), "outside");
    active = true;
    assert.equal(requestMemo("test:guard", read, copyFlat), "inside");
    assert.equal(computes, 2, "each guard state computes once");
    active = false;
    // A read that hit a guard-dependent memo is guard-dependent itself.
    let outerComputes = 0;
    const outer = () => {
      outerComputes += 1;
      return `wrapped ${requestMemo("test:guard", read, copyFlat)}`;
    };
    assert.equal(requestMemo("test:guard-outer", outer, copyFlat), "wrapped outside");
    active = true;
    assert.equal(requestMemo("test:guard-outer", outer, copyFlat), "wrapped inside");
    active = false;
    assert.equal(outerComputes, 2);
  });
});

test("copies keep shape: shared references, cycles, Maps, null-prototype rows", () => {
  const shared = { a: 1 };
  const value = { x: shared, y: shared, m: new Map([["k", { q: 1 }]]), when: new Date(5) };
  value.self = value;
  const copy = copyDeep(value);
  assert.notEqual(copy, value);
  assert.equal(copy.x, copy.y);
  assert.notEqual(copy.x, shared);
  assert.equal(copy.self, copy);
  assert.deepEqual([...copy.m], [["k", { q: 1 }]]);
  assert.notEqual(copy.m.get("k"), value.m.get("k"));
  assert.equal(copy.when.getTime(), 5);

  const row = db.prepare(`SELECT 1 AS one, 'two' AS two`).get();
  const rowCopy = copyFlat(row);
  assert.equal(Object.getPrototypeOf(rowCopy), Object.getPrototypeOf(row));
  assert.deepEqual({ ...rowCopy }, { ...row });
});

test("memoKey keeps undefined and non-finite numbers apart from null, and refuses non-plain values", () => {
  assert.notEqual(memoKey([undefined]), memoKey([null]));
  assert.notEqual(memoKey([Number.NaN]), memoKey([null]));
  assert.notEqual(memoKey({ a: undefined }), memoKey({}));
  assert.notEqual(memoKey(["u"]), memoKey([undefined]));
  assert.notEqual(memoKey(["nNaN"]), memoKey([Number.NaN]));
  assert.notEqual(memoKey(["1"]), memoKey([1]));
  assert.equal(memoKey([1, "a", { b: [true, null] }]), memoKey([1, "a", { b: [true, null] }]));
  assert.equal(memoKey(new Map()), null);
  assert.equal(memoKey({ at: new Date(0) }), null);
  assert.equal(memoKey({ f: () => 1 }), null);
});

test("daysBetweenISO's integer fast path answers exactly what the Date.parse path does", () => {
  const viaParse = (later, earlier) => {
    const l = Date.parse(`${String(later).slice(0, 10)}T00:00:00Z`);
    const e = Date.parse(`${String(earlier).slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(l) || !Number.isFinite(e)) return null;
    return Math.round((l - e) / 864e5);
  };
  const days = [];
  for (let t = Date.UTC(1899, 11, 25); t < Date.UTC(2101, 0, 10); t += 864e5 * 11) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  const odd = [
    "",
    "2024-02-29",
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-1-05",
    "2026-10-03T12:00:00Z",
    "0000-01-01",
    "9999-12-31",
    "2026/10/03",
    " 2026-10-03",
    null,
    undefined,
    20261003,
  ];
  const samples = [...days, ...odd];
  for (let i = 0; i < samples.length; i++) {
    for (const j of [0, 1, 7, 365, samples.length - 1 - i]) {
      const a = samples[i];
      const b = samples[(i + j) % samples.length];
      assert.ok(Object.is(daysBetweenISO(a, b), viaParse(a, b)), `${String(a)} vs ${String(b)}`);
    }
  }
});

function daysAgo(n) {
  return localDaysAgo(n);
}

function seedPlanAndLog() {
  repo.upsertExercise({ name: "Memo Plan Squat", muscle_group: "quads", mode: "reps" });
  const day = repo.savePlanDay(1, "Legs", "Legs", [
    { exercise: "Memo Plan Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 100 },
  ]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(daysAgo(90), day.id);
  const ex = repo.findExercise("Memo Plan Squat");
  for (const [n, weight] of [
    [14, 95],
    [7, 100],
  ]) {
    const sess = repo.getOrCreateSession(daysAgo(n), null);
    for (const setNumber of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, 8, 2)`
      ).run(sess.id, ex.id, setNumber, weight);
    }
  }
  return ex;
}

test("queueing the week-ahead refresh job leaves memoized reads standing; any other job row retires them", () => {
  const c = counter();
  runWithBrainSnapshot(() => {
    requestMemo("test:week-ahead", c.read, copyDeep);
    const { created } = createWeekAheadAgentJob({ cacheKey: `request-memo-test-${Math.random()}` });
    assert.equal(created, true);
    requestMemo("test:week-ahead", c.read, copyDeep);
    assert.equal(c.count, 1, "the queued week-ahead row is bookkeeping no memoized read consults");
    createAgentJob({ kind: "week_ahead", input: { cacheKey: "not-through-the-neutral-path" } });
    requestMemo("test:week-ahead", c.read, copyDeep);
    assert.equal(c.count, 2, "an agent_jobs row written any other way still retires the entry");
  });
});

test("planDayProgression's memo keeps the day number's type and answers what a recompute does", () => {
  seedPlanAndLog();
  const outside = planDayProgression(1);
  const nextOutside = planDayProgression(1, { forNextSession: true });
  assert.ok(outside.length > 0);
  runWithBrainSnapshot(() => {
    assert.deepEqual(planDayProgression(1), outside);
    const hit = planDayProgression(1);
    assert.deepEqual(hit, outside, "a hit is the same answer");
    hit[0].why = "mutated by a caller";
    assert.deepEqual(planDayProgression(1), outside, "and a caller's mutation never reaches the next one");
    // The day number is echoed into every row, so "1" and 1 are different questions.
    assert.equal(planDayProgression("1")[0].day_number, "1");
    assert.equal(planDayProgression(1)[0].day_number, 1);
    // A pass for the next session reads no autoregulation; it never shares the day's slot.
    assert.deepEqual(planDayProgression(1, { forNextSession: true }), nextOutside);
    assert.deepEqual(planDayProgression(1), outside);
  });
});

test("getProgress, the program state, expenditure and a session's dose read the same inside a scope", () => {
  const ex = seedPlanAndLog();
  const sessionId = repo.getOrCreateSession(daysAgo(7), null).id;
  const outside = {
    all: getProgress("Memo Plan Squat"),
    through: getProgress("Memo Plan Squat", { through: daysAgo(10) }),
    state: getProgramState(),
    exp21: estimateExpenditure(21),
    exp28: estimateExpenditure(28),
    dose: recoverySessionDose(sessionId),
  };
  runWithBrainSnapshot(() => {
    for (let pass = 0; pass < 2; pass++) {
      assert.deepEqual(getProgress("Memo Plan Squat"), outside.all);
      // `through` is part of the key: the horizon read must not answer the all-time one.
      assert.deepEqual(getProgress("Memo Plan Squat", { through: daysAgo(10) }), outside.through);
      assert.notDeepEqual(outside.all.points, outside.through.points);
      assert.deepEqual(getProgramState(), outside.state);
      assert.deepEqual(estimateExpenditure(28), outside.exp28);
      assert.deepEqual(estimateExpenditure(21), outside.exp21);
      assert.deepEqual(recoverySessionDose(sessionId), outside.dose);
    }
    // A logged set is a write: the progress read recomputes and sees it.
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 4, 110, 8)`).run(
      sessionId,
      ex.id
    );
    assert.equal(getProgress("Memo Plan Squat").points.at(-1).topWeight, 110);
  });
});

test("flexibleTrainingAgenda memoizes only its own run-plan read, never an injected one", () => {
  const date = localDateISO();
  const injected = {
    available: true,
    week_start: date,
    runs: [{ kind_label: "easy", day_number: 1, label: "Injected easy run", target_distance_km: 5 }],
  };
  runWithBrainSnapshot(() => {
    const bare = flexibleTrainingAgenda(date);
    assert.equal(flexibleTrainingAgenda(date, { runPlan: injected }).available, true);
    assert.equal(flexibleTrainingAgenda(date, { runPlan: null }).available, false);
    assert.deepEqual(flexibleTrainingAgenda(date), bare, "the bare read is not answered by an injected plan");
    assert.deepEqual(flexibleTrainingAgenda(date, {}), bare);
  });
});

test("the last-instant zoned-parts cache answers per instant and per zone", () => {
  // 22:30 UTC on Oct 3 is already Oct 4 in Belgrade and still Oct 3 in New York.
  const late = new Date(Date.UTC(2026, 9, 3, 22, 30));
  const early = new Date(Date.UTC(2026, 9, 3, 1, 0));
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(localDateISO(late, "Europe/Belgrade"), "2026-10-04");
    assert.equal(localDateISO(late, "Europe/Belgrade"), "2026-10-04");
    assert.equal(localDateISO(late, "America/New_York"), "2026-10-03");
    assert.equal(localDateISO(early, "America/New_York"), "2026-10-02");
    assert.equal(localDateISO(early, "Europe/Belgrade"), "2026-10-03");
  }
  // A Date mutated in place between two calls is a new instant, not the cached one.
  const moving = new Date(Date.UTC(2026, 9, 3, 12, 0));
  assert.equal(localDateISO(moving, "Europe/Belgrade"), "2026-10-03");
  moving.setUTCDate(10);
  assert.equal(localDateISO(moving, "Europe/Belgrade"), "2026-10-10");
});
