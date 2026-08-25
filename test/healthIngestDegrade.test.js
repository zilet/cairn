import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { db, repo, resetTables } from "./_seed.js";
import { applyHealthIngest, buildHealthSourceInventory, describeAgentDegrade, enqueueEnrich } from "../dist/enrich.js";
import { buildHealthIngestPrompt } from "../dist/prompt.js";
import { AgentFallbackError } from "../dist/agents.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeExport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ingest-degrade-"));
  const xdm = path.join(dir, "IHE_XDM", "SUBSET01");
  fs.mkdirSync(xdm, { recursive: true });
  fs.writeFileSync(
    path.join(xdm, "DOC0001.XML"),
    `<?xml version="1.0"?>
<ClinicalDocument xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <component><structuredBody>
    <component><section>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
        <code code="24331-1" codeSystem="2.16.840.1.113883.6.1"><originalText>LIPID PANEL</originalText></code>
        <effectiveTime><low value="20260824120400+0000"/></effectiveTime>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2093-3" codeSystem="2.16.840.1.113883.6.1"><originalText>CHOLESTEROL</originalText></code>
          <effectiveTime value="20260824120400+0000"/>
          <value xsi:type="PQ" value="262" unit="mg/dL"/>
          <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/>
        </observation></component>
      </organizer></entry>
    </section></component>
    <component><section>
      <title>Allergies</title>
      <text>No known active allergies</text>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`
  );
  fs.writeFileSync(path.join(dir, "INDEX.HTM"), "<html><body>Summary</body></html>");
  fs.writeFileSync(path.join(dir, "1 of 1 - My Health Summary.PDF"), "%PDF-1.7 summary");
  fs.writeFileSync(path.join(xdm, "STYLE.XSL"), "<xsl:stylesheet/>");
  fs.mkdirSync(path.join(dir, "HTML", "IMAGES"), { recursive: true });
  fs.writeFileSync(path.join(dir, "HTML", "IMAGES", "logo.png"), "png");
  fs.mkdirSync(path.join(dir, "__MACOSX"), { recursive: true });
  fs.writeFileSync(path.join(dir, "__MACOSX", "._DOC0001.XML"), "junk");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
  return dir;
}

