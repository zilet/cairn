// The Brief's headline beside a CHOSEN session (second review, item 14). When the athlete
// has chosen today's session on a training read, the hero shows that session; the day
// read's headline names the PLAN day. The Today aggregate serves a server-written line
// about the chosen session (`chosen_session_headline`) and leaves the read's cached prose
// and its identity alone. Synthetic fixtures only; deterministic and offline.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { todayAggregate } from "../dist/domain/today/today-surface.js";
import { getCachedDayRead } from "../dist/repo/day-read-cache.js";
import { DAY_READ_CHOSEN_SESSION_HEADLINE_VARIANTS, dayReadProseIdentity } from "../dist/repo/day-read-prose.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { localDaysAgo, repo, resetTables } from "./_seed.js";

const TODAY = localDaysAgo(0);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow }));

beforeEach(() => {
  resetTables(
    "daily_session_compositions",
    "daily_session_decisions",
    "logged_sets",
    "sessions",
    "day_reads",
    "plan_items",
    "plan_days",
    "exercises",
    "profile"
  );
  repo.savePlanDay(1, "Push", "Shoulders, chest & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  repo.savePlanDay(2, "Pull", "Back, biceps & rear delts", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
  repo.setProfile({ strength_schedule: { days: EVERY_DAY, source: "athlete", updated_at: TODAY } });
});

function trainRead() {
  return {
    kind: "train",
    headline: "Shoulders, chest & triceps today.",
    why: "Good day for it.",
    focus: "Shoulders, chest & triceps",
    est_minutes: 60,
    signals: {},
    source: "deterministic",
    override: null,
    decision: { rule_code: "planned_training" },
  };
}

const CHOSEN = {
  name: "Upper Body & Core",
  why: "The athlete wrote this one.",
  items: [{ exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 12 }],
};

test("a chosen session on a training read gets a headline about THAT session; the read's cached prose stands", () => {
  repo.saveDayRead(TODAY, trainRead());
  const before = getCachedDayRead(TODAY);
  repo.prepareDailySession({ date: TODAY, source: "athlete_override", session: CHOSEN });
  const today = todayAggregate(TODAY);
  assert.equal(today.open_session?.chosen, true);
  const headline = today.chosen_session_headline;
  assert.ok(headline, "a chosen session earns its own headline");
  assert.match(headline, /Upper Body & Core/, headline);
  assert.doesNotMatch(headline, /Shoulders, chest/i, "never the plan day's content");
  assert.equal(violatesReadingGrammar(headline), null, headline);
  // The day read itself is untouched: its headline, its why and its prose identity.
  const after = getCachedDayRead(TODAY);
  assert.equal(after.headline, before.headline);
  assert.equal(after.why, before.why);
  assert.equal(dayReadProseIdentity(TODAY, after), dayReadProseIdentity(TODAY, before));
});

test("the empty Open session gets a neutral line, never 'Open session today.'", () => {
  repo.saveDayRead(TODAY, trainRead());
  repo.prepareDailySession({
    date: TODAY,
    source: "athlete_override",
    session: { name: "Open session", focus: "Choose as you go", why: "A blank session.", est_minutes: null, items: [] },
  });
  const headline = todayAggregate(TODAY).chosen_session_headline;
  assert.ok(headline);
  assert.doesNotMatch(headline, /open session/i, headline);
  assert.ok(DAY_READ_CHOSEN_SESSION_HEADLINE_VARIANTS.includes(headline), headline);
});

test("no chosen session, or a quiet read, keeps the day read's own headline (null)", () => {
  repo.saveDayRead(TODAY, trainRead());
  assert.equal(todayAggregate(TODAY).chosen_session_headline, null, "nothing chosen");
  // A plain adaptive session the athlete only opened is not a choice.
  repo.prepareDailySession({ date: TODAY, source: "adaptive_plan" });
  assert.equal(todayAggregate(TODAY).open_session?.chosen, false);
  assert.equal(todayAggregate(TODAY).chosen_session_headline, null);
});

test("on a rest read the chosen session's headline stays the read's (the choice rides as the line's caveat)", () => {
  repo.saveDayRead(TODAY, { ...trainRead(), kind: "rest", headline: "Rest today.", focus: null });
  repo.prepareDailySession({ date: TODAY, source: "athlete_override", session: CHOSEN });
  assert.equal(todayAggregate(TODAY).open_session?.chosen, true);
  assert.equal(todayAggregate(TODAY).chosen_session_headline, null);
});

test("every chosen-session headline holds the reading grammar and carries no number", () => {
  assert.ok(DAY_READ_CHOSEN_SESSION_HEADLINE_VARIANTS.length >= 6);
  for (const line of DAY_READ_CHOSEN_SESSION_HEADLINE_VARIANTS) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /\d/, line);
    assert.match(line, /\.$/, line);
  }
});
