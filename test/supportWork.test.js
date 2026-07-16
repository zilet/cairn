// Wave S — support-work intelligence. When a COMPOUND lift lags, the elite-coach
// read isn't only "rotate the movement": a contributing muscle that's under-trained
// is often the real unlock. These lock the deterministic supportWorkRead (driven off
// the program-state volume bands) AND its wiring into programEvolutionTrigger:
//  - a plateaued bench whose triceps sit below band → one "build the triceps" entry;
//  - the same bench with every band healthy → nothing (calm no-op);
//  - a below-band PRIME mover reads as "the lift's under-practiced", not a synergist;
//  - progressing lifts never appear;
//  - the trigger folds the suggestion in with a STABLE {lift + weak-link} signature
//    (drafts once), re-arming only when the weak link changes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

const REF = "2026-05-01";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

// The five plateau sessions sit inside BOTH the 3-week volume window (last 21 days)
// and a ≥14-day span with ≥4 sessions, so the lift grades a real plateau.
const PLATEAU_DAYS = [20, 15, 10, 5, 0];

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "exercises",
    "activities",
    "plan_items",
    "plan_days",
    "program_blocks",
    "daily_metrics",
    "checkins"
  );
});

// Seed a plateaued bench at a chosen sets/session (same top load every session →
// flat trend, static top load → 'plateaued'). Bench is a horizontal press, so each
// working set also earns triceps + front-delt (shoulders) HALF a set of indirect
// volume — that coupling is what the band math below is tuned against.
function seedPlateauedBench(setsPerSession = 6) {
  for (const d of PLATEAU_DAYS) {
    for (let s = 0; s < setsPerSession; s++) {
      repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 2, date: back(d) });
    }
  }
}

test("a plateaued bench whose triceps sit below band → one entry naming triceps", () => {
  // 30 bench sets → chest 10.0/wk (productive), triceps + shoulders 5.0/wk each (low).
  seedPlateauedBench(6);
  // Lift shoulders OUT of the weak-link zone with direct lateral raises (no indirect
  // triceps), so triceps is the SOLE weak link: +12 sets → shoulders 9.0/wk.
  for (const d of [15, 10, 5]) {
    for (let s = 0; s < 4; s++) {
      repo.logSetByName({ exercise: "Lateral Raise", weight: 25, reps: 15, rir: 2, date: back(d) });
    }
  }

  const out = repo.supportWorkRead(REF);
  assert.equal(out.length, 1, "one lagging compound with an under-trained synergist");
  const e = out[0];
  assert.match(e.lift, /Bench Press/);
  assert.equal(e.status, "plateaued");
  assert.equal(e.prime_gap, false, "the prime mover (chest) is fine — this is a synergist gap");
  assert.ok(
    e.weak_links.some((w) => w.muscle_group === "triceps" && w.band === "low"),
    "triceps is flagged as the below-band weak link"
  );
  assert.ok(!e.weak_links.some((w) => w.muscle_group === "shoulders"), "shoulders are productive — not flagged");
  assert.match(e.suggestion, /triceps/i, "the coaching sentence names triceps");
  assert.match(e.suggestion, /Bench Press/, "and names the stalled lift");
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(e.suggestion), "no 0-100 score leaks into the suggestion");
  assert.match(e.signature, /support:bench press:triceps/, "stable {lift + weak-link} digest");
});

test("the same bench with every contributing band healthy → nothing to suggest", () => {
  seedPlateauedBench(6);
  // Shoulders healthy (lateral raises) AND triceps healthy (direct pushdowns → 7.0/wk).
  for (const d of [15, 10, 5]) {
    for (let s = 0; s < 4; s++) {
      repo.logSetByName({ exercise: "Lateral Raise", weight: 25, reps: 15, rir: 2, date: back(d) });
    }
    for (let s = 0; s < 2; s++) {
      repo.logSetByName({ exercise: "Triceps Pushdown", weight: 50, reps: 12, rir: 2, date: back(d) });
    }
  }

  const out = repo.supportWorkRead(REF);
  assert.deepEqual(out, [], "no under-trained contributor → calm no-op");
});

