import { test } from "node:test";
import assert from "node:assert/strict";
import { joinList } from "../dist/repo/shared.js";

// joinList() is the one Oxford-comma list-joiner behind what used to be several
// independently reimplemented "join with 'and'" helpers (risk.ts, plan-selection.ts,
// team-week.ts, symptom-links.ts, support-work.ts, signal-state.ts), most of which
// silently dropped the comma before "and" on 3+ items ("a, b and c" instead of
// "a, b, and c"). This covers the shape every caller relies on.

test("joinList: empty and single-item lists pass through", () => {
  assert.equal(joinList([]), "");
  assert.equal(joinList(["a"]), "a");
});

test("joinList: two items join with a plain 'and', no comma", () => {
  assert.equal(joinList(["a", "b"]), "a and b");
});

test("joinList: three or more items use an Oxford comma before 'and'", () => {
  assert.equal(joinList(["a", "b", "c"]), "a, b, and c");
  assert.equal(joinList(["a", "b", "c", "d"]), "a, b, c, and d");
});

test("joinList: works on real athlete-facing phrases, not just single letters", () => {
  assert.equal(joinList(["left knee"]), "left knee");
  assert.equal(joinList(["left knee", "right shoulder"]), "left knee and right shoulder");
  assert.equal(joinList(["left knee", "right shoulder", "lower back"]), "left knee, right shoulder, and lower back");
});
