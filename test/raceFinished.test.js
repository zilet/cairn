// The race just run, said back (src/repo/race-finished.ts): the logged result in the
// athlete's units, the recovery days (race-recovery.ts's own window, said from race
// day), and the next dated race as a forward line — for two weeks, then quiet.
// Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { raceBuild } from "../dist/repo/race-build.js";
import { raceFinishedRead } from "../dist/repo/race-finished.js";
import { RACE_FINISHED_SHOWN_DAYS } from "../dist/repo/race-recovery.js";
import { repo, resetTables } from "./_seed.js";

const RACE = "2026-11-01"; // a Sunday half: recovery Mon 11-02 .. Thu 11-05, full again Fri 11-06

beforeEach(() => {
  resetTables("activities", "garmin_activities", "context_events", "app_state", "profile");
});

function seed({ goal } = {}) {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal:
      goal === null
        ? null
        : { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00", ...(goal ?? {}) },
  });
  repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: "2026-10-27" });
  repo.addActivity({ type: "run", duration_min: 130.3, distance_km: 21.18, date: RACE });
}

test("race day: the result in the athlete's units, recovery ahead, no next race yet", () => {
  seed();
  const f = raceFinishedRead(RACE, { units: "mi" });
  assert.ok(f);
  assert.equal(f.event, "Riverside Half");
  assert.equal(f.date, RACE);
  assert.equal(f.days_since, 0);
  assert.equal(f.finish_sec, 7818);
  assert.match(f.result_line, /^13\.2 mi in 2:10:18 · 9:54 \/mi · Sun, Nov 1$/);
  assert.ok(f.headline.includes("Riverside Half"));
  assert.equal(f.recovering, true);
  assert.match(f.recovery_line, /Thursday/);
  assert.match(f.recovery_line, /Friday/);
  assert.equal(f.next_line, null);
});

test("a new goal loops on: the next race toward its target, the race kept behind", () => {
  seed();
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Spring 5K", date: "2027-05-16", distance_km: 5, target: "sub-20:00" },
  });
  const f = raceFinishedRead("2026-11-02", {
    units: "km",
    next: { event: "Spring 5K", date: "2027-05-16", distance_km: 5, target_sec: 1200, estimate_sec: 1386, fit: "beyond_horizon" },
  });
  assert.ok(f);
  assert.equal(f.event, "Riverside Half");
  assert.equal(f.next_line, "Next: Spring 5K, May 16, 2027 · 23:06 now, 3:06 to find for 20:00.");
  // The build hands its own race in as "next".
  const build = raceBuild("2026-11-02", { describeRunning: true, units: "km" });
  assert.ok(build.finished);
  assert.match(build.finished.next_line ?? "", /^Next: Spring 5K, May 16, 2027/);
  // An internal caller never pays for the read.
  assert.equal(raceBuild("2026-11-02").finished, undefined);
});

test("the goal still pointing at the race just run is never its own 'next'", () => {
  seed();
  const f = raceFinishedRead("2026-11-02", {
    next: { event: "Riverside Half", date: RACE, distance_km: 21.1, target_sec: 7200, estimate_sec: 6600, fit: "fits" },
  });
  assert.equal(f?.next_line, null);
});

test("the last easy day, then 'back to full', then quiet after two weeks", () => {
  seed();
  repo.setProfile({ endurance_goal: null }); // the goal cleared after the race: it is kept behind
  assert.equal(raceFinishedRead("2026-11-05")?.recovering, true);
  const after = raceFinishedRead("2026-11-08");
  assert.equal(after?.recovering, false);
  assert.match(after?.recovery_line ?? "", /since/);
  const lastShown = new Date(Date.parse(`${RACE}T00:00:00Z`) + RACE_FINISHED_SHOWN_DAYS * 864e5).toISOString().slice(0, 10);
  assert.ok(raceFinishedRead(lastShown));
  const gone = new Date(Date.parse(`${lastShown}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  assert.equal(raceFinishedRead(gone), null);
});

test("no logged effort, no finished race (the provisional goal date never celebrates)", () => {
  repo.setProfile({
    age: 40,
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1 },
  });
  repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: "2026-10-27" });
  assert.equal(raceFinishedRead("2026-11-02"), null);
});

test("the race day's run is named for what it was, not the long run its weekday held", async () => {
  seed();
  repo.setProfile({ endurance_goal: null });
  const { raceEffortRunLabel } = await import("../dist/repo/race-recovery.js");
  assert.equal(raceEffortRunLabel(RACE), "Half marathon test");
  assert.equal(raceEffortRunLabel("2026-10-27"), null);
  const { planWeek } = await import("../dist/domain/training/plan-week.js");
  const cell = planWeek("2026-10-26").days?.find((d) => d.date === RACE);
  if (cell?.run) assert.equal(cell.run.label, "Half marathon test");
});

test("a health hold's wording agrees in number", async () => {
  const { enduranceHoldRecovers } = await import("../dist/repo/directives-read.js");
  assert.equal(enduranceHoldRecovers({ marker: "Vitamin D" }), "your bloodwork recovers");
  assert.equal(enduranceHoldRecovers({ marker: "Ferritin" }), "your iron stores recover");
});
