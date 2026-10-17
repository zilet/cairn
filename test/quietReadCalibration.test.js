// CALIBRATION FROM THE ATHLETE'S OWN HISTORY — the per-signal quiet-read calibration
// (src/repo/brain/quiet-read-calibration.ts).
//
// Pinned here:
//   1. The rule, replayed over the production ledger's per-DATE outcomes
//      (2026-07-26..10-16, one row per judged date: read kind, load, verdict): the easy
//      reads' hit rate improves, and no day with cost evidence is ever opened.
//   2. Shrinkage and the minimum-evidence floor: a thin record stays at the prior; one
//      cost holds the signal for the whole window; the newest morning honored holds it.
//   3. Per DATE: a repeated date counts once.
//   4. Only the soft signals: sleep, a felt tap, anything clinical never retire.
//   5. The DB path: the ledger's own morning reads (an agent's cited brake, or the
//      deciding brakes the read published) feed it, and a retired brake is no longer one
//      the agent may cite to read a train day quieter.
//   6. The bridge: mornings written before reads recorded their signal form one pooled
//      record that answers for a brake only until that brake has a record of its own.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { repo, resetTables, localDaysAgo, seedTrainingDay, seedRecoveryDay } from "./_seed.js";
import {
  CALIBRATABLE_BRAKE_FIELDS,
  QUIET_CALIBRATION_MIN_COMPARABLE,
  QUIET_CALIBRATION_WINDOW_DAYS,
  LEGACY_UNKEYED,
  brakeRetired,
  calibrateQuietReads,
  calibrationRetiresAll,
  quietReadCalibration,
} from "../dist/repo/brain/quiet-read-calibration.js";
import { morningReadForDate, quietReadKeys } from "../dist/repo/brain/read-adherence.js";
import { dayReadCitableBrakes } from "../dist/repo/day-read.js";
import { agentCautionLacksBrake } from "../dist/dayread.js";

beforeEach(() =>
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "day_reads",
    "brain_decisions",
    "brain_expectations",
    "brain_evaluations"
  )
);

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------- 1. the replay

// date kind load verdict(A aligned / N not_aligned). A derived table, one row per DATE.
const LEDGER = `
  2026-07-26 rest easy N | 2026-07-27 rest moderate N | 2026-07-28 rest hard N | 2026-07-29 rest none A
  2026-07-30 easy moderate N | 2026-07-31 train hard A | 2026-08-01 easy moderate N | 2026-08-02 rest hard N
  2026-08-03 rest moderate N | 2026-08-04 easy moderate N | 2026-08-05 easy hard N | 2026-08-06 easy moderate N
  2026-08-07 easy none A | 2026-08-08 easy none A | 2026-08-09 easy none A | 2026-08-10 easy none A
  2026-08-11 easy moderate N | 2026-08-12 easy moderate N | 2026-08-13 easy moderate N | 2026-08-14 easy none A
  2026-08-15 easy none A | 2026-08-16 easy moderate N | 2026-08-17 easy moderate N | 2026-08-18 easy hard N
  2026-08-19 easy moderate N | 2026-08-20 train hard A | 2026-08-21 train moderate A | 2026-08-22 train moderate A
  2026-08-23 train moderate A | 2026-08-24 train none N | 2026-08-25 easy hard N | 2026-08-26 easy hard N
  2026-08-27 easy hard N | 2026-08-28 train hard A | 2026-08-29 easy hard N | 2026-08-30 easy hard N
  2026-08-31 easy hard N | 2026-09-01 easy hard N | 2026-09-02 easy hard N | 2026-09-03 train moderate A
  2026-09-04 train hard A | 2026-09-05 train none N | 2026-09-06 easy none A | 2026-09-07 rest none A
  2026-09-08 easy hard N | 2026-09-09 easy hard N | 2026-09-10 easy moderate N | 2026-09-11 easy hard N
  2026-09-12 rest hard N | 2026-09-13 rest none A | 2026-09-14 easy hard N | 2026-09-15 train hard A
  2026-09-16 train hard A | 2026-09-17 train hard A | 2026-09-18 train hard A | 2026-09-19 train moderate A
  2026-09-20 rest hard N | 2026-09-21 rest hard N | 2026-09-22 easy hard N | 2026-09-23 train hard A
  2026-09-24 train hard A | 2026-09-25 train hard A | 2026-09-26 rest none A | 2026-09-27 train hard A
  2026-09-28 train hard A | 2026-09-29 rest hard A | 2026-09-30 train hard A | 2026-10-01 train hard A
  2026-10-02 train hard A | 2026-10-03 rest hard A | 2026-10-04 easy hard N | 2026-10-05 train hard A
  2026-10-06 easy hard N | 2026-10-07 train hard A | 2026-10-08 train hard A | 2026-10-09 train hard A
  2026-10-10 easy moderate N | 2026-10-11 rest none A | 2026-10-12 train moderate A | 2026-10-13 train hard A
  2026-10-14 train hard A | 2026-10-15 train hard A | 2026-10-16 train moderate A
`
  .split(/[|\n]/)
  .map((cell) => cell.trim())
  .filter(Boolean)
  .map((cell) => {
    const [date, kind, load, verdict] = cell.split(/\s+/);
    return { date, kind, load, aligned: verdict === "A" };
  });

