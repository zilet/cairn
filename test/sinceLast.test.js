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
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

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
  assert.equal(c.kicker, "SINCE YOU LAST LOOKED");
  assert.ok(c.priority > 0, "priority should be positive");
  assert.ok(typeof c.title === "string" && c.title.length > 0, "a calm title");
  // Constitution: no counter / "N days" / score language in the line.
  assert.ok(!/\bday(s)? (ago|away)\b/i.test(c.title), "no 'N days away' framing");
  assert.ok(!/\bstreak\b/i.test(c.title), "never a streak");
  assert.ok(!/\b\d+\s*\/\s*\d+\b/.test(c.title), "no numeric score");
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

test("the most notable change leads; extras fold into plain words", () => {
  repo.setAppState(KEY, sqlAgo(2 * 60 * 60 * 1000));
  // A new lab (high notability) + an insight (lower) — the lab should lead.
  seedHealthDoc("2026-06-23", [marker("ApoB", 92, { unit: "mg/dL" })], "bloodwork");
  repo.addInsight({ kind: "connection", text: "Sleep dipped the weeks you ran more.", status: "new" });

  const c = repo.sinceLastLookedCandidate();
  assert.ok(c);
  assert.ok(/bloodwork|result/i.test(c.title), "the lab leads the line");
  assert.ok(/other thing/i.test(c.title), "extras fold into plain words, not a count badge");
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
