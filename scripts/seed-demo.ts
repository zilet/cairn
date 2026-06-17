// Demo/representative history backfill for a dev database.
//
//   npx tsx scripts/seed-demo.ts
//
// REPLACES the journal tables (sessions/logged_sets, activities, bodyweight_log,
// food_notes) with ~10 weeks of plausible history ending today: a 184 -> 170 lb
// cut with a mid-way plateau, 4-5 training sessions a week following the seeded
// plan with progressive loads (incl. a deload week), weekend cardio, and a few
// recent food notes. Plan, exercises, profile, meal plans, memory, chat, health
// docs, and context events are left untouched.
import { db, todayISO } from "../src/db.js";

const WEEKS = 10;
const START_LB = 184.0;
const END_LB = 170.0;

// Deterministic PRNG so reruns produce the same "random" history.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260611);

const today = todayISO();
const todayMs = Date.parse(today + "T00:00:00Z");
const dow = (new Date(todayMs).getUTCDay() + 6) % 7; // 0 = Monday
const thisMonday = todayMs - dow * 864e5;
const startMonday = thisMonday - (WEEKS - 1) * 7 * 864e5;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const round5 = (v: number) => Math.round(v / 5) * 5;
const smooth = (x: number) => x * x * (3 - 2 * x); // smoothstep

console.log(`Backfilling ${WEEKS} weeks (${iso(startMonday)} → ${today})…`);

