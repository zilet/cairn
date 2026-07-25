import { test } from "node:test";
import assert from "node:assert/strict";
import { clipText } from "../dist/repo/shared.js";

// clipText() is the one truncation primitive behind what used to be seven
// independently reimplemented "trim to N chars" helpers (attention.ts,
// coaching-focus.ts, forward-timeline.ts, learned-timeline.ts, team-week.ts,
// training-milestones.ts, today-agenda.ts). These cover every option combination
// those seven originals actually used, plus the shared edge cases.

test("clipText: null/undefined/empty/whitespace-only all clip to an empty string", () => {
  assert.equal(clipText(null, 10), "");
  assert.equal(clipText(undefined, 10), "");
  assert.equal(clipText("", 10), "");
  assert.equal(clipText("   \t\t  \n  ", 10), "");
  assert.equal(clipText("   \t\t  \n  ", 10, { collapseWhitespace: true }), "");
});

test("clipText: a string already within the budget passes through untouched", () => {
  assert.equal(clipText("short", 20), "short");
  // Exactly AT the limit is not truncated (length > max is the trigger, not >=).
  assert.equal(clipText("a".repeat(10), 10), "a".repeat(10));
});

test("clipText: one char over the limit truncates; one char under does not", () => {
  const s = "a".repeat(11);
  assert.equal(clipText(s, 10).length <= 10 || clipText(s, 10).endsWith("…"), true);
  assert.notEqual(clipText(s, 10), s);
  assert.equal(clipText("a".repeat(9), 10), "a".repeat(9));
});

test("clipText: default options (no collapse, naive slice, … ellipsis)", () => {
  const out = clipText("hello world foobar", 10);
  // Naive (non-word-boundary) truncation: matches every original's default
  // behavior of slicing at max-1 and trimming ONLY the trailing whitespace the
  // cut happens to expose — it does NOT walk back to a word boundary, so it can
  // (and here does) cut mid-word. This is a deliberately preserved latent quirk
  // from the seven originals, not a bug introduced here — see clip-diff-harness.
  assert.equal(out, "hello wor…");
});

test("clipText: ellipsis option selects the marker (\"...\", \"…\", or none)", () => {
  const long = "abcdefghijklmnopqrstuvwxyz";
  assert.ok(clipText(long, 10, { ellipsis: "..." }).endsWith("..."));
  assert.ok(clipText(long, 10, { ellipsis: "…" }).endsWith("…"));
  // Empty ellipsis = a silent hard cut, no marker, no reserved char, no trimEnd
  // (learned-timeline.ts's original behavior).
  const hardCut = clipText(long, 10, { ellipsis: "" });
  assert.equal(hardCut, long.slice(0, 10));
  assert.equal(hardCut.length, 10);
});

test("clipText: collapseWhitespace folds runs of whitespace (incl. newlines) to one space first", () => {
  const messy = "line one\n\nline   two\tline three";
  assert.equal(clipText(messy, 500, { collapseWhitespace: true }), "line one line two line three");
  // Without it, only the ends are trimmed — internal whitespace runs survive.
  assert.equal(clipText(messy, 500), messy);
});

test("clipText: naive (wordBoundary: false) cuts mid-word when the budget lands there", () => {
  const s = "supercalifragilisticexpialidocious and more text after that";
  const out = clipText(s, 15, { ellipsis: "…" });
  assert.equal(out, `${s.slice(0, 14)}…`);
  assert.ok(!out.includes(" "), "the cut landed inside the first long word, no space survives");
});

test("clipText: wordBoundary walks back to the last space instead of cutting mid-word", () => {
  const s = "the quick brown fox jumps over the lazy dog and keeps going for a while longer";
  const out = clipText(s, 20, { wordBoundary: true, ellipsis: "…" });
  assert.ok(out.length <= 21);
  // The ellipsis hangs directly off the last word — no stranded space before it, which
  // is what a naive `slice(0, lastSpace + 1)` would leave.
  assert.doesNotMatch(out, /\s…$/, "no trailing space before the ellipsis");
  // The clip is a clean prefix of the original up to a word boundary.
  const base = out.slice(0, -1);
  assert.ok(s.startsWith(base));
  const nextChar = s[base.length];
  assert.ok(nextChar === undefined || nextChar === " ", "cuts exactly at a word boundary");
});

