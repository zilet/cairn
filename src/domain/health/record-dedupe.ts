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
import { registerRestoredRecordSettler } from "../../repo/health.js";

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
 * file), then store the version, but ONLY after a pass that converged with no
 * error. A failing pass leaves the version unstored and counts the attempt
 * (`health_dedupe_rules_attempts`, "<version>:<n>"); after MAX_UPGRADE_ATTEMPTS
 * failing boots in a row it says so loudly and stops trying until the next version
 * bump. Runs before the enrichment queue resumes.
 */
export const DEDUPE_RULES_ATTEMPTS_KEY = "health_dedupe_rules_attempts";
export const MAX_UPGRADE_ATTEMPTS = 3;

export function runDedupeRulesUpgradeIfDue(): {
  ran: boolean;
  gave_up?: boolean;
  result?: DedupeHealthDocumentsResult;
} {
  const want = String(DEDUPE_RULES_VERSION);
  if (getAppState(DEDUPE_RULES_VERSION_KEY) === want) return { ran: false };
  const [attemptVersion, attemptCount] = String(getAppState(DEDUPE_RULES_ATTEMPTS_KEY) ?? "").split(":");
  const failures = attemptVersion === want ? Number(attemptCount) || 0 : 0;
  if (failures >= MAX_UPGRADE_ATTEMPTS) return { ran: false, gave_up: true };
  let result: DedupeHealthDocumentsResult;
  try {
    result = dedupeHealthDocuments({});
  } catch (e: any) {
    result = {
      dry_run: false,
      scanned: 0,
      passes: 0,
      clusters: [],
      merged: 0,
      added_markers: 0,
      deleted_files: 0,
      errors: [String(e?.message ?? e)],
      converged: false,
    };
  }
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
  if (result.converged && !result.errors.length) {
    setAppState(DEDUPE_RULES_VERSION_KEY, want);
    setAppState(DEDUPE_RULES_ATTEMPTS_KEY, "");
    return { ran: true, result };
  }
  const n = failures + 1;
  setAppState(DEDUPE_RULES_ATTEMPTS_KEY, `${want}:${n}`);
  const why = result.errors.length ? result.errors.join("; ") : "it did not settle within its pass limit";
  if (n >= MAX_UPGRADE_ATTEMPTS) {
    log.error(
      `[dedupe] rules v${want}: the whole-record duplicate pass failed on ${n} boots in a row (${why}). It will not run again until DEDUPE_RULES_VERSION changes; the Records screen's check still works.`
    );
  } else {
    log.warn(`[dedupe] rules v${want}: stopped early (${why}); will try again next boot (${n}/${MAX_UPGRADE_ATTEMPTS}).`);
  }
  return { ran: true, gave_up: n >= MAX_UPGRADE_ATTEMPTS, result };
}

export interface PlannedCluster {
  survivor: number;
  merged: number[];
  rule: string;
  // the uploads the plan said this merge deletes (ids, or the plan's {id} objects)
  removes?: Array<number | { id: number }>;
}

export const RECORDS_CHANGED_MESSAGE = "Your records changed since the check. Check again to see the current plan.";

/**
 * The Records screen's "Merge these": apply EXACTLY the clusters the person was
 * shown, never whatever happens to be foldable now. The approved pairs are re-planned
 * (dry run, restricted to them); only if every one still holds, with the same rule and
 * the same uploads deleted with it, and nothing else would ride along, are they folded, in the same synchronous call, so
 * nothing can change in between. Otherwise nothing is folded and the answer says the
 * records changed.
 */
export function applyPlannedDedupe(
  planned: PlannedCluster[]
): (DedupeHealthDocumentsResult & { ok: true }) | { ok: false; changed: true; error: string } {
  const wanted = new Set<string>();
  const allow = new Set<string>();
  for (const cluster of Array.isArray(planned) ? planned : []) {
    const survivor = Number(cluster?.survivor);
    for (const id of Array.isArray(cluster?.merged) ? cluster.merged : []) {
      const twin = Number(id);
      if (!Number.isInteger(survivor) || !Number.isInteger(twin)) continue;
      allow.add(`${survivor}:${twin}`);
      wanted.add(`${String(cluster.rule)}:${survivor}:${twin}`);
    }
    // the uploads it deletes are part of what the person agreed to
    for (const removed of Array.isArray(cluster?.removes) ? cluster.removes : []) {
      const rid = Number(typeof removed === "object" && removed ? (removed as any).id : removed);
      if (Number.isInteger(rid)) wanted.add(`removes:${survivor}:${rid}`);
    }
  }
  const changed = { ok: false as const, changed: true as const, error: RECORDS_CHANGED_MESSAGE };
  if (!wanted.size) return changed;
  const pairs = (result: DedupeHealthDocumentsResult) =>
    new Set(
      result.clusters.flatMap((c) => [
        ...c.merged.map((m) => `${c.rule}:${c.survivor.id}:${m.id}`),
        ...(c.removes ?? []).map((r) => `removes:${c.survivor.id}:${r.id}`),
      ])
    );
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((key) => b.has(key));
  const plan = dedupeHealthDocuments({ dryRun: true, allow });
  if (plan.errors.length || !same(pairs(plan), wanted)) return changed;
  const applied = dedupeHealthDocuments({ allow });
  if (applied.merged) {
    try {
      deriveDirectives();
    } catch {
      /* the fold is done; the connected brain settles on its next pass */
    }
  }
  return { ok: true as const, ...applied };
}

// Twins re-filed after the record they folded into went with its upload settle
// through the same chokepoint (src/repo/health.ts calls back; it cannot import this).
registerRestoredRecordSettler((id) => {
  settleNewHealthRecords(id, { label: `re-filed health#${id}` });
});
