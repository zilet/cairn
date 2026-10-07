// @ts-check
// Settings -> Data controller: update checks, exports, setup reset, and phone access
// wiring — plus the Settings -> Devices slice (renderDevices), which shares its deps.

type SettingsDataControllerWorkingModel = {
  update_check_enabled: boolean;
  usage_ping_enabled: boolean;
};

type SettingsDataControllerDeps = {
  root: ParentNode;
  workingModel: SettingsDataControllerWorkingModel;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  toast(message: string): void;
  markDirty(): void;
  updateCardHtml(status: unknown): string;
  withToken(path: string): string;
  downloadFile(path: string): void;
  /** Injected in tests; the browser build uses api-core's openResourceLink (a signed link). */
  openResourceLink?: (path: string, mode?: "tab" | "download") => Promise<void>;
  reload(): void;
  inStandaloneApp?: boolean;
  /** The page origin the pairing code points at; the browser build reads location. */
  origin?: string;
  /** "Dates read human" for the updater line. */
  relTime?: (iso: string) => string;
  /** Injected in tests; the browser build reads its own service worker. */
  appIdentity?: AppIdentityCardDeps;
};

let updateStatusCache: Record<string, unknown> | null = null;

function settingsDataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function settingsDataRequired<T extends Element = HTMLElement>(deps: SettingsDataControllerDeps, selector: string): T {
  const el = deps.root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing Settings Data element: ${selector}`);
  return el;
}

function refreshSettingsDataUpdateCard(deps: SettingsDataControllerDeps): void {
  const el = deps.root.querySelector<HTMLElement>("#updateCard");
  if (el) el.innerHTML = deps.updateCardHtml(updateStatusCache);
  // How releases reach this host + the calm "Update now" (settings-update-client.ts).
  const actions = deps.root.querySelector<HTMLElement>("#updateActions");
  if (!actions || typeof CairnSettingsUpdate === "undefined") return;
  actions.innerHTML = CairnSettingsUpdate.updateActionsHtml(updateStatusCache, { relTime: deps.relTime });
  CairnSettingsUpdate.wireUpdateActions({ host: actions, api: deps.api, toast: deps.toast });
}

// The browser's own service worker for the "This app" block.
function settingsDataAppIdentityDeps(deps: SettingsDataControllerDeps): AppIdentityCardDeps {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  return {
    api: (path) => deps.api(path),
    workerShell: () => (nav ? CairnAppIdentityController.workerShell(nav) : Promise.resolve("")),
  };
}

function renderSettingsData(deps: SettingsDataControllerDeps): void {
  const wm = deps.workingModel;
  const root = deps.root as HTMLElement;
  root.innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Keep an offline copy of everything, check for new versions, or start the first-time setup over.</p>
        ${CairnSettingsData.phoneAccessCardHtml({ inStandaloneApp: deps.inStandaloneApp })}

        <h1 class="lbl" style="margin:14px 0 8px">Cairn version</h1>
        <div id="updateCard" class="sess">${deps.updateCardHtml(updateStatusCache)}</div>
        <div id="updateActions" class="upd-actions"></div>
        <label class="toggle" style="margin-top:12px"><input type="checkbox" id="updateCheckEnabled" ${wm.update_check_enabled ? "checked" : ""}>
          <span>Check for new Cairn releases</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">A quiet daily check against the public GitHub Releases page — pull, never a notification. It sends nothing but an anonymous request; no data leaves your instance. Off keeps Cairn fully offline.</div>
        <button id="updateCheckNow" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:10px;${wm.update_check_enabled ? "" : "display:none"}">Check now</button>
        <div id="appIdentityCard" class="sess app-id-card"></div>

        <h1 class="lbl" style="margin:22px 0 8px">Data &amp; backup</h1>
        <button id="dlJson" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Download JSON backup</button>
        <button id="dlDb" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Download SQLite snapshot</button>

        <h1 class="lbl" style="margin:22px 0 8px">Exercise guide</h1>
        <div class="sess-line" id="exGuideStatus" style="color:var(--muted)">Checking…</div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Step-by-step instructions and two demonstration photos per movement, from the public-domain free-exercise-db dataset — about 1 MB from raw.githubusercontent.com, stored locally; photos are fetched per exercise on first view. Only unambiguous name matches are attached — the rest stay unlinked rather than showing you the wrong lift.</div>
        <button id="exGuideImport" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:10px">Fetch exercise guide</button>

        <h1 class="lbl setdata-h">Feedback &amp; privacy</h1>
        <button id="feedbackOpen" class="ghostbtn setdata-btn" type="button">Send feedback</button>
        <label class="toggle setdata-toggle"><input type="checkbox" id="usagePingEnabled" ${wm.usage_ping_enabled ? "checked" : ""}>
          <span>Share anonymous usage</span></label>
        <div class="sess-line setdata-muted">Once a week, Cairn sends a random install id, its version, the host platform, CPU architecture and Node version — nothing about you or your data. Off by default, and only sent when this build has a feedback service.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Setup</h1>
        <button id="rerunSetup" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Re-run first-time setup</button>
      </section>`;

  const appIdentityHost = deps.root.querySelector<HTMLElement>("#appIdentityCard");
  if (appIdentityHost && typeof CairnAppIdentityController !== "undefined") {
    CairnAppIdentityController.mountAppCard(appIdentityHost, deps.appIdentity || settingsDataAppIdentityDeps(deps));
  }
  CairnSettingsData.wirePhoneAccessCard({ api: deps.api, toast: deps.toast });
  CairnSettingsData.wireExerciseGuideCard({ root: deps.root, api: deps.api, toast: deps.toast });
  refreshSettingsDataUpdateCard(deps);
  settingsDataRequired<HTMLButtonElement>(deps, "#feedbackOpen").addEventListener("click", () => {
    if (typeof CairnSettingsFeedback !== "undefined") CairnSettingsFeedback.open({ api: deps.api, toast: deps.toast });
  });
  settingsDataRequired<HTMLInputElement>(deps, "#usagePingEnabled").addEventListener("change", (event) => {
    wm.usage_ping_enabled = (event.currentTarget as HTMLInputElement).checked;
    deps.markDirty();
  });

  settingsDataRequired<HTMLInputElement>(deps, "#updateCheckEnabled").addEventListener("change", (event) => {
    wm.update_check_enabled = (event.currentTarget as HTMLInputElement).checked;
    deps.markDirty();
    const btn = deps.root.querySelector<HTMLElement>("#updateCheckNow");
    if (btn) btn.style.display = wm.update_check_enabled ? "" : "none";
    refreshSettingsDataUpdateCard(deps);
  });

  settingsDataRequired<HTMLButtonElement>(deps, "#updateCheckNow").addEventListener("click", async () => {
    const btn = settingsDataRequired<HTMLButtonElement>(deps, "#updateCheckNow");
    btn.disabled = true;
    btn.textContent = "Checking...";
    try {
      updateStatusCache = settingsDataRecord(await deps.api("/update-check", { method: "POST" }));
    } catch {
      // Keep the prior cached status; the card renderer can explain stale/error state.
    }
    if (!btn.isConnected) return;
    refreshSettingsDataUpdateCard(deps);
    btn.disabled = false;
    btn.textContent = "Check now";
  });

  // A download leaves the app (an installed iOS app hands it to Safari, which does not
  // share this app's sign-in), so it rides a short-lived signed link.
  const download = (path: string): void => void (deps.openResourceLink || openResourceLink)(path, "download");
  settingsDataRequired<HTMLButtonElement>(deps, "#dlJson").addEventListener("click", () => download("/api/export"));
  settingsDataRequired<HTMLButtonElement>(deps, "#dlDb").addEventListener("click", () => download("/api/export/db"));
  settingsDataRequired<HTMLButtonElement>(deps, "#rerunSetup").addEventListener("click", async () => {
    await deps.api("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboarded: false }),
    });
    deps.reload();
  });

  if (!updateStatusCache) {
    deps.api("/update-status").then((status) => {
      const next = settingsDataRecord(status);
      if (!next) return;
      updateStatusCache = next;
      refreshSettingsDataUpdateCard(deps);
    }).catch(() => {});
  }
}

