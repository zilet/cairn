import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repo } from "./_seed.js";
import { enqueueEnrich } from "../dist/enrich.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("health reanalysis keeps an existing structured ingest when the agent returns a wrong shape", async () => {
  repo.setSettings({
    enrich_enabled: true,
    agent_strategy: "priority",
    agent_order: ["stub"],
    disabled_agents: ["claude", "codex", "antigravity", "grok"],
  });

  const fp = path.join(os.tmpdir(), `cairn-existing-health-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(fp, "Garmin ECG recording: sinus rhythm, average heart rate 57 bpm.", "utf8");
  const doc = repo.addHealthDocument({
    kind: "other",
    doc_date: "2026-06-30",
    original_name: "Garmin_ecg.pdf",
    mime: "application/pdf",
    file_path: fp,
    enrichment_status: "pending",
    summary: "Garmin ECG recording shows sinus rhythm at an average heart rate of 57 bpm.",
    parsed_json: {
      markers: [
        { name: "Average Heart Rate", value: 57, unit: "bpm", flag: null },
      ],
      clinical_facts: [
        { kind: "procedure", date: "2026-06-30", name: "ECG Recording", status: "completed" },
      ],
    },
  });

  enqueueEnrich("health", doc.id);

  let after = repo.getHealthDocument(doc.id);
  for (let i = 0; i < 80; i++) {
    after = repo.getHealthDocument(doc.id);
    if (!["pending", "in_progress"].includes(after.enrichment_status)) break;
    await sleep(50);
  }
  fs.rmSync(fp, { force: true });

  assert.equal(after.enrichment_status, "done");
  assert.equal(after.parsed.markers.length, 1);
  assert.equal(after.parsed.markers[0].name, "Average Heart Rate");
  assert.equal(after.parsed.clinical_facts.length, 1);
});
