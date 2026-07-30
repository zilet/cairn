import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  buildSymptomCapturePrompt,
  coerceSymptomCapture,
  matchSymptomMovement,
  symptomTextMentionsBody,
} from "../dist/symptomCapture.js";

beforeEach(() => {
  resetTables(
    "symptom_reports",
    "movement_tolerance_observations",
    "training_symptom_events",
    "logged_sets",
    "sessions",
    "exercises"
  );
  repo.findOrCreateExercise("Landmine Press", "shoulders");
  repo.findOrCreateExercise("Barbell Curl", "biceps");
  repo.findOrCreateExercise("Back Squat", "quads");
});

function reports() {
  return db.prepare(`SELECT * FROM symptom_reports ORDER BY id`).all();
}

function observations(eventId) {
  return db
    .prepare(
      `SELECT movement_name, outcome, evidence, observed_on FROM movement_tolerance_observations
       WHERE symptom_event_id = ? ORDER BY id`
    )
    .all(eventId);
}

// ---------------------------------------------------------------------------
// 1. The words survive.
// ---------------------------------------------------------------------------

test("a long pain report is stored whole while area_text stays the short label", () => {
  // The shape of the live bug: a real sentence squeezed into a 60-character label
  // column, clipped mid-word, remainder gone forever.
  const spoken =
    "Slight unpleasent feeling in my right hand joint (probably from gripping the bar too hard on the last set) " +
    "and it only shows up when I press overhead, not when I pull, and it settles within about an hour of finishing " +
    "so I do not think it is anything structural but I want it on the record in case it keeps happening every week.";
  assert.ok(spoken.length > 300, "fixture must be longer than any label column");

  const event = repo.reportTrainingSymptom({ area_text: spoken, onset_on: "2035-03-01" });

  const stored = reports();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, spoken, "the athlete's words are kept verbatim, uncut");
  assert.equal(stored[0].symptom_event_id, event.id);
  assert.equal(stored[0].extraction_status, "pending");

  // The label is still a label — pain-relevance runs substring regexes over it.
  assert.ok(event.area_text.length <= 60);
  assert.notEqual(event.area_text, spoken);
  assert.ok(spoken.startsWith(event.area_text), "the label is a prefix of their words, not a rewrite");
  // And the lifecycle hands the full text back, so the surface can render it.
  assert.equal(event.report_text, spoken);
  assert.equal(repo.getTrainingSymptom(event.id, "2035-03-01").report_text, spoken);
});

test("re-delivering the same report is one record, not two", () => {
  repo.reportTrainingSymptom({ area_text: "left knee is grumbling again", onset_on: "2035-03-01" });
  repo.reportTrainingSymptom({ area_text: "left knee is grumbling again", onset_on: "2035-03-01" });
  assert.equal(reports().length, 1);
});

// ---------------------------------------------------------------------------
// 2. Extraction: words in, structure out — through the existing repo functions.
// ---------------------------------------------------------------------------

async function enrichModule() {
  return import("../dist/enrich.js");
}

function captureContext(text, on) {
  return {
    text,
    reported_on: on,
    active_events: repo
      .listTrainingSymptoms({ on, include_resolved: false, seed_legacy: false })
      .map((event) => ({ id: event.id, area_label: event.area_text, scope: event.scope })),
    session_movements: ["Landmine Press", "Barbell Curl"],
    recent_movements: ["Back Squat"],
  };
}

