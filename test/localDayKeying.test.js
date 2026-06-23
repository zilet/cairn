// Day-keying for logged food (src/repo/nutrition.ts). The bug this guards: intake
// used to GROUP food by the UTC date of created_at, so a meal logged at 8:30 PM ET
// (= 00:30 UTC the next day) counted toward TOMORROW. Food now carries a stamped
// LOCAL `date`, and getDayIntake keys by it. Also pins the per-entry logged_at.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { runWithTimeZone } from "../dist/tz.js";

beforeEach(() => resetTables("food_notes", "chat_turns"));

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
