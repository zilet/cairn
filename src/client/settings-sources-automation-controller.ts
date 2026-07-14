// @ts-check
// Settings -> Sources/Automation controller: input sources, connector sync, and background toggles.
{
  function settingsSourcesAutomationRequired<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector<T>(selector);
    if (!el) throw new Error(`Missing Settings Sources/Automation element: ${selector}`);
    return el;
  }

  function settingsSourcesAutomationOptional<T extends Element = HTMLElement>(
    root: ParentNode,
    selector: string
  ): T | null {
    return root.querySelector<T>(selector);
  }

  function settingsSourcesAutomationInput(event: Event): HTMLInputElement {
    return event.currentTarget as HTMLInputElement;
  }

  function appleHealthShortcutRecipe(origin: string): string {
    const endpoint = origin.replace(/\/$/, "") + "/api/health-metrics";
    return `Cairn Apple Health Shortcut manual recipe

1. Name the shortcut "Update Cairn from Apple Health".
2. Choose the day to summarize and Format Date as yyyy-MM-dd.
3. Add Find Health Samples actions for only the data you want to share. Filter to that day, then calculate the appropriate sum or average.
4. Build a Dictionary. Always include:
   source: apple_health
   date: <formatted date>
   Add only available values: steps, sleep_min, resting_hr, hrv_ms, active_calories, total_calories, distance_km, exercise_min, stand_hours, spo2_avg, vo2max.
5. Add Get Contents of URL:
   URL: ${endpoint}
   Method: POST
   Request Body: JSON (the Dictionary)
   Authorization: use a dedicated ingest token obtained through the pairing exchange, or the owner token only for a manually managed trusted instance. Never put either token in the URL.
6. Read the response Dictionary. If ok is true, Show Notification "Cairn updated". Otherwise Show Alert with errors. A connection failure can be retried by running the shortcut again; source+date upsert makes repeats safe.
7. Run once and approve the requested Health permissions. Optionally create a Time of Day personal automation that runs this shortcut.

Apple requires the shortcut actions and Health permissions to be reviewed on your device. The Cairn project can publish an exported, Apple-validated Shortcut, but this checkout does not fabricate or bundle one.`;
  }

  function appleHealthRunLink(shortcutName: string, origin: string, pairingCode: string): string {
    const payload = JSON.stringify({
      base_url: origin.replace(/\/$/, ""),
      pairing_code: pairingCode,
    });
    const params = new URLSearchParams({ name: shortcutName, input: "text", text: payload });
    return `shortcuts://run-shortcut?${params.toString()}`;
  }

  function appleHealthStateRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  async function renderSettingsSources(deps: ClientSettingsSourcesAutomationControllerDeps): Promise<void> {
    const wm = deps.workingModel;
    deps.root.innerHTML = CairnSettingsSurface.sourcesSliceHtml({
      workingModel: wm,
      settings: deps.settings,
      garminStatusHtml: deps.garminStatusLine(deps.settings, false),
    });

    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#garminUsername").addEventListener(
      "input",
      (event) => {
        wm.garmin_username = settingsSourcesAutomationInput(event).value;
      }
    );
    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#garminPassword").addEventListener(
      "input",
      (event) => {
        wm.garmin_password = settingsSourcesAutomationInput(event).value;
      }
    );

    // Manual Garmin sync: pulse while the connector runs, then re-pull /settings so the
    // status line shows exactly what the server recorded.
    settingsSourcesAutomationRequired<HTMLButtonElement>(deps.root, "#garminSyncBtn").addEventListener(
      "click",
      async () => {
        const btn = settingsSourcesAutomationRequired<HTMLButtonElement>(deps.root, "#garminSyncBtn");
        const status = settingsSourcesAutomationRequired<HTMLElement>(deps.root, "#garminStatus");
        btn.disabled = true;
        btn.textContent = "Syncing…";
        status.innerHTML = deps.garminStatusLine(null, true);
        let result: SettingsScreenGarminSyncResponse | null = null;
        try {
          result = (await deps.api("/garmin/sync", { method: "POST" })) as SettingsScreenGarminSyncResponse;
        } catch {}
        let fresh: unknown = deps.settings;
        try {
          fresh = CairnSettingsSurface.settingsData(await deps.api("/settings")).settings;
        } catch {}
        if (!btn.isConnected) return; // slice/tab swapped while we waited
        status.innerHTML = deps.garminStatusLine(fresh, false);
        btn.disabled = false;
        btn.textContent = "Sync now";
        deps.toast(
          result && result.ok
            ? `Garmin synced · ${result.activities} activit${result.activities === 1 ? "y" : "ies"}`
            : "Garmin sync failed"
        );
      }
    );

    const origin = deps.locationOrigin ?? location.origin;
    const card = settingsSourcesAutomationOptional<HTMLElement>(deps.root, "#appleHealthCard");
    if (!card) return;

    const loadAppleHealth = async (error: string | null = null): Promise<void> => {
      try {
        const [rawConfig, rawConnections] = await Promise.all([
          deps.api("/apple-health/config"),
          deps.api("/apple-health/connections"),
        ]);
        if (!card.isConnected) return;
        const config = appleHealthStateRecord(rawConfig);
        const connectionData = appleHealthStateRecord(rawConnections);
        const connections = Array.isArray(connectionData.connections) ? connectionData.connections : [];
        card.innerHTML = CairnSettingsSurface.appleHealthCardHtml({ config, connections, error });
      } catch {
        if (!card.isConnected) return;
        card.innerHTML = CairnSettingsSurface.appleHealthCardHtml({
          error: error || "Could not load Apple Health connection status.",
        });
      }

      const ahUrl = settingsSourcesAutomationOptional<HTMLElement>(card, "#ahUrl");
      if (ahUrl) ahUrl.textContent = origin.replace(/\/$/, "") + "/api/health-metrics";
      const ahCopy = settingsSourcesAutomationOptional<HTMLButtonElement>(card, "#ahUrlCopy");
      if (ahCopy)
        ahCopy.addEventListener("click", async () => {
          try {
            await (deps.clipboard ?? navigator.clipboard).writeText(origin.replace(/\/$/, "") + "/api/health-metrics");
            ahCopy.textContent = "Copied";
          } catch {
            ahCopy.textContent = "Copy failed";
          }
          (deps.setTimeout ?? setTimeout)(() => {
            ahCopy.textContent = "Copy endpoint";
          }, 1600);
        });
      const recipeCopy = settingsSourcesAutomationOptional<HTMLButtonElement>(card, "#ahRecipeCopy");
      if (recipeCopy)
        recipeCopy.addEventListener("click", async () => {
          try {
            await (deps.clipboard ?? navigator.clipboard).writeText(appleHealthShortcutRecipe(origin));
            recipeCopy.textContent = "Recipe copied";
          } catch {
            recipeCopy.textContent = "Copy failed";
          }
          (deps.setTimeout ?? setTimeout)(() => {
            recipeCopy.textContent = "Copy manual recipe";
          }, 2000);
        });

      const refresh = settingsSourcesAutomationOptional<HTMLButtonElement>(card, "#ahRefresh");
      if (refresh) refresh.addEventListener("click", () => void loadAppleHealth());
      const retry = settingsSourcesAutomationOptional<HTMLButtonElement>(card, "#ahRetry");
      if (retry) retry.addEventListener("click", () => void loadAppleHealth());
      for (const button of card.querySelectorAll<HTMLButtonElement>(".ah-revoke")) {
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await deps.api(`/apple-health/connections/${button.dataset.connectionId}`, { method: "DELETE" });
            deps.toast("Apple Health connection revoked");
            await loadAppleHealth();
          } catch {
            button.disabled = false;
            await loadAppleHealth("Could not revoke that connection.");
          }
        });
      }
      const connect = settingsSourcesAutomationOptional<HTMLButtonElement>(card, "#ahConnect");
      if (connect)
        connect.addEventListener("click", async () => {
          connect.disabled = true;
          connect.textContent = "Preparing…";
          try {
            const pairing = appleHealthStateRecord(
              await deps.api("/apple-health/pairings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label: "Apple Health Shortcut", shortcut_version: "1" }),
              })
            );
            const config = appleHealthStateRecord(await deps.api("/apple-health/config"));
            if (typeof pairing.code !== "string" || typeof config.shortcut_name !== "string")
              throw new Error("pairing unavailable");
            const beforeRaw = appleHealthStateRecord(await deps.api("/apple-health/connections"));
            const beforeIds = new Set(
              (Array.isArray(beforeRaw.connections) ? beforeRaw.connections : [])
                .map((connection) => appleHealthStateRecord(connection).id)
                .filter((id): id is number => typeof id === "number")
            );
            const link = appleHealthRunLink(config.shortcut_name, origin, pairing.code);
            if (deps.openUrl) deps.openUrl(link);
            else location.href = link;
            connect.textContent = "Waiting for Shortcut…";

            const wait = deps.setTimeout ?? setTimeout;
            let attempts = 0;
            const poll = async (): Promise<void> => {
              attempts += 1;
              try {
                const raw = appleHealthStateRecord(await deps.api("/apple-health/connections"));
                const connections = Array.isArray(raw.connections) ? raw.connections : [];
                const connected = connections.some((value) => {
                  const connection = appleHealthStateRecord(value);
                  return connection.status === "connected" &&
                    typeof connection.id === "number" &&
                    !beforeIds.has(connection.id) &&
                    typeof connection.last_used_at === "string" &&
                    connection.last_used_at.length > 0;
                });
                if (connected) {
                  deps.toast("Apple Health connected");
                  await loadAppleHealth();
                  return;
                }
              } catch {}
              if (!card.isConnected) return;
              if (attempts >= 8) {
                await loadAppleHealth("The Shortcut did not connect yet. Run it again, then retry or refresh status.");
                return;
              }
              wait(() => void poll(), 2000);
            };
            wait(() => void poll(), 1000);
          } catch {
            await loadAppleHealth("Could not start pairing. Check this instance's authentication and try again.");
          }
        });
    };

    await loadAppleHealth();
  }

  function renderSettingsAutomation(deps: ClientSettingsSourcesAutomationControllerDeps): void {
    const wm = deps.workingModel;
    const researchEligible = CairnSettingsSurface.routeEligible(deps.data);
    deps.root.innerHTML = CairnSettingsSurface.automationSliceHtml({
      workingModel: wm,
      settings: deps.settings,
      artSpendHtml: deps.artSpendHtml,
      researchEligible,
    });

    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#enrichEnabled").addEventListener(
      "change",
      (event) => {
        wm.enrich_enabled = settingsSourcesAutomationInput(event).checked;
      }
    );
    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#artEnabled").addEventListener(
      "change",
      (event) => {
        wm.art_enabled = settingsSourcesAutomationInput(event).checked;
      }
    );
    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#researchEnabled").addEventListener(
      "change",
      (event) => {
        wm.research_enabled = settingsSourcesAutomationInput(event).checked;
      }
    );
    settingsSourcesAutomationRequired<HTMLSelectElement>(deps.root, "#leadMode").addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      wm.lead_mode = (
        ["lead", "announce_first", "review_everything"].includes(value) ? value : "lead"
      ) as SettingsScreenWorkingModel["lead_mode"];
    });
    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#geminiApiKey").addEventListener(
      "input",
      (event) => {
        wm.gemini_api_key = settingsSourcesAutomationInput(event).value;
      }
    );
  }

  const CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER = {
    appleHealthShortcutRecipe,
    appleHealthRunLink,
    renderSources: renderSettingsSources,
    renderAutomation: renderSettingsAutomation,
  };

  Object.assign(globalThis, { CairnSettingsSourcesAutomationController: CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnSettingsSourcesAutomationController = CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER;
  }
}
