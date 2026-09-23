// A missing night is ABSENT, never low — and a real recovery dip is a bounded trim.
//
// The weekly run engine used to read its recovery dip off the 7-vs-30-day MEDIAN delta
// of whatever nights had synced. On an episodically-worn watch one late sync moved that
// median across the band, and the dip then stacked a supporting-role two-thirds cut and
// a long run sized off the eased week on top of its own 0.9: one missing night took a
// week down by about a third and nearly halved its long run, and the next sync put it
// back. The laws pinned here:
//
//   • the dip is read off the NIGHTS — the newest three readings in the last seven days
//     all past the athlete's OWN line (baseline less one of their own SDs, never inside
//     the 7% HRV band) — so a night that never synced neither starts nor ends one;
//   • a late sync (last night absent, the nights before it ordinary) changes nothing;
//   • a real dip still eases the week, by a bounded trim: ~10% off the volume, the long
//     run held one step under the demonstrated longest — never a collapse;
//   • the morning read (runDayIntensity) treats an absent last night as absent: no HRV
//     brake, no HRV support, and no trailing-dip soft brake off a median wobble.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { weeklyRunPlan } from "../dist/repo/run-progression.js";
import { recoveryDipRead, runMorningEvidence, sustainedPastOwnLine } from "../dist/repo/run-day-intensity.js";
import { getRecoverySummary } from "../dist/repo/coach.js";

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "checkins",
    "suggestions",
    "context_events",
    "training_symptom_events",
    "symptom_reports",
    "sessions",
    "logged_sets",
    "day_reads",
    "brain_decisions",
    "brain_expectations",
    "plan_items",
    "plan_days",
    "program_blocks",
    "health_directives",
    "app_state",
    "profile"
  );
});

const TODAY = localDateISO();
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const T = dowOf(TODAY);
const MONDAY = addDays(TODAY, -((T + 6) % 7));

// A steady runner: Tue 6, Thu 8, Sun 12 km for six closed weeks before this Monday.
function seedRunner() {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  for (let w = 1; w <= 6; w++) {
    const monday = addDays(MONDAY, -7 * w);
    for (const [offset, km] of [
      [1, 6],
      [3, 8],
      [6, 12],
    ])
      repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, date: addDays(monday, offset) });
  }
}

// Thirty nights of the athlete's own: HRV cycling 48–56 (median 52), resting HR 50–54,
// sleep steady. `recent` overrides HRV newest-first from TODAY (index 0 = last night);
// `null` means that night never synced.
const OWN_HRV = [48, 50, 52, 54, 56];
function seedNights(recent = [], { skip = [] } = {}) {
  for (let back = 0; back < 30; back++) {
    if (skip.includes(back)) continue;
    const override = back < recent.length ? recent[back] : undefined;
    if (override === null) continue;
    // Tonight only exists when the caller supplied it.
    if (back === 0 && override === undefined) continue;
    repo.upsertGarminDailyMetric({
      date: addDays(TODAY, -back),
      hrv_ms: override ?? OWN_HRV[back % 5],
      resting_hr: [50, 51, 52, 53, 54][back % 5],
      sleep_min: 460,
    });
  }
}

// An episodic-wearer week shaped like the live one: a mix of ordinary and lowish nights,
// never three low in a row, with a good night last night. The 7-day median sits just
// inside the old band with that night, and just outside it without.
const MIXED_WEEK = [56, 49, 47, 50, 46, 49, 45];

