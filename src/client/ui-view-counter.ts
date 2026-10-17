// @ts-check
// Privacy-light count of which screens get opened. Direct guarded fetch, same
// shape as client-diagnostics: no imports, never throws, and a failure here
// never reports itself through that reporter. Counts stay in memory until a
// flush. Offline and Do Not Track drop them; nothing is queued for later.

type UiViewCount = { view: string; n: number };
type UiViewState = {
  tab?: unknown;
  progressSeg?: unknown;
  planSeg?: unknown;
  planJump?: unknown;
  standSeg?: unknown;
  meSeg?: unknown;
  setSeg?: unknown;
  horizonSeg?: unknown;
  youSeg?: unknown;
};
type UiViewHost = {
  visibilityState?: string;
  addEventListener?(type: string, listener: () => void): void;
};
type UiViewBeacon = (url: string, body: Blob) => boolean;
type UiViewFetch = (url: string, init: RequestInit) => Promise<unknown> | unknown;
type UiViewCounter = {
  note(view: string): void;
  noteActive(): void;
  flush(): void;
  pending(): UiViewCount[];
  install(host?: UiViewHost): void;
};

const UI_VIEW_URL = "/api/ui-views";
const UI_VIEW_MAX_PENDING = 20;
const UI_VIEW_MAX_N = 50;
const UI_VIEW_FLUSH_MS = 60_000;
// A section token from the route contract: lowercase, no date, no id.
const UI_VIEW_TOKEN = /^[a-z][a-z0-9]*$/;
const UI_VIEW_KEY = /^[a-z][a-z0-9]*(\/[a-z][a-z0-9]*)?$/;

function uiViewSection(prefix: string, section: unknown, bare: string): string {
  const seg = typeof section === "string" ? section : "";
  if (!seg || (seg === "overview" && prefix === "train")) return bare;
  if (!UI_VIEW_TOKEN.test(seg)) return bare;
  return `${prefix}/${seg}`;
}

/**
 * The screen the shell is showing, as a closed view key. A day page is `day`
 * (never its date); a stone is `you/stone` (never which stone).
 */
function uiViewKey(state: UiViewState | null | undefined): string | null {
  const tab = typeof state?.tab === "string" ? state.tab : "";
  if (!UI_VIEW_TOKEN.test(tab)) return null;
  if (tab === "today") return "today";
  if (tab === "session") return "session";
  if (tab === "day") return "day";
  if (tab === "chat" || tab === "ask") return "ask";
  if (tab === "horizon") return uiViewSection("horizon", state?.horizonSeg, "horizon");
  if (tab === "you") return uiViewSection("you", state?.youSeg, "you");
  if (tab === "settings") return uiViewSection("settings", state?.setSeg, "settings");
  if (tab === "progress" || tab === "train") return uiViewSection("train", state?.progressSeg, "train");
  if (tab === "plan") {
    const jump = typeof state?.planJump === "string" ? state.planJump : "";
    const seg = typeof state?.planSeg === "string" ? state.planSeg : "";
    return uiViewSection("plan", jump || seg || "edit", "plan");
  }
  if (tab === "stand") return uiViewSection("stand", state?.standSeg, "stand");
  if (tab === "me") return uiViewSection("me", state?.meSeg, "me");
  return tab;
}

