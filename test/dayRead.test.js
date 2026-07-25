// dayRead (src/repo.ts) is the deterministic floor under the Brief. The
// constitution says it SUGGESTS, never gates — these cases pin the three reads
// and the two protect-recovery triggers (earned rest, clearly-low recovery).
// dayRead(date, recovery) takes an explicit recovery object, letting us drive the
// low-sleep branch without coupling to wall-clock "now".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedTrainingDay, seedRecoveryDay, isoDaysAgo, localDaysAgo } from "./_seed.js";
import {
  DAY_READ_OUTCOMES,
  DAY_READ_POLICY_REASON_VARIANTS,
  DAY_READ_REQUIRED_CONCEPT,
  DAY_READ_WHY_VARIANTS,
  QUIET_STREAK_GUARDED_WHY,
  QUIET_STREAK_WHY,
  RECOVERY_WEEK_SOFTEN_WHY,
  quietOrdinal,
} from "../dist/repo/day-read.js";
import { UNPROGRAMMED_EASY_DAY, pickDayVariant } from "../dist/repo/brain/day-read-rules.js";
import { SIGNAL_VOICE_REGISTRY, signalVoice } from "../dist/repo/signal-state.js";

// A reference date well clear of the recovery window so an empty recovery fetch
// can't accidentally flip the read.
const REF = "2026-03-15";
const dayBefore = (base, n) => new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

// Every rule now speaks in SEVERAL calm phrasings of the same judgement, rotated by
// calendar day (a stable input used to print one literal forever). So a case pins the
// rule's whole vocabulary, not the sentence that happened to land on this date.
const saysOneOf = (text, code) =>
  assert.ok((DAY_READ_WHY_VARIANTS[code] ?? []).includes(text), `${code}: unexpected wording ${JSON.stringify(text)}`);

// The movement work-around names the injury in the athlete's own register and rotates
// by calendar day like every other sentence (it used to splice the machine-facing
// evidence summary behind one fixed lead-in), so a case pins the whole set. Returns the
// phrasing that landed, so a caller can assert about what follows it.
const injurySentence = (text, title) => {
  const landed = signalVoice({ key: "active_injury", subject: title.toLowerCase() }).find((variant) =>
    text.includes(variant)
  );
  assert.ok(landed, `expected the injury work-around, got ${JSON.stringify(text)}`);
  return landed;
};

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "session_skips",
    "plan_items",
    "plan_days",
    "checkins",
    "daily_metrics",
    "activities",
    "context_events"
  );
});

test("REST on >=3 consecutive training days ending the day before", () => {
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  saysOneOf(r.why, "accumulated_load_rest");
});

test("does NOT force rest on only 2 consecutive training days", () => {
  for (let i = 1; i <= 2; i++) seedTrainingDay(dayBefore(REF, i));
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 2);
});

test("an active dated obligation compresses a train day without changing its posture", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "family_event",
    title: "School pickup and evening event",
    start_date: REF,
    end_date: REF,
  });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.est_minutes, 40);
  assert.equal(r.signals.signal_state.action.posture, "train");
  assert.equal(r.signals.signal_state.action.directives.schedule, "compress");
  assert.deepEqual(r.signals.schedule, {
    directive: "compress",
    compressed: true,
    original_est_minutes: 60,
    est_minutes: 40,
    reason: "School pickup and evening event adds schedule pressure today.",
  });
  assert.match(r.why, /dated commitment compresses today's training window/i);
});

test("poor recovery owns an injury-overlap day while the movement work-around survives", () => {
  repo.savePlanDay(1, "Upper", "Upper body", [{ exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "injury",
    title: "Shoulder strain",
    detail: "Overhead loading aggravates it",
    start_date: REF,
  });

  const r = repo.dayRead(REF, {
    has_data: true,
    recovery: { training_readiness: 20, avg_training_readiness: 50 },
    quality: {
      training_readiness: { latest_date: REF, source: "garmin", freshness: "fresh", sample_count: 1 },
    },
  });
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.signal_state.action.posture, "easy");
  assert.equal(r.signals.signal_state.action.directives.training, "recover");
  assert.equal(r.signals.health_workaround.field, "active_injury");
  injurySentence(r.why, "Shoulder strain");
  assert.match(r.why, /shoulder/i);
  // The evidence summary is machine-facing and stays that way: what the athlete reads
  // is never the observer's note written about them.
  assert.doesNotMatch(r.why, /\bthe athlete\b/i);
});

test("a short rolling sleep average is a chronic EASY watch when nothing is programmed", () => {
  // A 14-day pattern matters, but it is not fresh evidence about this morning.
  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 300 } }); // 5h
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.low_sleep, true);
  assert.equal(r.decision.rule_code, "chronic_sleep_watch");
  saysOneOf(r.why, "chronic_sleep_watch");
});

test("a chronically short sleeper is still OFFERED a due plan day, with the sleep as a caveat", () => {
  // The watch used to sit ABOVE the plan-day rule, so anyone whose rolling average
  // ran under six hours was never offered their session at all — permanent rest
  // traded for permanent easy. It is a caveat on the train read now, like a volume
  // spike: the concern is voiced, the athlete still gets their day.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 300 } }); // 5h

  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
  assert.equal(r.signals.low_sleep, true);
  assert.equal(r.decision.rule_code, "planned_training");
  assert.match(r.why, /sleep's been running short lately/i);
  assert.match(r.why, /stop a rep or two shy/i);
});

test("a fresh short night corroborating the short rolling average can suggest REST", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 300)`).run(dayBefore(REF, 1));

  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 330 } });

  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "acute_sleep_corroborated");
  assert.equal(
    r.decision.evidence.some((item) => item.date === dayBefore(REF, 1)),
    true
  );
  saysOneOf(r.why, "acute_sleep_corroborated");
});

test("a corroborated short night on an injury day still names the work-around", () => {
  // The gap that let the defect through: every injury case drove LOW READINESS, so the
  // protect rule always won and the movement work-around always got spoken. A short
  // night preempts that rule — and health constraints are exactly what drive the protect
  // posture, so the two co-occur constantly. The injury must survive the rule that wins.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "injury",
    title: "Achilles tendinopathy",
    detail: "Running and jumping aggravate it",
    start_date: REF,
  });
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 300)`).run(dayBefore(REF, 1));

  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 330 } });

  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "acute_sleep_corroborated");
  // The sleep rule still leads with its own words...
  assert.ok(
    DAY_READ_WHY_VARIANTS.acute_sleep_corroborated.some((v) => r.why.startsWith(v)),
    `the sleep read should still lead, got ${JSON.stringify(r.why)}`
  );
  // ...and the injury is still named, in both registers.
  assert.equal(r.signals.health_workaround.field, "active_injury");
  injurySentence(r.why, "Achilles tendinopathy");
  assert.match(r.why, /achilles/i);
  // Whatever the continuity voice appends next lands after this, so the spliced
  // sentence has to close.
  assert.match(r.why, /[.!?]$/, "the read still closes as a sentence");
  // The machine-facing summary keeps the classifier line ("Achilles tendinopathy: an
  // active injury is worth easing or working around") for provenance; the athlete
  // hears the name once, in one voice.
  assert.match(r.signals.health_workaround.reason, /an active injury is worth easing/i);
  assert.doesNotMatch(r.why, /an active injury is worth easing/i);
});

