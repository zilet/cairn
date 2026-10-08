// @ts-check
// The sign-in screen (lazy "auth" bundle; the eager door is token-sheet.ts). Three
// calm ways in, in this order: a passkey (when this browser can use one and the
// server has any), a one-time pairing code from a device that is already signed in,
// and — folded away as the recovery path — the access token itself.
//
// Every way in ends the same: the server sets this device's HttpOnly session cookie
// and the app reloads signed in. The access token is never stored on the device.
//
// The one dismissible passkey offer after a sign-in lives in auth-offer-client.ts.

declare const CairnSignInOffer: {
  offerPasskeyWith(deps?: { doc?: Document; toast?: (message: string) => void }): Promise<void>;
  offerHeldByWelcome(state: { bodyClasses: string[]; pathname: string }): boolean;
};

type FirstVisit = {
  platform: "railway" | "installer" | "docker" | null;
  hostSettingsUrl: string | null;
  logCode: boolean;
};

type SignInDeps = {
  doc?: Document;
  fetchHealth?: () => Promise<Record<string, unknown> | null>;
  reload?: () => void;
  standalone?: boolean;
  passkeysSupported?: boolean;
  pairFailed?: boolean;
  retiredLink?: boolean;
  oauthResume?: () => Promise<string | null>;
  navigate?: (path: string) => void;
};

