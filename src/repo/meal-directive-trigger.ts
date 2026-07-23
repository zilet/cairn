// Reactivity: when directive derivation produces a NEW material nutrition/watch
// directive that postdates the current accepted meal plan, enqueue a meal-plan
// REGENERATION through the existing owned-refresh channel — the scheduler drafts
// it via draftMealPlan → the autonomy policy (announce/quiet per lead_mode) at
// tomorrow's food-day boundary. This NEVER runs an agent inline on the derivation
// write path; it only stamps the durable request app_state.
//
// Anti-pileup mirrors programEvolutionTrigger (repo/progression.ts): fires only on
// a NEW directive-set signature, with a cooldown + single-slot dedup, so a standing
// directive set acts once, not daily. Degrades to a calm no-op end to end (no agent,
// no accepted plan, no directive postdating the plan, unchanged signature, or within
// cooldown all skip). Self-contained direct reads — no coupling to nutrition/coach —
// so it stays a safe leaf import for propagation.ts.
import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { MEAL_REFRESH_INSTRUCTION_KEY, MEAL_REFRESH_REQUEST_KEY } from "./meal-refresh-retry.js";
import { pickAgentOrder } from "./settings.js";
import { addDaysISO, localDateISO } from "./shared.js";

const REFRESH_SIG_KEY = "meal_directive_refresh_sig";
const REFRESH_DATE_KEY = "meal_directive_refresh_date";
export const MEAL_DIRECTIVE_REFRESH_COOLDOWN_DAYS = 5;

const DIRECTIVE_REFRESH_INSTRUCTION =
  "A new health directive affecting nutrition has landed since this meal plan was drafted. " +
  "Refresh the upcoming week of meals so it reflects the current health directives, training, " +
  "recovery, preferences, schedule, and accepted nutrition target.";

// SQLite `datetime('now')` values are "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker).
function parseSqliteTs(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  return Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
}

interface NutritionDirectiveState {
  keys: string[];
  newestCreatedMs: number | null;
}

// The active nutrition/watch directive IDENTITY set (sorted) + the newest such
// directive's creation instant. Only rows carrying real directive text count — a
// blank row is not a material directive.
function nutritionDirectiveState(): NutritionDirectiveState {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT domain, marker, directive_key, directive, created_at
           FROM health_directives
          WHERE status = 'active' AND (domain = 'nutrition' OR domain = 'watch')`
      )
      .all() as any[];
  } catch {
    rows = [];
  }
  const keys: string[] = [];
  let newestCreatedMs: number | null = null;
  for (const r of rows) {
    if (!String(r?.directive || "").trim()) continue;
    const key = [
      String(r?.domain || "watch").toLowerCase(),
      String(r?.marker || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim(),
      String(r?.directive_key || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim(),
    ].join("|");
    keys.push(key);
    const ms = parseSqliteTs(r?.created_at);
    if (Number.isFinite(ms)) newestCreatedMs = newestCreatedMs == null ? ms : Math.max(newestCreatedMs, ms);
  }
  keys.sort();
  return { keys, newestCreatedMs };
}

// The current accepted meal plan's creation instant (the plan the athlete is
// actually eating). A draft-only history — no accepted plan — means there's nothing
// to regenerate against yet (the first accepted plan will already be drafted from
// current directives), so the trigger stays quiet.
function acceptedMealPlanCreatedMs(): number | null {
  try {
    const row = db
      .prepare(
        `SELECT created_at FROM meal_plans
          WHERE status IN ('accepted','applied','kept')
          ORDER BY id DESC LIMIT 1`
      )
      .get() as any;
    const ms = parseSqliteTs(row?.created_at);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function agentsAvailable(): boolean {
  try {
    return pickAgentOrder().length > 0;
  } catch {
    return false;
  }
}

// Returns true iff a fresh refresh request was written. `opts.agentsAvailable`
// injects the agent-availability read for offline tests; production computes it.
export function maybeRequestMealRefreshForDirectives(
  opts: { now?: Date; today?: string; agentsAvailable?: boolean } = {}
): boolean {
  const now = opts.now ?? new Date();
  const today = opts.today ?? localDateISO(now);

  // No agent could ever run the refresh → don't queue work that can't happen.
  if (!(opts.agentsAvailable ?? agentsAvailable())) return false;

  // An owned refresh is already pending; its instruction re-reads current directives,
  // so the new one is already covered. Never stack a second request.
  if (String(getAppState(MEAL_REFRESH_REQUEST_KEY) ?? "").trim()) return false;

  const { keys, newestCreatedMs } = nutritionDirectiveState();
  if (keys.length === 0 || newestCreatedMs == null) return false;

  const planCreatedMs = acceptedMealPlanCreatedMs();
  if (planCreatedMs == null) return false; // nothing accepted to regenerate against
  if (newestCreatedMs <= planCreatedMs) return false; // no directive postdates the plan

  const sig = keys.join("||");
  if (getAppState(REFRESH_SIG_KEY) === sig) return false; // already acted on this exact set

  // Cooldown: at most one directive-driven refresh request per COOLDOWN_DAYS, so a
  // standing directive set can't re-request daily (single-slot dedup + cadence).
  const lastDate = String(getAppState(REFRESH_DATE_KEY) ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
    const ageDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / 864e5);
    if (Number.isFinite(ageDays) && ageDays < MEAL_DIRECTIVE_REFRESH_COOLDOWN_DAYS) return false;
  }

  const boundary = addDaysISO(today, 1) ?? today; // lands at tomorrow's food-day boundary
  try {
    setAppState(MEAL_REFRESH_REQUEST_KEY, boundary);
    setAppState(MEAL_REFRESH_INSTRUCTION_KEY, DIRECTIVE_REFRESH_INSTRUCTION);
    setAppState(REFRESH_SIG_KEY, sig);
    setAppState(REFRESH_DATE_KEY, today);
  } catch {
    return false;
  }
  return true;
}