test("low subjective check-in (low energy) forces REST", () => {
  // checkin is read by date inside dayRead (getCheckinByDate(d)); seed it on REF.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  repo.addCheckin(REF, { energy: 1, sleep_feel: 2, mood: 2, soreness: 4 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  // A low-energy check-in is a safety override, so the unified protect posture — not
  // the felt_run_down_rest rule — owns this read. Both speak the SAME words, because
  // one trigger reading in two voices depending on which rule won is the defect.
  assert.equal(r.decision.rule_code, "acute_signal_protection");
  saysOneOf(r.why, "acute_signal_protection:felt_energy_low");
  assert.deepEqual(
    [...DAY_READ_WHY_VARIANTS.felt_run_down_rest],
    [...DAY_READ_WHY_VARIANTS["acute_signal_protection:felt_energy_low"]]
  );
});

test("TRAIN when recovered, due, and a plan day exists", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
  assert.equal(typeof r.est_minutes, "number");
});

test("EASY when nothing is programmed and recovery is unremarkable", () => {
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "unprogrammed_easy_day");
  saysOneOf(r.why, "unprogrammed_easy_day");
});

test("EASY after a LIGHT activity is already logged today", () => {
  // A short easy outing (a 25-min stroll — below the hard-cardio bar) reads as
  // 'covered', not a fresh session, but stays easy: it isn't real loading work.
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(REF);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.match(r.why, /already/i);
});

// ── PART 2: a genuinely HARD cardio day counts REGARDLESS of discipline ──────────
test("a HARD cardio day (40+ min run) reads DONE for a strength-primary athlete", () => {
  // A strength-primary lifter's genuinely hard run is real work: it reads DONE (a
  // solid run in, recover the rest of the day), not a fresh session and not merely
  // "keep it easy". Cardio is no longer invisible just because the discipline is strength.
  repo.setProfile({ primary_discipline: "strength" });
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 48, 9)`).run(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.equal(r.signals.trained_today, true);
  assert.equal(
    r.signals.today_load !== "none" && r.signals.today_load !== "easy",
    true,
    "hard cardio grades as loading"
  );
});

test("hard cardio stacks toward earned rest REGARDLESS of discipline", () => {
  // Three straight 45-min runs make a strength-primary athlete's Brief suggest rest,
  // exactly as three straight lifting days would — the streak counts hard cardio.
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 45, 8)`).run(
      dayBefore(REF, i)
    );
  }
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 3);
});

test("an easy stroll never counts toward the loading streak (negative case)", () => {
  // Short 25-min walks are below every hard-cardio bar, so they break (never build)
  // the loading streak — no forced rest off strolls, no false 'done'.
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(dayBefore(REF, i));
  }
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 0);
});

test("a ~43-min easy hike today does NOT flip a planned-lift day to DONE", () => {
  // Fix round: an easy hike (no wearable data) must not grade as loading — it reads as
  // "covered but easy", never DONE/recover, so it never suppresses the planned session.
  repo.setProfile({ primary_discipline: "strength" });
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'hike', 43, 4)`).run(REF);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "done");
  assert.notEqual(r.kind, "rest");
});

test("prior ~43-min easy hikes do NOT stack toward earned rest (planned lift still suggested)", () => {
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'hike', 43, 4)`).run(
      dayBefore(REF, i)
    );
  }
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 0, "easy hikes never stack loading days");
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
});

test("DONE (not EASY) when a real loading session is already logged today", () => {
  // A hard session today is a FACT — the read must acknowledge it as DONE, never
  // mislabel it "easy". (This is the bug: a hard push session read "EASY DAY".)
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /recovery/i);
  assert.equal(r.signals.trained_today, true);
});

test("DONE preempts REST: a hard session today wins over 3 prior hard days", () => {
  // The user's exact case — trained hard for days AND already trained again today. A
  // "Rest today" read would contradict the work already in (and the session sitting
  // below it). The day must read DONE (debrief), never tell them to rest after they've
  // already loaded. This is the done-before-earned-rest ordering.
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.kind, "done");
  assert.equal(r.signals.trained_today, true);
});

test("DONE 'why' names the session (not the run) when both land today", () => {
  // A lift + a run on the same day must not let the run's label erase the strength work
  // in the deterministic floor's why-line.
  seedTrainingDay(REF);
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 40, 6)`).run(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /\bsession\b/i);
  assert.doesNotMatch(r.why, /\brun\b/i);
});

test("stale sleep is NOT treated as last night (no fabricated sleep read)", () => {
  // A wearable can stop syncing sleep for weeks; a ~month-old night is NOT last night.
  // dayRead must surface it as ABSENT so the Brief never asserts "you slept fine".
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 25));
  const stale = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(stale.signals.last_night, null);
  // A recent night (yesterday) IS surfaced as last night.
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 1));
  const fresh = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.ok(fresh.signals.last_night && fresh.signals.last_night.total_min === 440);
});

test("EASY (not DONE) when today's logged work was only light", () => {
  // A short mobility/recovery session graded 'easy' is NOT a completed training
  // day — keep it 'easy' (they may still want their real work), never 'done'.
  seedRecoveryDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
});

test("forwardLook points to the NEXT session's focus (the day-ahead heads-up)", () => {
  repo.savePlanDay(1, "Push", "Chest & shoulders", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  repo.savePlanDay(2, "Lower", "Lower body", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 225 },
  ]);
  // Trained Push (plan day 1) the day before REF → the forward look is plan day 2.
  const ex = repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  const day1Id = repo.getPlanDay(1).id; // the real plan_days row id (autoincrement varies in the shared DB)
  const sess = repo.getOrCreateSession(dayBefore(REF, 1), day1Id);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 135, 6, 2)`
  ).run(sess.id, ex.id);
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, "Lower body");
  assert.match(fl.text, /Lower body/);
});

test("forwardLook is null-safe with no plan (degrades, never throws)", () => {
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, null);
  assert.equal(fl.text, null);
});

test("absent signals never throw and never force rest (graceful degradation)", () => {
  // No recovery, no check-in, no sessions, no plan — must return a calm 'easy'.
  const r = repo.dayRead(isoDaysAgo(0));
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.consecutive_training_days, 0);
});