const totalKm = (plan) => Math.round(plan.runs.reduce((s, r) => s + Number(r.target_distance_km ?? 0), 0) * 10) / 10;
const longKm = (plan) => plan.runs.find((r) => r.kind_label === "long")?.target_distance_km ?? null;
const shape = (plan) => ({
  total: totalKm(plan),
  long: longKm(plan),
  runs: plan.runs.map((r) => `${r.day_number}:${r.kind_label}:${r.target_distance_km}:${r.dose ?? ""}`),
});
const easedByDip = (plan) => plan.rationale.some((line) => /Recovery's down this week/.test(line));
const readWeek = (opts = {}) => weeklyRunPlan(TODAY, { adjustToday: false, ...opts });

test("one missing night inside the week → no dip, and the week is exactly the week it was", () => {
  seedRunner();
  seedNights(MIXED_WEEK);
  const whole = readWeek();
  assert.equal(easedByDip(whole), false, "the mixed week itself is not a dip");

  db.prepare("DELETE FROM garmin_daily_metrics WHERE date = ?").run(addDays(TODAY, -1));
  const gap = readWeek();
  assert.equal(
    easedByDip(gap),
    false,
    `a night that never synced is not a low night: ${JSON.stringify(gap.rationale)}`
  );
  assert.deepEqual(shape(gap), shape(whole), "one missing night moves nothing");
});

test("a late sync (last night absent, the nights before it ordinary) changes nothing", () => {
  seedRunner();
  seedNights(MIXED_WEEK);
  const synced = readWeek();
  db.prepare("DELETE FROM garmin_daily_metrics WHERE date = ?").run(TODAY);
  const late = readWeek();
  assert.equal(easedByDip(late), false, `absence is not a dip: ${JSON.stringify(late.rationale)}`);
  assert.deepEqual(shape(late), shape(synced), "the week does not swing on when the watch synced");
});

test("three consecutive nights below the athlete's own band → a dip, and a bounded one", () => {
  seedRunner();
  seedNights([null]);
  const ordinary = readWeek();
  assert.equal(easedByDip(ordinary), false);

  resetTables("garmin_daily_metrics");
  seedNights([null, 40, 40, 40]);
  const dipped = readWeek();
  assert.equal(
    easedByDip(dipped),
    true,
    `three low nights running are a real dip: ${JSON.stringify(dipped.rationale)}`
  );
  assert.ok(totalKm(dipped) < totalKm(ordinary), `the dip eases the week (${totalKm(dipped)} vs ${totalKm(ordinary)})`);
  // Bounded: never below a recovery week (0.8) off the 26 km week it steps from — the
  // dip's own 0.9, one fewer run only on a four-run week, the quality day a short set.
  assert.ok(totalKm(dipped) >= 26 * 0.8 - 0.05, `the trim is bounded (${totalKm(dipped)} vs ${totalKm(ordinary)} km)`);
  assert.ok(totalKm(dipped) <= 26 * 0.9 + 0.05, "and it is a real trim, not a build");
  // The long run steps a clear step UNDER the demonstrated 12 km — the spike / reset hold
  // (0.85) — never sized off the eased week's share.
  assert.ok(longKm(dipped) < longKm(ordinary), "the long run eases with it");
  assert.ok(
    longKm(dipped) >= 12 * 0.85 - 0.05,
    `the long run holds one step under the longest (got ${longKm(dipped)})`
  );
  assert.ok(longKm(dipped) <= 12 * 0.85 + 0.05);
  // The quality day keeps its short set (a trimmed week trims volume, not intensity).
  assert.ok(
    dipped.runs.some((r) => r.dose === "short"),
    "the quality day keeps a short set"
  );
});

test("a missing night neither starts nor ends a dip", () => {
  seedRunner();
  // Low, low, (never synced), low — the newest three READINGS are all low.
  seedNights([null, 40, null, 40, 40]);
  assert.equal(easedByDip(readWeek()), true, "the gap does not clear a real dip");
  // …and the pure core agrees, both ways.
  const past = (v) => v < 45;
  const nights = (vals) =>
    vals.map((value, i) => (value == null ? null : { date: addDays(TODAY, -i), value })).filter(Boolean);
  assert.equal(sustainedPastOwnLine(nights([null, 40, null, 40, 40]), TODAY, past, 3), true);
  assert.equal(sustainedPastOwnLine(nights([null, 40, null, 40]), TODAY, past, 3), false, "two readings are not three");
  assert.equal(sustainedPastOwnLine(nights([50, 40, 40, 40]), TODAY, past, 3), false, "a good newest night ends it");
  // A stale series is absent: the newest of the three is older than the sensor window.
  assert.equal(sustainedPastOwnLine(nights([null, null, null, null, 40, 40, 40]), TODAY, past, 3), false);
});

test("the supporting role: a dip trims the week, it does not collapse it to two-thirds", () => {
  seedRunner();
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
    },
  });
  const trainingIntent = {
    priorities: ["strength"],
    endurance_role: "supporting",
    endurance_capacity: null,
    source: "explicit",
  };
  seedNights([null]);
  const ordinary = readWeek({ trainingIntent });
  resetTables("garmin_daily_metrics");
  seedNights([null, 40, 40, 40]);
  const dipped = readWeek({ trainingIntent });
  assert.equal(easedByDip(dipped), true);
  assert.equal(dipped.runs.length, ordinary.runs.length, "the named days all stay");
  assert.ok(
    totalKm(dipped) >= 26 * 0.8 - 0.05,
    `bounded on the supporting role too (${totalKm(dipped)} vs ${totalKm(ordinary)} km)`
  );
  assert.ok(longKm(dipped) >= 12 * 0.85 - 0.05, `no long-run collapse (got ${longKm(dipped)})`);
});

