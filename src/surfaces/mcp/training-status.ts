import { z } from "zod";
import {
  getEnduranceSchedule,
  getStrengthSchedule,
  normalizeEnduranceSchedule,
  normalizeStatedQuality,
  normalizeStrengthSchedule,
  setProfile,
} from "../../domain/person/index.js";
import {
  getCardioForDate,
  getEnduranceGoal,
  getEndurancePRs,
  getWeeklyStats,
  recordStatedRunWeek,
  runComplianceRead,
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
    "Endurance PRs from logged cardio, GROUPED BY SPORT (a best is only meaningful within its modality): each sport's longest distance + duration, plus fastest pace (min/km at 1/5/10k/half/full) for foot sports (run/walk) or best speed (km/h) for cycling/swim/row. `sports[]` leads with the user's primary endurance sport (profile endurance_sport, default running); flat top-level fields mirror that lead sport for back-compat. Optional `type` filter. Plain numbers — the endurance analogue of the strength est-1RM.",
    { type: z.string().optional().describe("filter to one activity type, e.g. 'run' | 'ride'") },
    async ({ type }) => asText(getEndurancePRs(type))
  );

  server.tool(
    "get_run_compliance",
    "Run compliance for this week (Monday-anchored): the prescribed plan cardio (sessions / km / min) vs the actual logged cardio efforts, plus a plain-language summary ('32 of 40 km this week'). A ratio — the endurance analogue of plan-day adherence for lifting. `basis` says where the prescription came from: 'applied' (the plan rows) or 'live_plan' (this week's live run mix, used when the applied rows prescribe no runs or predate this week).",
    { date: z.string().optional().describe("YYYY-MM-DD inside the week to read; defaults to this week") },
    async ({ date }) => asText(runComplianceRead(date || undefined))
  );

  server.tool(
    "get_cardio",
    "The day's logged cardio efforts (runs/rides/etc.), each hydrated from the linked Garmin record so a synced effort carries its HR zones + pace. Strength is excluded (it's modeled as a session). Defaults to today; pass date YYYY-MM-DD. [] when there's no cardio that day.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(getCardioForDate(date ?? ""))
  );

  server.tool(
    "get_endurance_goal",
    "The user's temporary endurance objective. mode 'race' carries a dated event with weeks/days-to-race + a periodization phase hint (base/build/sharpen/taper); mode 'standing' is an ongoing readiness target with no date. null when unset. Keep durable priority and capability identity in get_training_intent; set this through set_endurance_goal.",
    {},
    async () => asText(getEnduranceGoal())
  );

  server.tool(
    "set_endurance_goal",
    "Set or clear a temporary endurance objective. mode 'race' → a dated event the coach periodizes a ramp + taper toward (needs a real YYYY-MM-DD; optional event, distance_km, target like 'sub-1:45'). mode 'standing' → an ongoing readiness target with NO date. Keep durable priority and capability identity in set_training_intent.",
    {
      mode: z.enum(["race", "standing"]).nullable().optional().describe("'race' | 'standing'; omitting it or passing null clears the whole goal, whatever other fields are sent"),
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

  server.tool(
    "get_endurance_schedule",
    "The athlete's stated run days. days[] is {dow: 0-6 (0=Sunday), kind: easy|quality|long|any}. The run engine and rolling agenda honor these weekdays and never suggest a run off-schedule. `quality`, when present, is the stated quality session {type: threshold|tempo|vo2|hills, work_km?, warm_up_km?, cool_down_km?, note?}: the engine runs that type on the quality day (instead of its phase rotation) as warm-up + work + cool-down, holding the work below the stated km — and saying so — when the week or the athlete's demonstrated running cannot carry it yet. null when unset.",
    {},
    async () => asText(getEnduranceSchedule())
  );

  server.tool(
    "set_endurance_schedule",
    "Set or clear the athlete's stated run days. Only weekdays they named — never invent a day. days is [{dow: 0-6 (0=Sunday), kind: easy|quality|long|any}]. Pass days: null to clear. A duplicate weekday keeps the first kind. A stated recurring NON-RUN day ('Saturday optional, MTB or other') goes in cross_training as {dow, sport}, never as a run day; omit cross_training to keep what is stored, [] clears it. A stated QUALITY SESSION ('Thursday is a hard threshold 5k with a few km around it') goes in quality as {type: 'threshold', work_km: 5, warm_up_km?, cool_down_km?}; omit quality to keep what is stored, quality: null clears it. To change ONLY the quality session, omit days and pass quality — the stored run week, cross-training days and note stay. Likewise omit days and pass cross_training and/or note to change only those; the stored run week stays.",
    {
      days: z
        .array(
          z.object({
            dow: z.number().int().min(0).max(6).describe("0=Sunday … 6=Saturday"),
            kind: z
              .string()
              .describe(
                "easy|quality|long|any for a run day. A non-run sport here (ride, swim, walk, row, paddle, other) with optional: true is moved into cross_training, never kept as a run day"
              ),
            optional: z.boolean().optional(),
          })
        )
        .nullable()
        .optional()
        .describe(
          "pass null to clear the whole schedule (a call with no days, quality, cross_training or note also clears it); omit beside cross_training/note/quality to keep the stored run week"
        ),
      cross_training: z
        .array(
          z.object({
            dow: z.number().int().min(0).max(6).describe("0=Sunday … 6=Saturday"),
            sport: z.string().describe("ride|swim|walk|row|paddle|other"),
            optional: z.literal(true).optional(),
          })
        )
        .optional()
        .describe("stated recurring non-run days, at most three; omit to keep what is stored, [] clears"),
      quality: z
        .object({
          type: z
            .string()
            .describe("threshold|tempo|vo2|hills (a close word like 'cruise' or 'intervals' is read to its type)"),
          work_km: z
            .number()
            .optional()
            .describe("the stated work itself, km (the 5 of 'threshold 5k'); 1-15, clamped. Omit to let the engine size it"),
          warm_up_km: z.number().optional().describe("easy km before the work, 0-5; omit for the engine's default"),
          cool_down_km: z.number().optional().describe("easy km after the work, 0-5; omit for the engine's default"),
          note: z.string().optional().describe("the athlete's own words for the session, up to 160 chars"),
        })
        .nullable()
        .optional()
        .describe(
          "the stated quality session the engine runs on the quality day instead of its phase rotation, still inside the week's ceiling (held below the stated work, and said so, when the week or demonstrated running cannot carry it). Omit to keep what is stored; null clears"
        ),
      note: z.string().optional(),
    },
    async (input) => {
      // The week as it stood: the stated change is recorded in the ledger ("You said X →
      // the brain changed Y", with Undo) once the write lands (stated-input.ts).
      const before = getEnduranceSchedule();
      const words = input.note ?? (input.quality && typeof input.quality === "object" ? input.quality.note : undefined);
      const stated = (result: unknown) => {
        recordStatedRunWeek({ before, words, via: "mcp" });
        return asText(result);
      };
      // Clearing the whole schedule takes an explicit days: null, or a call that states
      // nothing at all. A call that names cross_training, a note or the quality session but
      // no days changes those and keeps the stored run week.
      const statesNothing =
        input.days === undefined &&
        input.quality === undefined &&
        input.cross_training === undefined &&
        input.note === undefined;
      if (input.days === null || statesNothing) return stated(setProfile({ endurance_schedule: null }));
      // A quality-only update: no days, a quality (or null). The stored run week, the
      // cross-training days and the note stand (profile.ts serializeEnduranceSchedule).
      if (input.days === undefined && input.cross_training === undefined && input.note === undefined) {
        if (input.quality !== null && !normalizeStatedQuality(input.quality))
          return asText({ ok: false, error: "quality needs a readable type: threshold|tempo|vo2|hills" });
        return stated(setProfile({ endurance_schedule: { quality: input.quality } }));
      }
      // No days, but cross-training and/or a note: patch them onto the stored run week.
      const stored = input.days === undefined ? before : null;
      const schedule = normalizeEnduranceSchedule({
        days: input.days ?? stored?.days ?? [],
        ...(input.cross_training !== undefined
          ? { cross_training: input.cross_training }
          : stored?.cross_training
            ? { cross_training: stored.cross_training }
            : {}),
        note: input.note !== undefined ? input.note : (stored?.note ?? undefined),
        source: "athlete",
      });
      if (!schedule) {
        return asText({
          ok: false,
          error:
            "endurance_schedule requires at least one valid day (dow 0-6, kind easy|quality|long|any, or a cross-training sport)",
        });
      }
      // An explicit cross_training (even []) is passed on as said, so [] clears the stored
      // days; omitted, setProfile keeps them (profile.ts serializeEnduranceSchedule).
      const next: Record<string, unknown> =
        input.cross_training !== undefined
          ? { ...schedule, cross_training: schedule.cross_training ?? [] }
          : { ...schedule };
      // The quality session as said (null clears); omitted, setProfile keeps the stored one.
      if (input.quality !== undefined) next.quality = input.quality;
      return stated(setProfile({ endurance_schedule: next }));
    }
  );

  server.tool(
    "get_strength_schedule",
    "The athlete's stated LIFTING weekdays. days[] is {dow: 0-6 (0=Sunday)} — no kind, because which split lands on which day is the plan's business, not the schedule's. When set, the weekday ring lays the plan's strength days onto exactly these weekdays and never puts one on an unstated weekday. null when unset.",
    {},
    async () => asText(getStrengthSchedule())
  );

  server.tool(
    "set_strength_schedule",
    "Set or clear the athlete's stated lifting weekdays. Only weekdays they named — never invent a day. days is [{dow: 0-6 (0=Sunday)}]. Pass days: null (or omit) to clear the schedule; days: [] clears it too. A duplicate weekday is kept once.",
    {
      days: z
        .array(z.object({ dow: z.number().int().min(0).max(6).describe("0=Sunday … 6=Saturday") }))
        .nullable()
        .optional()
        .describe("omit or pass null to clear the whole schedule"),
      note: z.string().optional(),
    },
    async (input) => {
      if (input.days == null) return asText(setProfile({ strength_schedule: null }));
      const schedule = normalizeStrengthSchedule({ days: input.days, note: input.note, source: "athlete" });
      if (!schedule) {
        return asText({
          ok: false,
          error: "strength_schedule requires days to be a list of {dow: 0-6} (an empty list clears it)",
        });
      }
      return asText(setProfile({ strength_schedule: schedule }));
    }
  );
}