// What a quiet read's day answered: above easy and the verdict said the read was too
// cautious (nothing afterwards said it cost anything) — a clean override; above easy
// and the verdict held the caution (a cost showed) — a costly one; at or under easy —
// honored.
function answer(row) {
  const above = row.load === "moderate" || row.load === "hard";
  if (!above) return "honored";
  return row.aligned ? "costly_override" : "clean_override";
}

// Replay every easy morning in date order against ONLY the mornings before it. The CSV
// carries no per-signal column, so every easy morning stands on one pooled key.
function replay(ledger) {
  const history = [];
  const out = [];
  for (const row of ledger) {
    if (row.kind !== "easy") continue;
    const opened = calibrateQuietReads(history, row.date).retired.includes("hrv");
    const outcome = answer(row);
    // Opened, the read is a train read: a hit when the athlete trained, a miss when he
    // took the quiet day. Not opened, the easy read keeps its own verdict.
    const hit = opened ? outcome !== "honored" : outcome === "honored";
    out.push({ date: row.date, opened, outcome, hit });
    // An opened morning stays evidence (the held-open train morning, same answer).
    history.push({ date: row.date, keys: ["hrv"], outcome });
  }
  return out;
}

test("replayed over the production ledger, the easy reads' hit rate improves and no cost case flips", () => {
  assert.equal(LEDGER.length, 83);
  assert.equal(new Set(LEDGER.map((row) => row.date)).size, 83, "one row per DATE");
  const easy = LEDGER.filter((row) => row.kind === "easy");
  assert.equal(easy.length, 36);
  const baselineHits = easy.filter((row) => answer(row) === "honored").length;
  assert.equal(baselineHits, 7, "the deterministic prior: 7 of 36 easy reads held");

  const result = replay(LEDGER);
  const hits = result.filter((day) => day.hit).length;
  assert.equal(hits, 20, `calibrated: ${hits} of 36`);
  assert.ok(hits > baselineHits);
  // Nothing opens before eight answered mornings exist, and the August record — six
  // honored mornings in its first fifteen — holds the read at easy longer than a
  // naive "most of them were overridden" would.
  const opened = result.filter((day) => day.opened).map((day) => day.date);
  assert.equal(opened[0], "2026-08-27");
  assert.ok(opened.every((date) => date >= "2026-08-27"));
  // The cost of being wrong: exactly one honored morning the calibration would have
  // read as train (2026-09-06) — the athlete took the quiet day anyway, and the
  // calibration counts it against the signal.
  assert.deepEqual(
    result.filter((day) => day.opened && day.outcome === "honored").map((day) => day.date),
    ["2026-09-06"]
  );
  // No day with cost evidence is ever opened. The ledger's only cost cases are two rest
  // reads trained through (2026-09-29, 10-03) — never in the calibration's reach.
  assert.equal(result.filter((day) => day.opened && day.outcome === "costly_override").length, 0);
  const costRows = LEDGER.filter((row) => row.kind !== "train" && answer(row) === "costly_override");
  assert.deepEqual(
    costRows.map((row) => `${row.date}:${row.kind}`),
    ["2026-09-29:rest", "2026-10-03:rest"]
  );
  assert.ok(!result.some((day) => costRows.some((row) => row.date === day.date)), "a rest read is never moved");
});

test("one costly override holds the signal for the whole window", () => {
  // The same ledger with one easy morning answered by a cost (2026-09-01).
  const costly = LEDGER.map((row) => (row.date === "2026-09-01" ? { ...row, aligned: true } : row));
  const result = replay(costly);
  const until = addDays("2026-09-01", QUIET_CALIBRATION_WINDOW_DAYS);
  for (const day of result) {
    if (day.date > "2026-09-01" && day.date <= until)
      assert.equal(day.opened, false, `${day.date} opened inside the cost's window`);
  }
  assert.ok(result.filter((day) => day.hit).length < 20);
});

