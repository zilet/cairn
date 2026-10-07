// @ts-check
// The eager door to sign-in. api-core opens it when a request comes back 401; the
// sign-in screen itself (passkey, pairing code, access token) lives in the lazy
// "auth" bundle (src/client/auth-signin-client.ts), so the eager shell carries only
// this stub. It also hands the one calm "add a passkey" offer to that bundle after a
// sign-in this tab just completed (index.html's pairing exchange or the sign-in
// screen sets the session flag).
type TokenSheetApi = { open(): void };
declare const CairnTokenSheet: TokenSheetApi;

{
  // withBundle (app-lazy-bundles, a later eager bundle) exists by the time anything
  // here runs: a 401 or the offer timer, never module load.
  function openSignIn(): void {
    if (typeof document === "undefined") return;
    Promise.resolve()
      .then(() => withBundle("auth", () => CairnSignIn.open()))
      .catch(() => {
        // The sign-in bundle could not load (a dropped connection at the worst
        // moment). Say so plainly; reopening Cairn tries again.
        if (typeof CairnUiSheet === "undefined" || document.querySelector(".token-sheet-ov")) return;
        CairnUiSheet.open({
          overlayClass: "token-sheet-ov",
          sheetClass: "token-sheet",
          dismissible: false,
          html: `<h2 class="token-sheet-h">Sign in to Cairn</h2><p class="token-sheet-p">Couldn't load the sign-in screen. Check your connection, then try again.</p>
            <div class="token-sheet-ft"><button class="token-sheet-btn" type="button" data-token-retry>Try again</button></div>`,
        }).sheet.querySelector("[data-token-retry]")?.addEventListener("click", () => location.reload());
      });
  }

  // After index.html's pairing exchange (which may still be in flight) or a reload
  // the sign-in screen made.
  function offerPasskeyLater(): void {
    if (typeof sessionStorage === "undefined" || !sessionStorage.getItem("cairn.auth.offer")) return;
    setTimeout(() => {
      Promise.resolve()
        .then(() => withBundle("auth", () => CairnSignIn.offerPasskey()))
        .catch(() => {});
    }, 2500);
  }

  Promise.resolve((globalThis as { __cairnAuthReady?: unknown }).__cairnAuthReady)
    .catch(() => {})
    .then(offerPasskeyLater)
    .catch(() => {});

  const CAIRN_TOKEN_SHEET: TokenSheetApi = { open: openSignIn };

  Object.assign(globalThis, { CairnTokenSheet: CAIRN_TOKEN_SHEET });
}
