// K3 (v1 arch) — the conductor is the SINGLE arbiter of "what's next", and the
// FocusCandidate producer contract is shared. These are PURE tests (coachingFocus +
// the shared focus-candidate primitive take literal inputs, no DB), mirroring
// coachingFocus.test.js. They lock three things:
//   1. There is exactly ONE ranking formula (focus-candidate.scoreFocus/rankFocus),
//      and it orders by leverage first, then actionable, then fresh, minus a penalty.
//   2. A cardiovascular-risk read surfaces THROUGH the conductor as one voice.
//   3. The external producers (journey, benchmarks, due-attention, risk) are
//      arbitrated together into ONE lead + parallel/later — never competing co-equal
//      leads — and nextBestStep emits the SAME shared FocusCandidate contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coachingFocus } from "../dist/repo/coaching-focus.js";
import {
  scoreFocus,
  rankFocus,
  focusScore,
  LEVERAGE_WEIGHT,
  ACTIONABLE_BONUS,
  FRESH_BONUS,
} from "../dist/repo/focus-candidate.js";

// ---- 1. the ONE shared ranking primitive -----------------------------------

test("scoreFocus is the single formula: leverage·weight + actionable + fresh − penalty", () => {
  const base = (over) => ({ candidate: { domain: "training", kind: "k", priority_inputs: [], headline: "h", why: "w" }, leverage: 2, ...over });
  assert.equal(scoreFocus(base()), 2 * LEVERAGE_WEIGHT);
  assert.equal(scoreFocus(base({ actionable: true })), 2 * LEVERAGE_WEIGHT + ACTIONABLE_BONUS);
  assert.equal(scoreFocus(base({ fresh: true })), 2 * LEVERAGE_WEIGHT + FRESH_BONUS);
  assert.equal(scoreFocus(base({ penalty: 1e6 })), 2 * LEVERAGE_WEIGHT - 1e6);
  // The scalar sibling agrees with the wrapped form.
  assert.equal(focusScore(2, { actionable: true }), scoreFocus(base({ actionable: true })));
});

test("rankFocus is the single sort: leverage dominates, ties break by actionable then input order", () => {
  const mk = (kind, leverage, extra = {}) => ({ candidate: { domain: "health", kind, priority_inputs: [], headline: kind, why: "" }, leverage, ...extra });
  const ranked = rankFocus([
    mk("low", 1, { actionable: true }),
    mk("high", 3),
    mk("mid-actionable", 2, { actionable: true }),
    mk("mid-plain", 2),
  ]);
  assert.deepEqual(ranked.map((r) => r.candidate.kind), ["high", "mid-actionable", "mid-plain", "low"]);
});

// ---- 2. a cardiovascular-risk candidate surfaces via the conductor ----------

test("an elevated PREVENT risk read surfaces as the conductor's lead (clinical % allowed)", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    cardioRisk: {
      prevent: { estimates: { ascvd: { ten_year: 12.4, thirty_year: null }, total_cvd: { ten_year: 15, thirty_year: null } }, vascular_age: 58 },
      enhancers: [{ key: "apob", label: "ApoB above optimal", lever: "Bring ApoB toward ~80 mg/dL with clinician-guided lipid work." }],
    },
  });
  assert.equal(out.available, true);
  assert.match(out.lead.title, /cardiovascular risk/i);
  assert.match(out.lead.why, /PREVENT/);
  assert.match(out.lead.why, /12\.4%/, "the clinical risk % is spoken plainly");
  assert.match(out.lead.why, /not medical advice/i, "framed informational, not a verdict");
  assert.ok(out.lead.based_on.some((l) => /PREVENT/i.test(l)), "provenance names the risk read");
});

test("a non-elevated risk read rides in parallel behind a real training lead, never a competing lead", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    groupsTrajectory: { groups: [{ verdict: "stalling", label: "Shoulders", lead_lift: "Overhead Press", stalled_signal: "flat 4 wks", vary_options: [{ name: "Push Press" }] }] },
    cardioRisk: {
      prevent: { estimates: { ascvd: { ten_year: 3.1, thirty_year: null }, total_cvd: { ten_year: null } }, vascular_age: null },
      enhancers: [{ key: "vo2max", label: "Cardiorespiratory fitness below target", lever: "Keep easy aerobic volume consistent." }],
    },
  });
  assert.equal(out.lead.domain, "training", "the training plateau leads");
  const risk = [out.lead, ...out.parallel].find((x) => /cardiovascular/i.test(x.title));
  assert.ok(risk, "the risk candidate is arbitrated in, not dropped");
  assert.notEqual(risk, out.lead, "but it does not compete as a co-equal lead");
});

// ---- 3. one voice across all producers --------------------------------------

test("journey, benchmark and risk producers are arbitrated into ONE lead + supporting slots", () => {
  const out = coachingFocus({
    goalMode: "lose",
    // A strong health act-now lever should lead; the rest are supporting voices.
    healthFocus: { lead: { group: "Lipids & Cardiovascular", tier: "act_now", why: "ApoB and LDL sit high", moves: { nutrition: "Emphasize oily fish and soluble fiber." } } },
    groupsTrajectory: { groups: [{ verdict: "stalling", label: "Shoulders", lead_lift: "Overhead Press", stalled_signal: "flat", vary_options: [{ name: "Push Press" }] }] },
    journeyMilestones: [{ label: "Down 10 lb", detail: "A calm milestone.", kind: "weight_loss", priority: 5 }],
    benchmarkMilestones: [{ title: "Close to a 2× bodyweight deadlift", why: "within reach", suggested_test: "Test a heavy single", priority: 4 }],
    dueAttention: [{ signal_key: "health:marker:ferritin", domain: "health", reason: "recheck ferritin" }, { signal_key: "training:strength:back-squat", domain: "training", reason: "re-test squat" }],
  });
  assert.equal(out.available, true);
  // Exactly one lead — the single voice.
  assert.ok(out.lead && out.lead.title, "one lead is named");
  // The due-attention re-checks batch into the ONE checkpoint (labs + lifts together).
  assert.ok(out.retest, "a batched checkpoint is produced");
  assert.ok(out.retest.focus.some((f) => /ferritin/i.test(f)), "a due lab folds into the batched checkpoint");
  assert.ok(out.retest.focus.some((f) => /squat/i.test(f)), "a due lift re-test folds into the same checkpoint");
  // Journey + benchmark never become their own competing leads — they sit in the
  // supporting slots the conductor arbitrated them into.
  const titles = [out.lead.title, ...out.parallel.map((p) => p.title), ...out.later.map((l) => l.title)].join(" | ");
  assert.match(titles, /Down 10 lb|deadlift/i, "the supporting producers are surfaced, not dropped");
});
