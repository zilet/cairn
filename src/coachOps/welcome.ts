// The first run, server half: proving a freshly connected agent answers (verifyAgent)
// and the coach's first conversation (welcomeCoach). The welcome is the ONE place a
// brand-new install goes from "nothing" to "a week and a starting food target in place",
// and it does that only through the existing writers — the onboarding extraction, the
// blank-slate week composer and its autonomy routing, the nutrition target's floors —
// never a scripted stand-in for an agent. No agent ⇒ the designed {ok:false} and nothing
// pretends to coach.

import { addChatMessage, listChatMessages } from "../repo/chat.js";
import { violatesReadingGrammar } from "../repo/day-read-grammar.js";
import { pickDayVariant } from "../repo/brain/day-read-rules.js";
import { getLatestNutritionTarget, setNutritionTarget } from "../repo/nutrition.js";
import { getPlan } from "../repo/plan.js";
import { weekdayPlanDayMap } from "../repo/plan-selection.js";
import { statedLiftDows } from "../repo/profile.js";
import { executionProfileForOp, getSettings, interactiveTimeoutForOp, setSettings } from "../repo/settings.js";
import { localDateISO } from "../repo/shared.js";
import { applyDueAnnouncedDecisions } from "../domain/brain/autonomy-service.js";
import { classifyAgentFailure, resourceFailureHeadline, type AgentFailure } from "../agentAvailability.js";
import {
  AgentFallbackError,
  commandPresent,
  invalidateAgentConfigured,
  loadAgents,
  recordAgentAnswered,
  reprobeAgentConfigured,
  runAgent,
} from "../agents.js";
import { isAgentBusyError } from "../agent-busy.js";
import { runChosen } from "../runChosen.js";
import { buildOnboardPrompt } from "../prompt/program.js";
import { ONBOARD_SCHEMA } from "../agent-contracts.js";
import { log } from "../log.js";
import { agentFailure, agentStatusFor } from "./shared.js";
import type { OpHooks } from "./shared.js";
import { applyOnboardBase, applyOnboardParsed, emptyOnboardApplied, type OnboardApplied } from "./memory.js";
import { composeWeek } from "./training.js";

// ---------- verify: "say hello" through the real spawn path ----------

export type AgentVerifyReason =
  | "busy"
  | "not_signed_in"
  | "timeout"
  | "failed"
  | "not_installed"
  // The SERVER ran out of room, not the provider — the message says what to do.
  | "disk_full"
  | "out_of_memory";
export type AgentVerifyResult =
  | { ok: true; agent: string; ms: number }
  | { ok: false; agent: string; reason: AgentVerifyReason; message: string };

/** The connect step's round-trip leash: long enough for a cold CLI, short enough to feel live. */
export const AGENT_VERIFY_TIMEOUT_MS = 75_000;

const VERIFY_PROMPT = `This is a connection check from Cairn, a training app, run once while someone connects you.
Reply with exactly this JSON object and nothing else: {"ok": true}`;

/** The name a person knows a provider by (agents.json `label`), else its config key. */
export function agentDisplayName(name: string): string {
  const label = loadAgents()[name]?.label;
  return typeof label === "string" && label.trim() ? label.trim() : name;
}

// One failed run, in plain words. The reason is the machine half the PWA branches on;
// the message is what a person reads, never raw CLI output.
export function verifyFailureFrom(
  name: string,
  input: { busy?: boolean; timedOut?: boolean; launchFailed?: boolean; failure?: AgentFailure | null }
): { reason: AgentVerifyReason; message: string } {
  const who = agentDisplayName(name);
  if (input.busy)
    return { reason: "busy", message: "Cairn is finishing something else first — trying again in a moment." };
  if (input.launchFailed) return { reason: "not_installed", message: `${who} isn't set up on this server yet.` };
  if (input.timedOut) return { reason: "timeout", message: `${who} took too long to answer. Try again in a moment.` };
  switch (input.failure?.state) {
    case "auth_required":
      return { reason: "not_signed_in", message: `${who} isn't signed in yet.` };
    case "quota_exhausted":
      return { reason: "failed", message: `${who} says your plan's limit is reached for now.` };
    case "rate_limited":
      return { reason: "failed", message: `${who} is busy right now. Try again in a minute.` };
    case "payment_required":
      return { reason: "failed", message: `${who} needs an active plan on that account.` };
    case "disk_full":
    case "out_of_memory":
      return { reason: input.failure.state, message: resourceFailureHeadline(input.failure.state, who) || "" };
    default:
      return {
        reason: "failed",
        message: `${who} didn't answer the way Cairn expected. Try again, or use a different one.`,
      };
  }
}