test("enforceCompletionContract clamps completion facts in BOTH directions", async () => {
  const { enforceCompletionContract } = await import("../dist/dayread.js");

  // Agent claims "done" on a day the server says is not done → deterministic floor.
  const trainBaseline = { kind: "train", focus: "Lower body", why: "Recovered and due.", est_minutes: 60, signals: {} };
  const falseDone = enforceCompletionContract(
    {
      kind: "done",
      headline: "You're done.",
      why: "Great work!",
      focus: null,
      est_minutes: null,
      source: "agent",
      agent: "claude",
    },
    trainBaseline
  );
  assert.equal(falseDone.kind, "train", "an agent can never mark an untrained day done");
  assert.equal(falseDone.source, "deterministic");
  assert.equal(falseDone.agent, "claude", "provenance survives the clamp");

  // Agent downgrades a genuinely-done day → forced back to done, prospective residue stripped.
  const doneBaseline = { kind: "done", focus: null, why: "Solid run in.", est_minutes: null, signals: {} };
  const downgraded = enforceCompletionContract(
    { kind: "easy", headline: "Take it easy.", why: "Light day.", focus: "Easy", est_minutes: 30, source: "agent" },
    doneBaseline
  );
  assert.equal(downgraded.kind, "done");
  assert.equal(downgraded.focus, null);
  assert.equal(downgraded.est_minutes, null);

  // Agent voices done correctly → its warm prose survives, residue still nulled.
  const voiced = enforceCompletionContract(
    {
      kind: "done",
      headline: "Strong push session.",
      why: "The work is in — refuel well.",
      focus: "Push",
      est_minutes: 60,
      source: "agent",
    },
    doneBaseline
  );
  assert.equal(voiced.kind, "done");
  assert.equal(voiced.headline, "Strong push session.");
  assert.equal(voiced.focus, null);
  assert.equal(voiced.est_minutes, null);
});

test("agentic day-read posture cannot become more aggressive without an athlete override", async () => {
  const { enforceDayReadSafetyPosture, enforceCompletionContract } = await import("../dist/dayread.js");
  const restBaseline = {
    kind: "rest",
    focus: null,
    why: "Recovery signals say rest is the smart call.",
    est_minutes: null,
    signals: { low_sleep: true },
  };
  const aggressive = {
    kind: "train",
    headline: "Push hard today.",
    why: "The plan says legs.",
    focus: "Lower body",
    est_minutes: 60,
    signals: restBaseline.signals,
    source: "agent",
    agent: "claude",
    tried: ["claude"],
  };
  const clamped = enforceDayReadSafetyPosture(aggressive, restBaseline, false);
  assert.equal(clamped.kind, "rest");
  assert.equal(clamped.headline, "Rest today.");
  assert.equal(clamped.why, restBaseline.why, "clamped prose must match the deterministic posture");
  assert.equal(clamped.focus, null);
  assert.equal(clamped.est_minutes, null);
  assert.equal(clamped.source, "deterministic");
  assert.equal(clamped.agent, "claude", "agent provenance survives the policy clamp");

  const easyBaseline = {
    kind: "easy",
    focus: "Easy movement",
    why: "Nothing programmed today.",
    est_minutes: 30,
    signals: {},
  };
  assert.equal(enforceDayReadSafetyPosture(aggressive, easyBaseline, false).kind, "easy");

  const conservative = { ...aggressive, kind: "rest", headline: "Rest today.", why: "Take the recovery." };
  assert.equal(
    enforceDayReadSafetyPosture(conservative, { ...easyBaseline, kind: "train" }, false),
    conservative,
    "the agent may always become more conservative"
  );

  assert.equal(
    enforceDayReadSafetyPosture(aggressive, restBaseline, true),
    aggressive,
    "an explicit athlete override preserves the bounded agent recommendation"
  );
  const falseDone = { ...aggressive, kind: "done", headline: "All done." };
  const overrideStillNotDone = enforceCompletionContract(
    enforceDayReadSafetyPosture(falseDone, restBaseline, true),
    restBaseline
  );
  assert.equal(overrideStillNotDone.kind, "rest", "completion remains non-negotiable under an override");
});

test("recovery-week prose policy prevents repeated non-loading days but preserves athlete control", async () => {
  const { enforceRecoveryWeekCadence } = await import("../dist/dayread.js");
  const recoveryWeek = { state: "applied", applied_on: "2026-03-12", until: "2026-03-19" };
  const baseline = {
    kind: "train",
    headline: "Reduced lower body.",
    focus: "Lower body",
    why: "Use the reduced prescription and keep every set crisp.",
    est_minutes: 45,
    signals: {
      recovery_week: recoveryWeek,
      recent_load: [{ date: "2026-03-14", load: "easy" }],
    },
    input_fingerprint: "stable",
  };
  const agentEasy = {
    kind: "easy",
    headline: "Take it easy.",
    focus: null,
    why: "Broad context says keep resting.",
    est_minutes: 20,
    source: "agent",
    agent: "stub",
  };
  const agentRest = { ...agentEasy, kind: "rest", headline: "Rest today.", est_minutes: null };

  for (const agentRead of [agentEasy, agentRest]) {
    const clamped = enforceRecoveryWeekCadence(agentRead, baseline, false);
    assert.equal(clamped.kind, "train", "a non-loading prior day returns to the reduced training dose");
    assert.equal(clamped.focus, "Lower body");
    assert.equal(clamped.decision.basis, "server_policy");
    assert.equal(clamped.decision.rule_code, "recovery_week_reduced_train_after_non_loading_day");
  }

  for (const recent_load of [[], [{ date: "2026-03-14", load: "none" }]]) {
    const noLoadBaseline = {
      ...baseline,
      signals: { ...baseline.signals, recent_load },
    };
    const clamped = enforceRecoveryWeekCadence(agentEasy, noLoadBaseline, false);
    assert.equal(clamped.kind, "train", "empty/none history is an explicit non-loading prior day");
    assert.equal(clamped.decision.rule_code, "recovery_week_reduced_train_after_non_loading_day");
  }

  const afterLoading = {
    ...baseline,
    signals: {
      ...baseline.signals,
      recent_load: [{ date: "2026-03-14", load: "moderate" }],
    },
  };
  const softened = enforceRecoveryWeekCadence(agentRest, afterLoading, false);
  assert.equal(softened.kind, "easy", "rest may soften only as far as easy immediately after real load");
  assert.equal(softened.decision.rule_code, "recovery_week_rest_softened_to_easy_after_loading_day");
  assert.equal(
    enforceRecoveryWeekCadence(agentEasy, afterLoading, false),
    agentEasy,
    "an agent easy day remains allowed immediately after a moderate day"
  );

  const acuteBaseline = {
    ...baseline,
    kind: "rest",
    focus: null,
    why: "A fresh acute signal calls for rest.",
    est_minutes: null,
  };
  assert.equal(
    enforceRecoveryWeekCadence(acuteBaseline, acuteBaseline, false),
    acuteBaseline,
    "the cadence policy never rewrites an acute deterministic rest baseline"
  );

  assert.equal(
    enforceRecoveryWeekCadence(agentRest, baseline, true),
    agentRest,
    "an explicit athlete override bypasses the recovery-week cadence clamp"
  );

  assert.ok(
    RECOVERY_WEEK_SOFTEN_WHY.includes(softened.why),
    `unexpected wording for the softened rest→easy day: ${JSON.stringify(softened.why)}`
  );
});