test("a below-band PRIME mover reads as under-practiced, not a synergist gap", () => {
  // Only 2 bench sets/session → chest ~3.3/wk (low). The lift itself is under-practiced.
  seedPlateauedBench(2);

  const out = repo.supportWorkRead(REF);
  assert.equal(out.length, 1);
  const e = out[0];
  assert.equal(e.prime_gap, true, "the prime mover (chest) is the gap");
  assert.ok(e.weak_links.some((w) => w.muscle_group === "chest"), "chest is the below-band group");
  assert.match(e.suggestion, /chest/i, "the sentence points at the prime mover");
  assert.ok(!/triceps/i.test(e.suggestion), "it does NOT blame a synergist");
  assert.match(e.suggestion, /under-practiced/i, "framed as the lift simply needing more practice");
  assert.match(e.signature, /support:bench press:chest:prime/, "prime-gap digest");
});

test("progressing lifts never surface support work", () => {
  // Rising top load every session → 'progressing', even though chest volume is thin.
  const loads = { 20: 175, 15: 180, 10: 185, 5: 190, 0: 195 };
  for (const d of PLATEAU_DAYS) {
    for (let s = 0; s < 3; s++) {
      repo.logSetByName({ exercise: "Bench Press", weight: loads[d], reps: 5, rir: 2, date: back(d) });
    }
  }

  const out = repo.supportWorkRead(REF);
  assert.deepEqual(out, [], "a climbing lift is not lagging — no support-work read");
});

test("supportWorkRead degrades to [] when there is no volume picture", () => {
  // A minimal injected state (a stalled lift but no volume rows) can't reason about
  // weak links — quiet no-op, never a throw.
  const out = repo.supportWorkRead(REF, {
    programState: { lifts: [{ exercise: "Bench Press", status: "plateaued", weeks_static: 3 }] },
  });
  assert.deepEqual(out, []);
});

// ---- the evolution-trigger wiring ------------------------------------------
// Pure/injectable (mirrors the other programEvolutionTrigger cases): a lagging
// compound with an under-trained synergist makes the plan-evolution loop `due`,
// with a plain reason and a stable signature so it drafts ONCE.
test("the evolution trigger fires support work with a stable signature", () => {
  const picture = {
    programState: {
      lifts: [{ exercise: "Barbell Bench Press", status: "plateaued", weeks_static: 3, sessions: 6 }],
      volume: [
        { muscle_group: "chest", weekly_sets: 12, band: "productive", trend: "stable" },
        { muscle_group: "triceps", weekly_sets: 3, band: "low", trend: "stable" },
        { muscle_group: "shoulders", weekly_sets: 10, band: "productive", trend: "stable" },
      ],
    },
    balance: { due: [], over: [] },
    testWeek: { due: false },
    enduranceTests: [],
    trainingPlaybook: null,
  };

  const out = repo.programEvolutionTrigger("2026-06-26", picture);
  assert.equal(out.due, true);
  assert.match(out.reasons.join(" "), /Barbell Bench Press/);
  assert.match(out.reasons.join(" "), /triceps/i);
  assert.match(out.signature, /support:bench press:triceps/);
  assert.ok(!/\[object Object\]/.test(JSON.stringify(out)), "never leaks [object Object]");

  // Same picture → identical signature (a standing weak link drafts once, not daily).
  const again = repo.programEvolutionTrigger("2026-06-26", picture);
  assert.equal(again.signature, out.signature, "unchanged picture keeps the signature stable");

  // The weak link moves to shoulders → the signature re-arms (drafts again).
  const shifted = repo.programEvolutionTrigger("2026-06-26", {
    ...picture,
    programState: {
      lifts: picture.programState.lifts,
      volume: [
        { muscle_group: "chest", weekly_sets: 12, band: "productive", trend: "stable" },
        { muscle_group: "triceps", weekly_sets: 9, band: "productive", trend: "stable" },
        { muscle_group: "shoulders", weekly_sets: 5, band: "low", trend: "stable" },
      ],
    },
  });
  assert.match(shifted.signature, /support:bench press:shoulders/, "a new weak link is a new signature");
  assert.notEqual(shifted.signature, out.signature, "the standing condition re-arms only on a changed picture");
});

