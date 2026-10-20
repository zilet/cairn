// plainInline (src/lib/plain-text.ts) reads agent markdown as words — and ONLY markdown:
// a training note is full of characters markdown also uses (signs, arithmetic,
// identifiers, a set scheme with a note), and those must reach the athlete untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainInline } from "../dist/lib/plain-text.js";

const CASES = [
  // Real coach markdown: the markup goes, the words stay.
  ["**Monday: Push A (bench and overhead press).**", "Monday: Push A (bench and overhead press)."],
  [
    "**Tuesday: your one leg day (squat, deadlift, calves).** It sits clear of the key runs.",
    "Tuesday: your one leg day (squat, deadlift, calves). It sits clear of the key runs.",
  ],
  ["- **Monday:** Push A", "Monday: Push A"],
  ["**Bold** and _em_ and `code` and [a link](https://x)", "Bold and em and code and a link"],
  ["**a** and **b**", "a and b"],
  ["__two words__ stay words", "two words stay words"],
  ["a *soft* day", "a soft day"],
  ["## Heading", "Heading"],
  ["See [the guide](https://example.com/a) and [today](/today).", "See the guide and today."],
  [
    "Week ahead:\n- Squat 3x5\n- **Friday**: long run\n> Keep it easy",
    "Week ahead:\nSquat 3x5\nFriday: long run\nKeep it easy",
  ],
  // Identifiers are not bold.
  ["__init__", "__init__"],
  ["snake__case__name", "snake__case__name"],
  ["snake_case_name", "snake_case_name"],
  // Signs are not list or quote markers.
  ["- 5 kg", "- 5 kg"],
  ["+ 2.5 kg", "+ 2.5 kg"],
  ["> 160 bpm", "> 160 bpm"],
  ["- Squat", "- Squat"],
  [
    "Load:\n- 5 kg off the bar\n+ 2.5 kg next week\n> 160 bpm is the ceiling",
    "Load:\n- 5 kg off the bar\n+ 2.5 kg next week\n> 160 bpm is the ceiling",
  ],
  // A set scheme with a note is not a link; arithmetic is not bold or italics.
  ["[3x5](heavy)", "[3x5](heavy)"],
  ["5**2 + 3**2 = 34", "5**2 + 3**2 = 34"],
  ["2 * 3 * 4", "2 * 3 * 4"],
  ["x ** 2", "x ** 2"],
];

for (const [input, expected] of CASES) {
  test(`plainInline ${JSON.stringify(input)}`, () => {
    assert.equal(plainInline(input), expected);
  });
}

test("plainInline is idempotent on its own output", () => {
  for (const [input] of CASES) assert.equal(plainInline(plainInline(input)), plainInline(input), input);
});
