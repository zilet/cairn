import { db } from "./db.js";
import { installSeedArt } from "./art.js";

// [name, muscle_group, constraint_note, form_cues]
const exercises: [string, string, string | null, string][] = [
  ["Back Squat", "legs", null, "Brace on a big breath, sit between the hips, knees track over toes, drive the floor away. Hip crease below the knee."],
  ["Leg Extension", "quads", null, "Toes neutral, pause at lockout, control the negative, no swinging from the seat."],
  ["Leg Curl", "hamstrings", null, "Hips pinned down, curl with the hamstrings not the lower back, squeeze, slow eccentric."],
  ["Standing Calf Raise", "calves", null, "Full stretch at the bottom, pause, drive up onto the big toe, no bouncing."],
  ["Seated DB Overhead Press", "shoulders", null, "Ribs down, press slightly back over the ears, don't flare the elbows, full lockout."],
  ["Incline DB Press", "chest", null, "~30° incline, shoulder blades retracted, elbows ~45°, stretch then drive. Brace and breathe."],
  ["Lateral Raise", "shoulders", null, "Lead with the elbows, slight forward lean, no shrug, control the descent."],
  ["Triceps Rope Pushdown", "triceps", null, "Pin the elbows, neutral wrist, spread the rope at the bottom, stop short of end-range lock."],
  ["Assisted Pull-Up", "back", null, "Neutral grip, depress the shoulders first, chest toward the bar, full hang."],
  ["Barbell Bent-Over Row", "back", null, "Hinge to ~45°, neutral spine, pull to the belly, elbows in. Straps from set 2 if grip limits."],
  ["Lat Pulldown", "back", "Neutral/close grip.", "Neutral or close grip, drive the elbows down and back, chest up, control the stretch."],
  ["Face Pull", "rear delts", null, "High elbows, pull toward the eyes, externally rotate at the end, light and controlled."],
  ["Hammer Curl", "biceps", null, "Neutral grip, elbows pinned to the sides, no swing or supination."],
  ["Romanian Deadlift", "posterior", "New lift — start light; add straps if grip is the limiter.", "Soft knees, push the hips back, bar dragging the legs, feel the hamstring stretch, neutral spine."],
  ["Seated Cable Row", "back", "Neutral handle, straps from set 2, no chest pad.", "Neutral handle, tall chest, pull to the navel, no torso rock. Straps from set 2."],
  ["Bulgarian Split Squat", "legs", null, "Weight on the front foot, slight torso lean, knee tracks the toes, controlled depth. Per leg."],
  ["Seated Calf Raise", "calves", null, "Full stretch at the bottom, pause at the top, slow tempo, knees over toes."],
];

type Item = [string, number, number | null, number | null, number | null, string | null];
const days: [number, string, string, Item[]][] = [
  [1, "Lower A", "Quad-dominant", [
    ["Back Squat", 3, 8, 10, 190, "Top of range x3 @ RIR 2 before +5lb."],
    ["Leg Extension", 3, 12, 12, 135, "Superset with leg curl."],
    ["Leg Curl", 3, 12, 12, 135, "Superset with leg extension."],
    ["Standing Calf Raise", 3, 15, 15, null, "Slow stretch; short rest finisher."],
  ]],
  [2, "Push", "Shoulders / chest / triceps", [
    ["Seated DB Overhead Press", 3, 8, 10, 40, "Big jump from 35; build reps if 40 stalls."],
    ["Incline DB Press", 3, 8, 10, 42, "Secondary lift, ~30 deg. Pre-fatigued = lighter, that's fine."],
    ["Lateral Raise", 3, 15, 15, 17, "Superset."],
    ["Triceps Rope Pushdown", 3, 12, 12, null, "Rope, neutral wrist."],
  ]],
  [3, "Pull", "Back / rear delts / biceps", [
    ["Assisted Pull-Up", 3, 6, 8, -30, "Reduce assist from -40 to -30."],
    ["Barbell Bent-Over Row", 3, 8, 10, 140, "Straps from set 2."],
    ["Lat Pulldown", 3, 12, 12, null, "Neutral grip."],
    ["Face Pull", 3, 15, 15, null, "Light, controlled."],
    ["Hammer Curl", 3, 12, 12, 27, "Neutral grip only."],
  ]],
  [4, "Lower B", "Hinge / posterior chain", [
    ["Romanian Deadlift", 3, 8, 10, 135, "NEW - start at 135, log actual, report back."],
    ["Leg Curl", 3, 12, 12, 135, "Match Day 1."],
    ["Bulgarian Split Squat", 3, 10, 10, null, "Per leg; BW or light DBs."],
    ["Seated Calf Raise", 3, 15, 15, null, null],
  ]],
  [5, "Full Body", "Lighter, quality reps", [
    ["Back Squat", 3, 8, 8, 160, "~85% of Day 1; technique focus."],
    ["Seated Cable Row", 3, 12, 12, null, "Neutral, straps from set 2."],
    ["Seated DB Overhead Press", 3, 10, 10, 37, null],
    ["Lateral Raise", 3, 15, 15, 17, "Superset."],
    ["Hammer Curl", 3, 12, 12, 27, "Superset."],
  ]],
];