/**
 * Prove ONE agent answers: a tiny prompt through the real spawn path (`runAgent` — the
 * same tool policy, profile resolution and process-wide spawn cap every op uses), for
 * that agent only, with no fallback rotation. A host with no free spawn slot answers
 * `reason:"busy"`, which is congestion and never a verdict on the agent.
 *
 * Success drops the cached login verdict (and any availability hold) so the agent reads
 * as usable on the very next GET, and switches it back on if it had been switched off —
 * connecting a provider IS asking to use it.
 */
export async function verifyAgent(name: string, opts: { timeoutMs?: number } = {}): Promise<AgentVerifyResult> {
  const result = await verifyAgentOnce(name, opts);
  // One line per hello so a hosted log shows why a connect stalled (reason class only —
  // never the CLI's words or the prompt).
  if (result.ok) log.info("[welcome] hello answered", { agent: name, ms: result.ms });
  else log.warn("[welcome] hello failed", { agent: name, reason: result.reason });
  return result;
}

async function verifyAgentOnce(name: string, opts: { timeoutMs?: number }): Promise<AgentVerifyResult> {
  const def = loadAgents()[name];
  if (!def) return { ok: false, agent: name, reason: "failed", message: "Cairn doesn't know that provider." };
  if (!commandPresent(def.command)) {
    return { ok: false, agent: name, ...verifyFailureFrom(name, { launchFailed: true }) };
  }
  const started = Date.now();
  try {
    const result = await runAgent(name, VERIFY_PROMPT, {
      timeoutMs: opts.timeoutMs ?? AGENT_VERIFY_TIMEOUT_MS,
      priority: "interactive",
      profile: executionProfileForOp("agent_hello"),
    });
    if (result.parsed && typeof result.parsed === "object" && (result.parsed as any).ok === true) {
      const ms = Date.now() - started;
      try {
        invalidateAgentConfigured(name);
        // It answered: that is the strongest sign-in evidence there is, whatever the
        // login probe can or cannot read.
        recordAgentAnswered(name);
      } catch (err) {
        log.debug("[verify] could not refresh the agent's cached state", { error: err });
      }
      try {
        const s = getSettings();
        if (s.disabled_agents.includes(name))
          setSettings({ disabled_agents: s.disabled_agents.filter((n) => n !== name) });
      } catch (err) {
        log.warn("[verify] could not switch the connected agent on", { error: err });
      }
      return { ok: true, agent: name, ms };
    }
    return {
      ok: false,
      agent: name,
      ...(await signedOutOrAsIs(
        name,
        verifyFailureFrom(name, { failure: classifyAgentFailure(name, result, new Date()) })
      )),
    };
  } catch (error: any) {
    if (isAgentBusyError(error)) return { ok: false, agent: name, ...verifyFailureFrom(name, { busy: true }) };
    const message = String(error?.message ?? "");
    if (/timed out/i.test(message)) return { ok: false, agent: name, ...verifyFailureFrom(name, { timedOut: true }) };
    if (/failed to launch/i.test(message))
      return { ok: false, agent: name, ...verifyFailureFrom(name, { launchFailed: true }) };
    const failure = classifyAgentFailure(name, { code: null, raw: "", stderr: message }, new Date());
    return { ok: false, agent: name, ...(await signedOutOrAsIs(name, verifyFailureFrom(name, { failure }))) };
  }
}

