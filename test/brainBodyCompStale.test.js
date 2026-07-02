// Body-composition recency decay (src/repo/propagation.ts bodyCompStaleness).
// Grounded: a month-old DEXA still drove live Body-fat directives despite the athlete
// losing weight across weeks of logged training. A body-comp directive off a scan
// that's > ~3 weeks old AND while bodyweight has since moved must NOT assert the stale
// scan as current — it decays to a "worth a fresh scan to confirm" framing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, seedWeight, marker, isoDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "bodyweight_log", "profile");
});

// ---- pure staleness read ----
test("bodyCompStaleness: old scan + moved weight → stale, with a plain-language rescan reason", () => {
  const d = { marker: "Body fat", trigger_date: isoDaysAgo(35) };
  const weights = [
    { date: isoDaysAgo(35), weight_lb: 205 },
    { date: isoDaysAgo(1), weight_lb: 197 },
  ];
  const s = repo.bodyCompStaleness(d, weights);
  assert.equal(s.stale, true);
  assert.equal(s.delta_lb, -8);
  assert.match(s.reason, /scan|fresh scan|provisional/i);
  assert.match(s.reason, /down/i);
});

test("bodyCompStaleness: a RECENT scan is never stale, even if weight moved", () => {
  const d = { marker: "Body fat", trigger_date: isoDaysAgo(5) };
  const weights = [{ date: isoDaysAgo(5), weight_lb: 205 }, { date: isoDaysAgo(1), weight_lb: 197 }];
  assert.equal(repo.bodyCompStaleness(d, weights).stale, false);
});

test("bodyCompStaleness: an old scan with UNCHANGED weight is not stale", () => {
  const d = { marker: "Body fat", trigger_date: isoDaysAgo(40) };
  const weights = [{ date: isoDaysAgo(40), weight_lb: 200 }, { date: isoDaysAgo(1), weight_lb: 199.5 }];
  assert.equal(repo.bodyCompStaleness(d, weights).stale, false, "0.5 lb is under the move threshold");
});

test("bodyCompStaleness: a non-body-comp directive is never stale", () => {
  const d = { marker: "ApoB", trigger_date: isoDaysAgo(400) };
  assert.equal(repo.bodyCompStaleness(d, [{ date: isoDaysAgo(400), weight_lb: 200 }, { date: isoDaysAgo(1), weight_lb: 180 }]).stale, false);
});

// ---- end to end through the engine + coach/API surfaces ----
test("a Body-fat directive off a month-old DEXA decays in directivesForCoach + annotate", () => {
  repo.setProfile({ sex: "male", age: 40 });
  seedHealthDoc(isoDaysAgo(32), [marker("Total Body Fat", 30, { unit: "%", flag: "high" })], "dexa");
  seedWeight(isoDaysAgo(32), 205);
  seedWeight(isoDaysAgo(2), 196);
  repo.deriveDirectives();

  const forCoach = repo.directivesForCoach().filter((d) => /body fat/i.test(String(d.marker || "")));
  assert.ok(forCoach.length >= 1, "the body-fat directive is present");
  assert.ok(forCoach.some((d) => d.stale_measurement === true), "flagged stale for the coach");
  assert.ok(forCoach.some((d) => /fresh scan|provisional|scan ~/i.test(String(d.directive))), "the rescan note is folded into the coach text");

  const annotated = repo.annotateDirectiveFreshness(repo.listActiveDirectives()).filter((d) => /body fat/i.test(String(d.marker || "")));
  assert.ok(annotated.some((d) => d.stale_measurement === true), "the API annotation carries stale_measurement");
  assert.ok(annotated.some((d) => typeof d.weight_delta_lb === "number" && d.weight_delta_lb < 0), "and the weight delta");
});
