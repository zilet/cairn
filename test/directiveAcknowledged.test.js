// "DONE" ON A FINDING THAT STILL STANDS IS AN ACKNOWLEDGEMENT, NOT A CURE.
//
// The athlete tapped Done on their lipid directives meaning "got it" — and the engine
// read it as "fixed": a lab's Done held the directive back until the next draw, so for
// weeks no lipid guidance reached a single meal or training prompt while ApoB sat far
// above optimal. These pin the corrected law:
//   - a Done on a reading that still stands keeps the guidance IN EFFECT (every coaching
//     read sees it) as an ACKNOWLEDGED row — never a new to-do, never a fresh insert;
//   - it retires when a newer draw no longer calls for it;
//   - a Dismiss ("not relevant") still suppresses, until the marker is materially worse;
//   - a materially worse newer draw still resurfaces it as news;
//   - the state already on disk (every lipid row resolved by hand, same draw) comes back
//     into effect on the next pass, with no data migration.
// And the wearable half: a thin HRV week is no verdict, so it neither retires nor mints.
// Synthetic values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, isoDaysAgo, localDaysAgo, marker, repo, seedHealthDoc } from "./_seed.js";
import { renderConnectedBrain } from "../dist/prompt/shared.js";

const rowCount = () => Number(db.prepare(`SELECT COUNT(*) AS n FROM health_directives`).get().n);
const apob = () => repo.listActiveDirectives().filter((d) => d.marker === "ApoB");
// The coach projection prints the canonical display name ("Apolipoprotein B").
const coachApoB = () => repo.directivesForCoach().filter((d) => /apo/i.test(String(d.marker)));
const healthAgendaCard = () => {
  const agenda = repo.todayAgenda();
  return [...agenda.primary, ...agenda.more].find((c) => c.id === "health-focus");
};

// ---- 1. Done on a standing reading: in effect, acknowledged, no churn, not new ----

