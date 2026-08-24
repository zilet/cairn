// The HEALING CHECK block in renderActiveContext (src/prompt/shared.ts) tells the
// coach model how to bring up a past-window injury that hasn't been explicitly
// resolved. Round W2.2: the check now reads its own `likely_resolved` computation
// instead of always posing an open question — when the injury already reads as
// healed, the prompt instructs the model to STATE that inference (a rotating,
// plain-language phrase) and invite correction, rather than asking blind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderActiveContext } from "../dist/prompt/shared.js";

function ctxWith(candidate, today = "2026-08-24") {
  return {
    today,
    context_today: {
      resolve_candidates: [candidate],
    },
  };
}

test("likely_resolved: false/unknown keeps the original open ask, unchanged", () => {
  const out = renderActiveContext(ctxWith({ title: "left knee tweak", likely_resolved: false }));
  assert.match(out, /HEALING CHECK/);
  assert.match(out, /gently confirm whether it's still bothering them/, "the open-question instruction stands");
  assert.doesNotMatch(out, /STATE that plainly/, "no inference-statement instruction when unresolved");
  assert.match(out, /"left knee tweak"/);
});

test("likely_resolved: true states the inference and invites correction instead of asking", () => {
  const out = renderActiveContext(ctxWith({ title: "left knee tweak", likely_resolved: true }));
  assert.match(out, /HEALING CHECK/);
  assert.match(out, /reads as healed from the training since/);
  assert.match(out, /STATE that plainly instead of asking an open question/);
  assert.doesNotMatch(out, /gently confirm whether it's still bothering them/, "no open question once resolved");
});

test("the invite phrasing is a rotating variant set, not one fixed literal", () => {
  const seen = new Set();
  for (let day = 1; day <= 20; day++) {
    const date = `2026-0${day <= 9 ? "1" : "2"}-${String(((day - 1) % 28) + 1).padStart(2, "0")}`;
    const out = renderActiveContext(ctxWith({ title: "left knee tweak", likely_resolved: true }, date));
    const match = out.match(/something like "([^"]+)"/);
    assert.ok(match, "the instruction embeds a suggested phrase");
    seen.add(match[1]);
  }
  assert.ok(seen.size > 1, "more than one literal phrase appears across days — a real variant set");
});

test("no HEALING CHECK block when there is nothing to resolve", () => {
  const out = renderActiveContext({ today: "2026-08-24", context_today: { resolve_candidates: [] } });
  assert.doesNotMatch(out, /HEALING CHECK/);
});

test("no candidate list at all (context_today absent) renders nothing, never throws", () => {
  assert.equal(renderActiveContext({}), "");
  assert.equal(renderActiveContext({ today: "2026-08-24" }), "");
});
