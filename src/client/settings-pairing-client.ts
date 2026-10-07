// @ts-check
// Settings -> Devices: who can open this Cairn. The card shows only when the server
// requires sign-in (CAIRN_AUTH_TOKEN); an open instance gets one line saying why there
// is nothing to pair. Its own Settings tab (and a row on the You landing) so a phone's
// way in is never buried under exports and updates.
//
//   - Pair a device: mints a ONE-TIME code (POST /api/auth/pairing-codes, ten minutes,
//     works once) and shows it as a QR of `${origin}/#pair=<CODE>` plus the code in
//     text with a countdown. The code rides the URL FRAGMENT, which never reaches a
//     server log or a Referer; index.html's boot script exchanges it for that device's
//     own session cookie. The access token itself is never shown or encoded.
//   - Devices: every signed-in browser, this one marked, last seen in words; rename,
//     sign out, "Sign out other devices". Signing THIS device out (or the last one)
//     asks first and names the ways back in.
//   - Passkeys: add one for this device, list, remove (the WebAuthn ceremony is the
//     lazy "auth" bundle's CairnPasskeys, injected on the tap).
//   - Recovery: one line on where the access token lives.
//   - Calendar: "Reset calendar link" retires the plan.ics feed token a subscribed
//     calendar carries (DELETE /api/auth/calendar-link).
//
// The QR encoder is vendored (public/vendor/qrcode.js, MIT) and loaded on the first
// "Show pairing code"; the grid is drawn with DOM calls, never a markup string.

