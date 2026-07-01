// @ts-check
// Settings -> Data controller: update checks, exports, setup reset, and phone access wiring.

type SettingsDataControllerWorkingModel = {
  update_check_enabled: boolean;
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
  reload(): void;
  inStandaloneApp?: boolean;
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
        <label class="toggle" style="margin-top:12px"><input type="checkbox" id="updateCheckEnabled" ${wm.update_check_enabled ? "checked" : ""}>
          <span>Check for new Cairn releases</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">A quiet daily check against the public GitHub Releases page — pull, never a notification. It sends nothing but an anonymous request; no data leaves your instance. Off keeps Cairn fully offline.</div>
        <button id="updateCheckNow" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:10px;${wm.update_check_enabled ? "" : "display:none"}">Check now</button>

        <h1 class="lbl" style="margin:22px 0 8px">Data &amp; backup</h1>
        <button id="dlJson" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Download JSON backup</button>
        <button id="dlDb" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Download SQLite snapshot</button>

        <h1 class="lbl" style="margin:22px 0 8px">Setup</h1>
        <button id="rerunSetup" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Re-run first-time setup</button>
      </section>`;

  CairnSettingsData.wirePhoneAccessCard({ api: deps.api, toast: deps.toast });

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

  settingsDataRequired<HTMLButtonElement>(deps, "#dlJson").addEventListener("click", () => {
    deps.downloadFile(deps.withToken("/api/export"));
  });
  settingsDataRequired<HTMLButtonElement>(deps, "#dlDb").addEventListener("click", () => {
    deps.downloadFile(deps.withToken("/api/export/db"));
  });
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

const CAIRN_SETTINGS_DATA_CONTROLLER = {
  render: renderSettingsData,
};

Object.assign(globalThis, { CairnSettingsDataController: CAIRN_SETTINGS_DATA_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnSettingsDataController = CAIRN_SETTINGS_DATA_CONTROLLER;
}
