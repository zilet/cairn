#!/usr/bin/env node
// One-off generator: reads the validated AHA PREVENT (2023) coefficient artifact
// (gitignored, lives outside the repo) and emits src/repo/prevent-coefficients.ts
// as a typed, in-repo source of truth. Betas are NEVER hand-transcribed — this
// script is the only thing that writes prevent-coefficients.ts.
//
// Run: node scripts/gen-prevent-coefficients.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFile), "..");

// The coefficient artifact is a generation-time input, not something the repo
// ships (it's under the gitignored data/ dir). Default to the repo-relative
// location; override with PREVENT_ARTIFACT when it lives elsewhere.
const ARTIFACT = process.env.PREVENT_ARTIFACT ?? path.join(root, "data", "cv-risk-artifacts", "coeffs.json");
const OUTPUT = path.join(root, "src", "repo", "prevent-coefficients.ts");

const raw = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const { meta, models } = raw;

// Only emit the base model — v1 implements base only, but keep all 5 outcomes x
// 2 sexes x 2 horizons (20 blocks) so a future variant wave doesn't need to
// regenerate this file's shape.
const baseKeys = Object.keys(models)
  .filter((k) => k.startsWith("base|"))
  .sort();

if (baseKeys.length !== 20) {
  throw new Error(`expected 20 base|* model blocks, found ${baseKeys.length}`);
}

function jsonLit(value) {
  return JSON.stringify(value, null, 2).replace(/\n/g, "\n  ");
}

const blocksTs = baseKeys
  .map((key) => {
    const blk = models[key];
    return `  ${JSON.stringify(key)}: {
    model: ${JSON.stringify(blk.model)},
    sex: ${JSON.stringify(blk.sex)},
    outcome: ${JSON.stringify(blk.outcome)},
    horizon: ${JSON.stringify(blk.horizon)},
    intercept: ${blk.intercept},
    betas: ${jsonLit(blk.betas)},
  },`;
  })
  .join("\n");

const output = `// GENERATED FILE — do not hand-edit. Regenerate with:
//   node scripts/gen-prevent-coefficients.mjs
//
// Provenance: preventr R package (CRAN, MIT) sysdata.rda, machine-extracted via
// pyreadr into coeffs.json (sha1 8a7bc041), validated against the preventr
// documented worked example (Circulation 2023 supplement Table S25) by
// data/cv-risk-artifacts/validate.py — "ALL 10 CHECKS PASSED". See
// data/cv-risk-artifacts/README.md for the full transform/centering spec.
//
// Only the "base" model (no hba1c/uacr/sdi) is used by src/repo/prevent.ts today;
// the other 80 blocks in the source artifact are variant models, intentionally
// not emitted here (out of scope for v1 — see the wave-2 task).

export type PreventOutcome = "total_cvd" | "ascvd" | "heart_failure" | "chd" | "stroke";
export type PreventSex = "male" | "female";
export type PreventHorizon = "10yr" | "30yr";

export type PreventModelBlock = {
  model: "base";
  sex: PreventSex;
  outcome: PreventOutcome;
  horizon: PreventHorizon;
  intercept: number;
  betas: Record<string, number>;
};

export const PREVENT_META = ${jsonLit(meta)} as const;

// Keyed "base|<sex>|<outcome>|<horizon>" — look up by name, never by position.
export const PREVENT_BASE_MODELS: Record<string, PreventModelBlock> = {
${blocksTs}
};
`;

writeFileSync(OUTPUT, output);
console.log(`wrote ${path.relative(root, OUTPUT)} (${baseKeys.length} base model blocks)`);
