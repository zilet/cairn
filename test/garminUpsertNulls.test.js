// Omitted vs stated-null on the Garmin upserts.
//
// Two live footguns lived here. (1) `upsert_garmin_source` COALESCE-preserved every
// field on an update EXCEPT `mode`: an omitted mode arrived as "unofficial" and
// overwrote a stored "official"/"manual", so a status-only write silently
// reconfigured the connector. (2) On the activity and daily-metric upserts every
// column COALESCEd, so null and omitted were indistinguishable at the SQL layer and
// a wrong stored value could never be corrected back to empty through any surface.
//
// The sync path still needs the old behavior — `activityToInput` builds a FULL object
// whose absent fields are explicit nulls, and treating those as "clear" would erase
// richness on every sparse re-sync. So clearing is opt-in per call
// ({ nullsClear: true }), taken by the REST route and the MCP tool only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";
import { registerGarminTools } from "../dist/surfaces/mcp/garmin.js";

const TODAY = localDaysAgo(0);

beforeEach(() => {
  for (const t of ["activities", "garmin_activities", "garmin_daily_metrics", "garmin_sources"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
});

function mcpTool(name) {
  const tools = new Map();
  registerGarminTools({ tool: (n, _desc, schema, handler) => tools.set(n, { schema, handler }) });
  const tool = tools.get(name);
  if (!tool) throw new Error(`no MCP tool ${name}`);
  return tool;
}
const callTool = async (name, args) => JSON.parse((await mcpTool(name).handler(args)).content[0].text);

// ---- (1) the source's mode preserves on omit, like every sibling field ----------

test("upsert_garmin_source preserves a stored mode when the caller omits it", () => {
  const created = repo.upsertGarminSource({ label: "test", mode: "official", auth_status: "connected" });
  assert.equal(created.mode, "official");

  // A status-only update must not reconfigure the connector.
  const after = repo.upsertGarminSource({ label: "test", auth_status: "failed" });
  assert.equal(after.mode, "official", "an omitted mode leaves the stored one alone");
  assert.equal(after.auth_status, "failed");

  // A STATED mode still writes, and an unknown one still cleans to "unofficial".
  assert.equal(repo.upsertGarminSource({ label: "test", mode: "manual" }).mode, "manual");
  assert.equal(repo.upsertGarminSource({ label: "test", mode: "nonsense" }).mode, "unofficial");

  // On CREATE the absence still means "unofficial" — that default is unchanged.
  assert.equal(repo.upsertGarminSource({ label: "fresh" }).mode, "unofficial");
});

test("the sync path's own mode writes still land", () => {
  // src/garmin.ts states mode:"unofficial" on every source write, so the connector it
  // configures reads exactly as before this change.
  repo.upsertGarminSource({ label: "sync", mode: "official" });
  const synced = repo.upsertGarminSource({ label: "sync", mode: "unofficial", auth_status: "connected" });
  assert.equal(synced.mode, "unofficial");
});

// ---- (2) activity: null clears, omitted preserves, but only when asked -----------

const seedActivity = () =>
  repo.upsertGarminActivity({
    external_id: "ext-nulls",
    date: TODAY,
    start_time: `${TODAY}T07:30:00`,
    type: "running",
    name: "Morning run",
    duration_min: 42,
    distance_km: 8.1,
    avg_hr: 148,
    calories: 470,
  });

test("an omitted activity field preserves, a stated null clears it", () => {
  const seeded = seedActivity();
  assert.equal(seeded.avg_hr, 148);

  // Omitted: the sparse re-sync case. Nothing is lost.
  const sparse = repo.upsertGarminActivity({ external_id: "ext-nulls" }, null, { nullsClear: true });
  assert.equal(sparse.avg_hr, 148, "an omitted key never clears");
  assert.equal(sparse.duration_min, 42);
  assert.equal(sparse.distance_km, 8.1);

  // Stated null: the correction case.
  const cleared = repo.upsertGarminActivity({ external_id: "ext-nulls", avg_hr: null }, null, { nullsClear: true });
  assert.equal(cleared.avg_hr, null, "a stated null clears the stored value");
  assert.equal(cleared.calories, 470, "and touches nothing else");
  assert.equal(cleared.duration_min, 42);
});

test("without nullsClear an explicit null still preserves — the sync path is unchanged", () => {
  seedActivity();
  // This is exactly what activityToInput produces for an activity whose payload lacks
  // the field: an explicit null on a full object. It must never erase richness.
  const resynced = repo.upsertGarminActivity({
    external_id: "ext-nulls",
    date: TODAY,
    type: "running",
    name: "Morning run",
    duration_min: null,
    distance_km: null,
    avg_hr: null,
    calories: null,
  });
  assert.equal(resynced.avg_hr, 148, "the sync's nulls still COALESCE-preserve");
  assert.equal(resynced.duration_min, 42);
  assert.equal(resynced.distance_km, 8.1);
  assert.equal(resynced.calories, 470);
});

test("clearing an activity field also clears it in the mirrored activities row", () => {
  const seeded = seedActivity();
  const mirrorId = seeded.activity_id;
  assert.ok(mirrorId, "a cardio activity is mirrored into activities");
  assert.equal(db.prepare(`SELECT distance_km FROM activities WHERE id = ?`).get(mirrorId).distance_km, 8.1);

  repo.upsertGarminActivity({ external_id: "ext-nulls", distance_km: null }, null, { nullsClear: true });
  const mirrored = db.prepare(`SELECT duration_min, distance_km FROM activities WHERE id = ?`).get(mirrorId);
  assert.equal(mirrored.distance_km, null, "the calendar copy does not keep what was cleared");
  assert.equal(mirrored.duration_min, 42, "and an untouched field survives");
});

test("clearing one Garmin field leaves the rest of the mirrored row alone", () => {
  // The mirror gate is per column. `activities.notes` is DERIVED from HR/load/effect,
  // so it reads empty for an activity carrying none of them — and an unconditional
  // mirror then wrote that emptiness back, silently wiping a note the enricher or a
  // REST edit had written, on a clear of some entirely unrelated field.
  const seeded = repo.upsertGarminActivity({
    external_id: "ext-plain",
    date: TODAY,
    start_time: `${TODAY}T07:30:00`,
    type: "running",
    name: "Morning run",
    duration_min: 42,
    distance_km: 8.1,
    calories: 470,
  });
  const mirrorId = seeded.activity_id;
  assert.ok(mirrorId, "a cardio activity is mirrored into activities");
  db.prepare(`UPDATE activities SET notes = ? WHERE id = ?`).run("felt easy the whole way", mirrorId);

  repo.upsertGarminActivity({ external_id: "ext-plain", calories: null }, null, { nullsClear: true });
  const mirrored = db
    .prepare(`SELECT notes, duration_min, distance_km, pace FROM activities WHERE id = ?`)
    .get(mirrorId);
  assert.equal(mirrored.notes, "felt easy the whole way", "an unrelated clear never touches the note");
  assert.equal(mirrored.duration_min, 42);
  assert.equal(mirrored.distance_km, 8.1);
  assert.ok(mirrored.pace, "nor the derived pace");
});

test("clearing a reading the mirrored note is built from does rewrite the note", () => {
  // The other half of the same gate: notes IS derived from avg_hr, so clearing the
  // reading must not leave "avg HR 148" standing in the calendar copy.
  const seeded = seedActivity();
  const mirrorId = seeded.activity_id;
  assert.match(
    String(db.prepare(`SELECT notes FROM activities WHERE id = ?`).get(mirrorId).notes ?? ""),
    /avg HR 148/,
  );

  repo.upsertGarminActivity({ external_id: "ext-nulls", avg_hr: null }, null, { nullsClear: true });
  const after = db.prepare(`SELECT notes, duration_min FROM activities WHERE id = ?`).get(mirrorId);
  assert.doesNotMatch(String(after.notes ?? ""), /avg HR/, "the cleared reading leaves the note");
  assert.equal(after.duration_min, 42, "and the rest of the row stands");
});

test("the MCP upsert_garmin_activity tool can clear a stored field", async () => {
  seedActivity();
  const cleared = await callTool("upsert_garmin_activity", {
    external_id: "ext-nulls",
    training_load: null,
    avg_hr: null,
  });
  assert.equal(cleared.avg_hr, null, "the tool's null reaches the SQL as a clear");
  assert.equal(cleared.duration_min, 42, "and an omitted field is left alone");
});

// ---- (2b) daily metric: same rule ------------------------------------------------

test("an omitted daily-metric field preserves, a stated null clears it", () => {
  repo.upsertGarminDailyMetric({ date: TODAY, steps: 9000, resting_hr: 52, hrv_ms: 71 });

  const sparse = repo.upsertGarminDailyMetric({ date: TODAY }, null, { nullsClear: true });
  assert.equal(sparse.resting_hr, 52, "an omitted key never clears");
  assert.equal(sparse.steps, 9000);

  const cleared = repo.upsertGarminDailyMetric({ date: TODAY, resting_hr: null }, null, { nullsClear: true });
  assert.equal(cleared.resting_hr, null, "a stated null clears the stored value");
  assert.equal(cleared.hrv_ms, 71, "and touches nothing else");
  assert.equal(cleared.steps, 9000);

  // The sync path (no option) keeps preserving through explicit nulls.
  const resynced = repo.upsertGarminDailyMetric({ date: TODAY, steps: null, hrv_ms: null });
  assert.equal(resynced.steps, 9000);
  assert.equal(resynced.hrv_ms, 71);
});

test("the MCP upsert_garmin_daily_metric tool can clear a stored reading", async () => {
  repo.upsertGarminDailyMetric({ date: TODAY, steps: 9000, sleep_score: 80 });
  const cleared = await callTool("upsert_garmin_daily_metric", { date: TODAY, sleep_score: null });
  assert.equal(cleared.sleep_score, null);
  assert.equal(cleared.steps, 9000);
});