// The rest→easy softening clamp fires every day an applied recovery week follows a
// real loading day — exactly the path most likely to repeat verbatim for up to seven
// days straight (the original "rest after rest after rest" complaint this whole round
// exists to fix), so it rotates through pickDayVariant just like every other rule.
test("recovery-week rest→easy softening rotates day to day and stays stable per day", async () => {
  const { enforceRecoveryWeekCadence } = await import("../dist/dayread.js");
  const baselineFor = (date) => ({
    kind: "train",
    headline: "Reduced lower body.",
    focus: "Lower body",
    why: "Use the reduced prescription and keep every set crisp.",
    est_minutes: 45,
    signals: {
      recovery_week: { state: "applied", applied_on: dayBefore(date, 3), until: dayBefore(date, -4) },
      recent_load: [{ date: dayBefore(date, 1), load: "moderate" }],
    },
    input_fingerprint: "stable",
  });
  const agentRest = {
    kind: "rest",
    headline: "Rest today.",
    focus: null,
    why: "Broad context says keep resting.",
    est_minutes: null,
    source: "agent",
    agent: "stub",
  };

  const REASON_CODE = "recovery_week_rest_softened_to_easy_after_loading_day";
  const reasonVariants = DAY_READ_POLICY_REASON_VARIANTS[REASON_CODE];

  // Same day + same inputs ⇒ the same wording, every time — in BOTH registers (the
  // athlete-facing `why` and the ledger `decision.reason`, which rotates through the
  // same mechanism keyed on the same rule_code).
  const first = enforceRecoveryWeekCadence(agentRest, baselineFor(REF), false, REF);
  const again = enforceRecoveryWeekCadence(agentRest, baselineFor(REF), false, REF);
  assert.equal(again.why, first.why, "the same calendar day must not re-roll its wording");
  assert.equal(again.decision.reason, first.decision.reason, "the ledger reason must not re-roll either");
  // The two registers say something DIFFERENT on the same card, not the same idea
  // reworded — `why` narrates the day, `reason` explains the override.
  assert.notEqual(first.why, first.decision.reason, "why and reason must not restate each other");

  // Consecutive days always differ, and every day's wording stays within the set.
  const seen = [];
  for (let back = 6; back >= 0; back--) {
    const date = dayBefore(REF, back);
    const result = enforceRecoveryWeekCadence(agentRest, baselineFor(date), false, date);
    assert.ok(
      RECOVERY_WEEK_SOFTEN_WHY.includes(result.why),
      `${date}: unexpected wording ${JSON.stringify(result.why)}`
    );
    assert.ok(
      reasonVariants.includes(result.decision.reason),
      `${date}: unexpected reason ${JSON.stringify(result.decision.reason)}`
    );
    seen.push({ date, why: result.why, reason: result.decision.reason });
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i].why, seen[i - 1].why, `${seen[i].date} repeated ${seen[i - 1].date} verbatim`);
    assert.notEqual(
      seen[i].reason,
      seen[i - 1].reason,
      `${seen[i].date} repeated ${seen[i - 1].date}'s reason verbatim`
    );
  }
  assert.ok(new Set(seen.map((s) => s.why)).size >= 3, "seven days must not cycle through only one or two sentences");
  assert.ok(new Set(seen.map((s) => s.reason)).size >= 3, "the ledger reason must vary the same way");
});

// The other four server-policy clamps in dayread.ts also populate decision.reason
// unconditionally (it's rendered on the Brief whenever non-empty), and each can fire
// on consecutive days the same way the recovery-week softening clamp can — so each
// rotates through pickDayVariant too, keyed on its own rule_code.
test("every other server-policy reason rotates day to day and stays within its own set", async () => {
  const { enforceCompletionContract, enforceDayReadSafetyPosture, enforceRecoveryWeekCadence } = await import(
    "../dist/dayread.js"
  );
  const scenarios = [
    {
      code: "completion_fact_not_logged",
      run: (date) =>
        enforceCompletionContract(
          { kind: "done", headline: "All done.", why: "Nice work.", agent: "stub", tried: ["stub"] },
          { kind: "easy", headline: "Take it easy.", why: "Nothing logged yet.", signals: {} },
          date
        ),
    },
    {
      code: "completion_fact_preserved",
      run: (date) =>
        enforceCompletionContract(
          { kind: "easy", headline: "Take it easy.", why: "Broad context.", agent: "stub", tried: ["stub"] },
          { kind: "done", headline: "You're done for today.", why: "That session is in the books.", signals: {} },
          date
        ),
    },
    {
      code: "deterministic_safety_floor",
      run: (date) =>
        enforceDayReadSafetyPosture(
          { kind: "train", headline: "Good to train.", why: "Go get it.", agent: "stub", tried: ["stub"] },
          { kind: "rest", headline: "Rest today.", why: "Several loading days back to back.", signals: {} },
          false,
          date
        ),
    },
    {
      code: "recovery_week_reduced_train_after_non_loading_day",
      run: (date) =>
        enforceRecoveryWeekCadence(
          { kind: "easy", headline: "Take it easy.", why: "Broad context.", agent: "stub", tried: ["stub"] },
          {
            kind: "train",
            headline: "Reduced lower body.",
            focus: "Lower body",
            why: "Use the reduced prescription.",
            est_minutes: 45,
            signals: {
              recovery_week: { state: "applied", applied_on: dayBefore(date, 3), until: dayBefore(date, -4) },
              recent_load: [{ date: dayBefore(date, 1), load: "easy" }],
            },
          },
          false,
          date
        ),
    },
  ];

  for (const { code, run } of scenarios) {
    const variants = DAY_READ_POLICY_REASON_VARIANTS[code];
    assert.ok(Array.isArray(variants) && variants.length >= 3, `${code} needs several phrasings`);

    const first = run(REF);
    assert.equal(first.decision.rule_code, code, `${code}: scenario fixture fired the wrong clamp`);
    const again = run(REF);
    assert.equal(again.decision.reason, first.decision.reason, `${code}: same day must not re-roll`);

    const seen = [];
    for (let back = 6; back >= 0; back--) {
      const date = dayBefore(REF, back);
      const result = run(date);
      assert.ok(
        variants.includes(result.decision.reason),
        `${code} ${date}: unexpected reason ${JSON.stringify(result.decision.reason)}`
      );
      seen.push({ date, reason: result.decision.reason });
    }
    for (let i = 1; i < seen.length; i++) {
      assert.notEqual(seen[i].reason, seen[i - 1].reason, `${code}: ${seen[i].date} repeated ${seen[i - 1].date}`);
    }
    assert.ok(new Set(seen.map((s) => s.reason)).size >= 3, `${code}: seven days must not cycle through one or two`);
  }
});

// The same plain-language contract as every athlete-facing `why` (VISION.md
// Amendment 2), applied to the server-policy `reason` vocabulary — the Brief renders
// decision.reason whenever it's non-empty, so it holds the same line.
test("every server-policy reason reads as calm plain language", () => {
  for (const [code, variants] of Object.entries(DAY_READ_POLICY_REASON_VARIANTS)) {
    assert.equal(new Set(variants).size, variants.length, `${code} has a duplicate phrasing`);
    for (const sentence of variants) {
      const label = `${code}: ${JSON.stringify(sentence)}`;
      assert.ok(sentence.length > 10, `${label} needs a real sentence`);
      assert.match(sentence, /[.!?]$/, `${label} should read as a finished sentence`);
      assert.doesNotMatch(
        sentence,
        /_|deterministic|posture|baseline|policy|fingerprint|directive|override|boundary/i,
        `${label} reads as engineering prose`
      );
      assert.doesNotMatch(sentence, /\bacute warning\b|\breadiness signal\b/i, `${label} leaks device/clinical jargon`);
      assert.doesNotMatch(sentence, /\b\d{1,3}\s*(?:\/\s*100|%|points?|score)\b/i, `${label} leaks a score`);
      assert.doesNotMatch(sentence, /\byou must\b|\bdo not train\b|\bforbidden\b/i, `${label} reads as a gate`);
    }
  }
});

