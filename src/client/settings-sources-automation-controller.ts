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
  renderSources: renderSettingsSources,
  renderAutomation: renderSettingsAutomation,
};

Object.assign(globalThis, { CairnSettingsSourcesAutomationController: CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnSettingsSourcesAutomationController = CAIRN_SETTINGS_SOURCES_AUTOMATION_CONTROLLER;
}
}
