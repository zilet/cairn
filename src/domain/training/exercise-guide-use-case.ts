// Importing the exercise guide library — the only place in Cairn that reaches out
// to the free-exercise-db dataset, and only when the athlete asks it to.
//
// Two stages, deliberately split so neither blocks the other:
//   1. import — pull the ~1 MB metadata JSON once, cache it under DATA_DIR, store
//      every row, and re-run matching. Seconds, not minutes.
//   2. images — pulled LAZILY, one photo at a time, on first view of a guide that
//      actually matched something the athlete trains. The full dataset carries
//      ~1,750 photos (~65 MB); a real library needs a few dozen of them, so eagerly
//      downloading the lot would spend forty times the bytes for the same result.
//
// Every network failure degrades to absence: no dataset means no detail section,
// no photo means the steps render without one. Nothing here ever throws at a route.
import fs from "node:fs";
import path from "node:path";
import {
  EXERCISE_GUIDE_DATASET_PATH,
  EXERCISE_GUIDE_DATASET_URL,
  EXERCISE_GUIDE_LICENSE,
  EXERCISE_GUIDE_REPO_URL,
  EXERCISE_GUIDE_SOURCE,
  EXERCISE_GUIDES_DIR,
  type ExerciseGuideRecord,
  type GuideLinkSuggestion,
  guideImageCount,
  isValidGuideId,
  linkedGuideIds,
  linkGuidesToExercises,
  localGuideImagePath,
  remoteGuideImageUrl,
  upsertGuideRecords,
  usableGuideRecords,
} from "../../repo/exercise-guide.js";

/** Injectable so the test suite stays offline and deterministic. */
export type GuideFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface ExerciseGuideImportOptions {
  fetchImpl?: GuideFetch;
  /** Re-download the metadata even when a cached copy exists. */
  refresh?: boolean;
  /** Eagerly pull the demonstration photos for every linked guide (default: lazy). */
  prefetchImages?: boolean;
}

const DATASET_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 15_000;
const MAX_DATASET_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function defaultFetch(): GuideFetch | null {
  const impl = (globalThis as { fetch?: GuideFetch }).fetch;
  return typeof impl === "function" ? impl.bind(globalThis) : null;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readCachedDataset(): unknown | null {
  try {
    const raw = fs.readFileSync(EXERCISE_GUIDE_DATASET_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export type ExerciseGuideImportResult =
  | {
      ok: true;
      source: string;
      license: string;
      source_url: string;
      /** true when the metadata came from the on-disk cache instead of the network. */
      cached: boolean;
      records: number;
      /**
       * Upstream rows the id/name/instructions filter discarded. Normally 0; a
       * non-zero count is the dataset drifting away from the shape we read, which is
       * worth seeing rather than silently absorbing.
       */
      dropped: number;
      stored: number;
      linked: number;
      unmatched: number;
      suggested: GuideLinkSuggestion[];
      images_fetched: number;
    }
  | { ok: false; error: string };

/**
 * Fetch (or reuse) the dataset, store it, and match it against the athlete's
 * exercises. Idempotent: running it twice writes the same rows and produces the
 * same links, and the second run reuses the cached JSON unless `refresh` is set.
 */
export async function importExerciseGuides(
  options: ExerciseGuideImportOptions = {}
): Promise<ExerciseGuideImportResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  let payload: unknown | null = options.refresh ? null : readCachedDataset();
  let cached = payload != null;

  if (!payload) {
    if (!fetchImpl) return { ok: false, error: "no fetch implementation available" };
    try {
      const response = await fetchImpl(EXERCISE_GUIDE_DATASET_URL, {
        signal: AbortSignal.timeout(DATASET_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, error: `dataset fetch failed (HTTP ${response.status})` };
      const body = await response.text();
      if (body.length > MAX_DATASET_BYTES) return { ok: false, error: "dataset is implausibly large" };
      payload = JSON.parse(body);
      ensureDir(EXERCISE_GUIDES_DIR);
      fs.writeFileSync(EXERCISE_GUIDE_DATASET_PATH, body);
      cached = false;
    } catch (error: any) {
      return { ok: false, error: error?.message || "dataset fetch failed" };
    }
  }

  const records: ExerciseGuideRecord[] = usableGuideRecords(payload);
  if (!records.length) return { ok: false, error: "dataset contained no usable exercises" };

  const stored = upsertGuideRecords(records);
  const link = linkGuidesToExercises(records);

  let imagesFetched = 0;
  if (options.prefetchImages) {
    for (const guideId of linkedGuideIds()) {
      const count = guideImageCount(guideId);
      for (let index = 0; index < count; index += 1) {
        const file = await ensureGuideImage(guideId, index, { fetchImpl });
        if (file) imagesFetched += 1;
      }
    }
  }

  return {
    ok: true,
    source: EXERCISE_GUIDE_SOURCE,
    license: EXERCISE_GUIDE_LICENSE,
    source_url: EXERCISE_GUIDE_REPO_URL,
    cached,
    records: records.length,
    dropped: Math.max(0, (Array.isArray(payload) ? payload.length : 0) - records.length),
    stored,
    linked: link.linked,
    unmatched: link.unmatched.length,
    suggested: link.suggested,
    images_fetched: imagesFetched,
  };
}

/**
 * The local path to one demonstration photo, downloading it on first use. Returns
 * null whenever the photo cannot be had — an unknown guide, an out-of-range frame,
 * no network, a non-image response — so the caller answers "no photo", not an error.
 */
export async function ensureGuideImage(
  guideId: string,
  index: number,
  options: { fetchImpl?: GuideFetch | null } = {}
): Promise<string | null> {
  const target = localGuideImagePath(guideId, index);
  if (!target) return null;
  if (!isValidGuideId(guideId) || index >= guideImageCount(guideId)) return null;
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  } catch {
    // fall through and re-fetch
  }

  const fetchImpl = options.fetchImpl ?? defaultFetch();
  if (!fetchImpl) return null;
  try {
    const response = await fetchImpl(remoteGuideImageUrl(guideId, index), {
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    // JPEG magic bytes — the dataset serves only JPEGs, and we serve what we stored
    // back to an <img>, so anything else never reaches disk.
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, bytes);
    return target;
  } catch {
    return null;
  }
}

/** The already-cached photo, with no network fetch. Null when it is not on disk. */
export function cachedGuideImage(guideId: string, index: number): string | null {
  const target = localGuideImagePath(guideId, index);
  if (!target) return null;
  try {
    return fs.existsSync(target) && fs.statSync(target).size > 0 ? target : null;
  } catch {
    return null;
  }
}
