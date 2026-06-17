// Supplement UNDERSTANDING (not a daily log). You say what you take in plain
// words once; parseSupplements approximates each into canonical name + dose +
// cadence + the markers it touches, and the connected brain folds it in.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import * as prompt from "../dist/prompt.js";

beforeEach(() => {
  try { db.prepare("DELETE FROM supplements").run(); } catch {}
});

test("parseSupplements approximates a plain-words regimen", () => {
  const items = repo.parseSupplements("I take creatine daily, omega-3, some D, whey occasionally");
  const by = Object.fromEntries(items.map((i) => [i.name, i]));

  assert.ok(by["Creatine monohydrate"], "creatine understood");
  assert.equal(by["Creatine monohydrate"].dose, "5 g");
  assert.equal(by["Creatine monohydrate"].frequency, "daily");
  assert.ok(by["Creatine monohydrate"].related_markers.includes("eGFR"), "creatine ↔ eGFR for the safety gate");

  assert.ok(by["Omega-3 (EPA/DHA)"], "omega-3 understood");
  assert.ok(by["Vitamin D3"], "'some D' understood as Vitamin D3");
  assert.ok(by["Whey protein"], "whey understood");
  assert.equal(by["Whey protein"].frequency, "occasional");
});

test("dose overrides are picked up; unknown supplements are kept (not dropped)", () => {
  const items = repo.parseSupplements("creatine 10g, rhodiola 200mg daily");
  const c = items.find((i) => i.name === "Creatine monohydrate");
  assert.equal(c.dose, "10 g", "explicit dose overrides the KB default");

  const r = items.find((i) => i.category === "other");
  assert.ok(r, "unknown supplement kept");
  assert.match(r.name, /^Rhodiola$/i, "name cleaned of dose/cadence");
  assert.equal(r.dose, "200 mg");
  assert.equal(r.frequency, "daily");
});

test("understandSupplements stores + dedups by canonical name; update/delete work", () => {
  repo.understandSupplements("creatine daily, omega-3");
  assert.equal(repo.listSupplements().length, 2);

  // Re-stating an existing one updates in place, never duplicates.
  repo.understandSupplements("creatine");
  assert.equal(repo.listSupplements().length, 2, "dedup by name");

  const mag = repo.understandSupplements("magnesium 400mg")[0];
  assert.equal(mag.dose, "400 mg");
  // related_markers round-trips as an array (not a JSON string), raw is preserved.
  assert.ok(Array.isArray(mag.related_markers));
  assert.equal(mag.raw, "magnesium 400mg");

  // active=false hides it from the default list but keeps it for history.
  const u = repo.updateSupplement(mag.id, { active: false });
  assert.equal(u.active, 0);
  assert.equal(repo.listSupplements().length, 2, "stopped one hidden by default");
  assert.equal(repo.listSupplements({ activeOnly: false }).length, 3);

  assert.equal(repo.deleteSupplement(mag.id).deleted, 1);
});

test("the connected brain folds supplements into the coach prompts", () => {
  repo.understandSupplements("creatine daily, whey occasionally");
  const ctx = repo.getCoachContext();
  assert.ok(ctx.supplements.some((s) => s.name === "Creatine monohydrate"), "in coach context");

  const p = prompt.buildDayReadPrompt();
  assert.match(p, /SUPPLEMENTS THE ATHLETE ALREADY TAKES/);
  assert.match(p, /Creatine monohydrate/);
});
