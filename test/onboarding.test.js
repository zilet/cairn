// Frictionless onboarding (reframed B1): ONE free-text intro → understood + applied,
// then onboarded. No question barrage. The deterministic base must ALWAYS stand
// (about_me saved, KB supplements understood, no prose-as-supplement junk, onboarded
// flag set) so a flaky/absent agent never traps the user on setup.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import * as coachOps from "../dist/coachOps.js";

beforeEach(() => {
  try { db.prepare("UPDATE profile SET about_me = NULL WHERE id = 1").run(); } catch {}
  try { db.prepare("DELETE FROM supplements").run(); } catch {}
});

test("onboardFromText understands a plain intro and never bugs the user", async () => {
  const out = await coachOps.onboardFromText(
    "stub",
    "I'm 41, training for longevity and to stay strong for my kids. I take creatine daily and omega-3, and some vitamin D.",
  );
  assert.equal(out.ok, true);
  assert.ok(out.applied.about_me, "about_me captured");
  assert.ok(out.applied.supplements >= 2, "KB supplements understood");

  const prof = repo.getProfile();
  assert.match(prof.about_me, /longevity/, "their words are saved verbatim into about_me");

  const supps = repo.listSupplements();
  assert.ok(supps.some((s) => s.name === "Creatine monohydrate"));
  assert.ok(supps.some((s) => s.name === "Omega-3 (EPA/DHA)"));
  assert.ok(supps.some((s) => s.name === "Vitamin D3"));
  // critical: prose fragments ("I'm 41", "training for longevity") must NOT become supplements
  assert.ok(!supps.some((s) => /41|longevity|training|kids/i.test(s.name)), "no prose-as-supplement junk (strict mode)");

  // onboarded is set so the user is dropped straight into the app
  assert.equal(repo.getSettings().onboarded, true);
});

test("an empty intro is the Skip path — just marks onboarded", async () => {
  const out = await coachOps.onboardFromText(undefined, "   ");
  assert.equal(out.source, "empty");
  assert.equal(out.applied.about_me, false);
  assert.equal(repo.getSettings().onboarded, true);
});
