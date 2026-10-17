// @ts-check
// Garmin/cardio sync freshness helpers shared by Today and Plan -> Endurance.

type CardioSyncSettings = {
  garmin_credentials_source?: unknown;
  garmin_username?: unknown;
  garmin_password_configured?: unknown;
  garmin_last_sync_at?: unknown;
  garmin_last_sync_status?: unknown;
  garmin_last_export_attempt_at?: unknown;
  garmin_last_export_status?: unknown;
  garmin_sleep_gap_nights?: unknown;
};

type CardioSyncOptions = {
  expectingRun?: unknown;
};

type GarminSyncResult = import("../contracts/client-api.js").ClientGarminSyncResult;
type GarminSyncApi = (
  path: string,
  opts?: { method?: string; cache?: RequestCache; acceptErrorBody?: boolean }
) => Promise<unknown>;
type GarminSyncDeps = { api?: GarminSyncApi; wait?: (ms: number) => Promise<void>; readTimeoutMs?: number };

const CARDIO_HR_ZONE_COLORS = ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"];

// The line under the sync row answers "is anything actually wrong?" and stays silent
// when nothing is. Two things can be wrong and neither used to be visible anywhere:
// a strength write-back that has stopped landing, and a watch that has stopped sending
// sleep. Both are stated once, plainly, with what happens next — never a nag, never a
// count of what the athlete "should" have done.
const CARDIO_EXPORT_FAILED_VARIANTS: Array<(rel: string) => string> = [
  (rel) => `Last Garmin write failed ${rel} · it tries again on the next sync`,
  (rel) => `The last strength write to Garmin didn't land ${rel} — the next sync retries it`,
  (rel) => `Garmin didn't take the last strength write ${rel}; it retries on its own`,
];

const CARDIO_SLEEP_GAP_VARIANTS: Array<(missing: number, window: number) => string> = [
  (missing, window) => `Your watch hasn't sent sleep for ${missing} of the last ${window} nights`,
  (missing, window) => `${missing} of the last ${window} nights came in without sleep from your watch`,
  (missing, window) => `No sleep from your watch on ${missing} of the last ${window} nights`,
];

// A sync runs on the server as a background job (POST /api/garmin/sync answers at once
// with it). The PWA reads the job until it ends: measured 15 s typical, 53 s at worst,
// so a read every 1.5 s, given up quietly after four minutes — or sooner, after a run
// of reads that could not reach the server at all.
const GARMIN_SYNC_POLL_MS = 1500;
const GARMIN_SYNC_MAX_POLLS = 160;
const GARMIN_SYNC_MAX_MISSED_READS = 5;
// Each request gets this long to answer. A read can otherwise never settle at all —
// api() answers a 401 by opening sign-in and leaving its promise pending — and one
// read that never settles would hold the page-wide run, and the busy button, forever.
const GARMIN_SYNC_READ_TIMEOUT_MS = 20_000;

/** Below this many missing nights the line says nothing — a stray night is normal. */
const CARDIO_SLEEP_GAP_MIN = 3;
const CARDIO_SLEEP_GAP_WINDOW = 7;