// ---------------------------------------------------------------- 2. shrinkage & floors

const AS_OF = "2026-10-17";
const morning = (back, outcome, keys = ["hrv"]) => ({ date: addDays(AS_OF, -back), keys, outcome });
const run = (outcomes, keys) => outcomes.map((outcome, i) => morning(outcomes.length - i, outcome, keys));

test("below the minimum evidence nothing retires, however clean", () => {
  const seven = run(Array(QUIET_CALIBRATION_MIN_COMPARABLE - 1).fill("clean_override"));
  assert.deepEqual(calibrateQuietReads(seven, AS_OF).retired, []);
  const eight = run(Array(QUIET_CALIBRATION_MIN_COMPARABLE).fill("clean_override"));
  const cal = calibrateQuietReads(eight, AS_OF);
  assert.deepEqual(cal.retired, ["hrv"]);
  assert.equal(cal.keys[0].answered, 8);
  // Unanswered mornings count for neither side — never toward the floor.
  const withUnknown = run([...Array(7).fill("clean_override"), "unknown", "unknown"]);
  assert.deepEqual(calibrateQuietReads(withUnknown, AS_OF).retired, []);
});

test("shrinkage: two in three, after the prior, and the newest morning honored holds it", () => {
  const C = "clean_override";
  const H = "honored";
  // 5 of 8 clean: (5 + 2) / 12 — below two in three.
  assert.deepEqual(calibrateQuietReads(run([H, C, H, C, H, C, C, C]), AS_OF).retired, []);
  // 7 of 10 clean, newest clean: (7 + 2) / 14 — below too; the prior keeps pulling.
  assert.deepEqual(calibrateQuietReads(run([H, H, H, C, C, C, C, C, C, C]), AS_OF).retired, []);
  // 9 of 11, newest clean: retires.
  assert.deepEqual(calibrateQuietReads(run([H, H, C, C, C, C, C, C, C, C, C]), AS_OF).retired, ["hrv"]);
  // The same record with the athlete agreeing most recently holds.
  assert.deepEqual(calibrateQuietReads(run([H, C, C, C, C, C, C, C, C, C, H]), AS_OF).retired, []);
  // Any cost in the window holds it, whatever the rate.
  assert.deepEqual(calibrateQuietReads(run([...Array(12).fill(C), "costly_override", C]), AS_OF).retired, []);
});

test("the window and the per-DATE rule", () => {
  // Outside the window, or on/after the read date, a morning does not count.
  const old = Array.from({ length: 8 }, (_, i) => morning(QUIET_CALIBRATION_WINDOW_DAYS + 1 + i, "clean_override"));
  assert.deepEqual(calibrateQuietReads(old, AS_OF).retired, []);
  const today = [...run(Array(7).fill("clean_override")), { date: AS_OF, keys: ["hrv"], outcome: "clean_override" }];
  assert.deepEqual(calibrateQuietReads(today, AS_OF).retired, []);
  // One date written three times (a churny recompute day) is ONE morning, the last.
  const churn = [...run(Array(7).fill("clean_override"))];
  const day = addDays(AS_OF, -9);
  churn.push(
    { date: day, keys: ["hrv"], outcome: "clean_override" },
    { date: day, keys: ["hrv"], outcome: "clean_override" }
  );
  const cal = calibrateQuietReads(churn, AS_OF);
  assert.equal(cal.mornings, 8);
  assert.equal(cal.keys[0].answered, 8);
  churn.push({ date: day, keys: ["hrv"], outcome: "costly_override" });
  assert.deepEqual(calibrateQuietReads(churn, AS_OF).retired, [], "the date's last answer stands");
});

test("only the soft signals ever retire, and only all of a morning's brakes open it", () => {
  for (const field of ["sleep", "sleep_min", "felt_energy", "sleep_feel", "session_quality", "mesocycle", "symptom"]) {
    assert.equal(CALIBRATABLE_BRAKE_FIELDS.has(field), false, field);
    assert.deepEqual(calibrateQuietReads(run(Array(12).fill("clean_override"), [field]), AS_OF).retired, [], field);
  }
  const cal = calibrateQuietReads(run(Array(10).fill("clean_override"), ["hrv", "acute_load"]), AS_OF);
  assert.deepEqual(cal.retired, ["acute_load", "hrv"]);
  assert.equal(calibrationRetiresAll(cal, ["hrv"]), true);
  assert.equal(calibrationRetiresAll(cal, ["hrv", "resting_hr"]), false, "one live brake keeps the read");
  assert.equal(calibrationRetiresAll(cal, []), false, "no brake under the read is not this rule's question");
  assert.equal(calibrationRetiresAll(null, ["hrv"]), false);
});

