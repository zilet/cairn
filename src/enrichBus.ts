import { createProgressBus } from "./jobRunner.js";

// Live progress bus for background enrichment status transitions — the SSE
// counterpart to the polling the PWA used to do against GET /api/{activities,
// food-notes,health-docs}/:id. Modelled on the agent-jobs bus (src/agentJobs.ts):
// one EventEmitter per (kind, id), a subscriber gets every transition until the
// row reaches a terminal status, then the SSE handler closes.
//
// This lives in its OWN leaf module (not in enrich.ts) on purpose: the emit is
// wired into the repo status SETTERS (setActivityEnrichStatus / setFoodNoteEnrich
// Status / setHealthDocEnrichStatus / setExerciseEnrichStatus) + updateFoodNote,
// which are the single choke point through which EVERY status write flows — the
// enrich.ts queue, the food_photo/exercise jobs, health-doc create/reanalyze, and
// the manual food correction all route through them. Putting the bus here keeps
// those repo modules free of a static import from the heavy enrich.ts (which would
// re-introduce the repo↔enrich module-eval cycle the codebase already avoids with
// a lazy import). enrich.ts re-exports onEnrichEvent so callers can treat it as the
// engine's public surface.

export type EnrichResourceKind = "activity" | "food" | "health" | "exercise";

export interface EnrichEvent {
  kind: EnrichResourceKind;
  id: number;
  status: string | null;
  // The row's FRESH public shape (the same object the GET /:id route returns —
  // health docs are the public getHealthDocument, never the raw file_path).
  row: unknown;
}

const buses = {
  activity: createProgressBus<EnrichEvent>("enrich:activity"),
  food: createProgressBus<EnrichEvent>("enrich:food"),
  health: createProgressBus<EnrichEvent>("enrich:health"),
  exercise: createProgressBus<EnrichEvent>("enrich:exercise"),
} satisfies Record<EnrichResourceKind, unknown>;

// pending / in_progress → the row is still being enriched (a subscriber keeps
// listening). Everything else (done/failed/skipped/pending_confirm/null) is
// terminal for streaming purposes: nothing on the queue will move it, so the SSE
// handler ends after delivering it. Pure so the SSE decision is unit-testable.
export function isEnrichActive(status: string | null | undefined): boolean {
  return status === "pending" || status === "in_progress";
}

export function isEnrichTerminal(status: string | null | undefined): boolean {
  return !isEnrichActive(status);
}

// Emit a status transition for a row. `row` is the fresh PUBLIC shape (the caller
// re-reads it after the write); status is read off it so a null/deleted row emits a
// terminal event and never strands a subscriber. A no-op when nobody is listening.
export function emitEnrichTransition(kind: EnrichResourceKind, id: number, row: unknown): void {
  const status =
    row && typeof row === "object" ? ((row as { enrichment_status?: string | null }).enrichment_status ?? null) : null;
  buses[kind].emit(id, { kind, id, status, row });
}

// Subscribe to one row's transitions; returns an unsubscribe. Mirrors
// agentJobs.onJobEvent.
export function onEnrichEvent(kind: EnrichResourceKind, id: number, listener: (e: EnrichEvent) => void): () => void {
  return buses[kind].on(id, listener);
}
