// deriveDirectives + MARKER_MAPPINGS (src/repo.ts): the deterministic propagation
// engine. A sub-optimal lab marker propagates into the domains it touches as
// health_directives. Constitution-critical safety: the engine NEVER fabricates a
// directive for a marker that isn't actually off the worse way (the vitamin-D
// side guard), and re-deriving is idempotent (it never piles directives up).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives");
});

const activeFor = (markerLabel) =>
  repo.listActiveDirectives().filter((d) => (d.marker || "") === markerLabel);

test("a flagged ApoB produces nutrition + watch directives", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  const res = repo.deriveDirectives();
  assert.ok(res.derived >= 2);
  const domains = activeFor("ApoB").map((d) => d.domain).sort();
  assert.deepEqual(domains, ["nutrition", "watch"]);
  // The nutrition lever names the actual dietary change, with a guideline citation.
  const nut = activeFor("ApoB").find((d) => d.domain === "nutrition");
  assert.match(nut.directive, /saturated fat|fiber/i);
  assert.ok(nut.citation, "a well-established lever carries a citation");
  assert.equal(nut.uncertain ? 1 : 0, 0, "cited directive is not flagged uncertain");
});

test("a flagged HbA1c propagates into nutrition + training + watch", () => {
  seedHealthDoc("2025-12-01", [marker("HbA1c", 6.0, { unit: "%", flag: "high" })]);
  repo.deriveDirectives();
  const domains = new Set(activeFor("HbA1c").map((d) => d.domain));
  assert.ok(domains.has("nutrition") && domains.has("training") && domains.has("watch"));
});

test("VITAMIN-D SIDE GUARD: a HIGH vitamin D does NOT emit a 'supplement D3' directive", () => {
  // 90 ng/mL sits ABOVE the optimal band; vitamin D is 'low is worse', so a high
  // value is NOT off the worse way and is unflagged => the engine must stay silent.
  seedHealthDoc("2025-12-01", [marker("Vitamin D 25-OH", 90, { unit: "ng/mL" })]);
  repo.deriveDirectives();
  const vd = repo.listActiveDirectives().filter((d) => (d.marker || "").toLowerCase().includes("vitamin"));
  assert.equal(vd.length, 0, "no directive for a vitamin D that's already high");
});

test("a LOW vitamin D DOES emit the supplement + recheck directives", () => {
  seedHealthDoc("2025-12-01", [marker("Vitamin D 25-OH", 18, { unit: "ng/mL", flag: "low" })]);
  repo.deriveDirectives();
  const vd = repo.listActiveDirectives().filter((d) => (d.marker || "").toLowerCase().includes("vitamin"));
  assert.equal(vd.length, 2);
  assert.ok(vd.some((d) => /D3|supplement/i.test(d.directive)), "low vitamin D suggests supplementation");
});

test("LOW ferritin fires the iron-deficiency story across nutrition, training, watch", () => {
  // The deterministic per-marker building block of the anemia picture: low iron
  // stores drive iron-rich nutrition, a training-volume caution, and a recheck.
  seedHealthDoc("2025-12-01", [marker("Ferritin", 20, { unit: "ng/mL", flag: "low" })]);
  repo.deriveDirectives();
  const fer = activeFor("Ferritin");
  const domains = new Set(fer.map((d) => d.domain));
  assert.ok(domains.has("nutrition") && domains.has("training") && domains.has("watch"));
  const nut = fer.find((d) => d.domain === "nutrition");
  assert.match(nut.directive, /iron/i);
  const train = fer.find((d) => d.domain === "training");
  assert.match(train.directive, /endurance|easy|volume/i, "training caution while iron is low");
});

test("HIGH ferritin does NOT recommend adding iron (opposite-side guard)", () => {
  seedHealthDoc("2025-12-01", [marker("Ferritin", 400, { unit: "ng/mL", flag: "high" })]);
  repo.deriveDirectives();
  const fer = activeFor("Ferritin");
  assert.ok(fer.length >= 1);
  const nut = fer.find((d) => d.domain === "nutrition");
  if (nut) assert.match(nut.directive, /do not add iron|clinical context/i);
});

test("re-deriving is idempotent — directives never accumulate", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 120, { flag: "high" }),
    marker("Ferritin", 20, { flag: "low" }),
  ]);
  repo.deriveDirectives();
  const first = repo.listActiveDirectives().length;
  assert.ok(first > 0);
  repo.deriveDirectives();
  repo.deriveDirectives();
  assert.equal(repo.listActiveDirectives().length, first, "the 'markers' source is cleared + rewritten each run");
});

test("an in-optimal, unflagged marker yields no directives at all", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 65, { unit: "mg/dL", flag: "normal" })]); // inside [40,80]
  const res = repo.deriveDirectives();
  assert.equal(res.derived, 0);
  assert.equal(repo.listActiveDirectives().length, 0);
});
