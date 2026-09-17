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

type GarminSyncResponse = import("../contracts/client-api.js").ClientGarminSyncResponse;

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

  function wireCardioSync(scope: ParentNode | null | undefined, onDone?: () => unknown): void {
    (scope || view).querySelectorAll<HTMLButtonElement>("[data-syncnow]").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", async () => {
        const line = btn.closest<HTMLElement>("[data-cardio-sync]");
        btn.disabled = true;
        const text = line?.querySelector<HTMLElement>(".cardio-sync-text") ?? null;
        const prevText = text ? text.textContent || "" : "";
        const dot = line?.querySelector<HTMLElement>(".cardio-sync-dot") ?? null;
        if (dot) dot.classList.add("pulse");
        if (text) text.textContent = "Syncing...";
        btn.textContent = "...";
        let result: GarminSyncResponse | null = null;
        try {
          result = await api("/garmin/sync", { method: "POST" });
        } catch {}
        if (!btn.isConnected) return;
        const ok = !!(result && result.ok);
        const activities = Number(result?.activities) || 0;
        toast(ok ? `Garmin synced · ${activities} activit${activities === 1 ? "y" : "ies"}` : "Garmin sync failed");
        if (ok) {
          swrInvalidate("today:session:" + state.logDate);
          swrInvalidate("stats");
          if (onDone) {
            onDone();
            return;
          }
        }
        if (dot) dot.classList.remove("pulse");
        if (text) text.textContent = prevText;
        btn.disabled = false;
        btn.textContent = "Sync now";
      });
    });
  }

  const CAIRN_CARDIO_SYNC = {
    configured: garminConfigured,
    lineHtml: cardioSyncLine,
    wire: wireCardioSync,
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
