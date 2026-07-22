// Directive-sourced rechecks: marking a recheck directive Done ("Retest lipids in
// ~12 weeks", "Confirm testosterone with a morning repeat") schedules a real
// follow-up on the adaptive attention engine, which then closes the loop when a new
// reading lands — instead of the watch card just vanishing. Deterministic + offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker } from "./_seed.js";

function reset() {
  // health_directives + attention_schedule are the state under test; health_documents
  // feeds getMarkerHistory; app_state holds the derive signature + feedback counter.
  db.prepare("DELETE FROM health_directives").run();
  db.prepare("DELETE FROM attention_schedule").run();
  db.prepare("DELETE FROM health_documents").run();
  db.prepare("DELETE FROM app_state").run();
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const recheckRows = () =>
  db.prepare("SELECT * FROM attention_schedule WHERE source = 'directive-recheck'").all();

// ---- horizon parsing (the real phrasings) ----
test("parseRecheckHorizonDays reads the real directive phrasings, far end of a range", () => {
  assert.equal(repo.parseRecheckHorizonDays("Retest lipids in ~12 weeks"), 84);
  assert.equal(repo.parseRecheckHorizonDays("Recheck ApoB in ~12 weeks after diet changes"), 84);
  assert.equal(repo.parseRecheckHorizonDays("repeat the panel in 3-4 months"), 120); // far end
  assert.equal(repo.parseRecheckHorizonDays("repeat the panel in ~3-4 months"), 120); // far end, tilde
  assert.equal(repo.parseRecheckHorizonDays("Confirm with a morning repeat"), null); // no timeframe
  assert.equal(repo.parseRecheckHorizonDays("recheck in 6 weeks"), 42);
  assert.equal(repo.parseRecheckHorizonDays("recheck annually"), 365);
});

// ---- Done → entry creation, horizon from text ----
test("Done on a recheck directive schedules a follow-up at the parsed horizon", () => {
  reset();
  const d = repo.addDirective({
    source: "markers",
    marker: "LDL-C",
    domain: "watch",
    directive: "Retest lipids in ~12 weeks; discuss persistent elevation with your doctor.",
    intent_key: "recheck",
  });
  assert.equal(recheckRows().length, 0, "nothing scheduled until the user acts");

  repo.updateDirective(d.id, { status: "resolved", status_at: "2026-05-01" });

  const key = repo.directiveRecheckSignalKey("LDL-C");
  const entry = repo.getAttentionSchedule(key);
  assert.ok(entry, "a directive-recheck attention entry exists after Done");
  assert.equal(entry.source, "directive-recheck");
  assert.equal(entry.tier, "active");
  assert.equal(daysBetween("2026-05-01", entry.next_due), 84, "next_due is status_at + parsed 12-week horizon");
});

// ---- horizon falls back to the per-marker-class default when text has no timeframe ----
test("no timeframe in the text → the per-marker-class default horizon", () => {
  reset();
  // Hormone class default is ~4 weeks — the testosterone "morning repeat" case.
  const t = repo.addDirective({ marker: "Testosterone", domain: "watch", directive: "Confirm with a morning repeat", intent_key: "recheck" });
  repo.updateDirective(t.id, { status: "resolved", status_at: "2026-05-01" });
  assert.equal(daysBetween("2026-05-01", repo.getAttentionSchedule(repo.directiveRecheckSignalKey("Testosterone")).next_due), 28);

  // Lipid class default is ~12 weeks.
  const l = repo.addDirective({ marker: "ApoB", domain: "watch", directive: "Recheck ApoB", intent_key: "recheck" });
  repo.updateDirective(l.id, { status: "resolved", status_at: "2026-05-01" });
  assert.equal(daysBetween("2026-05-01", repo.getAttentionSchedule(repo.directiveRecheckSignalKey("ApoB")).next_due), 84);
});

// ---- a dismiss is not a recheck; a lever directive is not a recheck ----
test("dismiss never schedules, and a non-recheck (lever) directive never schedules", () => {
  reset();
  const dismissed = repo.addDirective({ marker: "LDL-C", domain: "watch", directive: "Retest lipids in ~12 weeks", intent_key: "recheck" });
  repo.updateDirective(dismissed.id, { status: "dismissed", status_at: "2026-05-01" });
  assert.equal(recheckRows().length, 0, "dismiss means 'not relevant' — no retest scheduled");

  const lever = repo.addDirective({ marker: "LDL-C", domain: "nutrition", directive: "Cut saturated fat and add soluble fibre.", intent_key: "lever" });
  repo.updateDirective(lever.id, { status: "resolved", status_at: "2026-05-01" });
  assert.equal(recheckRows().length, 0, "a lifestyle lever is not a recheck");
});

// ---- Done via the Wave-1 cascade twin still schedules ----
test("Done cascaded to a twin schedules the recheck from the flipped directive", () => {
  reset();
  // Two active directives sharing identity (canonical marker, domain, intent) — a
  // deterministic 'markers' one and its agent 'health_review' echo.
  const engine = repo.addDirective({ source: "markers", marker: "ApoB", domain: "watch", directive: "Retest ApoB in ~12 weeks.", intent_key: "recheck" });
  const review = repo.addDirective({ source: "health_review", marker: "ApoB", domain: "watch", directive: "Recheck ApoB with your doctor in ~12 weeks.", intent_key: "recheck" });

  // Flip the review twin; the cascade resolves the engine twin, and the hook schedules.
  repo.updateDirective(review.id, { status: "resolved", status_at: "2026-05-01" });
  assert.equal(repo.getDirective(engine.id).status, "resolved", "cascade resolved the twin");
  assert.equal(recheckRows().length, 1, "exactly one recheck entry for the shared marker");
  assert.ok(repo.getAttentionSchedule(repo.directiveRecheckSignalKey("ApoB")));
});

// ---- repeated Done never duplicates ----
test("repeated Done + a derive/refresh cycle never duplicates the entry", () => {
  reset();
  const d = repo.addDirective({ marker: "LDL-C", domain: "watch", directive: "Retest lipids in ~12 weeks", intent_key: "recheck" });
  repo.updateDirective(d.id, { status: "active" }); // toggle
  repo.updateDirective(d.id, { status: "resolved", status_at: "2026-05-01" });
  repo.updateDirective(d.id, { status: "active" });
  repo.updateDirective(d.id, { status: "resolved", status_at: "2026-05-10" });
  seedHealthDoc("2026-04-01", [marker("LDL-C", 160, { unit: "mg/dL", flag: "high" })]);
  repo.refreshDoctorLoopAttention();
  repo.refreshDoctorLoopAttention();
  assert.equal(recheckRows().length, 1, "one row per marker, keyed by signal_key");
});

// ---- the /directives annotation ----
test("annotateDirectiveRecheck attaches scheduled-recheck state to the directive row", () => {
  reset();
  const d = repo.addDirective({ marker: "LDL-C", domain: "watch", directive: "Retest lipids in ~12 weeks", intent_key: "recheck" });
  repo.updateDirective(d.id, { status: "resolved", status_at: "2026-05-01" });

  const rows = repo.annotateDirectiveRecheck(repo.listDirectives({ all: true }), "2026-05-15");
  const row = rows.find((r) => r.id === d.id);
  assert.ok(row.recheck, "the recheck annotation is attached");
  assert.equal(row.recheck.scheduled, true);
  assert.equal(row.recheck.next_due, "2026-07-24");
  assert.equal(row.recheck.due, false);

  // Once the window opens, `due` flips.
  const later = repo.annotateDirectiveRecheck(repo.listDirectives({ all: true }), "2026-08-01");
  assert.equal(later.find((r) => r.id === d.id).recheck.due, true);
  assert.equal(later.find((r) => r.id === d.id).recheck.when_text, "recheck window is open");
});

// ---- close the loop on a new reading ----
test("a new reading advances the entry; back-in-optimal heads toward released and never re-nags", () => {
  reset();
  const d = repo.addDirective({ marker: "Testosterone", domain: "watch", directive: "Confirm with a morning repeat", intent_key: "recheck" });
  repo.updateDirective(d.id, { status: "resolved", status_at: "2026-05-01" });
  const key = repo.directiveRecheckSignalKey("Testosterone");
  assert.equal(repo.getAttentionSchedule(key).tier, "active");

  // A recheck reading, back in the optimal band, lands after the window.
  seedHealthDoc("2026-06-05", [marker("Testosterone", 650, { unit: "ng/dL" })]);
  repo.refreshDoctorLoopAttention();
  let entry = repo.getAttentionSchedule(key);
  assert.equal(entry.tier, "confirming", "a clean recheck moves it off active, toward released");
  assert.equal(entry.last_checked, "2026-06-05");
  // No re-nag right after the recheck.
  assert.equal(
    repo.listDueAttention("2026-06-12", { limit: 50 }).some((x) => x.signal_key === key),
    false
  );

  // Re-running the refresh with the SAME reading is a no-op (idempotent).
  repo.refreshDoctorLoopAttention();
  assert.equal(repo.getAttentionSchedule(key).tier, "confirming");

  // A run of further clean readings eventually releases the entry entirely.
  for (const [date, val] of [["2026-08-01", 660], ["2026-11-01", 670], ["2027-02-01", 680]]) {
    seedHealthDoc(date, [marker("Testosterone", val, { unit: "ng/dL" })]);
    repo.refreshDoctorLoopAttention();
  }
  entry = repo.getAttentionSchedule(key);
  assert.equal(entry.tier, "released", "sustained clean rechecks release the follow-up (it goes quiet)");
  assert.equal(entry.next_due, null);
});

// ---- still-off reading keeps the recheck live ----
test("a recheck that is still off keeps the follow-up scheduled rather than releasing it", () => {
  reset();
  const d = repo.addDirective({ marker: "Testosterone", domain: "watch", directive: "Confirm with a morning repeat", intent_key: "recheck" });
  repo.updateDirective(d.id, { status: "resolved", status_at: "2026-05-01" });
  const key = repo.directiveRecheckSignalKey("Testosterone");

  seedHealthDoc("2026-06-05", [marker("Testosterone", 300, { unit: "ng/dL", flag: "low" })]);
  repo.refreshDoctorLoopAttention();
  const entry = repo.getAttentionSchedule(key);
  assert.equal(entry.tier, "active", "still off → stays active");
  assert.equal(entry.last_checked, "2026-06-05");
  assert.equal(daysBetween("2026-06-05", entry.next_due), 28, "another window opens from the new reading");
});

// ---- end-to-end: the testosterone case must work through the real derive engine ----
test("end-to-end: derive → Done → due ~4w → new reading closes the loop (testosterone)", () => {
  reset();
  seedHealthDoc("2026-05-01", [marker("Testosterone", 320, { unit: "ng/dL", flag: "low" })]);
  repo.deriveDirectives();
  const watch = repo.listDirectives().find((x) => /testosterone/i.test(x.marker || "") && x.domain === "watch");
  assert.ok(watch, "the deterministic engine derived a testosterone watch directive");
  // It classifies as a lever, yet the Done-hook still recognizes the morning-repeat recheck.
  assert.match(String(watch.directive), /morning repeat/i);

  repo.updateDirective(watch.id, { status: "resolved", status_at: "2026-05-10" });
  const key = repo.directiveRecheckSignalKey("Testosterone");
  const entry = repo.getAttentionSchedule(key);
  assert.ok(entry, "scheduling the recheck worked through the real directive text");
  assert.equal(daysBetween("2026-05-10", entry.next_due), 28, "due about four weeks out (hormone default)");

  seedHealthDoc("2026-06-08", [marker("Testosterone", 640, { unit: "ng/dL" })]);
  repo.refreshDoctorLoopAttention();
  assert.equal(repo.getAttentionSchedule(key).tier, "confirming", "the recheck reading closed the loop");
});
