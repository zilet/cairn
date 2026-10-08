// @ts-check
// The one dismissible offer to add a passkey after a sign-in this tab just completed
// (lazy "auth" bundle), shown once per device and never again after "Not now". It waits
// while the welcome is up. The sign-in screen (auth-signin-client.ts) sets the session flag.

{
  const OFFER_FLAG = "cairn.auth.offer";
  const OFFER_DISMISSED = "cairn.auth.passkey-offer";

  function offerDismissed(): boolean {
    try {
      return localStorage.getItem(OFFER_DISMISSED) === "dismissed";
    } catch {
      return true; // no storage: we could never remember a "Not now", so never ask
    }
  }

  // The offer never lands over the welcome: while its stage is up (or about to be, or the
  // onboarding decision has not landed: the shell's 4s fail-safe lifts `welcome-pending`
  // on a slow cold start while the welcome may still open) it waits for the welcome to close.
  function offerHeldByWelcome(state: { bodyClasses: string[]; pathname: string }): boolean {
    return (
      state.bodyClasses.includes("welcome-open") ||
      state.bodyClasses.includes("welcome-pending") ||
      state.bodyClasses.includes("welcome-undecided") ||
      /^\/app\/welcome(\/|$)/i.test(state.pathname)
    );
  }

  function welcomeState(doc: Document): { bodyClasses: string[]; pathname: string } {
    let pathname = "";
    try {
      pathname = typeof location !== "undefined" ? location.pathname : "";
    } catch {}
    return { bodyClasses: Array.from(doc.body?.classList || []), pathname };
  }

  function waitForWelcomeToClose(doc: Document, run: () => void): void {
    if (typeof MutationObserver === "undefined" || !doc.body) return;
    const observer = new MutationObserver(() => {
      if (offerHeldByWelcome(welcomeState(doc))) return;
      observer.disconnect();
      setTimeout(run, 1200);
    });
    observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
  }

  async function offerPasskey(
    deps: { doc?: Document; toast?: (message: string) => void; first?: boolean } = {}
  ): Promise<void> {
    const doc = deps.doc || (typeof document !== "undefined" ? document : null);
    if (!doc || typeof CairnUiSheet === "undefined") return;
    // Never stacked on another sheet (first-time setup, say): the flag waits for the
    // next open of this tab instead.
    if (CairnUiSheet.top()) return;
    if (offerHeldByWelcome(welcomeState(doc))) {
      // The flag stays (this tab, across reloads) and the offer re-runs when the welcome closes.
      waitForWelcomeToClose(doc, () => void offerPasskey(deps));
      return;
    }
    let firstSignIn = deps.first === true;
    try {
      firstSignIn = firstSignIn || sessionStorage.getItem(OFFER_FLAG) === "first";
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
    if (doc.querySelector(".passkey-offer-ov") || CairnUiSheet.top()) return;
    // The welcome may have opened while /auth/status was in flight: wait again, keeping
    // the first-sign-in copy (the flag was already spent).
    if (offerHeldByWelcome(welcomeState(doc))) {
      waitForWelcomeToClose(doc, () => void offerPasskey({ ...deps, first: firstSignIn }));
      return;
    }
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
      <p class="token-sheet-p">${
        firstSignIn
          ? "Add a passkey so you never need the access token again. This device then signs back in with Face ID / fingerprint. For your phone, use Settings → Devices → Pair a device."
          : "Add a passkey so this device signs back in with Face ID / fingerprint."
      }</p>
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

  Object.assign(globalThis, {
    CairnSignInOffer: { offerPasskeyWith: offerPasskey, offerHeldByWelcome },
  });
}
