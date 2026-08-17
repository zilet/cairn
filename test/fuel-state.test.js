// Pace-aware fuel state — the deterministic protein read behind the Brief's FUEL
// line. The bug it fixes: the old line cried "N g short" whenever ≥25 g remained,
// which is trivially true all morning. dayFuelState grades protein against where
// you'd EXPECT to be at this point in the eating window, so "on pace" (grams still
// to eat) is distinct from genuinely "behind".
//
// The window math is LOCAL-clock dependent, so every pace case runs inside a pinned
// UTC zone (runWithTimeZone) — otherwise the runner's own TZ would move the hours.
// minutes_ago and the string-date comparisons are TZ-independent by construction.
import assert from "node:assert/strict";
import test from "node:test";
import { dayFuelState } from "../dist/repo/fuel-state.js";
import { runWithTimeZone } from "../dist/tz.js";
import { db, repo, resetTables } from "./_seed.js";

const TODAY = "2026-07-13";
// weight 180 lb, maintain → protein target round(180 * 0.9) = 162 g.
const TARGET_G = 162;

function seedProfile() {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
}

// Insert one logged food note with a chosen local-wall-clock created_at (read as
// UTC under the pinned zone) and protein. enrichment_status 'done' so nothing queues.
function meal(date, createdAt, protein, { kcal = 500, summary = "meal", label = "meal" } = {}) {
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES (?, ?, '', ?, 'done', ?)`
  ).run(date, label, JSON.stringify({ summary, protein_g: protein, kcal }), createdAt);
}

// The intake-coverage law: "behind" is the one bucket that makes a claim about
// food NOT eaten, so it is only spoken when the plate is actually on the record.
// Every case below that asserts "behind" on TODAY therefore seeds the habit it
// depends on — a fortnight of complete closed days before the day under test.
// Nothing lands on the day under test itself, so no total moves.
function seedFullLogging(before) {
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.parse(`${before}T00:00:00Z`) - i * 864e5).toISOString().slice(0, 10);
    meal(d, `${d} 08:00:00`, 60, { kcal: 700, label: "breakfast" });
    meal(d, `${d} 19:00:00`, 60, { kcal: 900, label: "dinner" });
  }
}

function reset() {
  resetTables("food_notes", "profile", "bodyweight_log", "nutrition_targets", "daily_metrics", "garmin_daily_metrics");
}

test("no derivable target (incomplete profile) → null, so the FUEL line is simply omitted", () => {
  reset();
  const out = dayFuelState(TODAY, new Date("2026-07-13T11:51:00Z"));
  assert.equal(out, null);
});

test("an unknown logged protein amount never becomes a false zero or behind signal", () => {
  runWithTimeZone("UTC", () => {
    reset();
    seedProfile();
    meal(TODAY, "2026-07-13 07:30:00", null, { summary: "meal awaiting details" });
    assert.equal(dayFuelState(TODAY, new Date("2026-07-13T11:51:00Z")), null);
  });
});

test("behind: little protein in versus where the eating window says you'd be", () => {
  runWithTimeZone("UTC", () => {
    reset();
    seedProfile();
    seedFullLogging(TODAY);
    meal(TODAY, "2026-07-13 07:30:00", 20, { summary: "coffee + toast" });
    const out = dayFuelState(TODAY, new Date("2026-07-13T11:51:00Z"));
    assert.ok(out, "a target exists");
    assert.equal(out.target_g, TARGET_G);
    assert.equal(out.protein_so_far_g, 20);
    // window 07:30→21:00 (13.5 h); at 11:51, 4.35/13.5 = 0.322 → 162*0.322 ≈ 52 g.
    assert.equal(out.expected_by_now_g, 52);
    assert.equal(out.bucket, "behind");
    assert.ok(out.last_meal, "the last meal rides along for recency");
    assert.equal(out.last_meal.minutes_ago, 261, "07:30 → 11:51 is 261 min");
    assert.equal(out.last_meal.protein_g, 20);
  });
});

test("on_pace: the incident case — 65 g by late morning after a solid breakfast is fine", () => {
  runWithTimeZone("UTC", () => {
    reset();
    seedProfile();
    meal(TODAY, "2026-07-13 07:30:00", 60, { summary: "eggs + oats" });
    meal(TODAY, "2026-07-13 09:00:00", 5, { summary: "yogurt" });
    const out = dayFuelState(TODAY, new Date("2026-07-13T11:51:00Z"));
    assert.equal(out.protein_so_far_g, 65);
    assert.equal(out.expected_by_now_g, 52);
    // 65 ≥ 52 − 20 (=32), and a big remainder (97 g) still owed → on_pace, no nudge.
    assert.equal(out.bucket, "on_pace");
  });
});

test("on_pace / behind boundary is exactly the 20 g slack under the pace line", () => {
  runWithTimeZone("UTC", () => {
    // First meal at 07:00 fixes the window start; now 14:00 → half of a 14 h window
    // → expected = 162 × 0.5 = 81 g. The slack is 20 g, so 61 is on_pace, 60 behind.
    reset();
    seedProfile();
    meal(TODAY, "2026-07-13 07:00:00", 61, { summary: "big breakfast" });
    const onPace = dayFuelState(TODAY, new Date("2026-07-13T14:00:00Z"));
    assert.equal(onPace.expected_by_now_g, 81);
    assert.equal(onPace.bucket, "on_pace", "exactly expected − 20 is still on pace");

    reset();
    seedProfile();
    seedFullLogging(TODAY);
    meal(TODAY, "2026-07-13 07:00:00", 60, { summary: "big breakfast" });
    const behind = dayFuelState(TODAY, new Date("2026-07-13T14:00:00Z"));
    assert.equal(behind.expected_by_now_g, 81);
    assert.equal(behind.bucket, "behind", "one gram under the slack line is behind");
  });
});

test("met: protein within 10 g of target reads met regardless of the clock", () => {
  runWithTimeZone("UTC", () => {
    reset();
    seedProfile();
    meal(TODAY, "2026-07-13 08:00:00", 100, { summary: "breakfast" });
    meal(TODAY, "2026-07-13 12:30:00", 70, { summary: "lunch" }); // 170 total ≥ 162 − 10
    const out = dayFuelState(TODAY, new Date("2026-07-13T13:00:00Z"));
    assert.equal(out.protein_so_far_g, 170);
    assert.equal(out.bucket, "met");
  });
});

test("a past local day is graded on full-day totals (pace is meaningless once it's over)", () => {
  runWithTimeZone("UTC", () => {
    const past = "2026-07-10"; // before TODAY
    // Under-target on the whole day → behind, with expected pinned to the full target.
    reset();
    seedProfile();
    // Breakfast AND dinner, carrying a day's worth of calories between them: a closed
    // day only reads as under-target when it reads as a whole day in the first place
    // (see the coverage cases below), and reaching across the day is not enough on its
    // own — a day that spans 08:00 to 19:00 on one meal's calories is absent evidence.
    meal(past, "2026-07-10 08:00:00", 60, { kcal: 700, label: "breakfast" });
    meal(past, "2026-07-10 19:00:00", 40, { kcal: 900, label: "dinner" }); // 100 g protein, well under 162
    const behind = dayFuelState(past, new Date("2026-07-13T09:00:00Z"));
    assert.equal(behind.expected_by_now_g, TARGET_G, "past day expects the FULL target, not a time-fraction");
    assert.equal(behind.bucket, "behind");

    // Full-day total near target → met.
    reset();
    seedProfile();
    meal(past, "2026-07-10 08:00:00", 100, { kcal: 700, label: "breakfast" });
    meal(past, "2026-07-10 19:00:00", 60, { kcal: 900, label: "dinner" }); // 160 g, within 10 of 162
    const met = dayFuelState(past, new Date("2026-07-13T09:00:00Z"));
    assert.equal(met.expected_by_now_g, TARGET_G);
    assert.equal(met.bucket, "met");
  });
});

// ---- the intake-coverage law: absent, never low ------------------------------

test("a closed day whose dinner was never logged is ABSENT, not behind", () => {
  runWithTimeZone("UTC", () => {
    const past = "2026-07-10";
    reset();
    seedProfile();
    meal(past, "2026-07-10 08:00:00", 40, { label: "breakfast" }); // one meal, 40 g
    assert.equal(
      dayFuelState(past, new Date("2026-07-13T09:00:00Z")),
      null,
      "protein unrecorded must never be reported as protein missed"
    );
  });
});

test("a partial closed day that nonetheless MET the target still reads met", () => {
  runWithTimeZone("UTC", () => {
    const past = "2026-07-10";
    reset();
    seedProfile();
    // One entry, so the day is partial — but food that IS logged is still food, and
    // "met" makes no claim about anything missing.
    meal(past, "2026-07-10 08:00:00", 160, { label: "breakfast" });
    const out = dayFuelState(past, new Date("2026-07-13T09:00:00Z"));
    assert.ok(out);
    assert.equal(out.bucket, "met");
  });
});

test("with meals off the log, today's 'behind' is withheld — it would describe the diary", () => {
  runWithTimeZone("UTC", () => {
    reset();
    seedProfile();
    // No logging habit behind it: one small breakfast is the whole record.
    meal(TODAY, "2026-07-13 07:30:00", 20, { summary: "coffee + toast" });
    assert.equal(dayFuelState(TODAY, new Date("2026-07-13T11:51:00Z")), null);
  });
});

test("on_pace is never withheld for coverage — it accuses nothing", () => {
  runWithTimeZone("UTC", () => {
    reset();
    seedProfile();
    meal(TODAY, "2026-07-13 07:30:00", 60, { summary: "eggs + oats" });
    const out = dayFuelState(TODAY, new Date("2026-07-13T11:51:00Z"));
    assert.ok(out, "a quiet log does not silence the pace line itself");
    assert.equal(out.bucket, "on_pace");
  });
});
