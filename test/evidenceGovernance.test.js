import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { db } from "../dist/db.js";
import { runMigrations } from "../dist/migrate.js";
import { downgradedEvidenceConfidence, evidenceFreshness, verifyClaimToSource } from "../dist/evidenceGovernance.js";
import { EVIDENCE_PACK } from "../dist/evidencePack.js";
import * as evidence from "../dist/repo/evidence.js";

test("freshness and confidence downgrade deterministically against a fixed clock", () => {
  assert.equal(evidenceFreshness({ expires_at: "2026-08-31" }, "2026-07-01"), "current");
  assert.equal(evidenceFreshness({ expires_at: "2026-07-20" }, "2026-07-01"), "review_due");
  assert.equal(evidenceFreshness({ expires_at: "2026-06-30" }, "2026-07-01"), "expired");
  assert.equal(evidenceFreshness({}, "2026-07-01"), "unknown");
  assert.equal(downgradedEvidenceConfidence("high", "review_due", "claim_source"), "moderate");
  assert.equal(downgradedEvidenceConfidence("high", "expired", "claim_source"), "low");
  assert.equal(downgradedEvidenceConfidence("high", "current", "source_only"), "low");
});

test("claim-to-source verification rejects title-only and topic-mismatched evidence", () => {
  assert.equal(
    verifyClaimToSource({
      claim: "ApoB particle burden tracks cardiovascular risk.",
      body: "ApoB particle burden is associated with cardiovascular risk.",
      marker: "ApoB",
      source_title: "Lipid consensus statement",
      source_url: "https://www.ahajournals.org/doi/example",
    }).verified,
    true
  );

  assert.equal(
    verifyClaimToSource({
      claim: "ApoB particle burden tracks cardiovascular risk.",
      body: "This paper discusses sleep duration and circadian timing.",
      marker: "Sleep",
      source_title: "AHA review",
      source_url: "https://www.ahajournals.org/doi/example",
    }).reason,
    "topic_mismatch"
  );

  assert.equal(
    verifyClaimToSource({
      claim: "A sourced-looking claim",
      body: "A sourced-looking supporting sentence",
      source_title: "Example paper",
      source_url: "https://example.com/paper",
    }).reason,
    "invalid_url"
  );
});

test("evidence rows persist provenance scope/version/review/expiry and expose effective confidence", () => {
  const row = evidence.addEvidence({
    topic: "apob risk",
    marker: "ApoB",
    claim: "ApoB particle burden is associated with cardiovascular risk.",
    body: "ApoB particle burden tracks atherogenic cardiovascular risk.",
    source_title: "Sports Cardiology Athlete Consensus 2025",
    source_url: "https://journals.sportsmedicine.org/apob-athletes",
    source_scope: "athlete",
    source_version: "2025.1",
    published_at: "2025-03-01",
    reviewed_at: "2026-07-01",
    expires_at: "2026-12-31",
    confidence: "high",
  });
  assert.equal(row.source_scope, "athlete");
  assert.equal(row.source_version, "2025.1");
  assert.equal(row.provenance.verification_status, "claim_source");
  assert.equal(row.provenance.usable_for_claim, true);
  assert.equal(row.effective_confidence, "high");
  const verified = evidence.verifyCitation(row.source_title, row.source_url, row.claim, row.marker);
  assert.equal(verified.verified, true);
  assert.equal(verified.source_scope, "athlete");

  const clinician = evidence.addEvidence({
    marker: "Ferritin",
    claim: "The clinician requested a repeat ferritin after the intervention window.",
    body: "The clinician requested a repeat ferritin after the intervention window.",
    source_title: "Clinician care plan",
    source_url: "https://records.healthsystem.org/care-plan/1",
    source_scope: "clinician",
  });
  assert.equal(clinician.provenance.source_scope, "clinician");
});

test("organization names alone no longer verify material claims", () => {
  const verdict = evidence.verifyCitation("WHO 2023 physical activity guidelines");
  assert.equal(verdict.verified, false);
  assert.equal(verdict.uncertain, true);
  assert.equal(verdict.reason, "organization_only");
  assert.equal(verdict.citation, null);
});

test("the curated pack verifies only when the claim is tied to its source record", () => {
  const ferritin = EVIDENCE_PACK.find((entry) => entry.id === "ferritin");
  assert.ok(ferritin);
  const verified = evidence.verifyCitation(
    ferritin.source,
    ferritin.source_url,
    ferritin.summary,
    ferritin.markers.join(" ")
  );
  assert.equal(verified.verified, true);
  assert.equal(verified.verification_status, "claim_source");
  assert.equal(verified.source_scope, "general");
  assert.equal(verified.source_version, ferritin.source_version);
  assert.equal(verified.reviewed_at, ferritin.reviewed_at);
  assert.equal(verified.expires_at, ferritin.expires_at);

  const mismatched = evidence.verifyCitation(
    ferritin.source,
    ferritin.source_url,
    "This source proves that sprint intervals cure sleep apnea.",
    "Sleep"
  );
  assert.equal(mismatched.verified, false);
  assert.equal(mismatched.reason, "claim_mismatch");
});

test("expired cached evidence stays inspectable but is downgraded and unusable", () => {
  const row = evidence.addEvidence({
    topic: "old lipid evidence",
    marker: "ApoB",
    claim: "ApoB particle burden is associated with cardiovascular risk.",
    body: "ApoB particle burden tracks atherogenic cardiovascular risk.",
    source_title: "Journal of Lipid Evidence 2020",
    source_url: "https://journals.lipidscience.org/apob-2020",
    reviewed_at: "2020-01-01",
    expires_at: "2020-06-01",
    confidence: "high",
  });
  assert.equal(row.freshness, "expired");
  assert.equal(row.effective_confidence, "low");
  assert.equal(row.provenance.usable_for_claim, false);

  const verdict = evidence.verifyCitation(row.source_title, row.source_url, row.claim, row.marker);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.uncertain, true);
  assert.equal(verdict.reason, "expired");
  assert.equal(verdict.citation, row.source_title, "stale provenance remains inspectable");
});

test("migration v60 exposes every evidence-governance column", () => {
  const cols = new Set(
    db
      .prepare("PRAGMA table_info(evidence_cache)")
      .all()
      .map((row) => row.name)
  );
  for (const name of [
    "source_scope",
    "source_version",
    "published_at",
    "reviewed_at",
    "expires_at",
    "verification_status",
  ])
    assert.ok(cols.has(name), `missing ${name}`);
});

test("migration v60 backfills legacy evidence as source-only with a review window", () => {
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`CREATE TABLE evidence_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT, marker TEXT, claim TEXT, source_title TEXT, source_url TEXT,
    body TEXT, confidence TEXT, retrieved_at TEXT DEFAULT (datetime('now'))
  )`);
  legacy.exec(`INSERT INTO evidence_cache
    (topic, claim, source_title, source_url, body, confidence, retrieved_at)
    VALUES ('legacy', 'legacy claim', 'Legacy source', 'https://www.nih.gov/legacy', 'legacy body', 'high', '2026-01-01 00:00:00')`);
  legacy.exec("PRAGMA user_version = 59");
  runMigrations(legacy);
  const row = legacy.prepare("SELECT * FROM evidence_cache").get();
  assert.equal(row.source_scope, "general");
  assert.equal(row.verification_status, "source_only");
  assert.equal(row.reviewed_at, "2026-01-01 00:00:00");
  assert.equal(row.expires_at, "2026-04-01 00:00:00");
  legacy.close();
});
