import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as brain from "../dist/domain/brain/index.js";
import * as health from "../dist/domain/health/index.js";
import * as nutrition from "../dist/domain/nutrition/index.js";
import * as operator from "../dist/domain/operator/index.js";
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
  assert.equal(typeof operator.getSettings, "function");
  assert.equal(typeof operator.getArtStats, "function");
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
    "src/domain/operator/index.ts",
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

test("health document adapters use the health domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/health-docs.ts", "../domain/health/index.js"],
    ["src/surfaces/mcp/health-records.ts", "../../domain/health/index.js"],
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

test("garmin adapters use the training domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/garmin.ts", "../domain/training/index.js"],
    ["src/surfaces/mcp/garmin.ts", "../../domain/training/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import training domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("plan exercise adapters use the training domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/plan-exercises.ts", "../domain/training/index.js"],
    ["src/surfaces/mcp/plan-exercises.ts", "../../domain/training/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import training domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("training status MCP tools use domain entry points", () => {
  const src = read("src/surfaces/mcp/training-status.ts");
  assert.match(src, /from "\.\.\/\.\.\/domain\/training\/index\.js"/);
  assert.match(src, /from "\.\.\/\.\.\/domain\/person\/index\.js"/);
  assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, "training-status MCP should not import the repo barrel");
});

test("person context adapters use the person domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/person-context.ts", "../domain/person/index.js"],
    ["src/surfaces/mcp/person-context.ts", "../../domain/person/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import person domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("person adapters use person and health domain entry points", () => {
  for (const [file, personImportPath, healthImportPath] of [
    ["src/routes/person.ts", "../domain/person/index.js", "../domain/health/index.js"],
    ["src/surfaces/mcp/person.ts", "../../domain/person/index.js", "../../domain/health/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${personImportPath.replaceAll(".", "\\.")}"`), `${file} should import person domain exports`);
    assert.match(src, new RegExp(`from "${healthImportPath.replaceAll(".", "\\.")}"`), `${file} should import health domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("memory learning adapters use the person domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/memory-learning.ts", "../domain/person/index.js"],
    ["src/surfaces/mcp/memory-learning.ts", "../../domain/person/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import person domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("chat adapters use the person domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/chat.ts", "../domain/person/index.js"],
    ["src/surfaces/mcp/chat.ts", "../../domain/person/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import person domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("agent job adapters use the person domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/agent-jobs.ts", "../domain/person/index.js"],
    ["src/routes/background-op.ts", "../domain/person/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import person domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("export route uses health and training domain entry points", () => {
  const src = read("src/routes/exports.ts");
  assert.match(src, /from "\.\.\/domain\/health\/index\.js"/);
  assert.match(src, /from "\.\.\/domain\/training\/index\.js"/);
  assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, "exports route should not import the repo barrel");
});

test("operator adapters use the operator domain entry point", () => {
  for (const [file, importPath] of [
    ["src/routes/operator.ts", "../domain/operator/index.js"],
    ["src/surfaces/mcp/operator.ts", "../../domain/operator/index.js"],
    ["src/routes/art.ts", "../domain/operator/index.js"],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`from "${importPath.replaceAll(".", "\\.")}"`), `${file} should import operator domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
});

test("daily driver adapters use domain entry points", () => {
  for (const file of ["src/routes/today.ts", "src/surfaces/mcp/daily-driver.ts"]) {
    const src = read(file);
    assert.match(src, /domain\/brain\/index\.js/, `${file} should import brain domain exports`);
    assert.match(src, /domain\/health\/index\.js/, `${file} should import health domain exports`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+repo\s+from\s+["'][^"']*repo\.js["']/, `${file} should not import the repo barrel`);
  }
  assert.match(read("src/surfaces/mcp/daily-driver.ts"), /domain\/person\/index\.js/, "daily driver MCP should import person domain exports for feedback memory");
});

test("connected brain adapters use domain entry points", () => {
  for (const file of ["src/routes/connected-brain.ts", "src/surfaces/mcp/connected-brain.ts"]) {
    const src = read(file);
    assert.match(src, /domain\/brain\/index\.js/, `${file} should import brain domain exports`);
    assert.match(src, /domain\/health\/index\.js/, `${file} should import health domain exports`);
    assert.match(src, /domain\/person\/index\.js/, `${file} should import person domain exports for memory/learning data`);
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
