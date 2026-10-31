// One record per draw, settled the moment a record is added.
//
// Every path that creates a health record (an upload or paste once its read
// lands, the CCDA pass, a reanalysis, a confirmed chat paste, chat's direct
// record, MCP add_health_record) ends by calling settleNewHealthRecords(id): the
// deterministic fold (src/repo/health-dedupe.ts) of the rows that path created,
// matched against the WHOLE existing record set. A path that skipped it was how a
// pasted panel that fully duplicated one already on file stayed filed twice.
//
// Imaging is settled one step later, never inside the ingest that is still
// writing it: the enrichment engine registers an enqueuer here, and an imaging
// row created by `id` puts one job on its serial queue, which folds strict twins
// and asks an agent about near-twins once that ingest has finished
// (settleImagingTwins, src/coachOps/health.ts).
//
// And once per rules version at boot (runDedupeRulesUpgradeIfDue): a deploy whose
// rules recognize a twin the old ones missed folds the existing set once. No
// recurring job, and no agent: the boot pass is deterministic.
//
// Concurrency: node:sqlite is synchronous, and every fold here runs to completion
// inside one synchronous call, so no other request, ingest step or job can
// interleave with it on the event loop. The fold also skips any row whose read is
// still pending or in progress (loadRows), except the upload it was scoped to.

import { log } from "../../log.js";
import { getAppState, setAppState } from "../../repo/app-state.js";
import { DEDUPE_RULES_VERSION, dedupeHealthDocuments } from "../../repo/health-dedupe.js";
import type { DedupeHealthDocumentsResult } from "../../repo/health-dedupe.js";
import { db } from "../../db.js";
import { deriveDirectives } from "../../repo/propagation.js";

export const DEDUPE_RULES_VERSION_KEY = "health_dedupe_rules_version";

let imagingEnqueuer: ((id: number) => void) | null = null;

// The enrichment engine registers how an imaging settle is queued (the repo layer
// must not import the engine). Until it does, imaging simply waits for the
// Records screen's check.
export function registerImagingSettleEnqueuer(fn: ((id: number) => void) | null): void {
  imagingEnqueuer = fn;
}

function createsImaging(id: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM health_documents WHERE kind = 'imaging' AND (id = ? OR source_doc_id = ?) LIMIT 1`)
    .get(id, id);
}

/**
 * The chokepoint every health-record creation path settles through. Folds the rows
 * `id` created (the record itself, or the panels split out of the upload `id`) into
 * any record already on file that carries the same draw or encounter, and queues
 * the imaging settle when `id` produced an imaging study. Never throws: a fold that
 * fails leaves the records exactly as they were.
 */
export function settleNewHealthRecords(id: number, opts: { label?: string } = {}): DedupeHealthDocumentsResult | null {
  const where = opts.label ?? `health#${id}`;
  let folded: DedupeHealthDocumentsResult | null = null;
  try {
    folded = dedupeHealthDocuments({ scopeSourceId: id });
    if (folded.merged) {
      log.info(
        `[dedupe] ${where}: folded ${folded.merged} duplicate record(s) into ${folded.clusters.length} existing record(s) (+${folded.added_markers} marker(s)).`
      );
    }
    if (folded.errors.length) log.warn(`[dedupe] ${where}: ${folded.errors.join("; ")}`);
  } catch (e: any) {
    log.warn(`[dedupe] ${where}: duplicate fold failed: ${e?.message ?? e}`);
  }
  try {
    if (imagingEnqueuer && createsImaging(id)) imagingEnqueuer(id);
  } catch (e: any) {
    log.warn(`[dedupe] ${where}: could not queue the imaging check: ${e?.message ?? e}`);
  }
  return folded;
}

/**
 * Boot: when the stored rules version differs from DEDUPE_RULES_VERSION, fold the
 * whole record set once (deterministic rules plus any agent verdict already on
 * file), then store the version. A fold that stopped on an error leaves the version
 * unstored, so the next boot tries again. Runs before the enrichment queue resumes.
 */
export function runDedupeRulesUpgradeIfDue(): { ran: boolean; result?: DedupeHealthDocumentsResult } {
  const want = String(DEDUPE_RULES_VERSION);
  if (getAppState(DEDUPE_RULES_VERSION_KEY) === want) return { ran: false };
  const result = dedupeHealthDocuments({});
  if (result.merged) {
    log.info(
      `[dedupe] rules v${want}: folded ${result.merged} duplicate record(s) into ${result.clusters.length} record(s).`
    );
    try {
      deriveDirectives();
    } catch (e: any) {
      log.warn(`[dedupe] re-deriving after the rules upgrade failed: ${e?.message ?? e}`);
    }
  }
  if (result.errors.length) {
    log.warn(`[dedupe] rules v${want}: stopped early (${result.errors.join("; ")}); will try again next boot.`);
  } else {
    setAppState(DEDUPE_RULES_VERSION_KEY, want);
  }
  return { ran: true, result };
}
