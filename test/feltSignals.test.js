// Felt-signals learning (src/repo/felt-signals.ts) — the brain learns from what
// the athlete SAYS they feel. Invariants under test:
//   - override_rhythm speaks only when the same weekday is steered >=3 of its last
//     <=6 recorded days, carries that weekday, and stays silent on sparse steers
//   - checkin_signal fires on a persistent low read (>=4 samples, >=60% low) and is
//     ADHERENCE-NEUTRAL: sparse data, or non-low data, never produces a claim
//   - fueling_response reads the post-target follow-through (strained -> softer step,
//     steady -> landing well) and stays silent below the sample floor
//   - the nightly saveFeltSignals() round-trips through app_state and NEVER leaks the
//     internal params blob (GOLDEN)
//   - the day-read consumption pre-acknowledges a weekday pattern ONLY on its weekday
//   - thumbs-down suppression: a downvoted insight text stays in the dedup corpus
//     (recentInsightTexts / isDuplicateInsight) even after it ages past the window
// Deterministic, offline, temp DB (see test/run.mjs). Imports the module directly
// from dist (the LEAD wires the barrel re-export at merge).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";
import {
  buildFeltSignals,
  feltSignalsForCoach,
  feltSignalDayLines,
  saveFeltSignals,
} from "../dist/repo/felt-signals.js";

// ---- local seeding (kept in-file; never touches the shared _seed.js) ----
function reset() {
  for (const t of ["suggestions", "checkins", "fueling_feedback", "insights", "app_state"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
}

const REF = "2026-06-15"; // reference "today" for deterministic builds
function utcWeekday(dateISO) {
  return new Date(Date.parse(dateISO + "T00:00:00Z")).getUTCDay();
}
function daysBefore(dateISO, n) {
  return new Date(Date.parse(dateISO + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
}

function seedDayRead(date, { override = null, kind = "train" } = {}) {
  db.prepare(`INSERT INTO suggestions (kind, date, payload_json) VALUES ('day_read', ?, ?)`).run(
    date,
    JSON.stringify({ kind, focus: null, est_minutes: null, override })
  );
}
function seedCheckin(date, { energy = null, sleep_feel = null } = {}) {
  db.prepare(`INSERT INTO checkins (date, energy, sleep_feel) VALUES (?, ?, ?)`).run(date, energy, sleep_feel);
}
function seedFueling(date, { energy = null, hunger = null, decision_id = 1 } = {}) {
  db.prepare(`INSERT INTO fueling_feedback (date, energy, hunger, decision_id) VALUES (?, ?, ?, ?)`).run(
    date,
    energy,
    hunger,
    decision_id
  );
}

beforeEach(reset);

// ---------------------------------------------------------------------------
// override_rhythm
// ---------------------------------------------------------------------------
test("override_rhythm speaks when a weekday is repeatedly steered", () => {
  // Three same-weekday days (REF-7/-14/-21), all steered to rest.
  for (const n of [7, 14, 21]) seedDayRead(daysBefore(REF, n), { override: "rough night", kind: "rest" });
  const { patterns } = buildFeltSignals(REF);
  const p = patterns.find((x) => x.kind === "override_rhythm");
  assert.ok(p, "expected an override_rhythm pattern");
  assert.equal(p.weekday, utcWeekday(REF), "pattern carries the steered weekday");
  assert.ok(p.evidence_n >= 3);
  assert.match(p.statement.toLowerCase(), /rest/);
});

test("override_rhythm stays silent on sparse steers", () => {
  for (const n of [7, 14]) seedDayRead(daysBefore(REF, n), { override: "rough night", kind: "rest" });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "override_rhythm");
  assert.equal(p, undefined, "two steers is below the recurrence floor");
});

test("override_rhythm stays silent when steers are the minority of that weekday", () => {
  // 3 steered but 6 total recorded on the weekday -> exactly 50% passes; push to
  // 3 steered of 8 (<50%) so it must stay quiet.
  for (const n of [7, 14, 21]) seedDayRead(daysBefore(REF, n), { override: "rough night", kind: "rest" });
  for (const n of [28, 35, 42, 49, 56]) seedDayRead(daysBefore(REF, n), { override: null, kind: "train" });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "override_rhythm");
  assert.equal(p, undefined, "steers are the minority of the last 6 occurrences");
});

// Regression: before recordDayReadSuggestion()'s dedupe guard existed, a re-opened
// Brief could record several canonical (override:null) rows for the same date as
// the read evolved (rest -> the athlete trains -> train -> done). overrideRhythm
// already collapses `rows` to one entry per date in its own byDate map before any
// weekday counting happens, so this legacy duplication must NOT be mistaken for
// repeated steering — none of these rows carry an override, so the date never
// counts as steered no matter how many times it was re-recorded.
test("override_rhythm is not fooled by legacy duplicate canonical rows from Brief re-opens", () => {
  for (const n of [7, 14, 21]) {
    const d = daysBefore(REF, n);
    seedDayRead(d, { override: null, kind: "rest" });
    seedDayRead(d, { override: null, kind: "train" });
    seedDayRead(d, { override: null, kind: "done" });
  }
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "override_rhythm");
  assert.equal(p, undefined, "no genuine steer occurred — duplicate re-open rows must not read as repeated steering");
});

// ---------------------------------------------------------------------------
// checkin_signal
// ---------------------------------------------------------------------------
test("checkin_signal fires on persistent low energy", () => {
  for (const n of [1, 2, 3, 4, 5]) seedCheckin(daysBefore(REF, n), { energy: n % 2 === 0 ? 2 : 1 });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "checkin_signal");
  assert.ok(p, "expected a checkin_signal pattern");
  assert.equal(p.weekday, null);
  assert.match(p.statement.toLowerCase(), /energy/);
});

