// @ts-check
// The browser's credential and signed-link helpers, split out of api-core.ts (which
// loads right after this module and calls them at request time): the optional shared
// token, signed resource links for URLs the browser opens on its own, and the one
// place a 401 clears every remembered body and opens the token sheet.
{
  // ---------- optional auth ----------
  // No-op unless the server has CAIRN_AUTH_TOKEN set. A signed-in browser carries an
  // HttpOnly device-session cookie, which every same-origin fetch, <img>, download,
  // EventSource and WebSocket sends by itself — so authToken() is normally "" and
  // withToken() returns the url untouched. Only a token an older build stored (until
  // index.html's boot exchanges it for a cookie) still rides as a header / ?token=.
  function authToken(): string {
    try {
      return (localStorage.getItem("cairn_token") || "").trim();
    } catch {
      return "";
    }
  }

  function withToken(url: string): string {
    const t = authToken();
    if (!t) return url;
    return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
  }

  // A URL the browser opens on its own (a report in a new tab, a file, a download)
  // may land outside this app's cookie jar — an installed iOS app opens it in Safari —
  // so it carries a two-minute, one-path ?sig= the server mints (POST
  // /auth/resource-link). The tab opens NOW, inside the tap, so no popup blocker
  // eats it, and is pointed at the link once it is minted.
  function openResourceLink(path: string, mode: "tab" | "download" = "tab"): Promise<void> {
    const tab = mode === "tab" ? window.open("", "_blank") : null;
    return api("/auth/resource-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
      .then((r) => ((r as { url?: unknown })?.url as string) || path, () => path)
      .then((url) => {
        if (mode === "download") return downloadFile(url);
        if (tab) {
          tab.opener = null;
          // Absolute: a blank tab's own base URL is not a promise to keep.
          let href = url;
          try {
            href = new URL(url, location.href).href;
          } catch {}
          return tab.location.replace(href);
        }
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.click();
      });
  }

  // Any `<a data-resource-link href="/api/…">` (a record's file, an imaging attachment)
  // opens through a signed link. A modified click keeps the browser's own handling.
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", (event) => {
      const link = (event.target as Element | null)?.closest?.("a[data-resource-link]");
      if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      void openResourceLink(link.getAttribute("href") || "");
    });
  }

  let promptingAuth = false;

  // Every remembered API body on this device (the SWR tiers, cairn.swr.v1.*). A 401
  // or a new token means the bodies were read under a credential that no longer
  // stands, so none of them may paint again — the next open reads fresh or shows
  // its skeleton. swr-cache.ts owns the memory tier; the disk sweep here also covers
  // a boot where that module has not loaded yet.
  function clearRememberedApiBodies(): void {
    try {
      (globalThis as { swrClearAll?: () => void }).swrClearAll?.();
    } catch {}
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith("cairn.swr.v1.")) localStorage.removeItem(key);
      }
    } catch {}
    try {
      apiInvalidate();
    } catch {}
  }

  function handleUnauthorized(): void {
    if (promptingAuth) return;
    promptingAuth = true;
    try {
      localStorage.removeItem("cairn_token");
    } catch {}
    clearRememberedApiBodies();
    CairnTokenSheet.open();
  }

  Object.assign(globalThis, {
    authToken,
    withToken,
    openResourceLink,
    handleUnauthorized,
    clearRememberedApiBodies,
  });
}
