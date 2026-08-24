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

test("directiveFreshness: acute markers decay (fast), chronic markers never do", () => {
  const today = "2026-06-23";
  const ago = (n) => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
  // hs-CRP is acute (point-in-time) → stale once clearly old; fresh while recent. The
  // window is short (~10d): an acute reactant reflects the last several days, so a
  // 2-week-old reading must NOT keep capping training every morning.
  assert.equal(repo.directiveFreshness({ marker: "hs-CRP", trigger_date: ago(30) }, today).stale, true);
  assert.equal(repo.directiveFreshness({ marker: "hs-CRP", trigger_date: ago(12) }, today).stale, true);
  assert.equal(repo.directiveFreshness({ marker: "hs-CRP", trigger_date: ago(5) }, today).stale, false);
  assert.equal(repo.directiveFreshness({ marker: "C-Reactive Protein", trigger_date: ago(40) }, today).acute, true);
  // ApoB is chronic/structural → NEVER stale, however old the reading.
  const apob = repo.directiveFreshness({ marker: "ApoB", trigger_date: ago(400) }, today);
  assert.equal(apob.acute, false);
  assert.equal(apob.stale, false);
  // A composite/cluster name dominated by chronic markers (it merely MENTIONS hs-CRP) is
  // NOT acute — its durable lipid advice must never age out.
  const cluster = repo.directiveFreshness({ marker: "ApoB+LDL-C+Lp(a)+hs-CRP+Triglycerides", trigger_date: ago(400) }, today);
  assert.equal(cluster.acute, false);
  assert.equal(cluster.stale, false);
  // Lp(a) is chronic even paired with an acute marker (the guard must match the
  // paren-ending token, not silently fall through and class the pair as acute).
  assert.equal(repo.directiveFreshness({ marker: "Lp(a) + hs-CRP", trigger_date: ago(400) }, today).acute, false);
  // No anchor at all (no trigger_date, no created_at) → age unknown → never silently stale.
  assert.equal(repo.directiveFreshness({ marker: "hs-CRP", trigger_date: null }, today).stale, false);
  // created_at is the fallback anchor, so a health_review directive that never stamped a
  // trigger_date can still age out (the original "stale CRP caps forever" bug).
  assert.equal(repo.directiveFreshness({ marker: "hs-CRP", trigger_date: null, created_at: ago(20) }, today).stale, true);
  // An explicit reading-date anchor (the real LAB date, resolved from marker history) wins.
  assert.equal(repo.directiveFreshness({ marker: "hs-CRP", trigger_date: null }, today, ago(20)).stale, true);
});

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

