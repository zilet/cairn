#!/usr/bin/env node
// Deterministic, offline policy benchmark for the pure adaptive-chat classifier.
// It deliberately contains no CLI, network, database, or provider calls.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
export const DEFAULT_FIXTURE = path.join(root, "test/fixtures/adaptive-chat-routing.json");
export const DEFAULT_MODULE = path.join(root, "dist/chatRouting.js");

export function loadCorpus(file = DEFAULT_FIXTURE) {
  const corpus = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(corpus.cases) || corpus.cases.length < 60) {
    throw new Error("Adaptive chat routing corpus must contain at least 60 cases.");
  }
  return corpus;
}

function normalizedReasons(value) {
  const reasons = value?.reason_codes ?? [];
  return new Set(Array.isArray(reasons) ? reasons.map(String) : []);
}

// Fixture categories are intentionally readable; this adapter turns them into
// the classifier's stable minimum reason-code contract. Additional codes are
// always accepted, but a policy explanation must include each minimum code.
function requiredReasonCodes(benchmarkCase) {
  const categories = new Set(benchmarkCase.requiredReasons);
  if (benchmarkCase.expectedLane === "capture") {
    if (categories.has("correction")) return ["capture_correction"];
    if (categories.has("food")) return [categories.has("photo") ? "photo_food_default" : "explicit_food_log"];
    if (categories.has("activity")) return ["explicit_activity_log"];
    if (categories.has("weight")) return ["explicit_weight_log"];
    if (categories.has("supplement")) return ["explicit_supplement_log"];
  }
  if (benchmarkCase.expectedLane === "coach") {
    if (categories.has("explicit_fast")) return ["explicit_fast_request"];
    if (categories.has("photo")) return ["non_food_image"];
    return [categories.has("ordinary_coaching") ? "routine_coaching" : "ordinary_chat"];
  }
  if (categories.has("medication")) return ["medication_interaction"];
  if (categories.has("lab")) return ["lab_or_imaging"];
  if (categories.has("clinical_safety") || categories.has("injury") || categories.has("symptom")) return ["clinical_or_injury"];
  if (categories.has("current_information")) return ["current_research"];
  if (categories.has("multi_constraint")) return ["multi_constraint"];
  if (categories.has("goal_structure")) return [benchmarkCase.id === "plan-04" ? "goal_identity" : "plan_restructure"];
  if (categories.has("explicit_deep")) return ["explicit_deep_request"];
  if (categories.has("adversarial")) return ["mixed_risk"];
  return ["mixed_risk"];
}

// The fixture keeps image intent as a human-readable corpus annotation. The
// classifier contract deliberately receives only the privacy-minimal inputs it
// supports: message text and a boolean image presence flag.
function classifierInput(input = {}) {
  return {
    message: input.message ?? input.text ?? null,
    has_image: input.has_image ?? input.hasImage ?? false,
  };
}

export function evaluateCase(classifier, benchmarkCase) {
  const actual = classifier(classifierInput(benchmarkCase.input));
  const actualLane = typeof actual === "string" ? actual : actual?.lane;
  const reasons = normalizedReasons(actual);
  const laneMatches = actualLane === benchmarkCase.expectedLane;
  const requiredReasonCodesForCase = requiredReasonCodes(benchmarkCase);
  const missingReasons = requiredReasonCodesForCase.filter((reason) => !reasons.has(reason));
  return {
    id: benchmarkCase.id,
    expectedLane: benchmarkCase.expectedLane,
    actualLane: actualLane ?? null,
    requiredReasons: requiredReasonCodesForCase,
    actualReasons: [...reasons].sort(),
    laneMatches,
    missingReasons,
    passed: laneMatches && missingReasons.length === 0,
  };
}

export function runBenchmark({ classifier, corpus = loadCorpus() }) {
  if (typeof classifier !== "function") throw new TypeError("classifier must be a function");
  const results = corpus.cases.map((benchmarkCase) => evaluateCase(classifier, benchmarkCase));
  const failures = results.filter((result) => !result.passed);
  const byLane = Object.fromEntries(
    ["capture", "coach", "deep"].map((lane) => [lane, {
      total: results.filter((result) => result.expectedLane === lane).length,
      passed: results.filter((result) => result.expectedLane === lane && result.passed).length,
    }])
  );
  return {
    schemaVersion: corpus.schemaVersion,
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    byLane,
    failures,
  };
}

async function loadClassifier(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  const classifier = mod.classifyChatRoute;
  if (typeof classifier !== "function") {
    throw new Error(`${modulePath} must export classifyChatRoute(input).`);
  }
  return classifier;
}

async function main() {
  const modulePath = process.argv[2] ? path.resolve(root, process.argv[2]) : DEFAULT_MODULE;
  const summary = runBenchmark({ classifier: await loadClassifier(modulePath) });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
