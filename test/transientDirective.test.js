// annotateDirectiveFreshness × markerInTransientWindow — a FRESH acute marker
// (hs-CRP, ESR, …) drawn while a transient-inflammation context window is active
// (recent illness / injury / hard block) reads INFORMATIONAL ("drawn during a
// flare, recheck once settled") instead of capping training every morning. The
// existing acute/age_days/stale logic stays intact; this verdict is additive.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "context_events");
});

const TODAY = "2026-06-24";
const ago = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
// A passed-in effect keeps this fully deterministic (no DB context_events / real now).
const coldEffect = (startAgo) => repo.activeContextEffect(TODAY, [
  { kind: "life_event", title: "Fighting a cold", start_date: ago(startAgo), end_date: null, meta: null, archived: 0 },
]);

test("a FRESH hs-CRP drawn inside a transient-inflammation window reads transient", () => {
  seedHealthDoc(ago(2), [marker("hs-CRP", 8, { unit: "mg/L", flag: "high" })]);
  repo.deriveDirectives();
  const crpDirs = repo.listActiveDirectives().filter((d) => d.marker === "hs-CRP");
  assert.ok(crpDirs.length >= 1, "an off hs-CRP propagates a directive");
  const eff = coldEffect(2);
  assert.equal(eff.transient_inflammation, true);
  const annotated = repo.annotateDirectiveFreshness(crpDirs, TODAY, eff);
  const crp = annotated[0];
  assert.equal(crp.acute, true);
  assert.equal(crp.stale, false);          // fresh — not the stale path
  assert.equal(crp.transient, true);
  assert.match(crp.transient_reason, /cold|flare|recheck|settle/i);
});

test("no active transient window → transient false (acute/stale logic intact)", () => {
  seedHealthDoc(ago(2), [marker("hs-CRP", 8, { unit: "mg/L", flag: "high" })]);
  repo.deriveDirectives();
  const crpDirs = repo.listActiveDirectives().filter((d) => d.marker === "hs-CRP");
  const annotated = repo.annotateDirectiveFreshness(crpDirs, TODAY, repo.activeContextEffect(TODAY, []));
  assert.equal(annotated[0].acute, true);
  assert.equal(annotated[0].transient, false);
  assert.equal(annotated[0].transient_reason, null);
});

test("an OLD (stale) acute reading is NOT marked transient even inside a window", () => {
  seedHealthDoc(ago(30), [marker("hs-CRP", 8, { unit: "mg/L", flag: "high" })]);
  repo.deriveDirectives();
  const crpDirs = repo.listActiveDirectives().filter((d) => d.marker === "hs-CRP");
  const annotated = repo.annotateDirectiveFreshness(crpDirs, TODAY, coldEffect(2));
  assert.equal(annotated[0].stale, true);  // the stale path owns an old reading
  assert.equal(annotated[0].transient, false);
});

test("a chronic marker (ApoB) is never acute and never transient, even during a flare", () => {
  seedHealthDoc(ago(2), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const apobDirs = repo.listActiveDirectives().filter((d) => d.marker === "ApoB");
  assert.ok(apobDirs.length >= 1);
  const annotated = repo.annotateDirectiveFreshness(apobDirs, TODAY, coldEffect(2));
  assert.ok(annotated.every((d) => d.acute === false && d.transient === false));
});

test("the transient verdict is additive — fields are always present, default false/null", () => {
  seedHealthDoc(ago(2), [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const annotated = repo.annotateDirectiveFreshness(repo.listActiveDirectives(), TODAY);
  for (const d of annotated) {
    assert.ok("transient" in d && "transient_reason" in d && "stale" in d && "acute" in d && "age_days" in d);
  }
});
