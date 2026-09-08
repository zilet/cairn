#!/usr/bin/env node
// CI guard for the repo's #1 footgun: a cache-first service worker.
//
// The cache VERSION is no longer a human's job. public/sw.js ships the
// placeholder `const CACHE = "cairn-shell-dev"`, and src/swVersion.ts rewrites it
// at serve time to a content hash over everything the worker precaches — so a
// changed shell always ships a new cache name, and an unchanged one never
// re-downloads. What a human still owns is the PRECACHE LIST: an asset missing
// from CORE_ASSETS is neither cached offline nor covered by the hash.
//
// So this script asserts the derived-version contract still holds end to end:
//   - the placeholder literal is present and intact (the server substitutes it
//     by exact match; a rename here silently freezes the version);
//   - CORE_ASSETS mirrors the build-client BUNDLES manifest exactly, so a new
//     bundle cannot be born unprecached;
//   - index.html loads the eager bundles, in manifest order, and NONE of the
//     bundles marked `lazy` (those are injected by src/client/app/lazy-bundles.ts);
//   - every precached url exists on disk.
// Pure git/fs plumbing, no deps.
//
// Usage: node scripts/check-sw-cache.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLES } from "./build-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Must match SW_CACHE_PLACEHOLDER in src/swVersion.ts. */
const CACHE_PLACEHOLDER = "cairn-shell-dev";

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

/** `public/js/bundle-01-core.js` -> `/js/bundle-01-core.js` */
function servedUrl(output) {
  return output.replace(/^public/, "");
}

function assertPublicAssetContract() {
  const index = readRepo("public/index.html");
  const sw = readRepo("public/sw.js");
  const scripts = [...index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const core = quotedArrayValues(sw, "CORE_ASSETS");
  const optional = quotedArrayValues(sw, "OPTIONAL_ASSETS");
  const allCached = [...core, ...optional];
  const errors = [];

  // The version is derived from this literal being substitutable. Assert the
  // placeholder rather than a diff-window "did someone bump it" heuristic.
  const cacheLiteral = /const CACHE\s*=\s*["']([^"']+)["']/.exec(sw);
  if (!cacheLiteral) {
    errors.push("public/sw.js is missing its `const CACHE = \"…\"` declaration");
  } else if (cacheLiteral[1] !== CACHE_PLACEHOLDER) {
    errors.push(
      `public/sw.js CACHE must stay the placeholder "${CACHE_PLACEHOLDER}" (got "${cacheLiteral[1]}") — ` +
        "the served version is derived in src/swVersion.ts and substituted by exact match"
    );
  }

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

  // The BUNDLES manifest is the authority on which bundles exist and in what
  // order; CORE_ASSETS must mirror it exactly (so every bundle is precached and
  // folded into the derived version), and index.html must load exactly the eager
  // subset — a `lazy` bundle is injected by ensureBundle() at navigation time.
  const manifestBundles = BUNDLES.map((bundle) => servedUrl(bundle.output));
  const eagerBundles = BUNDLES.filter((bundle) => !bundle.lazy).map((bundle) => servedUrl(bundle.output));
  const lazyBundles = BUNDLES.filter((bundle) => bundle.lazy).map((bundle) => servedUrl(bundle.output));
  const indexBundles = scripts.filter((src) => src.startsWith("/js/"));
  const coreBundles = core.filter((src) => src.startsWith("/js/"));

  if (indexBundles.some((src) => !/^\/js\/bundle-\d+[\w-]*\.js$/.test(src))) {
    errors.push(`public/index.html must load only /js/bundle-*.js scripts (got: ${indexBundles.join(", ")})`);
  }
  if (JSON.stringify(coreBundles) !== JSON.stringify(manifestBundles)) {
    errors.push(
      "sw.js CORE_ASSETS bundles must mirror the build-client BUNDLES manifest exactly " +
        `(CORE_ASSETS: ${coreBundles.join(", ")} | manifest: ${manifestBundles.join(", ")})`
    );
  }
  if (JSON.stringify(indexBundles) !== JSON.stringify(eagerBundles)) {
    errors.push(
      "public/index.html must load exactly the non-lazy bundles, in manifest order " +
        `(index.html: ${indexBundles.join(", ")} | expected: ${eagerBundles.join(", ")})`
    );
  }

  // A lazy bundle is only reachable through the loader's own table.
  if (lazyBundles.length) {
    const loader = readRepo("src/client/app/lazy-bundles.ts");
    for (const bundle of BUNDLES.filter((b) => b.lazy)) {
      const url = servedUrl(bundle.output);
      if (!loader.includes(`"${bundle.lazy}": "${url}"`)) {
        errors.push(`src/client/app/lazy-bundles.ts must map "${bundle.lazy}" to "${url}"`);
      }
    }
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
  console.log(
    `✓ public app-shell cache contract is aligned (${scripts.length} eager boot script(s), ` +
      `${lazyBundles.length} lazy bundle(s), ${core.length} core asset(s), version derived from the shell)`
  );
}

assertPublicAssetContract();
