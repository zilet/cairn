// @ts-check
// Garmin/cardio sync freshness helpers shared by Today and Plan -> Endurance.
(() => {
    function garminConfigured(settings) {
        if (!settings)
            return false;
        if (settings.garmin_credentials_source && settings.garmin_credentials_source !== "none")
            return true;
        return !!(settings.garmin_username || settings.garmin_password_configured);
    }
    function cardioSyncLine(settings, opts = {}) {
        if (!garminConfigured(settings))
            return "";
        const at = settings?.garmin_last_sync_at;
        const raw = String(settings?.garmin_last_sync_status || "");
        const failed = raw.startsWith("failed");
        const parsedAt = at ? Date.parse(String(at)) : Number.NaN;
        const ageH = Number.isFinite(parsedAt) ? Math.max(0, (Date.now() - parsedAt) / 3600000) : Infinity;
        const stale = !at || failed || ageH > 3;
        let lead;
        if (opts.expectingRun && stale) {
            lead = `<span class="cardio-sync-dot stale" aria-hidden="true"></span><span class="cardio-sync-text">this morning's run not synced yet?</span>`;
        }
        else if (!at) {
            lead = `<span class="cardio-sync-dot" aria-hidden="true"></span><span class="cardio-sync-text">not synced yet</span>`;
        }
        else {
            const dotCls = failed ? "err" : "";
            const word = failed ? "Sync failed" : "synced";
            lead = `<span class="cardio-sync-dot ${dotCls}" aria-hidden="true"></span><span class="cardio-sync-text">${word} ${escHtml(relTime(String(at)))}</span>`;
        }
        return `<div class="cardio-sync" data-cardio-sync>
        ${lead}
        <button class="cardio-sync-go" type="button" data-syncnow>Sync now</button>
      </div>`;
    }
    const CAIRN_CARDIO_SYNC = {
        configured: garminConfigured,
        lineHtml: cardioSyncLine,
    };
    Object.assign(globalThis, {
        CairnCardioSync: CAIRN_CARDIO_SYNC,
        garminConfigured,
        cardioSyncLine,
    });
    if (typeof window !== "undefined") {
        Object.assign(window, {
            CairnCardioSync: CAIRN_CARDIO_SYNC,
            garminConfigured,
            cardioSyncLine,
        });
    }
})();
