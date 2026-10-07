// @ts-check
// Passkeys on the client: whether this browser can use one, the vendored WebAuthn
// helper (public/vendor/simplewebauthn-browser.js, loaded on first use — never with
// a bundle), and the two ceremonies against /api/auth/passkeys/*. Lives in the lazy
// "auth" bundle; the sign-in screen and Settings -> Devices both call it.
//
// Requests here go through plain same-origin fetch, not api(): the sign-in ceremony
// runs signed OUT, where api()'s 401 handling would only reopen the screen we are on.
// Nothing here logs; a challenge or an assertion never leaves these functions except
// to the server that issued it.

type PasskeyBrowserLib = {
  startRegistration(options: { optionsJSON: unknown }): Promise<unknown>;
  startAuthentication(options: { optionsJSON: unknown }): Promise<unknown>;
};

type PasskeyResult = { ok: true; body: Record<string, unknown> } | { ok: false; reason: "cancelled" | "failed" };

{
  const VENDOR_SRC = "/vendor/simplewebauthn-browser.js";
  let libLoad: Promise<PasskeyBrowserLib> | null = null;

  /** A secure context with WebAuthn: the only place a passkey can work. */
  function passkeysSupported(): boolean {
    try {
      return (
        typeof window !== "undefined" &&
        window.isSecureContext === true &&
        typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential === "function"
      );
    } catch {
      return false;
    }
  }

  function loadLib(doc: Document = document): Promise<PasskeyBrowserLib> {
    const ready = () => (globalThis as { SimpleWebAuthnBrowser?: PasskeyBrowserLib }).SimpleWebAuthnBrowser;
    const have = ready();
    if (have) return Promise.resolve(have);
    if (libLoad) return libLoad;
    libLoad = new Promise<PasskeyBrowserLib>((resolve, reject) => {
      const el = doc.createElement("script");
      el.src = VENDOR_SRC;
      el.async = true;
      el.addEventListener("load", () => {
        const lib = ready();
        if (lib) resolve(lib);
        else reject(new Error("passkey helper missing"));
      });
      el.addEventListener("error", () => reject(new Error("passkey helper failed to load")));
      doc.head.appendChild(el);
    }).catch((error) => {
      libLoad = null; // a later tap may try again
      throw error;
    });
    return libLoad;
  }

  async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // A device an older build signed in by token has not swapped it for a cookie yet.
    const token = typeof authToken === "function" ? authToken() : "";
    if (token) headers["X-Cairn-Token"] = token;
    const response = await fetch(`/api${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
    });
    let parsed: Record<string, unknown> = {};
    try {
      const json = await response.json();
      if (json && typeof json === "object") parsed = json as Record<string, unknown>;
    } catch {}
    return { status: response.status, body: parsed };
  }

  /**
   * This browser's non-secret device hint (index.html's boot script mints the same
   * one): sent with every sign-in so the server puts this browser back on its own
   * device row instead of adding another. "" when storage is unavailable.
   */
  function deviceHint(): string {
    const key = "cairn.device-hint";
    try {
      const have = localStorage.getItem(key) || "";
      if (/^[A-Za-z0-9_-]{16,64}$/.test(have)) return have;
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const hint = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(key, hint);
      return hint;
    } catch {
      return "";
    }
  }

  /** A sign-in request body carrying the device hint when there is one. */
  function withDeviceHint(body: Record<string, unknown>): Record<string, unknown> {
    const hint = deviceHint();
    return hint ? { ...body, device_hint: hint } : body;
  }

  function cancelled(error: unknown): boolean {
    const name = error && typeof error === "object" ? String((error as { name?: unknown }).name || "") : "";
    return name === "NotAllowedError" || name === "AbortError";
  }

  /** Sign this browser in with a passkey (discoverable: no username asked). */
  async function signInWithPasskey(): Promise<PasskeyResult> {
    try {
      const lib = await loadLib();
      const options = await postJson("/auth/passkeys/login/options", {});
      if (options.status !== 200) return { ok: false, reason: "failed" };
      const assertion = await lib.startAuthentication({ optionsJSON: options.body });
      const verified = await postJson("/auth/passkeys/login/verify", withDeviceHint({ response: assertion }));
      return verified.status === 200 && verified.body.ok
        ? { ok: true, body: verified.body }
        : { ok: false, reason: "failed" };
    } catch (error) {
      return { ok: false, reason: cancelled(error) ? "cancelled" : "failed" };
    }
  }

  /** Add a passkey bound to this (signed-in) device. */
  async function addPasskey(name?: string): Promise<PasskeyResult> {
    try {
      const lib = await loadLib();
      const options = await postJson("/auth/passkeys/register/options", {});
      if (options.status !== 200) return { ok: false, reason: "failed" };
      const attestation = await lib.startRegistration({ optionsJSON: options.body });
      const verified = await postJson("/auth/passkeys/register/verify", { response: attestation, name });
      return verified.status === 200 && verified.body.ok
        ? { ok: true, body: verified.body }
        : { ok: false, reason: "failed" };
    } catch (error) {
      return { ok: false, reason: cancelled(error) ? "cancelled" : "failed" };
    }
  }

  const CAIRN_PASSKEYS = {
    passkeysSupported,
    loadLib,
    postJson,
    signInWithPasskey,
    addPasskey,
    deviceHint,
    withDeviceHint,
  };
  Object.assign(globalThis, { CairnPasskeys: CAIRN_PASSKEYS });
}
