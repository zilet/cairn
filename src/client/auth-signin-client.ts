// @ts-check
// The sign-in screen (lazy "auth" bundle; the eager door is token-sheet.ts). Three
// calm ways in, in this order: a passkey (when this browser can use one and the
// server has any), a one-time pairing code from a device that is already signed in,
// and — folded away as the recovery path — the access token itself.
//
// Every way in ends the same: the server sets this device's HttpOnly session cookie
// and the app reloads signed in. The access token is never stored on the device.
//
// Also here: the one dismissible offer to add a passkey after a sign-in this tab just
// completed, shown once per device and never again after "Not now".

type SignInDeps = {
  doc?: Document;
  fetchHealth?: () => Promise<Record<string, unknown> | null>;
  reload?: () => void;
  standalone?: boolean;
  passkeysSupported?: boolean;
  pairFailed?: boolean;
  retiredLink?: boolean;
};

{
  const OFFER_FLAG = "cairn.auth.offer";
  const OFFER_DISMISSED = "cairn.auth.passkey-offer";

  function inStandaloneApp(): boolean {
    try {
      if (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) return true;
    } catch {}
    try {
      return (navigator as { standalone?: boolean }).standalone === true;
    } catch {
      return false;
    }
  }

  function markOffer(): void {
    try {
      sessionStorage.setItem(OFFER_FLAG, "1");
    } catch {}
  }

  function signInSheetHtml(opts: {
    passkeys: boolean;
    standalone: boolean;
    pairFailed: boolean;
    retiredLink?: boolean;
  }): string {
    const lead = opts.standalone
      ? `<p class="token-sheet-p signin-standalone">Home Screen apps sign in on their own — a passkey or a code from another device does it.</p>`
      : `<p class="token-sheet-p">This Cairn is private. Sign this device in once and it stays signed in.</p>`;
    const passkey = opts.passkeys
      ? `<button class="token-sheet-btn signin-passkey" type="button" data-signin-passkey>Sign in with passkey</button>`
      : "";
    const pairNote = opts.pairFailed
      ? `<p class="signin-note" role="status">That pairing code didn't work — it may have expired or already been used. Make a new one on your other device.</p>`
      : opts.retiredLink
        ? `<p class="signin-note" role="status">That sign-in link is retired — use a pairing code or your access token.</p>`
        : "";
    return `<h2 class="token-sheet-h" id="signinTitle">Sign in to Cairn</h2>
    ${lead}
    ${passkey}
    ${pairNote}
    <form class="signin-block" data-signin-code-form>
      <label class="signin-lbl" for="signinCode">Enter a pairing code</label>
      <p class="token-sheet-hint">On a device that&rsquo;s already signed in, open Settings → Devices → Pair a device.</p>
      <div class="signin-row">
        <input class="token-sheet-in signin-code" id="signinCode" name="code" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX">
        <button class="token-sheet-btn" type="submit">Sign in</button>
      </div>
    </form>
    <details class="signin-recovery">
      <summary>Use your access token</summary>
      <p class="token-sheet-hint">The token is CAIRN_AUTH_TOKEN in your host's settings (Railway → Variables, or the .env next to your install). It signs this device in; it isn't kept on the device.</p>
      <form class="signin-row" data-signin-token-form>
        <input class="token-sheet-in" name="token" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Access token" placeholder="Access token">
        <button class="token-sheet-btn" type="submit">Sign in</button>
      </form>
    </details>
    <div class="token-sheet-err" role="alert" aria-live="assertive" hidden></div>`;
  }

  async function postSignIn(path: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
    try {
      const response = await fetch(`/api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(CairnPasskeys.withDeviceHint((body ?? {}) as Record<string, unknown>)),
        credentials: "same-origin",
        cache: "no-store",
      });
      return response.status;
    } catch {
      return 0;
    }
  }

  async function defaultHealth(): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch("/api/health", { credentials: "same-origin", cache: "no-store" });
      const json = await response.json();
      return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  function signedIn(reload: () => void): void {
    try {
      (globalThis as { clearRememberedApiBodies?: () => void }).clearRememberedApiBodies?.();
    } catch {}
    try {
      localStorage.removeItem("cairn_token");
    } catch {}
    reload();
  }

  async function openSignIn(deps: SignInDeps = {}): Promise<void> {
    const doc = deps.doc || (typeof document !== "undefined" ? document : null);
    if (!doc || typeof CairnUiSheet === "undefined") return;
    if (doc.querySelector(".token-sheet-ov")) return;
    const reload = deps.reload || (() => location.reload());
    const health = await (deps.fetchHealth || defaultHealth)();
    const methods =
      health && typeof health.auth_methods === "object" ? (health.auth_methods as Record<string, unknown>) : null;
    const supported = deps.passkeysSupported ?? CairnPasskeys.passkeysSupported();
    const pairFailed = deps.pairFailed ?? !!(globalThis as { __cairnPairFailed?: unknown }).__cairnPairFailed;
    // A legacy `/?pair=<access token>` link: index.html's early script stripped it from
    // the address bar and exchanged nothing — the token never belongs in a URL.
    const retiredLink =
      deps.retiredLink ?? !!(globalThis as { __cairnRetiredPairLink?: unknown }).__cairnRetiredPairLink;
    if (doc.querySelector(".token-sheet-ov")) return;
    // The app is unusable signed out, so the sheet is not dismissible.
    const sheet = CairnUiSheet.open({
      overlayClass: "token-sheet-ov",
      sheetClass: "token-sheet signin-sheet",
      labelledBy: "signinTitle",
      dismissible: false,
      initialFocus: ".signin-passkey, .signin-code",
      html: signInSheetHtml({
        passkeys: supported && methods?.passkeys === true,
        standalone: deps.standalone ?? inStandaloneApp(),
        pairFailed,
        retiredLink,
      }),
    });
    const root = sheet.sheet;
    const errEl = root.querySelector<HTMLElement>(".token-sheet-err");
    const say = (text: string): void => {
      if (!errEl) return;
      errEl.textContent = text;
      errEl.hidden = !text;
    };
    const busy = (on: boolean): void => {
      for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>("button"))) b.disabled = on;
    };

    root.querySelector("[data-signin-passkey]")?.addEventListener("click", async () => {
      say("");
      busy(true);
      const result = await CairnPasskeys.signInWithPasskey();
      busy(false);
      if (result.ok) return signedIn(reload);
      if (result.reason === "failed") say("That passkey didn't sign you in. Try again, or use a pairing code.");
    });

    root.querySelector<HTMLFormElement>("[data-signin-code-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = root.querySelector<HTMLInputElement>(".signin-code");
      const code = (input?.value || "").trim();
      if (!code) {
        say("Type the code shown on your other device.");
        input?.focus();
        return;
      }
      say("");
      busy(true);
      const status = await postSignIn("/auth/pair", { code });
      busy(false);
      if (status === 200) {
        markOffer();
        return signedIn(reload);
      }
      say(
        status === 429
          ? "Too many tries for now. Wait a few minutes, or use your access token."
          : status === 0
            ? "Couldn't reach Cairn. Check your connection and try again."
            : "That code didn't work — it may have expired or already been used. Make a new one on your other device."
      );
      input?.focus();
    });

    root.querySelector<HTMLFormElement>("[data-signin-token-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>("input[name=token]");
      const token = (input?.value || "").trim();
      if (!token) {
        say("Paste the token to continue.");
        input?.focus();
        return;
      }
      say("");
      busy(true);
      const status = await postSignIn("/auth/session", {}, { Authorization: `Bearer ${token}` });
      busy(false);
      if (input) input.value = "";
      if (status === 200) {
        markOffer();
        return signedIn(reload);
      }
      say(
        status === 0
          ? "Couldn't reach Cairn. Check your connection and try again."
          : status === 429
            ? "Too many tries for now. Wait a minute and try again."
            : "That token wasn't accepted. Check it against your host's settings."
      );
      input?.focus();
    });
  }

  // ---------- the one passkey offer ----------

  function offerDismissed(): boolean {
    try {
      return localStorage.getItem(OFFER_DISMISSED) === "dismissed";
    } catch {
      return true; // no storage: we could never remember a "Not now", so never ask
    }
  }

  async function offerPasskey(deps: { doc?: Document; toast?: (message: string) => void } = {}): Promise<void> {
    const doc = deps.doc || (typeof document !== "undefined" ? document : null);
    if (!doc || typeof CairnUiSheet === "undefined") return;
    // Never stacked on another sheet (first-time setup, say): the flag waits for the
    // next open of this tab instead.
    if (CairnUiSheet.top()) return;
    try {
      sessionStorage.removeItem(OFFER_FLAG);
    } catch {}
    if (!CairnPasskeys.passkeysSupported() || offerDismissed()) return;
    let device: { has_passkey?: boolean } | null = null;
    try {
      const status = await api("/auth/status");
      device = status && typeof status === "object" && status.device ? status.device : null;
    } catch {
      return;
    }
    if (!device || device.has_passkey) return;
    if (doc.querySelector(".passkey-offer-ov")) return;
    const say = deps.toast || ((message: string) => (typeof toast === "function" ? toast(message) : undefined));
    const rememberDismissed = (): void => {
      try {
        localStorage.setItem(OFFER_DISMISSED, "dismissed");
      } catch {}
    };
    const sheet = CairnUiSheet.open({
      overlayClass: "token-sheet-ov passkey-offer-ov",
      sheetClass: "token-sheet",
      labelledBy: "passkeyOfferTitle",
      html: `<h2 class="token-sheet-h" id="passkeyOfferTitle">Add a passkey?</h2>
      <p class="token-sheet-p">Add a passkey so this device signs back in with Face ID / fingerprint.</p>
      <div class="token-sheet-err" role="alert" hidden></div>
      <div class="token-sheet-ft signin-offer-ft">
        <button class="linkbtn-quiet" type="button" data-offer-later>Not now</button>
        <button class="token-sheet-btn" type="button" data-offer-add>Add a passkey</button>
      </div>`,
      onClose: (reason) => {
        if (reason !== "api") rememberDismissed();
      },
    });
    sheet.sheet.querySelector("[data-offer-later]")?.addEventListener("click", () => {
      rememberDismissed();
      sheet.close({ reason: "button" });
    });
    sheet.sheet.querySelector("[data-offer-add]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      const result = await CairnPasskeys.addPasskey();
      button.disabled = false;
      if (result.ok) {
        rememberDismissed();
        sheet.close();
        say("Passkey added. This device can sign back in with it.");
        return;
      }
      if (result.reason === "failed") {
        const err = sheet.sheet.querySelector<HTMLElement>(".token-sheet-err");
        if (err) {
          err.textContent = "Couldn't add the passkey. You can add one later from Settings → Devices.";
          err.hidden = false;
        }
      }
    });
  }

  const CAIRN_SIGN_IN = {
    open: () => void openSignIn(),
    openSignIn,
    offerPasskey: () => void offerPasskey(),
    offerPasskeyWith: offerPasskey,
    signInSheetHtml,
  };
  Object.assign(globalThis, { CairnSignIn: CAIRN_SIGN_IN });
}