// The same plain-language contract every other why-variant set holds to (VISION.md
// Amendment 2), applied directly since this set lives outside DAY_READ_WHY_VARIANTS
// (it's a server-policy clamp in dayread.ts, not one of dayRead()'s own rules).
test("the recovery-week softening variants read as calm plain language, distinct in shape", () => {
  assert.ok(RECOVERY_WEEK_SOFTEN_WHY.length >= 3, "needs several genuinely different phrasings");
  assert.equal(new Set(RECOVERY_WEEK_SOFTEN_WHY).size, RECOVERY_WEEK_SOFTEN_WHY.length, "no duplicate phrasing");
  for (const sentence of RECOVERY_WEEK_SOFTEN_WHY) {
    assert.ok(sentence.length > 10, `needs a real sentence, got ${JSON.stringify(sentence)}`);
    assert.match(sentence, /[.!?]$/, "should read as a finished sentence");
    assert.doesNotMatch(
      sentence,
      /_|deterministic|posture|baseline|policy|fingerprint|directive|override|boundary/i,
      "reads as engineering prose"
    );
    assert.doesNotMatch(sentence, /\bacute warning\b|\breadiness signal\b/i, "leaks device/clinical jargon");
    assert.doesNotMatch(sentence, /\b\d{1,3}\s*(?:\/\s*100|%|points?|score)\b/i, "leaks a score");
    assert.doesNotMatch(sentence, /\byou must\b|\bdo not train\b|\bforbidden\b/i, "reads as a gate");
  }
});

test("Today agent-result validation rejects parseable off-contract JSON", async () => {
  const { isValidDayReadAgentResult } = await import("../dist/dayread.js");

  assert.equal(isValidDayReadAgentResult({ kind: "rest", why: "Three loading days in a row." }), true);
  assert.equal(isValidDayReadAgentResult({ summary: "Rest today" }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "rest", why: "" }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "pause", why: "Take it easy." }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "easy", why: "Keep it light.", est_minutes: "soon" }), false);
  assert.equal(
    isValidDayReadAgentResult({ kind: "done", why: "Your walk is in." }, { kind: "rest" }),
    false,
    "an easy activity cannot be promoted to completed training by the prose layer"
  );
  assert.equal(
    isValidDayReadAgentResult({ kind: "rest", why: "Recover." }, { kind: "done" }),
    false,
    "a completed training fact cannot be downgraded by the prose layer"
  );
  assert.equal(isValidDayReadAgentResult({ kind: "done", why: "Session logged." }, { kind: "done" }), true);
});

test("completed-load prose consistency rejects understatement but permits future easy advice", async () => {
  const { dayReadProseConsistencyIssue, isValidDayReadAgentResult } = await import("../dist/dayread.js");
  const baseline = {
    kind: "done",
    signals: { trained_today: true, today_load: "moderate" },
  };
  const contradiction = {
    kind: "done",
    headline: "Run complete.",
    why: "That run keeps your easy rhythm ticking along.",
  };
  const futureEasy = {
    kind: "done",
    headline: "Tempo work complete.",
    why: "That run was a solid moderate effort. Keep tomorrow's run easy so it can settle.",
  };

  assert.deepEqual(dayReadProseConsistencyIssue(contradiction, baseline.signals), {
    code: "completed_load_understated",
    classified_load: "moderate",
    evidence: contradiction.why,
  });
  assert.equal(isValidDayReadAgentResult(contradiction, baseline), false);
  assert.equal(dayReadProseConsistencyIssue(futureEasy, baseline.signals), null);
  assert.equal(isValidDayReadAgentResult(futureEasy, baseline), true);
});

// ---------- decision reasons: no parallel map, therefore no drift ----------
// The reason used to live in a `DECISION_REASONS` map in day-read.ts, keyed by
// the rule name with a `?? "Cairn's deterministic day policy selected this
// posture."` fallback — so the endurance volume-spike rule (added later, never
// added to the map) shipped engineering prose to the athlete. The reason now
// rides on the outcome the rule returns; these cases pin that contract.
// Every sentence the deterministic floor can say to the athlete, in both registers:
// the ledger `reason` on the outcome, and the read's own `why`. The wave-1 guarantee
// was "a rule cannot reach the athlete without words"; with several phrasings per
// rule it becomes "and every one of them holds the line".
function everyAthleteFacingSentence() {
  const rows = [];
  const outcomes = [...Object.entries(DAY_READ_OUTCOMES), ["unprogrammed_easy_day", UNPROGRAMMED_EASY_DAY]];
  for (const [key, outcome] of outcomes) {
    for (const reason of outcome.reasons) rows.push({ code: outcome.code, key, register: "reason", text: reason });
  }
  for (const [code, variants] of Object.entries(DAY_READ_WHY_VARIANTS)) {
    for (const why of variants) rows.push({ code, key: code, register: "why", text: why });
  }
  return rows;
}

test("every day-read outcome carries its own plain-language reasons", () => {
  const outcomes = [...Object.entries(DAY_READ_OUTCOMES), ["unprogrammed_easy_day", UNPROGRAMMED_EASY_DAY]];
  const codes = new Set();
  for (const [key, outcome] of outcomes) {
    assert.equal(outcome.code, key, `${key}: the table key IS the ledger code`);
    assert.equal(codes.has(outcome.code), false, `${key}: duplicate ledger code`);
    codes.add(outcome.code);
    // A stable input fires a stable rule, so one literal per rule printed the same
    // sentence to the athlete indefinitely. Each outcome now owns SEVERAL calm
    // phrasings of the same judgement. (The non-empty tuple type gets "at least one"
    // at compile time; this is the rest of the contract.)
    assert.ok(Array.isArray(outcome.reasons) && outcome.reasons.length >= 3, `${key} needs several phrasings`);
    assert.equal(new Set(outcome.reasons).size, outcome.reasons.length, `${key} has a duplicate phrasing`);
  }
  assert.equal(codes.size, outcomes.length);
});