/**
 * True when the agent's own login probe, asked again NOW, says it is signed out. A
 * failed run whose words were not recognisable (a CLI wording Cairn has not seen, an
 * error envelope too long to trust) is otherwise just "didn't answer" — the probe is
 * what tells a person to sign in rather than to try the same thing again.
 */
export async function provedSignedOut(name: string): Promise<boolean> {
  try {
    return (await reprobeAgentConfigured(name)) === false;
  } catch {
    return false;
  }
}

async function signedOutOrAsIs(
  name: string,
  failure: { reason: AgentVerifyReason; message: string }
): Promise<{ reason: AgentVerifyReason; message: string }> {
  if (failure.reason !== "failed") return failure;
  return (await provedSignedOut(name))
    ? verifyFailureFrom(name, { failure: { state: "auth_required" } as AgentFailure })
    : failure;
}

// ---------- the welcome: the coach's first conversation ----------

// In the order they happen: the reply and the starting fuel both come from the first
// agent pass, so they land (and show) before the slow part, the week.
export const WELCOME_PHASES = {
  understand: "reading what you said",
  fuel: "setting your starting fuel",
  week: "building your first week",
} as const;

/**
 * The welcome job's progress meta (job.meta, persisted on every phase): the step, and what
 * has already landed — the coach's reply from `fuel` on, the starting fuel from `week` on —
 * so the Meet stage paints each piece the moment it exists and a reload or a second device
 * re-attaching shows it too. `detail` is the week composer's own phase words. Small by
 * construction (the reply is capped at 700 characters). Client: ClientWelcomePhaseMeta.
 */
export interface WelcomePhaseMeta {
  step: "understand" | "fuel" | "week";
  frac: { done: number; total: number };
  reply?: string;
  fuel?: { target_kcal: number | null; protein_g: number | null } | null;
  fuel_state?: "set" | "existing" | "none";
  detail?: string;
  /**
   * The first week's days as the composer writes them (welcomeWeekPreview): a PREVIEW
   * the Meet stage and Today's "coming together" card paint row by row. The applied
   * week is the final result's `week`. At most WELCOME_PREVIEW_MAX_DAYS rows.
   */
  days_so_far?: WelcomeWeekDay[];
}

/** The most rows a phase meta's `days_so_far` carries (a week, with room to spare). */
export const WELCOME_PREVIEW_MAX_DAYS = 7;

// The calm floor for the coach's first words when the agent's own sentence is missing or
// breaks the reading grammar. Rotated like every other deterministic sentence; each one
// says only what is true whatever landed (the week and food lines are the reveal's job).
export const WELCOME_REPLY_FALLBACKS: readonly string[] = [
  "Thanks — that's a good picture to start from. I'm putting a first week and a starting food target in place, and we'll shape both as you go.",
  "Got it. I'll start you with a first week and a starting point for food, and adjust from what you actually do.",
  "That's plenty to start with. A first week and a food starting point are going in now, and everything stays easy to change.",
];

export interface WelcomeWeekDay {
  /** 0 = Sunday; null when no lifting weekdays were stated (the plan's ring order only). */
  dow: number | null;
  day_number: number;
  name: string;
}

export type WelcomeWeekState = "applied" | "announced" | "draft" | "existing" | "queued" | "failed" | "none";

export type WelcomeResult =
  | {
      ok: true;
      reply: string;
      week: WelcomeWeekDay[] | null;
      week_state: WelcomeWeekState;
      /** Set only while a busy host deferred the week to its own durable compose job. */
      week_job_id?: number | null;
      fuel: { target_kcal: number | null; protein_g: number | null } | null;
      fuel_state: "set" | "existing" | "none";
      applied: OnboardApplied;
      agent: string;
      tried: { agent: string; error: string }[];
      agent_status: string;
    }
  | {
      ok: false;
      error: string;
      agent: null;
      tried: { agent: string; error: string }[];
      /** The provider is signed out: the welcome offers its sign-in again. */
      reason?: "not_signed_in";
      signin_agent?: string;
      agent_busy?: true;
      agent_status: string;
    };

