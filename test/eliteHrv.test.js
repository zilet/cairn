// WEARABLE RECOVERY DIRECTIVES read the athlete's OWN week, clear on the sync that shows
// the week is back, say what they are, and reach prompts as CONTEXT, not orders.
//
// An HRV / resting-HR directive is a standing card and a line in every coach prompt, so it
// must be about something that lasts: the average of the last seven days' nights against
// the athlete's own band (Garmin's balanced range), the population zone only as a softer
// fallback — never a single short night, which is the day read's job. Synthetic values only.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables } from "./_seed.js";
import { ingestHealthMetrics } from "../dist/routes/health-metrics.js";
import { projectCoachContext } from "../dist/prompt/context-projection.js";
import { renderConnectedBrain } from "../dist/prompt/shared.js";

beforeEach(() => {
  resetTables("garmin_daily_metrics", "daily_metrics", "health_documents", "health_directives", "app_state", "brain_decisions");
});

const band = (lo, hi) => ({ hrv: { hrvSummary: { baseline: { balancedLow: lo, balancedUpper: hi } } } });
// nights[i] is the reading i days ago (null = no night).
const garminWeek = (nights, raw = band(43, 53)) => {
  nights.forEach((v, i) => {
    if (v != null) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: v, raw });
  });
};
const active = (marker) => repo.listActiveDirectives().filter((d) => d.marker === marker);

test("one short night inside a normal week raises no HRV directive", () => {
  // Last night 34 ms — below the athlete's own band — but the week averages ~46.
  garminWeek([34, 48, 49, 48, 47, 49, 48]);
  repo.deriveDirectives();
  assert.equal(active("HRV").length, 0, "a single night is the day read's job, never a directive's");
});

test("a week averaging below the athlete's OWN band raises it, anchored on the average and worded as a trend", () => {
  // This athlete's own band is 43–53 and the week averages ~40.
  garminWeek([41, 40, 39, 42, 40, 38, 41]);
  repo.deriveDirectives();
  const [d] = active("HRV");
  assert.ok(d, "a sustained dip below the own band is a directive");
  assert.ok(Math.abs(Number(d.trigger_value) - 40.1) < 0.2, `trigger is the week's average, got ${d.trigger_value}`);
  assert.equal(d.trigger_date, localDaysAgo(0));
  assert.match(d.directive, /your own usual range/);
  assert.match(d.directive, /last week/);
  assert.doesNotMatch(d.directive, /read it as a trend, not a single night/);
  assert.doesNotMatch(d.directive, /favor easy aerobic work/i, "context, not an order");
});

test("a week inside the own band never falls back to the population floor", () => {
  // 47 ms is under the population zone (50–120) but inside this athlete's band.
  garminWeek([47, 46, 48, 47, 46, 47, 48]);
  repo.deriveDirectives();
  assert.equal(active("HRV").length, 0);
});

test("with no personal band the population floor is a softer, uncertain fallback", () => {
  garminWeek([44, 45, 43, 44, 46, 44, 45], {});
  repo.deriveDirectives();
  const [d] = active("HRV");
  assert.ok(d, "population fallback still speaks");
  assert.equal(Boolean(d.uncertain), true);
  assert.match(d.directive, /broad population range/);
  assert.match(d.directive, /read this loosely/);
});

test("too few nights in the week is no trend and no directive", () => {
  garminWeek([30, null, null, null, null, 31, null]);
  repo.deriveDirectives();
  assert.equal(active("HRV").length, 0);
});

