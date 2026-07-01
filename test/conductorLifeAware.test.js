// The conductor is life/soreness-aware (Wave B / B4). It must NOT lead with a training
// lever that loads an active injury or a sore joint — it demotes that lever when a clean
// alternative exists, or keeps it with an explicit caveat when nothing cleaner does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coachingFocus } from "../dist/repo/coaching-focus.js";

const legPlateau = {
  groups: [{ verdict: "stalling", label: "legs", lead_lift: "Back Squat", stalled_signal: "same load 4 sessions", vary_options: [{ name: "Front Squat" }] }],
};

test("a knee injury annotates a leg-plateau lead when nothing cleaner exists", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    groupsTrajectory: legPlateau,
    injuries: [{ title: "Knee pain", area: "knee" }],
  });
  assert.equal(out.available, true);
  assert.equal(out.lead.domain, "training", "the leg plateau still leads (no cleaner lever)");
  assert.ok(out.caveat, "but it carries an explicit life/soreness caveat");
  assert.match(out.caveat, /around/i);
  assert.match(out.caveat, /knee/i);
  assert.match(out.lead.why, /around/i, "the caveat also rides inline on the lead");
});

test("a knee injury DEMOTES the leg-plateau lead when a clean lever exists", () => {
  const out = coachingFocus({
    goalMode: "lose",
    groupsTrajectory: legPlateau,
    healthFocus: { lead: { group: "Lipids & Cardiovascular", tier: "act_now", why: "ApoB and LDL sit high", moves: { nutrition: "Emphasize oily fish and soluble fiber." } } },
    injuries: [{ title: "Knee pain", area: "knee" }],
  });
  assert.notEqual(out.lead.domain, "training", "the injured leg lever is demoted from the lead");
  assert.equal(out.lead.domain, "nutrition", "the clean act-now lipid lever leads instead");
  assert.ok(out.caveat, "the deferral of the training lever is surfaced as a caveat");
  // The demoted training lever still rides alongside (never silently dropped).
  assert.ok(out.parallel.some((p) => p.domain === "training"), "the leg lever rides in parallel with its caution");
});

test("a flagged joint (autoregulation) also caveats a matching training lead", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    groupsTrajectory: legPlateau,
    autoregulation: { joint_pain: "knee", note: "knee ached on squats" },
  });
  assert.ok(out.caveat, "sore-joint feedback caveats a lever that loads it");
  assert.match(out.caveat, /knee/i);
});

test("no injury / sore joint → no caveat (unchanged behavior)", () => {
  const out = coachingFocus({ goalMode: "maintain", groupsTrajectory: legPlateau });
  assert.equal(out.lead.domain, "training");
  assert.equal(out.caveat, null, "a clean athlete gets no caveat");
});

test("a likely-resolved injury no longer caveats the lead", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    groupsTrajectory: legPlateau,
    injuries: [{ title: "Knee pain", area: "knee", likely_resolved: true }],
  });
  assert.equal(out.caveat, null, "a healed injury stops shaping the lead");
  assert.equal(out.lead.domain, "training");
});
