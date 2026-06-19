#!/usr/bin/env node
// CI guard for the repo's #1 footgun: a cache-first service worker.
//
// If a change touches any file under public/ (other than sw.js itself), the
// `const CACHE = "cairn-vNN"` constant at the top of public/sw.js MUST move in the
// same diff — otherwise already-installed PWA clients keep serving the STALE bundle
// forever (a client once silently fell ~40 versions behind). See CONTRIBUTING.md
// "The PWA cache version". Pure git plumbing, no deps.
//
// Usage: node scripts/check-sw-cache.mjs [baseRef]   (baseRef defaults to origin/main)
import { execFileSync } from "node:child_process";

const base = process.argv[2] || "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

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
