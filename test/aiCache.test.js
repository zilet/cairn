// Host-side AI result cache (src/repo.ts fingerprint / getAiCache / saveAiCache).
// This is the serve-stale-then-revalidate layer that cuts latency + agent spend
// for the idempotent ops (session-suggest, insight, weekly-read). The agent never
// runs here — we exercise the fingerprint stability and the staleness boundary
// directly:
//   - fingerprint is stable + order-insensitive over equal inputs, distinct on a change
//   - a fresh save is a non-stale hit returning the exact stored body
//   - a save with a past stale_after is served (instant) but flagged stale
//   - a missing / null result is a clean miss
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

beforeEach(() => {
  try { db.prepare(`DELETE FROM ai_cache`).run(); } catch { /* table may not exist */ }
});

test("fingerprint is stable + key-order-insensitive over equal inputs", () => {
  const a = repo.fingerprint({ minutes: 45, focus: "legs", date: "2026-06-16" });
  const b = repo.fingerprint({ date: "2026-06-16", focus: "legs", minutes: 45 });
  assert.equal(a, b, "same inputs in any key order → same fingerprint");
  assert.match(a, /^[0-9a-f]{40}$/, "sha1 hex");
});

test("fingerprint changes when any input changes", () => {
  const base = repo.fingerprint({ minutes: 45, focus: "legs" });
  assert.notEqual(base, repo.fingerprint({ minutes: 60, focus: "legs" }), "different minutes → different key");
  assert.notEqual(base, repo.fingerprint({ minutes: 45, focus: "push" }), "different focus → different key");
});

test("a fresh save is a non-stale hit returning the exact body", () => {
  const key = repo.fingerprint({ q: "fresh" });
  const result = { ok: true, session: { items: [{ exercise: "Squat" }] } };
  repo.saveAiCache("session_suggest", key, { result, chosen_agent: "stub", freshForMs: 60_000 });
  const hit = repo.getAiCache("session_suggest", key);
  assert.ok(hit, "the entry is found");
  assert.equal(hit.stale, false, "well within the freshness window → not stale");
  assert.equal(hit.chosen_agent, "stub");
  assert.deepEqual(hit.result, result, "the stored body round-trips byte-for-byte");
});

test("a save past its stale_after is still served but flagged stale (revalidate)", () => {
  const key = repo.fingerprint({ q: "stale" });
  // freshForMs in the PAST → stale_after is already behind now.
  repo.saveAiCache("insight", key, { result: { ok: true, insight: { id: 1 } }, freshForMs: -1000 });
  const hit = repo.getAiCache("insight", key);
  assert.ok(hit, "a stale entry is still RETURNED (served instantly, then revalidated)");
  assert.equal(hit.stale, true, "flagged stale so the caller knows to revalidate in the background");
  assert.deepEqual(hit.result, { ok: true, insight: { id: 1 } });
});

test("a missing key is a clean miss; a kind mismatch is a miss", () => {
  const key = repo.fingerprint({ q: "miss" });
  assert.equal(repo.getAiCache("session_suggest", key), null, "never stored → null");
  repo.saveAiCache("insight", key, { result: { ok: true }, freshForMs: 60_000 });
  assert.equal(repo.getAiCache("session_suggest", key), null, "same key under a different kind → still a miss");
  assert.ok(repo.getAiCache("insight", key), "stored under its own kind → hit");
});

test("saveAiCache upserts in place (a re-save replaces the body + freshness)", () => {
  const key = repo.fingerprint({ q: "upsert" });
  repo.saveAiCache("session_suggest", key, { result: { v: 1 }, freshForMs: -1000 }); // stale
  assert.equal(repo.getAiCache("session_suggest", key).stale, true);
  repo.saveAiCache("session_suggest", key, { result: { v: 2 }, freshForMs: 60_000 }); // fresh, new body
  const hit = repo.getAiCache("session_suggest", key);
  assert.equal(hit.stale, false, "the re-save refreshed the staleness boundary");
  assert.deepEqual(hit.result, { v: 2 }, "the body was replaced, not duplicated");
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM ai_cache WHERE kind='session_suggest' AND cache_key=?`).get(key);
  assert.equal(rows.n, 1, "PRIMARY KEY(kind, cache_key) keeps it a single row");
});
