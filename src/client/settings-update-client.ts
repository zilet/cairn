// @ts-check
// Settings -> Data: how a new release reaches THIS host, and the calm "Update now".
// The server owns the facts (src/hosting.ts via /update-status): the sentence on how
// updates happen here, whether this host can act on a tap, and what the installer's
// updater last reported. This module only frames them; the deploy hook URL never
// reaches the browser.

type SettingsUpdateApi = (
  path: string,
  opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
) => Promise<unknown>;

type SettingsUpdateWireDeps = {
  host: HTMLElement;
  api: SettingsUpdateApi;
  toast?: (message: string) => unknown;
};

type SettingsUpdateHtmlOptions = { relTime?: (iso: string) => string };

function settingsUpdateRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function settingsUpdateWhen(iso: unknown, options: SettingsUpdateHtmlOptions): string {
  const text = typeof iso === "string" ? iso : "";
  if (!text) return "";
  return options.relTime ? options.relTime(text) : "recently";
}

// The trigger-file updater's one line: never reported, quiet for days, or fine.
function settingsUpdaterLine(row: Record<string, unknown>, options: SettingsUpdateHtmlOptions): string {
  if (row.update_method !== "trigger_file") return "";
  const requested = settingsUpdateWhen(row.update_requested_at, options);
  if (requested) return `An update was requested ${escHtml(requested)} — the updater will pick it up shortly.`;
  const updater = settingsUpdateRow(row.updater);
  if (!updater) return "The updater on this machine hasn't reported in yet.";
  const ran = settingsUpdateWhen(updater.last_run, options);
  if (updater.stale) {
    return `The updater last ran ${escHtml(ran || "a while ago")} — more than three days ago. Check that its timer is still enabled.`;
  }
  return ran ? `The updater last checked ${escHtml(ran)}.` : "";
}

function updateActionsHtml(status: unknown, options: SettingsUpdateHtmlOptions = {}): string {
  const row = settingsUpdateRow(status);
  if (!row || typeof row.update_how !== "string") return "";
  const lines = [`<div class="sess-line upd-how">${escHtml(row.update_how)}</div>`];
  if (row.hook_misconfigured) {
    lines.push(
      `<div class="sess-line upd-note">CAIRN_DEPLOY_HOOK_URL is set but isn't an https address, so Cairn ignores it.</div>`
    );
  }
  if (typeof row.update_stale_hint === "string" && row.update_stale_hint) {
    lines.push(`<div class="sess-line upd-note">${escHtml(row.update_stale_hint)}</div>`);
  }
  const updater = settingsUpdaterLine(row, options);
  if (updater) lines.push(`<div class="sess-line upd-note">${updater}</div>`);
  if (row.can_apply && row.update_available && row.latest && !row.update_requested_at) {
    lines.push(
      `<button class="ghostbtn upd-now" type="button" data-update-apply>Update to v${escHtml(String(row.latest))}</button>`
    );
  }
  lines.push(`<div class="sess-line upd-result" role="status" aria-live="polite" hidden></div>`);
  return lines.join("");
}

// One tap, no second confirmation: the host's own redeploy keeps the data volume, and
// the result sentence (good or not) is the server's, shown in place.
function wireUpdateActions(deps: SettingsUpdateWireDeps): void {
  const button = deps.host.querySelector<HTMLButtonElement>("[data-update-apply]");
  const result = deps.host.querySelector<HTMLElement>(".upd-result");
  if (!button || !result) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Starting the update…";
    let body: Record<string, unknown> | null = null;
    try {
      body = settingsUpdateRow(await deps.api("/update/apply", { method: "POST", acceptErrorBody: true }));
    } catch {
      body = null;
    }
    if (!button.isConnected) return;
    const ok = !!body?.ok;
    result.textContent = String(body?.message || "Couldn't start the update. Try again in a moment.");
    result.hidden = false;
    if (ok) {
      button.hidden = true;
      deps.toast?.("Update started");
      return;
    }
    button.disabled = false;
    button.textContent = "Try again";
  });
}

const CAIRN_SETTINGS_UPDATE = {
  updateActionsHtml,
  wireUpdateActions,
};

Object.assign(globalThis, { CairnSettingsUpdate: CAIRN_SETTINGS_UPDATE });
