// The incremental reader for a streamed JSON array (src/streamedJsonArray.ts): the
// welcome's first week shows each `days[i]` the moment its closing brace arrives. It
// must never be fooled by a brace or quote inside a string, an escaped quote, a chunk
// boundary anywhere (mid-key, mid-escape, mid-number), narration or a fence around the
// JSON, or a same-named key nested deeper — and a malformed element is skipped, never
// thrown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamedArrayReader } from "../dist/streamedJsonArray.js";

const WEEK = {
  summary: 'A week with "quotes", {braces} and [brackets] in prose.',
  meta: { days: [{ name: "not this one" }] },
  days: [
    { day_number: 1, name: "Lower {A}", items: [{ exercise: "Back Squat", note: 'say "brace" }' }] },
    { day_number: 2, name: "Upper \\ back\\\\slash", items: [{ exercise: "Bench", note: "tab\there [x]" }] },
    { day_number: 3, name: "Full ✓ body", items: [] },
  ],
  tail: { more: "}" },
};

function feed(reader, text, size) {
  const seen = [];
  for (let i = 0; i < text.length; i += size) {
    for (const item of reader.push(text.slice(i, i + size))) seen.push(item);
  }
  return seen;
}

test("each element arrives exactly once, whatever the chunk size", () => {
  const text = JSON.stringify(WEEK, null, 2);
  for (const size of [1, 2, 3, 7, 13, 64, text.length]) {
    const reader = createStreamedArrayReader("days");
    const seen = feed(reader, text, size);
    assert.deepEqual(seen, WEEK.days, `chunk size ${size}`);
    assert.deepEqual(reader.items, WEEK.days);
  }
});

test("an element is handed over the moment its closing brace lands, not before", () => {
  const text = JSON.stringify(WEEK);
  const reader = createStreamedArrayReader("days");
  const firstEnd = text.indexOf("}]}", text.indexOf('"Lower')) + 3; // items array, then the day object
  assert.deepEqual(reader.push(text.slice(0, firstEnd - 1)), [], "one brace short is not a day");
  assert.deepEqual(reader.push(text.slice(firstEnd - 1, firstEnd)), [WEEK.days[0]]);
});

test("narration, a fence, and a stray brace before the reply never anchor the walk", () => {
  const text = `Sure — here is {the plan} you asked for. "Quoted" aside.\n\`\`\`json\n${JSON.stringify(WEEK)}\n\`\`\`\nDone.`;
  const reader = createStreamedArrayReader("days");
  assert.deepEqual(feed(reader, text, 5), WEEK.days);
});

test("a malformed element is skipped and the rest still arrive; nothing throws", () => {
  const text = '{"days":[{"day_number":1,"name":"A"},{"day_number":2,"name":"B",},{"day_number":3,"name":"C"}]}';
  const reader = createStreamedArrayReader("days");
  assert.deepEqual(
    feed(reader, text, 4).map((d) => d.name),
    ["A", "C"]
  );
});

test("an unterminated stream yields what completed; the array closing ends the read", () => {
  const reader = createStreamedArrayReader("days");
  assert.deepEqual(
    reader.push('{"days":[{"name":"A"},{"name":"B"').map((d) => d.name),
    ["A"]
  );
  const done = createStreamedArrayReader("days");
  done.push('{"days":[{"name":"A"}],"later":[{"name":"x"}]}');
  assert.deepEqual(done.push('{"days":[{"name":"again"}]}'), [], "read once");
  assert.equal(done.items.length, 1);
});

test("the item cap bounds what is kept", () => {
  const days = Array.from({ length: 20 }, (_, i) => ({ day_number: i + 1, name: `D${i + 1}` }));
  const reader = createStreamedArrayReader("days", { maxItems: 7 });
  feed(reader, JSON.stringify({ days }), 9);
  assert.equal(reader.items.length, 7);
});