export function seed() {
  const insertEx = db.prepare(`INSERT INTO exercises (name, muscle_group, constraint_note, cues) VALUES (?, ?, ?, ?)`);
  const exId: Record<string, number> = {};
  const dayIdByNumber: Record<number, number> = {};
  const insertDay = db.prepare(`INSERT INTO plan_days (day_number, name, focus) VALUES (?, ?, ?)`);
  const insertItem = db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSet = db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN");
  try {
    for (const [name, mg, note, cues] of exercises) {
      exId[name] = Number(insertEx.run(name, mg, note, cues).lastInsertRowid);
    }
    for (const [num, name, focus, items] of days) {
      const dayId = Number(insertDay.run(num, name, focus).lastInsertRowid);
      dayIdByNumber[num] = dayId;
      items.forEach((it, i) => {
        const [exName, sets, lo, hi, tw, note] = it;
        insertItem.run(dayId, i, exId[exName], sets, lo, hi, tw, note);
      });
    }

    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const baselineSessionId = Number(
      db.prepare(`INSERT INTO sessions (date, plan_day_id, duration_min, notes) VALUES (?, ?, ?, ?)`)
        .run(yesterday, dayIdByNumber[1], 55, "Seed baseline: completed Lower A so Today can propose the next training day.")
        .lastInsertRowid
    );
    const baselineSets: [string, number, number | null, number, number | null][] = [
      ["Back Squat", 1, 190, 8, 2],
      ["Back Squat", 2, 190, 8, 2],
      ["Back Squat", 3, 190, 8, 3],
      ["Leg Extension", 1, 135, 12, 2],
      ["Leg Extension", 2, 135, 12, 2],
      ["Leg Extension", 3, 135, 12, 2],
      ["Leg Curl", 1, 135, 12, 2],
      ["Leg Curl", 2, 135, 12, 2],
      ["Leg Curl", 3, 135, 12, 2],
      ["Standing Calf Raise", 1, null, 15, 2],
      ["Standing Calf Raise", 2, null, 15, 2],
      ["Standing Calf Raise", 3, null, 15, 2],
    ];
    for (const [exName, setNo, weight, reps, rir] of baselineSets) {
      insertSet.run(baselineSessionId, exId[exName], setNo, weight, reps, rir, "Seed baseline");
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // Example starter profile — clearly a placeholder. Replace it with your own
  // numbers in the Me tab (or during first-run onboarding). A lean-safe goal
  // (~0.8 lb/wk) so the goal check and Energy Balance views have something real
  // to render out of the box.
  const goalDate = new Date(Date.now() + 84 * 864e5).toISOString().slice(0, 10);
  db.prepare(
    `INSERT OR REPLACE INTO profile (id, sex, age, height_cm, weight_lb, goal_weight_lb, goal_date, activity_factor, notes, updated_at)
     VALUES (1, 'male', 35, 178.0, 185, 175, ?, 1.5, 'Example profile — edit this in the Me tab to match you.', datetime('now'))`
  ).run(goalDate);
}

export function seedIfEmpty(): boolean {
  // "Empty" must mean a pristine, never-initialized DB — NOT merely "no plan
  // days." A user can delete every plan day in-app (deletePlanDay is a feature),
  // and an exercise catalog persists independently; keying only on plan_days
  // would then re-run seed() on a populated DB and throw on the UNIQUE exercise
  // name. Seed only when neither the plan nor the exercise catalog exists.
  const days = db.prepare(`SELECT COUNT(*) AS c FROM plan_days`).get() as any;
  const exs = db.prepare(`SELECT COUNT(*) AS c FROM exercises`).get() as any;
  if (days.c > 0 || exs.c > 0) return false;
  seed();
  // Drop in any pre-baked studio photos that match the seeded exercises, so a
  // fresh install renders real art (not just SVGs) with no Gemini key. Offline,
  // idempotent, and a no-op when the seed-art/ pack isn't present.
  try {
    installSeedArt();
  } catch {
    /* art is purely cosmetic — never let it block seeding */
  }
  return true;
}

// CLI entry: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const did = seedIfEmpty();
  console.log(did ? `Seeded 5 days, ${exercises.length} exercises.` : "Already seeded. Use `npm run reset` to rebuild.");
}
