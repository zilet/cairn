import assert from "node:assert/strict";
import test from "node:test";
import { buildRecoveryMenu, recoveryMenuGrammarPool } from "../dist/repo/recovery-menu.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

test("buildRecoveryMenu is null for kinds other than rest/easy", () => {
  const date = localDaysAgo(0);
  assert.equal(buildRecoveryMenu(date, "train"), null);
  assert.equal(buildRecoveryMenu(date, "done"), null);
});

test("buildRecoveryMenu offers 2-3 options for a rest day and for an easy day", () => {
  resetTables("training_symptom_events");
  const date = localDaysAgo(0);
  for (const kind of ["rest", "easy"]) {
    const menu = buildRecoveryMenu(date, kind);
    assert.ok(menu, `expected a menu for kind=${kind}`);
    assert.equal(typeof menu.line, "string");
    assert.ok(menu.line.trim().length > 0);
    assert.ok(menu.options.length >= 2 && menu.options.length <= 3, `got ${menu.options.length} options`);
    for (const opt of menu.options) {
      assert.equal(typeof opt.label, "string");
      assert.ok(opt.label.trim().length > 0);
      assert.equal(typeof opt.detail, "string");
      assert.ok(opt.detail.trim().length > 0);
      assert.ok(opt.minutes === null || typeof opt.minutes === "number");
    }
  }
});

test("buildRecoveryMenu is deterministic for a fixed date and differs on consecutive dates", () => {
  resetTables("training_symptom_events");
  const date = localDaysAgo(3);
  const again = localDaysAgo(3);
  const first = buildRecoveryMenu(date, "rest");
  const second = buildRecoveryMenu(again, "rest");
  assert.deepEqual(first, second, "same date must produce the identical menu");

  const tomorrow = localDaysAgo(2); // one calendar day later than localDaysAgo(3)
  const next = buildRecoveryMenu(tomorrow, "rest");
  const sameLineAndOptions =
    JSON.stringify(first.options.map((o) => o.label).sort()) ===
      JSON.stringify(next.options.map((o) => o.label).sort()) && first.line === next.line;
  assert.ok(!sameLineAndOptions, "consecutive days should not read byte-identical");
});

test("an active, non-legacy training symptom guards the menu to a walk + steered mobility pair naming the area", () => {
  resetTables("training_symptom_events", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: date });

  const menu = buildRecoveryMenu(date, "rest");
  assert.ok(menu);
  assert.equal(menu.options.length, 2, "guarded mode drops the spin/core options");
  const labels = menu.options.map((o) => o.label);
  assert.ok(
    labels.some((l) => /walk/i.test(l)),
    "keeps a short walk"
  );
  assert.ok(
    labels.some((l) => /mobility/i.test(l)),
    "keeps a mobility option"
  );
  assert.ok(!labels.some((l) => /spin/i.test(l)), "drops the spin option");
  assert.ok(!labels.some((l) => /core/i.test(l)), "drops the core option");
  const mobilityOpt = menu.options.find((o) => /mobility/i.test(o.label));
  assert.match(mobilityOpt.detail, /knee/i, "the mobility detail names the flagged area");
});

