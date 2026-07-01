// @ts-check
// Shared API/auth/offline browser client. Kept as a plain script so the existing
// vanilla PWA modules can keep using global functions while this slice is typed.
//
// This module also carries the OFFLINE OUTBOX (see the section below): a durable
// localStorage queue that holds a failed capture / set-log POST and replays it,
// in order, the moment Cairn is reachable again — so a log typed in a gym dead
// zone is never lost. It lives here (rather than a standalone script) because it
// is the natural partner of api() + the offline hairline, and because api-client
// is already precached by the service worker.

type CairnApiOptions = RequestInit & { headers?: Record<string, string> };
type CairnApiResponse<Path extends string> = import("../contracts/client.js").ClientApiResponse<Path>;

// ---------- optional shared-token auth ----------
// No-op unless the server has CAIRN_AUTH_TOKEN set. The token lives in
// localStorage; api() sends it as a header, withToken() appends it to direct
// resource URLs (art images, file/export downloads) that can't carry a header.
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

let promptingAuth = false;

// ---------- Atelier token sheet (replaces the native window.prompt gate) ----------
// A designed, keyboard-perfect entry sheet for the optional shared token, in the
// warm-cream language of the app rather than an OS chrome prompt. Self-contained:
// it injects its own scoped styles (palette vars with fallbacks) so no styles.css
// coupling, mirroring the agent-login modal pattern.
function ensureTokenSheetStyles(): void {
  if (typeof document === "undefined" || document.getElementById("token-sheet-styles")) return;
  const style = document.createElement("style");
  style.id = "token-sheet-styles";
  style.textContent = `
.token-sheet-ov{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;
  padding:max(env(safe-area-inset-top),18px) 16px max(env(safe-area-inset-bottom),18px);
  background:rgba(33,29,23,.5);backdrop-filter:saturate(1.1) blur(2px);animation:tokenSheetFade .18s ease both}
@keyframes tokenSheetFade{from{opacity:0}to{opacity:1}}
.token-sheet{width:min(420px,100%);background:var(--card,#fffdf8);color:var(--ink,#211d17);
  border:1px solid var(--line,#e7dfd2);border-radius:var(--radius,18px);box-shadow:var(--shadow-md,0 14px 36px rgba(72,58,35,.2));
  padding:22px 20px 18px;font-family:var(--font-ui,system-ui,sans-serif)}
.token-sheet-h{margin:0 0 6px;font-family:var(--font-display,Georgia,serif);font-size:1.35rem;font-weight:600;line-height:1.15}
.token-sheet-p{margin:0 0 14px;font-size:.86rem;line-height:1.5;color:var(--ink-2,#57503f)}
.token-sheet-in{width:100%;box-sizing:border-box;font-family:var(--font-ui,system-ui,sans-serif);font-size:1rem;
  padding:11px 13px;border-radius:var(--radius-sm,12px);border:1px solid var(--line-2,#d8cfbd);
  background:var(--card-2,#f8f3ea);color:var(--ink,#211d17)}
.token-sheet-in:focus{outline:2px solid var(--accent,#b4552d);outline-offset:1px;border-color:transparent}
.token-sheet-err{margin-top:8px;font-size:.8rem;color:var(--warn,#b3402e);font-weight:600}
.token-sheet-ft{display:flex;justify-content:flex-end;margin-top:16px}
.token-sheet-btn{appearance:none;font-family:inherit;font-size:.92rem;font-weight:600;cursor:pointer;
  padding:10px 20px;border-radius:999px;border:0;background:var(--accent,#b4552d);color:var(--card,#fffdf8);
  transition:transform var(--dur-1,.2s) var(--ease,ease),background var(--dur-1,.2s) var(--ease,ease)}
.token-sheet-btn:hover{background:var(--accent-deep,#93421f)}
.token-sheet-btn:active{transform:var(--press,scale(.97))}
.token-sheet-btn:focus-visible{outline:2px solid var(--accent-deep,#93421f);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.token-sheet-ov{animation:none}.token-sheet-btn:active{transform:none}}
`;
  document.head.appendChild(style);
}

