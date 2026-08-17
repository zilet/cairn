import { test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";
import { MIGRATIONS } from "../dist/migrate.js";
import {
  clampProposalProvenanceDates,
  normalizeStoredProposalPayload,
  prepareProposalPayload,
} from "../dist/repo/proposal-truth.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

// The production incident this file pins: `inferredEvidenceDate` returned the first ISO
// date it found in a reason's prose UNCLAMPED, so a reason naming a forward window
// ("Suspend Z4 for 2026-08-09 → 2026-08-22") stored an evidence_date in its own future.
// Nothing caught it on the way in, and every later rehydration threw
// "evidence_date cannot be after as_of_date" — taking the whole listProposals call, and
// with it the scheduler's draft-adoption sweep, down with it on every tick.

// The poison payload goes in through raw SQL on purpose: the write path now refuses to
// create one, so the only way to reproduce a row already on disk is to write it directly.
function insertRawProposal(parsed, { createdAt } = {}) {
  const info = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json) VALUES (?, ?, ?, ?)`)
    .run("stub", "raw seeded proposal", "", JSON.stringify(parsed));
  const id = Number(info.lastInsertRowid);
  if (createdAt) db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(createdAt, id);
  return id;
}

function futureEvidencePayload(asOf) {
  const future = addDaysISO(asOf, 14);
  return {
    summary: "A protective endurance adjustment",
    as_of_date: asOf,
    proposal_truth: {
      version: 1,
      evidence: {
        version: 1,
        as_of_date: asOf,
        window_start: addDaysISO(asOf, -42),
        observed_through_date: asOf,
        latest_training_date: addDaysISO(asOf, -2),
        fingerprint: "seeded",
        plan_fingerprint: "seeded-plan",
        training_fingerprint: "seeded-training",
      },
    },
    changes: [
      {
        day_number: 1,
        exercise: "Back Squat",
        target_weight: 185,
        reason: `Suspend Z4 for ${asOf} through ${future} while the ankle settles.`,
        reason_provenance: {
          reason_code: "training_evidence",
          evidence_date: future,
          as_of_date: asOf,
          source_ref_type: "training_evidence_snapshot",
          source_ref_key: "seeded",
        },
      },
    ],
  };
}

test("inference clamps a future ISO date found in reason prose down to as_of", () => {
  const asOf = localDateISO();
  const future = addDaysISO(asOf, 21);
  // No provenance supplied at all, so the evidence date comes purely from inference over
  // the prose — which names a date in the future. That is the exact shape that poisoned
  // live rows 71 and 72.
  const prepared = prepareProposalPayload({
    summary: "Hold the hard runs while the ankle settles",
    changes: [
      {
        day_number: 2,
        exercise: "Tempo Run",
        target_weight: null,
        reason: `Suspend Z4 work for ${asOf} through ${future}.`,
      },
    ],
  });

  const provenance = prepared.changes[0].reason_provenance;
  assert.ok(provenance, "the write path stamps provenance on a reason");
  assert.equal(provenance.as_of_date, asOf);
  assert.ok(
    provenance.evidence_date <= asOf,
    `evidence_date ${provenance.evidence_date} must never sit after as_of ${asOf}`
  );
  assert.equal(provenance.evidence_date, asOf, "the clamp pulls it back onto as_of, it does not invent a date");
});

test("the write path still REFUSES a supplied evidence_date after as_of", () => {
  const asOf = localDateISO();
  // The read path clamps; the write path must keep throwing exactly as before, so a
  // caller can never store a contradiction in the first place.
  assert.throws(
    () =>
      prepareProposalPayload({
        summary: "A change with impossible provenance",
        as_of_date: asOf,
        changes: [
          {
            day_number: 1,
            exercise: "Back Squat",
            target_weight: 185,
            reason: "The last two comparable exposures held.",
            reason_provenance: {
              reason_code: "training_evidence",
              evidence_date: addDaysISO(asOf, 5),
              as_of_date: asOf,
            },
          },
        ],
      }),
    /evidence_date cannot be after as_of_date/
  );
});

test("rehydration CLAMPS a stored future evidence_date instead of throwing", () => {
  const asOf = addDaysISO(localDateISO(), -9);
  const payload = futureEvidencePayload(asOf);

  let hydrated;
  assert.doesNotThrow(() => {
    hydrated = normalizeStoredProposalPayload(payload, `${asOf} 08:00:00`);
  }, "a row already on disk cannot be un-stored, so hydration must never throw on it");

  const provenance = hydrated.changes[0].reason_provenance;
  assert.equal(provenance.evidence_date, asOf, "the stored evidence_date is clamped down to its own as_of");
  assert.equal(provenance.as_of_date, asOf, "as_of itself is left exactly as stored");
});

test("rehydration keeps a stored as_of that disagrees with the payload's", () => {
  const payloadAsOf = localDateISO();
  const ownerAsOf = addDaysISO(payloadAsOf, -4);
  const hydrated = normalizeStoredProposalPayload(
    {
      summary: "A change whose reason carries an older as_of",
      as_of_date: payloadAsOf,
      changes: [
        {
          day_number: 1,
          exercise: "Back Squat",
          target_weight: 185,
          reason: "The last two comparable exposures held.",
          reason_provenance: {
            reason_code: "training_evidence",
            evidence_date: ownerAsOf,
            as_of_date: ownerAsOf,
          },
        },
      ],
    },
    `${payloadAsOf} 08:00:00`
  );
  assert.equal(
    hydrated.changes[0].reason_provenance.as_of_date,
    ownerAsOf,
    "a stored as_of mismatch is kept, not thrown on and not rewritten to today"
  );
});

test("one poison row does not take listProposals down with it", () => {
  const asOf = addDaysISO(localDateISO(), -9);
  const healthy = repo.createProposal("stub", "a healthy draft", "", {
    summary: "A bounded target nudge",
    changes: [{ day_number: 1, exercise: "Back Squat", target_weight: 190, reason: "The last two exposures held." }],
  });
  // parsed_json that is not even JSON: normalization cannot repair this one, so it is
  // the case the per-row quarantine exists for.
  const poisonId = insertRawProposal(futureEvidencePayload(asOf));
  db.prepare(`UPDATE plan_proposals SET parsed_json = ? WHERE id = ?`).run("{not json at all", poisonId);

  let listed;
  assert.doesNotThrow(() => {
    listed = repo.listProposals(50);
  }, "the list survives a row it cannot hydrate");

  const ids = listed.map((row) => Number(row.id));
  assert.ok(ids.includes(Number(healthy.id)), "the healthy row is still returned");
  assert.ok(ids.includes(poisonId), "the unreadable row is returned too, not silently dropped");
  const quarantined = listed.find((row) => Number(row.id) === poisonId);
  assert.equal(quarantined.parsed, null, "an unparseable payload hydrates as null, never as a half-built object");
});

test("a stored future evidence_date hydrates through listProposals without throwing", () => {
  const asOf = addDaysISO(localDateISO(), -9);
  const id = insertRawProposal(futureEvidencePayload(asOf), { createdAt: `${asOf} 08:00:00` });

  let listed;
  assert.doesNotThrow(() => {
    listed = repo.listProposals(50);
  });
  const row = listed.find((entry) => Number(entry.id) === id);
  assert.ok(row, "the row is returned");
  assert.equal(row.hydration_error, undefined, "the clamp repairs it, so it is not quarantined at all");
  assert.equal(row.parsed.changes[0].reason_provenance.evidence_date, asOf);
});

test("migration 92 pulls a stored future evidence_date back onto its as_of", () => {
  const asOf = addDaysISO(localDateISO(), -9);
  const future = addDaysISO(asOf, 14);
  const badId = insertRawProposal(futureEvidencePayload(asOf), { createdAt: `${asOf} 08:00:00` });
  const goodId = insertRawProposal(
    {
      summary: "Provenance that was already consistent",
      as_of_date: asOf,
      changes: [
        {
          day_number: 1,
          exercise: "Bench Press",
          target_weight: 155,
          reason: "The last two comparable exposures held.",
          reason_provenance: { reason_code: "training_evidence", evidence_date: asOf, as_of_date: asOf },
        },
      ],
    },
    { createdAt: `${asOf} 08:00:00` }
  );
  const goodBefore = db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(goodId).parsed_json;

  // Confirm the seeded row really is poisonous before the repair runs.
  const stored = JSON.parse(db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(badId).parsed_json);
  assert.equal(stored.changes[0].reason_provenance.evidence_date, future);

  const migration = MIGRATIONS.find((entry) => entry.version === 92);
  assert.ok(migration, "migration 92 exists");
  migration.up(db);

  const repaired = JSON.parse(db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(badId).parsed_json);
  assert.equal(repaired.changes[0].reason_provenance.evidence_date, asOf, "clamped down to as_of");
  assert.equal(repaired.changes[0].reason_provenance.as_of_date, asOf, "as_of untouched");
  assert.equal(repaired.changes[0].reason, stored.changes[0].reason, "reason prose is not rewritten by the repair");
  assert.equal(
    db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(goodId).parsed_json,
    goodBefore,
    "a consistent row is left byte-identical"
  );

  // Idempotent: a second pass finds nothing left above its as_of.
  migration.up(db);
  const twice = JSON.parse(db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(badId).parsed_json);
  assert.deepEqual(twice, repaired);
});

test("migration 92 survives a row whose parsed_json is not JSON", () => {
  const id = insertRawProposal({ summary: "placeholder" });
  db.prepare(`UPDATE plan_proposals SET parsed_json = ? WHERE id = ?`).run("{not json at all", id);
  const migration = MIGRATIONS.find((entry) => entry.version === 92);
  assert.doesNotThrow(() => migration.up(db));
  assert.equal(
    db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(id).parsed_json,
    "{not json at all",
    "an unreadable payload is left exactly as stored"
  );
});

test("the clamp helper reaches every reason site a payload can carry", () => {
  const asOf = "2026-08-08";
  const future = "2026-08-23";
  const provenance = () => ({ reason_code: "training_evidence", evidence_date: future, as_of_date: asOf });
  const payload = {
    rationale: "why",
    rationale_provenance: provenance(),
    changes: [{ reason: "a", reason_provenance: provenance() }],
    cardio: [{ reason: "b", reason_provenance: provenance() }],
    days: [{ items: [{ reason: "c", reason_provenance: provenance() }] }],
  };
  assert.equal(clampProposalProvenanceDates(payload), 4, "rationale, change, cardio and day item all clamped");
  assert.equal(payload.rationale_provenance.evidence_date, asOf);
  assert.equal(payload.changes[0].reason_provenance.evidence_date, asOf);
  assert.equal(payload.cardio[0].reason_provenance.evidence_date, asOf);
  assert.equal(payload.days[0].items[0].reason_provenance.evidence_date, asOf);
  assert.equal(clampProposalProvenanceDates(payload), 0, "idempotent");
});
