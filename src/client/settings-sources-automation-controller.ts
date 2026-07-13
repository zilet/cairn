// @ts-check
// Settings -> Sources/Automation controller: input sources, connector sync, and background toggles.
{
function settingsSourcesAutomationRequired<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing Settings Sources/Automation element: ${selector}`);
  return el;
}

function settingsSourcesAutomationOptional<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function settingsSourcesAutomationInput(event: Event): HTMLInputElement {
  return event.currentTarget as HTMLInputElement;
}

function appleHealthShortcutRecipe(origin: string, token = ""): string {
  const endpoint = origin.replace(/\/$/, "") + "/api/health-metrics";
  const auth = token.trim()
    ? `Authorization header\nName: Authorization\nValue: Bearer ${token.trim()}`
    : "Authorization header\nNone — this Cairn browser session has no shared token.";
  return `Cairn Apple Health Shortcut build sheet

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
   ${auth.replace(/\n/g, "\n   ")}
6. Read the response Dictionary. If ok is true, Show Notification "Cairn updated". Otherwise Show Alert with errors. A connection failure can be retried by running the shortcut again; source+date upsert makes repeats safe.
7. Run once and approve the requested Health permissions. Optionally create a Time of Day personal automation that runs this shortcut.

Apple requires the shortcut actions and Health permissions to be reviewed on your device. Cairn cannot generate or sign a validated .shortcut file.`;
}

function renderSettingsSources(deps: ClientSettingsSourcesAutomationControllerDeps): void {
  const wm = deps.workingModel;
  deps.root.innerHTML = CairnSettingsSurface.sourcesSliceHtml({
    workingModel: wm,
    settings: deps.settings,
    garminStatusHtml: deps.garminStatusLine(deps.settings, false),
  });

  settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#garminUsername").addEventListener("input", (event) => {
    wm.garmin_username = settingsSourcesAutomationInput(event).value;
  });
  settingsSourcesAutomationRequired<HTMLInputElement>(deps.root, "#garminPassword").addEventListener("input", (event) => {
    wm.garmin_password = settingsSourcesAutomationInput(event).value;
  });

  // Manual Garmin sync: pulse while the connector runs, then re-pull /settings so the
  // status line shows exactly what the server recorded.
  settingsSourcesAutomationRequired<HTMLButtonElement>(deps.root, "#garminSyncBtn").addEventListener("click", async () => {
    const btn = settingsSourcesAutomationRequired<HTMLButtonElement>(deps.root, "#garminSyncBtn");
    const status = settingsSourcesAutomationRequired<HTMLElement>(deps.root, "#garminStatus");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    status.innerHTML = deps.garminStatusLine(null, true);
    let result: SettingsScreenGarminSyncResponse | null = null;
    try {
      result = await deps.api("/garmin/sync", { method: "POST" }) as SettingsScreenGarminSyncResponse;
    } catch {}
    let fresh: unknown = deps.settings;
    try {
      fresh = CairnSettingsSurface.settingsData(await deps.api("/settings")).settings;
    } catch {}
    if (!btn.isConnected) return; // slice/tab swapped while we waited
    status.innerHTML = deps.garminStatusLine(fresh, false);
    btn.disabled = false;
    btn.textContent = "Sync now";
    deps.toast(result && result.ok ? `Garmin synced · ${result.activities} activit${result.activities === 1 ? "y" : "ies"}` : "Garmin sync failed");
  });

  // Apple Health: page-origin POST URL + one-tap copy.
  const origin = deps.locationOrigin ?? location.origin;
  const ahUrl = settingsSourcesAutomationOptional<HTMLElement>(deps.root, "#ahUrl");
  if (ahUrl) ahUrl.textContent = origin + "/api/health-metrics";
  const ahCopy = settingsSourcesAutomationOptional<HTMLButtonElement>(deps.root, "#ahUrlCopy");
  if (ahCopy) ahCopy.addEventListener("click", async () => {
    const url = origin + "/api/health-metrics";
    try {
      const clipboard = deps.clipboard ?? navigator.clipboard;
      await clipboard.writeText(url);
      ahCopy.textContent = "Copied";
    } catch {
      ahCopy.textContent = "Copy failed";
    }
    (deps.setTimeout ?? setTimeout)(() => { ahCopy.textContent = "Copy"; }, 1600);
  });
  const recipeCopy = settingsSourcesAutomationOptional<HTMLButtonElement>(deps.root, "#ahRecipeCopy");
  if (recipeCopy) recipeCopy.addEventListener("click", async () => {
    const token = deps.authToken?.() ?? "";
    try {
      const clipboard = deps.clipboard ?? navigator.clipboard;
      await clipboard.writeText(appleHealthShortcutRecipe(origin, token));
      recipeCopy.textContent = "Build sheet copied";
    } catch {
      recipeCopy.textContent = "Copy failed";
    }
    (deps.setTimeout ?? setTimeout)(() => { recipeCopy.textContent = "Copy build sheet"; }, 2000);
  });
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
  renderSources: renderSettingsSources,
  renderAutomation: renderSettingsAutomation,
};

Object.assign(globalThis, { CairnSettingsSourcesAutomationController: CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnSettingsSourcesAutomationController = CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER;
}
}
