import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export const BRAIN_EVENT_KINDS = [
  "set_logged",
  "session_finished",
  "session_feedback",
  "fueling_feedback",
  "exercise_skipped",
  "exercise_swapped",
  "food_logged",
  "food_corrected",
  "weight_logged",
  "nutrition_target_changed",
  "recovery_metrics_changed",
  "activity_synced",
  "health_marker_changed",
  "health_directive_changed",
  "medication_changed",
  "supplement_changed",
  "body_measurement_changed",
  "context_changed",
  "profile_changed",
  "goal_changed",
  "plan_changed",
  "meal_plan_changed",
] as const;

export type BrainEventKind = (typeof BRAIN_EVENT_KINDS)[number];
export type BrainEventDomain = "training" | "nutrition" | "health" | "recovery" | "body" | "lifestyle" | "person";

export interface BrainEvent {
  kind: BrainEventKind;
  domain: BrainEventDomain;
  date: string;
  entity_id?: string | number | null;
  subject_key?: string | null;
  reason?: string | null;
  material?: boolean;
  clinical?: boolean;
}

export interface RoutedBrainEvent extends BrainEvent {
  fingerprint: string;
  review: boolean;
  emitted_at: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(30);
const pending = new Map<string, BrainEvent>();
const cooldowns = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

const DEFAULT_DEBOUNCE_MS = 350;
const DEFAULT_COOLDOWN_MS = 10 * 60_000;

function clean(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).trim().replace(/\s+/g, " ").slice(0, max);
  return text || null;
}

function validDate(value: unknown): string | null {
  const text = clean(value, 10);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function normalizeBrainEvent(value: unknown): BrainEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const kind = BRAIN_EVENT_KINDS.includes(input.kind as BrainEventKind) ? (input.kind as BrainEventKind) : null;
  const domains: BrainEventDomain[] = ["training", "nutrition", "health", "recovery", "body", "lifestyle", "person"];
  const domain = domains.includes(input.domain as BrainEventDomain) ? (input.domain as BrainEventDomain) : null;
  const date = validDate(input.date);
  if (!kind || !domain || !date) return null;
  const rawId = input.entity_id;
  const entityId = typeof rawId === "number" && Number.isFinite(rawId) ? Math.trunc(rawId) : clean(rawId, 120);
  return {
    kind,
    domain,
    date,
    entity_id: entityId,
    subject_key: clean(input.subject_key, 160),
    reason: clean(input.reason, 300),
    material: input.material === true,
    clinical: input.clinical === true,
  };
}

function coalescingKind(kind: BrainEventKind): BrainEventKind {
  // Twenty set writes should become one session-activity signal; the explicit
  // session_finished event remains the material review boundary.
  return kind === "set_logged" ? "set_logged" : kind;
}

export function brainEventFingerprint(event: BrainEvent): string {
  const subjectIdentity = event.kind === "set_logged" ? "" : clean(event.subject_key, 160) || "";
  const identity = [
    coalescingKind(event.kind),
    event.domain,
    event.date,
    subjectIdentity,
    event.entity_id == null ? "" : String(event.entity_id),
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

export function brainEventNeedsReview(event: BrainEvent): boolean {
  if (event.clinical || event.material) return true;
  return [
    "session_finished",
    "session_feedback",
    "fueling_feedback",
    "exercise_swapped",
    "nutrition_target_changed",
    "health_marker_changed",
    "health_directive_changed",
    "medication_changed",
    "supplement_changed",
    "body_measurement_changed",
    "context_changed",
    "goal_changed",
    "plan_changed",
    "meal_plan_changed",
  ].includes(event.kind);
}

function mergeEvent(previous: BrainEvent | undefined, next: BrainEvent): BrainEvent {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    material: !!(previous.material || next.material),
    clinical: !!(previous.clinical || next.clinical),
    reason: next.reason || previous.reason || null,
  };
}

function routePending(now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS): RoutedBrainEvent[] {
  const routed: RoutedBrainEvent[] = [];
  for (const [fingerprint, event] of pending) {
    pending.delete(fingerprint);
    const last = cooldowns.get(fingerprint);
    if (last != null && now - last < cooldownMs) continue;
    cooldowns.set(fingerprint, now);
    const result: RoutedBrainEvent = {
      ...event,
      fingerprint,
      review: brainEventNeedsReview(event),
      emitted_at: new Date(now).toISOString(),
    };
    routed.push(result);
    bus.emit("event", result);
  }
  // Bound process memory during long uptimes.
  if (cooldowns.size > 2_000) {
    const cutoff = now - Math.max(cooldownMs, 24 * 60 * 60_000);
    for (const [key, at] of cooldowns) if (at < cutoff) cooldowns.delete(key);
  }
  return routed;
}

export function emitBrainEvent(value: unknown, opts: { debounceMs?: number } = {}): string | null {
  const event = normalizeBrainEvent(value);
  if (!event) return null;
  const fingerprint = brainEventFingerprint(event);
  pending.set(fingerprint, mergeEvent(pending.get(fingerprint), event));
  if (timer) clearTimeout(timer);
  timer = setTimeout(
    () => {
      timer = null;
      routePending();
    },
    Math.max(0, Math.min(5_000, Math.trunc(opts.debounceMs ?? DEFAULT_DEBOUNCE_MS)))
  );
  timer.unref?.();
  return fingerprint;
}

export function onBrainEvent(listener: (event: RoutedBrainEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

export function flushBrainEventsForTest(now = Date.now(), cooldownMs = 0): RoutedBrainEvent[] {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  return routePending(now, cooldownMs);
}

export function resetBrainEventsForTest(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending.clear();
  cooldowns.clear();
  bus.removeAllListeners("event");
}