test("extraction ties words to the open watch and records what each movement did", async () => {
  const { applySymptomExtraction } = await enrichModule();
  const on = "2035-04-10";
  const existing = repo.reportTrainingSymptom({ area_text: "right hand joint", onset_on: "2035-04-01" });
  assert.equal(existing.last_reported_on, "2035-04-01");

  const text = "right hand joint aching again, landmine press lit it up, curls were fine";
  const report = repo.recordSymptomReport({ text, source_kind: "session_note", reported_on: on, extract: false });
  const ctx = captureContext(text, on);

  // A payload shaped exactly as the contract asks — the model echoes a label, never
  // an id, and names only movements from the list it was handed.
  const validated = coerceSymptomCapture(
    {
      found: true,
      reports: [
        {
          quote: "right hand joint aching again",
          area_label: "right hand joint",
          scope: "area",
          change: "worse",
          movements: [
            { name: "landmine press", outcome: "pain_present" },
            { name: "curls", outcome: "pain_free" },
          ],
        },
      ],
    },
    ctx
  );
  assert.equal(validated.ok, false, "a movement the athlete never trained is not one of theirs");

  const good = coerceSymptomCapture(
    {
      found: true,
      reports: [
        {
          quote: "right hand joint aching again",
          area_label: "right hand joint",
          scope: "area",
          change: "worse",
          movements: [
            { name: "landmine press", outcome: "pain_present" },
            { name: "Barbell Curl", outcome: "pain_free" },
          ],
        },
      ],
    },
    ctx
  );
  assert.equal(good.ok, true, good.ok ? "" : good.reason);
  // The deterministic side owns the matching: the model said "landmine press".
  assert.deepEqual(good.result.reports[0].movements[0], { name: "Landmine Press", outcome: "pain_present" });

  applySymptomExtraction(report.id, good.result);

  const events = repo.listTrainingSymptoms({ on, seed_legacy: false });
  assert.equal(events.length, 1, "it adopted the open watch instead of opening a second one");
  const event = events[0];
  assert.equal(event.id, existing.id);
  assert.equal(event.last_reported_on, on, "saying it again refreshes freshness");
  assert.equal(event.freshness, "acute_movement_brake");

  const rows = observations(event.id);
  assert.equal(rows.filter((row) => row.movement_name === "Landmine Press" && row.outcome === "pain_present").length, 1);
  assert.equal(rows.filter((row) => row.movement_name === "Barbell Curl" && row.outcome === "pain_free").length, 1);
  assert.ok(rows.every((row) => row.evidence === "stated"), "the athlete said these, so they are stated");
  // The words and the record now point at each other.
  assert.equal(repo.getSymptomReport(report.id).symptom_event_id, event.id);

  // Re-running the same extraction is a retry, not a second episode.
  const before = { events: repo.listTrainingSymptoms({ on, seed_legacy: false }).length, rows: observations(event.id).length };
  applySymptomExtraction(report.id, good.result);
  assert.equal(repo.listTrainingSymptoms({ on, seed_legacy: false }).length, before.events);
  assert.equal(observations(event.id).length, before.rows);
  assert.equal(repo.getTrainingSymptom(event.id, on).recurrence_count, event.recurrence_count);
});

test("the validator refuses smuggled prose, scores and gate language", () => {
  const text = "shoulder felt rough on presses today";
  const ctx = captureContext(text, "2035-04-10");
  const base = {
    quote: "shoulder felt rough on presses",
    area_label: "shoulder",
    scope: "area",
    change: "same",
    movements: [],
  };
  const reject = (patch, why) => {
    const out = coerceSymptomCapture({ found: true, reports: [{ ...base, ...patch }] }, ctx);
    assert.equal(out.ok, false, why);
  };
  reject({ quote: "The athlete reports moderate rotator cuff irritation." }, "a quote must be their own words");
  reject({ area_label: "shoulder, severity 7/10" }, "a label may not carry a score");
  reject({ area_label: "shoulder — you must stop pressing" }, "a label may not carry gate language");
  reject({ change: "flaring" }, "change is a closed vocabulary");
  reject({ scope: "whole_body" }, "scope is a closed vocabulary");
  reject({ scope: "systemic", movements: [{ name: "Back Squat", outcome: "pain_free" }] }, "systemic names no movement");
  reject({ area_label: null }, "an area report must name a place");

  // And the honest happy path still passes, including a "7/10" the ATHLETE wrote.
  const theirScore = "knee was about 7/10 on squats";
  const scored = coerceSymptomCapture(
    {
      found: true,
      reports: [{ quote: theirScore, area_label: "knee", scope: "area", change: "worse", movements: [] }],
    },
    captureContext(theirScore, "2035-04-10")
  );
  assert.equal(scored.ok, true, "their words are theirs, numbers and all");
});

