// "Your data" (src/domain/health/data-coverage.ts): one row per source Cairn reads, with
// its coverage and freshness in plain words, then at most two gaps where more data would
// most sharpen the reads. Served at GET /api/health/data-coverage and get_data_coverage.
//   - rows come back in one order; visit notes only when there are any
//   - a draw is one row per (kind, date), so a CCDA split never inflates the count
//   - a superseded imaging study is not a current record
//   - a wearable is "quiet" by the sensor-freshness law, never by a number of its own
//   - gaps: the evidence-wanted line first, then no panel / no wearable / quiet wearable;
//     never more than two, calm, and never a score
// Every fixture is synthetic: invented dates and values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, marker, repo, seedHealthDoc } from "./_seed.js";
import { DATA_COVERAGE_MAX_GAPS, dataCoverageRead } from "../dist/domain/health/data-coverage.js";
import { connectedBrainRouter } from "../dist/routes/connected-brain.js";
import { registerConnectedBrainTools } from "../dist/surfaces/mcp/connected-brain.js";
import { setGarminSyncStatus } from "../dist/repo/settings.js";

const AS_OF = "2026-06-10";

function insertDoc({ kind, doc_date, source_doc_id = null, parsed = null }) {
  const info = db
    .prepare(
      `INSERT INTO health_documents (kind, doc_date, source_doc_id, parsed_json, enrichment_status, created_at)
       VALUES (?, ?, ?, ?, 'done', datetime('now'))`
    )
    .run(kind, doc_date, source_doc_id, parsed ? JSON.stringify(parsed) : null);
  return Number(info.lastInsertRowid);
}

function imaging(modality, status = "current") {
  return { imaging_study: { study: { modality }, provenance: { record_status: status } } };
}

function garminNight(date) {
  let source = db.prepare(`SELECT id FROM garmin_sources WHERE label = 'synthetic'`).get();
  if (!source) {
    const info = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'synthetic')`).run();
    source = { id: Number(info.lastInsertRowid) };
  }
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, sleep_min, resting_hr) VALUES (?, ?, 420, 52)`).run(
    source.id,
    date
  );
}

function appleConnection(lastUsed) {
  db.prepare(
    `INSERT INTO apple_health_connections (label, token_hash, created_at, expires_at, last_used_at)
     VALUES ('Synthetic phone', ?, '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z', ?)`
  ).run(`hash-${Math.random()}`, lastUsed);
}

const rowOf = (read, key) => read.rows.find((r) => r.key === key);

test("an empty record: every source in order, each saying how to add it, and two calm gaps", () => {
  const read = dataCoverageRead({ asOf: AS_OF });
  assert.equal(read.as_of, AS_OF);
  assert.deepEqual(
    read.rows.map((r) => r.key),
    ["labs", "scans", "garmin", "apple_health", "body"],
    "no visits row until there is a visit"
  );
  for (const row of read.rows) {
    assert.equal(row.state, "absent", `${row.key} has nothing yet`);
    assert.equal(row.date, null);
    assert.equal(row.quiet, false, "an absent source is not quiet");
  }
  assert.equal(rowOf(read, "labs").cta, "Add");
  assert.equal(rowOf(read, "garmin").cta, "Connect");
  assert.equal(rowOf(read, "apple_health").opens, "sources");
  assert.deepEqual(
    read.gaps.map((g) => g.key),
    ["labs:none", "source:wearable"]
  );
  assert.equal(read.gaps[0].action, "add");
  assert.equal(read.gaps[1].action, "sources");
  assert.match(read.frame, /nothing waits on it/i);
});

test("a full record: counts are draws, scans name their study, visits appear, body opens the newer source", () => {
  const upload = insertDoc({ kind: "bloodwork", doc_date: "2026-05-02" });
  insertDoc({ kind: "bloodwork", doc_date: "2026-05-02", source_doc_id: upload }); // a CCDA split of it
  insertDoc({ kind: "bloodwork", doc_date: "2025-11-20" });
  insertDoc({ kind: "imaging", doc_date: "2026-04-30", parsed: imaging("CT") });
  insertDoc({ kind: "imaging", doc_date: "2026-01-15", parsed: imaging("MRI") });
  insertDoc({ kind: "imaging", doc_date: "2026-05-20", parsed: imaging("US", "superseded") });
  const visit = insertDoc({ kind: "visit_note", doc_date: "2026-03-03" });
  const summary = insertDoc({ kind: "after_visit_summary", doc_date: "2026-03-03" });
  insertDoc({ kind: "dexa", doc_date: "2026-02-01" });
  db.prepare(`INSERT INTO body_measurements (date, waist_in) VALUES ('2026-06-01', 33.5)`).run();

  const read = dataCoverageRead({ asOf: AS_OF });
  assert.deepEqual(
    read.rows.map((r) => r.key),
    ["labs", "scans", "visits", "garmin", "apple_health", "body"]
  );

  const labs = rowOf(read, "labs");
  assert.equal(labs.state, "present");
  assert.equal(labs.holds, "2 blood draws", "one draw is one row, however many documents carry it");
  assert.equal(labs.date, "2026-05-02");
  assert.equal(labs.date_words, "May 2");
  assert.equal(labs.doc_id, upload, "the row opens the uploaded source of the draw");
  assert.equal(labs.cta, null);

  const scans = rowOf(read, "scans");
  assert.equal(scans.date, "2026-04-30", "a superseded study is not a current record");
  assert.equal(scans.holds, "CT scan · 2 studies");

  const visits = rowOf(read, "visits");
  assert.equal(visits.holds, "Notes from 1 visit", "a note and its summary are one visit");
  assert.equal(visits.date, "2026-03-03");
  assert.ok([visit, summary].includes(visits.doc_id), "the row opens that visit's record");

  const body = rowOf(read, "body");
  assert.equal(body.holds, "DEXA and tape measurements");
  assert.equal(body.date, "2026-06-01");
  assert.equal(body.opens, "measurements", "the newer of the two decides where the row opens");

  assert.ok(!read.gaps.some((g) => g.key === "labs:none"), "a panel on file is never asked for");
});

