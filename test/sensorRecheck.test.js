// The sensor baseline-recheck loop (src/repo/sensor-recheck.ts) — the ONE calm,
// optional offer an episodic wearer gets when the picture of their own recovery
// range has aged past the point where a single night would visibly sharpen it.
//
// Constitution-critical properties pinned here: it never fires for a daily wearer
// (nothing to sharpen) or a never-wearer (that is onboarding, not a recheck); a
// new reading clears it outright; it is said ONCE and then goes quiet for a real
// cooldown; the wording rotates rather than repeating a literal; and its presence
// or absence can never move the day read or the next step.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import {
  SENSOR_RECHECK_FIRM_DAYS,
  SENSOR_RECHECK_SOFT_DAYS,
  reconcileSensorRecheckAttention,
  sensorBaselineRecheck,
  sensorRecheckCandidate,
  sensorRecheckDecision,
  sensorRecheckGrammarPool,
  sensorRecheckLine,
  sensorRecheckState,
} from "../dist/repo/sensor-recheck.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNAL_KEY = "recovery:sensor-recheck";

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// A pure-core fixture: an episodic wearer whose newest reading is `ageDays` old
// and who has a real personal range behind it.
function episodic(ageDays, extra = {}) {
  const today = "2026-07-30";
  const last = addDaysISO(today, -ageDays);
  return {
    today,
    pattern: "spot_check",
    history_readings: 14,
    dimensions: [
      { key: "hrv", last_reading_date: last, band_readings: 12 },
      { key: "rhr", last_reading_date: last, band_readings: 12 },
      { key: "sleep", last_reading_date: last, band_readings: 12 },
    ],
    ...extra,
  };
}

// The DB fixture the acceptance criteria are written against: a spot-check wearer
// with 12 readings spread over ~4 months, the newest of them six weeks old. Every
// date is far enough apart that the 90-day cadence window reads spot_check, and
// there are enough readings inside the 180-day range lookback to have earned a
// personal range.
const EPISODIC_OFFSETS = [42, 46, 50, 55, 60, 66, 72, 80, 92, 104, 118, 130];
function seedEpisodicWearer() {
  for (const daysAgo of EPISODIC_OFFSETS) {
    repo.recordDailyMetrics("apple", localDaysAgo(daysAgo), { hrv_ms: 52, resting_hr: 54, sleep_min: 430 });
  }
}

beforeEach(() => {
  resetTables("daily_metrics", "garmin_daily_metrics", "attention_schedule", "app_state");
});

// ---- the pure decision core --------------------------------------------------

test("an episodic wearer six weeks past their last night gets exactly ONE offer, correctly aged", () => {
  const r = sensorRecheckDecision(episodic(42));
  assert.ok(r, "six weeks of silence is past the threshold");
  assert.equal(r.last_reading_age_days, 42);
  assert.equal(r.last_reading_date, addDaysISO("2026-07-30", -42));
  assert.equal(r.tier, "soft");
  assert.equal(r.reason_key, "recovery_range_ageing");
  // One suggestion covering all three dimensions — never three suggestions.
  assert.deepEqual(r.dimensions, ["hrv", "rhr", "sleep"]);
});

test("the soft threshold is a threshold: one day under is silence, the day itself speaks", () => {
  assert.equal(sensorRecheckDecision(episodic(SENSOR_RECHECK_SOFT_DAYS - 1)), null);
  assert.ok(sensorRecheckDecision(episodic(SENSOR_RECHECK_SOFT_DAYS)));
});

test("past ten weeks the same offer firms up, without ever becoming urgent", () => {
  assert.equal(sensorRecheckDecision(episodic(SENSOR_RECHECK_FIRM_DAYS - 1)).tier, "soft");
  const firm = sensorRecheckDecision(episodic(SENSOR_RECHECK_FIRM_DAYS));
  assert.equal(firm.tier, "firm");
  assert.equal(firm.reason_key, "recovery_range_historical");
});

test("a daily wearer never sees it — their picture is fresh by construction", () => {
  assert.equal(sensorRecheckDecision(episodic(42, { pattern: "continuous" })), null);
});