test("found:false is a correct, cheap answer and the prefilter keeps it cheaper", () => {
  const ctx = captureContext("great session, felt strong", "2035-04-10");
  const out = coerceSymptomCapture({ found: false, reports: [] }, ctx);
  assert.deepEqual(out, { ok: true, result: { found: false, reports: [] } });

  assert.equal(symptomTextMentionsBody("great session, felt strong"), false);
  assert.equal(symptomTextMentionsBody("PR day, everything moved well"), false);
  assert.equal(symptomTextMentionsBody("right wrist ached on the last set"), true);
  assert.equal(symptomTextMentionsBody("everything feels off today"), true);
  assert.equal(symptomTextMentionsBody(""), false);

  assert.equal(matchSymptomMovement("landmine press", ["Landmine Press", "Back Squat"]), "Landmine Press");
  assert.equal(matchSymptomMovement("kettlebell swing", ["Landmine Press"]), null);
});

test("the extraction prompt is bounded: their words, their watches, their movements", () => {
  const on = "2035-04-10";
  repo.reportTrainingSymptom({ area_text: "right hand joint", onset_on: "2035-04-01" });
  const prompt = buildSymptomCapturePrompt(captureContext("right hand joint aching", on));
  assert.match(prompt, /right hand joint aching/);
  assert.match(prompt, /WATCHES ALREADY OPEN/);
  assert.match(prompt, /- Landmine Press/);
  assert.match(prompt, /Do not invent ids/);
  // It is a reading task, not a coaching one — no coach context reaches it.
  assert.doesNotMatch(prompt, /DATA:/);
  assert.ok(prompt.length < 12_000);
});

// ---------------------------------------------------------------------------
// 3. Systemic reports finally have somewhere to live.
// ---------------------------------------------------------------------------

test("a whole-body report is a first-class watch that never loads a movement", async () => {
  const { applySymptomExtraction } = await enrichModule();
  const on = "2035-05-02";
  const text = "everything feels off today, not one movement";
  const report = repo.recordSymptomReport({ text, source_kind: "session_note", reported_on: on, extract: false });
  const validated = coerceSymptomCapture(
    {
      found: true,
      reports: [{ quote: text, area_label: null, scope: "systemic", change: "new", movements: [] }],
    },
    captureContext(text, on)
  );
  assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
  applySymptomExtraction(report.id, validated.result);

  const active = repo.listTrainingSymptoms({ on, seed_legacy: false });
  assert.equal(active.length, 1);
  assert.equal(active[0].scope, "systemic");
  assert.equal(active[0].report_text, text, "the watch shows their words");

  // It is visible, and it gates nothing.
  assert.deepEqual(
    repo.activeSystemicTrainingSymptoms(on, { seed_legacy: false }).map((event) => event.id),
    [active[0].id]
  );
  for (const movement of ["Back Squat", "Landmine Press", "Barbell Curl"]) {
    assert.deepEqual(
      repo.activeRelevantTrainingSymptoms(on, { name: movement }, { seed_legacy: false }),
      [],
      `${movement} must not be gated by a report that named no place`
    );
  }
  assert.deepEqual(
    repo.trainingSymptomsForMovements(on, ["Back Squat", "Landmine Press"], { seed_legacy: false }),
    []
  );
  assert.deepEqual(observations(active[0].id), [], "no per-movement rows could be honest here");
});

