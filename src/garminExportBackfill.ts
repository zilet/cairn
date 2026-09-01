// Cairn → Garmin strength write-back, for HISTORY.
//
// The ordinary write-back is incremental: `finishSession` exports the session just
// finished, and a Garmin *sync* only looks back 7 days — deliberately, so flipping
// the (default-on) toggle never dumps a month of old workouts into someone's Garmin
// calendar behind their back. That leaves no path at all for an athlete who WANTS
// their whole Cairn history on Garmin.
//
// This is that path, and it is user-triggered, batched and dry-run-first:
//
//   - DRY RUN (the default) touches no network and enqueues nothing. It reports, per
//     session, what the exporter WOULD do — including which lifts the FIT catalog
//     could not place, so the athlete sees the gaps before anything is sent.
//   - APPLY hands the sessions to the serial enrichment queue as ordinary
//     `garmin_export` jobs, OLDEST FIRST, so Garmin's history builds forward in time
//     and the queue paces the writes. The export itself stays the single authority:
//     nothing here calls exportSessionToGarmin inline, and nothing here skips a
//     safety rule the exporter owns.
//
// The `planned` field is a PREDICTION, not a promise. It CALLS the exporter's own
// target decision (`planGarminExportTarget`) over the same rows rather than restating
// it — a second copy of those rules is how a preview starts lying about retargets and
// orphaned shells — but the world can move between the preview and the job (a watch
// recording syncs, a set is edited), in which case the exporter's answer wins.
import { garminExportFingerprint, planGarminExportTarget, type GarminExportPayloadSet } from "./garminExport.js";
import * as repo from "./repo.js";
import { localDateISO } from "./repo/shared.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * `retarget` — the sets move onto the watch's own recording and the shells Cairn made
 * are withdrawn. `drop_surplus` — the sets are already where they belong; only a
 * surplus shell (a create whose answer was lost, a delete Garmin refused) is removed,
 * and nothing is rewritten.
 */
export type GarminBackfillPlan =
  | "unchanged"
  | "fill_or_replace"
  | "create"
  | "retarget"
  | "drop_surplus"
  | "skip_no_mapped_sets";

/**
 * Why a movement is worth an agentic pass. `unmapped` — the FIT catalog could not
 * place it, so it is silently missing from every export. `never_enriched` — it has
 * never been through enrichment at all, so its name was never canonicalized and its
 * group/equipment were never classified; an install that predates the background
 * cleanup carries a tail of these ("Seated leg press - machine"), and a tidier name
 * is often what makes the catalog able to place it on the next pass.
 */
export type GarminRefineReason = "unmapped" | "never_enriched";

export interface GarminRefineCandidate {
  exercise_id: number;
  exercise: string;
  reason: GarminRefineReason;
}

export interface GarminBackfillPreview {
  session_id: number;
  date: string;
  sets: number;
  mapped_sets: number;
  /** Lifts on this session the FIT catalog could not place — they are left out of the payload. */
  unmapped_exercises: string[];
  /** The watch's own strength recording for the day, when one is linked. */
  watch_activity_id: string | null;
  /** The activity the sets would land on — null only when one has to be created. */
  target_activity_id: string | null;
  /** Shells Cairn authored that the export would withdraw. Usually empty. */
  surplus_activity_ids: string[];
  prior_export: { activity_id: string; mode: string; exported_at: string } | null;
  /** What the exporter would hash for this session, predicted from today's rows. */
  predicted_fingerprint: string;
  planned: GarminBackfillPlan;
}

export interface GarminBackfillResult {
  ok: boolean;
  skipped?: string;
  dry_run?: boolean;
  total_eligible?: number;
  batch?: GarminBackfillPreview[];
  enqueued?: number;
  /** Distinct unplaceable lift names across the batch, in first-seen order. */
  unmapped_exercises?: string[];
  /** Movements a `refine_unmapped` pass would take, whether or not it took them. */
  refine_candidates?: GarminRefineCandidate[];
  refine_queued?: GarminRefineCandidate[];
  refine_skipped?: string;
  remaining?: number;
  error?: string;
}

export interface GarminBackfillOptions {
  since?: string;
  until?: string;
  limit?: number;
  apply?: boolean;
  refine_unmapped?: boolean;
}

