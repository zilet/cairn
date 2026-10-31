// Review regressions for the duplicate fold. A fold must never lose a draw another
// upload still carries, the later EXPORT's value must stand whichever export is read
// again, a person's merge folds exactly what they were shown, a read in progress is
// never folded under, only the deterministic CCDA pass's own rows are one encounter,
// and the boot pass gives up loudly instead of retrying forever.
// Every value here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, repo } from "./_seed.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { deleteHealthDocument, replaceHealthPanels, replaceHealthPanelsByType } from "../dist/repo/health.js";
import { dedupeHealthDocuments, isDeterministicCcdaRow } from "../dist/repo/health-dedupe.js";
import {
  DEDUPE_RULES_ATTEMPTS_KEY,
  DEDUPE_RULES_VERSION_KEY,
  MAX_UPGRADE_ATTEMPTS,
  applyPlannedDedupe,
  runDedupeRulesUpgradeIfDue,
  settleNewHealthRecords,
} from "../dist/domain/health/record-dedupe.js";

const v = (name, value, unit = null) => ({ name, value, unit, flag: null });

function exportRow(createdAt, extra = {}) {
  const row = repo.addHealthDocument({
    kind: "other",
    original_name: "export.zip",
    enrichment_status: "done",
    ...extra,
  });
  db.prepare("UPDATE health_documents SET created_at = ? WHERE id = ?").run(createdAt, row.id);
  return row.id;
}

const sheet = (weight) => [
  v("Systolic BP", 128, "mmHg"),
  v("Diastolic BP", 79, "mmHg"),
  v("Pulse", 71, "bpm"),
  v("Weight", weight, "lb"),
];
const visit = (weight) => [
  {
    doc_date: "2026-03-10",
    kind: "other",
    summary: "MyChart vitals recorded 2026-03-10 15:52",
    recorded_at: "2026-03-10 15:52",
    markers: sheet(weight),
  },
];

// the CCDA pass for one export, then the settle every ingest ends with
function ccdaPass(sourceId, weight) {
  replaceHealthPanelsByType(sourceId, "ccda_vitals", visit(weight));
  return settleNewHealthRecords(sourceId);
}

const visitRows = () =>
  db
    .prepare("SELECT id, source_doc_id, parsed_json FROM health_documents WHERE doc_date = '2026-03-10' ORDER BY id")
    .all()
    .map((r) => {
      const parsed = JSON.parse(r.parsed_json);
      return { id: r.id, source: r.source_doc_id, weight: parsed.markers.find((m) => m.name === "Weight")?.value };
    });

test("re-reading the export that owns the merged visit keeps the later export's value", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  ccdaPass(e1, 180);
  ccdaPass(e2, 181);
  assert.deepEqual(
    visitRows().map((r) => [r.source, r.weight]),
    [[e1, 181]],
    "one visit, the later export's weight"
  );

  ccdaPass(e1, 180); // reanalyze the EARLIER export, which owns the merged row
  assert.deepEqual(
    visitRows().map((r) => [r.source, r.weight]),
    [[e1, 181]],
    "the later value still wins"
  );
});

test("deleting the export that owns the merged visit leaves the visit on file from the other export", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  ccdaPass(e1, 180);
  ccdaPass(e2, 181);
  const out = deleteHealthDocument(e1);
  assert.equal(out.deleted, 1);
  assert.equal(out.restored, 1);
  assert.deepEqual(
    visitRows().map((r) => [r.source, r.weight]),
    [[e2, 181]],
    "E2's visit survives with E2's values"
  );
});

test("an agent re-read of the owning export (every derived row replaced) re-files the other export's visit", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  ccdaPass(e1, 180);
  ccdaPass(e2, 181);
  replaceHealthPanels(e1, [{ doc_date: "2026-04-04", summary: "Lipid panel", markers: [v("LDL-C", 110, "mg/dL")] }]);
  assert.deepEqual(
    visitRows().map((r) => [r.source, r.weight]),
    [[e2, 181]]
  );
});

