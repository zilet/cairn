// "Since you last looked" — honest continuity, NOT a streak (src/repo/since-last.ts).
// One calm plain-language line summarizing the single most notable thing that
// genuinely changed since the last Today open. Invariants:
//   - no prior stamp (first-ever open) → null (silent — never summarizes everything)
//   - a genuine change after the stamp (a new lab / a resolved finding / an applied
//     plan draft / a new insight / a PR) → a non-null candidate with a calm title +
//     priority > 0, kicker "SINCE YOU LAST LOOKED", kind 'continuity', tier 'primary'
//   - nothing changed since the stamp → null
//   - markTodaySeen() is DEBOUNCED: two advances inside the window don't move it twice
//   - the produced candidate is NEVER a counter / "N days away" / score (constitution)
// Producers are imported via the repo barrel (integrator wires the export).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

const KEY = "today_last_seen_at";

// A SQLite-format UTC timestamp `msAgo` milliseconds in the past.
function sqlAgo(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
}

beforeEach(() => {
  resetTables("health_documents", "health_directives", "insights", "plan_proposals", "sessions", "logged_sets", "app_state");
});

test("no prior stamp → silent (null) on the first-ever open", () => {
  // Even with a change present, with no last-seen stamp we never summarize.
  seedHealthDoc("2026-06-20", [marker("ApoB", 95, { unit: "mg/dL" })]);
  assert.equal(repo.sinceLastLookedCandidate(), null);
});

test("nothing changed since the stamp → null", () => {
  // A doc that landed BEFORE the stamp must not be re-surfaced. We seed the doc,
  // then set the stamp to AFTER it so the window is genuinely empty.
  seedHealthDoc("2026-06-18", [marker("LDL", 120, { unit: "mg/dL" })]);
  repo.setAppState(KEY, sqlAgo(0)); // stamp = now (after the just-seeded doc)
  assert.equal(repo.sinceLastLookedCandidate(), null);
});

test("a new lab since the stamp → a calm continuity candidate", () => {
  // Stamp two hours ago, then a fresh doc (created_at = now) lands in the window.
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  seedHealthDoc("2026-06-23", [marker("ApoB", 88, { unit: "mg/dL" })], "bloodwork");

  const c = repo.sinceLastLookedCandidate();
  assert.ok(c, "expected a candidate when a new lab landed in the window");
  assert.equal(c.id, "since-last");
  assert.equal(c.kind, "continuity");
  assert.equal(c.tier, "primary");
  // A 2h-old stamp is usually the same local day; a run just after midnight
  // legitimately reads "yesterday" — both are honest.
  assert.match(String(c.kicker), /^SINCE (YOU LAST LOOKED|YESTERDAY)$/);
  assert.ok(c.priority > 0, "priority should be positive");
  assert.ok(typeof c.title === "string" && c.title.length > 0, "a calm title");
  // Constitution: no counter / "N days" / score language in the line.
  assert.ok(!/\bday(s)? (ago|away)\b/i.test(c.title), "no 'N days away' framing");
  assert.ok(!/\bstreak\b/i.test(c.title), "never a streak");
  assert.ok(!/\b\d+\s*\/\s*\d+\b/.test(c.title), "no numeric score");
});

test("a new Garmin ECG since the stamp gets a specific continuity label", () => {
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  seedHealthDoc("2026-06-23", [marker("Sinus Rhythm", "normal", { flag: "normal" })], "ecg");

  const c = repo.sinceLastLookedCandidate();
  assert.ok(c, "expected a candidate when a Garmin ECG landed in the window");
  assert.match(c.title, /Garmin ECG/i);
});

test("a resolved directive since the stamp → continuity candidate", () => {
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  const dir = repo.addDirective({ source: "markers", domain: "nutrition", marker: "LDL-C", directive: "Lean toward oats." });
  repo.updateDirective(dir.id, { status: "resolved" }); // stamps status_at = now

  const c = repo.sinceLastLookedCandidate();
  assert.ok(c, "a resolved finding should surface");
  assert.ok(/finding|ldl/i.test(c.title), "the line names the finding it closed");
  assert.ok(c.priority > 0);
});

test("a strength PR since the stamp → continuity candidate", () => {
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  // Prior baseline + a clear all-time best, both logged now (created_at > stamp).
  repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5 });
  repo.logSetByName({ exercise: "Bench Press", weight: 225, reps: 5 }); // new est-1RM best

  const c = repo.sinceLastLookedCandidate();
  assert.ok(c, "a new best should surface");
  assert.ok(/best|bench/i.test(c.title), "the line names the lift's new best");
});