test("a systemic watch and an area watch are separate records", () => {
  const on = "2035-05-02";
  const systemic = repo.reportTrainingSymptom({
    area_text: "everything feels off",
    scope: "systemic",
    onset_on: on,
  });
  const area = repo.reportTrainingSymptom({ area_text: "everything feels off", onset_on: on });
  assert.notEqual(systemic.id, area.id);
  assert.equal(repo.getTrainingSymptom(systemic.id, on).scope, "systemic");
  assert.equal(repo.getTrainingSymptom(area.id, on).scope, "area");
});

// ---------------------------------------------------------------------------
// 4. Tolerance inferred from training reality.
// ---------------------------------------------------------------------------

function loadDay(date, exercise) {
  for (let n = 1; n <= 3; n++) {
    repo.logSetByName({ date, exercise, weight: 95, reps: 8, rir: 2 });
  }
  return repo.getOrCreateSession(date, null);
}

test("finishing a session records the quiet exposures the athlete trained through", () => {
  const on = "2035-06-05";
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-06-01" });
  assert.equal(knee.last_reported_on, "2035-06-01");
  const session = loadDay(on, "Back Squat");

  repo.finishSession(session.id, "solid session, nothing to report");

  const after = repo.getTrainingSymptom(knee.id, on);
  const rows = observations(knee.id);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { movement_name: rows[0].movement_name, outcome: rows[0].outcome, evidence: rows[0].evidence },
    { movement_name: "Back Squat", outcome: "pain_free", evidence: "inferred" }
  );
  // THE POINT: the watch stays alive because they trained, not because they pressed.
  assert.equal(after.last_reported_on, on);
  assert.equal(after.freshness, "acute_movement_brake");
  // And nothing pretends they said anything.
  assert.equal(after.recurrence_count, 0, "training through it is not a recurrence");
  assert.equal(after.legacy_unconfirmed, knee.legacy_unconfirmed);
  const readiness = after.movement_readiness[0];
  assert.equal(readiness.pain_free_exposures, 1);
  assert.equal(readiness.stated_pain_free_exposures, 0);
  assert.equal(readiness.inferred_only, true, "silence must be visible as silence");

  // Re-finishing (an outbox replay, a Garmin re-sync) adds nothing.
  repo.finishSession(session.id, "solid session, nothing to report");
  repo.inferTrainingSymptomExposures(session.id, on);
  assert.equal(observations(knee.id).length, 1);
  assert.equal(repo.getTrainingSymptom(knee.id, on).recurrence_count, 0);
});

test("an inferred exposure is upgraded, never shadowed, once the athlete speaks", () => {
  const on = "2035-06-05";
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-06-01" });
  const session = loadDay(on, "Back Squat");
  repo.finishSession(session.id, "nothing to report");
  assert.equal(observations(knee.id)[0].evidence, "inferred");

  repo.recordMovementTolerance({
    symptom_event_id: knee.id,
    movement: "Back Squat",
    observed_on: on,
    session_id: session.id,
    pain_free: true,
  });
  const rows = observations(knee.id);
  assert.equal(rows.length, 1, "it is one exposure, not two");
  assert.equal(rows[0].evidence, "stated");
  assert.equal(repo.getTrainingSymptom(knee.id, on).movement_readiness[0].inferred_only, false);
});

test("a movement reported painful that day is never also recorded as tolerated", () => {
  const on = "2035-06-06";
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-06-01" });
  const session = loadDay(on, "Back Squat");
  repo.recordMovementTolerance({
    symptom_event_id: knee.id,
    movement: "Back Squat",
    observed_on: on,
    session_id: session.id,
    pain_free: false,
  });
  const before = observations(knee.id).length;
  repo.finishSession(session.id, "");
  const rows = observations(knee.id);
  assert.equal(rows.length, before);
  assert.equal(rows.filter((row) => row.outcome === "pain_free").length, 0);
});