test("three exports: the latest stands, and re-reading the middle one never reverts it", () => {
  const a = exportRow("2026-01-01 10:00:00");
  const b = exportRow("2026-02-01 10:00:00");
  const c = exportRow("2026-03-01 10:00:00");
  ccdaPass(a, 180);
  ccdaPass(b, 181);
  ccdaPass(c, 182);
  assert.deepEqual(
    visitRows().map((r) => r.weight),
    [182]
  );
  ccdaPass(b, 181); // reanalyze the middle export
  const rows = visitRows();
  assert.deepEqual(
    rows.map((r) => r.weight),
    [182],
    "C (the latest export) still stands"
  );
  const parsed = JSON.parse(
    db.prepare("SELECT parsed_json FROM health_documents WHERE id = ?").get(rows[0].id).parsed_json
  );
  const key = Object.keys(parsed.reading_sources).find((k) => /weight/.test(k));
  assert.equal(parsed.reading_sources[key].source_doc_id, c, "the standing value remembers its export");
  // and re-reading the first export (which owns the row) keeps C too
  ccdaPass(a, 180);
  assert.deepEqual(
    visitRows().map((r) => r.weight),
    [182]
  );
});

test("only the CCDA pass's own rows are one encounter; an agent panel naming a CCDA type is filed untyped", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  const [agentRow] = replaceHealthPanels(e1, [
    { ...visit(180)[0], type: "ccda_vitals", markers: [v("Weight", 180, "lb")] },
  ]);
  const parsed = JSON.parse(
    db.prepare("SELECT parsed_json FROM health_documents WHERE id = ?").get(agentRow.id).parsed_json
  );
  assert.equal(parsed.type, undefined, "an agent cannot claim a deterministic stream");
  assert.equal(parsed.ccda_pass, undefined);
  assert.equal(parsed.recorded_at, undefined);
  // the CCDA pass's row is flagged; a legacy row is recognized only by what that pass writes
  const [ccdaRow] = replaceHealthPanelsByType(e2, "ccda_vitals", visit(181));
  assert.equal(
    JSON.parse(db.prepare("SELECT parsed_json FROM health_documents WHERE id = ?").get(ccdaRow.id).parsed_json)
      .ccda_pass,
    true
  );
  assert.equal(
    isDeterministicCcdaRow({
      parsed: { type: "ccda_vitals", markers: [v("Weight", 1, "lb")] },
      summary: "MyChart vitals recorded 2026-03-10 15:52",
    }),
    true
  );
  assert.equal(
    isDeterministicCcdaRow({
      parsed: { type: "ccda_vitals", markers: [v("Body weight (scale)", 1, "lb")] },
      summary: "MyChart vitals recorded 2026-03-10 15:52",
    }),
    false,
    "a name the CCDA pass never writes"
  );
  assert.equal(
    isDeterministicCcdaRow({
      parsed: { type: "ccda_vitals", markers: [v("Weight", 1, "lb")] },
      summary: "Vitals from the clinic visit",
    }),
    false
  );
  // the agent row and the CCDA row share the encounter text, yet never fold as one encounter
  assert.equal(dedupeHealthDocuments({}).merged, 0);
});

test("a read in progress is never folded under, by the whole-set pass or the boot pass", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  replaceHealthPanelsByType(e1, "ccda_vitals", visit(180));
  replaceHealthPanelsByType(e2, "ccda_vitals", visit(181));
  db.prepare("UPDATE health_documents SET enrichment_status = 'in_progress' WHERE id = ?").run(e2);
  assert.equal(dedupeHealthDocuments({}).merged, 0, "E2 is mid-read: its rows stay put");
  repo.setAppState(DEDUPE_RULES_VERSION_KEY, "0");
  assert.equal(runDedupeRulesUpgradeIfDue().result.merged, 0);
  // the ingest's own scoped settle still folds (it IS the read in progress)
  assert.equal(settleNewHealthRecords(e2).merged, 1);
});

