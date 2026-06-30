import { z } from "zod";
import { setProfile } from "../../domain/person/index.js";
import {
  getCardioForDate,
  getEnduranceGoal,
  getEndurancePRs,
  getRunCompliance,
  getWeeklyStats,
} from "../../domain/training/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerTrainingStatusTools(server: McpToolRegistrar) {
  server.tool(
    "get_weekly_stats",
    "Compact weekly dashboard: training days, tonnage, total logged sets (incl. timed) over the last 7 days, plus the consistency streak — and an additive `endurance` block (this week's mileage, moving time, longest effort, time-in-HR-zone, pace trend) for runner/hybrid athletes.",
    {},
    async () => asText(getWeeklyStats())
  );

  server.tool(
    "get_endurance_prs",
    "Endurance PRs from logged cardio, GROUPED BY SPORT (a best is only meaningful within its modality): each sport's longest distance + duration, plus fastest pace (min/km at 1/5/10k/half/full) for foot sports (run/walk) or best speed (km/h) for cycling/swim/row. `sports[]` leads with the athlete's primary endurance sport (profile endurance_sport, default running); flat top-level fields mirror that lead sport for back-compat. Optional `type` filter. Plain numbers, never a score — the endurance analogue of the strength est-1RM.",
    { type: z.string().optional().describe("filter to one activity type, e.g. 'run' | 'ride'") },
    async ({ type }) => asText(getEndurancePRs(type))
  );

  server.tool(
    "get_run_compliance",
    "Run compliance for this week (Monday-anchored): the prescribed plan cardio (sessions / km / min) vs the actual logged cardio efforts, plus a plain-language summary ('32 of 40 km this week'). A ratio, never a 0-100 score — the endurance analogue of plan-day adherence for lifting.",
    {},
    async () => asText(getRunCompliance())
  );

  server.tool(
    "get_cardio",
    "The day's logged cardio efforts (runs/rides/etc.), each hydrated from the linked Garmin record so a synced effort carries its HR zones + pace. Strength is excluded (it's modeled as a session). Defaults to today; pass date YYYY-MM-DD. [] when there's no cardio that day.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(getCardioForDate(date ?? ""))
  );

  server.tool(
    "get_endurance_goal",
    "The athlete's endurance OBJECTIVE (v37), computed. mode 'race' carries a dated event with weeks/days-to-race + a periodization phase hint (base/build/sharpen/taper); mode 'standing' is an ongoing readiness target with no date. null when unset. Orthogonal to primary_discipline. Set it via set_profile { endurance_goal: {…} }.",
    {},
    async () => asText(getEnduranceGoal())
  );

  server.tool(
    "set_endurance_goal",
    "Set or clear the athlete's endurance OBJECTIVE (running goal). mode 'race' → a dated event the coach periodizes a ramp + taper toward (needs date YYYY-MM-DD; optional event, distance_km, target like 'sub-1:45'). mode 'standing' → an ongoing readiness target with NO date (e.g. label '10k-ready', distance_km 10). Pass null to clear. Orthogonal to primary_discipline (a strength-first athlete can hold a standing running goal).",
    {
      mode: z.enum(["race", "standing"]).nullable().optional().describe("'race' | 'standing'; omit/null with no other fields to clear"),
      event: z.string().optional(),
      date: z.string().optional().describe("YYYY-MM-DD (race mode)"),
      label: z.string().optional().describe("readiness label (standing mode), e.g. '10k-ready'"),
      distance_km: z.number().optional(),
      target: z.string().optional(),
      weekly_km: z.number().optional(),
      weekly_sessions: z.number().optional(),
    },
    async (goal) => {
      // A race without a date can't be periodized; reject it rather than clearing the goal.
      if (goal.mode === "race" && !goal.date) return asText({ ok: false, error: "race mode requires a date (YYYY-MM-DD)" });
      return asText(setProfile({ endurance_goal: goal.mode == null ? null : goal }));
    }
  );
}