test("clipText: wordBoundary with no space in the window falls back to a full-window hard cut", () => {
  const longToken = "y".repeat(50);
  const out = clipText(longToken, 20, { wordBoundary: true, ellipsis: "…" });
  assert.equal(out, `${"y".repeat(20)}…`);
});

test("clipText: sentenceBoundary prefers a sentence end at least halfway into the budget", () => {
  const text = "This is a longer opening sentence here. And then more text that runs past the budget.";
  const out = clipText(text, 60, { wordBoundary: true, sentenceBoundary: true, ellipsis: "…" });
  assert.equal(out, "This is a longer opening sentence here.");
  assert.ok(!out.endsWith("…"), "a sentence-boundary cut is a complete thought, no ellipsis");
});

test("clipText: a sentence end too early in the budget does NOT qualify", () => {
  // The other half of the halfway rule, and the case that makes it worth having: a
  // three-word opener would otherwise throw away most of the budget. Here ". " sits at
  // index 12 with a budget of 40, so it loses and the word boundary wins — which is
  // what team-week.ts did before this helper existed.
  const text =
    "Short opener. This is a second sentence that runs on for a good while to push well past the budget for this test.";
  const out = clipText(text, 40, { wordBoundary: true, sentenceBoundary: true, ellipsis: "…" });
  assert.equal(out, "Short opener. This is a second sentence…");
});

test("clipText: sentenceBoundary falls back to the word boundary when no sentence end qualifies", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const withSentence = clipText(text, 30, { wordBoundary: true, sentenceBoundary: true, ellipsis: "…" });
  const wordOnly = clipText(text, 30, { wordBoundary: true, sentenceBoundary: false, ellipsis: "…" });
  assert.equal(withSentence, wordOnly, "no sentence boundary in range, so both land on the same word cut");
  assert.ok(withSentence.endsWith("…"));
});

test("clipText: sentenceBoundary is opt-in — plain wordBoundary never adopts it silently", () => {
  const text = "Ends right here. But then a lot more filler text keeps going long past the budget for this case.";
  const wordOnly = clipText(text, 25, { wordBoundary: true, ellipsis: "…" });
  const withSentence = clipText(text, 25, { wordBoundary: true, sentenceBoundary: true, ellipsis: "…" });
  // With sentenceBoundary off, the sentence-end shortcut never fires even though
  // "Ends right here." would qualify — proving the flag actually gates it.
  assert.notEqual(wordOnly, "Ends right here.");
  assert.equal(withSentence, "Ends right here.");
});

test("clipText: team-week.ts's exact combination (collapse + … + wordBoundary + sentenceBoundary)", () => {
  const long = `Shift the plan to a longer accumulation block with ${"cadence ".repeat(20)}work`;
  const out = clipText(long, 150, {
    collapseWhitespace: true,
    ellipsis: "…",
    wordBoundary: true,
    sentenceBoundary: true,
  });
  assert.ok(out.length <= 151);
  assert.ok(out.endsWith("…"));
  const base = out.slice(0, -1).trim();
  const collapsed = long.replace(/\s+/g, " ").trim();
  assert.ok(collapsed.startsWith(base), "the clip is a prefix of the collapsed original");
  assert.ok(
    collapsed.length === base.length || collapsed[base.length] === " ",
    "the clip ends on a whole word"
  );
});

test("clipText: a limit landing exactly on a space never leaves a trailing space before the ellipsis", () => {
  const s = `${"w".repeat(19)} tail-content-that-continues-on-for-a-while`;
  const out = clipText(s, 20, { wordBoundary: true, ellipsis: "…" });
  assert.ok(!out.includes("  "));
  assert.ok(!out.startsWith(" ", out.length - 2));
});

test("clipText: text that already contains an ellipsis character is handled like any other text", () => {
  const s = "The result was inconclusive… so the team re-tested the whole panel next week after another cycle.";
  const naive = clipText(s, 30, { ellipsis: "…" });
  assert.ok(naive.endsWith("…"));
  const bounded = clipText(s, 30, { wordBoundary: true, sentenceBoundary: true, ellipsis: "…" });
  assert.ok(bounded.length <= 31);
});

test("clipText: embedded newlines survive without collapseWhitespace, fold to spaces with it", () => {
  const s = "Line one.\nLine two.\nLine three.";
  assert.ok(clipText(s, 500).includes("\n"));
  assert.ok(!clipText(s, 500, { collapseWhitespace: true }).includes("\n"));
});