test("a legacy-imported (unconfirmed) symptom never guards the menu", () => {
  resetTables("training_symptom_events", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  db.prepare(
    `INSERT INTO training_symptom_events
      (source_session_id, source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
     VALUES (NULL, 'legacy_note', 'left knee', 'active', ?, ?, 1)`
  ).run(date, date);

  const menu = buildRecoveryMenu(date, "rest");
  assert.ok(menu);
  assert.ok(menu.options.length >= 2 && menu.options.length <= 3);
  assert.ok(
    !menu.options.some((o) => /mobility/i.test(o.label) && /knee/i.test(o.detail)),
    "an unconfirmed legacy row must not steer the menu"
  );
});

test("a resolved symptom no longer guards the menu", () => {
  resetTables("training_symptom_events", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  const event = repo.reportTrainingSymptom({ area_text: "right shoulder", onset_on: localDaysAgo(5) });
  repo.resolveTrainingSymptom(event.id, localDaysAgo(2));

  const menu = buildRecoveryMenu(date, "easy");
  assert.ok(menu);
  assert.ok(!menu.options.some((o) => /shoulder/i.test(o.detail)), "a resolved symptom must not still steer the menu");
});

test("every line/label/detail string in the full recovery-menu vocabulary passes the reading grammar", () => {
  const pool = recoveryMenuGrammarPool();
  assert.ok(pool.length > 5);
  for (const text of pool) {
    assert.equal(violatesReadingGrammar(text), null, `violated grammar: ${JSON.stringify(text)}`);
  }
});

// ---- learned recovery bias (recovery_adjustment) ----
//
// Direction matters and is NOT the same as the step-size targets: reaction-model
// raises `recovery_adjustment` ABOVE 1 when recovery outcomes disappoint, because
// the thing being scaled is the recovery response itself. These pin that the menu
// reads it in one direction only.
function recoveryModifier(scale) {
  return {
    key: "recovery_hrv_delta::test",
    target: "recovery_adjustment",
    stage: null,
    scale,
    bounds: { min: 0.9, max: 1.15 },
    confidence: "observed",
    evidence_n: 3,
    rationale: "test fixture",
    never_overrides: [],
  };
}

test("a recovery_adjustment above 1 offers the gentler half of the same menu", () => {
  resetTables("training_symptom_events");
  // Cover every combo the day rotation can land on, not just today's.
  for (let daysAgo = 0; daysAgo < 5; daysAgo++) {
    const date = localDaysAgo(daysAgo);
    const gentle = buildRecoveryMenu(date, "rest", { responseModifier: recoveryModifier(1.1) });
    assert.ok(gentle, `expected a menu for ${date}`);
    assert.ok(gentle.options.length >= 2, `gentle menu kept ${gentle.options.length} options on ${date}`);
    assert.ok(
      !gentle.options.some((o) => /spin/i.test(o.label)),
      "the option that raises breathing is dropped when recovery evidence has been disappointing"
    );
    const walk = gentle.options.find((o) => /walk/i.test(o.label));
    if (walk) assert.ok(walk.minutes <= 12, `gentle walk should be short, got ${walk.minutes}`);
    const mobility = gentle.options.find((o) => /mobility/i.test(o.label));
    if (mobility) assert.ok(mobility.minutes <= 10, `gentle mobility should be short, got ${mobility.minutes}`);
  }
});

test("a recovery_adjustment of exactly 1 leaves the menu byte-identical to no modifier at all", () => {
  resetTables("training_symptom_events");
  for (let daysAgo = 0; daysAgo < 5; daysAgo++) {
    const date = localDaysAgo(daysAgo);
    for (const kind of ["rest", "easy"]) {
      assert.deepEqual(
        buildRecoveryMenu(date, kind, { responseModifier: recoveryModifier(1) }),
        buildRecoveryMenu(date, kind, { responseModifier: null }),
        `a holding modifier changed the menu on ${date}/${kind}`
      );
    }
  }
});

test("a recovery_adjustment below 1 can never talk the menu into offering more", () => {
  resetTables("training_symptom_events");
  const date = localDaysAgo(1);
  const standard = buildRecoveryMenu(date, "rest", { responseModifier: null });
  // The producer never emits this for recovery_adjustment; the guard exists so a
  // future producer change cannot quietly turn a caution-only lever into a push.
  assert.deepEqual(buildRecoveryMenu(date, "rest", { responseModifier: recoveryModifier(0.9) }), standard);
});

test("with no wearable nights on record the live read changes nothing", () => {
  resetTables("training_symptom_events", "daily_metrics", "brain_decisions", "brain_expectations");
  const date = localDaysAgo(2);
  // No opts at all: the live personalResponseModifierFor path. Nothing has been
  // learned, so there is no modifier and the menu is the standard one.
  assert.deepEqual(buildRecoveryMenu(date, "rest"), buildRecoveryMenu(date, "rest", { responseModifier: null }));
});

test("a flagged area still wins over the learned recovery bias, unchanged", () => {
  resetTables("training_symptom_events", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: date });
  assert.deepEqual(
    buildRecoveryMenu(date, "rest", { responseModifier: recoveryModifier(1.1) }),
    buildRecoveryMenu(date, "rest", { responseModifier: null }),
    "the guarded pair is already the gentlest menu; the modifier has nothing to add"
  );
});

test("the gentle menu says nothing the grammar pool does not already enumerate", () => {
  resetTables("training_symptom_events");
  const pool = new Set(recoveryMenuGrammarPool());
  for (let daysAgo = 0; daysAgo < 5; daysAgo++) {
    const menu = buildRecoveryMenu(localDaysAgo(daysAgo), "rest", { responseModifier: recoveryModifier(1.1) });
    assert.ok(pool.has(menu.line), `unregistered line: ${JSON.stringify(menu.line)}`);
    for (const opt of menu.options) {
      assert.ok(pool.has(opt.label), `unregistered label: ${JSON.stringify(opt.label)}`);
      assert.equal(violatesReadingGrammar(opt.detail), null, `violated grammar: ${JSON.stringify(opt.detail)}`);
    }
  }
});