function trainingWeekExists(): boolean {
  try {
    return (getPlan() as any[]).some((day) => Array.isArray(day?.items) && day.items.length > 0);
  } catch {
    return false;
  }
}

/**
 * The week the reveal shows: each lifting day's NAME, on the weekday it lands when the
 * person named their lifting weekdays (the stated strength_schedule — the same map the
 * week strip uses), else in plan order with no weekday. Never an invented Mon=Day 1.
 */
export function welcomeWeekFrom(days: any[] | null | undefined): WelcomeWeekDay[] | null {
  const lifting = (Array.isArray(days) ? days : [])
    .filter((d) => Number.isFinite(Number(d?.day_number)) && Array.isArray(d?.items) && d.items.length > 0)
    .filter((d) => d.items.some((it: any) => String(it?.kind ?? "strength") !== "cardio"))
    .map((d) => ({
      day_number: Number(d.day_number),
      name: String(d.name || d.focus || `Day ${Number(d.day_number)}`)
        .trim()
        .slice(0, 60),
      names: d.items
        .filter((it: any) => String(it?.kind ?? "strength") !== "cardio")
        .map((it: any) => String(it?.exercise ?? "")),
    }))
    .sort((a, b) => a.day_number - b.day_number);
  if (!lifting.length) return null;
  let liftDows: number[] = [];
  try {
    liftDows = statedLiftDows();
  } catch {
    liftDows = [];
  }
  if (liftDows.length) {
    const map = weekdayPlanDayMap(lifting, liftDows);
    if (map.size) {
      return [...map.entries()]
        .sort((a, b) => ((a[0] + 6) % 7) - ((b[0] + 6) % 7))
        .map(([dow, day]) => ({ dow, day_number: day.day_number, name: day.name }));
    }
  }
  return lifting.map((d) => ({ dow: null, day_number: d.day_number, name: d.name }));
}

/**
 * The days that have arrived so far, in the reveal's shape. The weekday map fills a
 * short pool by repeating it (a 2-day pool over 4 named weekdays lifts both twice), and
 * that is right for a finished week but would show a day twice while the rest are still
 * being written — so each plan day keeps only its first weekday here.
 */
export function welcomeWeekPreview(days: any[] | null | undefined): WelcomeWeekDay[] {
  const seen = new Set<number>();
  const out: WelcomeWeekDay[] = [];
  for (const day of welcomeWeekFrom(days) ?? []) {
    if (seen.has(day.day_number)) continue;
    seen.add(day.day_number);
    out.push(day);
    if (out.length >= WELCOME_PREVIEW_MAX_DAYS) break;
  }
  return out;
}

export function welcomeReplyFrom(parsed: any, date = localDateISO()): string {
  const raw = typeof parsed?.welcome_reply === "string" ? parsed.welcome_reply : "";
  const text = raw.replace(/\s+/g, " ").replace(/!/g, ".").trim().slice(0, 700);
  if (text.length >= 20 && violatesReadingGrammar(text) == null) return text;
  return pickDayVariant(WELCOME_REPLY_FALLBACKS, date, "welcome_reply");
}

function fuelStartFrom(
  parsed: any
): { target_kcal: number | null; protein_g: number | null; why: string | null } | null {
  const f = parsed?.fuel_start;
  if (!f || typeof f !== "object") return null;
  const num = (v: any, lo: number, hi: number): number | null => {
    const n = Number(v);
    return v != null && v !== "" && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
  };
  const target_kcal = num(f.target_kcal, 1000, 6000);
  const protein_g = num(f.protein_g, 40, 400);
  if (target_kcal == null && protein_g == null) return null;
  const why = typeof f.why === "string" && f.why.trim() ? f.why.trim().slice(0, 240) : null;
  return { target_kcal, protein_g, why };
}

/**
 * The starting fuel: an existing target is kept; with none, the first pass's suggestion
 * goes through setNutritionTarget (its floors clamp it). A target an earlier, interrupted
 * welcome already set from this same first conversation still reads as `set` — it is the
 * welcome's own, not one the person had before.
 */