test("the wearable re-derive clears the card on the sync that brings the week back, and never touches a lab directive", () => {
  // Six low nights (yesterday back): the directive stands.
  garminWeek([null, 38, 39, 40, 38, 39, 40]);
  repo.deriveDirectives();
  assert.equal(active("HRV").length, 1);
  const lab = repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "ApoB is above optimal — lab lever.",
    trigger_value: 120,
    trigger_side: "high",
    trigger_date: localDaysAgo(30),
  });
  // A strong week: tonight's sync lands 58 and rewrites the week above 43 on average.
  for (let i = 1; i <= 3; i++) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 52, raw: band(43, 53) });
  repo.upsertGarminDailyMetric({ date: localDaysAgo(0), hrv_ms: 58, raw: band(43, 53) });
  const out = repo.deriveWearableDirectives();
  assert.ok(out.changed >= 1);
  assert.equal(active("HRV").length, 0, "cleared on this sync, not at the next daily tick");
  assert.equal(active("ApoB").length, 1, "a lab directive is outside the wearable pass");
  assert.equal(active("ApoB")[0].id, lab.id);
});

test("an Apple Health ingest carrying HRV re-derives the wearable directives in the same call", () => {
  for (let i = 1; i <= 5; i++) repo.recordDailyMetrics("apple", localDaysAgo(i), { hrv_ms: 30 });
  repo.deriveDirectives();
  assert.equal(active("HRV").length, 1);
  ingestHealthMetrics(
    [0, 1, 2, 3, 4].map((i) => ({ source: "apple", date: localDaysAgo(i), hrv_ms: 70 }))
  );
  assert.equal(active("HRV").length, 0);
});

test("resting HR reads the week too — one high morning is not a directive, a high week is worded as one", () => {
  const rhr = (vals) => vals.forEach((v, i) => repo.upsertGarminDailyMetric({ date: localDaysAgo(i), resting_hr: v }));
  rhr([72, 54, 55, 53, 54, 55, 54]);
  repo.deriveDirectives();
  assert.equal(active("Resting HR").length, 0, "one high morning inside a normal week");
  rhr([66, 65, 67, 64, 66, 65, 66]);
  repo.deriveDirectives();
  const training = active("Resting HR").find((d) => d.domain === "training");
  assert.ok(training);
  assert.match(training.directive, /across the last week/);
  assert.equal(Boolean(training.uncertain), true);
});

test("HRV directives reach prompts as context, never as an instruction; lab directives pass untouched", () => {
  garminWeek([41, 40, 39, 42, 40, 38, 41]);
  repo.deriveDirectives();
  repo.addDirective({ source: "markers", domain: "nutrition", marker: "ApoB", directive: "ApoB lab lever.", trigger_value: 120, trigger_side: "high" });
  const coach = repo.directivesForCoach();
  const hrv = coach.find((d) => d.marker === "HRV");
  const apob = coach.find((d) => d.domain === "nutrition");
  assert.equal(hrv.role, "recovery_context");
  assert.equal(apob.role, undefined);

  const projected = projectCoachContext({ directives: coach }, "day_read").directives;
  const pHrv = projected.find((d) => d.marker === "HRV");
  const pApob = projected.find((d) => d.domain === "nutrition");
  assert.equal(pHrv.directive, undefined, "no `directive` key for a recovery read");
  assert.equal(pHrv.context_note, hrv.directive);
  assert.equal(pApob.directive, "ApoB lab lever.");
  // Structure, not string surgery: the payload still round-trips as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);

  const block = renderConnectedBrain({ directives: coach }, { domains: ["training", "watch"] });
  assert.match(block, /RECOVERY-TREND CONTEXT/);
  assert.doesNotMatch(block, /honor these/, "the HRV read is not in the honor-these list");
});

test("the trend window is the mean of the week's readings and needs three nights", () => {
  const asOf = "2026-09-23";
  const pts = [
    { date: "2026-09-15", value: 30 }, // outside the week
    { date: "2026-09-17", value: 46 },
    { date: "2026-09-18", value: 41 },
    { date: "2026-09-19", value: 44 },
    { date: "2026-09-20", value: 37 },
    { date: "2026-09-23", value: 55 },
  ];
  assert.deepEqual(repo.wearableTrendWindow(pts, asOf), { value: 44.6, nights: 5, from: "2026-09-17", to: "2026-09-23" });
  assert.equal(repo.wearableTrendWindow(pts.slice(-2), asOf), null);
});
