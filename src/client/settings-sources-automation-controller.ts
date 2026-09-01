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

  function appleHealthRunLink(shortcutName: string, origin: string, pairingCode: string): string {
    const payload = JSON.stringify({
      base_url: origin.replace(/\/$/, ""),
      pairing_code: pairingCode,
    });
    // Percent-encode by hand: URLSearchParams emits form-encoding (space → "+"),
    // and the Shortcuts app takes those pluses literally — "Cairn+Apple+Health+Sync"
    // then fails name lookup on-device.
    const query = `name=${encodeURIComponent(shortcutName)}&input=text&text=${encodeURIComponent(payload)}`;
    return `shortcuts://run-shortcut?${query}`;
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
    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#garminExportStrength").addEventListener(
      "change",
      (event) => {
        wm.garmin_export_strength = settingsSourcesAutomationInput(event).checked;
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

    // Resolved at call time: the date helpers are plain globals from another
    // client script, so a top-level reference would not survive load order.
    const dates = { relTime, absDate };

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
        card.innerHTML = CairnSettingsSurface.appleHealthCardHtml({ config, connections, error, dates });
      } catch {
        if (!card.isConnected) return;
        card.innerHTML = CairnSettingsSurface.appleHealthCardHtml({
          error: error || "Could not load Apple Health connection status.",
          dates,
        });
      }

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
                await loadAppleHealth(
                  "Paired, but no Health data has arrived yet. Open the Shortcuts app and tap the Shortcut once to allow Health access, then tap Refresh status."
                );
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

    // Device-local, and applied on the spot: it never rides the Save button with
    // the server-backed settings around it.
    const wakeLockToggle = settingsSourcesAutomationOptional<HTMLInputElement>(deps.root, "#wakeLockEnabled");
    if (wakeLockToggle && !wakeLockToggle.disabled) {
      wakeLockToggle.addEventListener("change", (event) => {
        if (typeof setWakeLockEnabled === "function") {
          setWakeLockEnabled(settingsSourcesAutomationInput(event).checked);
        }
      });
    }

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
    settingsSourcesAutomationRequired<HTMLSelectElement>(deps.root, "#trainingDrive").addEventListener(
      "change",
      (event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        wm.training_drive = (value === "push" ? "push" : "steady") as SettingsScreenWorkingModel["training_drive"];
      }
    );
    settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#geminiApiKey").addEventListener(
      "input",
      (event) => {
        wm.gemini_api_key = settingsSourcesAutomationInput(event).value;
      }
    );
  }

  const CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER = {
    appleHealthRunLink,
    renderSources: renderSettingsSources,
    renderAutomation: renderSettingsAutomation,
  };

  Object.assign(globalThis, { CairnSettingsSourcesAutomationController: CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnSettingsSourcesAutomationController = CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER;
  }
}