function createUiViewCounter(
  options: {
    fetch?: UiViewFetch;
    sendBeacon?: UiViewBeacon;
    schedule?: (fn: () => void, delay: number) => unknown;
    online?: () => boolean;
    doNotTrack?: () => string | null;
    state?: () => UiViewState | null | undefined;
    authToken?: () => string;
    timeZone?: () => string;
    day?: () => string;
  } = {}
): UiViewCounter {
  const counts = new Map<string, number>();
  let lastView: string | null = null;
  let installed = false;
  const fetcher: UiViewFetch = options.fetch || ((url, init) => fetch(url, init));
  const beacon: UiViewBeacon =
    options.sendBeacon ||
    ((url, body) => {
      try {
        if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
          return navigator.sendBeacon(url, body);
        }
      } catch {
        /* fall through to fetch */
      }
      return false;
    });
  const schedule =
    options.schedule || ((fn, delay) => (typeof setInterval === "function" ? setInterval(fn, delay) : undefined));

  function trackingOff(): boolean {
    try {
      const value = options.doNotTrack
        ? options.doNotTrack()
        : typeof navigator === "undefined"
          ? null
          : navigator.doNotTrack;
      return value === "1";
    } catch {
      return false;
    }
  }
  function isOnline(): boolean {
    try {
      if (options.online) return options.online() !== false;
      if (typeof navigator === "undefined") return true;
      return navigator.onLine !== false;
    } catch {
      return true;
    }
  }
  function readState(): UiViewState | null | undefined {
    if (options.state) return options.state();
    return (globalThis as { state?: UiViewState }).state;
  }
  function authToken(): string {
    try {
      if (options.authToken) return options.authToken().trim();
      if (typeof localStorage === "undefined") return "";
      return String(localStorage.getItem("cairn_token") || "").trim();
    } catch {
      return "";
    }
  }
  function timeZone(): string {
    try {
      if (options.timeZone) return options.timeZone().trim();
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  }
  // The device's own calendar day: a beacon cannot send the zone header.
  function localDay(): string {
    try {
      if (options.day) return options.day();
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    } catch {
      return "";
    }
  }
  function requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = authToken().slice(0, 500);
    if (token) headers["X-Cairn-Token"] = token;
    const zone = timeZone().slice(0, 80);
    if (zone) headers["X-Cairn-TZ"] = zone;
    return headers;
  }
  function deliver(body: string): void {
    // sendBeacon cannot carry the token or the device zone. When a token is
    // present, fetch keepalive is the one that actually authenticates.
    const token = authToken();
    if (!token && typeof Blob === "function") {
      try {
        if (beacon(UI_VIEW_URL, new Blob([body], { type: "application/json" }))) return;
      } catch {
        /* fetch below */
      }
    }
    try {
      void Promise.resolve(
        fetcher(UI_VIEW_URL, { method: "POST", headers: requestHeaders(), body, keepalive: true })
      ).catch(() => {});
    } catch {
      /* a dropped flush is the offline contract */
    }
  }
  function note(view: string): void {
    try {
      if (!UI_VIEW_KEY.test(view)) return;
      // The shell can note one activation twice (tab switch, then its route
      // sync). A repeat of the view already open is one open.
      if (view === lastView) return;
      lastView = view;
      if (trackingOff() || !isOnline()) return;
      if (!counts.has(view) && counts.size >= UI_VIEW_MAX_PENDING) return;
      const next = (counts.get(view) ?? 0) + 1;
      if (next > UI_VIEW_MAX_N) return;
      counts.set(view, next);
    } catch {
      /* never break navigation */
    }
  }
  function noteActive(): void {
    try {
      const key = uiViewKey(readState());
      if (key) note(key);
    } catch {
      /* never break navigation */
    }
  }
  function flush(): void {
    try {
      if (trackingOff() || !isOnline()) {
        counts.clear();
        return;
      }
      if (!counts.size) return;
      const views = [...counts.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([view, n]) => ({ view, n }));
      counts.clear();
      const day = localDay();
      deliver(JSON.stringify(day ? { views, day } : { views }));
    } catch {
      /* never break the page lifecycle */
    }
  }
  function pending(): UiViewCount[] {
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([view, n]) => ({ view, n }));
  }
  function install(host?: UiViewHost): void {
    try {
      if (installed) return;
      installed = true;
      const doc: UiViewHost | null = host || (typeof document !== "undefined" ? document : null);
      if (doc && typeof doc.addEventListener === "function") {
        doc.addEventListener("visibilitychange", () => {
          if (doc.visibilityState === "hidden") flush();
        });
      }
      schedule(() => flush(), UI_VIEW_FLUSH_MS);
    } catch {
      /* counting is optional */
    }
  }
  return { note, noteActive, flush, pending, install };
}

const CairnUiViewCounter = createUiViewCounter();
try {
  CairnUiViewCounter.install();
} catch {
  /* counting is optional */
}

Object.assign(globalThis, {
  CairnUiViewCounter,
  CairnUiViewCounterCore: { createUiViewCounter, uiViewKey },
});
