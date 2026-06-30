import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as brain from "../dist/domain/brain/index.js";
import * as health from "../dist/domain/health/index.js";
import * as nutrition from "../dist/domain/nutrition/index.js";
import * as person from "../dist/domain/person/index.js";
import * as training from "../dist/domain/training/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("domain entry points group representative repo capabilities", () => {
  assert.equal(typeof training.programBalance, "function");
  assert.equal(typeof training.weeklyRunPlan, "function");
  assert.equal(typeof health.healthFocus, "function");
  assert.equal(typeof health.dexaTargeting, "function");
  assert.equal(typeof nutrition.getDayIntake, "function");
  assert.equal(typeof person.getProfile, "function");
  assert.equal(typeof person.nextBestStep, "function");
  assert.equal(typeof brain.getCoachContext, "function");
  assert.equal(typeof brain.todayAgenda, "function");
});

test("domain entry points are additive barrels, not new behavior layers", () => {
  for (const file of [
    "src/domain/training/index.ts",
    "src/domain/health/index.ts",
    "src/domain/nutrition/index.ts",
    "src/domain/person/index.ts",
    "src/domain/brain/index.ts",
  ]) {
    const src = read(file);
    assert.doesNotMatch(src, /\bfrom\s+["']\.\.\/\.\.\/db\.js["']/, `${file} must not touch DB directly`);
    assert.doesNotMatch(src, /\bfunction\b|\bclass\b/, `${file} should remain a grouping barrel for now`);
    assert.match(src, /export \* from /, `${file} should expose grouped repo modules`);
  }
});

test("nutrition adapters use the nutrition domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/nutrition.ts", "../domain/nutrition/index.js"],
    ["src/surfaces/mcp/nutrition.ts", "../../domain/nutrition/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import nutrition domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("health metrics adapters use the health domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/health-metrics.ts", "../domain/health/index.js"],
    ["src/surfaces/mcp/health-metrics.ts", "../../domain/health/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import health domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("training log adapters use the training domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/training-log.ts", "../domain/training/index.js"],
    ["src/surfaces/mcp/training-log.ts", "../../domain/training/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import training domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("repo compatibility barrel remains the public back-compat surface", () => {
  const repo = read("src/repo.ts");
  assert.match(repo, /Barrel: repo\.ts was split into cohesive domain modules/);
  assert.match(repo, /External code imports from "\.\/repo\.js" by name/);
  assert.match(repo, /export \* from "\.\/repo\/today-agenda\.js"/);
  assert.match(repo, /export \* from "\.\/repo\/next-step\.js"/);
});