function welcomeFuel(parsed: any): {
  fuel: { target_kcal: number | null; protein_g: number | null } | null;
  fuel_state: "set" | "existing" | "none";
} {
  try {
    const existing: any = getLatestNutritionTarget();
    if (existing) {
      return {
        fuel: { target_kcal: existing.target_kcal ?? null, protein_g: existing.protein_g ?? null },
        fuel_state: existing.source === "onboard" ? "set" : "existing",
      };
    }
    const start = fuelStartFrom(parsed);
    if (!start) return { fuel: null, fuel_state: "none" };
    const saved: any = setNutritionTarget({
      target_kcal: start.target_kcal,
      protein_g: start.protein_g,
      source: "onboard",
      note: start.why ?? "A starting point from your first conversation with the coach.",
    });
    if (saved)
      return {
        fuel: { target_kcal: saved.target_kcal ?? null, protein_g: saved.protein_g ?? null },
        fuel_state: "set",
      };
  } catch (err) {
    log.warn("[welcome] the starting fuel target could not be set", { error: err });
  }
  return { fuel: null, fuel_state: "none" };
}

/**
 * The exchange lands in Ask history and the install is marked onboarded + welcomed. A
 * retry after an interruption re-sends the same words: the exchange is written once.
 */
function recordWelcomeExchange(raw: string, reply: string, chosen: string): void {
  try {
    const already = (listChatMessages(20) as any[]).some(
      (m) => m?.role === "user" && m?.meta?.kind === "welcome" && String(m?.content ?? "") === raw
    );
    if (!already) {
      addChatMessage("user", raw, null, { kind: "welcome" });
      addChatMessage("assistant", reply, chosen, { kind: "welcome" });
    }
  } catch (err) {
    log.warn("[welcome] could not save the first exchange to chat history", { error: err });
  }
  try {
    setSettings({ onboarded: true, coach_welcomed: true });
  } catch (err) {
    log.warn("[welcome] could not mark the welcome done", { error: err });
  }
}

function plainNoAgentError(
  tried: { agent: string; error: string; availability?: { state?: string } }[],
  signedOut: string | null = null
): string {
  const first = tried[0];
  if (!first) return "Your coach isn't connected yet.";
  const who = agentDisplayName(signedOut ?? first.agent);
  // The server ran out of disk or memory: that, with what to do, is the whole story.
  const resource = tried.find(
    (t) => t.availability?.state === "disk_full" || t.availability?.state === "out_of_memory"
  );
  const resourceLine = resource
    ? resourceFailureHeadline(
        resource.availability?.state as "disk_full" | "out_of_memory",
        agentDisplayName(resource.agent)
      )
    : null;
  if (resourceLine) return resourceLine;
  if (signedOut || first.availability?.state === "auth_required")
    return `${who} isn't signed in. Sign in again, then say hello.`;
  if (/timed out/i.test(first.error)) return `${who} took too long to answer. Try again in a moment.`;
  return `${who} didn't answer just now. Try again in a moment.`;
}

// The first tried agent that is signed out: its own words said so, or (when they were
// not recognisable) its login probe, asked again now, does.
async function signedOutAgent(tried: { agent: string; availability?: { state?: string } }[]): Promise<string | null> {
  for (const entry of tried) {
    if (!entry?.agent) continue;
    if (entry.availability?.state === "auth_required") return entry.agent;
    if (await provedSignedOut(entry.agent)) return entry.agent;
  }
  return null;
}

/**
 * The coach's first conversation. Steps, each best-effort after the first, in the order a
 * person can use them (each one's result rides the job's phase meta the moment it lands):
 *   a. understand — one agent pass over the person's words (the onboarding extraction,
 *      extended with the coach's reply, a starting fuel suggestion, the goal and any
 *      named lifting weekdays), applied through the onboarding writers;
 *   b. fuel — with no nutrition target yet, the suggestion through setNutritionTarget
 *      (its floors clamp it); it needs nothing but step a, so it never waits on the week;
 *   c. the exchange lands in Ask history and the install is marked onboarded + welcomed;
 *   d. week — with no plan yet, the blank-slate composer, routed as the person's own
 *      request so it lands today with one-tap Undo rather than next Monday. The slow
 *      part, last: the person may leave to look around while it composes, and the job
 *      (server-side) lands the week on Today/Train all the same.
 * Only step a can fail the op: no agent answered ⇒ {ok:false, error, tried} and nothing
 * is marked done, so the person can simply try again.
 */
