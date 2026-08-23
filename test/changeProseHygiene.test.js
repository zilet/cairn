// The brain's change prose reaches the athlete verbatim, so the two ways it used to
// arrive broken are guarded here:
//   1. cleanText (src/brain/contract-utils.ts) clamped with a bare .slice(), cutting
//      mid-word ("…rotates to a fresh") and running the fragment into whatever the
//      surface printed next.
//   2. normalizeHistoricalReason (src/repo/proposal-truth.ts) rewrote the possessive
//      "today's Pull" with the adverbial replacement, producing "on August 19, 2026
//      Pull" — not a sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanIdentifier, cleanText, truncateAtWord } from "../dist/brain/contract-utils.js";
import { normalizeHistoricalReason } from "../dist/repo/proposal-truth.js";

test("truncateAtWord cuts at a word boundary and marks the cut", () => {
  assert.equal(truncateAtWord("short enough", 40), "short enough");
  // Exactly at the limit is not a truncation.
  assert.equal(truncateAtWord("abcde", 5), "abcde");

  const cut = truncateAtWord("the accessory rotates to a fresh variation", 22);
  assert.ok(cut.endsWith("…"), `expected an ellipsis, got ${JSON.stringify(cut)}`);
  assert.ok(cut.length <= 22, `expected <= 22 chars, got ${cut.length}`);
  // No half-word survives the cut.
  assert.equal(cut, "the accessory rotates…");

  // Trailing punctuation is absorbed rather than left dangling before the ellipsis.
  assert.equal(truncateAtWord("held the load, then eased", 16), "held the load…");

  // A single unbroken token has no boundary worth honouring — keep the hard cut.
  assert.equal(truncateAtWord("supercalifragilistic", 10), "supercali…");

  // Cutting back to the boundary can strip everything before it: the first "word" is
  // punctuation alone. A bare "…" says nothing, so the hard clip is the floor.
  assert.equal(truncateAtWord("....... hi there", 10), "....... h…");
  assert.notEqual(truncateAtWord("....... hi there", 10), "…");
  assert.equal(truncateAtWord("..........", 5), "....…");
  // Ordinary leading punctuation still cuts at the boundary.
  assert.equal(truncateAtWord("\"held the load\" then eased", 18), '"held the load"…');
});

// Not everything the contracts clamp is prose. An evaluator version and a conference
// row key are MATCHED, not read — an appended "…" would become part of the value.
test("cleanIdentifier clips hard and never appends an ellipsis", () => {
  assert.equal(cleanIdentifier("adherence_v3_long_suffix", 12), "adherence_v3");
  assert.ok(!cleanIdentifier("adherence_v3_long_suffix", 12).includes("…"));
  assert.equal(cleanIdentifier("  spaced   version  ", 40), "spaced version");
  assert.equal(cleanIdentifier(7, 40), null);
  assert.equal(cleanIdentifier("   ", 40), null);
});

test("cleanText clamps to whole words while keeping its max length", () => {
  const text = "Rotating the accessory to a fresh variation so the pattern keeps moving.";
  const clamped = cleanText(text, 30);
  assert.ok(clamped.length <= 30);
  assert.ok(clamped.endsWith("…"));
  assert.equal(clamped, "Rotating the accessory to a…");

  // Whitespace still collapses, non-strings are still rejected, short text untouched.
  assert.equal(cleanText("  keeps   its    words  ", 200), "keeps its words");
  assert.equal(cleanText(42, 200), null);
  assert.equal(cleanText("   ", 200), null);
});

test("historical reasons keep possessives grammatical when dated", () => {
  const provenance = {
    reason_code: "recovery_hold",
    evidence_date: "2026-08-18",
    as_of_date: "2026-08-19",
  };

  const possessive = normalizeHistoricalReason("Rotates into today's Pull block.", provenance);
  assert.equal(possessive, "Rotates into the August 19, 2026 Pull block.");
  assert.ok(!possessive.includes("on August 19, 2026 Pull"));

  assert.equal(
    normalizeHistoricalReason("Following yesterday's soreness report.", provenance),
    "Following the August 18, 2026 soreness report.",
  );

  // "the today's X" collapses rather than doubling the article.
  assert.equal(
    normalizeHistoricalReason("Held for the today's session.", provenance),
    "Held for the August 19, 2026 session.",
  );

  // The plain adverbial forms are unchanged.
  assert.equal(
    normalizeHistoricalReason("Eased today after training yesterday.", provenance),
    "Eased on August 19, 2026 after training on August 18, 2026.",
  );
});

// The rewrite drops in mid-sentence text, so a possessive that OPENED the sentence
// lost its capital: "Today's Pull stays." became "the August 19, 2026 Pull stays."
test("a possessive that opens a sentence keeps its capital when dated", () => {
  const provenance = {
    reason_code: "recovery_hold",
    evidence_date: "2026-08-18",
    as_of_date: "2026-08-19",
  };

  assert.equal(
    normalizeHistoricalReason("Today's Pull stays.", provenance),
    "The August 19, 2026 Pull stays.",
  );
  assert.equal(
    normalizeHistoricalReason("Yesterday's soreness held it.", provenance),
    "The August 18, 2026 soreness held it.",
  );
  // Sentence-internal and later sentences each get the case they deserve.
  assert.equal(
    normalizeHistoricalReason("Held it. Today's Pull stays.", provenance),
    "Held it. The August 19, 2026 Pull stays.",
  );
  assert.equal(
    normalizeHistoricalReason("Rotates into today's Pull block.", provenance),
    "Rotates into the August 19, 2026 Pull block.",
  );

  // The plain (non-possessive) adverbial form has the same defect when it opens
  // the sentence: "Yesterday you held it." must not lose its capital.
  assert.equal(
    normalizeHistoricalReason("Yesterday you held it.", provenance),
    "On August 18, 2026 you held it.",
  );
});