test("directivesForCoach projects canonical marker display labels for agents", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const coach = repo.directivesForCoach();
  assert.ok(coach.some((d) => d.marker === "Apolipoprotein B (ApoB)"), "agent context uses the same canonical label as marker history/report");
  assert.ok(repo.listActiveDirectives().some((d) => d.marker === "ApoB"), "stored directive identity stays stable");
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

test("a lab-flagged Lp(a) in mg/dL can still drive guidance without fake nmol/L conversion", () => {
  seedHealthDoc("2025-12-01", [marker("Lp(a)", 45, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const lpa = activeFor("Lp(a)");
  assert.ok(lpa.length >= 1, "source high flag still propagates the Lp(a) risk context");
  assert.ok(lpa.every((d) => d.trigger_side === "high"), "source high flag sets the side without raw unit comparison");
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

test("duplicate marker name-variants for one zone emit a single directive per domain (within-run dedup)", () => {
  // "Fasting Glucose" and "Glucose" both map to the "Fasting glucose" optimal zone,
  // so they're two marker entries (getMarkerHistory keys by lowercased name) that
  // resolve to one zone. A directive is about the zone+domain, so the run must NOT
  // emit it once per name-variant — the exact dup pattern seen on live data.
  seedHealthDoc("2025-11-01", [marker("Fasting Glucose", 110, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2025-12-01", [marker("Glucose", 108, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const fg = activeFor("Fasting glucose");
  assert.ok(fg.length >= 1, "the zone produced at least one directive");
  const perDomainDups = fg.length - new Set(fg.map((d) => d.domain)).size;
  assert.equal(perDomainDups, 0, "no duplicate same-domain directives for the zone");
});

test("an in-optimal, unflagged marker yields no directives at all", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 65, { unit: "mg/dL", flag: "normal" })]); // inside [40,80]
  const res = repo.deriveDirectives();
  assert.equal(res.derived, 0);
  assert.equal(repo.listActiveDirectives().length, 0);
});

// ---- review-directive resurface (applyReviewDirectives) ---------------------
// The 'health_review' path used to HARD-skip on ANY prior resolved/dismissed
// feedback — so a finding dismissed at ApoB 95 never came back at ApoB 140. It now
// mirrors the markers path: keep suppressing UNLESS the marker is materially worse.
const reviewWithApoB = (value, date) => {
  seedHealthDoc(date, [marker("ApoB", value, { unit: "mg/dL" })]);
  return repo.addHealthReview(
    {
      headline: "Whole-picture read",
      directives: [{
        domain: "nutrition",
        marker: "ApoB",
        directive: "Lower saturated fat and add soluble fiber to bring ApoB toward optimal.",
        rationale: "ApoB is the atherogenic-particle lever.",
        citation: "AHA/ACC 2018 Cholesterol Guideline",
      }],
    },
    "stub"
  );
};
const activeReviewApoB = () =>
  repo.listActiveDirectives().filter((d) => d.source === "health_review" && (d.marker || "") === "ApoB");

test("a dismissed review finding STAYS suppressed when the marker hasn't worsened", () => {
  reviewWithApoB(95, "2025-01-01");
  const dir = activeReviewApoB()[0];
  assert.ok(dir, "first review emits the ApoB directive");
  repo.updateDirective(dir.id, { status: "dismissed" }); // stamps trigger from ApoB=95
  reviewWithApoB(96, "2025-03-01"); // not materially worse
  assert.equal(activeReviewApoB().length, 0, "stays suppressed at a near-identical value");
});

test("a dismissed review finding RESURFACES when the marker is materially worse", () => {
  reviewWithApoB(95, "2025-01-01");
  const dir = activeReviewApoB()[0];
  repo.updateDirective(dir.id, { status: "dismissed" });
  reviewWithApoB(140, "2025-06-01"); // clearly worse
  const back = activeReviewApoB();
  assert.equal(back.length, 1, "resurfaces on a clear worsening");
  assert.equal(back[0].resurfaced_from_id, dir.id, "links back to the dismissed directive");
  assert.equal(back[0].trigger_value, 140, "stamps the new (worse) trigger value");
});

// ---- optimal-silence, enforced server-side (applyReviewDirectives) ----------
// W4.6: the deterministic 'markers' engine already only fires on off-optimal markers
// (see "an in-optimal, unflagged marker yields no directives at all" above). This
// mirrors that guard onto the agent-emitted 'health_review' path, which has no such
// discipline of its own beyond the prompt's instruction — a model that drifts into
// nudging on an already-optimal reading must not have that directive persisted.
test("a health-review directive for an IN-OPTIMAL marker is dropped, not persisted", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 65, { unit: "mg/dL", flag: "normal" })]); // inside [40,80]
  const saved = repo.addHealthReview(
    {
      headline: "Whole-picture read",
      directives: [
        {
          domain: "nutrition",
          marker: "ApoB",
          directive: "Keep leaning on soluble fiber to nudge ApoB lower.",
          rationale: "Every little bit helps.",
        },
      ],
    },
    "stub"
  );
  assert.ok(saved, "the review itself still saves");
  assert.equal(
    repo.listActiveDirectives().filter((d) => d.source === "health_review" && (d.marker || "") === "ApoB").length,
    0,
    "an in-optimal marker gets no directive, even one the agent emitted"
  );
});

test("a health-review directive for an OUT-OF-OPTIMAL marker still persists", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.addHealthReview(
    {
      headline: "Whole-picture read",
      directives: [
        {
          domain: "nutrition",
          marker: "ApoB",
          directive: "Lower saturated fat and add soluble fiber to bring ApoB toward optimal.",
          rationale: "ApoB is the atherogenic-particle lever.",
        },
      ],
    },
    "stub"
  );
  assert.equal(
    repo.listActiveDirectives().filter((d) => d.source === "health_review" && (d.marker || "") === "ApoB").length,
    1,
    "a genuinely off-optimal finding still gets its directive"
  );
});

// ---- the de-escalation passage (addHealthReview → not_worried) --------------
test("addHealthReview coerces and caps the not_worried de-escalation passage", () => {
  const saved = repo.addHealthReview(
    {
      headline: "Whole-picture read",
      not_worried: {
        markers: ["CK", "ALT", 42, null, ""],
        note: "Both are elevated from recent hard training and have tracked this way before — nothing to act on.",
      },
    },
    "stub"
  );
  assert.ok(saved, "a headline alone is enough to save");
  assert.deepEqual(saved.parsed.not_worried.markers, ["CK", "ALT", "42"], "non-strings coerce, blanks drop");
  assert.match(saved.parsed.not_worried.note, /recent hard training/);
});

test("addHealthReview stores not_worried as null when the agent has nothing to de-escalate", () => {
  const saved = repo.addHealthReview(
    { headline: "Whole-picture read", not_worried: { markers: [], note: "" } },
    "stub"
  );
  assert.equal(saved.parsed.not_worried, null);
});

test("addHealthReview tolerates a missing/malformed not_worried field", () => {
  const saved = repo.addHealthReview({ headline: "Whole-picture read" }, "stub");
  assert.equal(saved.parsed.not_worried, null);
  const malformed = repo.addHealthReview({ headline: "Whole-picture read", not_worried: "not an object" }, "stub");
  assert.equal(malformed.parsed.not_worried, null);
});