test("a never-wearer never sees it — that is onboarding, not a recheck", () => {
  const empty = {
    today: "2026-07-30",
    pattern: "none",
    history_readings: 0,
    dimensions: [
      { key: "hrv", last_reading_date: null, band_readings: 0 },
      { key: "rhr", last_reading_date: null, band_readings: 0 },
      { key: "sleep", last_reading_date: null, band_readings: 0 },
    ],
  };
  assert.equal(sensorRecheckDecision(empty), null);
});

test("a handful of readings is not a picture to sharpen — the history floor holds", () => {
  const thin = episodic(42, {
    history_readings: 4,
    dimensions: [
      { key: "hrv", last_reading_date: addDaysISO("2026-07-30", -42), band_readings: 4 },
      { key: "rhr", last_reading_date: addDaysISO("2026-07-30", -42), band_readings: 4 },
      { key: "sleep", last_reading_date: null, band_readings: 0 },
    ],
  });
  assert.equal(sensorRecheckDecision(thin), null);
});

test("a dimension with a real range still speaks for the group when a sibling is thin", () => {
  const mixed = episodic(42, {
    history_readings: 11,
    dimensions: [
      { key: "hrv", last_reading_date: addDaysISO("2026-07-30", -42), band_readings: 12 },
      { key: "rhr", last_reading_date: addDaysISO("2026-07-30", -50), band_readings: 3 },
      { key: "sleep", last_reading_date: null, band_readings: 0 },
    ],
  });
  const r = sensorRecheckDecision(mixed);
  assert.ok(r);
  assert.deepEqual(r.dimensions, ["hrv"], "only the dimensions with a real range are claimed");
  assert.equal(r.last_reading_age_days, 42, "the NEWEST reading across the group sets the age");
});

test("a future-dated reading is a clock problem, not freshness — it is ignored", () => {
  const r = sensorRecheckDecision(
    episodic(42, {
      dimensions: [
        { key: "hrv", last_reading_date: addDaysISO("2026-07-30", 3), band_readings: 12 },
        { key: "rhr", last_reading_date: addDaysISO("2026-07-30", -42), band_readings: 12 },
        { key: "sleep", last_reading_date: addDaysISO("2026-07-30", -42), band_readings: 12 },
      ],
    })
  );
  assert.ok(r);
  assert.equal(r.last_reading_age_days, 42, "the tomorrow-dated row never counts as the newest reading");
  assert.deepEqual(r.dimensions, ["rhr", "sleep"]);
});

test("junk input degrades to silence, never to a suggestion", () => {
  assert.equal(
    sensorRecheckDecision({ today: "not-a-date", pattern: "spot_check", history_readings: 20, dimensions: [] }),
    null
  );
  assert.equal(
    sensorRecheckDecision({ today: "2026-07-30", pattern: "spot_check", history_readings: 20, dimensions: null }),
    null
  );
});

// ---- the words --------------------------------------------------------------

test("every athlete-facing string passes the reading grammar", () => {
  const pool = sensorRecheckGrammarPool();
  assert.ok(pool.length >= 12, "both tiers, titles and bodies, are enumerated");
  for (const text of pool) {
    assert.equal(violatesReadingGrammar(text), null, `violated grammar: ${JSON.stringify(text)}`);
  }
});

test("the register is an offer, never a scold or a count of missed nights", () => {
  for (const text of sensorRecheckGrammarPool()) {
    assert.doesNotMatch(text, /haven't|hasn't|failed|missed|should have|need to|make sure/i, text);
    assert.doesNotMatch(text, /\d/, `no number ever reaches the athlete: ${text}`);
  }
});

test("the sentence rotates across dates rather than repeating one literal", () => {
  const r = sensorRecheckDecision(episodic(42));
  const titles = new Set();
  const bodies = new Set();
  for (let i = 0; i < 6; i++) {
    const line = sensorRecheckLine(r, addDaysISO("2026-07-30", -i));
    titles.add(line.title);
    bodies.add(line.body);
  }
  assert.ok(titles.size >= 3, "at least three phrasings of the offer");
  assert.ok(bodies.size >= 3);
  // A fixed date always reads the same.
  assert.deepEqual(sensorRecheckLine(r, "2026-07-30"), sensorRecheckLine(r, "2026-07-30"));
});