function openTokenSheet(): void {
  if (typeof document === "undefined") {
    // Non-DOM context (should not happen in the browser) — degrade to a reload so
    // the app-shell guard has a chance to run again once a token exists.
    try { location.reload(); } catch {}
    return;
  }
  if (document.querySelector(".token-sheet-ov")) return;
  ensureTokenSheetStyles();
  const overlay = document.createElement("div");
  overlay.className = "token-sheet-ov";
  overlay.innerHTML = `<div class="token-sheet" role="dialog" aria-modal="true" aria-labelledby="tokenSheetTitle" aria-describedby="tokenSheetBody">
    <h2 class="token-sheet-h" id="tokenSheetTitle">Enter your access token</h2>
    <p class="token-sheet-p" id="tokenSheetBody">This Cairn is protected by a shared access token. Paste it to continue — it's stored only on this device.</p>
    <input class="token-sheet-in" type="password" inputmode="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Access token" placeholder="Access token">
    <div class="token-sheet-err" role="alert" aria-live="assertive" hidden></div>
    <div class="token-sheet-ft"><button class="token-sheet-btn" type="button" data-token-save>Connect</button></div>
  </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>(".token-sheet-in");
  const errEl = overlay.querySelector<HTMLElement>(".token-sheet-err");
  const save = (): void => {
    const value = (input?.value || "").trim();
    if (!value) {
      if (errEl) { errEl.textContent = "Paste the token to continue."; errEl.hidden = false; }
      input?.focus();
      return;
    }
    try { localStorage.setItem("cairn_token", value); } catch {}
    location.reload();
  };
  overlay.querySelector("[data-token-save]")?.addEventListener("click", save);
  input?.addEventListener("keydown", (event: KeyboardEvent) => { if (event.key === "Enter") save(); });

  // Contain focus inside the sheet — the app is unusable without the token, so
  // there is deliberately no dismiss; Tab wraps between the input and Connect.
  overlay.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const focusable = [...overlay.querySelectorAll<HTMLElement>("input,button")].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length < 2) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  if (typeof setTimeout === "function") setTimeout(() => input?.focus(), 0);
  else input?.focus();
}

function handleUnauthorized(): void {
  if (promptingAuth) return;
  promptingAuth = true;
  try {
    localStorage.removeItem("cairn_token");
  } catch {}
  openTokenSheet();
}

// The device's live IANA timezone (e.g. "America/New_York", "Asia/Tokyo"). Sent
// on every call so the server frames "today"/now/log-times where the owner ACTUALLY
// is, so traveling across zones just works (logs stay UTC instants server-side).
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function api<Path extends string>(p: Path, opts: CairnApiOptions = {}): Promise<CairnApiResponse<Path>> {
  const t = authToken();
  const headers = { ...(opts.headers || {}) };
  if (t) headers["X-Cairn-Token"] = t;
  const tz = deviceTimeZone();
  if (tz) headers["X-Cairn-TZ"] = tz;
  return fetch("/api" + p, { ...opts, headers })
    .then((r) => {
      if (r.status === 401) {
        handleUnauthorized();
        return new Promise<CairnApiResponse<Path>>(() => {});
      }
      setOffline(false); // a real response landed, Cairn is reachable
      return r.json() as Promise<CairnApiResponse<Path>>;
    })
    .catch((err) => {
      setOffline(true); // the network dropped, surface the calm hairline banner
      throw err;
    });
}

// ---------- offline hairline ----------
// A calm, non-alarming banner that rides just under the header whenever a fetch
// fails or the browser reports offline. It clears itself the moment any request
// succeeds (or `online` fires). Constitution: information, never an alarm, one
// thin warm line, no modal. The "will retry" promise is now literally true — a
// failed capture / set-log is held in the outbox and replayed on reconnect.
let _offline = false;

function setOffline(on: unknown): void {
  const offline = !!on;
  if (offline === _offline) return;
  _offline = offline;
  let bar = document.querySelector(".offline-bar");
  if (offline) {
    if (!bar) {
      const created = document.createElement("div");
      created.className = "offline-bar";
      created.setAttribute("role", "status");
      created.setAttribute("aria-live", "polite");
      created.innerHTML = `<span class="offline-dot" aria-hidden="true"></span><span>Can't reach Cairn — your logs are saved, will retry</span>`;
      document.body.appendChild(created);
      bar = created;
    }
    const visibleBar = bar;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => visibleBar.classList.add("show"));
    else visibleBar.classList.add("show");
    document.body.classList.add("is-offline");
  } else {
    if (bar) bar.classList.remove("show");
    document.body.classList.remove("is-offline");
    // We just regained a live connection (a real response landed, or `online`
    // fired): drain anything the outbox is holding, in order.
    try { void flushOutbox(); } catch {}
  }
}

