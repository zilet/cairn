import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  boundedDiagnosticRouteFamily,
  DIAGNOSTIC_ROUTE_FAMILIES,
} from "../dist/contracts/diagnostic-route-families.js";
import {
  normalizeDiagnosticRoute,
  registerMountedApiRouteFamilies,
  resetMountedApiRouteFamilies,
} from "../dist/repo/diagnostics.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The client build transpiles each browser module in isolation, so the browser
// copy of the vocabulary cannot be an import — it is a literal mirror. Two
// hand-maintained lists is exactly what drifted before (the client knew
// `training-agenda`, the server did not, and every batch carrying it was
// rejected whole). This test is the thing that keeps the mirror honest.
function clientRouteFamilies() {
  const context = { Set, String, Object, Array, RegExp, JSON, Math, Map, Date, Number, URL, Error, Intl };
  vm.runInNewContext(readFileSync(join(root, "public/js/client-diagnostics.js"), "utf8"), context);
  return context.CairnClientDiagnosticsCore.families;
}

test("the browser route-family mirror is identical to the shared contract", () => {
  assert.deepEqual([...clientRouteFamilies()], [...DIAGNOSTIC_ROUTE_FAMILIES]);
});

test("the shared family list is sorted and free of duplicates", () => {
  const families = [...DIAGNOSTIC_ROUTE_FAMILIES];
  assert.deepEqual(families, [...new Set(families)].sort());
});

test("client and server agree on which route families are recordable", () => {
  // The mounted-family bound is process-global, and any file in this shard that
  // imports the API module arms it. This test is about the SHARED vocabulary, so
  // it pins the unarmed state rather than inheriting whatever the shard left.
  resetMountedApiRouteFamilies();
  const context = { Set, String, Object, Array, RegExp, JSON, Math, Map, Date, Number, URL, Error, Intl };
  vm.runInNewContext(readFileSync(join(root, "public/js/client-diagnostics.js"), "utf8"), context);
  const normalizeOnClient = context.CairnClientDiagnosticsCore.normalizeRoute;
  const cases = [
    "/api/today",
    "/api/training-agenda?date=2026-08-25",
    "/api/training-symptoms/17/resolve",
    "/api/brand-new-endpoint",
    "/api/health-docs/9",
  ];
  for (const path of cases)
    assert.equal(normalizeOnClient(path), normalizeDiagnosticRoute(path), `route family disagreement for ${path}`);
  // A shape neither side may record: the server drops it, the client blanks it
  // (its blank becomes "/api", which the server keeps as the bare API root).
  assert.equal(normalizeDiagnosticRoute("/api/Named Private Exercise"), null);
  assert.equal(normalizeOnClient("/api/Named Private Exercise"), "");
});

test("an unknown family is bounded rather than free text", () => {
  assert.equal(boundedDiagnosticRouteFamily("today"), "today");
  assert.equal(boundedDiagnosticRouteFamily("BRAND-NEW"), "brand-new");
  assert.equal(boundedDiagnosticRouteFamily("a".repeat(40)), "a".repeat(40));
  assert.equal(boundedDiagnosticRouteFamily("a".repeat(41)), null);
  assert.equal(boundedDiagnosticRouteFamily("private family detail"), null);
  assert.equal(boundedDiagnosticRouteFamily("-leading-hyphen"), null);
  assert.equal(boundedDiagnosticRouteFamily("under_score"), null);
  assert.equal(boundedDiagnosticRouteFamily(""), null);
});

// ---------- cardinality: a durable table, a client-supplied string ----------

test("an unknown family is only recorded when this server actually mounts it", () => {
  // `diagnostic_events` is keyed by route, so an unbounded family vocabulary is
  // unbounded ROW CARDINALITY — and the string comes from the browser. The shape
  // bound alone accepts a thousand invented segments; the mounted set is what makes
  // an unlisted-but-real endpoint visible without opening that door.
  registerMountedApiRouteFamilies(["today", "brand-new-endpoint", "Sessions"]);
  try {
    // In the shared allowlist → itself, always.
    assert.equal(normalizeDiagnosticRoute("/api/today"), "/api/today");
    assert.equal(normalizeDiagnosticRoute("/api/training-agenda?date=2026-08-25"), "/api/training-agenda");
    // Not in the allowlist but genuinely mounted → itself, the day it ships.
    assert.equal(normalizeDiagnosticRoute("/api/brand-new-endpoint"), "/api/brand-new-endpoint");
    // Registration is case-folded, so a mount table's own casing cannot exclude a route.
    assert.equal(normalizeDiagnosticRoute("/api/sessions/4/sets"), "/api/sessions");
    // Well-shaped, but nothing serves it → one shared bucket, not a new row per name.
    assert.equal(normalizeDiagnosticRoute("/api/zzz-invented"), "/api/unknown");
    assert.equal(normalizeDiagnosticRoute("/api/probe-1"), "/api/unknown");
    // Still dropped outright when it cannot even be bounded to a segment shape.
    assert.equal(normalizeDiagnosticRoute("/api/Named Private Exercise"), null);
    assert.equal(normalizeDiagnosticRoute("/api"), "/api");
  } finally {
    resetMountedApiRouteFamilies();
  }
  // With nothing registered (a context that mounts no HTTP surface at all) the
  // shape bound stands alone — the previous behavior, unchanged.
  assert.equal(normalizeDiagnosticRoute("/api/zzz-invented"), "/api/zzz-invented");
});

test("the mounted families are derived from the routers this build actually mounts", async () => {
  // Importing the API module registers the set as a side effect of mounting, the
  // same way the server does at boot.
  await import("../dist/api.js");
  try {
    for (const path of ["/api/today", "/api/sessions/4/sets", "/api/chat/9", "/api/health-docs/2", "/api/settings"]) {
      const family = normalizeDiagnosticRoute(path);
      assert.notEqual(family, "/api/unknown", `${path} is mounted and must keep its own name`);
      assert.ok(family?.startsWith("/api/"), path);
    }
    assert.equal(normalizeDiagnosticRoute("/api/zzz-not-a-real-route"), "/api/unknown");
  } finally {
    resetMountedApiRouteFamilies();
  }
});