test("the ingest prompt hands the agent a file inventory instead of asking it to look around", () => {
  const dir = writeExport();
  try {
    const inventory = buildHealthSourceInventory(dir);
    const listed = inventory.join("\n");
    assert.ok(inventory.length >= 3);
    assert.ok(/DOC0001\.XML {2}\(\d+ bytes\)/.test(listed));
    assert.ok(listed.includes("My Health Summary.PDF"));
    assert.ok(listed.includes("INDEX.HTM"));
    // Stylesheets, images, Apple resource forks and dotfiles carry no health data.
    assert.equal(/STYLE\.XSL|logo\.png|__MACOSX|DS_Store/.test(listed), false);
    assert.ok(inventory.every((line) => path.isAbsolute(line.split("  (")[0])));

    const prompt = buildHealthIngestPrompt(dir, true, "clinical_summary", { inventory });
    assert.ok(prompt.includes("FILE INVENTORY"));
    assert.ok(prompt.includes("do NOT run shell commands or directory listings"));
    assert.ok(prompt.includes("use ONLY"));
    assert.ok(prompt.includes(inventory[0]));
    assert.ok(/already been extracted deterministically/i.test(prompt));

    // The single-file branch is untouched.
    const single = buildHealthIngestPrompt("/tmp/labs.pdf", false, "bloodwork");
    assert.equal(single.includes("FILE INVENTORY"), false);
    assert.equal(single, buildHealthIngestPrompt("/tmp/labs.pdf", false, "bloodwork", { inventory }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a degraded ingest explains itself in the athlete's words", () => {
  const withAvailability = new AgentFallbackError(
    ["claude", "codex", "grok", "antigravity"],
    [
      { agent: "claude", error: "exit 1", availability: { state: "weekly_limit", detail: "weekly limit, resets Tue 8:00 AM" } },
      { agent: "codex", error: "exit 1", availability: { state: "usage_limit", detail: "usage limit until Sep 18" } },
      { agent: "grok", error: "exit 1", availability: { state: "needs_credit" } },
      { agent: "antigravity", error: "no output produced" },
    ]
  );
  const described = describeAgentDegrade(withAvailability);
  assert.equal(described.reason, "weekly_limit");
  assert.ok(described.detail.startsWith("Claude: weekly limit, resets Tue 8:00 AM · Codex: usage limit until Sep 18"));
  assert.ok(described.detail.includes("Grok: needs credit"));
  assert.ok(described.detail.includes("Antigravity: invalid output"));
  assert.ok(described.detail.length <= 240);

  // No availability read attached (the sibling stream absent): the attempt's error
  // CLASS still carries the story, under a taxonomy-only reason.
  const bare = new AgentFallbackError(["claude"], [{ agent: "claude", error: "timed out" }]);
  assert.deepEqual(describeAgentDegrade(bare), { reason: "no_valid_output", detail: "Claude: timeout" });
  assert.equal(describeAgentDegrade(new Error("boom")).reason, "no_valid_output");

  // …and NEVER the raw text. On the throw path `attempt.error` is stderr, and this
  // string is persisted into health_documents.parsed_json.ingest.detail and printed
  // on the card — a stack frame, a home directory or a provider URL cannot go there.
  const rawStderr = new AgentFallbackError(
    ["codex"],
    [
      {
        agent: "codex",
        error:
          "Error: ENOENT: spawn /Users/someone/.local/bin/codex\n    at ChildProcess.handle (node:internal/child_process:1234)\n  see https://chatgpt.com/explore/plus",
      },
    ]
  );
  const described2 = describeAgentDegrade(rawStderr);
  assert.doesNotMatch(described2.detail, /Users|node:internal|ChildProcess|https?:/);
  assert.equal(described2.detail, "Codex: unknown error");
});

test("an import that only the deterministic pass could read says so on the row", async () => {
  const dir = writeExport();
  try {
    repo.setSettings({
      enrich_enabled: true,
      agent_strategy: "priority",
      agent_order: [],
      disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"],
    });
    const doc = repo.addHealthDocument({
      kind: "clinical_summary",
      original_name: "health_summary_mychart.zip",
      mime: "application/zip",
      file_path: dir,
      enrichment_status: "pending",
    });

    enqueueEnrich("health", doc.id);
    let after = repo.getHealthDocument(doc.id);
    for (let i = 0; i < 80; i++) {
      after = repo.getHealthDocument(doc.id);
      if (!["pending", "in_progress"].includes(after.enrichment_status)) break;
      await sleep(50);
    }

    assert.equal(after.enrichment_status, "done");
    assert.equal(after.parsed.ingest.mode, "deterministic");
    assert.equal(after.parsed.ingest.reason, "no_agent_enabled");
    assert.ok(after.parsed.ingest.detail.length > 0);
    assert.ok(Date.parse(after.parsed.ingest.at) > 0);
    // The labs really did land, on their own dated panel.
    const derived = db
      .prepare(`SELECT parsed_json FROM health_documents WHERE source_doc_id = ?`)
      .all(doc.id)
      .map((r) => JSON.parse(r.parsed_json));
    assert.ok(derived.some((p) => p.type === repo.CCDA_RESULTS_TYPE && p.markers.some((m) => m.name === "Total Cholesterol")));

    const events = db.prepare(`SELECT * FROM diagnostic_events WHERE kind = 'degraded'`).all();
    assert.equal(events.length, 1);
    assert.equal(events[0].level, "warning");
    assert.equal(events[0].source, "worker");
    assert.equal(events[0].fingerprint, "worker:degraded:enrichment:health:no_agent_enabled");
    assert.equal(/mychart|\//i.test(String(events[0].message)), false, "the message stays taxonomy-only");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings", "diagnostic_events");
  }
});

test("a later full agent read clears the degraded mark", () => {
  const doc = repo.addHealthDocument({
    kind: "clinical_summary",
    original_name: "health_summary_mychart.zip",
    enrichment_status: "done",
    parsed_json: {
      markers: [],
      clinical_facts: [{ kind: "allergy", name: "No known active allergies" }],
      ingest: { mode: "deterministic", reason: "weekly_limit", detail: "Claude: weekly limit", at: "2026-08-24T12:00:00.000Z" },
    },
  });
  try {
    assert.equal(repo.getHealthDocument(doc.id).parsed.ingest.mode, "deterministic");
    const applied = applyHealthIngest(doc.id, {
      panels: [
        {
          doc_date: "2026-08-24",
          kind: "bloodwork",
          summary: "Lipids are up since spring.",
          markers: [{ name: "Total Cholesterol", value: 262, unit: "mg/dL", flag: "high" }],
        },
      ],
      summary: "One lipid panel, read in full.",
    });
    assert.equal(applied, true);
    const after = repo.getHealthDocument(doc.id);
    assert.equal(after.parsed.ingest, undefined, "an agent read that landed is not a degraded one");
    assert.equal(after.summary, "Lipids are up since spring.");
    assert.equal(after.parsed.markers[0].name, "Total Cholesterol");
  } finally {
    resetTables("health_documents");
  }
});
