// When an everyday op deserves one more step of thinking than its default.
//
// Effort defaults low (TASK_EXECUTION_PROFILES): measured live on all four CLIs
// (2026-10-13), low matched or beat medium on the everyday ops, faster on every one. A
// few situations still make a wrong answer cost more than a slow one, and the server
// already knows each of them, so the bump is server policy, never the model's call:
//   - open_pain: the athlete STATED pain in a place within the last two weeks, and the
//     op composes or checks training around it;
//   - race_window: the race is two weeks out or less (the taper and race week), for the
//     same training ops;
//   - new_finding: a health finding reached nutrition within the last two weeks, for
//     the ops that compose or change food. A standing finding is the ordinary case the
//     low default already handles; only a new one earns the extra step.
// A bump is ONE step, applied only to the default policy — a person's own effort choice in
// Settings always wins. Reads the raw rows (no repo graph): settings.ts resolves every
// spawn's profile through this, and must stay low in the import order.
import { db } from "../db.js";
import { daysBetweenISO, localDateISO } from "./shared.js";

export type EffortRisk = "open_pain" | "race_window" | "new_finding";

const RISK_WINDOW_DAYS = 14;
const TRAINING_TASKS = new Set(["session_suggest", "session_compose", "week_ahead", "session_verify", "plan_verify"]);
const NUTRITION_TASKS = new Set(["meal_plan", "meal_swap", "recipe", "nutrition_checkin", "meal_plan_verify"]);

function openPain(today: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM training_symptom_events
        WHERE status = 'active' AND scope = 'area' AND legacy_unconfirmed = 0
          AND last_reported_on >= date(?, '-${RISK_WINDOW_DAYS} days')
        LIMIT 1`
    )
    .get(today);
  return !!row;
}

function raceWindow(today: string): boolean {
  const row = db.prepare(`SELECT endurance_goal_json FROM profile WHERE id = 1`).get() as
    | { endurance_goal_json?: string | null }
    | undefined;
  if (!row?.endurance_goal_json) return false;
  let goal: { mode?: unknown; date?: unknown } | null = null;
  try {
    goal = JSON.parse(row.endurance_goal_json);
  } catch {
    return false;
  }
  if (goal?.mode !== "race" || typeof goal.date !== "string") return false;
  const days = daysBetweenISO(goal.date, today);
  return days != null && days >= 0 && days <= RISK_WINDOW_DAYS;
}

function newFinding(today: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM health_directives
        WHERE status = 'active' AND domain = 'nutrition' AND COALESCE(uncertain, 0) = 0
          AND date(created_at) >= date(?, '-${RISK_WINDOW_DAYS} days')
        LIMIT 1`
    )
    .get(today);
  return !!row;
}

/** Why this op should think one step harder today, or null for its default. Never throws. */
export function effortRiskFor(task: string, today: string = localDateISO()): EffortRisk | null {
  try {
    if (TRAINING_TASKS.has(task)) {
      if (openPain(today)) return "open_pain";
      if (raceWindow(today)) return "race_window";
    }
    if (NUTRITION_TASKS.has(task) && newFinding(today)) return "new_finding";
  } catch {
    /* a policy read never breaks a coaching run */
  }
  return null;
}
