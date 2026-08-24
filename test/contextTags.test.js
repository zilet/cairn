// W3.3 context tags — the WHOOP-journal pattern, Cairn-shaped. Cheap, athlete-
// volunteered life context (travel/alcohol/rough sleep/work crunch/feeling off)
// reuses context_events with kind:'tag'; no schema change (no CHECK constraint
// exists on context_events.kind — the only gate was the app-level allowlist in
// repo/health.ts, widened here to include 'tag').
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { CONTEXT_TAG_VOCAB, isContextTagKey, contextTagLabel } from "../dist/contextTags.js";
import { projectCoachContext, PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";
import { localDateISO } from "../dist/repo/shared.js";

beforeEach(() => {
  db.prepare(`DELETE FROM context_events`).run();
});

// ── the vocabulary contract ──────────────────────────────────────────────────

test("the vocabulary is the one source of truth for valid keys", () => {
  assert.ok(CONTEXT_TAG_VOCAB.length > 0);
  for (const { key, label } of CONTEXT_TAG_VOCAB) {
    assert.ok(isContextTagKey(key));
    assert.equal(contextTagLabel(key), label);
  }
  assert.equal(isContextTagKey("not_a_real_tag"), false);
  assert.equal(contextTagLabel("not_a_real_tag"), "not_a_real_tag", "an unknown key echoes back rather than throwing");
});

// ── one-tap toggle lifecycle ─────────────────────────────────────────────────

test("toggleContextTag: tap tags today, tap again untags (archives, does not delete)", () => {
  const today = localDateISO();
  const first = repo.toggleContextTag("travel", today);
  assert.equal(first.on, true);
  assert.ok(first.row?.id);

  let tagged = repo.listContextTags(today);
  assert.deepEqual(tagged.map((t) => t.key), ["travel"]);

  const second = repo.toggleContextTag("travel", today);
  assert.equal(second.on, false);
  assert.equal(second.row, null);

  tagged = repo.listContextTags(today);
  assert.deepEqual(tagged, [], "untagged today no longer shows as tagged");

  // Archived, not deleted — the row still exists on record.
  const row = db.prepare(`SELECT archived FROM context_events WHERE kind='tag' AND title='travel'`).get();
  assert.ok(row, "the row survives the untag");
  assert.equal(Number(row.archived), 1);

  // A third tap re-tags (a fresh row rather than reviving the archived one, matching
  // add_context_event's own always-insert semantics).
  const third = repo.toggleContextTag("travel", today);
  assert.equal(third.on, true);
});

test("toggleContextTag rejects a key outside the controlled vocabulary", () => {
  assert.throws(() => repo.toggleContextTag("hangover", "2026-01-01"));
});

test("recentContextTags carries tags over the trailing window with athlete-facing labels", () => {
  const today = localDateISO();
  repo.toggleContextTag("alcohol", today);
  const recent = repo.recentContextTags(30);
  assert.ok(recent.some((t) => t.key === "alcohol" && t.label === "drinks"));
});

// ── chat action: log_context_tag ─────────────────────────────────────────────

test("normalizeChatAction: log_context_tag drops keys outside the vocabulary and empty tag lists", () => {
  const kept = normalizeChatAction({ type: "log_context_tag", tags: ["travel", "made_up_tag", "alcohol"] });
  assert.deepEqual(kept.tags, ["travel", "alcohol"]);

  const allBad = normalizeChatAction({ type: "log_context_tag", tags: ["made_up_tag"] });
  assert.equal(allBad, null);

  const empty = normalizeChatAction({ type: "log_context_tag", tags: [] });
  assert.equal(empty, null);
});

test("a log_context_tag chat action lands a tag row through the offline apply path (stub-agent shaped, no live agent)", () => {
  const today = localDateISO();
  const { applied } = applyChatActions(
    { actions: [{ type: "log_context_tag", tags: ["travel", "work_crunch"] }] },
    { agent: "stub", message: "flying out today, brutal week at work" }
  );
  const tagAction = applied.find((a) => a.type === "log_context_tag");
  assert.ok(tagAction, "the action was applied");
  assert.equal(tagAction.result.length, 2);
  assert.ok(tagAction.result.every((r) => !r.error));

  const tagged = repo.listContextTags(today).map((t) => t.key).sort();
  assert.deepEqual(tagged, ["travel", "work_crunch"]);
});

test("the chat path is an idempotent ADD, never a toggle — re-mentioning the same tag never untags it", () => {
  const today = localDateISO();
  applyChatActions({ actions: [{ type: "log_context_tag", tags: ["alcohol"] }] }, { agent: "stub", message: "drinks tonight" });
  assert.deepEqual(repo.listContextTags(today).map((t) => t.key), ["alcohol"]);

  // Re-stating it later in the same thread must not silently remove it (a toggle would).
  applyChatActions({ actions: [{ type: "log_context_tag", tags: ["alcohol"] }] }, { agent: "stub", message: "yeah, still drinks tonight" });
  assert.deepEqual(repo.listContextTags(today).map((t) => t.key), ["alcohol"], "still tagged, no duplicate row either");

  const rows = db.prepare(`SELECT COUNT(*) AS n FROM context_events WHERE kind='tag' AND title='alcohol' AND archived=0`).get();
  assert.equal(rows.n, 1, "no duplicate row from the re-mention");
});

// ── insight prompt projection ────────────────────────────────────────────────

test("recent_context_tags reaches the insight prompt site's allowlist", () => {
  assert.ok(
    PROMPT_CONTEXT_SITES.insight.keys.includes("recent_context_tags"),
    "the insight site must carry recent_context_tags for the co-occurrence search"
  );
});

test("projectCoachContext carries recent_context_tags through to the insight site untouched", () => {
  const ctx = { recent_context_tags: [{ date: "2026-01-01", key: "travel", label: "travel" }] };
  const projected = projectCoachContext(ctx, "insight");
  assert.deepEqual(projected.recent_context_tags, ctx.recent_context_tags);
});

// ── confounder machinery ─────────────────────────────────────────────────────
// (extended coverage of the SAME regression brainEvaluationConfounders.test.js
// pins — kept here too so this file is a complete read of the W3.3 surface area.)

test("getCoachContext's recent_context_tags is null on a quiet history and populated after a tap", () => {
  const before = repo.getCoachContext();
  assert.equal(before.recent_context_tags, null);

  repo.toggleContextTag("poor_sleep_env", localDateISO());
  const after = repo.getCoachContext();
  assert.ok(Array.isArray(after.recent_context_tags));
  assert.ok(after.recent_context_tags.some((t) => t.key === "poor_sleep_env"));
});
