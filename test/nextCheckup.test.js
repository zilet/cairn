// The "Next checkup" read (src/repo/next-checkup.ts) — the athlete-facing
// composition over the doctor-loop. It folds the deterministic recheck-cadence
// engine + supplement/directive → marker links into { due_now, upcoming,
// follow_through, prep }. Invariants:
//   - due/upcoming come from the attention schedule + recommendedPanel
//   - follow_through joins active supplements AND directives to their target
//     markers, with plain status words and no numeric scores
//   - prep composes ordered labs (review follow-ups + a conservative visit-note
//     scan) + what to bring + what to ask, deterministically
//   - an empty DB yields calm empty shapes and never throws
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "health_documents",
    "health_directives",
    "health_reviews",
    "attention_schedule",
    "supplements",
    "blood_pressure_readings",
    "weight_log",
    "marker_aliases",
    "profile"
  );
});

test("nextCheckupRead composes all four sections from seeded data", () => {
  // ApoB elevated across three dated readings, falling toward optimal (a real
  // trend). The latest reading is old enough that the 84-day lipid window has
  // opened by the as-of date, so the recheck is due.
  seedHealthDoc("2025-11-01", [marker("ApoB", 145, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2026-01-15", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2026-03-15", [marker("ApoB", 112, { unit: "mg/dL", flag: "high" })]);
  // an active cross-domain directive on ApoB (the connected brain)
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "Prioritize soluble fiber and oily fish.",
    status: "active",
  });
  // an active supplement pointed at ApoB / LDL-C (psyllium → lipids)
  repo.addSupplement({ name: "Fiber (psyllium)", related_markers: ["LDL-C", "ApoB"], frequency: "daily" });

  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-01" });

  // due_now: the ApoB recheck window is open (last read 2026-03-15 + 84d = 2026-06-07).
  assert.ok(read.due_now.some((i) => /apob/i.test(i.label)), "ApoB recheck is due");
  const apobDue = read.due_now.find((i) => /apob/i.test(i.label));
  assert.equal(apobDue.when_text, "window is open");
  assert.equal(apobDue.kind, "lab");

  // upcoming: recommendedPanel folds in high-value workups still worth adding.
  assert.ok(read.upcoming.some((i) => i.kind === "add"), "worth-adding workups appear in upcoming");

  // follow_through: ApoB joins BOTH the supplement and the directive, and reads
  // as moving your way (falling toward optimal), with the recheck flagged due.
  const ft = read.follow_through.find((f) => /apob/i.test(f.marker));
  assert.ok(ft, "ApoB follow-through present");
  assert.ok(ft.via.some((v) => /psyllium/i.test(v)), "psyllium is credited");
  assert.ok(ft.via.some((v) => /plan/i.test(v)), "the directive is credited");
  assert.equal(ft.status, "moving_your_way");
  assert.equal(ft.status_text, "moving your way");
  assert.equal(ft.recheck, "due");
  assert.equal(ft.trend_dir, "falling");
  assert.match(String(ft.latest_value), /112/);

  // prep: a question about the due recheck, and a calm bring list.
  assert.ok(read.prep.questions.some((q) => /apob/i.test(q)), "prep asks about the due recheck");
  assert.ok(read.prep.bring.length > 0, "prep suggests what to bring");

  assert.equal(read.has_content, true);
  assert.match(read.lede, /apob/i);
  assert.ok(read.frame.includes("Informational"));

  // No numeric grade/score leaks anywhere in the serialized read.
  const serialized = JSON.stringify(read);
  assert.doesNotMatch(serialized, /impact_score/);
});

test("upcoming lists a dated recheck opening in the future with a plain horizon", () => {
  // A clean-but-borderline marker under an active supplement lever → active tier,
  // next_due in the future. Use a recent reading so the window hasn't opened yet.
  seedHealthDoc("2026-06-20", [marker("Vitamin D", 34, { unit: "ng/mL" })]);
  repo.addSupplement({ name: "Vitamin D3", related_markers: ["Vitamin D"], frequency: "daily" });
  repo.addDirective({ source: "markers", domain: "watch", marker: "Vitamin D", directive: "Recheck after a dose window.", status: "active" });

  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-01" });
  const vd = read.upcoming.find((i) => /vitamin d/i.test(i.label) && i.next_due);
  assert.ok(vd, "an upcoming dated vitamin D recheck is listed");
  assert.match(String(vd.when_text), /^opens in about /);
  assert.equal(read.due_now.some((i) => /vitamin d/i.test(i.label)), false);
});

