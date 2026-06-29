// @ts-check
// Shared API/auth/offline browser client. Kept as a plain script so the existing
// vanilla PWA modules can keep using global functions while this slice is typed.
// ---------- optional shared-token auth ----------
// No-op unless the server has CAIRN_AUTH_TOKEN set. The token lives in
// localStorage; api() sends it as a header, withToken() appends it to direct
// resource URLs (art images, file/export downloads) that can't carry a header.
function authToken() {
    try {
        return (localStorage.getItem("cairn_token") || "").trim();
    }
    catch {
        return "";
    }
}
function withToken(url) {
    const t = authToken();
    if (!t)
        return url;
    return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}
let promptingAuth = false;
function handleUnauthorized() {
    if (promptingAuth)
        return;
    promptingAuth = true;
    try {
        localStorage.removeItem("cairn_token");
    }
    catch { }
    const t = window.prompt("Cairn needs an access token (CAIRN_AUTH_TOKEN) to continue:");
    if (t && t.trim()) {
        try {
            localStorage.setItem("cairn_token", t.trim());
        }
        catch { }
    }
    location.reload();
}
// The device's live IANA timezone (e.g. "America/New_York", "Asia/Tokyo"). Sent
// on every call so the server frames "today"/now/log-times where the owner ACTUALLY
// is, so traveling across zones just works (logs stay UTC instants server-side).
function deviceTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    }
    catch {
        return "";
    }
}
function api(p, opts = {}) {
    const t = authToken();
    const headers = { ...(opts.headers || {}) };
    if (t)
        headers["X-Cairn-Token"] = t;
    const tz = deviceTimeZone();
    if (tz)
        headers["X-Cairn-TZ"] = tz;
    return fetch("/api" + p, { ...opts, headers })
        .then((r) => {
        if (r.status === 401) {
            handleUnauthorized();
            return new Promise(() => { });
        }
        setOffline(false); // a real response landed, Cairn is reachable
        return r.json();
    })
        .catch((err) => {
        setOffline(true); // the network dropped, surface the calm hairline banner
        throw err;
    });
}
// ---------- offline hairline ----------
// A calm, non-alarming banner ("Can't reach Cairn — changes will retry") that
// rides just under the header whenever a fetch fails or the browser reports
// offline. It clears itself the moment any request succeeds (or `online` fires).
// Constitution: information, never an alarm, one thin warm line, no modal.
let _offline = false;
function setOffline(on) {
    const offline = !!on;
    if (offline === _offline)
        return;
    _offline = offline;
    let bar = document.querySelector(".offline-bar");
    if (offline) {
        if (!bar) {
            const created = document.createElement("div");
            created.className = "offline-bar";
            created.setAttribute("role", "status");
            created.setAttribute("aria-live", "polite");
            created.innerHTML = `<span class="offline-dot" aria-hidden="true"></span><span>Can't reach Cairn — changes will retry</span>`;
            document.body.appendChild(created);
            bar = created;
        }
        const visibleBar = bar;
        requestAnimationFrame(() => visibleBar.classList.add("show"));
        document.body.classList.add("is-offline");
    }
    else if (bar) {
        bar.classList.remove("show");
        document.body.classList.remove("is-offline");
    }
}
if (typeof window !== "undefined") {
    window.addEventListener("offline", () => setOffline(true));
    window.addEventListener("online", () => setOffline(false));
    if (navigator.onLine === false)
        setOffline(true);
}
Object.assign(globalThis, {
    authToken,
    withToken,
    deviceTimeZone,
    api,
    setOffline,
});