(() => {
  function garminConfigured(settings: CardioSyncSettings | null | undefined): boolean {
    if (!settings) return false;
    if (settings.garmin_credentials_source && settings.garmin_credentials_source !== "none") return true;
    return !!(settings.garmin_username || settings.garmin_password_configured);
  }

  function cardioSyncLine(settings: CardioSyncSettings | null | undefined, opts: CardioSyncOptions = {}): string {
    if (!garminConfigured(settings)) return "";
    const at = settings?.garmin_last_sync_at;
    const raw = String(settings?.garmin_last_sync_status || "");
    const failed = raw.startsWith("failed");
    const parsedAt = at ? Date.parse(String(at)) : Number.NaN;
    const ageH = Number.isFinite(parsedAt) ? Math.max(0, (Date.now() - parsedAt) / 3600000) : Infinity;
    const stale = !at || failed || ageH > 3;
    let lead: string;
    if (opts.expectingRun && stale) {
      lead = `<span class="cardio-sync-dot stale" aria-hidden="true"></span><span class="cardio-sync-text">this morning's run not synced yet?</span>`;
    } else if (!at) {
      lead = `<span class="cardio-sync-dot" aria-hidden="true"></span><span class="cardio-sync-text">not synced yet</span>`;
    } else {
      const dotCls = failed ? "err" : "";
      const word = failed ? "Sync failed" : "synced";
      lead = `<span class="cardio-sync-dot ${dotCls}" aria-hidden="true"></span><span class="cardio-sync-text">${word} ${escHtml(relTime(String(at)))}</span>`;
    }
    return `<div class="cardio-sync" data-cardio-sync>
        ${lead}
        <button class="linkbtn linkbtn-plain cardio-sync-go" type="button" data-syncnow>Sync now</button>
      </div>${cardioSyncNotesHtml(settings)}`;
  }

  /**
   * The quiet notes under the sync row: a write-back that has stopped landing, and a
   * watch that has stopped sending sleep. Each appears only while it is true, and
   * neither asks the athlete for anything — the retry is automatic and a missing night
   * is a device fact, not a failure. Empty when both are fine, which is the usual case.
   */
  function cardioSyncNotesHtml(settings: CardioSyncSettings | null | undefined): string {
    const notes: string[] = [];
    const exportStatus = String(settings?.garmin_last_export_status || "");
    const exportAt = settings?.garmin_last_export_attempt_at;
    if (exportStatus.startsWith("failed") && exportAt) {
      const rel = relTime(String(exportAt));
      const date = String(exportAt).slice(0, 10);
      notes.push(escHtml(pickDayVariant(CARDIO_EXPORT_FAILED_VARIANTS, date, "garmin-export-failed")(rel)));
    }
    const missing = Number(settings?.garmin_sleep_gap_nights);
    if (Number.isFinite(missing) && missing >= CARDIO_SLEEP_GAP_MIN) {
      notes.push(
        escHtml(
          pickDayVariant(CARDIO_SLEEP_GAP_VARIANTS, undefined, "garmin-sleep-gap")(
            Math.trunc(missing),
            CARDIO_SLEEP_GAP_WINDOW
          )
        )
      );
    }
    if (!notes.length) return "";
    return notes.map((note) => `<div class="cardio-sync-note">${note}</div>`).join("");
  }

  function garminSyncRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  let garminSyncRun: Promise<GarminSyncResult | null> | null = null;

  function garminSyncReadWithin<T>(read: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer")), ms);
    });
    return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * Ask the server for a Garmin sync and settle with how it ended: the sync's own
   * result once its job is done, or null when it could not be asked or did not finish.
   * Every caller in this page shares one run — a second tap, or Settings while Today's
   * is going, waits on the same one (the server also hands a second POST the same job).
   * An older server that still answered inline is read as that answer.
   */
  function syncGarminNow(deps: GarminSyncDeps = {}): Promise<GarminSyncResult | null> {
    if (garminSyncRun) return garminSyncRun;
    const call: GarminSyncApi = deps.api ?? ((path, opts) => api(path, opts));
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const readMs = deps.readTimeoutMs ?? GARMIN_SYNC_READ_TIMEOUT_MS;
    const follow = async (): Promise<GarminSyncResult | null> => {
      let posted: Record<string, unknown>;
      try {
        posted = garminSyncRecord(await garminSyncReadWithin(call("/garmin/sync", { method: "POST" }), readMs));
      } catch {
        return null;
      }
      let job = garminSyncRecord(posted.job);
      const id = job.id ?? posted.job_id;
      if (id == null) return typeof posted.ok === "boolean" ? (posted as unknown as GarminSyncResult) : null;
      let missed = 0;
      for (let polls = 0; !["done", "error", "canceled"].includes(String(job.status)); polls++) {
        if (polls >= GARMIN_SYNC_MAX_POLLS || missed >= GARMIN_SYNC_MAX_MISSED_READS) return null;
        await wait(GARMIN_SYNC_POLL_MS);
        try {
          const read = garminSyncRecord(
            await garminSyncReadWithin(
              call(`/agent-jobs/${encodeURIComponent(String(id))}`, { cache: "no-store", acceptErrorBody: true }),
              readMs
            )
          );
          missed = 0;
          if (read.job) job = garminSyncRecord(read.job);
          else if (read.ok === false) return null; // the job is gone (pruned, or a restore)
        } catch {
          // A missed read is not an ending by itself: the next one tries again.
          missed++;
        }
      }
      const result = garminSyncRecord(job.result);
      return job.status === "done" && typeof result.ok === "boolean" ? (result as unknown as GarminSyncResult) : null;
    };
    const run = follow().then((result) => {
      // Refresh what the sync changed HERE, once per run, whoever is still waiting: the
      // athlete may have left the surface that asked during a 15–50 s sync, and the
      // reads it fed (Today, Train, Endurance) must not keep painting the old day.
      if (result?.ok) garminSyncLanded();
      return result;
    });
    garminSyncRun = run;
    void run.finally(() => {
      if (garminSyncRun === run) garminSyncRun = null;
    });
    return run;
  }

  // What a finished sync can have changed: every read the ONE write table names for it.
  function garminSyncLanded(): void {
    try {
      if (typeof CairnWriteInvalidation !== "undefined") {
        CairnWriteInvalidation.invalidateWrite("garmin_sync");
        return;
      }
      if (typeof swrInvalidate === "function") {
        if (typeof state !== "undefined") swrInvalidate("today:session:" + state.logDate);
        swrInvalidate("stats");
      }
    } catch {
      // A refresh that could not be marked costs one stale paint, never the sync.
    }
  }

  function wireCardioSync(scope: ParentNode | null | undefined, onDone?: () => unknown): void {
    (scope || view).querySelectorAll<HTMLButtonElement>("[data-syncnow]").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", async () => {
        const line = btn.closest<HTMLElement>("[data-cardio-sync]");
        const text = line?.querySelector<HTMLElement>(".cardio-sync-text") ?? null;
        const prevText = text ? text.textContent || "" : "";
        const dot = line?.querySelector<HTMLElement>(".cardio-sync-dot") ?? null;
        if (dot) dot.classList.add("pulse");
        if (text) text.textContent = "Asking Garmin for the latest…";
        const restore =
          typeof btnBusy === "function"
            ? btnBusy(btn, "Syncing")
            : (() => {
                btn.disabled = true;
                return () => {
                  btn.disabled = false;
                };
              })();
        // The run itself refreshes the reads a landed sync fed (garminSyncLanded), so a
        // surface left mid-sync still comes back fresh; only this line's paint is skipped.
        const result = await syncGarminNow();
        if (!btn.isConnected) return;
        if (result?.ok) {
          const activities = Number(result.activities) || 0;
          toast(`Garmin synced · ${activities} activit${activities === 1 ? "y" : "ies"}`);
          if (onDone) {
            onDone();
            return;
          }
        }
        // A sync that did not land says so once, on the line itself, and the button is
        // ready again. No toast — the line is where it shows. Garmin itself turning the
        // sync down (a sign-in the server could not make) is not fixed by a retry, so
        // that line points to where the connection lives; no answer at all is a retry.
        restore();
        if (dot) dot.classList.remove("pulse");
        if (text) {
          text.textContent = result?.ok
            ? prevText
            : result
              ? "That sync didn't go through · Settings → Sources has the details"
              : "Garmin didn't answer just now · try again";
        }
      });
    });
  }

  const CAIRN_CARDIO_SYNC = {
    configured: garminConfigured,
    lineHtml: cardioSyncLine,
    wire: wireCardioSync,
    sync: syncGarminNow,
    zoneColors: CARDIO_HR_ZONE_COLORS,
  };

  Object.assign(globalThis, {
    CairnCardioSync: CAIRN_CARDIO_SYNC,
    HR_ZONE_COLORS: CARDIO_HR_ZONE_COLORS,
    garminConfigured,
    cardioSyncLine,
    wireCardioSync,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnCardioSync: CAIRN_CARDIO_SYNC,
      HR_ZONE_COLORS: CARDIO_HR_ZONE_COLORS,
      garminConfigured,
      cardioSyncLine,
      wireCardioSync,
    });
  }
})();
