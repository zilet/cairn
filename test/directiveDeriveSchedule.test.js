// PERIODIC RE-DERIVATION of the connected brain (scheduler.ts "directive_derive_date").
//
// deriveDirectives() was always diff-based, idempotent, feedback-suppressing and
// age-aware — but nothing ran it on a timer, so on a quiet month the lab -> training
// propagation engine was dormant: a finding aged past a year without ever picking up its
// recheck note, a deleted panel's directives outlived their evidence, and a Done/Dismiss
// settled only when the next lab happened to land.
//
// This file proves the three edges that woke it up (the daily scheduler op, a document
// delete, a user status flip) plus the property all of them depend on: re-running the pass
// changes NOTHING when nothing moved — no rows, no ledger entries. Modelled on
// checkupAttention.test.js, including its practice of restating the op body so a drift in
// scheduler.ts shows up here.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker, isoDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "health_documents",
    "health_directives",
    "health_directive_history",
    "scheduler_operations",
    "app_state",
    "brain_decisions",
    "brain_expectations",
    "profile"
  );
});

// The exact op body the scheduler tick runs (kept in lockstep with scheduler.ts).
const propagationOp = () => {
  const hasMarkers = (repo.getMarkerHistory().markers || []).length > 0;
  if (!hasMarkers) return { outcome: "no_op" };
  return { outcome: "succeeded", value: repo.deriveDirectives() };
};

// Every physical directive row, the way directiveChurn.test.js snapshots them: ids AND
// statuses, so a soft-resolve-and-reinsert cannot hide behind a stable active count.
const allRows = () =>
  repo.listDirectives({ all: true }).map((d) => ({ id: d.id, status: d.status, key: d.directive_key }));

const activeRows = () => repo.listActiveDirectives().filter((d) => d.source === "markers");

const ledgerCount = () => db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n;

// ---- 1. the scheduler op itself ----