type SettingsAccessApi = (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;

type SettingsPairingWireDeps = {
  root: ParentNode;
  api: SettingsAccessApi;
  origin: string;
  document?: Document;
  loadQr?: () => Promise<SettingsPairingQrFactory>;
  now?: () => number;
  relTime?: (iso: string) => string;
  toast?: (message: string) => void;
  reload?: () => void;
  passkeys?: {
    supported(): boolean;
    add(name?: string): Promise<{ ok: boolean; reason?: string }>;
  };
  confirm?: (opts: { title: string; body: string; action: string }) => Promise<boolean>;
};

function wireAccessCard(deps: SettingsPairingWireDeps): void {
  const doc = deps.document || (typeof document !== "undefined" ? document : null);
  const card = deps.root.querySelector<HTMLElement>("#accessCard");
  if (!doc || !card) return;
  const now = deps.now || (() => Date.now());
  // "Dates read human" (date-utils relTime) unless the caller hands its own.
  const seenWhen = deps.relTime || ((iso: string) => (typeof relTime === "function" ? relTime(iso) : iso.slice(0, 10)));
  const say = deps.toast || ((message: string) => (typeof toast === "function" ? toast(message) : undefined));
  const reload = deps.reload || (() => location.reload());
  const confirm = deps.confirm || defaultConfirm;
  // The ceremony lives in the lazy "auth" bundle, injected only on "Add a passkey".
  const passkeys = deps.passkeys || {
    supported: () => {
      try {
        return (
          window.isSecureContext === true &&
          typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential === "function"
        );
      } catch {
        return false;
      }
    },
    add: async (name?: string): Promise<{ ok: boolean; reason?: string }> => {
      try {
        await ensureBundle("auth");
        return typeof CairnPasskeys !== "undefined"
          ? await CairnPasskeys.addPasskey(name)
          : { ok: false, reason: "failed" };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
  };

  let devices: SettingsAccessDevice[] = [];
  let othersRemovePasskeys: unknown = [];
  let othersDisconnectApps: unknown = [];

  const refresh = async (): Promise<void> => {
    const [devBody, keyBody] = await Promise.all([
      deps.api("/auth/devices").catch(() => null),
      deps.api("/auth/passkeys").catch(() => null),
    ]);
    if (!card.isConnected && !deps.document) return;
    devices = accessDevices(devBody);
    othersRemovePasskeys = accessRecord(devBody)?.revoke_others_removes_passkeys ?? [];
    othersDisconnectApps = accessRecord(devBody)?.revoke_others_disconnects_apps ?? [];
    const keys = accessPasskeys(keyBody);
    const devList = card.querySelector<HTMLElement>("[data-access-devices]");
    if (devList) {
      devList.innerHTML = devices.length
        ? devices.map((d) => deviceRowHtml(d, seenWhen)).join("")
        : `<li class="sess-line access-muted">No device is signed in with a session yet.</li>`;
    }
    const others = card.querySelector<HTMLElement>("[data-access-revoke-others]");
    if (others) others.hidden = !devices.some((d) => !d.current) || !devices.some((d) => d.current);
    const keyList = card.querySelector<HTMLElement>("[data-access-passkeys]");
    if (keyList) {
      keyList.innerHTML = keys.length
        ? keys.map(passkeyRowHtml).join("")
        : `<li class="sess-line access-muted">No passkeys yet.</li>`;
    }
    const current = devices.find((d) => d.current);
    const add = card.querySelector<HTMLElement>("[data-access-add-passkey]");
    const note = card.querySelector<HTMLElement>("[data-access-passkey-note]");
    const supported = passkeys.supported();
    if (add) add.hidden = !supported || !current || current.has_passkey;
    if (note) note.hidden = supported;
  };

  deps
    .api("/health")
    .then((health) => {
      if (accessRecord(health)?.auth_required) {
        card.hidden = false;
        return refresh();
      }
      const off = deps.root.querySelector<HTMLElement>("[data-access-off]");
      if (off && accessRecord(health)) off.hidden = false;
    })
    .catch(() => {});

  // ---- Pair a device ----
  const show = card.querySelector<HTMLButtonElement>("[data-pair-show]");
  const hide = card.querySelector<HTMLButtonElement>("[data-pair-hide]");
  const reveal = card.querySelector<HTMLElement>(".pair-reveal");
  const slot = card.querySelector<HTMLElement>(".pair-qr");
  const codeEl = card.querySelector<HTMLElement>(".pair-code");
  const expiry = card.querySelector<HTMLElement>(".pair-expiry");
  const err = card.querySelector<HTMLElement>(".pair-err");
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const clearCode = (): void => {
    stopTimer();
    slot?.replaceChildren();
    if (codeEl) codeEl.textContent = "";
    if (expiry) expiry.textContent = "";
    if (reveal) reveal.hidden = true;
    if (show) {
      show.hidden = false;
      show.textContent = "Show pairing code";
    }
  };

  if (show && hide && reveal && slot && codeEl && expiry && err) {
    show.addEventListener("click", async () => {
      show.disabled = true;
      err.hidden = true;
      try {
        const minted = accessRecord(await deps.api("/auth/pairing-codes", { method: "POST" }));
        const code = typeof minted?.code === "string" ? minted.code : "";
        const expiresAt = Date.parse(String(minted?.expires_at || ""));
        if (!code || !Number.isFinite(expiresAt)) throw new Error("no code");
        const factory = await (deps.loadQr || (() => settingsPairingLoadQr(doc)))();
        const qr = factory(0, "M");
        qr.addData(pairingUrl(deps.origin, code));
        qr.make();
        if (!card.isConnected && !deps.document) return;
        slot.replaceChildren(pairingQrSvg(doc, qr));
        codeEl.textContent = code;
        reveal.hidden = false;
        show.hidden = true;
        const tick = (): void => {
          const left = expiresAt - now();
          if (left <= 0) {
            clearCode();
            show.textContent = "Make a new code";
            err.textContent = "That code expired. Make a new one when the other device is ready.";
            err.hidden = false;
            return;
          }
          expiry.textContent = `Works once · expires in ${pairingCountdown(left)}`;
        };
        tick();
        stopTimer();
        timer = setInterval(() => {
          if (!card.isConnected) return stopTimer();
          tick();
        }, 1000);
      } catch {
        err.textContent = "Couldn't make a pairing code. Try again in a moment.";
        err.hidden = false;
      } finally {
        show.disabled = false;
      }
    });
    hide.addEventListener("click", () => {
      clearCode();
      show.focus();
    });
  }

  // ---- devices ----
  card.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return;
    const row = target.closest<HTMLElement>("[data-device-id]");
    const deviceId = row ? Number(row.dataset.deviceId) : NaN;
    const device = devices.find((d) => d.id === deviceId);

    if (target.closest("[data-device-rename]") && row && device) {
      const nameEl = row.querySelector<HTMLElement>(".access-name");
      if (!nameEl || row.querySelector("input")) return;
      nameEl.innerHTML = `<form class="access-rename" data-rename-form><input class="token-sheet-in" maxlength="60" aria-label="Device name" value="${escAttr(device.name)}"><button class="linkbtn-quiet" type="submit">Save</button></form>`;
      const form = nameEl.querySelector<HTMLFormElement>("form");
      const input = nameEl.querySelector<HTMLInputElement>("input");
      input?.focus();
      form?.addEventListener("submit", async (submit) => {
        submit.preventDefault();
        const name = (input?.value || "").trim();
        if (name && name !== device.name) {
          await deps
            .api(`/auth/devices/${device.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            })
            .catch(() => null);
        }
        await refresh();
      });
      return;
    }

    if (target.closest("[data-device-revoke]") && device) {
      const last = devices.length === 1;
      const removes = device.current
        ? ""
        : [passkeysRemovedHtml(device.revoke_removes_passkeys), appsDisconnectedHtml(device.revoke_disconnects_apps)]
            .filter(Boolean)
            .join(" ");
      if (device.current || last || removes) {
        const title = device.current
          ? "Sign out this device?"
          : last
            ? "Sign out the last device?"
            : `Sign out ${device.name}?`;
        const waysBack = device.current || last ? waysBackInHtml(device.current && device.has_passkey) : "";
        const ok = await confirm({ title, body: [removes, waysBack].filter(Boolean).join(" "), action: "Sign out" });
        if (!ok) return;
      }
      const result = accessRecord(await deps.api(`/auth/devices/${device.id}`, { method: "DELETE" }).catch(() => null));
      if (result?.signed_out) return reload();
      if (result?.ok) say(`Signed out ${device.name}.`);
      await refresh();
      return;
    }

    if (target.closest("[data-access-revoke-others]")) {
      // Every passkey not tied to this device goes too — unbound ones included — so the
      // sheet names them before anything is removed.
      const ok = await confirm({
        title: "Sign out every other device?",
        body: [
          "Every device but this one is signed out.",
          passkeysRemovedHtml(othersRemovePasskeys) ||
            "Any passkey not tied to this device is removed too; this device's own passkey stays.",
          appsDisconnectedHtml(othersDisconnectApps),
        ]
          .filter(Boolean)
          .join(" "),
        action: "Sign out others",
      });
      if (!ok) return;
      const result = accessRecord(await deps.api("/auth/devices/revoke-others", { method: "POST" }).catch(() => null));
      if (result?.ok) say("Every other device is signed out. Connected AI apps keep their own access.");
      await refresh();
      return;
    }

    if (target.closest("[data-access-calendar-reset]")) {
      const ok = await confirm({
        title: "Reset the calendar link?",
        body: "Calendars subscribed to your plan stop updating. Subscribe again from Train → Plan to get a new link.",
        action: "Reset link",
      });
      if (!ok) return;
      const result = accessRecord(await deps.api("/auth/calendar-link", { method: "DELETE" }).catch(() => null));
      say(result?.ok ? "Calendar link reset." : "Couldn't reset the calendar link. Try again in a moment.");
      return;
    }

    const keyRow = target.closest<HTMLElement>("[data-passkey-id]");
    if (target.closest("[data-passkey-remove]") && keyRow) {
      const result = accessRecord(
        await deps.api(`/auth/passkeys/${Number(keyRow.dataset.passkeyId)}`, { method: "DELETE" }).catch(() => null)
      );
      if (result?.ok) say("Passkey removed.");
      await refresh();
      return;
    }

    const addBtn = target.closest<HTMLButtonElement>("[data-access-add-passkey]");
    if (addBtn) {
      addBtn.disabled = true;
      const result = await passkeys.add(devices.find((d) => d.current)?.name);
      addBtn.disabled = false;
      if (result.ok) say("Passkey added. This device can sign back in with it.");
      else if (result.reason !== "cancelled") say("Couldn't add the passkey. Try again in a moment.");
      await refresh();
    }
  });
}

const CAIRN_SETTINGS_PAIRING = {
  pairingUrl,
  pairingCountdown,
  accessCardHtml,
  devicesSliceHtml,
  pairingQrSvg,
  waysBackInHtml,
  wireAccessCard,
};

Object.assign(globalThis, { CairnSettingsPairing: CAIRN_SETTINGS_PAIRING });
