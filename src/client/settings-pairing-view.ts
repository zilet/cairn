// @ts-check
// The pure half of Settings -> Devices (settings-pairing-client.ts wires it): the card's
// markup, the QR encoder loader and SVG drawing, the device / passkey rows and the
// confirm copy. Nothing here touches the network; every string rendered into markup is
// escaped. Loads right before settings-pairing-client.ts in the settings bundle.

type SettingsPairingQr = {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};

type SettingsPairingQrFactory = (typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H") => SettingsPairingQr;

type SettingsAccessDevice = {
  id: number;
  name: string;
  user_agent_summary: string | null;
  last_seen_at: string;
  current: boolean;
  has_passkey: boolean;
  /** The passkeys signing this device out also removes (bound to it, added or last used by it). */
  revoke_removes_passkeys?: Array<{ id: number; name: string }>;
  /** The AI apps (MCP keys and sign-ins) this device made or approved — signed out with it. */
  revoke_disconnects_apps?: Array<{ id: number; name: string }>;
};

type SettingsAccessPasskey = { id: number; name: string; this_device: boolean; created_at: string };

const SETTINGS_PAIRING_QR_SRC = "/vendor/qrcode.js";
const SETTINGS_PAIRING_QUIET_ZONE = 4;
let settingsPairingQrLoad: Promise<SettingsPairingQrFactory> | null = null;

function pairingUrl(origin: string, code: string): string {
  return `${String(origin || "").replace(/\/+$/, "")}/#pair=${encodeURIComponent(code)}`;
}

/** "9:41" for the seconds left; "0:00" once spent. */
function pairingCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function accessCardHtml(): string {
  return `<div id="accessCard" class="access-card" hidden>
        <div id="pairCard" class="sess pair-card">
          <h2 class="lbl pair-h">Pair a device</h2>
          <div class="sess-line">Point your phone's camera at the code — or open the link on a laptop — to sign it in. No password to type.</div>
          <button class="ghostbtn pair-show" type="button" data-pair-show>Show pairing code</button>
          <div class="pair-reveal" hidden>
            <div class="pair-qr" role="img" aria-label="Pairing code for this Cairn"></div>
            <div class="pair-code" aria-live="polite"></div>
            <div class="small-note pair-expiry"></div>
            <button class="linkbtn-quiet pair-hide" type="button" data-pair-hide>Hide code</button>
          </div>
          <div class="sess-line pair-err" role="alert" hidden></div>
        </div>
        <div class="sess access-devices">
          <h2 class="lbl pair-h">Signed in</h2>
          <ul class="access-list" data-access-devices><li class="sess-line access-muted">Checking…</li></ul>
          <button class="ghostbtn access-wide" type="button" data-access-revoke-others hidden>Sign out other devices</button>
        </div>
        <div class="sess access-passkeys">
          <h2 class="lbl pair-h">Passkeys</h2>
          <ul class="access-list" data-access-passkeys></ul>
          <button class="ghostbtn access-wide" type="button" data-access-add-passkey hidden>Add a passkey for this device</button>
          <div class="sess-line access-muted" data-access-passkey-note hidden>Passkeys need a secure (https) address.</div>
        </div>
        <div class="sess-line access-muted access-recovery">Recovery: if you lose every device, sign in with your access token (CAIRN_AUTH_TOKEN) — it lives in your host's settings (Railway → Variables, or the .env next to your install).</div>
        <div class="sess-line access-muted access-calendar">A calendar subscribed to your plan (Train → Plan → Subscribe) keeps its own read-only link. <button class="linkbtn-quiet" type="button" data-access-calendar-reset>Reset calendar link</button></div>
      </div>`;
}

/** The whole Settings -> Devices slice: an intro, the open-instance line, the card. */
function devicesSliceHtml(): string {
  return `<section class="set-group set-group--flush">
        <p class="set-group-sub">Sign a phone or laptop in, see every device that is signed in, and keep a passkey for the quick way back.</p>
        <div class="sess-line access-muted access-off" data-access-off hidden>Sign-in is off on this Cairn, so any browser that can reach it opens it and there is nothing to pair. To sign devices in one by one — pairing codes, passkeys, signing out a lost phone — set CAIRN_AUTH_TOKEN on the host.</div>
        ${accessCardHtml()}
      </section>`;
}

function settingsPairingLoadQr(doc: Document): Promise<SettingsPairingQrFactory> {
  const ready = () => (globalThis as { qrcode?: SettingsPairingQrFactory }).qrcode;
  if (ready()) return Promise.resolve(ready() as SettingsPairingQrFactory);
  if (settingsPairingQrLoad) return settingsPairingQrLoad;
  settingsPairingQrLoad = new Promise<SettingsPairingQrFactory>((resolve, reject) => {
    const el = doc.createElement("script");
    el.src = SETTINGS_PAIRING_QR_SRC;
    el.async = true;
    el.addEventListener("load", () => {
      const factory = ready();
      if (factory) resolve(factory);
      else reject(new Error("qr encoder missing"));
    });
    el.addEventListener("error", () => reject(new Error("qr encoder failed to load")));
    doc.head.appendChild(el);
  }).catch((error) => {
    settingsPairingQrLoad = null; // a later tap may try again
    throw error;
  });
  return settingsPairingQrLoad;
}

// The module grid as one SVG path: one unit square per dark module, a four-module
// quiet zone, crisp edges at any size.
function pairingQrSvg(doc: Document, qr: SettingsPairingQr): SVGSVGElement {
  const count = qr.getModuleCount();
  const size = count + SETTINGS_PAIRING_QUIET_ZONE * 2;
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col))
        d += `M${col + SETTINGS_PAIRING_QUIET_ZONE} ${row + SETTINGS_PAIRING_QUIET_ZONE}h1v1h-1z`;
    }
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const ground = doc.createElementNS(ns, "rect");
  ground.setAttribute("class", "pair-qr-ground");
  ground.setAttribute("width", String(size));
  ground.setAttribute("height", String(size));
  const marks = doc.createElementNS(ns, "path");
  marks.setAttribute("class", "pair-qr-ink");
  marks.setAttribute("d", d);
  svg.append(ground, marks);
  return svg;
}

function accessRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function accessDevices(body: unknown): SettingsAccessDevice[] {
  const list = accessRecord(body)?.devices;
  return Array.isArray(list) ? (list.filter((d) => accessRecord(d)) as SettingsAccessDevice[]) : [];
}

function accessPasskeys(body: unknown): SettingsAccessPasskey[] {
  const list = accessRecord(body)?.passkeys;
  return Array.isArray(list) ? (list.filter((d) => accessRecord(d)) as SettingsAccessPasskey[]) : [];
}

function deviceRowHtml(device: SettingsAccessDevice, relTime: (iso: string) => string): string {
  const seen = device.current ? "Using now" : `Last seen ${relTime(device.last_seen_at)}`;
  // The label starts as the browser summary; say it again only once renamed.
  const what =
    device.user_agent_summary && device.user_agent_summary !== device.name ? `${device.user_agent_summary} · ` : "";
  return `<li class="access-row" data-device-id="${escAttr(device.id)}">
      <div class="access-main">
        <div class="access-name">${escHtml(device.name)}${device.current ? ` <span class="access-tag">This device</span>` : ""}</div>
        <div class="access-meta">${escHtml(what + seen)}</div>
      </div>
      <div class="access-actions">
        <button class="linkbtn-quiet" type="button" data-device-rename>Rename</button>
        <button class="linkbtn-quiet" type="button" data-device-revoke>Sign out</button>
      </div>
    </li>`;
}

function passkeyRowHtml(passkey: SettingsAccessPasskey): string {
  return `<li class="access-row" data-passkey-id="${escAttr(passkey.id)}">
      <div class="access-main">
        <div class="access-name">${escHtml(passkey.name)}${passkey.this_device ? ` <span class="access-tag">This device</span>` : ""}</div>
      </div>
      <div class="access-actions"><button class="linkbtn-quiet" type="button" data-passkey-remove>Remove</button></div>
    </li>`;
}

/** The ways back in after THIS device signs out — never a vague "you may lose access". */
/** "It also removes this passkey…: A, B." — every name escaped; "" when there are none. */
function passkeysRemovedHtml(list: unknown): string {
  const names = (Array.isArray(list) ? list : []).map((p) => String(accessRecord(p)?.name ?? "")).filter(Boolean);
  if (!names.length) return "";
  const what = names.length === 1 ? "this passkey, so it" : "these passkeys, so they";
  return `It also removes ${what} can't sign anything in again: ${names.map((n) => `<b>${escHtml(n)}</b>`).join(", ")}.`;
}

function appsDisconnectedHtml(list: unknown): string {
  const names = (Array.isArray(list) ? list : []).map((a) => String(accessRecord(a)?.name ?? "")).filter(Boolean);
  if (!names.length) return "";
  return `It also disconnects the AI ${names.length === 1 ? "app" : "apps"} it connected: ${names.map((n) => `<b>${escHtml(n)}</b>`).join(", ")}.`;
}

function waysBackInHtml(hasPasskey: boolean): string {
  const ways = [
    hasPasskey ? "this device's passkey" : "",
    "a pairing code from another signed-in device",
    "your access token (CAIRN_AUTH_TOKEN in your host's settings)",
  ].filter(Boolean);
  return `To sign back in, use ${ways.map((w) => escHtml(w)).join(", or ")}.`;
}

function defaultConfirm(opts: { title: string; body: string; action: string }): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof CairnUiSheet === "undefined") return resolve(false);
    let answered = false;
    const sheet = CairnUiSheet.open({
      overlayClass: "token-sheet-ov",
      sheetClass: "token-sheet",
      labelledBy: "accessConfirmTitle",
      html: `<h2 class="token-sheet-h" id="accessConfirmTitle">${escHtml(opts.title)}</h2>
        <p class="token-sheet-p">${opts.body}</p>
        <div class="token-sheet-ft signin-offer-ft">
          <button class="linkbtn-quiet" type="button" data-ui-sheet-close>Cancel</button>
          <button class="token-sheet-btn" type="button" data-access-confirm>${escHtml(opts.action)}</button>
        </div>`,
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    sheet.sheet.querySelector("[data-access-confirm]")?.addEventListener("click", () => {
      answered = true;
      resolve(true);
      sheet.close();
    });
  });
}

// Each source file is built as its own closure, so the client module that wires these reads
// them off the global scope at call time.
Object.assign(globalThis, {
  pairingUrl,
  pairingCountdown,
  accessCardHtml,
  devicesSliceHtml,
  settingsPairingLoadQr,
  pairingQrSvg,
  accessRecord,
  accessDevices,
  accessPasskeys,
  deviceRowHtml,
  passkeyRowHtml,
  passkeysRemovedHtml,
  appsDisconnectedHtml,
  waysBackInHtml,
  defaultConfirm,
});
