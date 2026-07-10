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
import { db, isoDaysAgo, localDaysAgo, repo, resetTables, seedHealthDoc, seedIntake, marker } from "./_seed.js";

// Tables every candidate producer reads — wiped to a known floor each case so the
// arbiter sees exactly (and only) what each test seeds.
beforeEach(() => {
  resetTables(
    "food_notes",
    "insights",
    "plan_proposals",
    "health_directives",
    "garmin_activities",
    "garmin_sources",
    "sessions",
    "logged_sets",
    "activities",
    "plan_days",
    "plan_items",
    "bodyweight_log",
    "app_state",
    "profile",
    "day_reads",
    "brain_evaluations",
    "brain_expectations",
    "brain_decisions"
  );
});

test("an announced structural change appears calmly with a working chat hold-on path", () => {
  const decision = repo.recordDecision({
    effective_date: localDaysAgo(-3),
    kind: "training_structure",
    domain: "training",
    summary: "Shift the next block toward dumbbell pressing.",
    rationale: "Your recent barbell pattern is stalled while the chest wall is still sensitive.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: "42",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    input_fingerprint: null,
    context: null,
    action: { proposal_id: 42 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
  const agenda = repo.todayAgenda();
  const card = [...agenda.primary, ...agenda.more].find((item) => item.id === `announced-decision-${decision.id}`);
  assert.equal(card?.kicker, "NEXT BOUNDARY");
  assert.equal(card?.action?.label, "Hold on");
  assert.equal(card?.action?.kind, "hold-decision", "hold is a deterministic one-tap cancel, not a chat prefill");
  assert.equal(Number(card?.action?.payload), decision.id);
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

test("agenda-only draft, health, and running candidates render as generic cards", () => {
  repo.createProposal("stub", "auto: weekly review", "", { changes: [] });
  repo.savePlanDay(1, "Run", "Endurance", [
    { kind: "cardio", exercise: "Long run", target_distance_km: 16 },
  ]);
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  repo.saveDayRead(localDaysAgo(0), { kind: "train", headline: "Train", why: "normal plan day" });

  const agenda = repo.todayAgenda();
  const all = [...agenda.primary, ...agenda.more];
  const byId = (id) => all.find((c) => c.id === id);

  assert.equal(byId("draft-proposals")?.client_card, undefined, "drafts must not name an unmounted rail slot");
  assert.equal(byId("draft-proposals")?.action?.kind, "plan-coach");
  assert.ok(byId("draft-proposals")?.title);

  assert.equal(byId("health-focus")?.client_card, undefined, "health focus must render as generic agenda copy");
  assert.equal(byId("health-focus")?.action?.kind, "me-health-read");
  assert.ok(byId("health-focus")?.title);

  assert.equal(byId("run-compliance")?.client_card, undefined, "run compliance must render as generic agenda copy");
  assert.equal(byId("run-compliance")?.action?.kind, "plan-endurance");
  assert.ok(byId("run-compliance")?.title);
});

test("rest or easy Brief suppresses plan-forward agenda cards", () => {
  repo.savePlanDay(1, "Run", "Endurance", [
    { kind: "cardio", exercise: "Easy run", target_distance_km: 10 },
  ]);
  repo.savePlanDay(2, "Push", "Shoulders", [
    { exercise: "Lateral Raise", sets: 3, rep_low: 12, rep_high: 15, target_weight: 20 },
  ]);
  repo.saveDayRead(localDaysAgo(0), { kind: "train", headline: "Train", why: "normal plan day" });

  const openAgenda = repo.todayAgenda(localDaysAgo(0));
  const openIds = [...openAgenda.primary, ...openAgenda.more].map((c) => c.id);
  assert.ok(openIds.includes("week-ahead"), "precondition: plan-forward cards can surface on a normal plan day");
  assert.ok(openIds.includes("run-compliance"), "precondition: running compliance can surface on a normal plan day");

  for (const kind of ["rest", "easy"]) {
    resetTables("day_reads");
    repo.saveDayRead(localDaysAgo(0), { kind, headline: kind, why: "athlete chose recovery" });
    const agenda = repo.todayAgenda(localDaysAgo(0));
    const ids = [...agenda.primary, ...agenda.more].map((c) => c.id);

    assert.equal(agenda.hero.id, "brief", "the Brief still leads the day");
    assert.ok(!ids.includes("program-adjustments"), `${kind} day omits program adjustments`);
    assert.ok(!ids.includes("week-ahead"), `${kind} day omits the week-ahead training card`);
    assert.ok(!ids.includes("run-compliance"), `${kind} day omits running compliance`);
  }
});

test("cold same-day Brief cache does not speculate with plan-forward agenda cards", () => {
  repo.savePlanDay(1, "Run", "Endurance", [
    { kind: "cardio", exercise: "Easy run", target_distance_km: 10 },
  ]);
  resetTables("day_reads");

  const agenda = repo.todayAgenda(localDaysAgo(0));
  const ids = [...agenda.primary, ...agenda.more].map((c) => c.id);

  assert.equal(agenda.hero.id, "brief");
  assert.ok(!ids.includes("week-ahead"));
  assert.ok(!ids.includes("run-compliance"));
});

test("a routed Today date anchors weekly producers to that week", () => {
  repo.savePlanDay(1, "Run", "Endurance", [
    { kind: "cardio", exercise: "Easy run", target_distance_km: 10 },
  ]);
  repo.addActivity({ type: "run", date: isoDaysAgo(0), duration_min: 50, distance_km: 10 });

  const pastAgenda = repo.todayAgenda("2026-01-07");
  const past = [...pastAgenda.primary, ...pastAgenda.more];
  const pastRun = past.find((c) => c.id === "run-compliance");

  assert.equal(pastRun?.title, "0 of 10 km this week", "past Today links do not borrow the current week's run");
  assert.ok(!past.some((c) => c.id === "lately"), "past Today links do not surface current-week activity as lately");

  repo.saveDayRead(localDaysAgo(0), { kind: "train", headline: "Train", why: "normal plan day" });
  const liveAgenda = repo.todayAgenda(isoDaysAgo(0));
  const liveRun = [...liveAgenda.primary, ...liveAgenda.more].find((c) => c.id === "run-compliance");
  assert.equal(liveRun?.title, "10 of 10 km this week", "the live week still reads the current run");
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