test("a systemic watch ages like any other — training alone never refreshes it", () => {
  const on = "2035-06-07";
  const systemic = repo.reportTrainingSymptom({
    area_text: "everything feels off",
    scope: "systemic",
    onset_on: "2035-06-01",
  });
  const session = loadDay(on, "Barbell Curl");
  repo.finishSession(session.id, "");
  const after = repo.getTrainingSymptom(systemic.id, on);
  // It names no place, so no session can say anything about it. Refreshing it on
  // every finish is what kept one open forever: it never aged, so it never went
  // stale enough to close. Recency moves when the athlete speaks, and only then.
  assert.equal(after.last_reported_on, "2035-06-01");
  assert.equal(after.freshness, "hold_easy_recheck");
  assert.equal(after.stated_freshness, "hold_easy_recheck");
  assert.deepEqual(observations(systemic.id), []);
  // Left alone long enough, it goes stale — the state it could never reach while
  // every session finish quietly renewed it.
  assert.equal(repo.getTrainingSymptom(systemic.id, "2035-06-20").freshness, "stale_needs_recheck");

  // Saying it again is what makes it current.
  repo.reportTrainingSymptom({ area_text: "everything feels off", scope: "systemic", onset_on: on });
  assert.equal(repo.getTrainingSymptom(systemic.id, on).last_reported_on, on);
});

test("two phrasings of a whole-body report are one watch, relabelled to their newest words", () => {
  const first = repo.reportTrainingSymptom({
    area_text: "everything feels off",
    scope: "systemic",
    onset_on: "2035-06-01",
  });
  const second = repo.reportTrainingSymptom({
    area_text: "whole body's wrecked",
    scope: "systemic",
    onset_on: "2035-06-03",
  });
  assert.equal(second.id, first.id, "a systemic watch is deduped on scope, not on wording");
  assert.equal(second.area_text, "whole body's wrecked", "the label follows their latest words");
  assert.equal(second.last_reported_on, "2035-06-03");
  assert.equal(
    repo.activeSystemicTrainingSymptoms("2035-06-03", { seed_legacy: false }).length,
    1,
    "at most one systemic watch is open"
  );
  // An area watch is still keyed by place — this dedupe is scope-only.
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-06-03" });
  const wrist = repo.reportTrainingSymptom({ area_text: "right wrist", onset_on: "2035-06-03" });
  assert.notEqual(knee.id, wrist.id);
});

test("a movement the watch does not load stays out of it entirely", () => {
  const on = "2035-06-08";
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-06-01" });
  const session = loadDay(on, "Barbell Curl");
  repo.finishSession(session.id, "");
  assert.deepEqual(observations(knee.id), [], "a curl says nothing about a knee");
  assert.equal(repo.getTrainingSymptom(knee.id, on).last_reported_on, "2035-06-01");
});

test("a session they said it hurt on is never also read as a quiet clean day", () => {
  // No enrichment, no agent — so nothing structures these words. That is the normal
  // case the old veto missed entirely: it only knew about pain the extraction lane
  // had already written down.
  const on = "2035-06-09";
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-06-01" });
  const session = loadDay(on, "Back Squat");

  repo.finishSession(session.id, "left knee hurt badly on every squat today, had to stop");

  // Their words are kept — that half never depended on an agent.
  const stored = reports().filter((row) => row.reported_on === on);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source_kind, "session_note");
  assert.equal(stored[0].extraction_status, "pending", "structure is still owed, and may never arrive");

  // And nothing was inferred from a day they spoke on.
  assert.deepEqual(
    observations(knee.id).filter((row) => row.observed_on === on),
    [],
    "silence cannot be read off a session they said hurt"
  );
  const after = repo.getTrainingSymptom(knee.id, on);
  assert.equal(after.relevant_pain_free_exposures, 0);
  assert.deepEqual(after.movement_readiness, [], "no exposure, so no readiness to show");
  assert.equal(after.last_reported_on, "2035-06-01", "an unspoken-for day moves no recency");

  // The quiet path is untouched: a note about nothing still yields the inferred read.
  const quietOn = "2035-06-10";
  const quiet = loadDay(quietOn, "Back Squat");
  repo.finishSession(quiet.id, "felt strong, best session in weeks");
  const rows = observations(knee.id).filter((row) => row.observed_on === quietOn);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evidence, "inferred");
});