{
  const OFFER_FLAG = "cairn.auth.offer";

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

  // "first" marks a sign-in on a brand-new install: the passkey offer then says why
  // (so the code is never needed again) and points at pairing the phone.
  function markOffer(first = false): void {
    try {
      sessionStorage.setItem(OFFER_FLAG, first ? "first" : "1");
    } catch {}
  }

  // The server's /api/health `first_visit` object, read defensively. Only a Railway
  // variables address is ever turned into a link.
  function firstVisitFrom(health: Record<string, unknown> | null): FirstVisit | null {
    const raw =
      health && typeof health.first_visit === "object" ? (health.first_visit as Record<string, unknown> | null) : null;
    if (!raw) return null;
    const platform =
      raw.platform === "railway" || raw.platform === "installer" || raw.platform === "docker" ? raw.platform : null;
    const url = typeof raw.host_settings_url === "string" ? raw.host_settings_url : "";
    const hostSettingsUrl =
      platform === "railway" &&
      /^https:\/\/railway\.com\/project\/[0-9a-f-]{36}\/service\/[0-9a-f-]{36}\/variables\?environmentId=[0-9a-f-]{36}$/i.test(
        url
      )
        ? url
        : null;
    return { platform, hostSettingsUrl, logCode: raw.log_code === true };
  }

  function firstVisitHtml(fv: FirstVisit): string {
    const where =
      fv.platform === "railway"
        ? `In Railway, open your project, then the <strong>cairn</strong> service, then <strong>Variables</strong>, and copy <code>CAIRN_AUTH_TOKEN</code>.`
        : fv.platform === "installer"
          ? `The installer printed it when it finished. It is also in the <code>.env</code> file next to your install (<code>cairn.sh status</code> shows where).`
          : `It is <code>CAIRN_AUTH_TOKEN</code> in your server's settings.`;
    const link = fv.hostSettingsUrl
      ? `<p class="signin-first-link"><a class="token-sheet-btn signin-first-btn" href="${escAttr(fv.hostSettingsUrl)}" target="_blank" rel="noopener">Open your Railway variables &#8599;</a></p>`
      : "";
    const logs = fv.logCode
      ? `<p class="token-sheet-hint">Or open the deploy logs: the first sign-in line has a one-time code you can type in the pairing code box below.</p>`
      : "";
    return `<section class="signin-first" aria-labelledby="signinFirstTitle">
      <h3 class="signin-first-h" id="signinFirstTitle">First time here?</h3>
      <p class="token-sheet-p" id="signinFirstNote">Your access token was created when Cairn was deployed. ${where}</p>
      ${link}${logs}
    </section>`;
  }

  function signInSheetHtml(opts: {
    passkeys: boolean;
    standalone: boolean;
    pairFailed: boolean;
    retiredLink?: boolean;
    firstVisit?: FirstVisit | null;
  }): string {
    const fv = opts.firstVisit || null;
    const lead =
      fv && !opts.standalone
        ? ""
        : opts.standalone
          ? `<p class="token-sheet-p signin-standalone">This Home Screen app needs its own sign-in — a passkey or a code from another device does it.</p>`
          : `<p class="token-sheet-p">This Cairn is private. Sign this device in once and it stays signed in.</p>`;
    const passkey = opts.passkeys
      ? `<button class="token-sheet-btn signin-passkey" type="button" data-signin-passkey>Sign in with passkey</button>`
      : "";
    const pairNote = opts.pairFailed
      ? `<p class="signin-note" role="status">That pairing code didn't work — it may have expired or already been used. Make a new one on your other device.</p>`
      : opts.retiredLink
        ? `<p class="signin-note" role="status">That sign-in link is retired — use a pairing code or your access token.</p>`
        : "";
    // First visit: the visible label names the input (id + for) and the note above describes it.
    const tokenInput = fv
      ? `<input class="token-sheet-in" id="signinFirstToken" name="token" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="signinFirstNote" placeholder="Access token">`
      : `<input class="token-sheet-in" name="token" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Access token" placeholder="Access token">`;
    const tokenForm = `<form class="signin-row" data-signin-token-form>
        ${tokenInput}
        <button class="token-sheet-btn" type="submit">Sign in</button>
      </form>`;
    const firstToken = fv
      ? `<div class="signin-block signin-first-token"><label class="signin-lbl" for="signinFirstToken">Paste your access token</label>${tokenForm}</div>`
      : "";
    const recovery = fv
      ? ""
      : `<details class="signin-recovery">
      <summary>Use your access token</summary>
      <p class="token-sheet-hint">The token is CAIRN_AUTH_TOKEN in your host's settings (Railway → Variables, or the .env next to your install). It signs this device in; it isn't kept on the device.</p>
      ${tokenForm}
    </details>`;
    return `<h2 class="token-sheet-h" id="signinTitle">Sign in to Cairn</h2>
    ${lead}
    ${fv ? firstVisitHtml(fv) : ""}
    ${firstToken}
    ${passkey}
    ${pairNote}
    <form class="signin-block" data-signin-code-form>
      <label class="signin-lbl" for="signinCode">Enter a pairing code</label>
      <p class="token-sheet-hint">${
        fv
          ? "A one-time code from the deploy logs, or from Settings → Devices → Pair a device on a signed-in device."
          : "On a device that&rsquo;s already signed in, open Settings → Devices → Pair a device."
      }</p>
      <div class="signin-row">
        <input class="token-sheet-in signin-code" id="signinCode" name="code" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX">
        <button class="token-sheet-btn" type="submit">Sign in</button>
      </div>
    </form>
    ${recovery}
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

  // A connector's consent page this browser was signing in for: the server holds it in
  // an HttpOnly cookie, and the reload would be answered by the service worker's cached
  // shell, so ask. Only a same-origin /oauth/authorize path is ever followed.
  async function defaultOAuthResume(): Promise<string | null> {
    try {
      const response = await fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" });
      const json = (await response.json()) as { oauth_resume?: unknown } | null;
      const path = json && typeof json.oauth_resume === "string" ? json.oauth_resume : "";
      return /^\/oauth\/authorize\?rid=[A-Za-z0-9_-]+$/.test(path) ? path : null;
    } catch {
      return null;
    }
  }

  async function signedIn(reload: () => void, deps: SignInDeps): Promise<void> {
    try {
      (globalThis as { clearRememberedApiBodies?: () => void }).clearRememberedApiBodies?.();
    } catch {}
    try {
      localStorage.removeItem("cairn_token");
    } catch {}
    const resume = await (deps.oauthResume || defaultOAuthResume)();
    if (resume) return (deps.navigate || ((path: string) => location.replace(path)))(resume);
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
    const firstVisit = firstVisitFrom(health);
    // The app is unusable signed out, so the sheet is not dismissible.
    const sheet = CairnUiSheet.open({
      overlayClass: "token-sheet-ov",
      sheetClass: "token-sheet signin-sheet",
      labelledBy: "signinTitle",
      dismissible: false,
      initialFocus: firstVisit ? "input[name=token]" : ".signin-passkey, .signin-code",
      html: signInSheetHtml({
        passkeys: supported && methods?.passkeys === true,
        standalone: deps.standalone ?? inStandaloneApp(),
        pairFailed,
        retiredLink,
        firstVisit,
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
      if (result.ok) return signedIn(reload, deps);
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
        markOffer(!!firstVisit);
        return signedIn(reload, deps);
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
        markOffer(!!firstVisit);
        return signedIn(reload, deps);
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

  const CAIRN_SIGN_IN = {
    open: () => void openSignIn(),
    openSignIn,
    offerPasskey: () => void CairnSignInOffer.offerPasskeyWith(),
    offerPasskeyWith: (deps?: { doc?: Document; toast?: (message: string) => void }) =>
      CairnSignInOffer.offerPasskeyWith(deps),
    signInSheetHtml,
    firstVisitFrom,
    offerHeldByWelcome: (state: { bodyClasses: string[]; pathname: string }) =>
      CairnSignInOffer.offerHeldByWelcome(state),
  };
  Object.assign(globalThis, { CairnSignIn: CAIRN_SIGN_IN });
}