test("every phrasing of every rule reads as calm plain language, in both registers", () => {
  const sentences = everyAthleteFacingSentence();
  assert.ok(sentences.length >= 60, "the whole vocabulary is under test");
  for (const { key, register, text } of sentences) {
    const label = `${key} (${register})`;
    const sentence = String(text || "").trim();
    assert.ok(sentence.length > 10, `${label} needs a real sentence, got ${JSON.stringify(sentence)}`);
    assert.match(sentence, /[.!?]$/, `${label} should read as a finished sentence`);
    // VISION.md Amendment 2: plain language, never internals leaking as coaching.
    assert.doesNotMatch(
      sentence,
      /_|deterministic|posture|baseline|policy|fingerprint|directive|override|boundary/i,
      `${label} reads as engineering prose`
    );
    // Clinical/device vocabulary that actually leaked once (CHRONIC_SLEEP_WHY[0]'s
    // "acute warning", LOW_READINESS_WHY[0]'s "readiness signal") — phrase-level so
    // a legitimate colloquial "nothing acute" elsewhere in the same rule's own
    // variants isn't caught by a blanket ban on the bare word.
    assert.doesNotMatch(sentence, /\bacute warning\b|\breadiness signal\b/i, `${label} leaks device/clinical jargon`);
    // No scores, no grades, no metric wall.
    assert.doesNotMatch(sentence, /\b\d{1,3}\s*(?:\/\s*100|%|points?|score)\b/i, `${label} leaks a score`);
    // A suggestion, never a gate.
    assert.doesNotMatch(sentence, /\byou must\b|\bdo not train\b|\bforbidden\b/i, `${label} reads as a gate`);
  }
});

test("every phrasing carries the meaning its rule exists to convey", () => {
  // The drift guard. A single-literal case pinned semantics by accident; with several
  // variants the requirement has to be explicit, and it lives in the source next to
  // the prose (DAY_READ_REQUIRED_CONCEPT) so a new phrasing cannot quietly drop it.
  const declared = new Set(Object.keys(DAY_READ_REQUIRED_CONCEPT));
  for (const { code } of everyAthleteFacingSentence()) {
    assert.ok(declared.has(code), `${code} has no declared concept — every rule must say what it is about`);
  }
  for (const { key, register, text } of everyAthleteFacingSentence()) {
    assert.match(text, DAY_READ_REQUIRED_CONCEPT[key], `${key} (${register}) lost the rule's own meaning`);
  }
});

// ---------- the unified protect path: the dominant rest read ----------
// A check-in with low felt sleep or high soreness is a safety override, so the protect
// posture — not any of the rules above — decides most rest/easy mornings. It used to
// assign the winning evidence's machine-facing `summary` to the Brief's headline: the
// third person, about the athlete, in ONE literal per signal, printed verbatim for as
// long as the input held. These pin the second vocabulary that replaced it.
test("every athlete-facing phrasing of the signal state speaks to the athlete, not about them", () => {
  const rows = Object.entries(SIGNAL_VOICE_REGISTRY).flatMap(([key, entry]) =>
    entry.variants.map((text) => ({ key, text }))
  );
  assert.ok(rows.length >= 60, "the whole signal vocabulary is under test");
  for (const { key, text } of rows) {
    assert.doesNotMatch(text, /\bthe athlete\b/i, `${key} talks about the athlete instead of to them`);
    assert.doesNotMatch(text, /\bthey (?:feel|felt|report|reports)\b/i, `${key} reads as an observer's note`);
    // Every one of them is also registered in DAY_READ_WHY_VARIANTS, so the plain
    // language / no-score / no-gate guards above already cover this path.
    assert.ok(
      (DAY_READ_WHY_VARIANTS[`acute_signal_protection:${key}`] ?? []).includes(text),
      `${key} is not registered with the rest of the Brief's vocabulary`
    );
  }
});

test("a felt-recovery check-in leads the Brief in the athlete's own voice, and rotates", () => {
  const seen = [];
  for (let back = 4; back >= 0; back--) {
    const date = dayBefore(REF, back);
    repo.addCheckin(date, { sleep_feel: 1, energy: 3, mood: 3 });
    const read = repo.dayRead(date, { has_data: false, recovery: {} });
    assert.equal(read.kind, "rest");
    assert.equal(read.decision.rule_code, "acute_signal_protection");
    assert.equal(read.signals.signal_state.action.voice.key, "sleep_feel_low");
    saysOneOf(read.why, "acute_signal_protection:sleep_feel_low");
    // The exact string the reviewer found on the Brief.
    assert.doesNotMatch(read.why, /The athlete feels poorly recovered/i);
    seen.push(read.why);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i], seen[i - 1], "the dominant rest path repeated itself day over day");
  }
  assert.ok(new Set(seen).size >= 3, "five days must not cycle through two sentences");
});

test("the protect read never prints the machine-facing evidence summary", () => {
  repo.addCheckin(REF, { soreness: 5, energy: 3, sleep_feel: 3, mood: 3 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });

  assert.equal(r.decision.rule_code, "acute_signal_protection");
  saysOneOf(r.why, "acute_signal_protection:soreness_high");
  // …while the coach context and the provenance trail still see the summary, verbatim.
  const state = r.signals.signal_state;
  assert.equal(state.action.reason, "The athlete reports high soreness today.");
  assert.equal(state.dimensions.training_load_tolerance.reason, "The athlete reports high soreness today.");
  assert.notEqual(state.action.reason, r.why);
});

// ---------- prose variety (the "rest after rest after rest" complaint) ----------
test("variant selection is stable per day and never repeats on consecutive days", () => {
  const variants = ["a", "b", "c", "d"];
  // Same day + same key ⇒ the same text, every time.
  for (let i = 0; i < 5; i++) {
    assert.equal(pickDayVariant(variants, REF, "rule"), pickDayVariant(variants, REF, "rule"));
  }
  // Consecutive days ⇒ different text, for 30 days straight.
  for (let back = 0; back < 30; back++) {
    const today = dayBefore(REF, back);
    const yesterday = dayBefore(REF, back + 1);
    assert.notEqual(
      pickDayVariant(variants, today, "rule"),
      pickDayVariant(variants, yesterday, "rule"),
      `${yesterday} → ${today} repeated itself`
    );
  }
  // Degenerate + malformed inputs stay safe.
  assert.equal(pickDayVariant(["only"], REF, "rule"), "only");
  assert.equal(pickDayVariant(variants, "not-a-date", "rule"), variants[pickIndexFor("rule", variants.length)]);
});

// The offset half of pickDayVariant, mirrored so the malformed-date case above can
// assert a concrete value rather than "it didn't throw".
function pickIndexFor(key, span) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash % 9973) % span;
}

// The cross-day cases run on REAL recent dates on purpose: saveDayRead prunes rows
// older than 21 days, so a fixed historical REF would delete its own history.
const CHRONIC_SHORT_SLEEP = { has_data: true, recovery: { avg_sleep_min: 300 } }; // 5h nightly

// Live the same unchanging day `n` times in a row, persisting each read the way the
// real Brief does so the next morning can read yesterday back.
function liveConsecutiveDays(n, recovery = CHRONIC_SHORT_SLEEP) {
  const reads = [];
  for (let back = n - 1; back >= 0; back--) {
    const date = localDaysAgo(back);
    const read = repo.dayRead(date, recovery);
    repo.saveDayRead(date, { ...read, headline: "Take it easy.", source: "deterministic", override: null });
    reads.push({ date, read });
  }
  return reads;
}

