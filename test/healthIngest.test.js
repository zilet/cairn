// Health-record ingestion robustness (the "extract EVERY marker" fix). A modern
// panel (e.g. Function Health) lists 100+ markers; a weaker model used to curate
// that down to "the interesting ones". These cases pin the three deterministic
// guards that make the ingest path complete: the Claude-first agent order, the
// generous per-panel cap, and the raw-text candidate estimator that detects a
// grossly short extraction so the path can re-run. Fully offline — no real agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { buildHealthIngestPrompt } from "../dist/prompt.js";

// A trimmed Function-Health-style paste: name / range-flag / value triples, plus
// the no-range markers (percentages, hormones, blood type) and qualitative urine
// results that models love to drop. 12 real markers under 2 section headers.
const PASTE = `Heart
Apolipoprotein B (ApoB)
Above Range
148 mg/dL
LDL-Cholesterol
Above Range
207 mg/dL (calc)
HDL-Cholesterol
In Range
56 mg/dL
Triglycerides
In Range
123 mg/dL
Lymphocytes %
49.9 %
Estradiol (E2)
33 pg/mL
ABO Group
O
Rhesus (Rh) Factor
Rh(d) Positive
Urine
Glucose - Urine
In Range
Negative
Color - Urine
In Range
Yellow
Specific Gravity - Urine
In Range
1.003
pH - Urine
In Range
7.0`;

test("estimateMarkerCandidates counts one value per marker (headers + flags excluded)", () => {
  const n = repo.estimateMarkerCandidates(PASTE);
  // 12 markers in the paste; the estimate is coarse but must land close, and must
  // NOT count the 2 section headers or the "In/Above Range" flag lines.
  assert.ok(n >= 11 && n <= 13, `expected ~12 candidates, got ${n}`);
});

test("estimateMarkerCandidates ignores flag words and section headers", () => {
  // Only headers + flags, no value lines → zero candidates (no false retries).
  const onlyNoise = "Autoimmunity\nIn Range\nAbove Range\nBelow Range\nHeart\nKidney\nYounger";
  assert.equal(repo.estimateMarkerCandidates(onlyNoise), 0);
  assert.equal(repo.estimateMarkerCandidates(""), 0);
  assert.equal(repo.estimateMarkerCandidates(null), 0);
});

test("estimateMarkerCandidates flags a grossly short extraction", () => {
  // The actual failure mode: a 111-line panel, an extraction of 44 → 44 < 0.8*est.
  const big = Array.from({ length: 111 }, (_, i) => `Marker ${i}\nIn Range\n${i + 1} mg/dL`).join("\n");
  const est = repo.estimateMarkerCandidates(big);
  assert.ok(est >= 100, `expected ~111 candidates, got ${est}`);
  assert.ok(44 < est * 0.8, "44 extracted should trip the retry threshold");
});

test("pickHealthAgentOrder prefers claude then codex, keeping the rest in order", () => {
  const order = repo.pickHealthAgentOrder(["claude", "codex"], {
    enabled: ["antigravity", "grok", "codex", "claude"],
  });
  assert.deepEqual(order, ["claude", "codex", "antigravity", "grok"]);
});

test("pickHealthAgentOrder honors an explicit health route ahead of the preference", () => {
  const order = repo.pickHealthAgentOrder(["claude", "codex"], {
    enabled: ["antigravity", "grok", "codex", "claude"],
    route: "grok",
  });
  assert.deepEqual(order, ["grok", "claude", "codex", "antigravity"]);
});

test("pickHealthAgentOrder falls through when the preferred agent is absent", () => {
  const order = repo.pickHealthAgentOrder(["claude", "codex"], {
    enabled: ["antigravity", "grok", "codex"],
  });
  assert.deepEqual(order, ["codex", "antigravity", "grok"]);
  // A single usable agent is returned as-is; none → [].
  assert.deepEqual(repo.pickHealthAgentOrder(["claude"], { enabled: ["grok"] }), ["grok"]);
  assert.deepEqual(repo.pickHealthAgentOrder(["claude"], { enabled: [] }), []);
});

test("replaceHealthPanels keeps a full 111-marker panel but caps a runaway one", () => {
  resetTables("health_documents");
  const source = repo.addHealthDocument({ kind: "bloodwork", doc_date: "2026-06-11", enrichment_status: "done" });

  const mk = (count) => Array.from({ length: count }, (_, i) => ({ name: `Marker ${i}`, value: i, unit: "mg/dL", flag: "normal" }));
  const created = repo.replaceHealthPanels(source.id, [
    { doc_date: "2026-06-11", kind: "bloodwork", summary: "full panel", markers: mk(111) },
    { doc_date: "2026-01-01", kind: "bloodwork", summary: "runaway", markers: mk(400) },
  ]);
  assert.equal(created.length, 2);
  const byDate = Object.fromEntries(created.map((c) => [c.doc_date, c.parsed.markers.length]));
  assert.equal(byDate["2026-06-11"], 111, "a real comprehensive panel is preserved whole");
  assert.equal(byDate["2026-01-01"], repo.MAX_MARKERS_PER_PANEL, "a runaway list is capped at the panel max");
  assert.ok(repo.MAX_MARKERS_PER_PANEL >= 111, "the cap must clear a comprehensive panel");
});

test("buildHealthIngestPrompt preserves non-marker MyChart facts separately", () => {
  const prompt = buildHealthIngestPrompt("/tmp/mychart-export", true, "other");
  assert.match(prompt, /clinical_facts/);
  assert.match(prompt, /medications/i);
  assert.match(prompt, /allergies/i);
  assert.match(prompt, /procedures\/surgeries/i);
  assert.match(prompt, /encounters\/visits/i);
  assert.match(prompt, /Do NOT force non-measurement sections into markers/);
});

test("replaceHealthPanels preserves bounded clinical facts on derived records", () => {
  resetTables("health_documents");
  const source = repo.addHealthDocument({ kind: "other", doc_date: "2026-06-11", enrichment_status: "done" });

  const created = repo.replaceHealthPanels(source.id, [
    {
      doc_date: "2026-04-02",
      kind: "other",
      summary: "Visit summary",
      markers: [],
      clinical_facts: [
        {
          kind: "procedure",
          date: "2026-04-02",
          name: "Right knee MRI",
          status: "completed",
          detail: "Sports medicine encounter",
          source: "Procedures",
        },
      ],
    },
  ]);

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].parsed.clinical_facts, [
    {
      kind: "procedure",
      date: "2026-04-02",
      name: "Right knee MRI",
      status: "completed",
      detail: "Sports medicine encounter",
      source: "Procedures",
    },
  ]);
});