test("a wearable reads its sync while its newest night is current, and goes quiet by the sensor-freshness law", () => {
  garminNight("2026-06-09");
  setGarminSyncStatus("ok: 3 activities · 7 daily");
  let read = dataCoverageRead({ asOf: AS_OF });
  let garmin = rowOf(read, "garmin");
  assert.equal(garmin.state, "present");
  assert.equal(garmin.quiet, false);
  assert.ok(garmin.synced_at, "a clean sync with a current night shows its clock");
  assert.equal(garmin.date_words, "yesterday");
  assert.ok(!read.gaps.some((g) => g.key.startsWith("source:")), "one current wearable is enough");

  // The same night, read three weeks later: no longer current for sleep, HRV or RHR.
  read = dataCoverageRead({ asOf: "2026-06-30" });
  garmin = rowOf(read, "garmin");
  assert.equal(garmin.quiet, true);
  assert.equal(garmin.synced_at, null, "a quiet source shows its newest date, not a sync clock");
  const gap = read.gaps.find((g) => g.key === "source:garmin:quiet");
  assert.ok(gap, "every connected wearable quiet → one calm line");
  assert.equal(gap.subject, "Garmin");
  assert.match(gap.why, /Jun 9/);
  assert.doesNotMatch(gap.why, /\bmust\b|overdue|missing|urgent/i);
});

test("Apple Health: a linked phone with nothing synced yet is connected; a fresh night is current", () => {
  appleConnection("2026-06-10T06:00:00Z");
  let apple = rowOf(dataCoverageRead({ asOf: AS_OF }), "apple_health");
  assert.equal(apple.state, "present", "a live connection is connected before its first night");
  assert.equal(apple.quiet, true, "but nothing current has arrived");

  repo.recordDailyMetrics("apple_health", "2026-06-10", { sleep_min: 400, hrv_ms: 61 });
  apple = rowOf(dataCoverageRead({ asOf: AS_OF }), "apple_health");
  assert.equal(apple.quiet, false);
  assert.equal(apple.date_words, "today");
  assert.equal(apple.synced_at, "2026-06-10T06:00:00Z");
});

test("the evidence-wanted line leads the gaps, and there are never more than two", () => {
  seedHealthDoc("2026-01-01", [
    marker("ApoB", 125, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 160, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.refreshDoctorLoopAttention();
  const read = dataCoverageRead({ asOf: "2026-05-01" });
  assert.ok(read.gaps.length <= DATA_COVERAGE_MAX_GAPS);
  assert.equal(read.gaps[0].key, "panel:lipids", "the overdue recheck comes first");
  assert.equal(read.gaps[0].action, "checkup");
  assert.equal(read.gaps[0].action_label, "See checkup");
  assert.match(read.gaps[0].why, /^When it suits you/);
  for (const gap of read.gaps) {
    assert.doesNotMatch(`${gap.subject} ${gap.why}`, /\b\d+\s*\/\s*\d+\b|\bscore\b|%/i, "never a score");
  }
});

test("the route and the MCP tool answer the same read", async () => {
  insertDoc({ kind: "bloodwork", doc_date: "2026-05-02" });
  const layer = connectedBrainRouter.stack.find(
    (l) => l.route?.path === "/health/data-coverage" && l.route.methods.get
  );
  assert.ok(layer, "routed");
  const body = await new Promise((resolve) =>
    layer.route.stack.at(-1).handle({ query: { as_of: AS_OF } }, { json: resolve })
  );
  assert.equal(rowOf(body, "labs").holds, "1 blood draw");

  const tools = new Map();
  registerConnectedBrainTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const out = await tools.get("get_data_coverage")({ as_of: AS_OF });
  assert.deepEqual(JSON.parse(out.content[0].text), body);
});
