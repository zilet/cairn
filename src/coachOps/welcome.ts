// The first run, server half: proving a freshly connected agent answers (verifyAgent)
// and the coach's first conversation (welcomeCoach). The welcome is the ONE place a
// brand-new install goes from "nothing" to "a week and a starting food target in place",
// and it does that only through the existing writers — the onboarding extraction, the
// blank-slate week composer and its autonomy routing, the nutrition target's floors —
// never a scripted stand-in for an agent. No agent ⇒ the designed {ok:false} and nothing
// pretends to coach.

import { addChatMessage } from "../repo/chat.js";
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

export const WELCOME_PHASES = {
  understand: "reading what you said",
  week: "building your first week",
  fuel: "setting your starting fuel",
} as const;

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

function plainNoAgentError(
  tried: { agent: string; error: string; availability?: { state?: string } }[],
  signedOut: string | null = null
): string {
  const first = tried[0];
  if (!first) return "Your coach isn't connected yet.";
  const who = agentDisplayName(signedOut ?? first.agent);
  // The server ran out of disk or memory: that, with what to do, is the whole story.
  const resource = tried.find((t) => t.availability?.state === "disk_full" || t.availability?.state === "out_of_memory");
  const resourceLine = resource
    ? resourceFailureHeadline(resource.availability?.state as "disk_full" | "out_of_memory", agentDisplayName(resource.agent))
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
 * The coach's first conversation. Steps, each best-effort after the first:
 *   a. understand — one agent pass over the person's words (the onboarding extraction,
 *      extended with the coach's reply, a starting fuel suggestion, the goal and any
 *      named lifting weekdays), applied through the onboarding writers;
 *   b. week — with no plan yet, the blank-slate composer, routed as the person's own
 *      request so it lands today with one-tap Undo rather than next Monday;
 *   c. fuel — with no nutrition target yet, the suggestion through setNutritionTarget
 *      (its floors clamp it);
 *   d. the exchange lands in Ask history and the install is marked onboarded + welcomed.
 * Only step a can fail the op: no agent answered ⇒ {ok:false, error, tried} and nothing
 * is marked done, so the person can simply try again.
 */
export async function welcomeCoach(agent: string | undefined, text: string, hooks?: OpHooks): Promise<WelcomeResult> {
  const raw = String(text ?? "")
    .trim()
    .slice(0, 4000);
  const today = localDateISO();
  if (!raw) {
    return {
      ok: false,
      error: "Tell me a little about what you're training for first.",
      agent: null,
      tried: [],
      agent_status: "ok",
    };
  }
  hooks?.onPhase?.(WELCOME_PHASES.understand, { step: "understand", frac: { done: 0, total: 3 } });

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

  // b. the first week
  hooks?.onPhase?.(WELCOME_PHASES.week, { step: "week", frac: { done: 1, total: 3 } });
  let week: WelcomeWeekDay[] | null = null;
  let week_state: WelcomeWeekState = "none";
  if (trainingWeekExists()) {
    week_state = "existing";
    week = welcomeWeekFrom(getPlan() as any[]);
  } else {
    try {
      // The composer's own phase captions would replace ours mid-step; keep the
      // welcome's three steps the only thing the waiting card says.
      const composed: any = await composeWeek(
        chosen,
        raw,
        { signal: hooks?.signal },
        { explicitRequest: true, priority: "interactive" }
      );
      if (composed?.agent_busy) {
        week_state = "queued"; // the job runner hands it to its own durable compose job
      } else if (composed?.ok && Number(composed?.days) > 0) {
        if (composed?.autonomy?.announced && composed?.autonomy?.effective_date === today) {
          try {
            applyDueAnnouncedDecisions(today);
          } catch (err) {
            log.warn("[welcome] the first week could not land today", { error: err });
          }
        }
        if (trainingWeekExists()) {
          week_state = "applied";
          week = welcomeWeekFrom(getPlan() as any[]);
        } else {
          week_state = composed?.autonomy?.announced ? "announced" : "draft";
          week = welcomeWeekFrom(composed?.proposal?.parsed?.days);
        }
      } else {
        week_state = "failed";
      }
    } catch (error) {
      if (hooks?.signal?.aborted) throw error;
      log.warn("[welcome] composing the first week failed", { error });
      week_state = "failed";
    }
  }

  // c. starting fuel
  hooks?.onPhase?.(WELCOME_PHASES.fuel, { step: "fuel", frac: { done: 2, total: 3 } });
  let fuel: { target_kcal: number | null; protein_g: number | null } | null = null;
  let fuel_state: "set" | "existing" | "none" = "none";
  try {
    const existing = getLatestNutritionTarget();
    if (existing) {
      fuel_state = "existing";
      fuel = { target_kcal: (existing as any).target_kcal ?? null, protein_g: (existing as any).protein_g ?? null };
    } else {
      const start = fuelStartFrom(parsed);
      if (start) {
        const saved: any = setNutritionTarget({
          target_kcal: start.target_kcal,
          protein_g: start.protein_g,
          source: "onboard",
          note: start.why ?? "A starting point from your first conversation with the coach.",
        });
        if (saved) {
          fuel_state = "set";
          fuel = { target_kcal: saved.target_kcal ?? null, protein_g: saved.protein_g ?? null };
        }
      }
    }
  } catch (err) {
    log.warn("[welcome] the starting fuel target could not be set", { error: err });
  }

  // d. the exchange joins Ask history; the install is past its first run.
  try {
    addChatMessage("user", raw, null, { kind: "welcome" });
    addChatMessage("assistant", reply, chosen, { kind: "welcome" });
  } catch (err) {
    log.warn("[welcome] could not save the first exchange to chat history", { error: err });
  }
  try {
    setSettings({ onboarded: true, coach_welcomed: true });
  } catch (err) {
    log.warn("[welcome] could not mark the welcome done", { error: err });
  }

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
