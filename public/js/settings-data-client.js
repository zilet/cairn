(() => {
// @ts-check
// Small Settings -> Data helpers for setup/export-facing cards.
function phoneAccessCardHtml(options = {}) {
    if (options.inStandaloneApp)
        return "";
    return `
      <!-- Phone & PWA access: web-only, collapsed-by-default operator hint.
           Hidden in an installed PWA, where this setup is already complete. -->
      <details class="sess phone-access route-card">
        <summary>
          <span class="phone-access-summary">
            <span class="lbl">Phone &amp; PWA access</span>
            <span class="phone-access-tease">Private phone setup and app install notes</span>
          </span>
        </summary>
        <div class="phone-access-body">
          <div class="sess-line">Reach Cairn from your phone <b>privately</b> with Tailscale <b>Serve</b> — tailnet-only, nothing on the public internet. Easiest: run this once on the host (from the cloned repo):</div>
          <div class="cmd-line">./scripts/setup-phone.sh</div>
          <div class="sess-line phone-access-then">It detects your exact <b>https://…ts.net</b> URL and prints the Add-to-Home-Screen steps. By hand:</div>
          <div class="cmd-line">sudo tailscale serve --bg --https=443 http://127.0.0.1:8787</div>
          <div id="phoneTokenRow" class="phone-access-token">
            <button id="phoneGenToken" class="ghostbtn" type="button">Prepare a token for phone</button>
            <span id="phoneTokenOut" class="phone-token"></span>
          </div>
          <div class="small-note">
            On a private tailnet a token is optional; set one if others share your tailnet, or if Cairn is reachable beyond it (then set <b>CAIRN_REQUIRE_AUTH=1</b> too). iOS needs the HTTPS URL for a full offline app. Details in <b>docs/DEPLOYMENT.md</b> and <b>SECURITY.md</b>.
          </div>
        </div>
      </details>`;
}
function makePhoneToken(options = {}) {
    const cryptoLike = options.crypto || (typeof crypto !== "undefined" ? crypto : null);
    let tok = "";
    try {
        if (cryptoLike && cryptoLike.getRandomValues) {
            const bytes = new Uint8Array(28);
            cryptoLike.getRandomValues(bytes);
            tok = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
        }
    }
    catch { }
    if (!tok) {
        const random = options.random || Math.random;
        const now = options.now || Date.now;
        tok = "cairn-" + random().toString(36).slice(2) + now().toString(36);
    }
    return tok;
}
function wirePhoneAccessCard(options = {}) {
    const doc = options.document || (typeof document !== "undefined" ? document : null);
    if (!doc)
        return;
    const genTokenBtn = doc.querySelector("#phoneGenToken");
    const genTokenOut = doc.querySelector("#phoneTokenOut");
    const nav = options.navigator || (typeof navigator !== "undefined" ? navigator : null);
    const toastFn = options.toast || (typeof toast !== "undefined" ? toast : null);
    if (genTokenBtn && genTokenOut) {
        genTokenBtn.addEventListener("click", async () => {
            const tok = makePhoneToken(options);
            genTokenOut.textContent = tok;
            genTokenOut.title = "Set as CAIRN_AUTH_TOKEN=… in .env / compose, then restart";
            // navigator.clipboard is undefined in insecure contexts (e.g. http://<lan-ip>) — the
            // exact case this card targets. Only claim "copied" when the write actually succeeds.
            let copied = false;
            try {
                if (nav && nav.clipboard && nav.clipboard.writeText) {
                    await nav.clipboard.writeText(tok);
                    copied = true;
                }
            }
            catch { }
            if (toastFn) {
                toastFn(copied
                    ? "Token copied. Set CAIRN_AUTH_TOKEN=… in .env / compose, then restart."
                    : "Token ready — copy it, set CAIRN_AUTH_TOKEN=… in .env / compose, then restart.");
            }
        });
    }
    // Auth-aware: if a shared token is already configured, generating a new one is the wrong
    // move — say so instead. GET /api/health is auth-exempt and reports auth_required.
    const phoneTokenRow = doc.querySelector("#phoneTokenRow");
    const apiFn = options.api || (typeof api !== "undefined" ? api : null);
    if (phoneTokenRow && apiFn) {
        apiFn("/health").then((h) => {
            if (h && typeof h === "object" && h.auth_required) {
                phoneTokenRow.innerHTML =
                    `<div class="sess-line phone-token-set">✓ A shared token is already set — your phone will be asked for it once.</div>`;
            }
        }).catch(() => { });
    }
}
const CAIRN_SETTINGS_DATA = {
    phoneAccessCardHtml,
    wirePhoneAccessCard,
};
Object.assign(globalThis, { CairnSettingsData: CAIRN_SETTINGS_DATA });
if (typeof window !== "undefined") {
    window.CairnSettingsData = CAIRN_SETTINGS_DATA;
}
})();