test("a single reading reads as awaiting the first recheck", () => {
  seedHealthDoc("2026-05-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.addSupplement({ name: "Fiber (psyllium)", related_markers: ["ApoB"], frequency: "daily" });
  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-01" });
  const ft = read.follow_through.find((f) => /apob/i.test(f.marker));
  assert.ok(ft);
  assert.equal(ft.status, "awaiting_recheck");
  assert.equal(ft.status_text, "awaiting the first recheck");
});

test("prep surfaces ordered labs from a recent visit note, deterministically", () => {
  db.prepare(
    `INSERT INTO health_documents (kind, doc_date, summary, parsed_json, enrichment_status)
     VALUES ('visit_note', '2026-07-07', ?, '{"markers":[]}', 'done')`
  ).run("Adult patient visit. Plan: will obtain a lipid panel, Lp(a), and ApoB at the next draw.");

  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-10" });
  const labels = read.prep.ordered_labs.map((o) => o.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes("lipid panel")), "lipid panel is picked up");
  assert.ok(labels.some((l) => l.includes("lp(a)")), "Lp(a) is picked up");
  assert.ok(labels.some((l) => l.includes("apob")), "ApoB is picked up");
  assert.ok(read.prep.ordered_labs.every((o) => o.source === "visit_note"));
  assert.equal(read.has_content, true, "an ordered lab raises the read");
});

test("a visit note without an order-context word is NOT mined for labs", () => {
  db.prepare(
    `INSERT INTO health_documents (kind, doc_date, summary, parsed_json, enrichment_status)
     VALUES ('visit_note', '2026-07-07', ?, '{"markers":[]}', 'done')`
  ).run("Office visit. Reviewed prior lipid panel and ApoB results; no changes discussed.");
  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-10" });
  assert.deepEqual(read.prep.ordered_labs, [], "no order context → no guessed labs");
});

test("ordered-labs scan captures the real-world uppercase order list", () => {
  db.prepare(
    `INSERT INTO health_documents (kind, doc_date, summary, parsed_json, enrichment_status)
     VALUES ('visit_note', '2026-07-07', ?, '{"markers":[]}', 'done')`
  ).run("Future labs ordered: LIPID PANEL, LIPOPROTEIN A, APOLIPOPROTEIN B");
  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-10" });
  const labels = read.prep.ordered_labs.map((o) => o.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes("lipid panel")), "lipid panel captured");
  assert.ok(labels.some((l) => l.includes("lp(a)")), "Lp(a) captured");
  assert.ok(labels.some((l) => l.includes("apob")), "ApoB captured");
});

// Regression for defect (a): short abbreviations must match as whole words, and
// bare alt/ast are dropped — so substrings inside "health"/"salt"/"fasting" never
// phantom-order a Liver-function panel, even with an order word elsewhere.
test("ordered-labs scan does not phantom a panel from a substring inside a word", () => {
  db.prepare(
    `INSERT INTO health_documents (kind, doc_date, summary, parsed_json, enrichment_status)
     VALUES ('visit_note', '2026-07-07', ?, '{"markers":[]}', 'done')`
  ).run("Plan: will repeat imaging in 6 months. Patient in good health, reports salt sensitivity; fasting tolerated well.");
  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-10" });
  assert.deepEqual(read.prep.ordered_labs, [], "alt/ast substrings in health/salt/fasting must not order Liver function");
});

// Regression for defect (b): an order word and a panel name must sit in the SAME
// clause — a reviewed-then-planned note must not attribute the reviewed panels.
test("ordered-labs scan requires clause proximity, not document co-occurrence", () => {
  db.prepare(
    `INSERT INTO health_documents (kind, doc_date, summary, parsed_json, enrichment_status)
     VALUES ('visit_note', '2026-07-07', ?, '{"markers":[]}', 'done')`
  ).run("Reviewed lipid panel and CBC from March, all stable. Plan: repeat DEXA in 6 months.");
  const read = repo.nextCheckupRead({ refresh: true, asOf: "2026-07-10" });
  assert.deepEqual(read.prep.ordered_labs, [], "a reviewed panel in a different clause is not an order");
});

