// Pins an account refused: which model alias / effort level a provider's CLI said this
// account cannot use, remembered for a while so later spawns skip that pin up front.
//
// A model is pinned only when the person chose one (Settings -> Agents, the class
// bindings in settings.model_class_bindings, or an advanced per-lane/per-task override),
// and an effort level per execution class always. A lower plan tier may not be allowed
// the chosen alias, and the CLI then exits within a second with "There's an issue with
// the selected model". The spawn retries once on the CLI's own default
// (runWithModelAccessFallback in src/agents.ts) and records the refusal here, so the
// next run does not pay the failed first spawn again.
//
// In-memory with a TTL, like the process-local breaker — not a provider hold: the
// provider itself is healthy, only one pin is refused, and a plan upgrade (or a new CLI
// that knows the alias) should be picked up within hours without anyone clearing
// anything. A restart forgets, at the cost of one failed spawn to relearn.
//
// Dependency-free: agents.ts imports it.

export type PinField = "model" | "reasoning";

/** How long a refused pin is skipped before it is tried again. */
export const REFUSED_PIN_TTL_MS = 6 * 3_600_000;

interface Refusal {
  value: string;
  until: number;
}

const refused = new Map<string, Partial<Record<PinField, Refusal>>>();

/** Remember that `agent` refused `value` for `field` (model alias or effort level). */
export function noteRefusedPin(agent: string, field: PinField, value: string, now = Date.now()): void {
  const v = String(value ?? "").trim();
  if (!agent || !v) return;
  const entry = refused.get(agent) ?? {};
  entry[field] = { value: v, until: now + REFUSED_PIN_TTL_MS };
  refused.set(agent, entry);
}

/** True while `agent` is remembered as refusing exactly this `value` for `field`. */
export function isRefusedPin(agent: string, field: PinField, value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const hit = refused.get(agent)?.[field];
  if (!hit) return false;
  if (hit.until <= now) {
    const entry = refused.get(agent);
    if (entry) {
      delete entry[field];
      if (!entry.model && !entry.reasoning) refused.delete(agent);
    }
    return false;
  }
  return hit.value === value;
}

/**
 * The pin a spawn should actually use: each field the agent is remembered as refusing
 * is dropped (the CLI then runs on its own default for it). `dropped` names the fields
 * removed, for the caller's log line.
 */
export function pinsAfterRefusals<R extends string>(
  agent: string,
  pin: { model?: string; reasoning?: R },
  now = Date.now()
): { model?: string; reasoning?: R; dropped: PinField[] } {
  const dropped: PinField[] = [];
  const out: { model?: string; reasoning?: R; dropped: PinField[] } = { dropped };
  if (pin.model) {
    if (isRefusedPin(agent, "model", pin.model, now)) dropped.push("model");
    else out.model = pin.model;
  }
  if (pin.reasoning) {
    if (isRefusedPin(agent, "reasoning", pin.reasoning, now)) dropped.push("reasoning");
    else out.reasoning = pin.reasoning;
  }
  return out;
}

/** Live refusals, for diagnostics and tests. */
export function refusedPinSnapshot(
  now = Date.now()
): Array<{ agent: string; field: PinField; value: string; until: string }> {
  const out: Array<{ agent: string; field: PinField; value: string; until: string }> = [];
  for (const [agent, entry] of refused) {
    for (const field of ["model", "reasoning"] as const) {
      const hit = entry[field];
      if (hit && hit.until > now)
        out.push({ agent, field, value: hit.value, until: new Date(hit.until).toISOString() });
    }
  }
  return out;
}

/** Forget refusals (one agent, or all). A test seam, and the hook a re-login can use. */
export function clearRefusedPins(agent?: string): void {
  if (agent) refused.delete(agent);
  else refused.clear();
}
