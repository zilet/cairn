import assert from "node:assert/strict";
import test from "node:test";
import { readToday, recordDayReadSuggestion } from "../dist/domain/brain/day-read-use-case.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

const countDayReads = (date) =>
  db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind='day_read' AND date=?`).get(date).n;

test("readToday serves cached canonical Brief with context and records it once", async () => {
  resetTables("day_reads", "suggestions", "plan_days", "plan_items", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Train today.",
    why: "You're recovered and due.",
    focus: "Lower body",
    est_minutes: 60,
    signals: { readiness: "steady" },
    source: "deterministic",
    override: null,
  });

  const first = await readToday({ date, recordOutcome: true });
  const second = await readToday({ date, recordOutcome: true });

  assert.equal(first.cached, true);
  assert.equal(first.kind, "train");
  assert.equal(first.forward, null);
  assert.ok(first.arc === null || typeof first.arc === "string");
  assert.equal(typeof first.agent_status, "string");
  assert.deepEqual(second.signals, { readiness: "steady" });
  assert.equal(countDayReads(date), 1);
});

test("recordDayReadSuggestion dedupes canonical reads but keeps override reads distinct", () => {
  resetTables("suggestions");
  const date = localDaysAgo(0);

  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  assert.equal(countDayReads(date), 1);

  recordDayReadSuggestion(date, { kind: "easy", focus: null, est_minutes: 25 }, "rough night");
  recordDayReadSuggestion(date, { kind: "easy", focus: null, est_minutes: 25 }, "short on time");
  assert.equal(countDayReads(date), 3);
});
