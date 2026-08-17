// The temporal law for reason provenance, with no database behind it.
//
// Evidence is what has ALREADY happened, so an `evidence_date` can never sit after
// the `as_of_date` it is evidence for. This module holds the one clamp that enforces
// that and the one walk over a proposal payload that applies it, deliberately free of
// any `db` import: `src/migrate.ts` is statically imported by `src/db.ts`, so a
// migration can only reuse a helper that does not import the database back (the same
// reason metabolism-core and expectation-arbitration exist as their own modules).
//
// Both callers live elsewhere: `src/repo/proposal-truth.ts` runs it on the rehydration
// path, and migration 92 runs it once over the rows already on disk.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function isoDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!ISO_DATE.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

// THE clamp. Non-ISO input is returned untouched — this decides dates, it does not
// validate shapes, and a caller that wants a refusal does its own check first.
export function clampEvidenceDate(evidenceDate: string, asOfDate: string): string {
  const evidence = isoDate(evidenceDate);
  const asOf = isoDate(asOfDate);
  if (!evidence || !asOf) return evidenceDate;
  return evidence > asOf ? asOf : evidence;
}

// Every place a proposal payload carries a reason and the provenance behind it, in one
// walk, so a new reason site is picked up everywhere at once.
export function proposalProvenanceOwners(payload: Record<string, any>): Array<Record<string, any>> {
  const owners: Array<Record<string, any>> = [];
  const rationale = record(payload.rationale_provenance);
  if (rationale) owners.push(rationale);
  const lists = [
    Array.isArray(payload.changes) ? payload.changes : [],
    Array.isArray(payload.cardio) ? payload.cardio : [],
    (Array.isArray(payload.days) ? payload.days : []).flatMap((day: any) =>
      Array.isArray(day?.items) ? day.items : []
    ),
  ];
  for (const list of lists) {
    for (const entry of list) {
      const provenance = record(record(entry)?.reason_provenance);
      if (provenance) owners.push(provenance);
    }
  }
  return owners;
}

// Repair for provenance already written: pull any evidence_date that sits after its own
// as_of_date back onto that date. Mutates in place and reports how many it moved.
// Idempotent by construction — a second pass finds nothing left above its as_of.
export function clampProposalProvenanceDates(payload: unknown): number {
  const source = record(payload);
  if (!source) return 0;
  let clamped = 0;
  for (const provenance of proposalProvenanceOwners(source)) {
    const evidenceDate = isoDate(provenance.evidence_date);
    const asOfDate = isoDate(provenance.as_of_date);
    if (!evidenceDate || !asOfDate || evidenceDate <= asOfDate) continue;
    provenance.evidence_date = asOfDate;
    clamped += 1;
  }
  return clamped;
}
