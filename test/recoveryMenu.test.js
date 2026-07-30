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