// ---------------------------------------------------------------- 3. the DB path

const evidence = (field, direction, extra = {}) => ({ field, direction, freshness: "fresh", ...extra });
const brakeState = (field) => ({
  dimensions: { recovery_capacity: { evidence: [evidence(field, "caution")] } },
});

function quietMorning(date, { brake = null, field = null, overridden = true } = {}) {
  repo.saveDayRead(date, {
    kind: "easy",
    headline: "Keep today easy.",
    why: "A lighter day sits better with how the week has gone.",
    focus: null,
    est_minutes: 25,
    // A read publishes the deciding brakes under it; `legacy` mornings predate that.
    signals:
      field === "legacy" ? {} : { signal_state: brakeState(field ?? brake), deciding_brakes: field ? [field] : [] },
    source: brake ? "agent" : "deterministic",
    override: null,
    ...(brake
      ? {
          decision: {
            rule_code: "agent_conservative_adjustment",
            basis: "agent",
            baseline_kind: "train",
            brake,
            reason: "",
            evidence: [],
          },
        }
      : {}),
  });
  if (overridden) seedTrainingDay(date);
  else seedRecoveryDay(date);
}

test("the ledger keys a quiet morning on the agent's cited brake, else the brakes the read published", () => {
  quietMorning(localDaysAgo(4), { brake: "hrv" });
  quietMorning(localDaysAgo(3), { field: "acute_load" });
  quietMorning(localDaysAgo(2), { field: "legacy" });
  assert.deepEqual(morningReadForDate(localDaysAgo(4))?.quietKeys, ["hrv"]);
  assert.deepEqual(morningReadForDate(localDaysAgo(3))?.quietKeys, ["acute_load"]);
  assert.equal(morningReadForDate(localDaysAgo(2))?.quietKeys, null, "a morning that recorded no signal");
  assert.equal(quietReadKeys(null), null);
  assert.deepEqual(quietReadKeys({ signals: { deciding_brakes: [] } }), [], "no brake under the read");
  assert.deepEqual(quietReadKeys({ signals: { deciding_brakes: ["hrv", 3, ""] } }), ["hrv"]);
});

test("eight easy mornings the athlete trained through on one brake, at no cost, retire it", () => {
  for (let back = 2; back <= 9; back++) quietMorning(localDaysAgo(back), { brake: "hrv" });
  const cal = quietReadCalibration(localDaysAgo(0));
  assert.deepEqual(cal.retired, ["hrv"]);
  assert.equal(cal.keys.find((stat) => stat.key === "hrv")?.clean, 8);

  // A train baseline carrying that brake can no longer be read quieter on it.
  const baseline = {
    kind: "train",
    decision: { rule_code: "planned_training" },
    signals: { signal_state: brakeState("hrv"), quiet_read_calibration: { retired: cal.retired, applied: false } },
  };
  assert.deepEqual(dayReadCitableBrakes(baseline), []);
  assert.equal(agentCautionLacksBrake({ kind: "easy", brake: "hrv" }, baseline), true);
  // Without the calibration the same brake is citable, exactly as before.
  const unretired = { ...baseline, signals: { signal_state: brakeState("hrv") } };
  assert.deepEqual(dayReadCitableBrakes(unretired), ["hrv"]);
  assert.equal(agentCautionLacksBrake({ kind: "easy", brake: "hrv" }, unretired), false);
});

test("a mixed record on the same brake keeps it citable", () => {
  for (let back = 2; back <= 9; back++) quietMorning(localDaysAgo(back), { brake: "hrv", overridden: back % 2 === 0 });
  assert.deepEqual(quietReadCalibration(localDaysAgo(0)).retired, []);
});

function trainMorning(date, signals, { trained = true } = {}) {
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Good to train.",
    why: "A calm sentence about the day.",
    focus: "Upper",
    est_minutes: 60,
    signals: { signal_state: brakeState("hrv"), deciding_brakes: ["hrv"], ...signals },
    source: "deterministic",
    override: null,
  });
  if (trained) seedTrainingDay(date);
  else seedRecoveryDay(date);
}