function clampLimit(limit: unknown): number {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

/**
 * The payload-shaped sets for one session, exactly as the exporter builds them —
 * same mapping floor (ensureGarminMapping persists a deterministic hit or remembers
 * the miss), same order, same fields — so the fingerprint predicted here is the one
 * the export would compute. Memoized per exercise so a four-set accessory does not
 * re-score the catalog four times.
 */
function previewSets(
  rows: ReturnType<typeof repo.garminExportSetRows>,
  mappedByExercise: Map<number, { category: string | null; exercise: string | null; status: string }>,
  unmapped: Map<number, string>,
  seen: Map<number, string>
): GarminExportPayloadSet[] {
  const out: GarminExportPayloadSet[] = [];
  for (const row of rows) {
    if (!seen.has(row.exercise_id)) seen.set(row.exercise_id, row.exercise);
    let category = row.garmin_category;
    let exercise = row.garmin_exercise;
    if (!category) {
      let mapped = mappedByExercise.get(row.exercise_id);
      if (!mapped) {
        mapped = repo.ensureGarminMapping(row.exercise_id);
        mappedByExercise.set(row.exercise_id, mapped);
      }
      if (mapped.status !== "mapped" || !mapped.category) {
        if (!unmapped.has(row.exercise_id)) unmapped.set(row.exercise_id, row.exercise);
        continue;
      }
      category = mapped.category;
      exercise = mapped.exercise;
    }
    out.push({
      exercise: row.exercise,
      set_number: row.set_number,
      weight: row.weight,
      reps: row.reps,
      duration_sec: row.duration_sec,
      mode: row.mode,
      garmin_category: category,
      garmin_exercise: exercise,
    });
  }
  return out;
}

/**
 * Has this movement never been through the enrichment pass at all? A NULL (or empty)
 * `enrichment_status` is the marker of a row created before the background cleanup
 * was wired up — never canonicalized, never classified. Every other value ('done',
 * 'skipped', 'pending', 'in_progress') means the question has already been asked.
 */
function neverEnriched(exerciseId: number): boolean {
  const ex = repo.getExercise(exerciseId) as any;
  if (!ex) return false;
  return !String(ex.enrichment_status ?? "").trim();
}

function previewOne(
  sessionId: number,
  unmappedInBatch: Map<number, string>,
  seenInBatch: Map<number, string>
): GarminBackfillPreview | null {
  const session = repo.sessionGarminExportContext(sessionId);
  if (!session) return null;
  const rows = repo.garminExportSetRows(sessionId);
  const unmappedHere = new Map<number, string>();
  const sets = previewSets(rows, new Map(), unmappedHere, seenInBatch);
  for (const [id, name] of unmappedHere) if (!unmappedInBatch.has(id)) unmappedInBatch.set(id, name);

  const fingerprint = garminExportFingerprint(sets);
  const prior = repo.getSessionGarminExport(sessionId);
  const linked = repo.listSessionGarminStrengthActivities(sessionId).filter((row) => row.external_id);
  // The exporter's OWN target reasoning, called rather than restated: provenance by
  // ledger and marker, the pin, orphan adoption and the surplus-shell sweep all come
  // from one place, so a preview cannot quietly drift from what the job will do.
  const plan = planGarminExportTarget({ prior, linked, fingerprint });
  // Nothing to rewrite, but shells still to withdraw — the exporter's delete-only pass.
  const dropOnly = !!prior && prior.fingerprint === fingerprint && prior.activity_id === plan.target_id;

  let planned: GarminBackfillPlan;
  if (!sets.length) planned = "skip_no_mapped_sets";
  else if (plan.unchanged) planned = "unchanged";
  else if (dropOnly) planned = "drop_surplus";
  else if (plan.mode === "retarget") planned = "retarget";
  else if (plan.mode === "create" || !plan.target_id) planned = "create";
  else planned = "fill_or_replace";

  return {
    session_id: sessionId,
    date: session.date,
    sets: rows.length,
    mapped_sets: sets.length,
    unmapped_exercises: [...unmappedHere.values()],
    watch_activity_id: plan.watch_activity_id,
    target_activity_id: plan.target_id,
    surplus_activity_ids: plan.shells_to_drop,
    prior_export: prior
      ? { activity_id: prior.activity_id, mode: prior.mode, exported_at: prior.exported_at }
      : null,
    predicted_fingerprint: fingerprint,
    planned,
  };
}

/**
 * One ledger row per APPLIED backfill — the athlete asked for history to be sent, and
 * a batch of outbound writes to an external account should be as visible in the
 * decision trail as anything Cairn does on its own. A dry run decides nothing and
 * records nothing. Not reversible: once the sets are on Garmin, withdrawing them is
 * the exporter's own retract path, not an undo of this batch. Best-effort — the
 * enqueue already happened, and audit must never fail the operation.
 */
function recordBackfillDecision(sessionIds: number[], opts: GarminBackfillOptions): void {
  if (!sessionIds.length) return;
  try {
    const since = String(opts.since ?? "").trim();
    const until = String(opts.until ?? "").trim();
    const window = since || until ? `${since || "the beginning"} to ${until || "today"}` : "all eligible history";
    repo.recordDecision({
      effective_date: localDateISO(),
      kind: "garmin_backfill",
      domain: "training",
      summary: `Sent ${sessionIds.length} finished strength session${sessionIds.length === 1 ? "" : "s"} back to Garmin`,
      rationale: `History backfill over ${window}, queued oldest first.`,
      source: "garmin_export_backfill",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "ask",
      risk_class: "low",
      reversible: false,
      applied_at: new Date().toISOString(),
      context: { window, limit: clampLimit(opts.limit) },
      action: { session_ids: sessionIds },
    });
  } catch {
    /* the writes are queued; the audit row is bookkeeping */
  }
}

/**
 * Preview (or run) a batched backfill of finished Cairn strength sessions to Garmin.
 * Returns a plain result — an unconfigured connector and a disabled toggle are
 * ordinary outcomes, not errors, and they use the exporter's own vocabulary.
 */
export async function garminExportBackfill(opts: GarminBackfillOptions = {}): Promise<GarminBackfillResult> {
  const settings = repo.getSettings();
  if (!settings.garmin_export_strength) return { ok: true, skipped: "export_disabled" };
  if (!repo.getGarminCredentials().configured) return { ok: true, skipped: "garmin_not_configured" };

  const apply = opts.apply === true;
  const limit = clampLimit(opts.limit);
  // Eligibility comes back newest-first; history is built forward, so process the
  // other way round — Garmin's own calendar then fills in chronological order.
  const eligible = repo.sessionsEligibleForGarminExport(opts.since ?? "", opts.until).slice().reverse();

  const unmappedInBatch = new Map<number, string>();
  const seenInBatch = new Map<number, string>();
  const batch: GarminBackfillPreview[] = [];
  for (const id of eligible.slice(0, limit)) {
    const preview = previewOne(id, unmappedInBatch, seenInBatch);
    if (preview) batch.push(preview);
  }

  let enqueued = 0;
  if (apply) {
    const { enqueueEnrich } = await import("./enrich.js");
    const sessionIds: number[] = [];
    for (const preview of batch) {
      if (preview.planned === "unchanged" || preview.planned === "skip_no_mapped_sets") continue;
      enqueueEnrich("garmin_export", preview.session_id);
      sessionIds.push(preview.session_id);
      enqueued++;
    }
    recordBackfillDecision(sessionIds, opts);
  }

  // The long tail is the agentic layer's job, not ours: the `exercise` enrichment
  // prompt carries the FIT candidate shortlist and applyExerciseEnrichment validates
  // the pick. Two cohorts qualify — a movement the catalog could not place, and one
  // that has never been enriched at all (an install predating the background cleanup
  // carries a tail of raw names, and canonicalizing one is often what lets the
  // catalog place it). The job is idempotent and the rename is identity-guarded, so
  // re-queuing is safe. Queueing is still a real action: a dry run only NAMES them.
  let refineCandidates: GarminRefineCandidate[] | undefined;
  const refineQueued: GarminRefineCandidate[] = [];
  let refineSkipped: string | undefined;
  if (opts.refine_unmapped) {
    refineCandidates = [];
    for (const [id, name] of seenInBatch) {
      const reason: GarminRefineReason | null = unmappedInBatch.has(id)
        ? "unmapped"
        : neverEnriched(id)
          ? "never_enriched"
          : null;
      if (reason) refineCandidates.push({ exercise_id: id, exercise: name, reason });
    }
    if (!apply) refineSkipped = "dry_run";
    else if (!settings.enrich_enabled) refineSkipped = "enrich_disabled";
    else {
      for (const candidate of refineCandidates) {
        // The ONE gate for this queue — it stamps enrichment_status 'pending' and
        // enqueues, so a disabled install cannot accrue pending churn here either.
        if (repo.queueExerciseEnrichment(candidate.exercise_id) === "pending") refineQueued.push(candidate);
      }
    }
  }

  return {
    ok: true,
    dry_run: !apply,
    total_eligible: eligible.length,
    batch,
    enqueued,
    unmapped_exercises: [...unmappedInBatch.values()],
    ...(refineCandidates ? { refine_candidates: refineCandidates } : {}),
    refine_queued: refineQueued,
    ...(refineSkipped ? { refine_skipped: refineSkipped } : {}),
    remaining: Math.max(0, eligible.length - batch.length),
  };
}
