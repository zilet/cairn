// The Today salience arbiter (Era 2, §12 item 1) — src/repo/today-agenda.ts.
// ONE deterministic ranking + budget pass over the whole Today surface: the Brief
// is always the hero, the top TODAY_PRIMARY_MAX candidates render inline (primary),
// the rest collapse behind one quiet "more". Constitution-critical invariants:
//   - empty data → ONLY the hero (no card invented to fill space)
//   - a candidate whose data is empty is OMITTED (priority <= 0 never surfaces)
//   - more than TODAY_PRIMARY_MAX candidates → exactly MAX in primary, rest in more
//   - everything is sorted by priority desc (primary holds the highest)
//   - one producer throwing never breaks the agenda (each read is isolated)
// todayAgenda is imported via the repo barrel (integrator wires the export);
// app_state + profile are reset so the two sibling Era-2 producers (since-last /
// goal-checkin) stay silent and the candidate set under test is fully controlled.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedIntake } from "./_seed.js";

// Tables every candidate producer reads — wiped to a known floor each case so the
// arbiter sees exactly (and only) what each test seeds.
beforeEach(() => {
  resetTables(
    "food_notes", "insights", "plan_proposals", "health_directives",
    "garmin_activities", "garmin_sources", "sessions", "logged_sets", "activities",
    "plan_days", "plan_items", "bodyweight_log", "app_state", "profile",
  );
});

// ---- the hero is always the Brief; an empty day surfaces nothing else ----
test("a completely empty day → only the Brief hero, nothing else", () => {
  const a = repo.todayAgenda();
  assert.ok(a.hero, "there is always a hero");
  assert.equal(a.hero.id, "brief");
  assert.equal(a.hero.kind, "training");
  assert.equal(a.hero.tier, "hero");
  assert.equal(a.hero.client_card, "brief");
  assert.deepEqual(a.primary, [], "no primary candidates on a quiet day");
  assert.deepEqual(a.more, [], "no more candidates on a quiet day");
  assert.equal(a.total, 0, "total counts only surfaced non-hero candidates");
});

// ---- an empty-data source is omitted (priority <= 0 never surfaces) ----
test("the fuel candidate is omitted when nothing is logged (no 'log something' nudge)", () => {
  // No food logged today → getDayIntake count 0 → fuel must NOT surface. (This is the
  // canonical arbiter principle: the fuel surface is an evaluation glance, never a
  // capture prompt.)
  const a = repo.todayAgenda();
  assert.ok(!a.primary.some((c) => c.id === "fuel"), "fuel absent from primary");
  assert.ok(!a.more.some((c) => c.id === "fuel"), "fuel absent from more");
});

test("the fuel candidate surfaces once there's logged food to evaluate", () => {
  seedIntake(0, 600, { protein_g: 40 }); // one logged item today
  const a = repo.todayAgenda();
  const all = [...a.primary, ...a.more];
  const fuel = all.find((c) => c.id === "fuel");
  assert.ok(fuel, "fuel surfaces when something is logged");
  assert.equal(fuel.client_card, "fuel");
  assert.ok(fuel.priority > 0);
});

