// The reversal safeguard has to survive a BUSY domain — which is the only kind of
// domain it exists for.
//
// domainIsDemoted asks "have enough of this domain's recent led changes been reverted
// that it should stop leading and start asking?". It used to answer by pulling the last
// 100 decisions in the domain (`ORDER BY id DESC`) and filtering tier and date in JS.
// Every ask-tier row, every review row, every row older than the ninety-day window
// still consumed one of those 100 slots. So in a domain doing real volume the fetch
// filled up with rows that all failed the filter, the guard read an empty set, and it
// quietly stopped firing — a safeguard that switches itself off under load, with
// nothing anywhere saying it did.
//
// The predicates now live in SQL, the way materialChangesThisWeek's always have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { domainIsDemoted } from "../dist/domain/brain/autonomy-service.js";
import { domainShouldDemote } from "../dist/brain/autonomy.js";

const insertDecision = db.prepare(
  `INSERT INTO brain_decisions
     (created_at, effective_date, kind, domain, summary, rationale, source, status, autonomy_tier,
      risk_class, reversible, context_json, action_json, evaluator_version)
   VALUES (?, ?, 'training_target', ?, ?, 'Recorded so the ledger can be counted.',
           ?, ?, ?, 'low', 1, '{}', '{}', 'demotion-test-v1')`
);

function tsDaysAgo(daysAgo) {
  return new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 19).replace("T", " ");
}

function seedDecisions({ domain = "training", n, status, tier, daysAgo, source = "test" }) {
  for (let i = 0; i < n; i++) {
    insertDecision.run(tsDaysAgo(daysAgo), "2026-01-01", domain, `${status} ${tier} ${i}.`, source, status, tier);
  }
}

// The reversal record that SHOULD demote: three of five led changes taken back.
function seedReversalRecord(daysAgo = 30) {
  seedDecisions({ n: 3, status: "reverted", tier: "quiet_apply", daysAgo });
  seedDecisions({ n: 2, status: "applied", tier: "quiet_apply", daysAgo });
}

// The volume that used to hide it: more ask-tier rows than the old fetch could hold,
// all NEWER than the reversals, so `ORDER BY id DESC LIMIT 100` saw nothing else.
function seedAskTierVolume(n = 120) {
  seedDecisions({ n, status: "review", tier: "ask", daysAgo: 1 });
}

test("the reversal record demotes a quiet domain", () => {
  seedReversalRecord();
  assert.equal(domainShouldDemote(3, 5), true, "the policy itself says three of five is enough");
  assert.equal(domainIsDemoted("training"), true);
});

test("…and still demotes it once the domain gets busy", () => {
  seedReversalRecord();
  seedAskTierVolume(120);

  // The exact shape of the old bug: every row the old fetch would have returned fails
  // the tier filter, so the JS-side count was zero.
  const newestHundred = db
    .prepare(`SELECT autonomy_tier FROM brain_decisions WHERE domain = 'training' ORDER BY id DESC LIMIT 100`)
    .all();
  assert.equal(newestHundred.length, 100);
  assert.ok(
    newestHundred.every((row) => row.autonomy_tier === "ask"),
    "the newest hundred rows are all ask-tier, as a busy domain's are"
  );

  assert.equal(domainIsDemoted("training"), true, "the safeguard still fires under load");
});

test("volume alone never demotes a domain that has not reverted anything", () => {
  seedAskTierVolume(120);
  seedDecisions({ n: 5, status: "applied", tier: "quiet_apply", daysAgo: 30 });

  assert.equal(domainIsDemoted("training"), false, "led changes that stuck are not a reversal record");
});

test("only the last ninety days count, and only this domain", () => {
  seedReversalRecord(200);
  assert.equal(domainIsDemoted("training"), false, "a reversal record that has aged out is spent");

  seedDecisions({ domain: "nutrition", n: 3, status: "reverted", tier: "announce", daysAgo: 30 });
  seedDecisions({ domain: "nutrition", n: 2, status: "applied", tier: "announce", daysAgo: 30 });
  assert.equal(domainIsDemoted("nutrition"), true, "nutrition's own record demotes nutrition");
  assert.equal(domainIsDemoted("training"), false, "…and never leaks into training");
});

test("rows that were never led, and rows that never landed, are not part of the ratio", () => {
  // Three reverted ask-tier rows are three changes the athlete was ASKED about and
  // said no to — a veto, not a reversal of something Cairn led. They must not count.
  seedDecisions({ n: 3, status: "reverted", tier: "ask", daysAgo: 30 });
  seedDecisions({ n: 2, status: "applied", tier: "quiet_apply", daysAgo: 30 });
  seedDecisions({ n: 4, status: "canceled", tier: "quiet_apply", daysAgo: 30 });
  seedDecisions({ n: 4, status: "announced", tier: "announce", daysAgo: 30 });

  assert.equal(domainIsDemoted("training"), false);
});