test("a productive synergist that is merely drifting down is NOT a weak link (no signature churn)", () => {
  const benchLift = { exercise: "Barbell Bench Press", status: "plateaued", weeks_static: 3, sessions: 6 };
  const base = (tricepsTrend) => ({
    programState: {
      lifts: [benchLift],
      volume: [
        { muscle_group: "chest", weekly_sets: 12, band: "productive", trend: "stable" },
        { muscle_group: "triceps", weekly_sets: 9, band: "productive", trend: tricepsTrend },
        { muscle_group: "shoulders", weekly_sets: 10, band: "productive", trend: "stable" },
      ],
    },
    balance: { due: [], over: [] },
    testWeek: { due: false },
    enduranceTests: [],
    trainingPlaybook: null,
  });

  // Direct read: a productive-band triceps drifting down earns no support entry.
  assert.deepEqual(repo.supportWorkRead("2026-06-26", { programState: base("falling").programState }), []);

  // And the trigger signature is identical whether that productive group is falling
  // or stable — the sliding-window trend flip can't churn the draft.
  const falling = repo.programEvolutionTrigger("2026-06-26", base("falling"));
  const stable = repo.programEvolutionTrigger("2026-06-26", base("stable"));
  assert.equal(falling.signature, stable.signature, "a productive+falling group does not alter the signature");
  assert.ok(!/support:/.test(falling.signature), "no support-work part enters the signature for a productive group");
  assert.equal(falling.due, false, "nothing material — calm no-op");
});

test("multiple lagging lifts return in a deterministic, input-order-independent sequence", () => {
  const volume = [
    { muscle_group: "chest", weekly_sets: 12, band: "productive", trend: "stable" },
    { muscle_group: "triceps", weekly_sets: 3, band: "low", trend: "stable" },
    { muscle_group: "shoulders", weekly_sets: 10, band: "productive", trend: "stable" },
    { muscle_group: "quads", weekly_sets: 14, band: "productive", trend: "stable" },
    { muscle_group: "glutes", weekly_sets: 3, band: "low", trend: "stable" },
    { muscle_group: "core", weekly_sets: 10, band: "productive", trend: "stable" },
  ];
  const benchLift = { exercise: "Barbell Bench Press", status: "plateaued", weeks_static: 3, sessions: 6 };
  const squatLift = { exercise: "Back Squat", status: "regressing", sessions: 7 };

  const a = repo.supportWorkRead("2026-06-26", { programState: { lifts: [benchLift, squatLift], volume } });
  const b = repo.supportWorkRead("2026-06-26", { programState: { lifts: [squatLift, benchLift], volume } });

  // Sorted by signature: "back squat" (b-a) sorts before "bench press" (b-e).
  const sigs = ["support:back squat:glutes", "support:bench press:triceps"];
  assert.deepEqual(
    a.map((e) => e.signature),
    sigs,
    "entries are sorted by their stable signature"
  );
  assert.deepEqual(
    b.map((e) => e.signature),
    a.map((e) => e.signature),
    "the returned order is independent of the input lift order"
  );

  // The composed evolution signature is likewise order-independent.
  const opts = (lifts) => ({
    programState: { lifts, volume },
    balance: { due: [], over: [] },
    testWeek: { due: false },
    enduranceTests: [],
    trainingPlaybook: null,
  });
  const ta = repo.programEvolutionTrigger("2026-06-26", opts([benchLift, squatLift]));
  const tb = repo.programEvolutionTrigger("2026-06-26", opts([squatLift, benchLift]));
  assert.equal(ta.signature, tb.signature, "trigger signature is stable regardless of lift ordering");
});
