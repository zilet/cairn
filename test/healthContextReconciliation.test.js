import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

beforeEach(() => resetTables("context_events", "health_documents", "day_reads"));

test("visit note reconciliation links and resolves a planned PCP context event", () => {
  const event = repo.addContextEvent({
    kind: "life_event",
    title: "PCP appointment — discuss blood work",
    detail: "Primary care visit to review labs.",
    start_date: "2026-07-07",
  });
  const doc = repo.addHealthDocument({
    kind: "visit_note",
    doc_date: "2026-07-07",
    original_name: "Pasted results",
    summary: "Televisit Adult Patient Visit on 2026-07-07 documented follow-up labs.",
    parsed_json: {
      markers: [],
      clinical_facts: [
        { kind: "encounter", date: "2026-07-07", name: "Televisit Adult Patient Visit", status: "completed", source: "visit note" },
      ],
    },
    enrichment_status: "done",
  });

  const matches = repo.reconcileHealthDocumentContextEvents(doc.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].event_id, event.id);
  assert.equal(matches[0].resolved_at, "2026-07-07");

  const after = repo.getContextEvent(event.id);
  assert.equal(after.resolved_at, "2026-07-07");
  assert.equal(after.meta.matched_health_doc.id, doc.id);
  assert.equal(after.meta.matched_health_doc.kind, "visit_note");
  assert.equal(repo.listContextEvents({ activeOnly: true }).some((e) => e.id === event.id), false);
});

test("visit note reconciliation adds provenance to an already-resolved PCP event", () => {
  const event = repo.addContextEvent({
    kind: "life_event",
    title: "PCP appointment — discuss blood work",
    start_date: "2026-07-07",
  });
  repo.resolveContextEvent(event.id, "2026-07-07");
  const doc = repo.addHealthDocument({
    kind: "after_visit_summary",
    doc_date: "2026-07-07",
    summary: "After Visit Summary for primary care appointment.",
    parsed_json: {
      markers: [],
      clinical_facts: [
        { kind: "encounter", date: "2026-07-07", name: "Office visit", status: "completed", source: "After Visit Summary" },
      ],
    },
    enrichment_status: "done",
  });

  const matches = repo.reconcileHealthDocumentContextEvents(doc.id);
  assert.equal(matches.length, 1);
  const after = repo.getContextEvent(event.id);
  assert.equal(after.resolved_at, "2026-07-07");
  assert.equal(after.meta.matched_health_doc.id, doc.id);
  assert.equal(after.meta.matched_health_doc.kind, "after_visit_summary");
});

test("visit note reconciliation ignores unrelated life events", () => {
  const event = repo.addContextEvent({
    kind: "life_event",
    title: "Cambridge Half Marathon",
    start_date: "2026-07-07",
  });
  const doc = repo.addHealthDocument({
    kind: "visit_note",
    doc_date: "2026-07-07",
    summary: "Televisit Adult Patient Visit on 2026-07-07 documented follow-up labs.",
    parsed_json: { markers: [], clinical_facts: [{ kind: "encounter", date: "2026-07-07", name: "Televisit Adult Patient Visit", status: "completed" }] },
    enrichment_status: "done",
  });

  assert.deepEqual(repo.reconcileHealthDocumentContextEvents(doc.id), []);
  assert.equal(repo.getContextEvent(event.id).resolved_at, null);
});