test("a person's merge folds exactly the planned clusters, or none when the records changed", () => {
  const panel = (date, extra = []) =>
    repo.addHealthDocument({
      kind: "bloodwork",
      doc_date: date,
      enrichment_status: "done",
      parsed_json: { markers: [v("LDL-C", 112, "mg/dL"), v("HDL-C", 58, "mg/dL"), ...extra] },
    }).id;
  const a1 = panel("2026-02-02", [v("Triglycerides", 90, "mg/dL")]);
  const a2 = panel("2026-02-02");
  const plan = dedupeHealthDocuments({ dryRun: true });
  assert.equal(plan.clusters.length, 1);
  const planned = plan.clusters.map((c) => ({
    survivor: c.survivor.id,
    merged: c.merged.map((m) => m.id),
    rule: c.rule,
  }));

  // a new twin arrives after the check: it is NOT folded by this merge
  const b1 = panel("2026-03-03", [v("Triglycerides", 95, "mg/dL")]);
  const b2 = panel("2026-03-03");
  const applied = applyPlannedDedupe(planned);
  assert.equal(applied.ok, true);
  assert.equal(applied.merged, 1);
  const present = (id) => !!db.prepare("SELECT 1 FROM health_documents WHERE id = ?").get(id);
  assert.ok(present(a1) && !present(a2));
  assert.ok(present(b1) && present(b2), "what was never shown is never merged");

  // a planned twin that changed since the check: nothing at all is folded
  const stale = dedupeHealthDocuments({ dryRun: true }).clusters.map((c) => ({
    survivor: c.survivor.id,
    merged: c.merged.map((m) => m.id),
    rule: c.rule,
  }));
  db.prepare("UPDATE health_documents SET parsed_json = ? WHERE id = ?").run(
    JSON.stringify({ markers: [v("LDL-C", 160, "mg/dL"), v("HDL-C", 40, "mg/dL")] }),
    b2
  );
  const refused = applyPlannedDedupe(stale);
  assert.equal(refused.ok, false);
  assert.equal(refused.changed, true);
  assert.match(refused.error, /changed since the check/);
  assert.ok(present(b1) && present(b2));
});

test("the plan says in plain words when a merge removes an uploaded file or a pasted report", () => {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const file = (name) => {
    const fp = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(fp, "x");
    return fp;
  };
  const markers = [v("LDL-C", 112, "mg/dL"), v("HDL-C", 58, "mg/dL")];
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    file_path: file("a.pdf"),
    mime: "application/pdf",
    enrichment_status: "done",
    parsed_json: { markers },
  });
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    file_path: file("b.txt"),
    mime: "text/plain",
    enrichment_status: "done",
    parsed_json: { markers },
  });
  const [cluster] = dedupeHealthDocuments({ dryRun: true }).clusters;
  assert.deepEqual(
    cluster.removes.map((r) => r.what),
    ["paste"]
  );
  assert.match(cluster.removes_note, /removes a duplicate pasted report/);
});

test("the boot pass stores its version only on a clean pass, and gives up loudly after three failing boots", () => {
  repo.setAppState(DEDUPE_RULES_VERSION_KEY, "0");
  // a twin whose file refuses to be removed makes every pass stop with an error
  const markers = [v("LDL-C", 112, "mg/dL"), v("HDL-C", 58, "mg/dL")];
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const ok = path.join(UPLOADS_DIR, "boot-ok.pdf");
  fs.writeFileSync(ok, "x");
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    file_path: ok,
    enrichment_status: "done",
    parsed_json: { markers: [...markers, v("Triglycerides", 90, "mg/dL")] },
  });
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    file_path: "/nonexistent/outside.pdf",
    enrichment_status: "done",
    parsed_json: { markers },
  });
  for (let i = 1; i <= MAX_UPGRADE_ATTEMPTS; i++) {
    const out = runDedupeRulesUpgradeIfDue();
    assert.equal(out.ran, true);
    assert.equal(repo.getAppState(DEDUPE_RULES_VERSION_KEY), "0", "never stored after a failing pass");
    assert.match(repo.getAppState(DEDUPE_RULES_ATTEMPTS_KEY), new RegExp(`:${i}$`));
  }
  assert.deepEqual(runDedupeRulesUpgradeIfDue(), { ran: false, gave_up: true });
});
