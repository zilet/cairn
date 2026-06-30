(() => {
// @ts-check
// Garmin/cardio sync freshness helpers shared by Today and Plan -> Endurance.
const CARDIO_HR_ZONE_COLORS = ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"];
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
    function wireCardioSync(scope, onDone) {
        (scope || view).querySelectorAll("[data-syncnow]").forEach((btn) => {
            if (btn.dataset.wired === "1")
                return;
            btn.dataset.wired = "1";
            btn.addEventListener("click", async () => {
                const line = btn.closest("[data-cardio-sync]");
                btn.disabled = true;
                const text = line?.querySelector(".cardio-sync-text") ?? null;
                const prevText = text ? text.textContent || "" : "";
                const dot = line?.querySelector(".cardio-sync-dot") ?? null;
                if (dot)
                    dot.classList.add("pulse");
                if (text)
                    text.textContent = "Syncing...";
                btn.textContent = "...";
                let result = null;
                try {
                    result = await api("/garmin/sync", { method: "POST" });
                }
                catch { }
                if (!btn.isConnected)
                    return;
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
                if (dot)
                    dot.classList.remove("pulse");
                if (text)
                    text.textContent = prevText;
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
})();
