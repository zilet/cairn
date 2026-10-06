// runZonesOneSource.test.js — one heart-rate model, one set of bands, on every surface.
//
// The demo seed showed a run's zone text "Z2 (129–141 bpm)" beside a structured band of
// 107–125: the run engine drew Karvonen bands off the athlete's resting HR (it hands
// runZones the morning recovery summary), while the day detail — like GET /run-zones —
// called runZones with nothing in hand and got plain max-HR bands. runZones now reads the
// recovery aggregate itself when the caller hands none, so the engine's zone text, the day
// detail's structured bands and segments, the agenda's intents and the zones endpoint all
// agree; and with a personal model the race build's easy ceiling is that same Z2 top.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { runZones, weeklyRunPlan } from "../dist/repo/run-progression.js";
import { flexibleTrainingAgenda } from "../dist/repo/flexible-training-agenda.js";
import { raceBuild } from "../dist/repo/race-build.js";
import { zonesFromLthr, easyCeilingFromZ2Top } from "../dist/repo/hr-model.js";

const NOW = new Date("2026-04-21T12:00:00");
const MONDAY = "2026-04-20";
const TUESDAY = "2026-04-21";
const THURSDAY = "2026-04-23";
const SUNDAY = "2026-04-26";

beforeEach(() =>
  resetTables("activities", "daily_metrics", "garmin_daily_metrics", "profile", "plan_items", "plan_days", "hr_model_state")
);

function seedRunner(t) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: {
      mode: "race",
      event: "Riverside Half",
      date: "2026-06-28",
      distance_km: 21.1,
      target: "sub-1:50",
    },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
      updated_at: MONDAY,
    },
  });
  const before = (n) => new Date(Date.parse(`${MONDAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  for (let wk = 0; wk < 10; wk++)
    for (const off of [1, 3, 5])
      repo.addActivity({ type: "run", duration_min: 54, distance_km: 9, date: before(wk * 7 + off) });
  // A resting heart rate on the record — what the Karvonen bands are drawn from.
  for (let n = 1; n <= 10; n++) repo.recordDailyMetrics("apple", before(n), { resting_hr: 52 });
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const tagBand = (text) => {
  const m = /\((\d+)–(\d+) bpm\)/.exec(String(text ?? ""));
  return m ? { low_bpm: Number(m[1]), high_bpm: Number(m[2]) } : null;
};

function assertOneBand(date) {
  const read = dayDetail(date);
  const run = read?.run;
  assert.ok(run?.zone, `${date}: a run with a zone`);
  const fromText = tagBand(run.zone.text);
  if (run.zone.key === "Z2" || run.kind !== "quality") {
    assert.deepEqual(fromText, { low_bpm: run.zone.low_bpm, high_bpm: run.zone.high_bpm }, `${date}: ${run.zone.text}`);
  }
  const endpoint = runZones().zones.find((z) => z.zone === run.zone.key);
  assert.deepEqual(
    { low_bpm: run.zone.low_bpm, high_bpm: run.zone.high_bpm },
    { low_bpm: endpoint.low_bpm, high_bpm: endpoint.high_bpm },
    `${date}: the zones endpoint draws the same band`
  );
  for (const segment of run.structure) {
    if (!segment.zone || !segment.hr) continue;
    const band = runZones().zones.find((z) => z.zone === segment.zone);
    assert.deepEqual(segment.hr, { low_bpm: band.low_bpm, high_bpm: band.high_bpm }, `${date} ${segment.part}`);
  }
  return run;
}

test("formula zones: the engine's text, the day detail's bands and segments, the agenda and the endpoint agree", (t) => {
  seedRunner(t);
  const zones = runZones();
  assert.equal(zones.reserve, true, "the resting HR on the record draws Karvonen bands");
  for (const date of [TUESDAY, THURSDAY, SUNDAY]) assertOneBand(date);
  const z2 = zones.zones.find((z) => z.zone === "Z2");
  const tag = `Z2 (${z2.low_bpm}–${z2.high_bpm} bpm)`;
  for (const rx of weeklyRunPlan(TUESDAY).runs.filter((r) => r.kind_label !== "quality"))
    assert.equal(rx.target_zone, tag, "the engine's tag is the endpoint's band");
  const agenda = flexibleTrainingAgenda(TUESDAY);
  for (const intent of (agenda.intents ?? []).filter((i) => i.kind !== "quality" && i.target_zone))
    assert.equal(intent.target_zone, tag, `agenda ${intent.suggested_date}`);
});

test("a stale resting HR draws no Karvonen band on ANY surface — the engine included", (t) => {
  seedRunner(t);
  // Only readings ten days old and more: the aggregate's newest night is stale.
  db.prepare(`DELETE FROM daily_metrics`).run();
  for (let n = 10; n <= 14; n++)
    repo.recordDailyMetrics("apple", addDays(TUESDAY, -n), { resting_hr: 52 });
  assert.equal(runZones().reserve, false, "a stale reading behaves as absent");
  const z2 = runZones().zones.find((z) => z.zone === "Z2");
  for (const rx of weeklyRunPlan(TUESDAY).runs.filter((r) => r.kind_label !== "quality"))
    assert.equal(rx.target_zone, `Z2 (${z2.low_bpm}–${z2.high_bpm} bpm)`, "the engine keeps the same law");
  assertOneBand(TUESDAY);
});

test("personal model: every surface reads the model's bands, and the race build's easy ceiling is its Z2 top", (t) => {
  seedRunner(t);
  const zones = zonesFromLthr(166);
  db.prepare(`INSERT INTO hr_model_state (id, as_of, model_json, updated_at) VALUES (1, ?, ?, datetime('now'))`).run(
    TUESDAY,
    JSON.stringify({
      observed_max: 186,
      lthr: 166,
      lthr_basis: "sustained_effort",
      zones,
      resting: 52,
      confidence: "estimated",
      easy_basis: "lthr",
      talk_test_runs: 0,
      basis_runs: 30,
      window_days: 183,
      updated_at: null,
    })
  );
  const tue = assertOneBand(TUESDAY);
  assert.equal(tue.zone.low_bpm, zones.z1_top + 1);
  assert.equal(tue.zone.high_bpm, zones.z2_top);
  const build = raceBuild(TUESDAY);
  const easy = (build?.paces?.bands ?? []).find((b) => b.key === "easy");
  if (easy?.hr_ceiling_bpm != null) {
    assert.equal(easy.hr_ceiling_bpm, easyCeilingFromZ2Top(tue.zone.high_bpm), "the ceiling is the band's top + the one tolerance");
    assert.equal(tue.hr_ceiling_bpm, easy.hr_ceiling_bpm, "the day detail carries the build's ceiling");
  } else {
    assert.fail(`the race build carried no easy ceiling: ${JSON.stringify(build?.paces?.bands)}`);
  }
});
