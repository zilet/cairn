// Track B — hybrid interference/synergy for a concurrent runner+lifter. Three
// deterministic seams are pinned here:
//   (1) repo.hybridDayContext(date) — the same-day/day-adjacent sequencing reads
//       (hard cardio yesterday, a double logged today, the next planned run, the
//       next heavy-lower day), all objective (activities + the stored plan) and null-safe.
//   (2) renderHybridSequencing(hc, today) — the compact session-prompt note, which
//       must fire ONLY on a real signal and be "" otherwise (the quiet-by-default pattern).
//   (3) weeklyRunPlan placement — the quality run avoids the day right after a leg day
//       and the long run prefers a day clear of a planned lower session, degrading to a
//       best-effort placement + note on a packed week (recovery gating stays outermost).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { renderHybridSequencing } from "../dist/prompt.js";

const REF = "2026-05-15";
const back = (n) => new Date(new Date(`${REF}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);
const fwd = (n) => new Date(new Date(`${REF}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

function resetAll() {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "garmin_daily_metrics",
    "program_blocks",
    "plan_proposals",
    "app_state",
    "bodyweight_log",
    "profile"
  );
}

beforeEach(resetAll);

// ── (1) hybridDayContext matrix ───────────────────────────────────────────────

test("hybridDayContext is all-null with no activities and no plan (graceful degradation)", () => {
  const hc = repo.hybridDayContext(REF);
  assert.equal(hc.hard_cardio_yesterday, null);
  assert.equal(hc.cardio_today, null);
  assert.equal(hc.planned_run_next, null);
  assert.equal(hc.heavy_lower_next, null);
});

test("hybridDayContext flags a genuinely HARD cardio effort logged yesterday", () => {
  repo.addActivity({ type: "run", duration_min: 48, distance_km: 9, date: back(1) });
  const hc = repo.hybridDayContext(REF);
  assert.ok(hc.hard_cardio_yesterday, "a 48-min run yesterday reads as hard cardio");
  assert.equal(hc.hard_cardio_yesterday.type, "run");
  assert.equal(hc.hard_cardio_yesterday.minutes, 48);
  assert.match(hc.hard_cardio_yesterday.why, /hard/i);
  assert.equal(hc.cardio_today, null);
});

test("hybridDayContext does NOT flag an easy stroll yesterday as hard cardio", () => {
  repo.addActivity({ type: "walk", duration_min: 30, date: back(1) });
  const hc = repo.hybridDayContext(REF);
  assert.equal(hc.hard_cardio_yesterday, null, "a short easy walk clears no hard-cardio bar");
});

test("hybridDayContext surfaces a same-day double (cardio already logged today)", () => {
  repo.addActivity({ type: "run", duration_min: 45, distance_km: 8, date: REF });
  const hc = repo.hybridDayContext(REF);
  assert.ok(hc.cardio_today, "today's run is the same-day-double signal");
  assert.equal(hc.cardio_today.type, "run");
  assert.equal(hc.cardio_today.minutes, 45);
  assert.equal(hc.cardio_today.hard, true, "a 45-min run clears the hard bar");
  assert.equal(hc.cardio_today.sport, "run", "the canonical sport bucket is carried for the note tiers");
});

test("hybridDayContext reads the next planned run from the stored plan", () => {
  // A single plan day carrying a long run — the projection lands on it tomorrow.
  repo.setWeeklyRuns([{ day_number: 1, label: "Long run", target_distance_km: 15, target_zone: "Z2" }]);
  const hc = repo.hybridDayContext(REF);
  assert.ok(hc.planned_run_next, "a planned run is surfaced");
  assert.equal(hc.planned_run_next.date, fwd(1));
  assert.equal(hc.planned_run_next.kind, "long");
  assert.equal(hc.planned_run_next.km, 15);
});

test("hybridDayContext projects a planned run across the Sun→Mon week boundary to the right date", () => {
  // A 7-day plan (day_numbers 1..7 fill Mon..Sun by the rotation convention) with a run ONLY
  // on day 1 (Monday). From a WEDNESDAY, the scan walks Thu→Sun and lands the run on the next
  // Monday — 5 days out, crossing the Sunday→Monday wrap in the weekday projection.
  const WED = "2026-05-13"; // a Wednesday (getUTCDay === 3)
  const monday = new Date(new Date(`${WED}T00:00:00Z`).getTime() + 5 * 864e5).toISOString().slice(0, 10);
  for (let dn = 1; dn <= 7; dn++) {
    repo.savePlanDay(dn, `Day ${dn}`, "Upper body", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  }
  repo.setWeeklyRuns([{ day_number: 1, label: "Easy run", target_distance_km: 6, target_zone: "Z2" }]);
  const hc = repo.hybridDayContext(WED);
  assert.ok(hc.planned_run_next, "the run is found across the week boundary");
  assert.equal(hc.planned_run_next.date, monday, "resolves to next Monday (the run's projected day)");
  assert.equal(hc.planned_run_next.kind, "easy");
  assert.equal(hc.planned_run_next.km, 6);
});

test("hybridDayContext reads the next heavy-lower plan day", () => {
  repo.savePlanDay(1, "Legs", "Lower body", [{ exercise: "Back Squat", sets: 5, rep_low: 3, rep_high: 5 }]);
  const hc = repo.hybridDayContext(REF);
  assert.ok(hc.heavy_lower_next, "a squat day is a heavy-lower day");
  assert.equal(hc.heavy_lower_next.date, fwd(1));
  assert.match(hc.heavy_lower_next.focus, /lower/i);
});

test("hybridDayContext heavy-lower excludes a calf-only day (not a squat/hinge day)", () => {
  repo.savePlanDay(1, "Calves", "Calves", [{ exercise: "Standing Calf Raise", sets: 4, rep_low: 10, rep_high: 15 }]);
  const hc = repo.hybridDayContext(REF);
  assert.equal(hc.heavy_lower_next, null, "a calf-raise day never gates a run");
});

// ── (2) renderHybridSequencing — fires only on a real signal ──────────────────

test("renderHybridSequencing is empty when nothing sequences", () => {
  assert.equal(renderHybridSequencing(null, REF), "");
  assert.equal(
    renderHybridSequencing(
      { hard_cardio_yesterday: null, cardio_today: null, planned_run_next: null, heavy_lower_next: null },
      REF
    ),
    ""
  );
});

test("renderHybridSequencing tiers the same-day double by outing intensity/type", () => {
  // (a) a HARD outing → the full one-stimulus / lift-first / fuel-both framing, named by sport.
  const hard = renderHybridSequencing({ cardio_today: { type: "run", minutes: 45, hard: true, sport: "run" } }, REF);
  assert.match(hard, /DOUBLE DAY/);
  assert.match(hard, /ONE stimulus/);
  assert.match(hard, /FIRST/);
  assert.match(hard, /run's fatigue/, "names the actual sport, not a hardcoded one");

  // (b) a real-but-easy endurance outing (a 43-min hike, not hard) → ONE soft fuel line only.
  const soft = renderHybridSequencing({ cardio_today: { type: "hike", minutes: 43, hard: false, sport: "walk" } }, REF);
  assert.match(soft, /DOUBLE DAY/);
  assert.match(soft, /fuel around both/);
  assert.doesNotMatch(soft, /ONE stimulus|FIRST/, "an easy outing does not get the strong lift-first framing");
  assert.match(soft, /\bhike\b/, "names the sport");

  // (b') an easy run (real endurance by sport even under 40 min) → the soft line.
  const easyRun = renderHybridSequencing(
    { cardio_today: { type: "run", minutes: 25, hard: false, sport: "run" } },
    REF
  );
  assert.match(easyRun, /fuel around both/);
  assert.doesNotMatch(easyRun, /ONE stimulus/);

  // (c) a short errand walk (not hard, not a real endurance outing) → no note at all.
  const stroll = renderHybridSequencing(
    { cardio_today: { type: "walk", minutes: 20, hard: false, sport: "walk" } },
    REF
  );
  assert.equal(stroll, "", "a 20-min stroll never reads as a competing stimulus");
});

test("renderHybridSequencing voices hard cardio yesterday", () => {
  const out = renderHybridSequencing(
    { hard_cardio_yesterday: { type: "run", minutes: 48, why: "a hard running (48 min) yesterday" } },
    REF
  );
  assert.match(out, /HARD CARDIO YESTERDAY/);
  assert.match(out, /MODERATE/);
});

test("renderHybridSequencing protects the legs before a quality run TOMORROW only", () => {
  const tomorrow = new Date(new Date(`${REF}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
  const laterDate = new Date(new Date(`${REF}T00:00:00Z`).getTime() + 3 * 864e5).toISOString().slice(0, 10);
  // A quality run tomorrow → the protect-the-legs note fires.
  assert.match(
    renderHybridSequencing({ planned_run_next: { date: tomorrow, kind: "quality", km: 8 } }, REF),
    /KEY RUN TOMORROW/
  );
  // An EASY run tomorrow does not gate today's leg work.
  assert.doesNotMatch(
    renderHybridSequencing({ planned_run_next: { date: tomorrow, kind: "easy", km: 6 } }, REF),
    /KEY RUN TOMORROW/
  );
  // A quality run several days out does not fire the note today.
  assert.doesNotMatch(
    renderHybridSequencing({ planned_run_next: { date: laterDate, kind: "quality", km: 8 } }, REF),
    /KEY RUN TOMORROW/
  );
  // STRICT guard: with no valid `today` we can't prove it's tomorrow, so we stay quiet
  // (the note must NOT fall through and fire for any non-easy run).
  assert.doesNotMatch(
    renderHybridSequencing({ planned_run_next: { date: tomorrow, kind: "quality", km: 8 } }),
    /KEY RUN TOMORROW/
  );
  assert.doesNotMatch(
    renderHybridSequencing({ planned_run_next: { date: tomorrow, kind: "quality", km: 8 } }, "not-a-date"),
    /KEY RUN TOMORROW/
  );
});

// ── (3) weeklyRunPlan placement awareness ─────────────────────────────────────

// Days apart on the Mon–Sun ring the template actually repeats on: 7 and 1 are
// neighbours, so a Sunday run is one day from a Saturday one, not six.
const ringDays = (a, b) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));

function seedRunner() {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({
    endurance_goal: {
      mode: "race",
      event: "Test Half",
      date: fwd(84),
      distance_km: 21.1,
      weekly_km: 35,
      weekly_sessions: 4,
    },
  });
  for (let wk = 0; wk < 10; wk++) {
    for (const off of [1, 3, 5]) {
      repo.addActivity({ type: "run", duration_min: 54, distance_km: 9, date: back(wk * 7 + off) });
    }
  }
}

test("weeklyRunPlan keeps quality on 2 / long on 6 when there are no leg days (baseline)", () => {
  seedRunner();
  const plan = repo.weeklyRunPlan(REF);
  assert.equal(plan.available, true);
  assert.equal(plan.runs.find((r) => r.kind_label === "quality")?.day_number, 2);
  assert.equal(plan.runs.find((r) => r.kind_label === "long")?.day_number, 6);
});

test("weeklyRunPlan shifts the quality run off the day right after a leg day", () => {
  seedRunner();
  // A heavy-lower day on plan day 1 → the day after (2) is the default quality slot.
  repo.savePlanDay(1, "Legs", "Lower body", [{ exercise: "Back Squat", sets: 5, rep_low: 3, rep_high: 5 }]);
  const plan = repo.weeklyRunPlan(REF);
  const quality = plan.runs.find((r) => r.kind_label === "quality");
  assert.ok(quality, "a quality session is still included");
  assert.notEqual(quality.day_number, 2, "the quality run moves off the day after leg day");
  // Measured on the RING, not the line: the quality slot can now reach Monday and
  // Sunday, and Sunday is one day from a Saturday long run however |s − 6| reads.
  assert.ok(ringDays(quality.day_number, 6) >= 2, "no two hard days back-to-back");
  assert.ok(
    plan.rationale.some((r) => /quality run off the day after/i.test(r)),
    "the shift is noted in plain words"
  );
});

test("weeklyRunPlan places the long run clear of a planned leg day on slot 6", () => {
  seedRunner();
  // A heavy-lower day on plan day 6 collides with the default long slot.
  repo.savePlanDay(6, "Legs", "Lower body", [{ exercise: "Back Squat", sets: 5, rep_low: 3, rep_high: 5 }]);
  const plan = repo.weeklyRunPlan(REF);
  const long = plan.runs.find((r) => r.kind_label === "long");
  assert.ok(long, "a long run is still in the mix");
  assert.notEqual(long.day_number, 6, "the long run moves off the leg day");
  assert.ok(
    plan.rationale.some((r) => /long run clear of your planned leg days/i.test(r)),
    "the placement is noted in plain words"
  );
});

test("weeklyRunPlan degrades gracefully on a packed week — places anyway and notes it", () => {
  seedRunner();
  // Every day is a leg day: there's no clean slot left, so placement falls back with a note.
  for (let dn = 1; dn <= 7; dn++) {
    repo.savePlanDay(dn, `Legs ${dn}`, "Lower body", [{ exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 }]);
  }
  const plan = repo.weeklyRunPlan(REF);
  // The plan still carries its full mix — placement never drops a run.
  assert.ok(
    plan.runs.find((r) => r.kind_label === "long"),
    "the long run is placed anyway"
  );
  assert.ok(
    plan.runs.find((r) => r.kind_label === "quality"),
    "the quality run is placed anyway"
  );
  assert.ok(
    plan.rationale.some((r) => /packed|couldn't fully separate|still lands near a leg day/i.test(r)),
    "the compromise is carried as a one-line note"
  );
});