test("the firm tier says something different from the soft one", () => {
  const soft = sensorRecheckLine(sensorRecheckDecision(episodic(42)), "2026-07-30");
  const firm = sensorRecheckLine(sensorRecheckDecision(episodic(90)), "2026-07-30");
  assert.notEqual(soft.title, firm.title);
  assert.equal(soft.kicker, firm.kicker, "the card label is stable; only the sentences move");
});

// ---- the DB-facing read ------------------------------------------------------

test("live: a spot-check wearer six weeks out reads as episodic, aged and banded", () => {
  seedEpisodicWearer();
  const state = sensorRecheckState();
  assert.equal(state.pattern, "spot_check");
  assert.equal(state.history_readings, EPISODIC_OFFSETS.length);
  assert.equal(state.dimensions.find((d) => d.key === "hrv").last_reading_date, localDaysAgo(42));
  assert.ok(state.dimensions.every((d) => d.band_readings >= 10));

  const r = sensorBaselineRecheck();
  assert.ok(r);
  assert.equal(r.last_reading_age_days, 42);
  assert.equal(r.tier, "soft");
});

test("live: a daily wearer with yesterday's reading never fires", () => {
  for (let i = 60; i >= 1; i--) {
    repo.recordDailyMetrics("apple", localDaysAgo(i), { hrv_ms: 50, resting_hr: 55, sleep_min: 440 });
  }
  assert.equal(sensorRecheckState().pattern, "continuous");
  assert.equal(sensorBaselineRecheck(), null);
  assert.equal(sensorRecheckCandidate(), null);
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null, "and nothing is filed");
});

test("live: an athlete who has never worn a sensor never fires", () => {
  assert.equal(sensorBaselineRecheck(), null);
  assert.equal(sensorRecheckCandidate(), null);
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null);
});

// ---- the quiet attention slot ------------------------------------------------
//
// `sensorRecheckCandidate` is now a PURE read — it never writes. Only
// `reconcileSensorRecheckAttention(asOf, surfaced)` spends the offer (or clears a
// resolved episode), and only once a caller has confirmed the card was actually
// SURFACED (never buried behind "more" — see today-agenda.ts). These tests
// exercise the underlying ladder mechanics directly by calling reconcile with
// `surfaced: true` right after producing the card, i.e. simulating "this pass was
// seen" — exactly what the salience arbiter does when the card lands inline.

test("the offer is made once — calm wording, and it does not repeat tomorrow", () => {
  seedEpisodicWearer();
  const card = sensorRecheckCandidate();
  assert.ok(card, "the offer is made");
  assert.equal(card.id, "sensor-recheck");
  assert.ok(card.dismissible);
  assert.ok(card.priority > 0 && card.priority < 20, "modest — it loses to anything actionable");
  assert.equal(violatesReadingGrammar(card.title), null);
  assert.equal(violatesReadingGrammar(card.body), null);
  assert.ok(sensorRecheckGrammarPool().includes(card.title), "nothing is said that the pool does not enumerate");
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null, "producing the candidate alone writes nothing");

  reconcileSensorRecheckAttention(localDaysAgo(0), true);
  const entry = repo.getAttentionSchedule(SIGNAL_KEY);
  assert.ok(entry, "surfacing files the cooldown on the shared attention schedule");
  assert.equal(entry.domain, "recovery");
  assert.equal(entry.tier, "active");
  assert.ok(entry.next_due > entry.last_checked, "and schedules the earliest it may be said again");

  // Same day, next day, next week: silence.
  assert.equal(sensorRecheckCandidate(), null);
  assert.equal(sensorRecheckCandidate(addDaysISO(localDaysAgo(0), 1)), null);
  assert.equal(sensorRecheckCandidate(addDaysISO(localDaysAgo(0), 7)), null);
});