test("the most notable change leads; the rest braid into the body by name", () => {
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  // A new lab (high notability) + a drafted-and-applied plan change (lower) —
  // the lab should lead and the plan change should be NAMED in the body
  // (connective tissue, not a count).
  seedHealthDoc("2026-06-23", [marker("ApoB", 92, { unit: "mg/dL" })], "bloodwork");
  const p = repo.createProposal("stub", "auto: weekly review", "", { changes: [] });
  db.prepare(`UPDATE plan_proposals SET status = 'applied' WHERE id = ?`).run(p.id);

  const c = repo.sinceLastLookedCandidate();
  assert.ok(c);
  assert.ok(/bloodwork|result/i.test(c.title), "the lab leads the line");
  assert.ok(!/other thing/i.test(c.title), "the title never hides substance behind a count");
  assert.ok(/plan picked up an adjustment/i.test(String(c.body)), "the braid names what else moved");
});

test("a waiting insight is NOT re-announced (its own card renders on the same rail)", () => {
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  repo.addInsight({ kind: "weekly_read", text: "Solid week — held three sessions.", status: "new" });
  repo.addInsight({ kind: "connection", text: "Sleep dipped the weeks you ran more.", status: "new" });

  // Insights alone → silent; the weekly-read / connection cards are their own
  // announcement in the same Today agenda pass.
  assert.equal(repo.sinceLastLookedCandidate(), null);
});

test("training done on a PRIOR day joins the braid; today's own session does not", () => {
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  seedHealthDoc("2026-06-23", [marker("ApoB", 92, { unit: "mg/dL" })], "bloodwork");
  // A set logged NOW but on yesterday's session date (a backfill) counts —
  // it happened while the athlete was away.
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, date: localDaysAgo(1) });

  const withPrior = repo.sinceLastLookedCandidate();
  assert.ok(withPrior);
  assert.ok(/in the books/i.test(String(withPrior.body)), "yesterday's work is acknowledged in the braid");
  assert.ok(!/\b\d+\b/.test(String(withPrior.body)), "counts render as words, never digits");

  // Today's own just-finished session must NOT be re-announced — the DONE hero
  // and Lately already tell it; the braid is about time away.
  resetTables("sessions", "logged_sets", "health_documents");
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5 });
  const todayOnly = repo.sinceLastLookedCandidate();
  assert.ok(
    !todayOnly || !/in the books/i.test(String(todayOnly.title) + String(todayOnly.body ?? "")),
    "today's session never triple-tells through the continuity line"
  );
});

test("a multi-day gap names the real day in the kicker", () => {
  // 3 full days back at the current wall-clock time is always a 2-6 day-diff
  // window regardless of when the suite runs → the kicker names a weekday.
  repo.setAppState(KEY, sqlAgo(3 * 24 * 60 * 60 * 1000));
  seedHealthDoc("2026-06-23", [marker("ApoB", 92, { unit: "mg/dL" })], "bloodwork");

  const c = repo.sinceLastLookedCandidate();
  assert.ok(c);
  assert.match(String(c.kicker), /^SINCE (MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)$/);
});

test("markTodaySeen is debounced inside the window", () => {
  // Seed a stamp 10 minutes ago (inside the ~1h debounce window).
  const tenMinAgo = sqlAgo(10 * 60 * 1000);
  repo.setAppState(KEY, tenMinAgo);
  repo.markTodaySeen();
  assert.equal(repo.getAppState(KEY), tenMinAgo, "a recent stamp is left alone (debounced)");

  // A stamp well outside the window DOES advance.
  repo.setAppState(KEY, sqlAgo(3 * 60 * 60 * 1000));
  repo.markTodaySeen();
  const advanced = repo.getAppState(KEY);
  assert.ok(advanced && Date.parse(advanced.replace(" ", "T") + "Z") > Date.parse(sqlAgo(60 * 60 * 1000).replace(" ", "T") + "Z"),
    "an old stamp advances to ~now");
});

test("markTodaySeen seeds a stamp when none exists, then a later change surfaces", () => {
  // No stamp yet → first open is silent, but markTodaySeen establishes the window.
  assert.equal(repo.getAppState(KEY), null);
  repo.markTodaySeen();
  assert.ok(repo.getAppState(KEY), "first markTodaySeen sets the stamp");

  // Rewind the just-set stamp into the past, then a change lands after it.
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  seedHealthDoc("2026-06-23", [marker("HbA1c", 5.3, { unit: "%" })], "bloodwork");
  assert.ok(repo.sinceLastLookedCandidate(), "a change after the established window surfaces");
});

test("Today agenda only advances last-seen for the device-local today", () => {
  assert.equal(repo.shouldMarkTodayAgendaSeen(undefined, "2026-06-27"), true, "no date means the live Today view");
  assert.equal(repo.shouldMarkTodayAgendaSeen("2026-06-27", "2026-06-27"), true, "today can advance the stamp");
  assert.equal(repo.shouldMarkTodayAgendaSeen("2026-06-26", "2026-06-27"), false, "past date review must not hide today's continuity line");
  assert.equal(repo.shouldMarkTodayAgendaSeen("2026-06-28", "2026-06-27"), false, "future date preview must not hide today's continuity line");
});
