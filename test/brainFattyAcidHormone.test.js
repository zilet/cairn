// Whole-panel correlation (src/repo/propagation-data.ts + propagation.ts): the fixes
// grounded in a real Function-Health-style panel (2026-06-11) that produced four bad
// watch cards. (1) the serum "Omega-3 Total / OmegaCheck" measure must resolve to omega
// guidance on its OWN %-by-wt band (distinct from the RBC index band); (2) low essential
// fatty acids read as ONE synthesized cluster story, not scattered per-marker cards;
// (3) a mildly-low TOTAL testosterone with normal Free T / SHBG / LH gets a CALIBRATED
// card, not the alarmist "go confirm a low testosterone"; (4) a borderline rheumatoid
// factor gets a soft mention that folds in an elevated hs-CRP when present.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile", "app_state");
});

const active = () => repo.listActiveDirectives();
const activeFor = (label) => active().filter((d) => (d.marker || "") === label);
const clusterDirs = () => active().filter((d) => String(d.marker || "").includes("+"));
const hasGenericNote = (nameRe) =>
  active().some((d) => nameRe.test(String(d.marker || "")) && /isn't one of the levers/i.test(String(d.directive || "")));

// ---- (1) omega zone naming: serum OmegaCheck vs RBC index -------------------
test("the real OmegaCheck names resolve to the SERUM omega zone on its own %-by-wt band", () => {
  const z = (n) => repo.matchOptimalZone(n);
  // The exact extracted names from the production panel.
  assert.equal(z("Omega-3 Total / OmegaCheck")?.label, "Omega-3 Total");
  assert.equal(z("Omega-3 Total")?.label, "Omega-3 Total");
  assert.equal(z("OmegaCheck")?.label, "Omega-3 Total");
  // The serum measure sits on the OmegaCheck %-by-wt band (>5.5 desirable), NOT the RBC
  // index band [8,12] — a 5.4 %-by-wt value must never be judged against the index band.
  assert.deepEqual(z("OmegaCheck")?.optimal, [5.5, 12]);
  assert.equal(z("OmegaCheck")?.dir, "low");
});

test("the RBC 'Omega-3 Index' keeps its own [8,12] band (precedence with the serum keys)", () => {
  const z = (n) => repo.matchOptimalZone(n);
  assert.equal(z("Omega-3 Index")?.label, "Omega-3 index");
  assert.deepEqual(z("Omega-3 Index")?.optimal, [8, 12]);
  // Longest-substring matching keeps the two apart: neither name leaks into the other zone.
  assert.equal(z("Omega-3 Total")?.label, "Omega-3 Total");
});

test("genuine fatty-acid RATIO names are still refused a serum band (the slash guard holds)", () => {
  // The OmegaCheck exception only exempts the dual-NAME serum measure; real ratios (which
  // carry "ratio") must never be held to a concentration band.
  assert.equal(repo.matchOptimalZone("Omega-6/3 Ratio"), null);
  assert.equal(repo.matchOptimalZone("Arachidonic Acid/EPA Ratio"), null);
});

// ---- (2) essential-fatty-acid cluster ---------------------------------------
test("omega-3 + linoleic low together fire ONE synthesized cluster, not scattered cards", () => {
  seedHealthDoc("2026-06-11", [
    marker("Omega-3 Total / OmegaCheck", 5.4, { unit: "% by wt", flag: "low" }),
    marker("Omega-6: Linoleic Acid", 17.7, { unit: "% by wt", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const cluster = clusterDirs();
  assert.ok(cluster.length >= 1, "the essential-fatty-acid cluster fires");
  const nut = cluster.find((d) => d.domain === "nutrition");
  assert.ok(nut, "the cluster carries a nutrition lever");
  assert.match(nut.directive, /essential fatty acids/i);
  assert.match(nut.directive, /oily fish|EPA\+DHA/i, "names the shared lever");
  assert.ok(cluster.some((d) => d.domain === "watch" && /recheck/i.test(d.directive)), "and a calm recheck");
});

test("the cluster SUPPRESSES the members' individual cards (no scattered omega-3 / linoleic notes)", () => {
  seedHealthDoc("2026-06-11", [
    marker("Omega-3 Total", 5.4, { unit: "% by wt", flag: "low" }),
    marker("Linoleic Acid", 17.7, { unit: "% by wt", flag: "low" }),
  ]);
  repo.deriveDirectives();
  // The standalone serum-omega mapped lever must NOT also appear (it's folded into the cluster).
  assert.equal(activeFor("Omega-3 Total").length, 0, "no standalone omega-3 mapped card alongside the cluster");
  // Linoleic acid must never produce a generic 'not a lever' card.
  assert.equal(hasGenericNote(/linoleic/i), false, "no generic linoleic note");
  assert.equal(activeFor("Linoleic acid").length, 0, "linoleic surfaces only through the cluster");
});

test("a LONE low omega-3 (no linoleic) keeps its individual mapped lever — cluster stays quiet", () => {
  seedHealthDoc("2026-06-11", [marker("Omega-3 Total", 5.4, { unit: "% by wt", flag: "low" })]);
  repo.deriveDirectives();
  assert.equal(clusterDirs().length, 0, "one member isn't enough to fire the cluster");
  const omega = activeFor("Omega-3 Total");
  assert.ok(omega.length >= 1, "the standalone serum-omega lever fires on its own");
  assert.ok(omega.some((d) => d.domain === "nutrition" && /oily fish/i.test(d.directive)));
});

test("a LONE low linoleic acid stays quiet (never a standalone generic card)", () => {
  seedHealthDoc("2026-06-11", [marker("Linoleic Acid", 17.7, { unit: "% by wt", flag: "low" })]);
  repo.deriveDirectives();
  assert.equal(hasGenericNote(/linoleic/i), false, "an isolated low LA is benign — no generic card");
  assert.equal(activeFor("Linoleic acid").length, 0, "and no mapped card (it's cluster-only)");
});

test("two omega-3 measures both low fire the cluster (≥2 members) and dedupe the phrasing", () => {
  seedHealthDoc("2026-06-11", [
    marker("Omega-3 Total", 5.4, { unit: "% by wt", flag: "low" }),
    marker("Omega-3 Index", 6.0, { unit: "%", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const nut = clusterDirs().find((d) => d.domain === "nutrition");
  assert.ok(nut, "two omega-3 members low is enough to fire the cluster");
  // Both are omega-3, so the synthesized text says "omega-3" once, not twice.
  assert.equal((nut.directive.match(/omega-3/gi) || []).length, 1, "omega-3 is not repeated in the read");
});

// ---- (3) hormone-panel correlation ------------------------------------------
const TDATE = "2026-06-11";
const seedTestosterone = (extra = []) =>
  seedHealthDoc(TDATE, [marker("Total Testosterone", 463, { unit: "ng/dL" }), ...extra]);

test("companions NORMAL → a calibrated single watch card, not the alarmist confirm", () => {
  seedTestosterone([
    marker("Free Testosterone", 74.1, { unit: "pg/mL" }),
    marker("SHBG", 25, { unit: "nmol/L" }),
    marker("LH", 4.4, { unit: "mIU/mL" }),
  ]);
  repo.deriveDirectives();
  const t = activeFor("Testosterone");
  assert.equal(t.length, 1, "exactly ONE calibrated card");
  assert.equal(t[0].domain, "watch");
  assert.match(t[0].directive, /free testosterone.*normal|usually unremarkable|routine morning draw/i);
  assert.equal(!!t[0].uncertain, true, "the calibrated read is a soft, uncertain nudge");
  // It must NOT read as the alarmist "confirm a low testosterone" card.
  assert.equal(/confirm a low testosterone/i.test(t[0].directive), false);
});

test("Free T ALSO low → keep the confirm-with-a-morning-repeat card (+ lifestyle levers)", () => {
  seedTestosterone([
    marker("Free Testosterone", 40, { unit: "pg/mL", flag: "low" }),
    marker("SHBG", 25, { unit: "nmol/L" }),
    marker("LH", 4.4, { unit: "mIU/mL" }),
  ]);
  repo.deriveDirectives();
  const t = activeFor("Testosterone");
  const domains = new Set(t.map((d) => d.domain));
  assert.ok(domains.has("training") && domains.has("nutrition") && domains.has("watch"), "the full low-T read");
  assert.ok(t.some((d) => d.domain === "watch" && /morning repeat/i.test(d.directive)), "keeps the confirm card");
});

test("companions ABSENT → keep the confirm card (can't reassure from a lone total)", () => {
  seedTestosterone(); // total T only
  repo.deriveDirectives();
  const t = activeFor("Testosterone");
  assert.ok(t.some((d) => d.domain === "watch" && /morning repeat/i.test(d.directive)), "no companions → confirm");
  assert.ok(t.length >= 2, "the alarmist path keeps its lifestyle levers too");
});

test("companions STALE (>60d apart) → keep the confirm card (a year-old normal doesn't reassure)", () => {
  // Free T / SHBG / LH normal but from a draw ~5 months before the low total.
  seedHealthDoc("2026-01-05", [
    marker("Free Testosterone", 74.1, { unit: "pg/mL" }),
    marker("SHBG", 25, { unit: "nmol/L" }),
    marker("LH", 4.4, { unit: "mIU/mL" }),
  ]);
  seedHealthDoc(TDATE, [marker("Total Testosterone", 463, { unit: "ng/dL" })]);
  repo.deriveDirectives();
  const t = activeFor("Testosterone");
  assert.ok(t.some((d) => d.domain === "watch" && /morning repeat/i.test(d.directive)), "stale companions → confirm");
});

// ---- (4) rheumatoid factor mapping + inflammation link ----------------------
test("a borderline RF gets a soft mention (not a generic 'not a lever' card)", () => {
  seedHealthDoc("2026-06-11", [marker("Rheumatoid Factor", 16, { unit: "IU/mL", flag: "high" })]);
  repo.deriveDirectives();
  const rf = activeFor("Rheumatoid factor");
  assert.equal(rf.length, 1, "one calm watch note");
  assert.equal(rf[0].domain, "watch");
  assert.equal(rf[0].intent_key, "notice", "informational register");
  assert.equal(!!rf[0].uncertain, true);
  assert.match(rf[0].directive, /mentioning at your next visit|rechecking rather than reacting/i);
  assert.equal(/isn't one of the levers/i.test(rf[0].directive), false, "not the generic long-tail card");
  // No hs-CRP in this panel → no inflammation-link clause.
  assert.equal(/hs-CRP is also up/i.test(rf[0].directive), false);
});

test("RF alongside an elevated hs-CRP folds in the inflammation connection", () => {
  seedHealthDoc("2026-06-11", [
    marker("Rheumatoid Factor", 16, { unit: "IU/mL", flag: "high" }),
    marker("hs-CRP", 3.2, { unit: "mg/L", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const rf = activeFor("Rheumatoid factor");
  assert.equal(rf.length, 1, "still ONE card, now inflammation-aware");
  assert.match(rf[0].directive, /hs-CRP is also up/i, "links the two inflammation signals");
});

// ---- idempotence on ALL the new paths ---------------------------------------
test("re-deriving the whole correlated panel is zero-churn (idempotent)", () => {
  seedHealthDoc("2026-06-11", [
    marker("Total Testosterone", 463, { unit: "ng/dL" }),
    marker("Free Testosterone", 74.1, { unit: "pg/mL" }),
    marker("SHBG", 25, { unit: "nmol/L" }),
    marker("LH", 4.4, { unit: "mIU/mL" }),
    marker("Rheumatoid Factor", 16, { unit: "IU/mL", flag: "high" }),
    marker("hs-CRP", 3.2, { unit: "mg/L", flag: "high" }),
    marker("Omega-3 Total / OmegaCheck", 5.4, { unit: "% by wt", flag: "low" }),
    marker("Omega-6: Linoleic Acid", 17.7, { unit: "% by wt", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const first = active().length;
  assert.ok(first >= 5, "the panel produces the cluster + hormone + RF + hs-CRP reads");
  repo.deriveDirectives();
  repo.deriveDirectives();
  assert.equal(active().length, first, "no new rows on repeat derivation");
});