// Walk the whole cooldown ladder, recording every offer actually made (and
// reconciled as surfaced) and the silence that followed it.
function walkLadder() {
  const said = [];
  const gaps = [];
  let asOf = localDaysAgo(0);
  for (let i = 0; i < 12; i++) {
    const card = sensorRecheckCandidate(asOf);
    if (card) said.push({ asOf, card });
    reconcileSensorRecheckAttention(asOf, !!card);
    const entry = repo.getAttentionSchedule(SIGNAL_KEY);
    if (!entry || entry.tier === "released" || !entry.next_due) break;
    gaps.push(Math.round((Date.parse(`${entry.next_due}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 864e5));
    asOf = entry.next_due;
  }
  return { said, gaps, asOf };
}

test("past the cooldown it may speak again — with different words, and a longer next silence", () => {
  seedEpisodicWearer();
  const { said, gaps } = walkLadder();
  assert.ok(said.length >= 3, "the offer is repeatable, far apart");
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY).tier, "released", "each repeat decays it toward silence");

  for (let i = 1; i < said.length; i++) {
    assert.notEqual(
      said[i].card.title,
      said[i - 1].card.title,
      `a re-shown offer repeated the previous literal on ${said[i].asOf}`
    );
    assert.notEqual(said[i].card.body, said[i - 1].card.body, `body repeated on ${said[i].asOf}`);
  }
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] > gaps[i - 1], `the silence must lengthen (${gaps.join(" -> ")})`);
  }
});

test("repeated far enough, it stops asking entirely", () => {
  seedEpisodicWearer();
  const { said, asOf } = walkLadder();
  assert.ok(said.length >= 2 && said.length <= 5, `a handful of offers, not a nag (said ${said.length} times)`);
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY).tier, "released");
  assert.equal(sensorRecheckCandidate(asOf), null, "released means silent, however long the lapse runs");
});

test("a new sleep/HRV reading clears the offer immediately and outright", () => {
  seedEpisodicWearer();
  assert.ok(sensorRecheckCandidate(), "it was offered");
  reconcileSensorRecheckAttention(localDaysAgo(0), true);
  assert.ok(repo.getAttentionSchedule(SIGNAL_KEY));

  repo.recordDailyMetrics("apple", localDaysAgo(0), { hrv_ms: 51, resting_hr: 55, sleep_min: 425 });

  assert.equal(sensorBaselineRecheck(), null, "the picture is current again");
  assert.equal(sensorRecheckCandidate(), null);
  // Cleanup on resolution isn't gated on `surfaced` — there's no card to have been
  // seen, so the stale row is cleared outright the next time a human pass reconciles.
  reconcileSensorRecheckAttention(localDaysAgo(0), false);
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null, "the episode is over — a later lapse starts fresh");
});

test("a read nobody is looking at computes the same answer and writes nothing", () => {
  seedEpisodicWearer();
  const quiet = sensorRecheckCandidate(localDaysAgo(0));
  assert.ok(quiet, "the same card");
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null, "producing the candidate alone spends nothing");
  // And it stays repeatable until a pass a human sees actually spends it.
  assert.deepEqual(sensorRecheckCandidate(localDaysAgo(0)), quiet);
  assert.ok(sensorRecheckCandidate());

  reconcileSensorRecheckAttention(localDaysAgo(0), true);
  assert.ok(repo.getAttentionSchedule(SIGNAL_KEY), "reconciling as surfaced is what actually spends the offer");
});

// ---- the surface -------------------------------------------------------------

test("it reaches the athlete through the Today rail, exactly once, as an ordinary quiet card", () => {
  seedEpisodicWearer();
  const agenda = repo.todayAgenda(localDaysAgo(0));
  const all = [...agenda.primary, ...agenda.more];
  const hits = all.filter((c) => c.id === "sensor-recheck");
  assert.equal(hits.length, 1, "exactly ONE recheck suggestion exists");
  assert.ok(hits[0].title);
  assert.equal(violatesReadingGrammar(hits[0].title), null);
  // And it does not come back tomorrow.
  const again = repo.todayAgenda(localDaysAgo(0));
  assert.equal([...again.primary, ...again.more].filter((c) => c.id === "sensor-recheck").length, 0);
});

test("an agent's agenda read never spends the offer", () => {
  seedEpisodicWearer();
  const agenda = repo.todayAgenda(localDaysAgo(0), { markIntroduced: false });
  assert.equal([...agenda.primary, ...agenda.more].filter((c) => c.id === "sensor-recheck").length, 1);
  assert.equal(repo.getAttentionSchedule(SIGNAL_KEY), null, "nothing was filed by a read no human saw");
});

// With TODAY_PRIMARY_MAX = 0, more is the only human-reachable surface. A
// sensor-recheck that lands there still spends — otherwise the ladder would
// never tick and the same offer would sit in more every day.
test("a card that lands in more still spends the attention ladder", () => {
  seedEpisodicWearer();
  repo.addFoodNote("meal", "", { kcal: 600, protein_g: 40 }, undefined, { date: localDaysAgo(0) }); // fuel (~32-40)
  repo.addInsight({ kind: "connection", text: "A genuine connection." }); // connection-insight (~38-44)

  const agenda = repo.todayAgenda(localDaysAgo(0));
  const recheck = [...agenda.primary, ...agenda.more].find((c) => c.id === "sensor-recheck");
  assert.ok(recheck, "the candidate is still produced");
  assert.equal(agenda.primary.length, 0, "primary stays empty");
  assert.ok(
    agenda.more.some((c) => c.id === "sensor-recheck"),
    "outranked by two higher-priority candidates, it lands behind the disclosure"
  );
  assert.ok(repo.getAttentionSchedule(SIGNAL_KEY), "more is the surface, so the offer spends");

  const tomorrow = addDaysISO(localDaysAgo(0), 1);
  const again = repo.todayAgenda(tomorrow);
  assert.ok(
    ![...again.primary, ...again.more].some((c) => c.id === "sensor-recheck"),
    "the freshly-spent cooldown holds on tomorrow's build"
  );
});

// The quiet-day twin: the lone candidate also spends from more, exactly once,
// and the cooldown holds on the next day's build.
test("a card that actually surfaces in more spends the ladder once, and the cooldown holds tomorrow", () => {
  seedEpisodicWearer(); // the lone candidate this quiet day — lands in more
  const first = repo.todayAgenda(localDaysAgo(0));
  assert.equal(first.primary.length, 0, "primary stays empty");
  assert.ok(
    first.more.some((c) => c.id === "sensor-recheck"),
    "with nothing else to outrank it, the lone candidate still waits in more"
  );
  const entry = repo.getAttentionSchedule(SIGNAL_KEY);
  assert.ok(entry, "surfacing it in more advances the shared attention ladder");
  assert.equal(entry.tier, "active");
  assert.ok(entry.next_due > entry.last_checked);

  const tomorrow = addDaysISO(localDaysAgo(0), 1);
  const again = repo.todayAgenda(tomorrow);
  assert.ok(
    ![...again.primary, ...again.more].some((c) => c.id === "sensor-recheck"),
    "the freshly-spent cooldown holds on tomorrow's build"
  );
});

// ---- the absence guarantee ---------------------------------------------------

test("this read can never move the day read or the next step", () => {
  seedEpisodicWearer();
  const date = localDaysAgo(0);

  // `computed_at` is a wall-clock stamp, not a decision — strip it (and its copy
  // on the decision block) so the comparison is over what the read actually SAYS.
  const stable = (read) => {
    if (!read) return read;
    const { computed_at, decision, ...rest } = read;
    return { ...rest, decision: decision ? { ...decision, computed_at: undefined } : decision };
  };

  const readBefore = stable(repo.dayRead(date));
  const stepBefore = repo.nextBestStep(date);
  assert.ok(readBefore, "the fixture produces a real day read");

  // Fire the whole loop: the card is produced and its cooldown is filed.
  const agenda = repo.todayAgenda(date);
  assert.equal([...agenda.primary, ...agenda.more].filter((c) => c.id === "sensor-recheck").length, 1);
  assert.ok(repo.getAttentionSchedule(SIGNAL_KEY), "state was written");

  assert.deepEqual(stable(repo.dayRead(date)), readBefore, "the day read is identical either way");
  assert.deepEqual(repo.nextBestStep(date), stepBefore, "and so is the next step");
});

test("nothing that decides posture or the next step imports this module", () => {
  // The strongest form of "its absence never degrades anything": the modules that
  // shape the day read and the next step cannot see it at all, so deleting this
  // file could not change what they say.
  for (const file of ["src/repo/day-read.ts", "src/dayread.ts", "src/repo/next-step.ts", "src/repo/signal-state.ts"]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    assert.doesNotMatch(fs.readFileSync(full, "utf8"), /sensor-recheck/, `${file} must not depend on the recheck read`);
  }
});