test("an epoch bump carries inferred exposures forward as inferred, not as stated", () => {
  repo.findOrCreateExercise("Leg Press", "quads");
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-06-01" });

  for (const day of ["2035-06-11", "2035-06-12"]) {
    const session = loadDay(day, "Back Squat");
    repo.finishSession(session.id, "");
  }
  const quiet = repo.getTrainingSymptom(knee.id, "2035-06-12").movement_readiness[0];
  assert.equal(quiet.pain_free_exposures, 2);
  assert.equal(quiet.stated_pain_free_exposures, 0);

  // A different knee-loading movement flares: a new evidence epoch, and the squat
  // history is carried into it.
  const flare = "2035-06-13";
  repo.logSetByName({ date: flare, exercise: "Leg Press", weight: 200, reps: 8, rir: 2 });
  const flareSession = repo.getOrCreateSession(flare, null);
  repo.recordMovementTolerance({
    symptom_event_id: knee.id,
    movement: "Leg Press",
    observed_on: flare,
    session_id: flareSession.id,
    pain_free: false,
  });

  const after = repo.getTrainingSymptom(knee.id, flare);
  assert.ok(after.evidence_epoch > knee.evidence_epoch, "the flare opened a new epoch");
  const squat = after.movement_readiness.find((movement) => movement.movement_name === "Back Squat");
  assert.ok(squat, "the squat history survived the epoch bump");
  assert.equal(squat.pain_free_exposures, 2, "two quiet exposures, still on the record");
  assert.equal(squat.stated_pain_free_exposures, 0, "and the athlete still has not confirmed one of them");
  assert.equal(squat.inferred_only, true);
  // The rows themselves, not just the counts: the column DEFAULT must never win here.
  const carried = observations(knee.id).filter(
    (row) => row.movement_name === "Back Squat" && row.outcome === "pain_free"
  );
  assert.ok(carried.length >= 2);
  assert.ok(
    carried.every((row) => row.evidence === "inferred"),
    "carrying a row forward may not launder how it was obtained"
  );
});

test("a note naming two places leaves BOTH watches holding the athlete's words", async () => {
  const { applySymptomExtraction } = await enrichModule();
  const opened = "2035-09-01";
  const spoke = "2035-09-10";
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: opened });
  const wrist = repo.reportTrainingSymptom({ area_text: "right wrist", onset_on: opened });

  // Quiet training in between, so the freshness ladder actually consults the reports
  // rather than short-circuiting to last_reported_on.
  const quiet = loadDay("2035-09-05", "Back Squat");
  repo.logSetByName({ date: "2035-09-05", exercise: "Landmine Press", weight: 45, reps: 8, rir: 2 });
  repo.finishSession(quiet.id, "");

  const text = "left knee ached on squats and right wrist was sore on presses";
  const report = repo.recordSymptomReport({
    text,
    source_kind: "session_note",
    reported_on: spoke,
    extract: false,
  });
  const validated = coerceSymptomCapture(
    {
      found: true,
      reports: [
        {
          quote: "left knee ached on squats",
          area_label: "left knee",
          scope: "area",
          change: "worse",
          movements: [{ name: "Back Squat", outcome: "pain_present" }],
        },
        {
          quote: "right wrist was sore on presses",
          area_label: "right wrist",
          scope: "area",
          change: "worse",
          movements: [{ name: "Landmine Press", outcome: "pain_present" }],
        },
      ],
    },
    captureContext(text, spoke)
  );
  assert.equal(validated.ok, true, validated.ok ? "" : validated.reason);
  const applied = applySymptomExtraction(report.id, validated.result);
  assert.equal(applied.events, 2);

  for (const id of [knee.id, wrist.id]) {
    const event = repo.getTrainingSymptom(id, spoke);
    assert.equal(event.report_text, text, `watch ${event.area_text} shows the words it came from`);
    assert.equal(event.last_stated_on, spoke, `watch ${event.area_text} counts that day as spoken for`);
    assert.equal(event.stated_freshness, "acute_movement_brake");
  }
  // The single column still names the first watch attributed — a link, not a rewrite.
  assert.equal(repo.getSymptomReport(report.id).symptom_event_id, knee.id);

  // Re-applying the same extraction writes nothing and counts nothing.
  const again = applySymptomExtraction(report.id, validated.result);
  assert.equal(again.observations, 0, "a replayed extraction has no new observations to report");
});

