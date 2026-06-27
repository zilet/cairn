#!/usr/bin/env node
// CI guard for the repo's #1 footgun: a cache-first service worker.
//
// If a change touches any file under public/ (other than sw.js itself), the
// `const CACHE = "cairn-vNN"` constant at the top of public/sw.js MUST move in the
// same diff — otherwise already-installed PWA clients keep serving the STALE bundle
// forever (a client once silently fell ~40 versions behind). See CONTRIBUTING.md
// "The PWA cache version". Also validates that the classic app-shell script
// graph and service-worker precache list stay aligned. Pure git plumbing, no deps.
//
// Usage: node scripts/check-sw-cache.mjs [baseRef]   (baseRef defaults to origin/main)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] || "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepo(file) {
  return readFileSync(path.join(root, file), "utf8");
}

function quotedArrayValues(src, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(src);
  if (!match) throw new Error(`public/sw.js is missing ${name}`);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

function assertPublicAssetContract() {
  const index = readRepo("public/index.html");
  const sw = readRepo("public/sw.js");
  const scripts = [...index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const core = quotedArrayValues(sw, "CORE_ASSETS");
  const optional = quotedArrayValues(sw, "OPTIONAL_ASSETS");
  const allCached = [...core, ...optional];
  const errors = [];

  for (const [name, values] of [
    ["CORE_ASSETS", core],
    ["OPTIONAL_ASSETS", optional],
  ]) {
    const dupes = duplicates(values);
    if (dupes.length) errors.push(`${name} contains duplicate entr${dupes.length === 1 ? "y" : "ies"}: ${dupes.join(", ")}`);
  }
  for (const asset of ["/", "/index.html", "/styles.css", "/manifest.json"]) {
    if (!core.includes(asset)) errors.push(`CORE_ASSETS must include ${asset}`);
  }

  const missingScripts = scripts.filter((src) => !core.includes(src));
  if (missingScripts.length) {
    errors.push(`app-shell script${missingScripts.length === 1 ? "" : "s"} missing from CORE_ASSETS: ${missingScripts.join(", ")}`);
  }

  if (scripts[0] !== "/art.js") errors.push("public/index.html must load /art.js before feature scripts");
  const settingsRoutesIndex = scripts.indexOf("/js/settings-routes.js");
  const bootIndex = scripts.indexOf("/js/10-boot.js");
  if (bootIndex !== scripts.length - 1) errors.push("public/index.html must load /js/10-boot.js last");
  if (settingsRoutesIndex === -1 || bootIndex === -1 || settingsRoutesIndex > bootIndex) {
    errors.push("public/index.html must load /js/settings-routes.js before /js/10-boot.js");
  }

  const missingFiles = allCached
    .filter((asset) => asset.startsWith("/"))
    .map((asset) => ({ asset, file: asset === "/" ? "public/index.html" : `public${asset}` }))
    .filter(({ file }) => !existsSync(path.join(root, file)));
  if (missingFiles.length) {
    errors.push(`cached asset${missingFiles.length === 1 ? "" : "s"} missing on disk: ${missingFiles.map((r) => `${r.asset} -> ${r.file}`).join(", ")}`);
  }

  if (errors.length) {
    console.error("✗ public app-shell cache contract failed:");
    for (const error of errors) console.error(`    ${error}`);
    process.exit(1);
  }
  console.log(`✓ public app-shell cache contract is aligned (${scripts.length} boot script(s), ${core.length} core asset(s))`);
}

assertPublicAssetContract();

let changed = [];
try {
  changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
} catch (e) {
  // Base ref unavailable (shallow clone, local run without the base fetched) — fall
  // through to the local working-tree check below. CI normally has the base.
  console.log(`• base ref ${base} unavailable (${e.message.split("\n")[0]}) — checking local diff only`);
}
const localChanged = [
  ...git("diff", "--name-only").split("\n").filter(Boolean),
  ...git("diff", "--cached", "--name-only").split("\n").filter(Boolean),
  ...git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
];
changed = [...new Set([...changed, ...localChanged])];

const assetChanges = changed.filter((f) => f.startsWith("public/") && f !== "public/sw.js");
if (assetChanges.length === 0) {
  console.log("✓ no public/ asset changes — sw.js cache bump not required");
  process.exit(0);
}

// Did the CACHE constant line itself change in this diff?
let swDiff = "";
try {
  swDiff = git("diff", `${base}...HEAD`, "--", "public/sw.js");
} catch {
  /* no diff for sw.js at all */
}
try {
  swDiff += "\n" + git("diff", "--", "public/sw.js");
  swDiff += "\n" + git("diff", "--cached", "--", "public/sw.js");
} catch {
  /* local sw diff unavailable */
}
const removedCache = [...swDiff.matchAll(/^-\s*const CACHE\s*=\s*["']([^"']+)["']/gm)].map((m) => m[1]);
const addedCache = [...swDiff.matchAll(/^\+\s*const CACHE\s*=\s*["']([^"']+)["']/gm)].map((m) => m[1]);
const cacheBumped = addedCache.some((next) => removedCache.some((prev) => prev !== next));

if (!cacheBumped) {
  console.error("✗ public/ assets changed but the public/sw.js CACHE version was not bumped:");
  for (const f of assetChanges) console.error(`    ${f}`);
  console.error('\n  Bump the `const CACHE = "cairn-vNN"` constant at the top of public/sw.js in');
  console.error("  the same change, or installed PWA clients will serve stale assets forever.");
  process.exit(1);
}
console.log(`✓ public/ assets changed and sw.js CACHE was bumped (${assetChanges.length} asset file(s))`);
