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

test("text visit notes fall back to structured clinical facts when the agent misses the ingest shape", async () => {
  repo.setSettings({
    enrich_enabled: true,
    agent_strategy: "priority",
    agent_order: ["stub"],
    disabled_agents: ["claude", "codex", "antigravity", "grok"],
  });

  const note = `Progress Notes by Amanda Dimeo at 7/7/2026  1:40 PM
Televisit Adult Patient Visit
7/7/2026
History of Present Illness:
Milos is presenting for follow-up on labs.
Reviewed family history and updated in EPIC; denies family history of heart disease, denies family history of sudden cardiac or unknown death

Assessment/Plan:
1. Elevated LDL cholesterol level
2. Elevated lipoprotein A level
Discussed results with patient and reviewed PREVENT algorithm; he has RF of LDL persistently > 160, high lipo(a) and Apo(B)
- Pending lab results, consider referral to Cardiology and/or e-consult for consideration of starting a mod-intensity statin versus CAC for further risk stratification
- LIPID PANEL; Future
- LIPOPROTEIN A; Future
- APOLIPOPROTEIN B; Future
- HEMOGLOBIN A1C; Future

3. Screening for endocrine, nutritional, metabolic and immunity disorder
- VITAMIN B12; Future
- FOLATE; Future
- VITAMIN D,25 HYDROXY; Future
- METHYLMALONIC ACID; Future

Follow-up:
- labs in Aug, f/u per myChart`;

  const fp = path.join(os.tmpdir(), `cairn-visit-note-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(fp, note, "utf8");
  const event = repo.addContextEvent({
    kind: "life_event",
    title: "PCP follow-up visit",
    detail: "Planned primary care appointment to review cholesterol labs.",
    start_date: "2026-07-07",
  });
  const doc = repo.addHealthDocument({
    kind: "other",
    original_name: "progress-note.txt",
    mime: "text/plain",
    file_path: fp,
    enrichment_status: "pending",
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
  assert.equal(after.doc_date, "2026-07-07");
  assert.match(after.summary, /future labs/i);
  assert.deepEqual(after.parsed.markers, []);
  const facts = after.parsed.clinical_facts;
  assert.ok(facts.some((f) => f.kind === "encounter" && /Televisit Adult Patient Visit/.test(f.name)));
  assert.ok(facts.some((f) => f.kind === "condition" && f.name === "Elevated LDL cholesterol level"));
  assert.ok(facts.some((f) => f.name === "LIPID PANEL" && f.status === "ordered"));
  assert.ok(facts.some((f) => f.name === "Follow-up plan" && /labs in Aug/i.test(f.detail)));
  assert.ok(facts.some((f) => f.kind === "family_history"));
  assert.ok(repo.listMemory(10).some((m) => m.kind === "milestone" && /future labs/i.test(m.content)));

  const resolvedEvent = repo.getContextEvent(event.id);
  assert.equal(resolvedEvent.resolved_at, "2026-07-07");
  assert.equal(resolvedEvent.meta.matched_health_doc.id, doc.id);
  assert.equal(resolvedEvent.meta.matched_health_doc.kind, "visit_note");
  assert.equal(repo.listContextEvents({ activeOnly: true }).some((e) => e.id === event.id), false);
});