test("five identical days for a chronic short sleeper do NOT print the same Brief", () => {
  // The actual complaint: nothing read yesterday's read, so a stable input — a
  // chronically short sleeper with nothing programmed — yielded a verbatim-identical
  // Brief indefinitely. Taking the rest never changes the input, so the read never
  // changed. Nothing anywhere covered this.
  const seen = liveConsecutiveDays(5).map(({ date, read }) => ({
    date,
    kind: read.kind,
    why: read.why,
    reason: read.decision.reason,
  }));

  assert.deepEqual(
    seen.map((s) => s.kind),
    ["easy", "easy", "easy", "easy", "easy"],
    "the POSTURE is stable — only the words move"
  );
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i].why, seen[i - 1].why, `${seen[i].date} repeated ${seen[i - 1].date} verbatim`);
  }
  assert.ok(new Set(seen.map((s) => s.why)).size >= 4, "five days must not cycle through two sentences");
  assert.ok(new Set(seen.map((s) => s.reason)).size >= 3, "the ledger reason varies too");
});

test("the third consecutive quiet day says something materially different", () => {
  const reads = liveConsecutiveDays(5).map((entry) => entry.read);

  // Day 1 argues the case for an easier day; day 2 repeats it but says so plainly...
  saysOneOf(reads[0].why, "chronic_sleep_watch");
  assert.equal(reads[0].signals.continuity.quiet_streak, 0);
  assert.ok(
    DAY_READ_WHY_VARIANTS.chronic_sleep_watch.some((v) => reads[1].why.startsWith(v)),
    `day 2 should still lead with the read, got ${JSON.stringify(reads[1].why)}`
  );
  assert.equal(reads[1].signals.continuity.quiet_streak, 1);
  // ...day 3 onward stops re-arguing it and offers the smallest thing worth doing.
  for (const read of reads.slice(2)) {
    assert.ok(read.signals.continuity.quiet_streak >= 2);
    assert.match(read.why, /quiet day/i);
    assert.equal(
      (DAY_READ_WHY_VARIANTS.chronic_sleep_watch ?? []).includes(read.why),
      false,
      "the third quiet day must not re-assert the same read"
    );
    // Still a suggestion, never a gate, never a nag, never a score.
    assert.match(read.why, /\b(?:walk|mobility|easy|small|rest)\b/i);
    assert.doesNotMatch(read.why, /\bmust\b|\bshould\b|\d+\s*(?:\/\s*100|%)/i);
    assert.equal(read.kind, "easy", "escalating the WORDS never escalates the posture");
  }
  assert.equal(reads[2].signals.continuity.quiet_streak, 2);
  assert.equal(reads[4].signals.continuity.quiet_streak, 4);
  assert.notEqual(reads[3].why, reads[2].why, "even the escalation rotates day over day");
});

test("the longest quiet run the Brief can see still reads as English", () => {
  // dayReadContinuity walks recentDayReads(date, 7), so the streak tops out at 7 and the
  // escalation asks for the ordinal of day 8 — one past where the ordinal table ended.
  // It fell through to the "another" fallback and printed "That's your another quiet day
  // in a row", reachable in exactly the scenario this layer exists to fix.
  const reads = liveConsecutiveDays(8).map((entry) => entry.read);
  const last = reads[reads.length - 1];

  assert.equal(last.signals.continuity.quiet_streak, 7, "the window itself caps the streak at 7");
  assert.ok(
    QUIET_STREAK_WHY.map((render) => render("eighth")).includes(last.why),
    `day 8 should name its own ordinal, got ${JSON.stringify(last.why)}`
  );
  assert.doesNotMatch(last.why, /\b(?:your|the)\s+another\b/i, "a determiner where the ordinal belongs");
});

test("the quiet-day ordinal covers every reachable streak and falls back to a word that fits every sentence", () => {
  // 3..8 is the whole reachable range (the escalation starts at a streak of 2, and the
  // continuity window caps it at 7). Beyond that the fallback has to be a WORD, not a
  // determiner — "your another quiet day" was grammatical nonsense in three of the four
  // templates, so widening the window would have broken the sentence all over again.
  for (let n = 3; n <= 8; n++) {
    assert.match(quietOrdinal(n), /^(?:third|fourth|fifth|sixth|seventh|eighth)$/, `streak ordinal ${n}`);
  }
  const fallback = quietOrdinal(99);
  for (const render of [...QUIET_STREAK_WHY, ...QUIET_STREAK_GUARDED_WHY]) {
    const sentence = render(fallback);
    assert.doesNotMatch(
      sentence,
      /\b(?:your|the)\s+(?:another|each|every|some|any)\b/i,
      `the fallback reads as a determiner here: ${JSON.stringify(sentence)}`
    );
    assert.match(sentence, /^[A-Z]/, `should still open as a sentence: ${JSON.stringify(sentence)}`);
    assert.match(sentence, /\bquiet days?\b/i, `should still be about the quiet stretch: ${JSON.stringify(sentence)}`);
  }
});

test("a quiet stretch with an injury never prescribes what the work-around just ruled out", () => {
  // The escalation is appended AFTER the injury caveat, so the read's last and most
  // memorable sentence was "ten easy minutes on your feet is plenty" — for someone who
  // had just been told to stay off it. Date-keyed variants made it contradict itself on
  // some days and not others.
  repo.addContextEvent({
    kind: "injury",
    title: "Achilles tendinopathy",
    detail: "Walking and running aggravate it",
    start_date: localDaysAgo(6),
  });
  const reads = liveConsecutiveDays(4).map((entry) => entry.read);

  for (const read of reads.slice(2)) {
    assert.ok(["easy", "rest"].includes(read.kind), `still a protective read, got ${read.kind}`);
    assert.equal(read.signals.health_workaround.field, "active_injury");
    // The caveat survives...
    const caveat = injurySentence(read.why, "Achilles tendinopathy");
    // ...the escalation still follows it, from the guarded set...
    const escalation = QUIET_STREAK_GUARDED_WHY.map((render) =>
      render(quietOrdinal(read.signals.continuity.quiet_streak + 1))
    );
    assert.ok(
      escalation.some((text) => read.why.endsWith(text)),
      `expected a guarded escalation to close the read, got ${JSON.stringify(read.why)}`
    );
    // ...and nothing after it sends an athlete with a lower-limb injury out on their feet.
    assert.doesNotMatch(read.why.slice(read.why.indexOf(caveat)), /on your feet|walk|mobility|steps/i);
  }
  assert.notEqual(reads[3].why, reads[2].why, "the guarded escalation rotates day over day too");
});