// ---------------------------------------------------------------------------
// 5. Failure is free.
// ---------------------------------------------------------------------------

test("a stub agent that cannot speak the contract fails the extraction, never the words", async () => {
  const { processSymptomJob } = await enrichModule();
  repo.setSettings({
    enrich_enabled: true,
    agent_strategy: "priority",
    agent_order: ["stub"],
    disabled_agents: ["claude", "codex", "antigravity", "grok"],
  });
  const on = "2035-07-01";
  const text = "right wrist ached badly on every press today";
  const report = repo.recordSymptomReport({ text, source_kind: "session_note", reported_on: on, extract: false });

  // The offline stub answers with a plan proposal — parseable JSON of the wrong
  // shape, which is exactly the failure mode this lane has to survive.
  await processSymptomJob(report.id);

  const after = repo.getSymptomReport(report.id);
  assert.equal(after.extraction_status, "failed");
  assert.equal(after.text, text, "their words are untouched by a failed derivation");
  assert.deepEqual(repo.listTrainingSymptoms({ on, seed_legacy: false }), [], "nothing was derived");

  // A failed report is not retried into a loop.
  await processSymptomJob(report.id);
  assert.equal(repo.getSymptomReport(report.id).extraction_status, "failed");
});

test("with enrichment off or no agent, extraction skips and the record still holds", async () => {
  const { processSymptomJob } = await enrichModule();
  const text = "left elbow is niggling on curls";
  repo.setSettings({ enrich_enabled: false });
  const off = repo.recordSymptomReport({ text, source_kind: "chat", reported_on: "2035-07-02", extract: false });
  await processSymptomJob(off.id);
  assert.equal(repo.getSymptomReport(off.id).extraction_status, "skipped");

  repo.setSettings({
    enrich_enabled: true,
    disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"],
  });
  const none = repo.recordSymptomReport({ text, source_kind: "chat", reported_on: "2035-07-03", extract: false });
  await processSymptomJob(none.id);
  assert.equal(repo.getSymptomReport(none.id).extraction_status, "skipped");
  assert.equal(repo.getSymptomReport(none.id).text, text);
});

// ---------------------------------------------------------------------------
// Capture points: a note, a feedback line.
// ---------------------------------------------------------------------------

test("a session note that mentions the body is captured; one that doesn't costs nothing", () => {
  const quiet = repo.getOrCreateSession("2035-08-01", null);
  repo.finishSession(quiet.id, "felt strong, best session in weeks");
  assert.deepEqual(reports(), []);

  const spoke = repo.getOrCreateSession("2035-08-02", null);
  const words = "left shoulder was tight through the whole warm-up and never really let go";
  repo.finishSession(spoke.id, words);
  const stored = reports();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, words);
  assert.equal(stored[0].source_kind, "session_note");
  assert.equal(stored[0].session_id, spoke.id);

  // Correcting the note after the fact captures the correction too.
  repo.updateSessionNotes(spoke.id, "left shoulder was tight and it is still there this evening");
  assert.equal(reports().length, 2);
});