// ---- the budget: more than MAX candidates → exactly MAX primary, rest in more,
//      sorted by priority desc ----
test("more than TODAY_PRIMARY_MAX candidates → exactly MAX primary, rest in more, sorted", () => {
  const MAX = repo.TODAY_PRIMARY_MAX;
  assert.ok(MAX >= 1, "the budget is at least one");

  // Seed FOUR distinct candidates of clearly-separated priority:
  //   reconcile  (~86) — a Garmin lift the watch logged, unlinked to a session
  //   draft      (~78) — a plan change waiting for review
  //   weekly     (~54) — a weekly read waiting in-app
  //   connection (~44) — a quiet cross-domain insight
  // Garmin strength activity with no linked session (isStrengthGarminType matches
  // 'strength_training'); date is today so it falls in the 30-day window. Foreign
  // keys are ON, so seed a real source first and reference its id.
  const today = new Date().toISOString().slice(0, 10);
  const src = repo.upsertGarminSource({ label: "default" });
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, type, name, date, session_id)
     VALUES (?, 'ext-9001', 'strength_training', 'Strength', ?, NULL)`
  ).run(src.id, today);
  repo.createProposal("stub", "auto: weekly review", "", { changes: [] }); // draft (default status)
  repo.addInsight({ kind: "weekly_read", text: "Solid week — held three sessions." });
  repo.addInsight({ kind: "connection", text: "Your easy runs cluster after short-sleep nights." });

  const a = repo.todayAgenda();
  assert.equal(a.total, 4, "all four are surfaced");
  assert.equal(a.primary.length, MAX, "exactly MAX render inline");
  assert.equal(a.more.length, 4 - MAX, "the rest collapse behind 'more'");

  // primary holds the highest-priority candidates; every primary outranks every more.
  const minPrimary = Math.min(...a.primary.map((c) => c.priority));
  const maxMore = a.more.length ? Math.max(...a.more.map((c) => c.priority)) : -Infinity;
  assert.ok(minPrimary >= maxMore, "the budget keeps the most important inline");

  // each list is itself sorted by priority desc (stable).
  for (const list of [a.primary, a.more]) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].priority >= list[i].priority, "candidates are priority-sorted");
    }
  }
  // the top surface today is the reconcile card (it has the highest deterministic priority).
  assert.equal(a.primary[0].id, "garmin-reconcile");
  // every surfaced candidate carries a positive priority (the omit rule held).
  assert.ok([...a.primary, ...a.more].every((c) => c.priority > 0));
});

// ---- the arbiter only DEMOTES: a candidate's final tier matches its bucket ----
test("surfaced candidates carry the tier of their bucket (primary vs more)", () => {
  repo.addInsight({ kind: "weekly_read", text: "A calm week." });
  repo.addInsight({ kind: "connection", text: "A small connection." });
  seedIntake(0, 500, { protein_g: 30 });
  const a = repo.todayAgenda();
  assert.ok(a.primary.every((c) => c.tier === "primary"));
  assert.ok(a.more.every((c) => c.tier === "more"));
  assert.equal(a.total, a.primary.length + a.more.length);
});

// ---- one producer throwing never breaks the agenda (each read is isolated) ----
test("a throwing producer is isolated — the agenda still returns the rest", () => {
  // Seed two healthy candidates from INDEPENDENT sources, then force ONE producer to
  // genuinely throw by dropping a table it reads. The reconcile producer reads
  // garmin_activities; with that table gone its SQL throws, and the arbiter's
  // per-producer try/catch (safe()) must still return the hero + the other candidates.
  seedIntake(0, 700, { protein_g: 45 });                       // fuel — independent of garmin
  repo.addInsight({ kind: "connection", text: "A genuine connection." }); // insight — independent

  // Capture the exact CREATE statement so we can restore the table verbatim after —
  // never poisoning the other test files that share this one DB process.
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='garmin_activities'`).get();
  db.exec(`DROP TABLE IF EXISTS garmin_activities`);
  try {
    const a = repo.todayAgenda(); // listUnreconciledGarminStrength throws inside safe()
    assert.ok(a.hero && a.hero.id === "brief", "the hero is always present");
    assert.ok(Array.isArray(a.primary) && Array.isArray(a.more), "the agenda still returns lists");
    // The two healthy candidates survived — one failing source can't sink the rest.
    const ids = [...a.primary, ...a.more].map((c) => c.id);
    assert.ok(ids.includes("fuel"), "fuel still surfaced");
    assert.ok(ids.includes("connection-insight"), "the insight still surfaced");
    // The reconcile candidate (whose source threw) is simply absent — never a crash.
    assert.ok(!ids.includes("garmin-reconcile"), "the throwing source is omitted, not fatal");
  } finally {
    if (ddl && ddl.sql) db.exec(ddl.sql); // restore the table verbatim for sibling suites
  }
});