export async function welcomeCoach(
  agent: string | undefined,
  text: string,
  hooks?: OpHooks,
  // A restart cut this welcome short during its week (src/agentJobs.ts boot recovery):
  // steps a–c already landed, so only the week runs, from the job's last phase meta.
  opts: { resume?: Partial<WelcomePhaseMeta> | null } = {}
): Promise<WelcomeResult> {
  const raw = String(text ?? "")
    .trim()
    .slice(0, 4000);
  const today = localDateISO();
  if (raw && opts.resume) return resumeWelcomeWeek(agent, raw, opts.resume, today, hooks);
  if (!raw) {
    return {
      ok: false,
      error: "Tell me a little about what you're training for first.",
      agent: null,
      tried: [],
      agent_status: "ok",
    };
  }
  hooks?.onPhase?.(WELCOME_PHASES.understand, {
    step: "understand",
    frac: { done: 0, total: 3 },
  } satisfies WelcomePhaseMeta);

  let run: Awaited<ReturnType<typeof runChosen>>;
  try {
    run = await runChosen(agent, buildOnboardPrompt(raw, { welcome: true }), {
      op: "onboard",
      timeoutMs: interactiveTimeoutForOp("onboard"),
      signal: hooks?.signal,
      schema: ONBOARD_SCHEMA,
      priority: "interactive",
      acceptParsed: (p: any) => !!p && typeof p === "object" && !Array.isArray(p),
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    const tried = error instanceof AgentFallbackError ? (error.tried as any[]) : failure.tried;
    const signedOut = failure.agent_busy ? null : await signedOutAgent(tried);
    return {
      ok: false,
      error: plainNoAgentError(tried, signedOut),
      agent: null,
      tried: failure.tried,
      ...(signedOut ? { reason: "not_signed_in" as const, signin_agent: signedOut } : {}),
      ...(failure.agent_busy ? { agent_busy: true as const } : {}),
      agent_status: agentStatusFor({ ok: false, agent: null, tried: failure.tried }),
    };
  }
  const chosen = run.agent;
  const parsed: any = run.result.parsed;

  const applied = emptyOnboardApplied();
  applyOnboardBase(raw, applied);
  applyOnboardParsed(parsed, applied);
  const reply = welcomeReplyFrom(parsed, today);
  // The reply is the person's first answer: it rides the next phase so it shows the
  // moment it exists (and survives a reload), long before the week is composed.
  hooks?.onPhase?.(WELCOME_PHASES.fuel, {
    step: "fuel",
    frac: { done: 1, total: 3 },
    reply,
  } satisfies WelcomePhaseMeta);

  // b. starting fuel — depends only on step a, so it lands before the (slow) week.
  const { fuel, fuel_state } = welcomeFuel(parsed);

  // c. the exchange joins Ask history and the install is past its first run. The
  // conversation has happened; the week is its follow-on, so a person who leaves to look
  // around while it composes is not greeted by "say hello" again.
  recordWelcomeExchange(raw, reply, chosen);

  // d. the first week
  const weekMeta: WelcomePhaseMeta = { step: "week", frac: { done: 2, total: 3 }, reply, fuel, fuel_state };
  const { week, week_state } = await welcomeWeek(chosen, raw, weekMeta, today, hooks);

  return {
    ok: true,
    reply,
    week,
    week_state,
    fuel,
    fuel_state,
    applied,
    agent: chosen,
    tried: run.tried,
    agent_status: agentStatusFor({ ok: true, agent: chosen, tried: run.tried }),
  };
}

/**
 * Step d on its own: the first week, composed as the welcome's own op (the thinner
 * `welcome_week` profile) and streamed where the agent can, each day riding the phase
 * meta as `days_so_far` the moment it is written. `resumed`: a restart interrupted this
 * week, so a week already on the plan is the welcome's own, landed before the restart.
 */
async function welcomeWeek(
  chosen: string | undefined,
  raw: string,
  weekMeta: WelcomePhaseMeta,
  today: string,
  hooks?: OpHooks,
  resumed = false
): Promise<{ week: WelcomeWeekDay[] | null; week_state: WelcomeWeekState; agent: string | null }> {
  hooks?.onPhase?.(WELCOME_PHASES.week, weekMeta);
  if (trainingWeekExists()) {
    return { week: welcomeWeekFrom(getPlan() as any[]), week_state: resumed ? "applied" : "existing", agent: null };
  }
  // The composer's own phase words ride as `detail` (a small second line under the
  // welcome's step); the arriving days ride beside them. Each phase carries both, so
  // whichever lands last never drops the other.
  let detail: string | undefined;
  let days: WelcomeWeekDay[] | undefined;
  const publish = () =>
    hooks?.onPhase?.(WELCOME_PHASES.week, {
      ...weekMeta,
      ...(detail ? { detail } : {}),
      ...(days?.length ? { days_so_far: days } : {}),
    });
  try {
    const composed: any = await composeWeek(
      chosen,
      raw,
      {
        signal: hooks?.signal,
        onPhase: (words: string) => {
          detail = words;
          publish();
        },
      },
      {
        explicitRequest: true,
        priority: "interactive",
        welcome: true,
        onDays: (arrived) => {
          const next = welcomeWeekPreview(arrived);
          if (next.length === (days?.length ?? 0)) return;
          days = next;
          publish();
        },
      }
    );
    const agent = typeof composed?.agent === "string" ? composed.agent : null;
    // the job runner hands a busy host's week to its own durable compose job
    if (composed?.agent_busy) return { week: null, week_state: "queued", agent };
    if (!composed?.ok || !(Number(composed?.days) > 0)) return { week: null, week_state: "failed", agent };
    if (composed?.autonomy?.announced && composed?.autonomy?.effective_date === today) {
      try {
        applyDueAnnouncedDecisions(today);
      } catch (err) {
        log.warn("[welcome] the first week could not land today", { error: err });
      }
    }
    if (trainingWeekExists()) return { week: welcomeWeekFrom(getPlan() as any[]), week_state: "applied", agent };
    return {
      week: welcomeWeekFrom(composed?.proposal?.parsed?.days),
      week_state: composed?.autonomy?.announced ? "announced" : "draft",
      agent,
    };
  } catch (error) {
    if (hooks?.signal?.aborted) throw error;
    log.warn("[welcome] composing the first week failed", { error });
    return { week: null, week_state: "failed", agent: null };
  }
}

/**
 * Finish a welcome a restart interrupted during its week. The reply, the fuel and the
 * exchange already landed (and the install is marked welcomed), so only the week runs;
 * the reveal reports what the job's last phase meta carried.
 */
async function resumeWelcomeWeek(
  agent: string | undefined,
  raw: string,
  resume: Partial<WelcomePhaseMeta>,
  today: string,
  hooks?: OpHooks
): Promise<WelcomeResult> {
  const reply = typeof resume.reply === "string" && resume.reply.trim() ? resume.reply : welcomeReplyFrom(null, today);
  const { fuel, fuel_state } = welcomeFuel(null);
  const weekMeta: WelcomePhaseMeta = { step: "week", frac: { done: 2, total: 3 }, reply, fuel, fuel_state };
  log.info("[welcome] resuming the first week after a restart");
  const { week, week_state, agent: ran } = await welcomeWeek(agent, raw, weekMeta, today, hooks, true);
  const chosen = ran ?? agent ?? "";
  return {
    ok: true,
    reply,
    week,
    week_state,
    fuel,
    fuel_state,
    applied: emptyOnboardApplied(),
    agent: chosen,
    tried: [],
    agent_status: agentStatusFor({ ok: true, agent: chosen, tried: [] }),
  };
}