test("checkin_signal is adherence-neutral: sparse data makes no claim", () => {
  for (const n of [1, 2, 3]) seedCheckin(daysBefore(REF, n), { energy: 1 });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "checkin_signal");
  assert.equal(p, undefined, "three check-ins is below the sample floor");
});

test("checkin_signal makes no negative claim when reads are not low", () => {
  for (const n of [1, 2, 3, 4, 5]) seedCheckin(daysBefore(REF, n), { energy: 4 });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "checkin_signal");
  assert.equal(p, undefined, "good energy never manufactures a low-energy claim");
});

// ---------------------------------------------------------------------------
// fueling_response
// ---------------------------------------------------------------------------
test("fueling_response flags a strained follow-through as a softer next step", () => {
  for (const n of [1, 2, 3]) seedFueling(daysBefore(REF, n), { energy: 1, decision_id: 7 });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "fueling_response");
  assert.ok(p, "expected a fueling_response pattern");
  assert.match(p.statement.toLowerCase(), /gentler|running low/);
  assert.deepEqual(p.domains, ["nutrition"]);
});

test("fueling_response reads a steady follow-through as landing well", () => {
  for (const n of [1, 2, 3]) seedFueling(daysBefore(REF, n), { energy: n === 1 ? 3 : 2, decision_id: 7 });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "fueling_response");
  assert.ok(p, "expected a fueling_response pattern");
  assert.match(p.statement.toLowerCase(), /landing well|steady/);
});

test("fueling_response stays silent below the sample floor", () => {
  seedFueling(daysBefore(REF, 1), { energy: 1, decision_id: 7 });
  const p = buildFeltSignals(REF).patterns.find((x) => x.kind === "fueling_response");
  assert.equal(p, undefined, "a single linked read is not enough");
});

// ---------------------------------------------------------------------------
// nightly insertion point + GOLDEN (no params leak)
// ---------------------------------------------------------------------------
test("saveFeltSignals round-trips through app_state and strips the params blob", () => {
  // saveFeltSignals() builds against the real local "today", so seed relative to it.
  for (const n of [1, 2, 3, 4, 5]) seedCheckin(isoDaysAgo(n), { energy: 1 });
  saveFeltSignals();
  const raw = db.prepare(`SELECT value FROM app_state WHERE key = 'felt_signals'`).get();
  assert.ok(raw && raw.value, "felt_signals cached to app_state");

  const coach = feltSignalsForCoach();
  assert.ok(coach.patterns.length >= 1, "cached patterns read back");
  // GOLDEN: the surfaced read must never carry an internal count/fraction.
  const serialized = JSON.stringify(coach);
  assert.ok(!/"params"/.test(serialized), "params blob never surfaces");
  for (const p of coach.patterns) assert.equal(p.params, undefined);
});

