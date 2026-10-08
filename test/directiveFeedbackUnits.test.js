// A directive's trigger snapshot reaches the coach WITH its unit, in the athlete's lab-unit
// system — never as a bare canonical number printed beside SI prose — and only when its unit
// is certain (an Lp(a) mass reading, or a number Cairn cannot place, rides without one).
// Synthetic values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, isoDaysAgo, marker, repo, seedHealthDoc } from "./_seed.js";
import { renderConnectedBrain } from "../dist/prompt/shared.js";

const date = isoDaysAgo(30);

function resolveAll(re) {
  for (const row of db.prepare(`SELECT id, marker FROM health_directives WHERE status = 'active'`).all()) {
    if (re.test(String(row.marker))) repo.updateDirective(row.id, { status: "resolved" });
  }
}

const feedbackLines = () =>
  renderConnectedBrain({ directive_feedback: repo.directiveFeedbackForCoach() }, {})
    .split("\n")
    .filter((l) => l.includes("marker snapshot"));

test("the feedback snapshot carries its value and unit in the athlete's system", () => {
  seedHealthDoc(date, [marker("LDL Cholesterol", 160, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  resolveAll(/ldl/i);
  const fb = repo.directiveFeedbackForCoach().filter((d) => /ldl/i.test(String(d.marker)));
  assert.ok(fb.length, "a resolved LDL directive is in the feedback memory");
  assert.equal(fb[0].trigger_value, undefined, "no bare number");
  assert.equal(fb[0].trigger_reading, "160 mg/dL");
  assert.ok(feedbackLines().some((l) => /\(marker snapshot: high 160 mg\/dL /.test(l)));

  repo.setSettings({ lab_units: "si" });
  assert.equal(repo.directiveFeedbackForCoach().find((d) => /ldl/i.test(String(d.marker))).trigger_reading, "4.14 mmol/L");
  const lines = feedbackLines();
  assert.ok(lines.some((l) => /\(marker snapshot: high 4\.14 mmol\/L /.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /snapshot: high 160\b/.test(l)), "never the canonical number after SI text");
});

test("active directives reach the coach with the same snapshot", () => {
  seedHealthDoc(date, [marker("LDL Cholesterol", 160, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  repo.setSettings({ lab_units: "si" });
  const ldl = repo.directivesForCoach().filter((d) => /ldl/i.test(String(d.marker)));
  assert.ok(ldl.length);
  for (const d of ldl) {
    assert.equal(d.trigger_value, undefined);
    assert.equal(d.trigger_reading, "4.14 mmol/L");
  }
});

test("a snapshot whose unit is not certain rides without a number", () => {
  // Lp(a) printed as mass: kept as reported, never placed on the nmol/L scale.
  seedHealthDoc(date, [marker("Lp(a)", 90, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  repo.addDirective({ source: "markers", domain: "watch", marker: "Lp(a)", directive: "Lp(a) note.", trigger_value: 90, trigger_side: "high", trigger_date: date });
  resolveAll(/lp\(a\)/i);
  const fb = repo.directiveFeedbackForCoach().filter((d) => /lp\(a\)|lipoprotein/i.test(String(d.marker)));
  assert.ok(fb.length);
  for (const d of fb) assert.equal(d.trigger_reading, null);
  assert.ok(!feedbackLines().some((l) => /nmol\/L|\b90\b/.test(l)));
});
