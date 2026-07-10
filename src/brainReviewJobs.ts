import { enqueueAgentJob } from "./agentJobs.js";
import { onBrainEvent, type RoutedBrainEvent } from "./brainEvents.js";
import { createBrainReviewAgentJob } from "./repo/chat.js";
import { diagnosticErrorName, recordAsyncFailure } from "./diagnostics.js";

const DEFAULT_COOLDOWN_MS = 10 * 60_000;
let unsubscribe: (() => void) | null = null;

export interface BrainReviewSubscriberDeps {
  enqueue?: (id: number) => void;
  cooldownMs?: number;
}

/** Persist one review-worthy event, then hand only newly-created jobs to the worker. */
export function persistBrainReviewEvent(
  event: RoutedBrainEvent,
  deps: BrainReviewSubscriberDeps = {}
): { job: any; created: boolean } | null {
  if (event.review !== true) return null;
  // A session finished, reopened for a correction, and finished again must not
  // compound into a second progression review. Its fingerprint already carries
  // the date, so a day-long cooldown means one review per session per day.
  const cooldownMs =
    deps.cooldownMs ?? (event.kind === "session_finished" ? 24 * 60 * 60_000 : DEFAULT_COOLDOWN_MS);
  const stored = createBrainReviewAgentJob(
    {
      fingerprint: event.fingerprint,
      event: {
        kind: event.kind,
        domain: event.domain,
        date: event.date,
        entity_id: event.entity_id,
        subject_key: event.subject_key,
        reason: event.reason,
        material: event.material,
        clinical: event.clinical,
        emitted_at: event.emitted_at,
      },
    },
    cooldownMs
  );
  if (stored.created) {
    // Persistence is synchronous and tiny; the potentially long coach run is
    // handed off after this event-listener stack unwinds.
    const enqueue = deps.enqueue ?? enqueueAgentJob;
    queueMicrotask(() => {
      try {
        enqueue(Number(stored.job.id));
      } catch (error: any) {
        recordAsyncFailure("brain_review", "enqueue", error);
        console.error(`[brain] could not enqueue review job#${stored.job.id} (${diagnosticErrorName(error)})`);
      }
    });
  }
  return stored;
}

/** Idempotent process-start subscriber. Returns a stop function for tests/shutdown. */
export function startBrainReviewJobSubscriber(deps: BrainReviewSubscriberDeps = {}): () => void {
  if (unsubscribe) return unsubscribe;
  const off = onBrainEvent((event) => {
    try {
      persistBrainReviewEvent(event, deps);
    } catch (error: any) {
      // Signal review is additive. A persistence failure must never block the
      // originating workout, food log, sync, or health write.
      recordAsyncFailure("brain_review", "persist", error);
      console.error(`[brain] signal review skipped safely (${diagnosticErrorName(error)})`);
    }
  });
  unsubscribe = () => {
    off();
    unsubscribe = null;
  };
  return unsubscribe;
}

export function stopBrainReviewJobSubscriber(): void {
  unsubscribe?.();
}