test("an unchanged read says so plainly instead of re-deriving itself", () => {
  const [, today] = liveConsecutiveDays(2);

  assert.equal(today.read.signals.continuity.repeat_of_yesterday, true);
  assert.equal(today.read.signals.continuity.yesterday.rule_code, "chronic_sleep_watch");
  assert.match(
    today.read.why,
    /(?:nothing's really moved|unchanged from yesterday|same picture as yesterday|nothing new has come in)/i
  );
});

test("a quiet stretch stops being the subject once they have actually moved today", () => {
  // "Third quiet day — here's the smallest thing worth doing" would ignore the walk
  // they already took. The read is about what they just did.
  liveConsecutiveDays(3);
  const today = localDaysAgo(0);
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(today);

  const read = repo.dayRead(today, CHRONIC_SHORT_SLEEP);

  assert.equal(read.kind, "easy");
  assert.equal(read.decision.rule_code, "logged_light_work_today");
  assert.ok(read.signals.continuity.quiet_streak >= 2, "the streak is still tracked");
  saysOneOf(read.why, "logged_light_work_today");
  assert.doesNotMatch(read.why, /quiet day/i);
});

test("a day the Brief never saw breaks the quiet run (an unknown day is not a quiet day)", () => {
  const read = repo.dayRead(localDaysAgo(0), CHRONIC_SHORT_SLEEP);
  assert.equal(read.signals.continuity.quiet_streak, 0);
  assert.equal(read.signals.continuity.yesterday, null);
  assert.equal(read.signals.continuity.repeat_of_yesterday, false);
  saysOneOf(read.why, "chronic_sleep_watch");
});

test("each reachable rule branch reports its own code and reason, never a generic fallback", () => {
  const generic = /deterministic day policy/i;
  const seen = new Map();
  const record = (read) => {
    seen.set(read.decision.rule_code, read.decision.reason);
    assert.doesNotMatch(read.decision.reason, generic, read.decision.rule_code);
    assert.ok(String(read.decision.reason).trim(), `${read.decision.rule_code} has no reason`);
    return read;
  };

  // No plan, nothing logged → the unprogrammed floor.
  const bare = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(bare.decision.rule_code, "unprogrammed_easy_day");
  assert.ok(UNPROGRAMMED_EASY_DAY.reasons.includes(bare.decision.reason));

  // Chronic short sleep with nothing programmed → the (demoted) sleep watch.
  const chronic = record(repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 300 } }));
  assert.equal(chronic.decision.rule_code, "chronic_sleep_watch");

  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const planned = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(planned.decision.rule_code, "planned_training");

  // A corroborating fresh short night still reaches rest.
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 300)`).run(dayBefore(REF, 1));
  const acute = record(repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 330 } }));
  assert.equal(acute.decision.rule_code, "acute_sleep_corroborated");
  resetTables("daily_metrics");

  // Three stacked loading days → earned rest from accumulated load.
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  const stacked = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(stacked.decision.rule_code, "accumulated_load_rest");
  resetTables("logged_sets", "sessions");

  // A run-down check-in reaches rest through the unified protect posture, which
  // sits ABOVE earned rest — so the code that reaches the ledger describes the
  // rule that actually fired, not the one further down the list.
  repo.addCheckin(REF, { energy: 1, sleep_feel: 2 });
  const runDown = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(runDown.kind, "rest");
  assert.equal(runDown.decision.rule_code, "acute_signal_protection");
  resetTables("checkins");

  // Work already logged today (a real loading session) → the done acknowledgement.
  seedTrainingDay(REF);
  const done = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(done.kind, "done");
  assert.equal(done.decision.rule_code, "logged_loading_work_today");
  resetTables("logged_sets", "sessions");

  assert.ok(seen.size >= 6);
});

test("the endurance volume-spike rule reports a real reason (it had none at all)", () => {
  // The one rule whose code was genuinely absent from the old map: it fired and
  // told the athlete "Cairn's deterministic day policy selected this posture."
  repo.setProfile({ primary_discipline: "endurance", endurance_sport: "running" });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  // A ramped week against a quiet chronic base. Two loading days is deliberate:
  // three would trip earned rest first and the spike rule would never be reached.
  const run = (daysBack, minutes, km) =>
    db
      .prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', ?, ?)`)
      .run(dayBefore(REF, daysBack), minutes, km);
  run(1, 55, 11);
  run(2, 85, 16);
  for (const back of [9, 16, 23]) run(back, 45, 8); // the quiet chronic base

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });

  assert.equal(r.signals.endurance_volume.volume_spike, true);
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "endurance_volume_spike");
  assert.ok(DAY_READ_OUTCOMES.endurance_volume_spike.reasons.includes(r.decision.reason));
  assert.doesNotMatch(r.decision.reason, /deterministic day policy/i);
});

test("sleep evidence speaks in hours, never raw minutes", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 412)`).run(dayBefore(REF, 1));

  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 412 } });
  const sleep = r.decision.evidence.find((item) => item.label === "Last night's sleep");

  assert.equal(sleep.value, "6h 52m");
  for (const item of r.decision.evidence) assert.doesNotMatch(item.value, /\d+\s*min\b/);
});

// ---------- the fingerprint is a DECISION fingerprint ----------
test("recovery telemetry that cannot move the decision leaves the fingerprint alone", () => {
  const base = {
    kind: "train",
    focus: "Lower body",
    signals: {
      recent_load: [{ date: dayBefore(REF, 1), load: "easy" }],
      today_load: "none",
      low_sleep: false,
      avg_sleep_min: 431,
      last_night: { date: dayBefore(REF, 1), total_min: 431, hrv_vs_baseline: 3 },
      fatigue: {
        anticipate_deload: false,
        low_readiness: false,
        acute_load: 210,
        hrv_vs_norm: -1,
        readiness: { current: 68, window_average: 61, sample_count: 9 },
      },
    },
  };
  const before = repo.dayReadInputFingerprint(REF, base);

  // A mid-day watch sync: every continuous number moves, no predicate flips.
  const resynced = {
    ...base,
    signals: {
      ...base.signals,
      avg_sleep_min: 437,
      last_night: { date: dayBefore(REF, 1), total_min: 448, hrv_vs_baseline: -2 },
      fatigue: {
        ...base.signals.fatigue,
        acute_load: 244,
        hrv_vs_norm: -4,
        readiness: { current: 71, window_average: 64, sample_count: 10 },
      },
    },
  };
  assert.equal(repo.dayReadInputFingerprint(REF, resynced), before, "telemetry noise must not invalidate the read");

  // But the predicates the rules actually branch on still do.
  const shortNight = {
    ...base,
    signals: { ...base.signals, last_night: { ...base.signals.last_night, total_min: 300 } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, shortNight), before);
  const chronic = { ...base, signals: { ...base.signals, low_sleep: true } };
  assert.notEqual(repo.dayReadInputFingerprint(REF, chronic), before);
  const lowReadiness = {
    ...base,
    signals: { ...base.signals, fatigue: { ...base.signals.fatigue, low_readiness: true } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, lowReadiness), before);
  const deload = {
    ...base,
    signals: { ...base.signals, fatigue: { ...base.signals.fatigue, anticipate_deload: true } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, deload), before);
  // The volume spike now participates at all — it used to be invisible here.
  const spike = {
    ...base,
    signals: { ...base.signals, endurance_volume: { last_week_km: 62, volume_spike: true } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, spike), before);
  // ...but its raw mileage does not.
  const mileageOnly = {
    ...base,
    signals: { ...base.signals, endurance_volume: { last_week_km: 41, volume_spike: false } },
  };
  assert.equal(repo.dayReadInputFingerprint(REF, mileageOnly), before);
});