test("a Done on a lab directive whose draw still stands stays in effect for coaching, acknowledged", () => {
  seedHealthDoc(isoDaysAgo(30), [
    marker("ApoB", 134, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 173, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const before = repo.listActiveDirectives();
  assert.ok(before.length >= 3, "the panel raised lipid directives");
  assert.ok(healthAgendaCard(), "an unacknowledged finding is news on Today");

  // The athlete taps "Got it" on every card, one by one (the person path).
  for (const d of before) {
    const back = repo.setDirectiveStatusByUser(d.id, "resolved");
    assert.equal(back.status, "active", "the tap comes back still in effect");
    assert.equal(back.acknowledged, true, "…and acknowledged");
  }
  const rows = rowCount();

  const after = repo.listActiveDirectives();
  assert.deepEqual(
    after.map((d) => d.id).sort(),
    before.map((d) => d.id).sort(),
    "the same rows stay in effect — nothing retired, nothing re-inserted"
  );
  assert.ok(
    after.every((d) => d.acknowledged === true),
    "every one reads as acknowledged"
  );

  const coach = coachApoB();
  assert.ok(coach.length >= 1, "ApoB guidance still reaches the coach context");
  assert.ok(
    coach.every((d) => d.acknowledged === true),
    "…marked as already acknowledged"
  );
  const block = renderConnectedBrain({ directives: repo.directivesForCoach() }, { domains: ["nutrition"] });
  assert.match(block, /DERIVED HEALTH DIRECTIVES/, "the meal prompt still honors the lipid levers");
  assert.match(block, /athlete acknowledged — still in effect/, "…without re-announcing them as news");

  // Re-derive repeatedly (bypassing the short-circuit): no duplicate, no churn.
  for (let pass = 0; pass < 3; pass++) {
    repo.setAppState("directive_derive_sig", "");
    repo.deriveDirectives();
  }
  assert.equal(rowCount(), rows, "no pass inserts a duplicate active row");
  assert.deepEqual(
    repo
      .listActiveDirectives()
      .map((d) => [d.id, d.acknowledged])
      .sort(),
    after.map((d) => [d.id, true]).sort(),
    "the acknowledged set is untouched"
  );

  assert.equal(healthAgendaCard(), undefined, "an acknowledged finding is not presented as new on Today");
});

// ---- 2. a newer draw back in optimal retires it ----

test("a newer draw back inside optimal retires an acknowledged directive", () => {
  seedHealthDoc(isoDaysAgo(60), [marker("ApoB", 134, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const [first] = apob();
  repo.setDirectiveStatusByUser(first.id, "resolved");
  assert.equal(repo.getDirective(first.id).acknowledged, true, "acknowledged, in effect");
  assert.ok(coachApoB().length >= 1);

  seedHealthDoc(isoDaysAgo(2), [marker("ApoB", 72, { unit: "mg/dL" })]);
  repo.deriveDirectives();
  assert.equal(apob().length, 0, "no ApoB directive is in effect once the newer draw is optimal");
  assert.equal(coachApoB().length, 0, "…and none reaches coaching");
  assert.equal(repo.getDirective(first.id).status, "resolved", "the row retires (history kept)");
});

// ---- 3. Dismiss keeps today's suppression ----

test("a Dismiss suppresses the directive — out of coaching — until the marker is materially worse", () => {
  seedHealthDoc(isoDaysAgo(30), [marker("ApoB", 134, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const [target] = apob();
  const back = repo.setDirectiveStatusByUser(target.id, "dismissed");
  assert.equal(back.status, "dismissed", "a dismissal is never kept in effect");
  const sameKey = () => repo.listActiveDirectives().filter((d) => d.directive_key === target.directive_key);
  assert.equal(sameKey().length, 0);
  assert.equal(
    repo.directivesForCoach().filter((d) => d.directive_key === target.directive_key).length,
    0,
    "a dismissed directive does not reach coaching"
  );
  repo.setAppState("directive_derive_sig", "");
  repo.deriveDirectives();
  assert.equal(sameKey().length, 0, "it stays suppressed across passes");

  seedHealthDoc(isoDaysAgo(1), [marker("ApoB", 190, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  assert.equal(sameKey().length, 1, "a materially worse draw brings it back");
  assert.equal(sameKey()[0].acknowledged, false);
});

// ---- 4. a materially worse newer draw resurfaces an acknowledged directive ----

test("a materially worse newer draw resurfaces an acknowledged directive as news", () => {
  seedHealthDoc(isoDaysAgo(60), [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const watch = apob().find((d) => d.domain === "watch");
  repo.setDirectiveStatusByUser(watch.id, "resolved");
  assert.equal(repo.getDirective(watch.id).acknowledged, true);

  seedHealthDoc(isoDaysAgo(1), [marker("ApoB", 160, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const now = apob().filter((d) => d.domain === "watch");
  assert.equal(now.length, 1, "exactly one watch directive is in effect");
  assert.notEqual(now[0].id, watch.id, "the worsening is a NEW row (news gets a row)");
  assert.equal(now[0].acknowledged, false, "…in front of the athlete again");
  assert.equal(now[0].resurfaced_from_id, watch.id, "linked to the acknowledged row it follows");
  assert.equal(now[0].trigger_value, 160);
});

test("a newer draw that is still off but not worse re-opens the acknowledged row as a to-do", () => {
  seedHealthDoc(isoDaysAgo(60), [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const watch = apob().find((d) => d.domain === "watch");
  repo.setDirectiveStatusByUser(watch.id, "resolved");

  seedHealthDoc(isoDaysAgo(1), [marker("ApoB", 122, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const row = repo.getDirective(watch.id);
  assert.equal(row.status, "active", "the same row carries the new panel");
  assert.equal(row.acknowledged, false, "a new panel is news: it is a to-do again");
  assert.equal(row.trigger_value, 122);
  assert.equal(row.resurfaced_from_id ?? null, null, "never linked to itself");
});

// ---- 5. the state already on disk comes back into effect, no migration ----

test("live-shaped state (every lipid row Done by hand on the same draw) is back in effect on the next pass", () => {
  const draw = isoDaysAgo(32);
  seedHealthDoc(draw, [
    marker("ApoB", 134, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 173, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 102.8, { unit: "mg/dL", flag: "high" }),
    marker("hs-CRP", 3.4, { unit: "mg/L", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const engineRows = repo.listActiveDirectives();
  assert.ok(engineRows.length >= 4, "the lipid panel raised its directives");
  // An agent-emitted echo of one of them, as the health review writes.
  repo.addDirective({
    source: "health_review",
    domain: "watch",
    marker: "ApoB",
    directive: "Retest a full lipid panel in about 12 weeks and discuss it with your doctor.",
    trigger_value: 134,
    trigger_side: "high",
    trigger_date: draw,
  });
  // What the old engine left on disk: every row resolved BY HAND within two minutes
  // (status_at stamped), the markers still off, no newer draw.
  const stamp = `${isoDaysAgo(25)} 13:59:00`;
  db.prepare(`UPDATE health_directives SET status = 'resolved', status_at = ? WHERE status = 'active'`).run(stamp);
  assert.equal(repo.listActiveDirectives().length, 0, "nothing in effect — the reported bug");
  // The old engine's stored signature; the upgraded pass must not short-circuit on it.
  repo.setAppState("directive_derive_sig", "pre-upgrade-signature");
  const rows = rowCount();

  repo.deriveDirectives();
  const back = repo.listActiveDirectives();
  const ids = new Set(back.map((d) => d.id));
  for (const d of engineRows) assert.ok(ids.has(d.id), `${d.marker}/${d.domain} is back in effect on its own row`);
  assert.ok(
    back.every((d) => d.acknowledged === true),
    "…as acknowledged guidance, not as new to-dos"
  );
  assert.equal(rowCount(), rows, "no row was written — the athlete's own rows came back");
  assert.ok(
    back.every((d) => d.status_at === stamp),
    "the athlete's Done time is kept"
  );
  assert.ok(
    repo.directivesForCoach().some((d) => d.domain === "nutrition" && /ApoB|LDL/.test(String(d.marker))),
    "lipid guidance reaches the meal prompts again"
  );
  assert.equal(healthAgendaCard(), undefined, "and none of it is announced as new on Today");
});

// ---- the wearable half: a thin HRV week is no verdict ----

test("a thin HRV week neither retires nor re-mints the HRV directive", () => {
  for (let i = 3; i >= 1; i--) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 40 });
  repo.deriveDirectives();
  const [row] = repo.listActiveDirectives().filter((d) => d.marker === "HRV");
  assert.ok(row, "a below-band week raised the HRV directive");
  const rows = rowCount();

  // The athlete stops wearing it to bed for a stretch: the week thins below three nights
  // while the series is still current.
  db.prepare(`DELETE FROM garmin_daily_metrics WHERE date IN (?, ?)`).run(localDaysAgo(3), localDaysAgo(2));
  repo.deriveDirectives();
  repo.deriveWearableDirectives();
  assert.equal(repo.getDirective(row.id).status, "active", "a thin week is no verdict — the row is held");

  // A full week again, still below band: the SAME row, not a fresh one.
  for (let i = 3; i >= 2; i--) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 40 });
  repo.deriveDirectives();
  repo.deriveWearableDirectives();
  assert.deepEqual(
    repo
      .listActiveDirectives()
      .filter((d) => d.marker === "HRV")
      .map((d) => d.id),
    [row.id],
    "the same row stands"
  );
  assert.equal(rowCount(), rows, "no row minted, none retired and re-minted");
});

test("an HRV series with no current readings still lets its directive retire", () => {
  for (let i = 3; i >= 1; i--) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 40 });
  repo.deriveDirectives();
  const [row] = repo.listActiveDirectives().filter((d) => d.marker === "HRV");
  assert.ok(row);
  // The watch has been in a drawer: only a reading well past the sensor-age bound.
  db.prepare(`DELETE FROM garmin_daily_metrics`).run();
  repo.upsertGarminDailyMetric({ date: localDaysAgo(30), hrv_ms: 40 });
  repo.deriveDirectives();
  assert.equal(repo.getDirective(row.id).status, "resolved", "a stale series reads as absent and retires");
  assert.equal(repo.getDirective(row.id).status_at, null, "a machine retire, never a Done");
});

// ---- "since you last looked" never calls an acknowledgement a close-out ----

test("a Got it on a standing finding is not announced as 'you closed out' — a real close-out still is", () => {
  const sqlAgo = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
  seedHealthDoc(isoDaysAgo(30), [marker("ApoB", 134, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const [watch] = apob().filter((d) => d.domain === "watch");
  // Its agent-emitted echo, which the Done cascades onto under the same stamp.
  repo.addDirective({
    source: "health_review",
    domain: "watch",
    marker: "ApoB",
    directive: "Retest a full lipid panel in about 12 weeks and discuss it with your doctor.",
  });
  db.prepare(`UPDATE health_documents SET created_at = ?`).run(sqlAgo(2 * 864e5));
  db.prepare(`UPDATE health_directives SET created_at = ?`).run(sqlAgo(2 * 864e5));
  repo.setAppState("today_last_seen_at", sqlAgo(60 * 60 * 1000));

  repo.setDirectiveStatusByUser(watch.id, "resolved");
  assert.equal(repo.getDirective(watch.id).acknowledged, true);
  const c = repo.sinceLastLookedCandidate();
  assert.ok(!c || !/closed out/i.test(String(c.title)), "an acknowledgement is not a close-out");

  // (Move that tap ten minutes back so the next one cannot share its one-second stamp.)
  db.prepare(`UPDATE health_directives SET status_at = ? WHERE status_at IS NOT NULL`).run(sqlAgo(10 * 60 * 1000));
  assert.ok(!repo.sinceLastLookedCandidate() || !/closed out/i.test(String(repo.sinceLastLookedCandidate().title)));
  // A marker-less agent note has no standing reading to keep it in effect: its Done closes it.
  const note = repo.addDirective({
    source: "health_review",
    domain: "watch",
    directive: "Keep a regular sleep window.",
  });
  const closed = repo.setDirectiveStatusByUser(note.id, "resolved");
  assert.equal(closed.status, "resolved", "nothing keeps a marker-less note in effect");
  assert.match(String(repo.sinceLastLookedCandidate()?.title), /closed out/i, "a real close-out still reads as one");
});