// The nightly scheduler op owns the attention-schedule refresh; the read is
// read-only by default, so a client open never triggers the write pass.
test("nextCheckupRead reads the persisted schedule when refresh is off", () => {
  seedHealthDoc("2026-03-15", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  // No refresh + nothing has populated the schedule yet → nothing is due.
  const cold = repo.nextCheckupRead({ refresh: false, asOf: "2026-07-01" });
  assert.equal(cold.due_now.length, 0, "a read without refresh never writes the schedule itself");
  // The op (or an explicit refresh) populates it; the read then reflects it.
  repo.refreshDoctorLoopAttention();
  const warm = repo.nextCheckupRead({ refresh: false, asOf: "2026-07-01" });
  assert.ok(warm.due_now.some((i) => /apob/i.test(i.label)), "the read surfaces the persisted recheck");
});

// Item 1: marker-level dedupe — a marker's cadence recheck and a review follow-up on
// that same marker are one story, not two rows.
test("a marker's cadence recheck and a review follow-up on the same marker dedupe to one", () => {
  const asOf = "2026-07-10";
  repo.upsertAttentionSchedule({
    signal_key: "marker:hs-crp",
    domain: "health",
    tier: "active",
    next_due: "2026-07-01", // due first
    last_checked: "2026-04-01",
    reason: "hs-CRP is off optimal; recheck after the inflammation window.",
    release_condition: "clean",
    source: "doctor-loop",
    state: {},
  });
  repo.upsertAttentionSchedule({
    signal_key: "review-followup:hs-crp:recheck-hs-crp-when-rested",
    domain: "health",
    tier: "active",
    next_due: "2026-07-05", // also due, but later
    last_checked: "2026-04-01",
    reason: "Health review follow-up: Recheck hs-CRP (when rested).",
    release_condition: "the follow-up lands",
    source: "health_review",
    state: {},
  });
  const read = repo.nextCheckupRead({ refresh: false, asOf });
  // Only the RECHECK signals for hs-CRP (a cadence `marker:` or a `review-followup:`),
  // not the "add:" missing-workup suggestion which is a separate concern.
  const hs = [...read.due_now, ...read.upcoming].filter((i) => /^(marker|review-followup):hs-crp/.test(i.signal_key));
  assert.equal(hs.length, 1, "the two hs-CRP recheck signals collapse to one checkup item");
  assert.equal(hs[0].signal_key, "marker:hs-crp", "the sooner (cadence) recheck wins");
});

// Item 2: two different review follow-ups must read as their two different actions,
// not one hardcoded "Lab follow-up from your last review" line.
test("review follow-ups read as their own human action, never one generic label", () => {
  const asOf = "2026-07-10";
  repo.upsertAttentionSchedule({
    signal_key: "review-followup:hs-crp:recheck-hs-crp",
    domain: "health",
    tier: "active",
    next_due: "2026-07-01",
    last_checked: "2026-04-01",
    reason: "Health review follow-up: Recheck hs-CRP (when rested).",
    release_condition: "x",
    source: "health_review",
    state: {},
  });
  repo.upsertAttentionSchedule({
    signal_key: "review-followup:ferritin:recheck-ferritin",
    domain: "health",
    tier: "active",
    next_due: "2026-07-02",
    last_checked: "2026-04-01",
    reason: "Health review follow-up: Recheck ferritin after iron repletion.",
    release_condition: "x",
    source: "health_review",
    state: {},
  });
  const read = repo.nextCheckupRead({ refresh: false, asOf });
  const labels = read.due_now.map((i) => i.label);
  assert.ok(labels.includes("Recheck hs-CRP"), "hs-CRP follow-up reads as its action");
  assert.ok(labels.some((l) => /^Recheck ferritin/i.test(l)), "ferritin follow-up reads as its own action");
  assert.ok(
    !labels.every((l) => l === "Lab follow-up from your last review"),
    "the two follow-ups are not one identical generic label"
  );
});

// Item 3: the DEXA re-scan reads as a soft suggestion window (matching Train's
// forward timeline), never a bare "window is open" due date.
test("the DEXA re-scan reads as a suggestion window, not an appointment", () => {
  const asOf = "2026-07-10";
  // A flagged body-comp DEXA baseline → an active dexa attention signal + a re-scan window.
  seedHealthDoc("2026-04-01", [marker("Body Fat %", 33, { unit: "%", flag: "high" })], "dexa");
  repo.refreshDoctorLoopAttention();
  const read = repo.nextCheckupRead({ refresh: false, asOf });
  const dexa = [...read.due_now, ...read.upcoming].find((i) => i.kind === "dexa");
  assert.ok(dexa, "a DEXA re-scan item is present");
  assert.match(dexa.when_text, /worth considering around /, "DEXA reads as a soft window");
  assert.doesNotMatch(String(dexa.when_text), /window is open|opens in/, "never a bare due-date phrase");
  assert.ok(dexa.next_due, "attention's next_due stays the scheduling key");
});

// Item 1 (fix): two DIFFERENT non-marker follow-ups are both filed under the
// "lab-follow-up" sentinel slug — that sentinel must NOT be a dedupe key, or one is
// silently dropped. They dedupe on their full signal_key instead and both survive.
test("two different non-marker review follow-ups both survive (no sentinel-slug collision)", () => {
  const asOf = "2026-07-10";
  repo.upsertAttentionSchedule({
    signal_key: "review-followup:lab-follow-up:repeat-sleep-study",
    domain: "health",
    tier: "active",
    next_due: "2026-07-01",
    last_checked: "2026-04-01",
    reason: "Health review follow-up: Repeat sleep study.",
    release_condition: "x",
    source: "health_review",
    state: {},
  });
  repo.upsertAttentionSchedule({
    signal_key: "review-followup:lab-follow-up:repeat-colonoscopy",
    domain: "health",
    tier: "active",
    next_due: "2026-07-02",
    last_checked: "2026-04-01",
    reason: "Health review follow-up: Repeat colonoscopy.",
    release_condition: "x",
    source: "health_review",
    state: {},
  });
  const read = repo.nextCheckupRead({ refresh: false, asOf });
  const reviewItems = read.due_now.filter((i) => i.kind === "review");
  assert.equal(reviewItems.length, 2, "both non-marker follow-ups survive the sentinel dedupe");
  assert.ok(reviewItems.some((i) => /^Repeat sleep study/.test(i.label)), "the sleep-study follow-up is present");
  assert.ok(reviewItems.some((i) => /^Repeat colonoscopy/.test(i.label)), "the colonoscopy follow-up is present");
});

// Item 3 (fix): an OVERDUE flagged body-comp — its 12–16-week window already past — must
// not render a nonsensical PAST date range; it reads as due/overdue, matching Train's
// timeline (which drops the stale window entirely).
test("an overdue DEXA re-scan reads as due, never a past dated window", () => {
  const asOf = "2026-07-10";
  seedHealthDoc("2026-01-01", [marker("Body Fat %", 33, { unit: "%", flag: "high" })], "dexa");
  repo.refreshDoctorLoopAttention();
  const read = repo.nextCheckupRead({ refresh: false, asOf });
  const dexa = [...read.due_now, ...read.upcoming].find((i) => i.kind === "dexa");
  assert.ok(dexa, "the overdue DEXA re-scan still surfaces");
  assert.match(dexa.when_text, /window is open/, "reads as due/overdue");
  assert.doesNotMatch(String(dexa.when_text), /\b(Jan|Feb|Mar|Apr|May)\b/, "no past-month date in when_text");
});

test("nextCheckupRead is calm and empty on a fresh DB, never throwing", () => {
  const read = repo.nextCheckupRead({ refresh: true });
  assert.deepEqual(read.due_now, []);
  assert.deepEqual(read.follow_through, []);
  assert.deepEqual(read.prep.ordered_labs, []);
  assert.ok(Array.isArray(read.upcoming));
  assert.equal(read.has_content, false);
  assert.ok(read.lede.length > 0);
  assert.ok(read.frame.includes("Informational"));
});
