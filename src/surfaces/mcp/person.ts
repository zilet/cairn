import { z } from "zod";
import {
  addBloodPressureReading,
  deriveDirectives,
  getDailyMetrics,
  listBloodPressureReadings,
  recordDailyMetrics,
} from "../../domain/health/index.js";
import {
  addCheckin,
  computeGoalCheck,
  confirmGoalCheckin,
  dismissGoalCheckin,
  getCheckinByDate,
  getEnduranceCapacity,
  getProfile,
  getTrainingIntent,
  listCheckins,
  listWeight,
  logWeight,
  setProfile,
} from "../../domain/person/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerPersonTools(server: McpToolRegistrar) {
  server.tool("get_profile", "Get the user's profile (age, height, weight, goal).", {}, async () =>
    asText(getProfile())
  );

  server.tool(
    "set_profile",
    "Update profile fields (any subset). name is the user's name (optional; stamped on the doctor-ready clinical report — pass '' to clear). home_location is the durable home base used as planning context; pass '' to clear. A dated trip's context-event meta.location overrides the effective location only while that trip is active and never overwrites home. Weight in lb, height in cm. about_me is free-text the coach uses to personalize (training history, work pattern, food likes/dislikes, what 'better' means to you); pass '' to clear. allergies are a HARD safety exclusion for meal planning; dietary_restrictions (vegetarian, no pork, …) are respected strongly. Pass '' to clear either. primary_discipline ('strength'|'endurance'|'hybrid', default 'strength') remains a broad compatibility label; training_intent is the athlete-owned ordered priorities, explicit endurance role, and optional durable capability. endurance_sport is optional free text, '' clears it.",
    {
      name: z
        .string()
        .optional()
        .describe("athlete's name; optional, stamped on the doctor-ready clinical report. Pass '' to clear, omit to leave unchanged"),
      home_location: z
        .string()
        .max(160)
        .optional()
        .describe(
          "durable home base; '' clears. Temporary travel belongs in a dated trip context event with meta.location"
        ),
      sex: z
        .string()
        .optional()
        .describe(
          "free-text (not an enum); selects health reference ranges and the female-only Navy body-fat formula. Left unset rather than guessed when unknown — never default it to a value"
        ),
      age: z.number().optional().describe("years; informs dose/recovery framing and reference ranges"),
      height_cm: z
        .number()
        .optional()
        .describe(
          "height in centimetres; required before BMI or body-fat estimates compute. Providing height_in on log_body_measurement also back-fills this field"
        ),
      weight_lb: z
        .number()
        .optional()
        .describe(
          "current bodyweight in pounds; updates only the profile's stored value, not a weigh-in log — use log_weight to record a dated entry that feeds the goal-pace series and TDEE bodyweight trend"
        ),
      goal_weight_lb: z
        .number()
        .optional()
        .describe(
          "target bodyweight in pounds; paired with goal_date drives the lean-safe deficit/surplus calc. Changing it is a goal-identity change and always requires the athlete's explicit approval"
        ),
      goal_date: z
        .string()
        .optional()
        .describe(
          "YYYY-MM-DD target date for goal_weight_lb; changing it is a goal-identity change and always requires the athlete's explicit approval"
        ),
      activity_factor: z
        .number()
        .optional()
        .describe(
          "TDEE activity multiplier applied to formula BMR when no measured/adaptive expenditure is available; default 1.5 (roughly 'moderately active')"
        ),
      notes: z.string().optional().describe("free-text profile notes; overwritten wholesale by any provided value"),
      about_me: z
        .string()
        .optional()
        .describe(
          "free-text the coach uses to personalize (training history, work pattern, food likes/dislikes, what 'better' means to you), up to 8000 chars; '' clears, omit to leave unchanged"
        ),
      allergies: z
        .string()
        .optional()
        .describe(
          "HARD safety exclusion for meal planning (never suggested, not just avoided); free text, up to 1000 chars; '' clears, omit to leave unchanged"
        ),
      dietary_restrictions: z
        .string()
        .optional()
        .describe(
          "soft preference respected strongly but not a hard exclusion (vegetarian, no pork, …); free text, up to 1000 chars; '' clears, omit to leave unchanged"
        ),
      primary_discipline: z
        .enum(["strength", "endurance", "hybrid"])
        .optional()
        .describe(
          "broad compatibility label driving coach framing, day-read, and weekly stats; default 'strength'. training_intent is the richer, athlete-owned priority ordering — set both when possible"
        ),
      endurance_sport: z
        .string()
        .optional()
        .describe("optional free text naming the athlete's endurance sport, up to 60 chars; '' clears, omit to leave unchanged"),
      endurance_schedule: z
        .object({
          days: z
            .array(
              z.object({
                dow: z.number().int().min(0).max(6).describe("0=Sunday … 6=Saturday"),
                kind: z.enum(["easy", "quality", "long", "any"]),
              })
            )
            .min(1),
          note: z.string().optional(),
          source: z.enum(["athlete", "chat"]).optional(),
        })
        .nullable()
        .optional()
        .describe(
          "stated run days the engine honors; only weekdays the athlete named. null clears. Never invent days they did not say"
        ),
      strength_schedule: z
        .object({
          days: z.array(z.object({ dow: z.number().int().min(0).max(6).describe("0=Sunday … 6=Saturday") })),
          note: z.string().optional(),
          source: z.enum(["athlete", "chat"]).optional(),
        })
        .nullable()
        .optional()
        .describe(
          "stated LIFTING weekdays the weekday ring lays the plan's strength days onto; only weekdays the athlete named, no kind. days: [] clears, null clears. Never invent days they did not say"
        ),
      training_intent: z
        .object({
          priorities: z
            .array(z.enum(["longevity", "muscle", "leanness", "strength", "endurance"]))
            .min(1)
            .max(5),
          endurance_role: z.enum(["none", "supporting", "co_primary", "primary"]),
          endurance_capacity: z
            .object({
              sport: z.string().min(1).max(60),
              target_duration_min: z.number().positive().max(1440),
              context: z.string().max(240).nullable().optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional()
        .describe(
          "ordered durable goals and endurance role; separate from a temporary dated endurance event"
        ),
      goal_mode: z
        .enum(["lose", "maintain", "gain"])
        .optional()
        .describe(
          "the journey's shape: 'lose' (lean-safe deficit), 'maintain' (anchor to real expenditure — no deficit), 'gain' (conservative lean surplus). Omit to leave a stored mode unchanged; only with none stored does it derive from the goal weight. This schema cannot send the null/'' that resets an explicit mode back to derived."
        ),
    },
    async (p) => asText(setProfile(p))
  );

  server.tool(
    "get_training_intent",
    "Read the athlete's ordered durable training priorities, endurance role, and optional sport-specific duration capability. Also returns a deterministic capability read from logged activity. This is identity; a dated race is a temporary overlay.",
    {},
    async () => {
      const intent = getTrainingIntent();
      return asText({ intent, endurance_capacity: getEnduranceCapacity(intent) });
    }
  );

  server.tool(
    "set_training_intent",
    "Set or clear the athlete's durable training direction. Priorities are ordered. endurance_role is none, supporting, co_primary, or primary. Use endurance_capacity for a real-world ability such as a 120-minute MTB ride; keep temporary races in set_endurance_goal. Age informs dose and recovery but must not silently reorder athlete-owned priorities.",
    {
      priorities: z
        .array(z.enum(["longevity", "muscle", "leanness", "strength", "endurance"]))
        .min(1)
        .max(5)
        .optional(),
      endurance_role: z.enum(["none", "supporting", "co_primary", "primary"]).optional(),
      endurance_capacity: z
        .object({
          sport: z.string().min(1).max(60),
          target_duration_min: z.number().positive().max(1440),
          context: z.string().max(240).nullable().optional(),
        })
        .nullable()
        .optional(),
      clear: z.boolean().optional().describe("true clears explicit intent and restores legacy-derived behavior"),
    },
    async ({ clear, priorities, endurance_role, endurance_capacity }) => {
      if (clear) {
        const profile = setProfile({ training_intent: null });
        const intent = getTrainingIntent(profile);
        return asText({ intent, endurance_capacity: getEnduranceCapacity(intent) });
      }
      if (!priorities?.length || !endurance_role) {
        return asText({ ok: false, error: "priorities and endurance_role are required unless clear is true" });
      }
      const profile = setProfile({
        training_intent: { priorities, endurance_role, endurance_capacity },
      });
      const intent = getTrainingIntent(profile);
      return asText({ intent, endurance_capacity: getEnduranceCapacity(intent) });
    }
  );

  server.tool("get_goal_check", "Compute TDEE and a lean-safe feasibility check for the current goal.", {}, async () =>
    asText(computeGoalCheck())
  );

  server.tool(
    "log_weight",
    "Record a bodyweight measurement (lb). Also updates the profile's current weight to the latest entry.",
    {
      weight_lb: z.number(),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      note: z.string().optional(),
    },
    async (a) => asText(logWeight(a.weight_lb, a.date, a.note))
  );

  server.tool(
    "list_weight",
    "List bodyweight history (chronological).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listWeight(limit ?? 60))
  );

  server.tool(
    "log_blood_pressure",
    "Record a point-in-time blood pressure reading. Use measured_at for the actual cuff/clinic time (YYYY-MM-DD or YYYY-MM-DDTHH:mm). The reading also appears in marker history as Systolic BP, Diastolic BP, and Pulse when present.",
    {
      systolic: z.number().describe("mmHg, clamped to 60-260; must be greater than diastolic"),
      diastolic: z.number().describe("mmHg, clamped to 35-160; must be less than systolic"),
      pulse: z.number().optional().describe("bpm, clamped to 25-240; omit if not measured"),
      measured_at: z
        .string()
        .optional()
        .describe("YYYY-MM-DD or YYYY-MM-DDTHH:mm; a bare date is stored at noon. Omit to use now"),
      source: z.string().optional().describe("who/what took the reading, e.g. 'manual', 'apple'; default 'manual'"),
      position: z.string().optional().describe("body position during the reading, e.g. 'sitting', 'standing'; free text"),
      note: z.string().optional().describe("free-text note stored with this reading, up to 240 chars"),
    },
    async (a) => {
      const row = addBloodPressureReading({
        measured_at: a.measured_at ?? null,
        systolic: a.systolic,
        diastolic: a.diastolic,
        pulse: a.pulse ?? null,
        source: a.source ?? "manual",
        position: a.position ?? null,
        note: a.note ?? null,
      });
      try {
        deriveDirectives();
      } catch {
        /* never fail the vital log */
      }
      return asText(row);
    }
  );

  server.tool(
    "list_blood_pressure",
    "List blood pressure readings newest-first. BP is point-in-time, so trends come from repeated readings rather than a single profile value.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listBloodPressureReadings(limit ?? 60))
  );

  server.tool(
    "confirm_goal_checkin",
    "Restart the gentle 'is this still your goal?' clock (Era 2): records that the user confirmed (or changed) their goal, so the quiet check-in stays away for ~3 months. You-drive — changes nothing else.",
    {},
    async () => {
      confirmGoalCheckin();
      return asText({ ok: true });
    }
  );

  server.tool(
    "dismiss_goal_checkin",
    "Wave off the gentle goal check-in (Era 2): starts a long cooldown so it stays quiet. Dismissible to silence.",
    {},
    async () => {
      dismissGoalCheckin();
      return asText({ ok: true });
    }
  );

  server.tool(
    "add_checkin",
    "Record an optional morning check-in (a day-read signal — offered, never required). All fields optional; mood/energy/sleep_feel/soreness are 1-5 (clamped). Several per day are allowed; the latest wins for reads.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      mood: z.number().optional(),
      energy: z.number().optional(),
      sleep_feel: z.number().optional(),
      soreness: z.number().optional(),
      note: z.string().optional(),
    },
    async ({ date, ...fields }) => asText(addCheckin(date ?? "", fields))
  );

  server.tool(
    "get_checkin",
    "Get the latest check-in for a date (or null if none).",
    { date: z.string().describe("YYYY-MM-DD") },
    async ({ date }) => asText(getCheckinByDate(date))
  );

  server.tool(
    "list_checkins",
    "List recent check-ins (newest first).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listCheckins(limit ?? 14))
  );

  server.tool(
    "record_daily_metrics",
    "Upsert one source's daily wearable metrics for a real, non-future YYYY-MM-DD (idempotent on source+date) — the Apple Health via Shortcuts path. `source` defaults to 'apple' and is capped at 64 characters. Partial re-posts preserve previously recorded fields. Supports steps, sleep/recovery, calories, distance, exercise/stand time, SpO2 and VO2max; `raw` keeps the source payload verbatim.",
    {
      date: z.string().describe("YYYY-MM-DD; real, non-future date only"),
      source: z.string().max(64).optional().describe("default 'apple'"),
      steps: z.number().nullable().optional().describe("step count for the day, clamped 0-200000; null/omit leaves any existing value on this source+date untouched"),
      sleep_min: z.number().nullable().optional().describe("total sleep in minutes, clamped 0-1440; null/omit leaves any existing value untouched"),
      sleep_score: z.number().nullable().optional().describe("0-100 device sleep score; null/omit leaves any existing value untouched"),
      resting_hr: z.number().nullable().optional().describe("resting heart rate in bpm, clamped 0-250; null/omit leaves any existing value untouched"),
      hrv_ms: z.number().nullable().optional().describe("heart-rate variability in milliseconds, clamped 0-500; null/omit leaves any existing value untouched"),
      active_calories: z.number().nullable().optional().describe("active-energy kcal for the day, clamped 0-20000; null/omit leaves any existing value untouched"),
      total_calories: z.number().nullable().optional().describe("total-energy kcal for the day, clamped 0-30000; null/omit leaves any existing value untouched"),
      distance_km: z.number().nullable().optional().describe("distance covered in kilometres, clamped 0-1000; null/omit leaves any existing value untouched"),
      exercise_min: z.number().nullable().optional().describe("exercise minutes for the day, clamped 0-1440; null/omit leaves any existing value untouched"),
      stand_hours: z.number().nullable().optional().describe("Apple Watch stand hours, clamped 0-24; null/omit leaves any existing value untouched"),
      spo2_avg: z
        .number()
        .nullable()
        .optional()
        .describe(
          "average blood oxygen; accepts either a HealthKit 0-1 fraction or a 0-100 percent, both normalized to percent. A value outside the plausible 50-100% range is rejected (stored as missing), never clamped, so a bad reading never masquerades as a real one"
        ),
      vo2max: z.number().nullable().optional().describe("VO2max in mL/kg/min, clamped 5-100; null/omit leaves any existing value untouched"),
      raw: z.any().optional().describe("source payload kept verbatim alongside the parsed fields, for debugging/traceability"),
    },
    async ({ date, source, ...metrics }) => asText(recordDailyMetrics(source ?? "apple", date, metrics))
  );

  server.tool(
    "get_daily_metrics",
    "Recent daily metric rows for a source (default all sources) over the last N days (default 30).",
    { source: z.string().max(64).optional(), days: z.number().int().min(1).max(366).optional() },
    async ({ source, days }) => asText(getDailyMetrics(source ?? null, days ?? 30))
  );
}
