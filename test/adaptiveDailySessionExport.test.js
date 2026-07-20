import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { repo } from "./_seed.js";

function session(name, reps) {
  return {
    name,
    why: "Export-history fixture.",
    items: [{ exercise: "Export Squat", sets: 3, rep_low: reps, rep_high: reps }],
  };
}

test("JSON export and SQLite snapshot preserve active and superseded daily-session history", () => {
  const date = "2032-03-06";
  const first = repo.prepareDailySession({
    date,
    source: "athlete_override",
    session: session("First version", 5),
  });
  const second = repo.prepareDailySession({
    date,
    source: "athlete_override",
    replace: true,
    session: session("Second version", 8),
  });

  const exported = repo.exportAll().daily_session_compositions.filter((row) => row.date === date);
  assert.deepEqual(
    exported.map(({ id, version, status }) => ({ id, version, status })),
    [
      { id: second.daily_session.id, version: 2, status: "active" },
      { id: first.daily_session.id, version: 1, status: "superseded" },
    ]
  );
  assert.deepEqual(exported[0].items[0].rep_low, 8);
  assert.deepEqual(exported[1].items[0].rep_low, 5);

  const snapshotPath = path.join(process.env.DATA_DIR, "daily-session-history.db");
  repo.snapshotDbTo(snapshotPath);
  const restored = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    assert.deepEqual(
      restored
        .prepare(`SELECT version, status, title FROM daily_session_compositions WHERE date = ? ORDER BY version DESC`)
        .all(date)
        .map((row) => ({ ...row })),
      [
        { version: 2, status: "active", title: "Second version" },
        { version: 1, status: "superseded", title: "First version" },
      ]
    );
  } finally {
    restored.close();
  }
});
