// Event-driven recheck cadence: a fresh health-document ingest recomputes the
// lab/marker attention schedule immediately (enrich.ts, alongside deriveDirectives)
// so a mid-day upload's "next checkup" recheck surfaces WITHOUT waiting for the
// nightly checkup_attention_date scheduler op — and without the read forcing a
// refresh (GET /health/next-checkup is read-only by default). Drives the real
// enrich pipeline offline via the stub agent (mirrors enrichHealthStatus.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repo, seedHealthDoc, marker } from "./_seed.js";
import { enqueueEnrich } from "../dist/enrich.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a fresh health-doc ingest recomputes the recheck cadence without the nightly op", async () => {
  repo.setSettings({
    enrich_enabled: true,
    agent_strategy: "priority",
    agent_order: ["stub"],
    disabled_agents: ["claude", "codex", "antigravity", "grok"],
  });

  const asOf = "2026-07-01";
  // A prior lab already on file: ApoB elevated, dated so its 84-day lipid recheck
  // window has opened by the as-of date — a recheck that should be due ONCE the
  // attention schedule is (re)computed. seedHealthDoc inserts a done doc directly;
  // it does NOT touch the attention schedule.
  seedHealthDoc("2026-03-15", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);

  // Nothing has refreshed the attention schedule yet, and the read is read-only →
  // no recheck is due.
  assert.equal(
    repo.nextCheckupRead({ refresh: false, asOf }).due_now.length,
    0,
    "before any refresh, the read surfaces nothing due (it never writes the schedule itself)"
  );

  // A text visit note reaches the health-completion tail via the deterministic
  // fallback under the stub agent (proven in enrichHealthStatus.test.js).
  const note = `Progress Notes by Amanda Dimeo at 7/7/2026  1:40 PM
Televisit Adult Patient Visit
7/7/2026
Assessment/Plan:
1. Elevated LDL cholesterol level
- Pending lab results
- LIPID PANEL; Future
- APOLIPOPROTEIN B; Future
Follow-up:
- labs in Aug, f/u per myChart`;
  const fp = path.join(os.tmpdir(), `cairn-checkup-ingest-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(fp, note, "utf8");
  const doc = repo.addHealthDocument({
    kind: "other",
    original_name: "progress-note.txt",
    mime: "text/plain",
    file_path: fp,
    enrichment_status: "pending",
  });

  enqueueEnrich("health", doc.id);

  let after = repo.getHealthDocument(doc.id);
  for (let i = 0; i < 100; i++) {
    after = repo.getHealthDocument(doc.id);
    if (!["pending", "in_progress"].includes(after.enrichment_status)) break;
    await sleep(50);
  }
  assert.equal(after.enrichment_status, "done");

  // The health-completion tail (reconcileMarkers → deriveDirectives → the new
  // refreshDoctorLoopAttention) runs just AFTER the status flips to done, so poll
  // for the side effect rather than asserting on the same tick.
  let surfaced = false;
  for (let i = 0; i < 60; i++) {
    if (repo.nextCheckupRead({ refresh: false, asOf }).due_now.some((x) => /apob/i.test(x.label))) {
      surfaced = true;
      break;
    }
    await sleep(50);
  }
  fs.rmSync(fp, { force: true });

  assert.ok(
    surfaced,
    "the ingest's event-driven refresh populated the schedule — the ApoB recheck surfaces with NO nightly op and NO ?refresh=1"
  );
});
