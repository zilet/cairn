// extractJson (src/agents.ts) pulls the JSON proposal out of an agent CLI's
// stdout. It is the trust boundary between a noisy subprocess and the apply loop,
// so the load-bearing guarantee is: return the right object, or null — NEVER wrong
// data. These cases pin both the salvage paths and the safe-null fallbacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../dist/agents.js";

test("extracts a fenced ```json block", () => {
  const out = "Here is the plan:\n```json\n{\"a\":1,\"b\":2}\n```\nthanks!";
  assert.deepEqual(extractJson(out), { a: 1, b: 2 });
});

test("extracts a fenced block without the json language tag", () => {
  const out = "```\n{\"ok\":true}\n```";
  assert.deepEqual(extractJson(out), { ok: true });
});

test("extracts a plain {...} object with no fence", () => {
  assert.deepEqual(extractJson('{"x": 10}'), { x: 10 });
});

test("handles braces INSIDE string values", () => {
  const r = extractJson('{"note":"use {curly} braces here","n":3}');
  assert.deepEqual(r, { note: "use {curly} braces here", n: 3 });
});

test("handles escaped quotes inside strings", () => {
  const r = extractJson('{"q":"she said \\"hi\\"","ok":true}');
  assert.deepEqual(r, { q: 'she said "hi"', ok: true });
});

test("handles nested objects and arrays", () => {
  const r = extractJson('{"a":{"b":{"c":1}},"d":[1,2,3]}');
  assert.deepEqual(r, { a: { b: { c: 1 } }, d: [1, 2, 3] });
});

test("ignores trailing prose after the object", () => {
  const r = extractJson('{"r":"ok"} -- and here is some commentary after.');
  assert.deepEqual(r, { r: "ok" });
});

test("ignores leading prose before the object", () => {
  const r = extractJson('Sure! Here you go: {"reply":"hi","actions":[]}');
  assert.deepEqual(r, { reply: "hi", actions: [] });
});

test("prefers a valid fenced block even when stray braces surround it", () => {
  const out = "prefix } ```json\n{\"v\":5}\n``` suffix {";
  assert.deepEqual(extractJson(out), { v: 5 });
});

test("returns null on truncated/unterminated output (never wrong data)", () => {
  assert.equal(extractJson('{"a":1,"b":'), null);
  assert.equal(extractJson('{"a":"hello'), null);
});

test("returns null when there is no JSON object at all", () => {
  assert.equal(extractJson("just some words, no object at all"), null);
  assert.equal(extractJson(""), null);
});

test("recovers the leading valid object even when stray prose/braces trail it", () => {
  // v30's hardened extractJson does a balanced-brace scan, so it returns the FIRST
  // complete top-level object and ignores trailing prose + stray braces (the old
  // naive first..last span failed here). Recover the value, never garbage.
  assert.deepEqual(extractJson('{"a":{"b":1}} note: end }'), { a: { b: 1 } });
});

test("a fully valid object always round-trips to the same value", () => {
  const obj = { changes: [{ exercise: "Squat", target_weight: 225 }], summary: "ok" };
  assert.deepEqual(extractJson(JSON.stringify(obj)), obj);
});
