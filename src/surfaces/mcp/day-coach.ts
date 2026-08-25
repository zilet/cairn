import { z } from "zod";
import {
  dailySessionErrorBody,
  isDailySessionAbsence,
  prepareDailySessionUseCase,
  previewAdaptiveDailySessionUseCase,
} from "../../domain/training/index.js";
import {
  dailyOutcomeRead,
  decideDailySession,
  getActiveDailySession,
  recordDailySessionDecision,
  sessionPrimer,
} from "../../repo.js";
import { localDateISO } from "../../repo/shared.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";

export function registerDayCoachTools(server: McpToolRegistrar) {
  server.tool(
    "get_day_read",
    "Queue a durable read of what KIND of day today should be — train, easy, or rest — as a calm suggestion. Returns a job immediately; poll get_agent_job for the final read. override reshapes it ('rough night' / 'short on time' / 'I want to train anyway').",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      override: z.string().optional().describe("free-text steer, e.g. 'rough night', 'short on time', 'train anyway'"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ date, override, agent }) => asText(queueMcpAgentJob("day_read_override", { date, override }, agent))
  );

  server.tool(
    "suggest_session",
    "Queue one session suggestion for today, honoring time, equipment, focus, injury, and the day read. Returns a job immediately; poll get_agent_job. The result is preview-only until prepare_daily_session is called; it never mutates the weekly plan.",
    {
      minutes: z.number().int().optional().describe("time budget in minutes (compresses the session)"),
      equipment: z.string().optional().describe("equipment available, e.g. 'dumbbells only' / 'hotel gym'"),
      focus: z.string().optional().describe("muscle/quality focus, e.g. 'lower body'"),
      constraints: z.string().optional().describe("anything to work around, e.g. 'sore left shoulder'"),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ minutes, equipment, focus, constraints, date, agent }) =>
      asText(
        queueMcpAgentJob(
          "session_suggest",
          { minutes, equipment, focus, constraints, date: date ?? localDateISO() },
          agent
        )
      )
  );

  server.tool(
    "compose_daily_session",
    "Queue a bounded agent composition for today: the server first decides the deterministic envelope (kind, muscle allow/exclude, caps, candidates), then the agent composes ONE session strictly inside it — every item is verified and clamped server-side, and absent/invalid output degrades to a deterministic session. Returns a job immediately; poll get_agent_job. Preview-only; accept via prepare_daily_session (source agent_suggest) with the job id. Never mutates the weekly plan.",
    {
      minutes: z.number().int().optional().describe("time budget in minutes"),
      equipment: z.string().optional().describe("equipment available, e.g. 'dumbbells only'"),
      override: z
        .string()
        .optional()
        .describe("free-text steer, e.g. 'train anyway' / 'rough night' / 'short on time'"),
      train_anyway: z
        .boolean()
        .optional()
        .describe("explicit athlete choice to train despite a rest/easy baseline; conservative safety caps still apply"),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ minutes, equipment, override, train_anyway, date, agent }) =>
      asText(
        queueMcpAgentJob(
          "session_compose",
          { minutes, equipment, override, train_anyway, date: date ?? localDateISO() },
          agent
        )
      )
  );

  server.tool(
    "get_daily_session",
    "Read the active durable daily-session composition for a date, including its exact prescribed strength/cardio items and session_id. Returns null when none has been prepared.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(getActiveDailySession(date))
  );

  server.tool(
    "preview_daily_session",
    "Preview the exact read-only adaptive session candidate Cairn would persist for this date and intent. Returns calm athlete-facing constraints and rationale plus an input fingerprint for compare-and-set prepare, or null when the date has no weekly template day to build one from. Never records a decision or creates a workout session.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      override: z.string().optional().describe("exact day steer used for this preview"),
      train_anyway: z.boolean().optional().describe("explicit athlete choice to train within current safety caps"),
    },
    async ({ date, override, train_anyway }) => {
      try {
        return asText(
          previewAdaptiveDailySessionUseCase({
            date,
            constraints: override ? { day_read_override: override } : {},
            train_anyway: train_anyway === true,
          })
        );
      } catch (error) {
        // Mirrors GET /api/daily-session/preview: an absent template day is null, not a
        // failure. Malformed input still surfaces as a tool error.
        if (isDailySessionAbsence(error)) return asText(null);
        throw error;
      }
    }
  );

  server.tool(
    "get_daily_session_decision",
    "Read the deterministic daily-session decision envelope for a date — the explainable, reproducible read (train/easy/rest kind, required/allowed/reduced/excluded muscles, volume/intensity/duration caps, candidate exercises, and the reason codes) BEFORE any agent composes. Same inputs always yield the same envelope and input_fingerprint. Agent-free.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      override: z
        .string()
        .optional()
        .describe("free-text steer, e.g. 'train anyway' / 'rough night' / 'short on time'"),
      train_anyway: z.boolean().optional().describe("explicit athlete choice to train with conservative safety caps"),
      equipment: z.string().optional().describe("equipment available, e.g. 'dumbbells only'"),
      minutes: z.number().int().optional().describe("time budget in minutes"),
    },
    async ({ date, override, train_anyway, equipment, minutes }) => {
      const { envelope } = decideDailySession(date, {
        override: override ?? null,
        train_anyway: train_anyway === true,
        equipment: equipment ?? null,
        minutes: minutes ?? null,
      });
      try {
        recordDailySessionDecision(envelope);
      } catch {
        /* observability write never blocks the read */
      }
      return asText(envelope);
    }
  );

  server.tool(
    "prepare_daily_session",
    "Explicitly persist a daily session without changing the weekly plan. Pass expected_active_id alone to assert that a cached composition still owns the date without creating or replacing anything. adaptive_plan/manual_plan snapshot a plan day; agent_suggest requires its completed session-suggest agent_job_id; athlete_override accepts a user-authored session, including an empty open session. Exact retries reuse safely; a different replace is refused after the session starts.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      expected_active_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("assertion-only active composition id; needs no source/session and never writes"),
      expected_input_fingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe("adaptive preview fingerprint; stale candidates return a fresh preview without writing"),
      day_number: z.number().int().optional().describe("explicit plan day; omit for the adaptive selection"),
      agent_job_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("required completed session-suggest job id for agent_suggest"),
      source: z
        .enum(["adaptive_plan", "agent_suggest", "manual_plan", "athlete_override"])
        .optional()
        .describe("composition provenance; defaults to adaptive_plan"),
      session: z.unknown().optional().describe("user-authored session shape; used only by athlete_override"),
      constraints: z.unknown().optional().describe("optional bounded JSON constraints captured with the snapshot"),
      provenance: z
        .unknown()
        .optional()
        .describe("optional bounded JSON provenance for athlete_override; agent_suggest provenance is server-derived"),
      train_anyway: z
        .boolean()
        .optional()
        .describe("explicit athlete override; adaptive_plan becomes a conservatively capped train composition"),
      replace: z.boolean().optional().describe("supersede the active composition before logging starts"),
    },
    async (input) => {
      try {
        return asText(prepareDailySessionUseCase(input));
      } catch (error) {
        return asText(dailySessionErrorBody(error));
      }
    }
  );

  server.tool(
    "get_daily_session_outcome",
    "Read the daily-session outcome reconciliation for a date or session — what was suggested vs actually trained, progression evidence, feedback, and adherence-neutral context. A calm athlete-facing learning is added only after completion. Deterministic, agent-free; null when no reconciled daily session exists.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      session_id: z.number().int().positive().optional().describe("exact completed session; takes precedence over date"),
    },
    async ({ date, session_id }) => asText(dailyOutcomeRead({ date, session_id }))
  );

  server.tool(
    "get_session_primer",
    "Read the calm, deterministic pre-session primer for a day — why today's session is what it is (from the Brief), what changed since last time, what to watch, and what's deliberately fresh. Returns immediately (no agent). null when there's nothing worth saying beyond the Brief.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      day: z.number().int().optional().describe("explicit plan-day number to prime; omit to use the adaptive pick"),
    },
    async ({ date, day }) =>
      asText(sessionPrimer(date, { dayNumber: day != null && Number.isFinite(day) ? day : null }))
  );

  server.tool(
    "get_week_ahead",
    "Queue a calm sketch of the next several days — lift / run / mixed / rest — honoring injuries, recovery, and health directives. Returns a job immediately; poll get_agent_job. It remains a suggestion, never a fixed schedule.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("week_ahead", {}, agent))
  );
}