test("feltSignalsForCoach falls back to a live build on a cold cache", () => {
  for (const n of [1, 2, 3, 4, 5]) seedCheckin(isoDaysAgo(n), { energy: 1 });
  const coach = feltSignalsForCoach(); // no saveFeltSignals() first
  assert.ok(coach.patterns.some((p) => p.kind === "checkin_signal"));
});

// ---------------------------------------------------------------------------
// day-read consumption: weekday pre-acknowledgement only on the matching day
// ---------------------------------------------------------------------------
test("feltSignalDayLines pre-acknowledges a weekday pattern only on its weekday", () => {
  for (const n of [7, 14, 21]) seedDayRead(daysBefore(REF, n), { override: "rough night", kind: "rest" });
  const patterns = buildFeltSignals(REF).patterns;

  const onDay = feltSignalDayLines(REF, patterns); // same weekday as the steered days
  assert.ok(onDay.some((l) => /rest/i.test(l)), "override line surfaces on its weekday");

  const otherDay = feltSignalDayLines(daysBefore(REF, 1), patterns); // a different weekday
  assert.ok(!otherDay.some((l) => /rest/i.test(l)), "override line is quiet off its weekday");
});

test("feltSignalDayLines returns nothing when there are no patterns", () => {
  assert.deepEqual(feltSignalDayLines(REF, []), []);
});

// ---------------------------------------------------------------------------
// thumbs-down suppression: a downvoted THEME stays in the dedup corpus
// ---------------------------------------------------------------------------
test("a downvoted insight stays suppressed after it ages past the recency window", () => {
  const downText = "Your ferritin ran low in spring and volume has been down since.";
  const downed = repo.addInsight({ kind: "connection", text: downText, feedback: "down" });
  assert.ok(downed, "seeded a downvoted insight");

  // Push it well past the 12-row recency window with unrelated newer insights.
  for (let i = 0; i < 15; i++) {
    repo.addInsight({ kind: "connection", text: `Unrelated observation number ${i} about something else entirely.` });
  }

  const recent = repo.recentInsightTexts(12);
  assert.ok(recent.includes(downText), "downvoted text is unioned into the dedup corpus");
  assert.equal(repo.isDuplicateInsight(downText), true, "the downvoted theme is treated as a duplicate");
  // A near-reword of the downvoted theme is also suppressed (soft dedup still applies).
  assert.equal(
    repo.isDuplicateInsight("Your ferritin ran low in spring and your volume has been down since then."),
    true
  );
  // A genuinely new connection is still allowed.
  assert.equal(repo.isDuplicateInsight("Your resting heart rate rose the week after your biggest mileage jump."), false);
});

// Suppression is TERRITORIAL as well as textual: a thumbs-down means "don't make
// this connection again", and the connection survives being reworded. The key corpus
// (src/repo/insight-intent.ts) carries downvoted KEYS past the time window exactly as
// recentInsightTexts carries downvoted TEXTS past the row window.
test("a downvoted insight's KEY stays suppressed after it ages out of the key window", () => {
  const key = "nutrition.protein~sleep.quality:same";
  const downed = repo.addInsight({
    kind: "connection",
    text: "Your protein intake and sleep quality look linked.",
    intent_key: key,
    feedback: "down",
  });
  assert.ok(downed, "seeded a downvoted, keyed insight");
  db.prepare(`UPDATE insights SET created_at = datetime('now', ?) WHERE id = ?`).run(
    `-${repo.INSIGHT_KEY_WINDOW_DAYS + 30} days`,
    downed.id
  );
  for (let i = 0; i < 15; i++) {
    repo.addInsight({ kind: "connection", text: `Unrelated observation number ${i} about something else entirely.` });
  }

  const corpus = repo.insightIntentCorpus();
  assert.ok(corpus.keys.includes(key), "the downvoted key is unioned into the corpus regardless of age");
  assert.equal(repo.isDuplicateInsightIntent(key, corpus.keys), true);
  // The same claim, globally flipped, is still that claim — however it gets worded.
  const flipped = repo.parseInsightIntentKey({
    a: { facet: "sleep.quality", direction: "down" },
    b: { facet: "nutrition.protein", direction: "down" },
  });
  assert.equal(repo.isDuplicateInsightIntent(flipped, corpus.keys), true);
  // Different territory is still free.
  assert.equal(repo.isDuplicateInsightIntent("body.weight~training.volume:opposite", corpus.keys), false);
});