// Settings -> Devices: pair a device, every signed-in device, passkeys, the recovery
// line (settings-pairing-client.ts owns the card; this mounts it as its own slice).
function renderSettingsDevices(deps: SettingsDataControllerDeps): void {
  const root = deps.root as HTMLElement;
  if (typeof CairnSettingsPairing === "undefined") {
    root.innerHTML = "";
    return;
  }
  const hasMcp = typeof CairnSettingsMcp !== "undefined";
  root.innerHTML = CairnSettingsPairing.devicesSliceHtml() + (hasMcp ? CairnSettingsMcp.cardHtml() : "");
  // Connected AI apps (settings-mcp-client.ts): MCP keys and signed-in apps, separate from devices.
  if (hasMcp) {
    CairnSettingsMcp.wire({
      root: deps.root,
      api: (path, opts) => deps.api(path, opts),
      origin: deps.origin ?? (typeof location !== "undefined" ? location.origin : ""),
      relTime: deps.relTime,
      toast: deps.toast,
    });
  }
  CairnSettingsPairing.wireAccessCard({
    root: deps.root,
    api: (path, opts) => deps.api(path, opts),
    origin: deps.origin ?? (typeof location !== "undefined" ? location.origin : ""),
    relTime: deps.relTime,
    toast: deps.toast,
    reload: deps.reload,
  });
}

const CAIRN_SETTINGS_DATA_CONTROLLER = {
  render: renderSettingsData,
  renderDevices: renderSettingsDevices,
};

Object.assign(globalThis, { CairnSettingsDataController: CAIRN_SETTINGS_DATA_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnSettingsDataController = CAIRN_SETTINGS_DATA_CONTROLLER;
}