test("the feedback joint line keeps the whole sentence even though the column keeps a label", () => {
  const words = "outside of my left knee, sharp on the way down but fine coming up";
  repo.setSessionFeedback("2035-08-05", { soreness: 3, joint_pain: words });
  const stored = reports();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, words);
  assert.equal(stored[0].source_kind, "session_feedback");
  const session = repo.getSessionByDate("2035-08-05");
  assert.ok(session.joint_pain.length <= 60);
  assert.notEqual(session.joint_pain, words);
});

// ---------------------------------------------------------------------------
// 7. Schema: the migration and the fresh CREATE agree, twice over.
// ---------------------------------------------------------------------------

test("migration 88 is idempotent and lands the same shape a fresh DB creates", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../dist/migrate.js");
  const migration = MIGRATIONS.find((entry) => entry.version === 88);
  assert.ok(migration, "migration 88 exists");

  const columns = (handle, table) =>
    handle.prepare(`PRAGMA table_info(${table})`).all().map((row) => `${row.name}:${row.type}:${row.dflt_value}`);

  // A pre-88 database: the tables as they stood before this round.
  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE training_symptom_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kind TEXT NOT NULL,
    area_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    onset_on TEXT NOT NULL,
    last_reported_on TEXT NOT NULL
  );
  CREATE TABLE movement_tolerance_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symptom_event_id INTEGER NOT NULL,
    movement_key TEXT NOT NULL,
    movement_name TEXT NOT NULL,
    observed_on TEXT NOT NULL,
    outcome TEXT NOT NULL,
    relevant INTEGER NOT NULL
  );`);
  old.exec(`INSERT INTO training_symptom_events (source_kind, area_text, onset_on, last_reported_on)
            VALUES ('explicit', 'left knee', '2035-01-01', '2035-01-01')`);
  old.exec(`INSERT INTO movement_tolerance_observations
              (symptom_event_id, movement_key, movement_name, observed_on, outcome, relevant)
            VALUES (1, 'exercise:1', 'Back Squat', '2035-01-01', 'pain_free', 1)`);

  migration.up(old);
  const first = [columns(old, "training_symptom_events"), columns(old, "movement_tolerance_observations")];
  migration.up(old); // running it twice must be a clean no-op
  assert.deepEqual(
    [columns(old, "training_symptom_events"), columns(old, "movement_tolerance_observations")],
    first
  );

  // Existing rows get the meaning they already had.
  assert.equal(old.prepare(`SELECT scope FROM training_symptom_events WHERE id = 1`).get().scope, "area");
  assert.equal(
    old.prepare(`SELECT evidence FROM movement_tolerance_observations WHERE id = 1`).get().evidence,
    "stated"
  );

  // And a fresh DB (db.ts's CREATE) carries the same columns with the same defaults.
  for (const table of ["training_symptom_events", "movement_tolerance_observations"]) {
    const fresh = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const column of ["scope", "evidence"]) {
      const migrated = old.prepare(`PRAGMA table_info(${table})`).all().find((row) => row.name === column);
      const created = fresh.find((row) => row.name === column);
      if (!migrated) continue;
      assert.ok(created, `${table}.${column} exists on a fresh DB`);
      assert.equal(created.dflt_value, migrated.dflt_value, `${table}.${column} default agrees`);
      assert.equal(created.notnull, migrated.notnull, `${table}.${column} nullability agrees`);
    }
  }
  old.close();

  // symptom_reports is a brand-new table, so the CREATE is the whole story.
  const shape = db.prepare(`PRAGMA table_info(symptom_reports)`).all().map((row) => row.name);
  assert.deepEqual(shape, [
    "id",
    "symptom_event_id",
    "session_id",
    "text",
    "source_kind",
    "reported_on",
    "extraction_json",
    "extraction_status",
    "created_at",
  ]);
});