// ============================================================================
// Offline outbox — never lose a gym-floor log.
// ============================================================================
// The queue core (createOutbox) is a pure, storage-injected unit — no DOM, no
// network — so its replay/ordering logic is fully testable. The runtime layer
// below wires it to the live api() + the "N to sync" affordance.

type OutboxItem = { id: string; ts: number; kind: string; path: string; body: unknown };
type OutboxStore = Pick<Storage, "getItem" | "setItem">;
type OutboxDrainResult = { sent: number; remaining: number };
type OutboxController = {
  enqueue(entry: { kind: string; path: string; body: unknown }): OutboxItem;
  list(): OutboxItem[];
  count(): number;
  remove(id: string): void;
  clear(): void;
  drain(send: (item: OutboxItem) => Promise<unknown>): Promise<OutboxDrainResult>;
};

const OUTBOX_KEY = "cairn.outbox.v1";
const OUTBOX_MAX = 250;

// ---------- pure core: a durable FIFO queue over injected storage ----------
function createOutbox(opts: { storage: OutboxStore; now?: () => number; key?: string; max?: number }): OutboxController {
  const storage = opts.storage;
  const now = opts.now || (() => Date.now());
  const key = opts.key || OUTBOX_KEY;
  const max = opts.max && opts.max > 0 ? opts.max : OUTBOX_MAX;
  let seq = 0;

  function isItem(value: unknown): value is OutboxItem {
    return (
      !!value && typeof value === "object" &&
      typeof (value as OutboxItem).id === "string" &&
      typeof (value as OutboxItem).path === "string" &&
      typeof (value as OutboxItem).kind === "string"
    );
  }
  function read(): OutboxItem[] {
    try {
      const raw = storage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isItem) : [];
    } catch {
      return [];
    }
  }
  function write(items: OutboxItem[]): void {
    try {
      storage.setItem(key, JSON.stringify(items.slice(-max)));
    } catch {}
  }
  function makeId(): string {
    seq = (seq + 1) % 1_000_000;
    return `${now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  function enqueue(entry: { kind: string; path: string; body: unknown }): OutboxItem {
    const item: OutboxItem = {
      id: makeId(),
      ts: now(),
      kind: String(entry.kind || "log"),
      path: String(entry.path || ""),
      body: entry.body,
    };
    const items = read();
    items.push(item);
    write(items);
    return item;
  }
  function list(): OutboxItem[] {
    return read();
  }
  function count(): number {
    return read().length;
  }
  function remove(id: string): void {
    write(read().filter((item) => item.id !== id));
  }
  function clear(): void {
    write([]);
  }

  // Replay queued POSTs oldest-first. `send` RESOLVES on delivery (the item is
  // dropped) and REJECTS on a transient failure (we STOP and keep this item and
  // every one after it for the next flush). Items enqueued DURING a drain (the
  // network dropped again mid-replay) land at the tail and survive, because
  // remove() always re-reads the freshly-stored queue.
  async function drain(send: (item: OutboxItem) => Promise<unknown>): Promise<OutboxDrainResult> {
    let sent = 0;
    const queue = read();
    for (const item of queue) {
      try {
        await send(item);
      } catch {
        break;
      }
      remove(item.id);
      sent++;
    }
    return { sent, remaining: count() };
  }

  return { enqueue, list, count, remove, clear, drain };
}

// ---------- runtime: one live queue wired to api() + the affordance ----------
function storageForOutbox(): OutboxStore {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {}
  // Private-mode / disabled storage → an in-memory queue for this session, so a
  // log is at least held until the tab closes rather than dropped outright.
  const mem = new Map<string, string>();
  return { getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null), setItem: (k, v) => { mem.set(k, String(v)); } };
}

let outboxController: OutboxController | null = null;
function outbox(): OutboxController {
  if (!outboxController) outboxController = createOutbox({ storage: storageForOutbox() });
  return outboxController;
}

let outboxFlushing = false;

function renderOutboxBar(): void {
  if (typeof document === "undefined") return;
  const pending = outbox().count();
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  let bar = document.querySelector<HTMLElement>(".outbox-bar");
  // While offline the warm `.offline-bar` already promises the logs are saved and
  // will retry — don't stack a second band under it. Surface the count only when
  // we're online (actively retrying, or holding until the drain lands).
  if (pending === 0 || offline) {
    if (bar) bar.classList.remove("show");
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "outbox-bar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    document.body.appendChild(bar);
  }
  const label = outboxFlushing ? "Syncing" : "Waiting to sync";
  bar.innerHTML = `<span class="outbox-dot" aria-hidden="true"></span><span class="outbox-txt">${label} · ${pending} log${pending === 1 ? "" : "s"}</span>`;
  const shown = bar;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => shown.classList.add("show"));
  else shown.classList.add("show");
}

function freshenAfterSync(): void {
  const g = globalThis as Record<string, unknown> & {
    swrInvalidate?(keyOrPrefix: string): void;
    reshapeToday?(): unknown;
    renderSession?(opts?: unknown): unknown;
    state?: { tab?: string; brief?: unknown };
  };
  try {
    g.swrInvalidate?.("stats");
    g.swrInvalidate?.("plan");
    g.swrInvalidate?.("today:session");
    g.swrInvalidate?.("history:sessions");
    g.swrInvalidate?.("progress:volume");
    g.swrInvalidate?.("progress:energy");
    if (g.state) g.state.brief = null;
  } catch {}
  // Reflect the just-synced logs where the user is actually looking. Both
  // renderers preserve their surface (Today re-reads the calm Brief; the Session
  // destination keeps scroll), so this is safe mid-review.
  try {
    const tab = g.state && g.state.tab;
    if (tab === "session" && typeof g.renderSession === "function") g.renderSession();
    else if (tab === "today" && typeof g.reshapeToday === "function") g.reshapeToday();
  } catch {}
}

async function flushOutbox(): Promise<void> {
  const box = outbox();
  if (outboxFlushing || box.count() === 0) {
    renderOutboxBar();
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    renderOutboxBar();
    return;
  }

  outboxFlushing = true;
  renderOutboxBar();
  let result: OutboxDrainResult = { sent: 0, remaining: box.count() };
  try {
    result = await box.drain(async (item) => {
      // api() resolves the body on ANY HTTP status and only REJECTS on a network
      // failure, so reaching the resolve means the server received the write. A
      // server-side {error} won't be cured by re-sending, so delivery counts as
      // done either way — drain drops the item and moves to the next.
      await api(item.path as string, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.body),
      });
      renderOutboxBar();
    });
  } finally {
    outboxFlushing = false;
  }
  renderOutboxBar();
  if (result.sent > 0) {
    freshenAfterSync();
    try {
      toast(`${result.sent} log${result.sent === 1 ? "" : "s"} synced`);
    } catch {}
  }
}

// Public enqueue: hold a failed POST and update the affordance. Callers pass the
// exact path + JSON body they tried, so replay is byte-for-byte the original write.
function outboxEnqueue(kind: string, path: string, body: unknown): OutboxItem {
  const item = outbox().enqueue({ kind, path, body });
  renderOutboxBar();
  return item;
}
function outboxCount(): number {
  return outbox().count();
}

const CAIRN_OUTBOX = {
  createOutbox,
  enqueue: outboxEnqueue,
  flush: flushOutbox,
  count: outboxCount,
  renderBar: renderOutboxBar,
};

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => { setOffline(false); void flushOutbox(); });
  if (navigator.onLine === false) setOffline(true);
  // Boot: paint any leftover queue and try to drain what a previous session held.
  if (typeof setTimeout === "function") setTimeout(() => { renderOutboxBar(); void flushOutbox(); }, 0);
}

Object.assign(globalThis, {
  authToken,
  withToken,
  deviceTimeZone,
  api,
  setOffline,
  CairnOutbox: CAIRN_OUTBOX,
  outboxEnqueue,
  flushOutbox,
  outboxCount,
});
