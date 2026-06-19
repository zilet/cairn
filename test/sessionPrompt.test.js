// The free-text session flow — "say what you want" (e.g. "legs sore from
// yesterday's run, something easier on the legs"). buildSessionPrompt must carry
// the free text verbatim AND hand the coach a concrete SWAP MENU from the
// variation library so it trades movements instead of inventing them. The agent
// call needs a CLI (not offline), but the prompt it builds is deterministic.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { buildSessionPrompt } from "../dist/prompt.js";

beforeEach(() => {
  resetTables("logged_sets", "session_skips", "sessions", "plan_items", "plan_days", "activities");
});

test("a free-text session request is embedded and gets a variation swap menu", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Leg Curl", sets: 3, rep_low: 8, rep_high: 12 },
  ]);
  const p = buildSessionPrompt(undefined, { constraints: "legs sore from yesterday's run, something easier on the legs" });
  assert.match(p, /easier on the legs/, "the athlete's words ride verbatim into the prompt");
  assert.match(p, /SWAP MENU/, "the variation library hands over concrete swaps");
  assert.match(p, /Back Squat →/, "names a plan movement with its alternatives");
  // the leg-curl classification fix: no biceps curls offered for a hamstring lift
  const menu = p.slice(p.indexOf("SWAP MENU"));
  assert.ok(!/Leg Curl → .*(Hammer Curl|Bicep)/.test(menu), "Leg Curl gets hamstring swaps, not biceps");
});

test("no request → no swap menu (kept quiet, calm by default)", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const p = buildSessionPrompt(undefined, {});
  assert.ok(!/SWAP MENU/.test(p), "no constraint/focus → no menu");
});
