// Garmin's training effect arrives as a float32 ("4.300000190734863"); notes say one decimal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

test("an imported activity's note rounds the training effect to one decimal", () => {
  repo.upsertGarminActivity({
    external_id: "te-1",
    date: "2026-06-10",
    type: "run",
    name: "Morning run",
    duration_min: 30,
    distance_km: 5,
    training_effect: 4.300000190734863,
  });
  const row = db.prepare(`SELECT notes FROM activities WHERE external_id = 'te-1'`).get();
  assert.match(row.notes, /effect 4\.3$/);
});

test("a stored raw float is tidied when the history is read", () => {
  db.prepare(`INSERT INTO activities (date, type, notes, source) VALUES ('2026-06-11', 'run', 'avg HR 140 · effect 4.300000190734863', 'garmin')`).run();
  const [row] = repo.listActivities(5);
  assert.equal(row.notes, "avg HR 140 · effect 4.3");
});