db.exec("BEGIN");
try {
  for (const t of ["logged_sets", "sessions", "activities", "bodyweight_log", "food_notes"]) {
    db.exec(`DELETE FROM ${t}`);
  }

  // ---- bodyweight: 184 -> 170 with noise and a week-4/5 plateau ----
  const totalDays = (todayMs - startMonday) / 864e5;
  const insBw = db.prepare(`INSERT INTO bodyweight_log (date, weight_lb, note, created_at) VALUES (?, ?, NULL, ? || ' 07:05:00')`);
  let bwCount = 0;
  for (let d = 0; d <= totalDays; d += 2) {
    let frac = smooth(d / totalDays);
    const week = d / 7;
    if (week > 3.5 && week < 5.5) frac = smooth(3.9 / (WEEKS - 1)); // the stall everyone hits
    let w = START_LB - (START_LB - END_LB) * frac + (rnd() - 0.5) * 0.8;
    if (d >= totalDays) w = END_LB; // land exactly on the story's current weight
    const date = iso(startMonday + d * 864e5);
    insBw.run(date, Math.round(w * 10) / 10, date);
    bwCount++;
  }
  db.prepare(`UPDATE profile SET weight_lb = ?, updated_at = datetime('now') WHERE id = 1`).run(END_LB);

  // ---- training sessions: plan days 1-5 on Mon-Fri, progressive loads ----
  const planDays = db.prepare(`SELECT id, day_number, name FROM plan_days ORDER BY day_number`).all() as any[];
  const itemsFor = db.prepare(`SELECT pi.*, e.id AS ex_id FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id WHERE pi.plan_day_id = ? ORDER BY pi.position`);
  const insSess = db.prepare(`INSERT INTO sessions (date, plan_day_id, duration_min, notes, created_at) VALUES (?, ?, ?, ?, ? || ' 07:55:00')`);
  const insSet = db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, created_at) VALUES (?, ?, ?, ?, ?, ?, ? || ' 08:10:00')`);

  let sessCount = 0;
  for (let w = 0; w < WEEKS; w++) {
    const deload = w === 4; // matches the bodyweight plateau
    for (const pd of planDays) {
      const dayMs = startMonday + w * 7 * 864e5 + (pd.day_number - 1) * 864e5;
      if (dayMs > todayMs) continue;
      // life happens: drop ~1 session most weeks (but never this week's)
      if (w < WEEKS - 1 && ((w % 3 === 1 && pd.day_number === 5) || (w % 4 === 2 && pd.day_number === 2))) continue;
      const date = iso(dayMs);
      const sid = Number(insSess.run(date, pd.id, 48 + Math.floor(rnd() * 18), deload ? "Deload week" : null, date).lastInsertRowid);
      sessCount++;
      for (const it of itemsFor.all(pd.id) as any[]) {
        const prog = w / (WEEKS - 1);
        let weight: number | null = null;
        if (it.target_weight != null && it.target_weight > 0) {
          weight = round5(it.target_weight * (0.88 + 0.12 * prog) * (deload ? 0.9 : 1));
        } else if (it.target_weight != null && it.target_weight < 0) {
          // assisted: assistance shrinks as the athlete gets stronger
          weight = -round5(Math.abs(it.target_weight) * (1.5 - 0.5 * prog));
        }
        for (let s = 1; s <= (it.sets || 3); s++) {
          const span = (it.rep_high ?? 10) - (it.rep_low ?? 8);
          const reps = (it.rep_low ?? 8) + Math.floor(rnd() * (span + 1) * (0.4 + 0.6 * prog));
          const rir = s === it.sets ? 1 : 2 + Math.round(rnd());
          insSet.run(sid, it.ex_id, s, weight, Math.min(reps, it.rep_high ?? 12), rir, date);
        }
      }
    }
  }

  // ---- weekend cardio: Sat run, Sun ride/hike alternating ----
  const insAct = db.prepare(`INSERT INTO activities (date, type, raw_text, duration_min, distance_km, pace, rpe, enrichment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ? || ' 09:30:00')`);
  let actCount = 0;
  for (let w = 0; w < WEEKS; w++) {
    const sat = startMonday + w * 7 * 864e5 + 5 * 864e5;
    const sun = sat + 864e5;
    if (sat <= todayMs) {
      const min = 40 + Math.floor(rnd() * 20);
      const km = Math.round(min / 5.6 * 10) / 10;
      insAct.run(iso(sat), "run", `ran ${min} min, ${km} km easy`, min, km, "5:36/km", 5 + Math.round(rnd()), iso(sat));
      actCount++;
    }
    if (sun <= todayMs) {
      if (w % 2 === 0) {
        const min = 60 + Math.floor(rnd() * 35);
        insAct.run(iso(sun), "ride", `rode ${min} min on the gravel loop`, min, Math.round(min * 0.42), null, 4, iso(sun));
      } else {
        const min = 90 + Math.floor(rnd() * 50);
        insAct.run(iso(sun), "hike", `hiked ${min} min with the pack`, min, Math.round(min * 0.065 * 10) / 10, null, 4 + Math.round(rnd()), iso(sun));
      }
      actCount++;
    }
  }

  // ---- a few recent food notes (last 5 days, already "enriched") ----
  const notes: [string, string, any][] = [
    ["breakfast", "oats + whey + greek yogurt with blueberries post-workout", { summary: "Post-workout oats & whey bowl", items: ["oats", "whey", "Greek yogurt", "blueberries"], kcal: 485, protein_g: 48 }],
    ["lunch", "chicken rice bowl with broccoli", { summary: "Chicken & rice bowl", items: ["chicken breast", "jasmine rice", "broccoli"], kcal: 540, protein_g: 52 }],
    ["dinner", "baked salmon, quinoa, brussels sprouts", { summary: "Baked salmon & quinoa", items: ["salmon", "quinoa", "Brussels sprouts"], kcal: 538, protein_g: 52 }],
    ["snack", "cottage cheese and a pear", { summary: "Cottage cheese & pear", items: ["cottage cheese", "pear"], kcal: 260, protein_g: 28 }],
    ["lunch", "sardine rice bowl, cucumber, tomatoes", { summary: "Sardine rice bowl", items: ["sardines", "rice", "cucumber", "cherry tomatoes"], kcal: 520, protein_g: 42 }],
  ];
  const insNote = db.prepare(`INSERT INTO food_notes (meal, raw_output, parsed_json, enrichment_status, created_at) VALUES (?, ?, ?, 'done', ? || ' 13:05:00')`);
  notes.forEach(([meal, raw, pj], i) => insNote.run(meal, raw, JSON.stringify(pj), iso(todayMs - (notes.length - 1 - i) * 864e5)));

  db.exec("COMMIT");
  console.log(`Done: ${bwCount} weigh-ins (${START_LB} → ${END_LB} lb), ${sessCount} sessions, ${actCount} activities, ${notes.length} food notes.`);
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