test("runDayIntensity: last night absent → no HRV brake, no HRV support, no trailing-dip brake off a wobble", () => {
  seedRunner();
  seedNights([null, ...MIXED_WEEK.slice(1)]);
  const ev = runMorningEvidence(TODAY);
  assert.ok(!ev.floors.includes("hrv_below_own_band"), "an absent night is not a low one");
  assert.ok(!ev.supports.includes("hrv_at_usual"), "…nor a usual one");
  assert.ok(!ev.soft_brakes.includes("recovery_trend_down"), `no dip behind it either: ${JSON.stringify(ev)}`);
});

test("runDayIntensity: a real dip still rides as the trailing soft brake", () => {
  seedRunner();
  seedNights([null, 40, 40, 40]);
  const ev = runMorningEvidence(TODAY);
  assert.ok(ev.soft_brakes.includes("recovery_trend_down"), JSON.stringify(ev));
  assert.ok(!ev.floors.includes("hrv_below_own_band"), "last night itself never synced — no one-night floor");
});

test("recoveryDipRead: no own spread, no baseline, or too few nights → absent, never down", () => {
  const readings = [0, 1, 2].map((i) => ({ date: addDays(TODAY, -i), value: 30 }));
  const full = { baseline: { hrv: 52 }, dispersion: { hrv: 3 }, verified: { hrv_ms: { readings } } };
  assert.equal(recoveryDipRead(full, TODAY).hrv, true);
  assert.equal(recoveryDipRead({ ...full, dispersion: {} }, TODAY).hrv, false, "no spread of their own → no band");
  assert.equal(recoveryDipRead({ ...full, baseline: {} }, TODAY).hrv, false);
  assert.equal(
    recoveryDipRead({ ...full, verified: { hrv_ms: { readings: readings.slice(0, 2) } } }, TODAY).hrv,
    false,
    "two nights are not a trend"
  );
  assert.equal(recoveryDipRead(null, TODAY).down, false);
  // The 7% band is the floor on the line: a 6% drop on a very tight spread is not a dip.
  const tight = {
    baseline: { hrv: 50 },
    dispersion: { hrv: 0.5 },
    verified: { hrv_ms: { readings: readings.map((r) => ({ ...r, value: 47 })) } },
  };
  assert.equal(recoveryDipRead(tight, TODAY).hrv, false);
  // And the live summary's own shape reads the same way.
  seedNights([null, 40, 40, 40]);
  assert.equal(recoveryDipRead(getRecoverySummary(14), TODAY).hrv, true);
});

