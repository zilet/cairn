// Day-keying for logged food (src/repo/nutrition.ts). The bug this guards: intake
// used to GROUP food by the UTC date of created_at, so a meal logged at 8:30 PM ET
// (= 00:30 UTC the next day) counted toward TOMORROW. Food now carries a stamped
// LOCAL `date`, and getDayIntake keys by it. Also pins the per-entry logged_at.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { runWithTimeZone } from "../dist/tz.js";

beforeEach(() => resetTables("food_notes", "chat_turns", "plan_proposals"));

test("getDayIntake keys food by the stamped LOCAL day, not the UTC date of created_at", () => {
  // created_at is 00:30 UTC Jun 24 (= 8:30 PM ET on Jun 23). The local day it
  // belongs to — and the day it must count toward — is Jun 23.
  db.prepare(
    `INSERT INTO food_notes (created_at, date, meal, raw_output, parsed_json, enrichment_status)
     VALUES ('2026-06-24 00:30:00', '2026-06-23', 'dinner', 'steak', ?, 'done')`,
  ).run(JSON.stringify({ summary: "Steak", kcal: 700, protein_g: 50 }));

  const localDay = repo.getDayIntake("2026-06-23");
  assert.equal(localDay.count, 1, "the evening meal counts toward its LOCAL day");
  assert.equal(localDay.totals.protein_g, 50);

  // The UTC date of created_at (the OLD, buggy key) must NOT capture it.
  const utcDay = repo.getDayIntake("2026-06-24");
  assert.equal(utcDay.count, 0, "it must NOT leak onto the next (UTC) day");
});

test("a pre-migration row with a NULL date still resolves via the created_at fallback", () => {
  // COALESCE(date, substr(created_at,1,10)) keeps legacy rows readable.
  db.prepare(
    `INSERT INTO food_notes (created_at, date, meal, raw_output, parsed_json, enrichment_status)
     VALUES ('2026-06-23 12:00:00', NULL, 'lunch', 'eggs', ?, 'done')`,
  ).run(JSON.stringify({ summary: "Eggs", kcal: 300, protein_g: 24 }));
  assert.equal(repo.getDayIntake("2026-06-23").count, 1);
});

test("addFoodNote stamps the local day and getDayIntake surfaces a logged_at label", () => {
  const today = localDateISO();
  // Empty raw → no enrichment queued (keeps the offline test self-contained).
  repo.addFoodNote("lunch", "", { summary: "Chicken bowl", kcal: 500, protein_g: 45 });
  const day = repo.getDayIntake(today);
  assert.equal(day.count, 1);
  assert.equal(day.totals.protein_g, 45);
  assert.ok(day.entries[0].logged_at, "each entry carries a local logged_at time label");
  // The stamped date column matches the queried local day.
  const row = db.prepare(`SELECT date FROM food_notes ORDER BY id DESC LIMIT 1`).get();
  assert.equal(row.date, today);
});

test("createChatTurn captures the active device timezone (so the worker can re-frame it)", () => {
  // The chat worker drains AFTER the request returns, so the device zone must be
  // captured at enqueue and re-established from the row (chatTurns.processChatTurn).
  const traveling = runWithTimeZone("Asia/Tokyo", () => repo.createChatTurn({ message: "hi from Tokyo" }));
  assert.equal(traveling.tz, "Asia/Tokyo");

  // No zone in scope (home / MCP / scheduler) → null, and the worker falls back to server-local.
  const home = repo.createChatTurn({ message: "hi from home" });
  assert.equal(home.tz, null);

  // An invalid header never persists a junk zone.
  const junk = runWithTimeZone("Not/AReal_Zone", () => repo.createChatTurn({ message: "hi" }));
  assert.equal(junk.tz, null);
});

// ── the same law, applied to `created_at` on plan_proposals ───────────────────
// Three reads compared a UTC `created_at` against a LOCAL calendar day: by slicing
// the stamp's first ten characters, or by letting SQLite's own date() do it. Both
// answer in UTC. Every evening west of Greenwich that is the wrong day — a
// proposal applied at 8:30 PM in Boston reports as tomorrow — so a "since this
// date" window silently included or excluded the whole evening.

const ET = "America/New_York";
// 00:30 UTC on Jun 24 IS 8:30 PM ET on Jun 23. The two calendars disagree, which
// is the entire point of the fixture.
const EVENING = "2026-06-24 00:30:00";
const LOCAL_DAY = "2026-06-23";
const UTC_DAY = "2026-06-24";

function appliedProposal({ agent = "coach", createdAt, changes }) {
  db.prepare(
    `INSERT INTO plan_proposals (agent, status, created_at, parsed_json, raw_output)
     VALUES (?, 'applied', ?, ?, '')`,
  ).run(agent, createdAt, JSON.stringify({ changes }));
}

test("lastAppliedRunPlanDate reports the LOCAL day an auto run plan landed on", () => {
  appliedProposal({ agent: "auto-run-plan", createdAt: EVENING, changes: [] });
  assert.equal(
    runWithTimeZone(ET, () => repo.lastAppliedRunPlanDate()),
    LOCAL_DAY,
    "an evening apply belongs to the evening's day, not to tomorrow",
  );
  assert.notEqual(runWithTimeZone(ET, () => repo.lastAppliedRunPlanDate()), UTC_DAY);
});

test("a midday apply reads identically either way — the fix only moves the boundary", () => {
  appliedProposal({ agent: "auto-run-plan", createdAt: "2026-06-23 15:00:00", changes: [] });
  assert.equal(runWithTimeZone(ET, () => repo.lastAppliedRunPlanDate()), LOCAL_DAY);
});

test("appliedProgressionDeloads counts an evening cut into its own local day", () => {
  appliedProposal({
    createdAt: EVENING,
    changes: [{ exercise: "Back Squat", target_weight: 200, progression_action: "deload" }],
  });

  // A window ENDING on the local day must contain it…
  assert.equal(
    runWithTimeZone(ET, () => repo.appliedProgressionDeloads("Back Squat", "2026-06-01", LOCAL_DAY)),
    1,
    "the cut happened on the 23rd local, so a window ending the 23rd sees it",
  );
  // …and a window that STARTS the day after must not.
  assert.equal(
    runWithTimeZone(ET, () => repo.appliedProgressionDeloads("Back Squat", UTC_DAY, "2026-06-30")),
    0,
    "and a window opening on the 24th has already missed it",
  );
});

test("appliedProgressionEscalations honors the same boundary", () => {
  appliedProposal({
    createdAt: EVENING,
    changes: [{ exercise: "Bench Press", target_weight: 150, progression_escalation: "rep_wave" }],
  });
  assert.equal(
    runWithTimeZone(ET, () => repo.appliedProgressionEscalations("Bench Press", "2026-06-01", LOCAL_DAY)),
    1,
  );
  assert.equal(
    runWithTimeZone(ET, () => repo.appliedProgressionEscalations("Bench Press", UTC_DAY, "2026-06-30")),
    0,
  );
});

test("away from the boundary nothing moved: a week-long window counts what it always did", () => {
  for (const day of ["2026-06-20 14:00:00", "2026-06-22 09:15:00", "2026-06-25 11:00:00"]) {
    appliedProposal({
      createdAt: day,
      changes: [{ exercise: "Back Squat", target_weight: 200, progression_action: "deload" }],
    });
  }
  assert.equal(
    runWithTimeZone(ET, () => repo.appliedProgressionDeloads("Back Squat", "2026-06-19", "2026-06-26")),
    3,
  );
});