test("a train day another law decided is never evidence, even with the retired brake on its board", () => {
  // Seven clean easy HRV mornings: one short of the floor.
  for (let back = 3; back <= 9; back++) quietMorning(localDaysAgo(back), { brake: "hrv" });
  // The eighth morning is a STATED key run the calendar dosed to train with HRV still
  // deciding. He ran it and it went fine — but no quiet read was outrun.
  const date = localDaysAgo(2);
  trainMorning(date, {
    calendar_dose: { applied: true, day: "key_run", stepped_aside: "acute_signal_protection", brakes: ["hrv"] },
    quiet_read_calibration: { retired: ["hrv"], applied: false },
  });
  const read = morningReadForDate(date);
  assert.equal(read?.calibrated, false);
  assert.deepEqual(read?.quietKeys, [], "no calibration key on a day the calendar decided");
  const cal = quietReadCalibration(localDaysAgo(0));
  assert.equal(cal.keys.find((stat) => stat.key === "hrv")?.answered, 7);
  assert.deepEqual(cal.retired, [], "the dosed day did not make the eighth override");
});

test("even an `applied` flag cannot make a calendar-dosed day evidence", () => {
  for (let back = 3; back <= 9; back++) quietMorning(localDaysAgo(back), { brake: "hrv" });
  trainMorning(localDaysAgo(2), {
    calendar_dose: { applied: true, day: "lift" },
    quiet_read_calibration: { retired: ["hrv"], applied: true },
  });
  assert.equal(morningReadForDate(localDaysAgo(2))?.calibrated, false);
  assert.deepEqual(quietReadCalibration(localDaysAgo(0)).retired, []);
});

test("a morning the calibration itself opened, trained through clean, is evidence", () => {
  for (let back = 3; back <= 9; back++) quietMorning(localDaysAgo(back), { brake: "hrv" });
  const date = localDaysAgo(2);
  trainMorning(date, { quiet_read_calibration: { retired: ["hrv"], applied: true } });
  const read = morningReadForDate(date);
  assert.equal(read?.calibrated, true);
  assert.deepEqual(read?.quietKeys, ["hrv"]);
  const cal = quietReadCalibration(localDaysAgo(0));
  assert.equal(cal.keys.find((stat) => stat.key === "hrv")?.clean, 8);
  assert.deepEqual(cal.retired, ["hrv"]);
});

test("a morning the calibration opened and he took easy hands the brake back", () => {
  for (let back = 3; back <= 10; back++) quietMorning(localDaysAgo(back), { brake: "hrv" });
  trainMorning(localDaysAgo(2), { quiet_read_calibration: { retired: ["hrv"], applied: true } }, { trained: false });
  assert.equal(morningReadForDate(localDaysAgo(2))?.calibrated, true);
  assert.deepEqual(quietReadCalibration(localDaysAgo(0)).retired, []);
});

// ---------------------------------------------------------------- 4. the bridge

test("the legacy pool answers for a brake only until that brake has a record of its own", () => {
  const legacy = Array.from({ length: 10 }, (_, i) => ({
    date: addDays(AS_OF, -(i + 2)),
    keys: [LEGACY_UNKEYED],
    outcome: "clean_override",
  }));
  const cal = calibrateQuietReads(legacy, AS_OF);
  assert.equal(cal.legacy_retires, true);
  assert.deepEqual(cal.retired, [], "the pool itself is never a brake");
  assert.equal(brakeRetired(cal, "hrv"), true);
  assert.equal(brakeRetired(cal, "sleep"), false, "never a floor");
  assert.equal(brakeRetired(cal, "felt_energy"), false);
  // One keyed answer about HRV — he took that morning easy — and HRV speaks for itself.
  const withOwn = calibrateQuietReads(
    [...legacy, { date: addDays(AS_OF, -1), keys: ["hrv"], outcome: "honored" }],
    AS_OF
  );
  assert.equal(brakeRetired(withOwn, "hrv"), false);
  assert.equal(brakeRetired(withOwn, "acute_load"), true, "a brake with no record of its own still rides the pool");
  assert.equal(calibrationRetiresAll(withOwn, ["acute_load", "hrv"]), false);
});

test("the DB pool: easy mornings that recorded no signal, trained through at no cost", () => {
  for (let back = 2; back <= 9; back++) quietMorning(localDaysAgo(back), { field: "legacy" });
  const cal = quietReadCalibration(localDaysAgo(0));
  assert.equal(cal.legacy_retires, true);
  assert.equal(brakeRetired(cal, "resting_hr"), true);
  // A read published with NO brake under it is not pooled: it says nothing either way.
  resetTables("logged_sets", "sessions", "day_reads", "brain_decisions", "brain_expectations");
  for (let back = 2; back <= 9; back++) quietMorning(localDaysAgo(back), { field: null });
  const none = quietReadCalibration(localDaysAgo(0));
  assert.equal(none.legacy_retires, false);
  assert.equal(none.mornings, 0);
});