// ============================================================================
// Review round (r5).
// ============================================================================
import * as rdi from "../dist/repo/run-day-intensity.js";

// ---------- 6. the dip is counted once ----------
test("a dip the week already trimmed for is not charged again as the morning's soft brake", () => {
  const long = { kind_label: "long", label: "Long run", target_distance_km: 10.2 };
  const dipAndLegs = { floors: [], soft_brakes: ["recovery_trend_down", "legs_carrying_lift"], supports: [], athlete_word: null };
  // Without the week answering it, two soft brakes shorten the long run…
  assert.equal(rdi.runDayIntensity(TODAY, long, { evidence: dipAndLegs }).dose, "shortened");
  // …with it, the dip is already in the 0.85 hold: the legs alone do not shorten again.
  const once = rdi.runDayIntensity(TODAY, long, { evidence: dipAndLegs, weekAnswersDip: true });
  assert.equal(once.dose, "full", JSON.stringify(once));
  assert.ok(!once.brakes.includes("recovery_trend_down"));
  // The trimmed week's short set: the dip no longer outvotes a real green morning.
  const short = { kind_label: "quality", dose: "short", label: "Short hills", target_distance_km: 4 };
  const ev = { floors: [], soft_brakes: ["recovery_trend_down"], supports: ["felt_good", "legs_clear"], athlete_word: null };
  assert.equal(rdi.runDayIntensity(TODAY, short, { evidence: ev }).kind, "easy");
  assert.equal(rdi.runDayIntensity(TODAY, short, { evidence: ev, weekAnswersDip: true }).kind, "quality");
});

test("weeklyRunPlan hands the morning the fact that its trim is the dip's", () => {
  seedRunner();
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: (T + 2) % 7, kind: "easy" },
        { dow: (T + 4) % 7, kind: "quality" },
        { dow: T, kind: "long" },
      ],
      source: "athlete",
    },
  });
  seedNights([null, 40, 40, 40]);
  const plan = weeklyRunPlan(TODAY);
  assert.equal(easedByDip(plan), true);
  assert.equal(plan.adapt?.dip, true, JSON.stringify(plan.adapt));
  if (plan.today_adjustment) assert.ok(!plan.today_adjustment.brakes.includes("recovery_trend_down"));
});

// ---------- b. fresh strain keeps the supporting role's protection, bounded ----------
test("fresh strain (watch overreaching) keeps the supporting role constrained — the hard session sits out, the long run holds a bounded step", () => {
  seedRunner();
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
    },
  });
  const trainingIntent = { priorities: ["strength"], endurance_role: "supporting", endurance_capacity: null, source: "explicit" };
  const flat = { delta: {}, baseline: {}, recovery: {}, quality: {} };
  const strained = {
    delta: {},
    baseline: {},
    recovery: { training_status: "overreaching" },
    quality: { training_status: { freshness: "fresh" } },
  };
  const ordinary = readWeek({ trainingIntent, recovery: flat });
  const tired = readWeek({ trainingIntent, recovery: strained });
  assert.ok(ordinary.runs.some((r) => r.kind_label === "quality"), "precondition: an ordinary week keeps quality");
  assert.ok(!tired.runs.some((r) => r.kind_label === "quality"), `the hard session sits out: ${JSON.stringify(shape(tired))}`);
  assert.ok(totalKm(tired) < totalKm(ordinary));
  // Bounded: the long run holds one step under the demonstrated longest when the week
  // has room for it — never sized down to a share of the eased week.
  assert.ok(longKm(tired) >= 12 * 0.85 - 0.05 || longKm(tired) >= Math.max(...tired.runs.map((r) => r.target_distance_km)),
    `no long-run collapse (got ${longKm(tired)})`);
  assert.ok(longKm(tired) <= 12 * 0.85 + 0.05, "and it is a real hold");
});