test("the propagation op runs deterministically and acknowledges its slot", async () => {
  seedHealthDoc(isoDaysAgo(30), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  const run = await repo.runSchedulerOperation("directive_derive_date", "2026-07-01", propagationOp);
  assert.equal(run.status, "succeeded");
  assert.ok(activeRows().length > 0, "the pass propagated the flagged panel into directives");
  assert.equal(
    repo.schedulerOperationDue("directive_derive_date", "2026-07-01"),
    false,
    "the slot is acknowledged after a successful pass"
  );
});

test("the propagation op is a calm no-op when no markers are on file", async () => {
  const run = await repo.runSchedulerOperation("directive_derive_date", "2026-07-02", propagationOp);
  assert.equal(run.status, "no_op");
  assert.equal(activeRows().length, 0);
});

test("a throw inside the propagation op is isolated as a retry, never a crash", async () => {
  const run = await repo.runSchedulerOperation(
    "directive_derive_date",
    "2026-07-03",
    async () => {
      throw new Error("propagation blew up");
    },
    { backoffMs: [1_000] }
  );
  assert.equal(run.status, "retry_wait");
  assert.ok(run.operation.next_retry_at, "a failed pass schedules a bounded retry instead of propagating");
});

// ---- 2. time alone moves a directive (the whole reason a timer exists) ----

test("a reading older than a year picks up its recheck note and softens to uncertain", () => {
  seedHealthDoc(isoDaysAgo(400), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const rows = activeRows();
  assert.ok(rows.length > 0, "the aged panel still propagates");
  assert.ok(
    rows.every((d) => String(d.rationale || "").includes("a recheck would confirm it still holds")),
    "every directive from a year-old reading carries the recheck clause"
  );
  assert.ok(
    rows.every((d) => !!d.uncertain),
    "and is softened to uncertain"
  );

  // Re-running the aged pass the same day must not rewrite a thing — including with the
  // app_state short-circuit cleared, so the reconcile itself is what holds still.
  const firstAll = allRows();
  for (let pass = 0; pass < 3; pass++) {
    repo.setAppState("directive_derive_sig", "");
    repo.deriveDirectives();
  }
  assert.deepEqual(allRows(), firstAll, "re-deriving an aged panel churns zero rows");
});

test("a ~200-day reading gets the softer age note WITHOUT being flipped to uncertain", () => {
  // Baseline: the same panel drawn today, so the comparison isolates AGE.
  seedHealthDoc(isoDaysAgo(1), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const fresh = new Map(activeRows().map((d) => [d.directive_key, !!d.uncertain]));
  assert.ok(fresh.size > 0);
  assert.ok(
    [...fresh.values()].some((u) => u === false),
    "at least one fresh directive is confident (cited)"
  );

  resetTables("health_documents", "health_directives", "app_state");
  seedHealthDoc(isoDaysAgo(200), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const aged = activeRows();
  assert.deepEqual(
    aged.map((d) => d.directive_key).sort(),
    [...fresh.keys()].sort(),
    "the same directives are derived — the age note is additive, never a different set"
  );
  for (const d of aged) {
    assert.ok(
      String(d.rationale || "").includes("still the most recent one on file"),
      `the ~200-day note landed on ${d.directive_key}`
    );
    assert.ok(
      !String(d.rationale || "").includes("a recheck would confirm"),
      "the year-old clause does not fire at 200 days"
    );
    assert.equal(!!d.uncertain, fresh.get(d.directive_key), `${d.directive_key} keeps its original confidence`);
  }
});

// ---- 3. the two event edges ----

test("deleting the panel WITHDRAWS its directives — soft-resolved, never user feedback", () => {
  const doc = seedHealthDoc(isoDaysAgo(20), [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("Ferritin", 20, { unit: "ng/mL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const before = activeRows();
  assert.ok(before.length > 0);

  // The edge the DELETE route (and the delete_health_record MCP tool) now runs.
  repo.deleteHealthDocument(doc.id);
  repo.deriveDirectives();

  assert.equal(activeRows().length, 0, "nothing is left active once the evidence is gone");
  const withdrawn = db
    .prepare(`SELECT status, status_at FROM health_directives WHERE id IN (${before.map(() => "?").join(",")})`)
    .all(...before.map((d) => d.id));
  assert.equal(withdrawn.length, before.length);
  for (const row of withdrawn) {
    assert.equal(row.status, "resolved", "the row is soft-resolved, not deleted");
    assert.equal(row.status_at, null, "status_at stays NULL — a machine resolve is not a Done tap");
  }
});

test("a user Done/Dismiss re-derives synchronously; the engine's own writer does not", () => {
  seedHealthDoc(isoDaysAgo(20), [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("Ferritin", 20, { unit: "ng/mL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const rows = activeRows();
  assert.ok(rows.length >= 2, "the panel produced more than one directive to work with");
  const signature = () => repo.getAppState("directive_derive_sig");
  const before = signature();

  // updateDirective is ALSO what reconcileDirectives calls to update a row in place, so it
  // must never re-enter the pass: it records the feedback and leaves the stored signature
  // describing the world before the flip.
  repo.updateDirective(rows[0].id, { status: "dismissed" });
  assert.equal(signature(), before, "the raw writer does not re-derive (no re-entrancy from inside a pass)");

  // The USER path settles the board on the tap.
  repo.setDirectiveStatusByUser(rows[1].id, "dismissed");
  assert.notEqual(signature(), before, "the user flip re-ran the pass and stored the post-feedback signature");
  assert.equal(
    activeRows().filter((d) => d.directive_key === rows[1].directive_key).length,
    0,
    "no active twin of the dismissed directive survives the flip"
  );
  const settled = allRows();
  assert.equal(repo.deriveDirectives().derived, 0, "the very next pass has nothing left to do");
  assert.deepEqual(allRows(), settled, "…and touches no rows");
});

// ---- 4. a dismissal outlives every future pass, but never traps the athlete ----

test("a dismissal survives repeated re-derivation, and still resurfaces when the marker worsens", () => {
  seedHealthDoc(isoDaysAgo(30), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const target = activeRows()[0];
  assert.ok(target, "a directive to dismiss");
  repo.setDirectiveStatusByUser(target.id, "dismissed");
  const afterDismiss = allRows();

  for (let pass = 0; pass < 4; pass++) {
    repo.setAppState("directive_derive_sig", "");
    repo.deriveDirectives();
  }
  assert.deepEqual(allRows(), afterDismiss, "four more passes insert nothing and revive nothing");
  assert.equal(
    repo.listDirectives({ all: true }).find((d) => d.id === target.id).status,
    "dismissed",
    "the athlete's verdict stands"
  );
  assert.equal(
    activeRows().filter((d) => d.directive_key === target.directive_key).length,
    0,
    "no active twin crept back in"
  );

  // The escape hatch: a materially worse draw is new information, so the suppression lifts.
  seedHealthDoc(isoDaysAgo(1), [marker("ApoB", 190, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  assert.ok(
    activeRows().some((d) => d.directive_key === target.directive_key),
    "a materially worse marker resurfaces the dismissed directive"
  );
});

// ---- 5. the ledger stays quiet ----

test("unchanged re-derives accumulate ZERO brain-decision rows", () => {
  seedHealthDoc(isoDaysAgo(30), [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("Ferritin", 20, { unit: "ng/mL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const after = ledgerCount();
  assert.ok(after > 0, "the first pass recorded its directives");

  for (let pass = 0; pass < 5; pass++) {
    repo.setAppState("directive_derive_sig", "");
    repo.deriveDirectives();
  }
  assert.equal(ledgerCount(), after, "a daily pass over an unchanged panel writes no new ledger rows");
});
