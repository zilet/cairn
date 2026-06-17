// Demo data — a rich, *entirely fictional* athlete used for screenshots, the
// README walkthrough, and "see Cairn populated" evaluation. NOTHING here is a
// real person's data. Run it against a THROWAWAY database, never your real one:
//
//   DATA_DIR=/tmp/cairn-demo DB_PATH=/tmp/cairn-demo/demo.db npm run seed:demo
//
// It wipes the target DB's app tables and rebuilds a believable picture:
// profile + about-me, the seed plan, ~6 weeks of progressive-overload sessions,
// a lean-safe bodyweight trend, ~3 weeks of recovery metrics, three dated blood
// panels (with a couple of markers off the *optimal* band so the connected brain
// has something to propagate), the derived cross-domain directives, quiet
// insights, durable memory, a family roster, life-context events, an active
// meal plan, morning check-ins, a short chat, and a warm cached day-read Brief.
//
// Deterministic + offline: no agent or API key is needed. deriveDirectives() and
// dayRead() are pure functions; the cached Brief is written directly so the
// morning open shows agent-quality prose without an agent running.
import { db } from "./db.js";
import { seed } from "./seed.js";
import * as repo from "./repo.js";

const DAY = 86_400_000;
const now = new Date();
const iso = (daysAgo: number): string =>
  new Date(now.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
const round5 = (n: number) => Math.round(n / 5) * 5;

// ---------- wipe (idempotent rebuild on a throwaway DB) ----------
function wipe() {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = [
    "logged_sets", "session_skips", "sessions", "plan_items", "plan_days", "exercises",
    "bodyweight_log", "activities", "daily_metrics", "garmin_activities", "garmin_daily_metrics",
    "garmin_sources", "health_documents", "health_reviews", "health_directives", "insights",
    "memory", "family_members", "context_events", "checkins", "meal_plans", "food_notes",
    "chat_messages", "day_reads", "suggestions", "plan_proposals", "evidence_cache",
    "art_assets", "art_aliases", "art_usage", "app_state",
  ];
  db.exec("BEGIN");
  try {
    for (const t of tables) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist on older schema */ }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  db.exec("PRAGMA foreign_keys = ON");
}

// ---------- profile ----------
function profile() {
  repo.setProfile({
    sex: "female",
    age: 41,
    height_cm: 167,
    weight_lb: 149,
    goal_weight_lb: 142,
    goal_date: iso(-77), // ~11 weeks out
    activity_factor: 1.45,
    notes: "Body recomposition + healthspan — steady fat loss, preserve lean mass. Not chasing a scale number.",
    about_me:
      "I'm 41, two kids, work as a product designer. I train 4–5×/week — strength plus trail running on weekends — " +
      "and I care more about long-term healthspan than a number on the scale. I lift fasted first thing most mornings " +
      "before the house wakes up, so no pre-workout meal — a real breakfast after. I love bold, savory food; not a fan " +
      "of cottage cheese or oversweet protein shakes. Old runner's right knee flares with deep lunges (squats are fine). " +
      "What 'better' means to me: steady energy through the afternoon, sleeping through the night, and keeping up with " +
      "the kids on the trail.",
  });
}

// ---------- training history (~6 weeks, progressive overload) ----------
// week index 0 (oldest) .. 5 (most recent) drives the ramp.
interface LiftSpec { reps: [number, number]; base: number; perWeek: number; sets?: number; }
// weight === null → bodyweight; negative → assisted (encoding the app relies on).
const DAY_TEMPLATES: Record<number, { name: string; lifts: [string, LiftSpec | null][] }> = {
  1: { name: "Lower A", lifts: [
    ["Back Squat", { reps: [8, 8], base: 170, perWeek: 4 }],
    ["Leg Extension", { reps: [12, 12], base: 120, perWeek: 3 }],
    ["Leg Curl", { reps: [12, 12], base: 118, perWeek: 3 }],
    ["Standing Calf Raise", null],
  ] },
  2: { name: "Push", lifts: [
    ["Seated DB Overhead Press", { reps: [9, 9], base: 35, perWeek: 1 }],
    ["Incline DB Press", { reps: [9, 9], base: 38, perWeek: 0.8 }],
    ["Lateral Raise", { reps: [15, 15], base: 15, perWeek: 0.4 }],
    ["Triceps Rope Pushdown", { reps: [12, 12], base: 42, perWeek: 1.5 }],
  ] },
  3: { name: "Pull", lifts: [
    ["Assisted Pull-Up", { reps: [7, 7], base: -40, perWeek: 2 }], // assist shrinks toward 0
    ["Barbell Bent-Over Row", { reps: [9, 9], base: 125, perWeek: 3 }],
    ["Lat Pulldown", { reps: [12, 12], base: 110, perWeek: 3 }],
    ["Face Pull", { reps: [15, 15], base: 30, perWeek: 1 }],
    ["Hammer Curl", { reps: [12, 12], base: 22, perWeek: 1 }],
  ] },
  4: { name: "Lower B", lifts: [
    ["Romanian Deadlift", { reps: [9, 9], base: 115, perWeek: 4 }],
    ["Leg Curl", { reps: [12, 12], base: 118, perWeek: 3 }],
    ["Bulgarian Split Squat", { reps: [10, 10], base: 25, perWeek: 1 }],
    ["Seated Calf Raise", null],
  ] },
  5: { name: "Full Body", lifts: [
    ["Back Squat", { reps: [8, 8], base: 145, perWeek: 3 }], // ~85% technique day
    ["Seated Cable Row", { reps: [12, 12], base: 100, perWeek: 3 }],
    ["Seated DB Overhead Press", { reps: [10, 10], base: 33, perWeek: 0.8 }],
    ["Lateral Raise", { reps: [15, 15], base: 15, perWeek: 0.4 }],
    ["Hammer Curl", { reps: [12, 12], base: 22, perWeek: 1 }],
  ] },
};

function trainingHistory(exId: Record<string, number>, planDayId: Record<number, number>) {
  const insertSession = db.prepare(
    `INSERT INTO sessions (date, plan_day_id, duration_min, notes, soreness, performance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSet = db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, note) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tops = [41, 34, 27, 20, 13, 6];   // top of each weekly block (days ago)
  const offs = [0, 1, 3, 4];              // ~4 sessions/week
  let gi = 0;                             // global session index → rotates the 5-day split
  db.exec("BEGIN");
  try {
    for (let w = 0; w < tops.length; w++) {
      for (const off of offs) {
        const daysAgo = tops[w] - off;
        const planNum = (gi % 5) + 1;
        gi++;
        const tpl = DAY_TEMPLATES[planNum];
        const date = iso(daysAgo);
        const dur = 45 + ((gi * 7) % 18); // 45–62 min, deterministic
        // light, occasional autoregulation feedback
        const soreness = off === 4 ? 3 : null;
        const performance = off === 0 ? 4 : null;
        const sid = Number(
          insertSession.run(date, planDayId[planNum], dur, null, soreness, performance, `${date} 07:05:00`).lastInsertRowid
        );
        for (const [exName, spec] of tpl.lifts) {
          const exid = exId[exName];
          if (!exid) continue;
          const sets = spec?.sets ?? 3;
          for (let s = 1; s <= sets; s++) {
            let weight: number | null;
            let reps: number;
            if (!spec) { weight = null; reps = 15; }
            else {
              const raw = spec.base + spec.perWeek * w;
              // assisted (negative) rounds toward 0 in 5s; DBs to nearest 1; bars to 5
              if (raw < 0) weight = Math.min(0, round5(raw));
              else if (Math.abs(spec.base) <= 50) weight = Math.round(raw); // dumbbells/cables
              else weight = round5(raw);
              reps = spec.reps[0];
            }
            const rir = s === sets ? 1 : 2;
            insertSet.run(sid, exid, s, weight, reps, rir, null);
          }
        }
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ---------- bodyweight trend (lean-safe, ~0.65 lb/wk) ----------
function bodyweight() {
  const start = 156.2;
  const perDay = (156.2 - 149.0) / 42; // ~0.17 lb/day
  // ~3 weigh-ins/week with mild noise; ends near current 149
  const noise = [0.4, -0.3, 0.2, -0.5, 0.3, -0.2, 0.5, -0.4, 0.1, -0.3, 0.4, -0.2, 0.3, -0.4, 0.2, -0.3];
  let k = 0;
  for (let d = 42; d >= 0; d -= 3) {
    const w = start - perDay * (42 - d) + (noise[k % noise.length] || 0);
    repo.logWeight(Math.round(w * 10) / 10, iso(d));
    k++;
  }
}

// ---------- recovery (Apple Health-style daily metrics, ~24 days) ----------
function recovery() {
  // a few short nights to make the Brief + insight believable
  const shortNights = new Set([18, 14, 8, 3]);
  for (let d = 24; d >= 0; d--) {
    const short = shortNights.has(d);
    const sleepMin = short ? 330 + ((d * 11) % 40) : 410 + ((d * 13) % 60);
    const sleepScore = short ? 62 + (d % 8) : 80 + (d % 11);
    const hrv = (short ? 46 : 58) + ((d * 7) % 14);
    const rhr = 51 + (short ? 4 : 0) + (d % 3);
    const steps = 7000 + ((d * 911) % 6500);
    const active = 380 + ((d * 37) % 320);
    repo.recordDailyMetrics("apple", iso(d), {
      steps, sleep_min: sleepMin, sleep_score: sleepScore, resting_hr: rhr, hrv_ms: hrv, active_calories: active,
    });
  }
}

// ---------- a couple of logged cardio activities (raw insert; no enrichment) ----------
function activities() {
  const ins = db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, pace, rpe, notes, source, enrichment_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo', 'done', ?)`
  );
  ins.run(iso(2), "run", "trail run, ~8k easy, legs felt springy", 48, 8.1, "5:55/km", 4, "Easy aerobic. Coastal loop.", `${iso(2)} 06:50:00`);
  ins.run(iso(6), "run", "long trail run 14k", 82, 14.2, "5:48/km", 6, "Long run; fueled with a gel at 8k.", `${iso(6)} 07:10:00`);
  ins.run(iso(9), "yoga", "45 min mobility + yoga", 45, null, null, 2, "Hips and t-spine; knee felt good.", `${iso(9)} 19:30:00`);
}

// ---------- food intake (~17 days) → high-confidence TDEE + frequents ----------
// The MacroFactor-style expenditure estimate needs intake days, and these also
// feed the Today "frequent foods" one-tap chips. Savory, plan-aligned, deficit.
function foodIntake() {
  const ins = db.prepare(
    `INSERT INTO food_notes (meal, raw_output, parsed_json, enrichment_status, created_at) VALUES (?, '', ?, 'done', ?)`
  );
  // [summary, kcal, protein, carbs, fat]
  const breakfasts: [string, number, number, number, number][] = [
    ["Smoked salmon & eggs, spinach", 480, 36, 22, 26],
    ["Tofu scramble, black beans, avocado", 450, 28, 34, 22],
    ["Mackerel on sourdough, tomato", 470, 30, 36, 22],
    ["Steak & eggs, sweet potato hash", 560, 42, 38, 26],
  ];
  const lunches: [string, number, number, number, number][] = [
    ["Lentil & roasted veg bowl, tahini", 560, 26, 60, 22],
    ["Chicken thigh & farro salad", 540, 40, 50, 18],
    ["Salmon poke bowl, edamame, rice", 560, 36, 58, 18],
    ["Lentil soup & whole-grain roll", 470, 25, 62, 12],
  ];
  const dinners: [string, number, number, number, number][] = [
    ["Grilled sardines, quinoa, broccoli", 520, 38, 42, 22],
    ["Beef & lentil chili, brown rice", 540, 38, 56, 16],
    ["Turkey meatballs, whole-wheat pasta", 540, 40, 58, 14],
    ["Grilled salmon, wild rice, asparagus", 540, 38, 46, 22],
  ];
  const snacks: [string, number, number, number, number][] = [
    ["Greek yogurt, berries, walnuts", 230, 20, 16, 9],
    ["Hummus, carrots & almonds", 220, 8, 20, 13],
  ];
  const put = (m: [string, number, number, number, number], date: string, hhUtc: number) =>
    ins.run(m[0], JSON.stringify({ summary: m[0], kcal: m[1], protein_g: m[2], carbs_g: m[3], fat_g: m[4] }),
      `${date} ${String(hhUtc).padStart(2, "0")}:${(m[1] % 50).toString().padStart(2, "0")}:00`);
  for (let d = 17; d >= 1; d--) {
    const date = iso(d);
    put(breakfasts[d % breakfasts.length], date, 6);
    put(lunches[d % lunches.length], date, 11);
    put(dinners[d % dinners.length], date, 17);
    if (d % 2 === 0) put(snacks[d % snacks.length], date, 14); // ~every other day
  }
}

// ---------- blood panels (3 dated docs) → markers + trends ----------
type M = { name: string; value: number; flag: "low" | "normal" | "high"; unit: string };
function markers() {
  // doc_date older → newer; trends emerge across the three.
  const panels: { date: string; markers: M[]; summary: string }[] = [
    {
      date: iso(410), summary: "Baseline panel. ApoB and LDL elevated; vitamin D low; ferritin low-normal; inflammation mildly up.",
      markers: [
        { name: "ApoB", value: 108, flag: "normal", unit: "mg/dL" },
        { name: "LDL-C", value: 132, flag: "high", unit: "mg/dL" },
        { name: "HDL-C", value: 54, flag: "normal", unit: "mg/dL" },
        { name: "Triglycerides", value: 118, flag: "normal", unit: "mg/dL" },
        { name: "hs-CRP", value: 2.4, flag: "normal", unit: "mg/L" },
        { name: "HbA1c", value: 5.5, flag: "normal", unit: "%" },
        { name: "Fasting glucose", value: 95, flag: "normal", unit: "mg/dL" },
        { name: "Ferritin", value: 46, flag: "normal", unit: "ng/mL" },
        { name: "Vitamin D", value: 23, flag: "low", unit: "ng/mL" },
        { name: "Vitamin B12", value: 480, flag: "normal", unit: "pg/mL" },
        { name: "TSH", value: 2.1, flag: "normal", unit: "uIU/mL" },
        { name: "ALT", value: 26, flag: "normal", unit: "U/L" },
      ],
    },
    {
      date: iso(190), summary: "Six-month recheck. Lipids improving with diet changes; vitamin D climbing; ferritin slipping.",
      markers: [
        { name: "ApoB", value: 99, flag: "normal", unit: "mg/dL" },
        { name: "LDL-C", value: 119, flag: "normal", unit: "mg/dL" },
        { name: "HDL-C", value: 56, flag: "normal", unit: "mg/dL" },
        { name: "Triglycerides", value: 96, flag: "normal", unit: "mg/dL" },
        { name: "hs-CRP", value: 1.9, flag: "normal", unit: "mg/L" },
        { name: "HbA1c", value: 5.4, flag: "normal", unit: "%" },
        { name: "Fasting glucose", value: 91, flag: "normal", unit: "mg/dL" },
        { name: "Ferritin", value: 36, flag: "normal", unit: "ng/mL" },
        { name: "Vitamin D", value: 30, flag: "normal", unit: "ng/mL" },
        { name: "Vitamin B12", value: 510, flag: "normal", unit: "pg/mL" },
        { name: "TSH", value: 1.9, flag: "normal", unit: "uIU/mL" },
        { name: "ALT", value: 23, flag: "normal", unit: "U/L" },
      ],
    },
    {
      date: iso(22), summary: "Latest panel. ApoB trending the right way but still above optimal; vitamin D low-optimal; ferritin now low — worth watching alongside the trail mileage.",
      markers: [
        { name: "ApoB", value: 92, flag: "normal", unit: "mg/dL" },
        { name: "LDL-C", value: 110, flag: "normal", unit: "mg/dL" },
        { name: "HDL-C", value: 58, flag: "normal", unit: "mg/dL" },
        { name: "Triglycerides", value: 84, flag: "normal", unit: "mg/dL" },
        { name: "hs-CRP", value: 1.6, flag: "normal", unit: "mg/L" },
        { name: "HbA1c", value: 5.3, flag: "normal", unit: "%" },
        { name: "Fasting glucose", value: 89, flag: "normal", unit: "mg/dL" },
        { name: "Ferritin", value: 27, flag: "low", unit: "ng/mL" },
        { name: "Vitamin D", value: 36, flag: "normal", unit: "ng/mL" },
        { name: "Vitamin B12", value: 540, flag: "normal", unit: "pg/mL" },
        { name: "TSH", value: 1.8, flag: "normal", unit: "uIU/mL" },
        { name: "ALT", value: 21, flag: "normal", unit: "U/L" },
        { name: "AST", value: 22, flag: "normal", unit: "U/L" },
        { name: "Creatinine", value: 0.85, flag: "normal", unit: "mg/dL" },
        { name: "eGFR", value: 100, flag: "normal", unit: "mL/min" },
        { name: "Hemoglobin", value: 13.1, flag: "normal", unit: "g/dL" },
        { name: "WBC", value: 5.2, flag: "normal", unit: "10^3/uL" },
        { name: "Platelets", value: 248, flag: "normal", unit: "10^3/uL" },
      ],
    },
  ];
  for (const p of panels) {
    repo.addHealthDocument({
      kind: "bloodwork",
      doc_date: p.date,
      original_name: `Bloodwork ${p.date}.pdf`,
      mime: "application/pdf",
      parsed_json: { type: "bloodwork", markers: p.markers },
      summary: p.summary,
      enrichment_status: "done",
    });
  }
  // a DEXA pair so Body Composition has a trend too
  repo.addHealthDocument({
    kind: "dexa", doc_date: iso(230), original_name: "DEXA 2025.pdf", mime: "application/pdf",
    parsed_json: { type: "dexa", markers: [
      { name: "Body fat", value: 31.2, unit: "%" },
      { name: "Lean mass", value: 96.4, unit: "lb" },
      { name: "Visceral fat", value: 1.4, unit: "lb" },
    ] },
    summary: "Baseline DEXA — body fat 31.2%, lean mass 96.4 lb.", enrichment_status: "done",
  });
  repo.addHealthDocument({
    kind: "dexa", doc_date: iso(35), original_name: "DEXA 2026.pdf", mime: "application/pdf",
    parsed_json: { type: "dexa", markers: [
      { name: "Body fat", value: 27.6, unit: "%" },
      { name: "Lean mass", value: 97.1, unit: "lb" },
      { name: "Visceral fat", value: 1.1, unit: "lb" },
    ] },
    summary: "Follow-up DEXA — body fat down to 27.6%, lean mass held (97.1 lb). Recomp is working.", enrichment_status: "done",
  });
}

// ---------- the agentic whole-picture health review (Me → Health → Analysis) ----------
// Seeded directly (no agent needed) in the exact addHealthReview contract. We omit
// the `directives` field on purpose so the connected-brain directives stay sourced
// from the deterministic engine alone (no double-listing in the Brain view).
function healthReview() {
  repo.addHealthReview({
    headline: "A strong year of work — your lipid picture is moving the right way; iron is the one thing to stay ahead of.",
    wins: [
      "ApoB down from 108 to 92 over the year — the diet changes are working.",
      "Triglycerides and HbA1c both landed in the optimal range.",
      "Body fat dropped to 27.6% while lean mass held — clean recomposition.",
      "Recovery's been steady: HRV in range, resting heart rate in the low 50s.",
    ],
    watchlist: [
      { marker: "Ferritin", status: "low", why: "Down to 27 ng/mL and still trending lower — common with high training volume, and you're running a lot.", action: "Add iron-rich meals (red meat, lentils + vitamin C) on long-run days; keep tea/coffee away from them.", citation: "WHO 2020 Ferritin Guideline" },
      { marker: "ApoB", status: "high", why: "92 mg/dL — improving, but still above the <80 optimal for long-term cardiovascular risk.", action: "Keep the lipid-lowering pattern: oily fish 3×/week, ~10 g/day soluble fiber, swap saturated for unsaturated fat.", citation: "AHA/ACC 2018 Cholesterol Guideline; ESC/EAS 2019 Dyslipidaemia" },
      { marker: "Vitamin D", status: "low", why: "36 ng/mL — up from 23, but still under the 40–60 optimal band.", action: "Continue sensible sun plus a D3 supplement; recheck in about three months.", citation: null },
      { marker: "hs-CRP", status: "watch", why: "1.6 mg/L — mildly elevated, and it tracks with the lipid picture.", action: "An anti-inflammatory pattern (olive oil, plenty of vegetables, fewer ultra-processed foods) helps both at once.", citation: null },
    ],
    focus: [
      { title: "Stay ahead of iron", why: "Falling ferritin plus high mileage is the classic endurance-athlete trap.", action: "Two iron-forward meals this week, both on running days." },
      { title: "Hold the lipid momentum", why: "ApoB is the most direct dietary lever you have for cardiovascular risk.", action: "Oily fish three times this week and soluble fiber daily." },
    ],
    followups: [
      { what: "Recheck ferritin and a full iron panel", when: "in 8–12 weeks" },
      { what: "Recheck ApoB and a lipid panel", when: "in ~12 weeks" },
      { what: "Recheck vitamin D", when: "in ~3 months" },
    ],
    training_impact: "Nothing here caps your lifting. The one flag is endurance volume against falling ferritin — keep long runs easy and don't stack a hard run the day before a heavy lower session until iron recovers.",
    nutrition_impact: "Your meals should keep doing the lipid work (oily fish, soluble fiber, unsaturated fats) while adding iron on running days. Protein stays the anchor for the recomp.",
  }, "claude");
}

// ---------- insights, memory, family, life, meals, check-ins, chat ----------
function quietLayer() {
  // Connected-brain directives propagated deterministically from the off-optimal markers.
  repo.deriveDirectives();

  repo.addInsight({
    kind: "connection",
    text: "Your lowest-energy mornings all followed a short night's sleep.",
    rationale: "Over the last three weeks, every morning you rated energy 2/5 came after a night under ~5.5 hours. The pattern is consistent enough to act on, and it lines up with your heavier training days.",
    next_step: "Protect a 10:30 lights-out the night before Pull and Lower B — your two heaviest sessions.",
    status: "new",
  });
  repo.addInsight({
    kind: "weekly_read",
    text: "Strong week — four sessions, squat moved, and your weight is right on the lean-safe line.",
    rationale: "Back Squat best set climbed to 190 and your 14-day trend is ~0.7 lb/week, exactly where it should be for a September goal. Ferritin is the one thing on the watchlist given your trail mileage.",
    next_step: "Hold the deficit; add an iron-rich meal on long-run days.",
    status: "seen",
  });

  for (const [content, kind] of [
    ["Trains fasted first thing most mornings — no pre-workout meal, substantial breakfast after.", "preference"],
    ["Old right-knee runner's injury: deep lunges aggravate it, back squats are fine.", "constraint"],
    ["Dislikes cottage cheese and oversweet protein shakes; prefers bold, savory food.", "preference"],
    ["Primary goal is healthspan and steady fat loss, not a scale number.", "decision"],
    ["Two kids (Leo, Iris) and a partner (Maya); plans training around family time on weekends.", "context"],
    ["ApoB is the cardiovascular marker we're actively lowering with diet (oily fish, soluble fiber).", "decision"],
  ] as [string, string][]) {
    repo.addMemory(content, kind, "demo");
  }

  repo.addFamily({ name: "Maya", relationship: "partner", color: "#C26B4A", notes: "Runs with you on Saturdays." });
  repo.addFamily({ name: "Leo", relationship: "child", birthdate: iso(9 * 365), color: "#6E8B6E", notes: "Soccer Tue/Thu evenings." });
  repo.addFamily({ name: "Iris", relationship: "child", birthdate: iso(6 * 365), color: "#7C6CA8", notes: "Swim lessons Sunday mornings." });

  repo.addContextEvent({
    kind: "injury", title: "Right knee — old runner's knee", detail: "Mild; deep lunges aggravate it. Squats and RDLs are fine.",
    start_date: iso(420), end_date: null, meta: { area: "right knee", severity: "mild" },
  });
  repo.addContextEvent({
    kind: "trip", title: "Lisbon — design offsite", detail: "Four days, hotel gym only. Travel-friendly week.",
    start_date: iso(-9), end_date: iso(-13), meta: { location: "Lisbon" },
  });
  repo.addContextEvent({
    kind: "life_event", title: "Coastal half marathon", detail: "Goal race — keep long runs easy, taper the week before.",
    start_date: iso(-38), end_date: iso(-38), meta: { impact: "positive" },
  });

  // Active meal plan — reflects the directives (oily fish + soluble fiber for ApoB,
  // iron-rich for ferritin), the fasted-AM training, and the cottage-cheese dislike.
  const meal = (name: string, items: string, kcal: number, p: number, c: number, f: number) => ({ name, items, kcal, protein_g: p, carbs_g: c, fat_g: f });
  const mealPlan = repo.createMealPlan("demo", "", {
    daily_kcal: 1850,
    daily_protein_g: 150,
    note: "Protein-anchored, ~30g fiber, oily fish 3×/week, iron on long-run days. No pre-workout meal — breakfast lands after the fasted lift.",
    days: [
      { day: "Mon", meals: [
        meal("Post-lift breakfast", "Smoked salmon, two eggs, sautéed spinach, rye toast", 520, 38, 34, 24),
        meal("Lunch", "Lentil & roasted veg bowl, tahini, pumpkin seeds", 560, 28, 62, 22),
        meal("Snack", "Greek yogurt, berries, walnuts", 230, 20, 16, 9),
        meal("Dinner", "Grilled sardines, quinoa, broccoli, olive oil", 540, 40, 44, 22),
      ] },
      { day: "Tue", meals: [
        meal("Post-lift breakfast", "Tofu scramble, black beans, avocado, salsa", 510, 30, 40, 24),
        meal("Lunch", "Chicken thigh, farro, kale & beet salad", 560, 42, 52, 18),
        meal("Snack", "Edamame + an orange", 200, 17, 22, 6),
        meal("Dinner", "Beef & lentil chili, brown rice", 560, 40, 58, 16),
      ] },
      { day: "Wed", meals: [
        meal("Post-lift breakfast", "Mackerel on sourdough, tomato, olive oil", 500, 32, 38, 24),
        meal("Lunch", "Salmon poke bowl, edamame, seaweed, brown rice", 580, 38, 60, 18),
        meal("Snack", "Hummus + carrots + a handful of almonds", 240, 9, 22, 14),
        meal("Dinner", "Turkey meatballs, whole-wheat pasta, marinara, side salad", 560, 42, 60, 14),
      ] },
      { day: "Thu (long-run day)", meals: [
        meal("Pre-run", "Banana + a date", 160, 2, 38, 1),
        meal("Post-run breakfast", "Steak & eggs, spinach, sweet potato hash", 600, 44, 42, 26),
        meal("Lunch", "Lentil soup, whole-grain roll, side of greens", 480, 26, 64, 12),
        meal("Dinner", "Grilled salmon, wild rice, asparagus", 560, 40, 48, 22),
      ] },
    ],
    shopping: ["Smoked salmon", "Sardines", "Mackerel", "Lentils", "Black beans", "Spinach", "Kale", "Beets", "Quinoa", "Farro", "Greek yogurt", "Berries", "Walnuts", "Edamame", "Tofu"],
  });
  if (mealPlan) repo.setMealPlanStatus(mealPlan.id, "applied");
  // A cached recipe on Mon's dinner so "recipe details" renders with no agent.
  if (mealPlan) repo.setMealRecipe(mealPlan.id, "Mon", 3, {
    summary: "A fast, omega-3-rich dinner that does double duty for your lipid panel — sardines for EPA/DHA, quinoa and broccoli for fiber.",
    time_min: 25,
    servings: 2,
    ingredients: [
      { item: "Fresh or tinned sardines", qty: "4–6 (≈300g)" },
      { item: "Quinoa", qty: "1 cup dry" },
      { item: "Broccoli", qty: "1 large head" },
      { item: "Lemon", qty: "1" },
      { item: "Extra-virgin olive oil", qty: "2 tbsp" },
      { item: "Garlic", qty: "2 cloves" },
      { item: "Chili flakes, salt, pepper", qty: "to taste" },
    ],
    steps: [
      "Rinse the quinoa, then simmer in 2 cups water for ~15 min until fluffy.",
      "Toss broccoli florets in 1 tbsp olive oil and salt; roast at 220°C / 425°F for 18–20 min.",
      "Pat the sardines dry; sear 2–3 min a side in a hot pan with a little oil and the sliced garlic.",
      "Squeeze lemon over the sardines and finish with chili flakes.",
      "Plate the quinoa and broccoli, top with sardines, and drizzle the remaining olive oil.",
    ],
    tips: [
      "Tinned sardines in olive oil work fine — skip the searing, just warm them through.",
      "Iron tip: the squeeze of lemon helps absorption — handy on long-run days.",
    ],
  });

  // Morning check-ins (today's drives the Brief's check-in card)
  repo.addCheckin(iso(0), { mood: 4, energy: 4, sleep_feel: 3, soreness: 2, note: "Good. Legs a touch tired from Saturday's long run." });
  repo.addCheckin(iso(3), { mood: 3, energy: 2, sleep_feel: 2, soreness: 3, note: "Short night, kids up early." });
  repo.addCheckin(iso(5), { mood: 4, energy: 4, sleep_feel: 4, soreness: 1 });
  repo.addCheckin(iso(8), { mood: 3, energy: 2, sleep_feel: 2, soreness: 2 });

  // A short, realistic conversation
  repo.addChatMessage("user", "logged a trail run this morning, ~8k easy, legs felt springy");
  repo.addChatMessage(
    "assistant",
    "Nice — logged it as 48 min easy trail. That's two cardio sessions this week on top of four lifts, and your recovery's been trending fine, so no flag. Want me to keep Saturday's long run easy again?",
    "claude", { actions: ["log_activity"] }
  );
  repo.addChatMessage("user", "yeah keep it easy. also I'm down to 149");
  repo.addChatMessage(
    "assistant",
    "Updated — 149 lb. You're tracking ~0.7 lb/week, right on the lean-safe line for your September goal, so I'd hold the deficit where it is. One thing on my radar: your last ferritin came back low, and you're running a lot — I've kept an iron-rich meal on your long-run days in the plan. Not medical advice, just worth a recheck.",
    "claude", { actions: ["set_profile"] }
  );
}

// ---------- cached evidence (F1) — cited sources behind the flagged markers ----------
// So the Brain view's "see the evidence (N)" disclosure has real, openable sources
// to show (not just the citation string). These mirror what the research pass would
// cache: a guideline body, a verifiable URL, a plain-language claim. Marker names
// match the directive markers (deriveDirectives / MARKER_MAPPINGS) case-insensitively.
function evidence() {
  const rows: repo.EvidenceInput[] = [
    {
      marker: "ApoB", topic: "apob cardiovascular risk", confidence: "high",
      claim: "ApoB is a stronger predictor of cardiovascular risk than LDL-C; an optimal target is under ~80 mg/dL for primary prevention.",
      source_title: "ESC/EAS 2019 Guidelines for the Management of Dyslipidaemias",
      source_url: "https://academic.oup.com/eurheartj/article/41/1/111/5556353",
      body: "Apolipoprotein B reflects the total number of atherogenic particles; lowering it with diet (unsaturated fats, soluble fiber, oily fish) and, where indicated, therapy reduces long-term risk.",
    },
    {
      marker: "Ferritin", topic: "ferritin iron endurance athletes", confidence: "moderate",
      claim: "In endurance athletes, ferritin below ~30 ng/mL signals depleted iron stores and can blunt training adaptation even before anemia appears.",
      source_title: "WHO 2020 Guideline on Ferritin Concentrations",
      source_url: "https://www.who.int/publications/i/item/9789240000124",
      body: "High training volume increases iron losses; pairing iron-rich foods with vitamin C and keeping tea/coffee away from those meals improves absorption.",
    },
    {
      marker: "Vitamin D", topic: "vitamin d optimal range", confidence: "moderate",
      claim: "A serum 25-hydroxyvitamin D in the 40–60 ng/mL band is a common longevity-oriented target, above the 20 ng/mL clinical-deficiency threshold.",
      source_title: "Endocrine Society Clinical Practice Guideline — Vitamin D",
      source_url: "https://academic.oup.com/jcem/article/96/7/1911/2833671",
      body: "Sensible sun exposure plus modest D3 supplementation typically raises levels; rechecking after about three months confirms the response.",
    },
    {
      marker: "hs-CRP", topic: "hs-crp inflammation cardiovascular", confidence: "moderate",
      claim: "hs-CRP under 1 mg/L is considered low cardiovascular risk; mildly elevated values often track with the lipid picture and respond to an anti-inflammatory dietary pattern.",
      source_title: "AHA/CDC Scientific Statement on Inflammation Markers",
      source_url: "https://www.ahajournals.org/doi/10.1161/01.CIR.0000052939.59093.45",
      body: "An olive-oil-forward, vegetable-rich pattern with fewer ultra-processed foods tends to lower hs-CRP alongside ApoB.",
    },
  ];
  for (const r of rows) repo.addEvidence(r);
}

// ---------- outcome learnings (F2) — "What Cairn has noticed" in Settings ----------
// The durable observations the suggestion→outcome reconciler would write over time
// (memory kind 'learning'). Gentle, plain-language patterns that quietly season the
// coach's defaults — never a rule, never a score. Surfaced via GET /api/learnings.
function learnings() {
  for (const content of [
    "Tends to follow through on Pull and Lower B days; the lighter accessory days are the ones that slip when the week gets busy.",
    "Recovers well from back-to-back lift days when sleep holds above ~7 hours — the read can lean 'train' a touch more often than it assumed.",
    "On the mornings after a short night, performance feedback runs lower — easing volume those days has matched how the sessions actually went.",
  ]) {
    repo.addMemory(content, "learning", "demo");
  }
}

// ---------- an unreconciled Garmin strength lift (F5) — the Today reconcile card ----------
// A synced strength activity from yesterday with no linked Cairn session, so the
// calm "Garmin logged a lift that isn't in Cairn yet — reconcile?" card lights up.
// We DON'T reconcile it here (that's the demo action to show). Carries the physiology
// blob (HR/zones/calories/TE) and a couple of detected sets so a reconcile reads real.
function garminStrength() {
  const date = iso(1); // yesterday
  repo.upsertGarminSource({ label: "default", auth_status: "connected", mode: "unofficial" });
  repo.upsertGarminActivity({
    external_id: "demo-strength-1",
    date,
    start_time: `${date}T07:02:00`,
    type: "strength_training",
    name: "Strength",
    duration_min: 52,
    calories: 372,
    avg_hr: 118,
    max_hr: 156,
    training_load: 142,
    training_effect: 2.7,
    aerobic_te: 1.8,
    anaerobic_te: 2.4,
    hr_zones: [
      { zone: 1, secs: 980, low_hr: 96 },
      { zone: 2, secs: 1340, low_hr: 114 },
      { zone: 3, secs: 560, low_hr: 133 },
      { zone: 4, secs: 240, low_hr: 152 },
    ],
    exercise_sets: [
      { category: "SQUAT", name: "Back Squat", reps: 8, weight_kg: 79, set_type: "ACTIVE" },
      { category: "ROW", name: "Barbell Bent-Over Row", reps: 9, weight_kg: 57, set_type: "ACTIVE" },
      { category: "SHOULDER_PRESS", name: "Seated DB Overhead Press", reps: 9, weight_kg: 16, set_type: "ACTIVE" },
    ],
  });
}

// ---------- the cached Brief (written LAST — recovery/check-ins invalidate it) ----------
function brief() {
  const today = iso(0);
  repo.invalidateDayRead(today);
  repo.saveDayRead(today, {
    kind: "train",
    headline: "A strong, controlled Pull day.",
    why: "You slept just under 7 hours and your HRV's back in range after Saturday's long run — recovered and due. Three lifts in this week; this is the day to earn the back work. Keep bar speed honest and stop a rep shy.",
    focus: "Pull — back, rear delts, biceps",
    est_minutes: 55,
    signals: { consecutive_training_days: 0, has_recovery_data: true },
    source: "agent",
    agent: "claude",
  });
}

function main() {
  wipe();
  seed(); // exercises + plan_days + plan_items (+ a baseline session/profile we replace)
  // clear seed's baseline session + example profile leftovers, keep plan/exercises
  db.prepare(`DELETE FROM logged_sets`).run();
  db.prepare(`DELETE FROM sessions`).run();

  const exId: Record<string, number> = {};
  for (const r of db.prepare(`SELECT id, name FROM exercises`).all() as any[]) exId[r.name] = r.id;
  const planDayId: Record<number, number> = {};
  for (const r of db.prepare(`SELECT id, day_number FROM plan_days`).all() as any[]) planDayId[r.day_number] = r.id;

  profile();
  trainingHistory(exId, planDayId);
  bodyweight();
  recovery();
  activities();
  foodIntake();
  markers();
  healthReview();
  quietLayer();
  evidence();        // F1 — cited sources behind the flagged markers
  learnings();       // F2 — "What Cairn has noticed" outcome learnings
  garminStrength();  // F5 — an unreconciled Garmin lift for the Today reconcile card
  brief();

  // make sure the app opens straight into the populated experience
  db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES (1)`).run();
  // proactive_enabled OFF so the background scheduler's nightly precompute can't
  // overwrite the warm cached Brief we seeded above (it would fall back to the
  // deterministic read with no agent configured). Pure capture hygiene.
  db.prepare(`UPDATE settings SET onboarded = 1, art_enabled = 1, proactive_enabled = 0, coach_enabled = 0, meal_prefs = ? WHERE id = 1`).run(
    "I train fasted first thing most mornings — no pre-workout meal, a real breakfast after. Bold savory food; no cottage cheese."
  );

  const counts = {
    sessions: (db.prepare(`SELECT COUNT(*) c FROM sessions`).get() as any).c,
    sets: (db.prepare(`SELECT COUNT(*) c FROM logged_sets`).get() as any).c,
    weighins: (db.prepare(`SELECT COUNT(*) c FROM bodyweight_log`).get() as any).c,
    recovery: (db.prepare(`SELECT COUNT(*) c FROM daily_metrics`).get() as any).c,
    panels: (db.prepare(`SELECT COUNT(*) c FROM health_documents`).get() as any).c,
    directives: (db.prepare(`SELECT COUNT(*) c FROM health_directives WHERE status='active'`).get() as any).c,
    insights: (db.prepare(`SELECT COUNT(*) c FROM insights`).get() as any).c,
    family: (db.prepare(`SELECT COUNT(*) c FROM family_members`).get() as any).c,
    evidence: (db.prepare(`SELECT COUNT(*) c FROM evidence_cache`).get() as any).c,
    learnings: (db.prepare(`SELECT COUNT(*) c FROM memory WHERE kind='learning' AND superseded_by IS NULL`).get() as any).c,
    garmin_unreconciled: (db.prepare(`SELECT COUNT(*) c FROM garmin_activities WHERE session_id IS NULL`).get() as any).c,
  };
  console.log("Demo data seeded:", JSON.stringify(counts));
}

main();
