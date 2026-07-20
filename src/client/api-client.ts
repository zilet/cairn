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

type CairnApiOptions = RequestInit & {
  headers?: Record<string, string>;
  acceptErrorBody?: boolean;
};
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
    try {
      location.reload();
    } catch {}
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
      if (errEl) {
        errEl.textContent = "Paste the token to continue.";
        errEl.hidden = false;
      }
      input?.focus();
      return;
    }
    try {
      localStorage.setItem("cairn_token", value);
    } catch {}
    location.reload();
  };
  overlay.querySelector("[data-token-save]")?.addEventListener("click", save);
  input?.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") save();
  });

  // Contain focus inside the sheet — the app is unusable without the token, so
  // there is deliberately no dismiss; Tab wraps between the input and Connect.
  overlay.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const focusable = [...overlay.querySelectorAll<HTMLElement>("input,button")].filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    if (focusable.length < 2) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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

// ============================================================================
// api() in-flight dedupe + micro-TTL cache + GET timeout
// ============================================================================
// Several PWA modules independently re-fetch the same hot GETs during one
// render burst (/settings, /profile, /stats, /coaching-focus), and a hung GET
// had no timeout. The pure core (createApiCoalescer) is storage/DOM/fetch-free
// — same shape as createOutbox above — so its dedupe/TTL/decision logic is
// fully unit-testable; api() below is the only thing that wires it to fetch.

type CairnApiErrorKind = "http" | "invalid_json" | "network" | "timeout";
type ApiFetchOutcome = {
  status: number;
  body?: unknown;
  invalidJson?: boolean;
  durationMs: number;
  requestId?: string;
};
type ApiCoalesceEntry<T> = { data: T; expires: number };
type ApiCoalescer = {
  isMicroCachePath(path: string): boolean;
  peekFresh<T = unknown>(path: string): T | undefined;
  store<T = unknown>(path: string, data: T): void;
  invalidateAll(): void;
  share<T>(path: string, start: () => Promise<T>): Promise<T>;
  inFlightCount(): number;
  cacheSize(): number;
};

const API_MICRO_TTL_MS = 1500;
const API_MICRO_CACHE_PATHS: readonly string[] = ["/settings", "/profile", "/stats", "/coaching-focus"];
const API_GET_TIMEOUT_MS = 20000;

class CairnApiError extends Error {
  kind: CairnApiErrorKind;
  method: string;
  route: string;
  status: number | null;
  durationMs: number;
  requestId: string | null;

  constructor(options: {
    kind: CairnApiErrorKind;
    method: string;
    route: string;
    status?: number | null;
    durationMs?: number;
    requestId?: string | null;
    cause?: unknown;
  }) {
    const statusSuffix = options.status == null ? "" : ` (${options.status})`;
    const label =
      options.kind === "http"
        ? `Cairn request failed${statusSuffix}`
        : options.kind === "invalid_json"
          ? "Cairn returned an invalid response"
          : options.kind === "timeout"
            ? "Cairn request timed out"
            : "Could not reach Cairn";
    super(label, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CairnApiError";
    this.kind = options.kind;
    this.method = options.method;
    this.route = normalizeApiRoute(options.route);
    this.status = options.status == null ? null : options.status;
    this.durationMs = Math.max(0, Math.round(options.durationMs || 0));
    this.requestId = options.requestId || null;
  }
}

function normalizeApiRoute(path: string): string {
  const reporter = (globalThis as { CairnClientDiagnosticsCore?: { normalizeRoute?: (value: unknown) => string } })
    .CairnClientDiagnosticsCore;
  if (reporter?.normalizeRoute) return reporter.normalizeRoute(path);
  return String(path || "")
    .split(/[?#]/, 1)[0]
    .slice(0, 160);
}

function diagnosticApiRoute(path: string): string {
  const route = normalizeApiRoute(path);
  if (route === "/api" || route.startsWith("/api/")) return route;
  return `/api${route.startsWith("/") ? route : `/${route}`}`;
}

function responseRequestId(response: Response | { headers?: unknown }): string {
  try {
    const headers = response.headers as Headers | { get?(name: string): string | null } | undefined;
    return String(headers?.get?.("X-Request-ID") || "")
      .trim()
      .slice(0, 100);
  } catch {
    return "";
  }
}

function reportApiError(error: CairnApiError): void {
  try {
    (globalThis as { CairnClientDiagnostics?: { report?(event: unknown): unknown } }).CairnClientDiagnostics?.report?.({
      kind: "api_failure",
      level: error.kind === "http" && error.status != null && error.status < 500 ? "warning" : "error",
      message: `${error.kind}: ${error.message}`,
      route: diagnosticApiRoute(error.route),
      method: error.method,
      status: error.status ?? undefined,
      duration_ms: error.durationMs,
      request_id: error.requestId || undefined,
      online: typeof navigator === "undefined" ? undefined : navigator.onLine,
    });
  } catch {}
}

function isTransientApiFailure(error: unknown): boolean {
  if (!(error instanceof CairnApiError)) return true;
  return (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.status === 408 ||
    error.status === 429 ||
    (error.status != null && error.status >= 500)
  );
}

// structuredClone when available, else a JSON round-trip, else the value as-is
// (never throw) — so neither a caller mutating a served body, nor us mutating
// what we just stored, can poison the micro-cache.
function cloneJson<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

// ---------- pure core: dedupe map + TTL cache over injected time ----------
function createApiCoalescer(
  opts: { now?: () => number; ttlMs?: number; ttlPaths?: readonly string[] } = {}
): ApiCoalescer {
  const now = opts.now || (() => Date.now());
  const ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : API_MICRO_TTL_MS;
  const ttlPaths = new Set(opts.ttlPaths || API_MICRO_CACHE_PATHS);
  const inFlight = new Map<string, Promise<unknown>>();
  const ttlCache = new Map<string, ApiCoalesceEntry<unknown>>();

  function isMicroCachePath(path: string): boolean {
    return ttlPaths.has(path);
  }
  function peekFresh<T = unknown>(path: string): T | undefined {
    const entry = ttlCache.get(path);
    if (!entry) return undefined;
    if (now() >= entry.expires) {
      ttlCache.delete(path);
      return undefined;
    }
    return cloneJson(entry.data) as T;
  }
  function store<T = unknown>(path: string, data: T): void {
    if (!isMicroCachePath(path)) return;
    ttlCache.set(path, { data: cloneJson(data), expires: now() + ttlMs });
  }
  function invalidateAll(): void {
    ttlCache.clear();
  }
  // Concurrent callers for the SAME path share one in-flight promise. The map
  // entry is cleared when `started` itself settles (fulfills OR rejects) — NOT
  // when a caller's own transformed/returned promise settles. That distinction
  // is what keeps a 401 from wedging this path forever: api() resolves `started`
  // to a plain {status:401} outcome (never hangs), so the dedupe entry clears
  // the instant the response arrives; each caller then independently decides
  // (per its own chain) to hang on the never-resolving auth-prompt promise.
  function share<T>(path: string, start: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(path);
    if (existing) return existing as Promise<T>;
    const started = start();
    inFlight.set(path, started as Promise<unknown>);
    started
      .finally(() => {
        if (inFlight.get(path) === started) inFlight.delete(path);
      })
      .catch(() => {}); // swallow on this derived chain only; `started` itself still rejects to callers
    return started;
  }
  function inFlightCount(): number {
    return inFlight.size;
  }
  function cacheSize(): number {
    return ttlCache.size;
  }

  return { isMicroCachePath, peekFresh, store, invalidateAll, share, inFlightCount, cacheSize };
}

// ---------- pure decision helpers (no DOM) ----------
// A caller-supplied `signal` or `cache` option is a request for real network
// control, so it bypasses BOTH the dedupe and the micro-TTL cache entirely.
function shouldBypassApiCache(opts: CairnApiOptions): boolean {
  return opts.signal != null || opts.cache != null;
}
// GETs get a generous safety timeout unless the caller brought its own signal
// — agentic ops are all background jobs now, so no legitimate GET runs long.
function shouldArmGetTimeout(method: string, opts: CairnApiOptions): boolean {
  return method.toUpperCase() === "GET" && opts.signal == null;
}

let apiCoalescerSingleton: ApiCoalescer | null = null;
function apiCoalescer(): ApiCoalescer {
  if (!apiCoalescerSingleton) apiCoalescerSingleton = createApiCoalescer({});
  return apiCoalescerSingleton;
}

// ---------- runtime: fetch init for one attempt ----------
// Arms a 20s AbortController ONLY for a timeout-eligible GET, and only when
// AbortController/setTimeout actually exist in this environment. A non-GET (or
// any caller-supplied signal) passes straight through untouched — long
// health-doc uploads on a slow network are legitimate and must never time out.
function buildFetchInit(
  method: string,
  opts: CairnApiOptions,
  headers: Record<string, string>
): { init: RequestInit; cleanup: () => void } {
  const { acceptErrorBody: _acceptErrorBody, ...fetchOptions } = opts;
  let signal = opts.signal;
  let cleanup = () => {};
  if (shouldArmGetTimeout(method, opts) && typeof AbortController === "function") {
    const controller = new AbortController();
    signal = controller.signal;
    if (typeof setTimeout === "function") {
      const timer = setTimeout(() => controller.abort(), API_GET_TIMEOUT_MS);
      cleanup = () => {
        if (typeof clearTimeout === "function") clearTimeout(timer);
      };
    }
  }
  return { init: { ...fetchOptions, headers, signal }, cleanup };
}

function api<Path extends string>(p: Path, opts: CairnApiOptions = {}): Promise<CairnApiResponse<Path>> {
  const method = (opts.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const bypass = shouldBypassApiCache(opts);
  const coalescer = apiCoalescer();

  if (!isGet) {
    coalescer.invalidateAll(); // any write may change anything — never serve a stale read after it
  } else if (!bypass) {
    const cached = coalescer.peekFresh<CairnApiResponse<Path>>(p);
    if (cached !== undefined) return Promise.resolve(cached);
  }

  const t = authToken();
  const headers = { ...(opts.headers || {}) };
  if (t) headers["X-Cairn-Token"] = t;
  const tz = deviceTimeZone();
  if (tz) headers["X-Cairn-TZ"] = tz;

  const attempt = (): Promise<ApiFetchOutcome> => {
    const { init, cleanup } = buildFetchInit(method, opts, headers);
    const started =
      typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    const elapsed = (): number => {
      const ended =
        typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
      return Math.max(0, ended - started);
    };
    return fetch("/api" + p, init)
      .then(async (r) => {
        const base = { status: r.status, durationMs: elapsed(), requestId: responseRequestId(r) };
        if (r.status === 401 || r.status === 204) return base;
        try {
          return { ...base, body: await r.json() };
        } catch {
          return { ...base, invalidJson: true };
        }
      })
      .catch((cause) => {
        const error = new CairnApiError({
          kind:
            cause && typeof cause === "object" && (cause as { name?: unknown }).name === "AbortError"
              ? "timeout"
              : "network",
          method,
          route: p,
          durationMs: elapsed(),
          cause,
        });
        reportApiError(error);
        throw error;
      })
      .finally(cleanup);
  };

  const settled = isGet && !bypass ? coalescer.share(p, attempt) : attempt();

  return settled
    .then((result) => {
      if (result.status === 401) {
        handleUnauthorized();
        return new Promise<CairnApiResponse<Path>>(() => {});
      }
      setOffline(false); // a real response landed, Cairn is reachable
      if (result.status < 200 || result.status >= 300) {
        // Readiness uses 503 as meaningful operator truth (for example, a stale
        // scheduler) and still returns a bounded JSON contract. Opt-in callers
        // can consume that body without turning the expected signal into a
        // recursive client diagnostic.
        if (opts.acceptErrorBody && !result.invalidJson && result.body !== undefined) {
          return result.body as CairnApiResponse<Path>;
        }
        const error = new CairnApiError({
          kind: "http",
          method,
          route: p,
          status: result.status,
          durationMs: result.durationMs,
          requestId: result.requestId,
        });
        reportApiError(error);
        throw error;
      }
      if (result.invalidJson) {
        const error = new CairnApiError({
          kind: "invalid_json",
          method,
          route: p,
          status: result.status,
          durationMs: result.durationMs,
          requestId: result.requestId,
        });
        reportApiError(error);
        throw error;
      }
      if (isGet && !bypass) coalescer.store(p, result.body);
      return result.body as CairnApiResponse<Path>;
    })
    .catch((err) => {
      // A reachable HTTP/protocol failure must never claim Cairn is offline.
      // Only fetch/abort/connectivity failures get the calm offline hairline.
      if (err instanceof CairnApiError && (err.kind === "network" || err.kind === "timeout")) setOffline(true);
      throw err;
    });
}

// Binary API reads share the normal token/time-zone headers but intentionally do
// not enter the JSON coalescer or any persistent browser cache.
async function apiBinary(p: string, opts: RequestInit = {}): Promise<{ body: ArrayBuffer; headers: Headers }> {
  const headers = new Headers(opts.headers || {});
  const token = authToken();
  if (token) headers.set("X-Cairn-Token", token);
  const tz = deviceTimeZone();
  if (tz) headers.set("X-Cairn-TZ", tz);
  const response = await fetch(`/api${p}`, { ...opts, headers, cache: "no-store" });
  if (!response.ok) throw new Error(`Binary request failed (${response.status})`);
  return { body: await response.arrayBuffer(), headers: response.headers };
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
      created.innerHTML = `<span class="offline-dot" aria-hidden="true"></span><span>Can't reach Cairn — saved logs will retry</span>`;
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
    try {
      void flushOutbox();
    } catch {}
  }
}

// ============================================================================
// Offline outbox — never lose a gym-floor log.
// ============================================================================
// The queue core (createOutbox) is a pure, storage-injected unit — no DOM, no
// network — so its replay/ordering logic is fully testable. The runtime layer
// below wires it to the live api() + the "N to sync" affordance.

type OutboxItem = {
  id: string;
  ts: number;
  kind: string;
  path: string;
  method?: "POST" | "DELETE";
  body: unknown;
  session_date?: string;
  state?: "pending" | "sending" | "prepared" | "needs_attention";
  in_flight_until?: number;
  claim_token?: string;
  failure_status?: number;
  depends_on?: string;
  group_id?: string;
  prepare_intent?: Record<string, unknown>;
  retry_body?: Record<string, unknown>;
  retry_intent?: Record<string, unknown>;
};
type OutboxStore = Pick<Storage, "getItem" | "setItem">;
type OutboxDrainResult = { sent: number; remaining: number; needsAttention: number };
type OutboxSendResult = undefined | "needs_attention";
type OutboxReviewEntry = { item: OutboxItem; role: "attention" | "blocked_dependent" };
type ClaimedOutboxItem = OutboxItem & {
  state: "sending";
  in_flight_until: number;
  claim_token: string;
};
type OutboxClaimResult = { item: ClaimedOutboxItem | null; blockedUntil?: number; storageError?: boolean };
type OutboxController = {
  enqueue(entry: {
    id?: string;
    kind: string;
    path: string;
    method?: "POST" | "DELETE";
    body: unknown;
    session_date?: string;
    state?: "pending" | "sending";
    in_flight_until?: number;
    claim_token?: string;
    depends_on?: string;
    group_id?: string;
    prepare_intent?: Record<string, unknown>;
    retry_body?: Record<string, unknown>;
    retry_intent?: Record<string, unknown>;
  }): OutboxItem | null;
  allocateId(): string;
  allocateClaimToken(): string;
  list(): OutboxItem[];
  review(): OutboxReviewEntry[];
  count(): number;
  retry(id: string): boolean;
  claimNext(): OutboxClaimResult;
  settle(
    id: string,
    claimToken: string,
    outcome: "delivered" | "attention" | "pending",
    failureStatus?: number,
  ): boolean;
  remove(id: string): boolean;
  hasDependents(id: string): boolean;
  clear(): void;
  drain(send: (item: OutboxItem) => Promise<OutboxSendResult>): Promise<OutboxDrainResult>;
};

const OUTBOX_KEY = "cairn.outbox.v1";
const OUTBOX_MAX = 250;
const OUTBOX_SEND_CLAIM_MS = 30_000;
const OUTBOX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const OUTBOX_WORKOUT_KINDS = new Set(["daily_session_prepare", "set", "finish", "skip", "restore"]);

function validOutboxId(value: unknown): value is string {
  return typeof value === "string" && OUTBOX_ID_RE.test(value);
}

function normalizedOutboxSessionDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function inferredOutboxSessionDate(kind: unknown, explicit: unknown, body: unknown): string | null {
  if (!OUTBOX_WORKOUT_KINDS.has(String(kind || ""))) return null;
  const direct = normalizedOutboxSessionDate(explicit);
  if (direct) return direct;
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  return normalizedOutboxSessionDate(record?.date);
}

// ---------- pure core: a durable FIFO queue over injected storage ----------
function createOutbox(opts: {
  storage: OutboxStore;
  now?: () => number;
  key?: string;
  max?: number;
}): OutboxController {
  const storage = opts.storage;
  const now = opts.now || (() => Date.now());
  const key = opts.key || OUTBOX_KEY;
  const max = opts.max && opts.max > 0 ? opts.max : OUTBOX_MAX;
  let seq = 0;
  let claimSeq = 0;

  function isItem(value: unknown): value is OutboxItem {
    return (
      !!value &&
      typeof value === "object" &&
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
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isItem).map((item) => {
        if (item.session_date) return item;
        const sessionDate = inferredOutboxSessionDate(item.kind, null, item.body);
        return sessionDate ? { ...item, session_date: sessionDate } : item;
      });
    } catch {
      return [];
    }
  }
  function write(items: OutboxItem[]): { items: OutboxItem[]; persisted: boolean } {
    const serialized = JSON.stringify(items);
    try {
      storage.setItem(key, serialized);
      return { items, persisted: storage.getItem(key) === serialized };
    } catch {
      return { items: read(), persisted: false };
    }
  }
  function allocateId(): string {
    const existing = new Set(read().map((item) => item.id));
    let candidate = "";
    do {
      seq = (seq + 1) % 1_000_000;
      candidate = `${now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    } while (existing.has(candidate));
    return candidate;
  }
  function allocateClaimToken(): string {
    const existing = new Set(read().map((item) => item.claim_token).filter(Boolean));
    let candidate = "";
    do {
      claimSeq = (claimSeq + 1) % 1_000_000;
      candidate = `claim:${now().toString(36)}:${claimSeq.toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    } while (existing.has(candidate));
    return candidate;
  }
  function enqueue(entry: {
    id?: string;
    kind: string;
    path: string;
    method?: "POST" | "DELETE";
    body: unknown;
    session_date?: string;
    state?: "pending" | "sending";
    in_flight_until?: number;
    claim_token?: string;
    depends_on?: string;
    group_id?: string;
    prepare_intent?: Record<string, unknown>;
    retry_body?: Record<string, unknown>;
    retry_intent?: Record<string, unknown>;
  }): OutboxItem | null {
    if (entry.id != null && !validOutboxId(entry.id)) return null;
    if (entry.claim_token != null && !validOutboxId(entry.claim_token)) return null;
    if (entry.state === "sending" && !entry.claim_token) return null;
    const sessionDate = inferredOutboxSessionDate(entry.kind, entry.session_date, entry.body);
    const item: OutboxItem = {
      id: entry.id || allocateId(),
      ts: now(),
      kind: String(entry.kind || "log"),
      path: String(entry.path || ""),
      ...(entry.method === "DELETE" ? { method: "DELETE" as const } : {}),
      body: entry.body,
      ...(sessionDate ? { session_date: sessionDate } : {}),
      ...(entry.state ? { state: entry.state } : {}),
      ...(entry.in_flight_until != null && Number.isFinite(entry.in_flight_until)
        ? { in_flight_until: Number(entry.in_flight_until) }
        : {}),
      ...(entry.state === "sending" && entry.claim_token ? { claim_token: entry.claim_token } : {}),
      ...(entry.depends_on ? { depends_on: String(entry.depends_on) } : {}),
      ...(entry.group_id ? { group_id: String(entry.group_id) } : {}),
      ...(entry.prepare_intent ? { prepare_intent: entry.prepare_intent } : {}),
      ...(entry.retry_body ? { retry_body: entry.retry_body } : {}),
      ...(entry.retry_intent ? { retry_intent: entry.retry_intent } : {}),
    };
    const items = read();
    if (items.some((candidate) => candidate.id === item.id)) return null;
    const prerequisite = entry.depends_on
      ? items.find((candidate) => candidate.id === entry.depends_on && candidate.kind === "daily_session_prepare")
      : null;
    const group = entry.group_id
      ? items.find((candidate) => candidate.group_id === entry.group_id)
      : null;
    if (entry.depends_on && !prerequisite) return null;
    // Never make room by deleting a previously confirmed log. A dependency
    // group that already owns its prepare barrier may continue past the nominal
    // cap so a workout transaction is never split; every new independent item
    // is rejected honestly once capacity is reached.
    if (items.length >= max && !prerequisite && !group) return null;
    items.push(item);
    const result = write(items);
    return result.persisted && result.items.some((candidate) => candidate.id === item.id) ? item : null;
  }
  function list(): OutboxItem[] {
    return read();
  }
  function count(): number {
    return read().length;
  }
  function review(): OutboxReviewEntry[] {
    const items = read();
    const attentionPrepareIds = new Set(
      items
        .filter((item) => item.kind === "daily_session_prepare" && item.state === "needs_attention")
        .map((item) => item.id),
    );
    const attentionGroupIds = new Set(
      items
        .filter((item) => item.state === "needs_attention" && item.group_id)
        .map((item) => item.group_id as string),
    );
    const rows: OutboxReviewEntry[] = [];
    for (const item of items) {
      // A currently owned generation is in delivery, never a review decision.
      // In particular, do not expose discard/retry affordances for it merely
      // because another member of the workout group needs attention.
      if (item.state === "sending") continue;
      if (item.state === "needs_attention") rows.push({ item, role: "attention" });
      else if (
        item.depends_on &&
        attentionPrepareIds.has(item.depends_on)
      ) {
        rows.push({ item, role: "blocked_dependent" });
      } else if (
        item.group_id &&
        attentionGroupIds.has(item.group_id)
      ) {
        rows.push({ item, role: "blocked_dependent" });
      }
    }
    return rows;
  }
  function retry(id: string): boolean {
    const items = read();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const current = items[index];
    if (current.state !== "needs_attention") return false;
    const freshId = allocateId();
    if (current.kind === "daily_session_prepare") {
      const body = current.retry_body || (
        current.body && typeof current.body === "object"
          ? { ...(current.body as Record<string, unknown>), replace: true }
          : current.body
      );
      const {
        state: _state,
        failure_status: _failureStatus,
        in_flight_until: _inFlightUntil,
        claim_token: _claimToken,
        ...pending
      } = current;
      items[index] = {
        ...pending,
        id: freshId,
        ts: now(),
        body,
        ...(current.retry_intent ? { prepare_intent: current.retry_intent } : {}),
      };
      for (let i = 0; i < items.length; i++) {
        if (items[i].depends_on === id) items[i] = { ...items[i], depends_on: freshId };
      }
      const result = write(items);
      return result.persisted && result.items.some((item) => item.id === freshId);
    }
    const {
      state: _state,
      failure_status: _failureStatus,
      in_flight_until: _inFlightUntil,
      claim_token: _claimToken,
      ...pending
    } = current;
    items[index] = { ...pending, id: freshId, ts: now() };
    for (let i = 0; i < items.length; i++) {
      if (items[i].depends_on === id) items[i] = { ...items[i], depends_on: freshId };
    }
    const result = write(items);
    return result.persisted && result.items.some((item) => item.id === freshId);
  }
  function hasDependents(id: string): boolean {
    return read().some((item) => item.depends_on === id);
  }
  function claimNext(): OutboxClaimResult {
    const items = read();
    const attentionGroupIds = new Set(
      items
        .filter((item) => item.state === "needs_attention" && item.group_id)
        .map((item) => item.group_id as string),
    );
    const blockedGroupIds = new Set(attentionGroupIds);
    let blockedUntil: number | undefined;
    let dirty = false;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.state === "prepared") {
        if (!items.some((candidate) => candidate.depends_on === item.id)) {
          items.splice(index, 1);
          index--;
          dirty = true;
        }
        continue;
      }
      if (item.state === "needs_attention") {
        if (item.group_id) blockedGroupIds.add(item.group_id);
        continue;
      }
      const liveClaim = (
        item.state === "sending" &&
        validOutboxId(item.claim_token) &&
        Number(item.in_flight_until) > now()
      );
      if (liveClaim) {
        const until = Number(item.in_flight_until);
        blockedUntil = blockedUntil == null ? until : Math.min(blockedUntil, until);
        if (item.group_id) blockedGroupIds.add(item.group_id);
        continue;
      }
      if (item.group_id && blockedGroupIds.has(item.group_id)) continue;
      if (item.depends_on) {
        const prerequisite = items.find((candidate) => candidate.id === item.depends_on);
        if (!prerequisite || prerequisite.kind !== "daily_session_prepare") {
          const {
            in_flight_until: _inFlightUntil,
            claim_token: _claimToken,
            ...pending
          } = item;
          items[index] = { ...pending, state: "needs_attention" };
          if (item.group_id) blockedGroupIds.add(item.group_id);
          dirty = true;
          continue;
        }
        if (prerequisite.state !== "prepared") continue;
      }
      const claimed: ClaimedOutboxItem = {
        ...item,
        state: "sending" as const,
        in_flight_until: now() + OUTBOX_SEND_CLAIM_MS,
        claim_token: allocateClaimToken(),
      };
      items[index] = claimed;
      const result = write(items);
      return result.persisted
        ? { item: claimed, ...(blockedUntil != null ? { blockedUntil } : {}) }
        : { item: null, storageError: true, ...(blockedUntil != null ? { blockedUntil } : {}) };
    }
    if (dirty && !write(items).persisted) return { item: null, storageError: true, ...(blockedUntil != null ? { blockedUntil } : {}) };
    return { item: null, ...(blockedUntil != null ? { blockedUntil } : {}) };
  }
  function settle(
    id: string,
    claimToken: string,
    outcome: "delivered" | "attention" | "pending",
    failureStatus?: number,
  ): boolean {
    const items = read();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const item = items[index];
    if (item.state !== "sending" || !validOutboxId(claimToken) || item.claim_token !== claimToken) return false;
    if (outcome === "attention") {
      const {
        in_flight_until: _inFlightUntil,
        claim_token: _claimToken,
        ...pending
      } = item;
      items[index] = {
        ...pending,
        state: "needs_attention",
        ...(failureStatus != null ? { failure_status: failureStatus } : {}),
      };
      return write(items).persisted;
    }
    if (outcome === "pending") {
      const {
        state: _state,
        in_flight_until: _InFlightUntil,
        failure_status: _failureStatus,
        claim_token: _claimToken,
        ...pending
      } = item;
      items[index] = pending;
      return write(items).persisted;
    }
    if (item.kind === "daily_session_prepare" && items.some((candidate) => candidate.depends_on === item.id)) {
      const {
        in_flight_until: _inFlightUntil,
        claim_token: _claimToken,
        ...prepared
      } = item;
      items[index] = { ...prepared, state: "prepared" };
    } else {
      items.splice(index, 1);
    }
    if (item.depends_on && !items.some((candidate) => candidate.depends_on === item.depends_on)) {
      const prerequisiteIndex = items.findIndex(
        (candidate) => candidate.id === item.depends_on && candidate.state === "prepared",
      );
      if (prerequisiteIndex >= 0) items.splice(prerequisiteIndex, 1);
    }
    return write(items).persisted;
  }
  function removeDelivered(id: string): boolean {
    return write(read().filter((item) => item.id !== id)).persisted;
  }
  function remove(id: string): boolean {
    const items = read();
    const item = items.find((candidate) => candidate.id === id);
    if (!item || (item.kind === "daily_session_prepare" && items.some((candidate) => candidate.depends_on === id))) {
      return false;
    }
    let next = items.filter((candidate) => candidate.id !== id);
    if (item.depends_on) {
      const prerequisite = next.find((candidate) => candidate.id === item.depends_on);
      if (prerequisite?.state === "prepared" && !next.some((candidate) => candidate.depends_on === item.depends_on)) {
        next = next.filter((candidate) => candidate.id !== item.depends_on);
      }
    }
    return write(next).persisted;
  }
  function clear(): void {
    write([]);
  }

  // Replay queued POSTs oldest-first. `send` RESOLVES on delivery (the item is
  // dropped) and REJECTS on a transient failure (we STOP and keep this item and
  // every one after it for the next flush). Items enqueued DURING a drain (the
  // network dropped again mid-replay) land at the tail and survive, because
  // remove() always re-reads the freshly-stored queue.
  async function drain(send: (item: OutboxItem) => Promise<OutboxSendResult>): Promise<OutboxDrainResult> {
    let sent = 0;
    let needsAttention = 0;
    const queue = read();
    const attentionGroupIds = new Set(
      queue
        .filter((item) => item.state === "needs_attention" && item.group_id)
        .map((item) => item.group_id as string),
    );
    const blockedGroupIds = new Set(attentionGroupIds);
    for (const item of queue) {
      if (item.state === "prepared") {
        if (!hasDependents(item.id) && !removeDelivered(item.id)) break;
        continue;
      }
      if (item.state === "needs_attention") {
        needsAttention++;
        if (item.group_id) blockedGroupIds.add(item.group_id);
        // A staged workout has no server identity yet. Its exact prepare POST is
        // a FIFO barrier: dependent set/finish writes must not leapfrog a
        // permanent preparation rejection and attach to a different session.
        continue;
      }
      // Generation-aware sending rows are owned by runtime claim/settle. The
      // legacy pure drain never takes them over without a fresh claim token.
      if (item.state === "sending") {
        if (item.group_id) blockedGroupIds.add(item.group_id);
        continue;
      }
      if (item.group_id && blockedGroupIds.has(item.group_id)) continue;
      if (item.depends_on) {
        const prerequisite = read().find((candidate) => candidate.id === item.depends_on);
        if (!prerequisite || prerequisite.kind !== "daily_session_prepare") {
          const current = read();
          const index = current.findIndex((candidate) => candidate.id === item.id);
          if (index >= 0) {
            current[index] = { ...current[index], state: "needs_attention" };
            if (!write(current).persisted) break;
          }
          needsAttention++;
          if (item.group_id) blockedGroupIds.add(item.group_id);
          continue;
        }
        if (prerequisite.state !== "prepared") continue;
      }
      let result: OutboxSendResult;
      try {
        result = await send(item);
      } catch {
        break;
      }
      if (result === "needs_attention") {
        const current = read();
        const index = current.findIndex((row) => row.id === item.id);
        if (index >= 0) {
          const {
            in_flight_until: _inFlightUntil,
            claim_token: _claimToken,
            ...pending
          } = current[index];
          current[index] = { ...pending, state: "needs_attention", failure_status: item.failure_status };
          if (!write(current).persisted) break;
        }
        needsAttention++;
        if (item.group_id) blockedGroupIds.add(item.group_id);
        continue;
      }
      if (item.kind === "daily_session_prepare" && hasDependents(item.id)) {
        const current = read();
        const index = current.findIndex((candidate) => candidate.id === item.id);
        if (index >= 0) {
          current[index] = { ...current[index], state: "prepared" };
          if (!write(current).persisted) break;
        }
      } else {
        if (!removeDelivered(item.id)) break;
      }
      if (item.depends_on) {
        const current = read();
        const prerequisite = current.find((candidate) => candidate.id === item.depends_on);
        if (prerequisite?.state === "prepared" && !current.some((candidate) => candidate.depends_on === item.depends_on)) {
          if (!removeDelivered(item.depends_on)) break;
        }
      }
      sent++;
    }
    return { sent, remaining: count(), needsAttention };
  }

  return {
    enqueue,
    allocateId,
    allocateClaimToken,
    list,
    review,
    count,
    retry,
    claimNext,
    settle,
    remove,
    hasDependents,
    clear,
    drain,
  };
}

// ---------- runtime: one live queue wired to api() + the affordance ----------
function storageForOutbox(): OutboxStore {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {}
  // Private-mode / disabled storage → an in-memory queue for this session, so a
  // log is at least held until the tab closes rather than dropped outright.
  const mem = new Map<string, string>();
  return {
    getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k, v) => {
      mem.set(k, String(v));
    },
  };
}

let outboxController: OutboxController | null = null;
const outboxBlockedStagedDates = new Set<string>();
function outbox(): OutboxController {
  if (!outboxController) outboxController = createOutbox({ storage: storageForOutbox() });
  return outboxController;
}

// Runtime mutations are serialized across tabs with Web Locks. Older browsers
// use a short renewable localStorage lease plus an in-tab promise tail. The
// lease is advisory (localStorage has no compare-and-swap), but the yield-then-
// verify acquisition prevents the classic simultaneous read/write winner loss.
// Every session mutation now owns its server idempotency key before the direct
// request, so even a suspended tab that outlives the lease cannot double-apply
// that same mutation when its lost response falls back to replay. The advisory
// path can still lose strict ordering between two genuinely distinct mutations.
const OUTBOX_RUNTIME_LOCK = "cairn-outbox-v1";
const OUTBOX_RUNTIME_LEASE_KEY = `${OUTBOX_KEY}.lock`;
const OUTBOX_RUNTIME_LEASE_MS = 30_000;
const outboxRuntimeOwner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let outboxRuntimeLockSeq = 0;
let outboxRuntimeTail: Promise<unknown> = Promise.resolve();

function outboxLockStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage !== "undefined" && localStorage ? localStorage : null;
  } catch {
    return null;
  }
}

function outboxLeaseOwner(storage: Pick<Storage, "getItem">): { owner: string; expires: number } | null {
  try {
    const parsed = JSON.parse(storage.getItem(OUTBOX_RUNTIME_LEASE_KEY) || "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as { owner?: unknown; expires?: unknown };
    return typeof row.owner === "string" && Number.isFinite(Number(row.expires))
      ? { owner: row.owner, expires: Number(row.expires) }
      : null;
  } catch {
    return null;
  }
}

function outboxLockPause(delay = 0): Promise<void> {
  if (typeof setTimeout !== "function") return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function withOutboxStorageLease<T>(work: () => Promise<T> | T): Promise<T> {
  const storage = outboxLockStorage();
  if (!storage) return work();
  const owner = `${outboxRuntimeOwner}:${++outboxRuntimeLockSeq}`;
  for (;;) {
    const current = outboxLeaseOwner(storage);
    const now = Date.now();
    if (!current || current.expires <= now) {
      try {
        storage.setItem(OUTBOX_RUNTIME_LEASE_KEY, JSON.stringify({ owner, expires: now + OUTBOX_RUNTIME_LEASE_MS }));
        await outboxLockPause(0);
        if (outboxLeaseOwner(storage)?.owner === owner) break;
      } catch {
        // Storage-disabled contexts have no cross-tab durable queue to protect;
        // the in-tab promise tail below remains the relevant fallback.
        return work();
      }
    }
    await outboxLockPause(18 + Math.floor(Math.random() * 17));
  }

  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const renew = (): void => {
    if (stopped || outboxLeaseOwner(storage)?.owner !== owner) return;
    try {
      storage.setItem(
        OUTBOX_RUNTIME_LEASE_KEY,
        JSON.stringify({ owner, expires: Date.now() + OUTBOX_RUNTIME_LEASE_MS }),
      );
    } catch {}
    if (typeof setTimeout === "function") renewTimer = setTimeout(renew, OUTBOX_RUNTIME_LEASE_MS / 3);
  };
  renew();
  try {
    return await work();
  } finally {
    stopped = true;
    if (renewTimer != null && typeof clearTimeout === "function") clearTimeout(renewTimer);
    try {
      if (outboxLeaseOwner(storage)?.owner === owner) storage.removeItem(OUTBOX_RUNTIME_LEASE_KEY);
    } catch {}
  }
}

function withOutboxRuntimeLock<T>(work: () => Promise<T> | T): Promise<T> {
  const locks = typeof navigator !== "undefined"
    ? (navigator as Navigator & { locks?: { request?<R>(name: string, callback: () => Promise<R> | R): Promise<R> } }).locks
    : undefined;
  if (typeof locks?.request === "function") return locks.request(OUTBOX_RUNTIME_LOCK, work);
  const run = outboxRuntimeTail.then(() => withOutboxStorageLease(work), () => withOutboxStorageLease(work));
  outboxRuntimeTail = run.then(() => undefined, () => undefined);
  return run;
}

let outboxFlushing = false;
let outboxFlushAgain = false;
let outboxFlushWaiters: Array<() => void> = [];
let outboxClaimRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOutboxClaimRetry(blockedUntil: number | undefined): void {
  if (blockedUntil == null || typeof setTimeout !== "function") return;
  if (outboxClaimRetryTimer != null && typeof clearTimeout === "function") clearTimeout(outboxClaimRetryTimer);
  const delay = Math.max(0, Math.min(OUTBOX_SEND_CLAIM_MS, blockedUntil - Date.now() + 25));
  outboxClaimRetryTimer = setTimeout(() => {
    outboxClaimRetryTimer = null;
    void flushOutbox();
  }, delay);
}

function escapeOutboxHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function boundedOutboxText(value: unknown, max = 140): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function outboxKindLabel(kind: unknown): string {
  switch (String(kind || "").toLowerCase()) {
    case "activity": return "Activity";
    case "food": return "Food";
    case "weight": return "Weight";
    case "set": return "Training set";
    case "finish": return "Session finish";
    case "skip": return "Exercise skip";
    case "restore": return "Exercise restore";
    case "daily_session_prepare": return "Session setup";
    default: return "Saved log";
  }
}

function outboxItemSummary(item: OutboxItem): string {
  const body = item.body && typeof item.body === "object" ? item.body as Record<string, unknown> : {};
  if (item.kind === "weight" && Number.isFinite(Number(body.weight_lb))) {
    return `${Number(body.weight_lb)} lb`;
  }
  if (item.kind === "food") {
    const meal = boundedOutboxText(body.meal, 24);
    const text = boundedOutboxText(body.text);
    return boundedOutboxText([meal, text].filter(Boolean).join(" · ")) || "Saved food log";
  }
  if (item.kind === "activity") return boundedOutboxText(body.text) || "Saved activity log";
  if (item.kind === "set") {
    const exercise = boundedOutboxText(body.exercise, 64);
    const duration = Number(body.duration_sec);
    if (Number.isFinite(duration) && duration > 0) return boundedOutboxText(`${exercise || "Timed set"} · ${duration}s`);
    const weight = Number(body.weight);
    const reps = Number(body.reps);
    const detail = [Number.isFinite(weight) ? `${weight} lb` : "", Number.isFinite(reps) ? `${reps} reps` : ""]
      .filter(Boolean).join(" × ");
    return boundedOutboxText([exercise, detail].filter(Boolean).join(" · ")) || "Saved training set";
  }
  if (item.kind === "finish") {
    const notes = boundedOutboxText(body.notes, 110);
    return notes ? `Finish session · ${notes}` : "Finish session";
  }
  if (item.kind === "daily_session_prepare") {
    const date = boundedOutboxText(body.date, 20);
    return date ? `Prepare workout · ${date}` : "Prepare workout";
  }
  if (item.kind === "skip" || item.kind === "restore") {
    const exercise = boundedOutboxText(body.exercise, 80);
    return `${item.kind === "restore" ? "Restore" : "Skip"}${exercise ? ` · ${exercise}` : " exercise"}`;
  }
  return "Saved log";
}

function outboxItemTime(item: OutboxItem): string {
  const date = new Date(Number(item.ts));
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  try {
    return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString();
  }
}

let outboxReviewReturnFocus: HTMLElement | null = null;

function stagedCachePair(date: string): {
  session: Record<string, unknown>;
  daily: Record<string, unknown>;
  prepareId: string;
} | null {
  if (!date || typeof peekCached !== "function") return null;
  const session = peekCached<Record<string, unknown>>(`today:session:${date}`)?.data;
  const standaloneDaily = peekCached<Record<string, unknown>>(`today:daily-session:${date}`)?.data;
  if (!session || typeof session !== "object") return null;
  const nested = session.daily_session && typeof session.daily_session === "object"
    ? session.daily_session as Record<string, unknown>
    : null;
  const daily = nested || standaloneDaily;
  if (!daily || session._staged_offline !== true || daily._staged_offline !== true) return null;
  const sessionPair = String(session._local_prepare_id || "");
  const dailyPair = String(daily._local_prepare_id || "");
  return sessionPair && sessionPair === dailyPair ? { session, daily, prepareId: sessionPair } : null;
}

function rekeyStagedCachePair(date: string, previousId: string, nextId: string): boolean {
  const pair = stagedCachePair(date);
  if (!pair || pair.prepareId !== previousId || !nextId || typeof swrSet !== "function") return false;
  const daily = { ...pair.daily, _local_prepare_id: nextId };
  const session = { ...pair.session, _local_prepare_id: nextId, daily_session: daily };
  swrSet(`today:session:${date}`, session);
  swrSet(`today:daily-session:${date}`, daily);
  return true;
}

function clearMatchingStagedCachePair(date: string, prepareId: string): boolean {
  const pair = stagedCachePair(date);
  if (!pair || pair.prepareId !== prepareId || typeof swrInvalidate !== "function") return false;
  swrInvalidate(`today:session:${date}`);
  swrInvalidate(`today:daily-session:${date}`);
  outboxBlockedStagedDates.add(date);
  return true;
}

function closeOutboxReview(): void {
  if (typeof document === "undefined") return;
  const overlay = document.querySelector<HTMLElement>(".outbox-review-ov");
  if (!overlay) return;
  overlay.remove();
  try { outboxReviewReturnFocus?.focus(); } catch {}
  outboxReviewReturnFocus = null;
}

async function retryOutboxItem(id: string): Promise<boolean> {
  const result = await withOutboxRuntimeLock(() => {
    const box = outbox();
    const before = box.list();
    const index = before.findIndex((item) => item.id === id);
    const previous = index >= 0 ? before[index] : null;
    if (!previous || !box.retry(id)) return false;
    const replacement = box.list()[index];
    if (previous.kind === "daily_session_prepare" && replacement && replacement.id !== id) {
      rekeyStagedCachePair(String(previous.session_date || ""), id, replacement.id);
    }
    return true;
  });
  if (!result) return false;
  renderOutboxBar();
  await flushOutbox();
  return true;
}

async function discardOutboxItem(id: string): Promise<boolean> {
  let clearedDate = "";
  const result = await withOutboxRuntimeLock(() => {
    const box = outbox();
    const item = box.list().find((candidate) => candidate.id === id);
    if (!item || !box.remove(id)) return false;
    if (item.kind === "daily_session_prepare") {
      const date = String(item.session_date || "");
      if (clearMatchingStagedCachePair(date, id)) clearedDate = date;
    }
    return true;
  });
  if (!result) return false;
  renderOutboxBar();
  if (clearedDate) {
    const g = globalThis as {
      state?: { tab?: string; logDate?: string };
      activateTab?(tab: string): unknown;
    };
    if (g.state?.tab === "session" && g.state.logDate === clearedDate) {
      try { g.activateTab?.("today"); } catch {}
    }
  }
  // Removing the failed member is an explicit resolution of its workout-group
  // barrier. Let pending siblings resume immediately in their original order.
  await flushOutbox();
  return true;
}

function focusOutboxReviewControl(overlay: HTMLElement): void {
  const control = overlay.querySelector<HTMLElement>("[data-outbox-retry]") ||
    overlay.querySelector<HTMLElement>("[data-outbox-close]");
  try { control?.focus(); } catch {}
}

function renderOutboxReview(options: { focusControl?: boolean } = {}): void {
  if (typeof document === "undefined") return;
  const overlay = document.querySelector<HTMLElement>(".outbox-review-ov");
  if (!overlay) return;
  const sheet = overlay.querySelector<HTMLElement>(".outbox-review");
  if (!sheet) return;
  const review = outbox().review();
  if (!review.length) {
    closeOutboxReview();
    return;
  }
  const rows = review.map(({ item, role }) => {
    const hasDependents = item.kind === "daily_session_prepare" && outbox().hasDependents(item.id);
    const isPrepare = item.kind === "daily_session_prepare";
    const isBlocked = role === "blocked_dependent";
    const blockedByMember = isBlocked && !!item.group_id && outbox().list().some(
      (candidate) => candidate.state === "needs_attention" && candidate.group_id === item.group_id,
    );
    const status = isBlocked
      ? blockedByMember
        ? "Blocked behind an earlier workout change that needs attention. You can discard this log individually."
        : "Blocked until the saved session setup is resolved. You can discard this log individually."
      : isPrepare && hasDependents
        ? "Use saved session will replace a conflicting unstarted session. A session with started work stays locked."
      : item.failure_status != null
        ? `Cairn couldn't accept this log (${item.failure_status}).`
        : "Cairn couldn't accept this log.";
    return `<li class="outbox-review-item" data-outbox-id="${escapeOutboxHtml(item.id)}">
      <div class="outbox-review-copy">
        <div class="outbox-review-meta"><strong>${escapeOutboxHtml(outboxKindLabel(item.kind))}</strong><time>${escapeOutboxHtml(outboxItemTime(item))}</time></div>
        <p>${escapeOutboxHtml(outboxItemSummary(item))}</p>
        <small>${escapeOutboxHtml(status)}</small>
      </div>
      <div class="outbox-review-actions">
        ${isBlocked ? "" : `<button type="button" class="btn sm" data-outbox-retry>${isPrepare ? "Use saved session" : "Retry"}</button>`}
        <button type="button" class="btn sm ghost outbox-discard" data-outbox-discard${hasDependents ? " disabled aria-disabled=\"true\"" : ""}>Discard</button>
      </div>
    </li>`;
  }).join("");
  sheet.innerHTML = `<div class="outbox-review-head">
      <div><p class="eyebrow">Saved on this device</p><h2 id="outboxReviewTitle">Logs that need attention</h2></div>
      <button type="button" class="outbox-review-close" data-outbox-close aria-label="Close log review">×</button>
    </div>
    <p class="outbox-review-intro" id="outboxReviewIntro">Resolve the earliest saved workout item, or discard blocked changes one at a time. A session setup can be discarded only after every dependent log is gone.</p>
    <ul class="outbox-review-list">${rows}</ul>`;
  if (options.focusControl) focusOutboxReviewControl(overlay);
}

function openOutboxReview(): void {
  if (typeof document === "undefined") return;
  if (!outbox().list().some((item) => item.state === "needs_attention")) return;
  const existing = document.querySelector<HTMLElement>(".outbox-review-ov");
  if (existing) {
    existing.querySelector<HTMLElement>("[data-outbox-close]")?.focus();
    return;
  }
  outboxReviewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement("div");
  overlay.className = "outbox-review-ov";
  overlay.innerHTML = `<section class="outbox-review" role="dialog" aria-modal="true" aria-labelledby="outboxReviewTitle" aria-describedby="outboxReviewIntro"></section>`;
  overlay.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === overlay || target.closest("[data-outbox-close]")) {
      closeOutboxReview();
      return;
    }
    const row = target.closest<HTMLElement>("[data-outbox-id]");
    const id = row?.dataset.outboxId;
    if (!id) return;
    if (target.closest("[data-outbox-discard]")) {
      void discardOutboxItem(id).then((discarded) => {
        if (!discarded) {
        try { toast("Discard each saved workout log before discarding the session setup"); } catch {}
        }
        renderOutboxReview({ focusControl: true });
      });
      return;
    }
    const retry = target.closest<HTMLButtonElement>("[data-outbox-retry]");
    if (retry) {
      retry.disabled = true;
      retry.textContent = "Retrying…";
      void retryOutboxItem(id).finally(() => renderOutboxReview({ focusControl: true }));
    }
  });
  overlay.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOutboxReview();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...overlay.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.appendChild(overlay);
  renderOutboxReview();
  if (typeof setTimeout === "function") setTimeout(() => overlay.querySelector<HTMLElement>("[data-outbox-close]")?.focus(), 0);
  else overlay.querySelector<HTMLElement>("[data-outbox-close]")?.focus();
}

function renderOutboxBar(): void {
  if (typeof document === "undefined") return;
  const pending = outbox().count();
  const attention = outbox()
    .list()
    .filter((item) => item.state === "needs_attention").length;
  const reviewCount = outbox().review().length;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  let bar = document.querySelector<HTMLElement>(".outbox-bar");
  // While offline the warm `.offline-bar` already promises the logs are saved and
  // will retry — don't stack a second band under it. Surface the count only when
  // we're online (actively retrying, or holding until the drain lands).
  if (pending === 0 || offline) {
    if (bar) {
      bar.classList.remove("show");
      bar.classList.remove("outbox-actionable");
      bar.setAttribute("disabled", "");
      bar.setAttribute("role", "status");
      bar.removeAttribute("aria-label");
    }
    return;
  }
  if (!bar) {
    bar = document.createElement("button");
    bar.className = "outbox-bar";
    bar.setAttribute("type", "button");
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    bar.addEventListener("click", openOutboxReview);
    document.body.appendChild(bar);
  }
  const label = attention ? "Needs attention" : outboxFlushing ? "Syncing" : "Waiting to sync";
  const displayCount = attention ? reviewCount : pending;
  const noun = attention ? "saved item" : "log";
  bar.innerHTML = `<span class="outbox-dot" aria-hidden="true"></span><span class="outbox-txt">${label} · ${displayCount} ${noun}${displayCount === 1 ? "" : "s"}</span>`;
  bar.classList.toggle("outbox-actionable", attention > 0);
  if (attention > 0) {
    bar.removeAttribute("role");
    bar.removeAttribute("disabled");
    bar.setAttribute("aria-label", `${reviewCount} saved item${reviewCount === 1 ? "" : "s"} need attention. Review saved items.`);
  } else {
    bar.setAttribute("role", "status");
    bar.setAttribute("disabled", "");
    bar.removeAttribute("aria-label");
  }
  const shown = bar;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => shown.classList.add("show"));
  else shown.classList.add("show");
}

type PreparedReplayTruth = { date: string; session: Record<string, unknown>; dailySession: Record<string, unknown> };

function storePreparedReplayTruth(truth: PreparedReplayTruth): void {
  const g = globalThis as { swrSet?(key: string, data: unknown): void; swrInvalidate?(key: string): void };
  g.swrSet?.(`today:session:${truth.date}`, truth.session);
  g.swrSet?.(`today:daily-session:${truth.date}`, truth.dailySession);
  g.swrInvalidate?.(`today:aggregate:${truth.date}`);
  outboxBlockedStagedDates.delete(truth.date);
}

function normalizedPrepareValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedPrepareValue);
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) normalized[key] = normalizedPrepareValue(entry);
    }
    return normalized;
  }
  return value ?? null;
}

function sameNormalizedPrepareValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedPrepareValue(left)) === JSON.stringify(normalizedPrepareValue(right));
}

function samePrepareIntent(item: OutboxItem, dailySession: Record<string, unknown>): boolean {
  const expected = item.prepare_intent;
  if (!expected) return false;
  for (const key of ["date", "source", "plan_day_id", "title", "focus", "est_minutes"] as const) {
    if ((expected[key] ?? null) !== (dailySession[key] ?? null)) return false;
  }
  const planSource = expected.source === "adaptive_plan" || expected.source === "manual_plan";
  if (!planSource && (expected.why ?? null) !== (dailySession.why ?? null)) return false;
  if (
    Object.prototype.hasOwnProperty.call(expected, "constraints") &&
    !sameNormalizedPrepareValue(expected.constraints, dailySession.constraints)
  ) return false;
  if (Object.prototype.hasOwnProperty.call(expected, "provenance")) {
    const expectedProvenance = expected.provenance && typeof expected.provenance === "object"
      ? expected.provenance as Record<string, unknown>
      : null;
    const actualProvenance = dailySession.provenance && typeof dailySession.provenance === "object"
      ? dailySession.provenance as Record<string, unknown>
      : null;
    if (!expectedProvenance || !actualProvenance) {
      if (!sameNormalizedPrepareValue(expectedProvenance, actualProvenance)) return false;
    } else {
      if (expected.source === "agent_suggest") {
        const expectedJobId = Number(expectedProvenance.agent_job_id);
        if (!Number.isInteger(expectedJobId) || expectedJobId <= 0) return false;
        if (Number(actualProvenance.agent_job_id) !== expectedJobId) return false;
      }
      // Compare every provenance promise the client persisted, but tolerate
      // server-owned enrichment fields added to the canonical record.
      for (const key of Object.keys(expectedProvenance)) {
        if (!Object.prototype.hasOwnProperty.call(actualProvenance, key)) return false;
        if (!sameNormalizedPrepareValue(expectedProvenance[key], actualProvenance[key])) return false;
      }
    }
  }
  const expectedItems = Array.isArray(expected.items) ? expected.items : [];
  const actualItems = Array.isArray(dailySession.items) ? dailySession.items : [];
  if (expectedItems.length !== actualItems.length) return false;
  const fields = [
    "position", "kind", "exercise", "sets", "rep_low", "rep_high", "target_weight", "target_seconds",
    "warmup_sets", "mode", "note", "target_distance_km", "target_duration_min", "target_zone", "interval",
    "superset_group",
  ] as const;
  return expectedItems.every((expectedItem, index) => {
    if (!expectedItem || typeof expectedItem !== "object") return false;
    const actualItem = actualItems[index];
    if (!actualItem || typeof actualItem !== "object") return false;
    const expectedRow = expectedItem as Record<string, unknown>;
    const actualRow = actualItem as Record<string, unknown>;
    return fields.every((field) => {
      if (!(field in expectedRow)) return true;
      return sameNormalizedPrepareValue(expectedRow[field], actualRow[field]);
    });
  });
}

function canonicalPreparedReplay(item: OutboxItem, value: unknown): PreparedReplayTruth | null {
  if (item.kind !== "daily_session_prepare" || !value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  const request = item.body && typeof item.body === "object" ? item.body as Record<string, unknown> : {};
  const session = response.session && typeof response.session === "object"
    ? response.session as Record<string, unknown>
    : null;
  const dailySession = response.daily_session && typeof response.daily_session === "object"
    ? response.daily_session as Record<string, unknown>
    : null;
  const date = String(request.date || "");
  if (response.ok !== true || !date || !session || !dailySession) return null;
  if (String(dailySession.date || "") !== date || (session.date != null && String(session.date) !== date)) return null;
  const expectedActiveId = Number(request.expected_active_id);
  if (Number.isInteger(expectedActiveId) && expectedActiveId > 0) {
    if (Number(dailySession.id) !== expectedActiveId) return null;
  } else if (String(dailySession.source || "") !== String(request.source || "")) return null;
  if (!samePrepareIntent(item, dailySession)) return null;
  return { date, session, dailySession };
}

function replayHasSemanticFailure(item: OutboxItem, value: unknown): boolean {
  if (!value || typeof value !== "object") return item.kind === "skip" || item.kind === "restore";
  const response = value as Record<string, unknown>;
  if (response.ok === false) return true;
  if (
    Object.prototype.hasOwnProperty.call(response, "error") &&
    response.error != null &&
    response.error !== "" &&
    response.error !== false
  ) return true;
  return (item.kind === "skip" || item.kind === "restore") && response.ok !== true;
}

function freshenAfterSync(prepared: PreparedReplayTruth[] = []): void {
  const g = globalThis as Record<string, unknown> & {
    swrInvalidate?(keyOrPrefix: string): void;
    reshapeToday?(): unknown;
    renderSession?(opts?: unknown): unknown;
    state?: { tab?: string; brief?: unknown };
  };
  try {
    g.swrInvalidate?.("stats");
    g.swrInvalidate?.("plan");
    g.swrInvalidate?.("today:session:");
    g.swrInvalidate?.("today:daily-session:");
    g.swrInvalidate?.("history:sessions");
    g.swrInvalidate?.("progress:volume");
    g.swrInvalidate?.("progress:energy");
    if (g.state) g.state.brief = null;
    for (const truth of prepared) storePreparedReplayTruth(truth);
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
  if (outboxFlushing) {
    outboxFlushAgain = true;
    renderOutboxBar();
    await new Promise<void>((resolve) => outboxFlushWaiters.push(resolve));
    return;
  }
  if (box.count() === 0) {
    renderOutboxBar();
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    renderOutboxBar();
    return;
  }

  outboxFlushing = true;
  renderOutboxBar();
  let sent = 0;
  let blockedUntil: number | undefined;
  const canonicalByDate = new Map<string, PreparedReplayTruth>();
  const mutatedPreparedDates = new Set<string>();
  try {
    do {
      outboxFlushAgain = false;
      for (;;) {
        const claim = await withOutboxRuntimeLock(() => box.claimNext());
        if (claim.blockedUntil != null) {
          blockedUntil = blockedUntil == null ? claim.blockedUntil : Math.min(blockedUntil, claim.blockedUntil);
        }
        if (!claim.item || claim.storageError) break;
        const item = claim.item;
        let outcome: "delivered" | "attention" | "pending" = "delivered";
        let failureStatus: number | undefined;
        try {
          const response = await api(item.path as string, {
            method: item.method === "DELETE" ? "DELETE" : "POST",
            headers: { "Content-Type": "application/json", "X-Idempotency-Key": item.id },
            body: JSON.stringify(item.body),
          });
          if (replayHasSemanticFailure(item, response)) outcome = "attention";
          else if (item.kind === "daily_session_prepare") {
            const canonical = canonicalPreparedReplay(item, response);
            if (!canonical) outcome = "attention";
            else {
              storePreparedReplayTruth(canonical);
              canonicalByDate.set(canonical.date, canonical);
            }
          } else if (item.depends_on) {
            if (item.session_date) mutatedPreparedDates.add(item.session_date);
          }
        } catch (error) {
          if (isTransientApiFailure(error)) outcome = "pending";
          else {
            outcome = "attention";
            if (error instanceof CairnApiError && error.status != null) failureStatus = error.status;
          }
        }
        const settled = await withOutboxRuntimeLock(() =>
          box.settle(item.id, item.claim_token, outcome, failureStatus)
        );
        renderOutboxBar();
        if (!settled || outcome === "pending") break;
        if (outcome === "delivered") sent++;
      }
    } while (
      outboxFlushAgain &&
      box.count() > 0 &&
      (typeof navigator === "undefined" || navigator.onLine !== false)
    );
  } finally {
    outboxFlushing = false;
    outboxFlushAgain = false;
    const waiters = outboxFlushWaiters;
    outboxFlushWaiters = [];
    for (const resolve of waiters) resolve();
  }
  renderOutboxBar();
  scheduleOutboxClaimRetry(blockedUntil);
  if (sent > 0) {
    const prepared = [...canonicalByDate.values()].filter((truth) => !mutatedPreparedDates.has(truth.date));
    freshenAfterSync(prepared);
    try {
      toast(`${sent} log${sent === 1 ? "" : "s"} synced`);
    } catch {}
  }
}

// Public enqueue: hold a failed POST and update the affordance. Callers pass the
// exact path + JSON body they tried, so replay is byte-for-byte the original write.
function outboxSessionPrerequisite(date: string): {
  status: "none" | "ready" | "blocked";
  id: string | null;
  reason?: "attention" | "other_tab" | "phantom";
} {
  const normalizedDate = String(date || "");
  const sharedPrepares = outbox().list().filter((item) => {
    return item.kind === "daily_session_prepare" && item.session_date === normalizedDate;
  });
  const pair = stagedCachePair(date);
  if (!pair) {
    if (sharedPrepares.length > 0) {
      return { status: "blocked", id: sharedPrepares[0].id, reason: "other_tab" };
    }
    return outboxBlockedStagedDates.has(date)
      ? { status: "blocked", id: null, reason: "phantom" }
      : { status: "none", id: null };
  }
  const prerequisite = sharedPrepares.find((item) => item.id === pair.prepareId);
  if (!prerequisite) {
    if (sharedPrepares.length > 0) {
      return { status: "blocked", id: sharedPrepares[0].id, reason: "other_tab" };
    }
    clearMatchingStagedCachePair(date, pair.prepareId);
    return { status: "blocked", id: null, reason: "phantom" };
  }
  if (sharedPrepares.length !== 1) {
    return { status: "blocked", id: prerequisite.id, reason: "other_tab" };
  }
  if (prerequisite.state === "needs_attention") {
    return { status: "blocked", id: prerequisite.id, reason: "attention" };
  }
  return { status: "ready", id: prerequisite.id };
}

function outboxResolveSessionPrerequisite(date: string): void {
  outboxBlockedStagedDates.delete(String(date || ""));
}

function outboxBlockSessionPrerequisite(date: string): void {
  const normalized = String(date || "");
  if (normalized) outboxBlockedStagedDates.add(normalized);
}

function outboxSessionDependency(date: string): string | null {
  const prerequisite = outboxSessionPrerequisite(date);
  return prerequisite.status === "ready" ? prerequisite.id : null;
}

function positiveOutboxIdentity(value: unknown): string | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function firstPositiveOutboxIdentity(...values: unknown[]): string | null {
  for (const value of values) {
    const identity = positiveOutboxIdentity(value);
    if (identity) return identity;
  }
  return null;
}

function outboxSessionGroupId(
  date: string,
  identity: { dailySessionId?: unknown; sessionId?: unknown } = {},
): string {
  const normalizedDate = String(date || "").trim();
  const queued = outbox().list();
  const queuedGroup = queued.find((item) => {
    return !!item.group_id && item.session_date === normalizedDate;
  })?.group_id;
  // Once a date-fallback group exists it remains the durable identity through
  // staged -> canonical reconciliation and any attention/retry cycle.
  if (queuedGroup) return queuedGroup;
  let cachedSession: Record<string, unknown> | null = null;
  let cachedDaily: Record<string, unknown> | null = null;
  if (normalizedDate && typeof peekCached === "function") {
    cachedSession = peekCached<Record<string, unknown>>(`today:session:${normalizedDate}`)?.data || null;
    cachedDaily = cachedSession?.daily_session && typeof cachedSession.daily_session === "object"
      ? cachedSession.daily_session as Record<string, unknown>
      : peekCached<Record<string, unknown>>(`today:daily-session:${normalizedDate}`)?.data || null;
  }
  const stagedPair = normalizedDate ? stagedCachePair(normalizedDate) : null;
  if (stagedPair && queued.some((item) => item.id === stagedPair.prepareId)) {
    return `prepare:${stagedPair.prepareId}`;
  }
  // The server session is the canonical workout identity. A daily composition's
  // own id describes the prescription snapshot, not the workout receiving sets,
  // skips, and finish, so it is only a last-resort canonical fallback.
  const sessionId = firstPositiveOutboxIdentity(
    identity.sessionId,
    cachedSession?.id,
    cachedDaily?.session_id,
  );
  if (sessionId) return `session:${sessionId}`;
  const dailyId = firstPositiveOutboxIdentity(identity.dailySessionId, cachedDaily?.id);
  if (dailyId) return `daily:${dailyId}`;
  return `date:${normalizedDate || "unknown"}`;
}

type OutboxEnqueueRuntimeOptions = {
  dependsOn?: string | null;
  groupId?: string | null;
  sessionDate?: string | null;
  method?: "POST" | "DELETE";
  prepareIntent?: Record<string, unknown> | null;
  retryBody?: Record<string, unknown> | null;
  retryIntent?: Record<string, unknown> | null;
  itemId?: string | null;
  state?: "pending" | "sending";
  inFlightUntil?: number | null;
  claimToken?: string | null;
};

function enqueueOutboxUnlocked(
  kind: string,
  path: string,
  body: unknown,
  options: OutboxEnqueueRuntimeOptions = {},
): OutboxItem | null {
  return outbox().enqueue({
    ...(options.itemId ? { id: options.itemId } : {}),
    kind,
    path,
    ...(options.method === "DELETE" ? { method: "DELETE" as const } : {}),
    body,
    ...(options.sessionDate ? { session_date: options.sessionDate } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.inFlightUntil != null ? { in_flight_until: options.inFlightUntil } : {}),
    ...(options.claimToken ? { claim_token: options.claimToken } : {}),
    ...(options.dependsOn ? { depends_on: options.dependsOn } : {}),
    ...(options.groupId ? { group_id: options.groupId } : {}),
    ...(options.prepareIntent ? { prepare_intent: options.prepareIntent } : {}),
    ...(options.retryBody ? { retry_body: options.retryBody } : {}),
    ...(options.retryIntent ? { retry_intent: options.retryIntent } : {}),
  });
}

async function outboxEnqueue(
  kind: string,
  path: string,
  body: unknown,
  options: OutboxEnqueueRuntimeOptions = {},
): Promise<OutboxItem | null> {
  const item = await withOutboxRuntimeLock(() => enqueueOutboxUnlocked(kind, path, body, options));
  renderOutboxBar();
  return item;
}

type OutboxSessionMutationResult =
  | { status: "sent"; value: unknown; groupId: string }
  | { status: "queued"; item: OutboxItem; groupId: string }
  | {
      status: "blocked";
      reason: "attention" | "other_tab" | "phantom";
      prerequisiteId: string | null;
      groupId: string;
    }
  | { status: "storage_error"; groupId: string }
  | { status: "failed"; error: unknown; groupId: string };
type OutboxSessionMutationPlan =
  | OutboxSessionMutationResult
  | { status: "deliver"; item: ClaimedOutboxItem; groupId: string };

async function runSessionMutation(
  input: {
    date: string;
    kind: string;
    path: string;
    body: unknown;
    method?: "POST" | "DELETE";
    identity?: { dailySessionId?: unknown; sessionId?: unknown };
  },
  send: (idempotencyKey: string) => Promise<unknown>,
): Promise<OutboxSessionMutationResult> {
  const plan = await withOutboxRuntimeLock((): OutboxSessionMutationPlan => {
    const date = String(input.date || "");
    const box = outbox();
    const groupId = outboxSessionGroupId(date, input.identity);
    // Allocate once, then write the complete mutation ahead of the network.
    // A lease-takeover tab therefore sees the in-flight workout member and can
    // only append behind it; a lost response never creates a detached fallback.
    const mutationId = box.allocateId();
    const blocked = (
      prerequisite: ReturnType<typeof outboxSessionPrerequisite>,
    ): OutboxSessionMutationResult => ({
      status: "blocked",
      reason: prerequisite.reason || "phantom",
      prerequisiteId: prerequisite.id,
      groupId,
    });
    const prerequisite = outboxSessionPrerequisite(date);
    if (prerequisite.status === "blocked") return blocked(prerequisite);
    const groupAlreadyQueued = box.list().some((item) => item.group_id === groupId);
    const deliver = prerequisite.status !== "ready" && !groupAlreadyQueued;
    const claimToken = deliver ? box.allocateClaimToken() : null;
    const item = enqueueOutboxUnlocked(input.kind, input.path, input.body, {
      itemId: mutationId,
      method: input.method,
      dependsOn: prerequisite.status === "ready" ? prerequisite.id : null,
      groupId,
      sessionDate: date,
      ...(deliver
        ? {
            state: "sending" as const,
            inFlightUntil: Date.now() + OUTBOX_SEND_CLAIM_MS,
            claimToken,
          }
        : {}),
    });
    if (!item) return { status: "storage_error", groupId } as const;
    if (!deliver) {
      return { status: "queued", item, groupId } as const;
    }
    return { status: "deliver", item: item as ClaimedOutboxItem, groupId } as const;
  });

  if (plan.status !== "deliver") {
    renderOutboxBar();
    if (plan.status === "queued") void flushOutbox();
    return plan;
  }

  const { item, groupId } = plan;
  try {
    const value = await send(item.id);
    if (replayHasSemanticFailure(item, value)) {
      // Keep the response contract for the caller's existing precise error
      // handling, while making the durable row explicitly reviewable.
      await withOutboxRuntimeLock(() => outbox().settle(item.id, item.claim_token, "attention"));
      renderOutboxBar();
      return { status: "sent", value, groupId };
    }
    // Completion reacquires current lock ownership after the network wait. That
    // prevents a resumed, expired lease holder from overwriting rows appended or
    // removed by the takeover tab while this response was in flight.
    await withOutboxRuntimeLock(() => outbox().settle(item.id, item.claim_token, "delivered"));
    renderOutboxBar();
    return { status: "sent", value, groupId };
  } catch (error) {
    if (isTransientApiFailure(error)) {
      await withOutboxRuntimeLock(() => outbox().settle(item.id, item.claim_token, "pending"));
      const queued = outbox().list().find((candidate) => candidate.id === item.id) || item;
      renderOutboxBar();
      void flushOutbox();
      return { status: "queued", item: queued, groupId };
    }
    const failureStatus = error instanceof CairnApiError && error.status != null ? error.status : undefined;
    await withOutboxRuntimeLock(() =>
      outbox().settle(item.id, item.claim_token, "attention", failureStatus)
    );
    renderOutboxBar();
    return { status: "failed", error, groupId };
  }
}
function outboxCount(): number {
  return outbox().count();
}

const CAIRN_OUTBOX = {
  createOutbox,
  enqueue: outboxEnqueue,
  flush: flushOutbox,
  count: outboxCount,
  list: () => outbox().list(),
  reviewItems: () => outbox().review(),
  renderBar: renderOutboxBar,
  openReview: openOutboxReview,
  closeReview: closeOutboxReview,
  retry: retryOutboxItem,
  discard: discardOutboxItem,
  itemSummary: outboxItemSummary,
  sessionGroupId: outboxSessionGroupId,
  runSessionMutation,
  sessionDependency: outboxSessionDependency,
  sessionPrerequisite: outboxSessionPrerequisite,
  resolveSessionPrerequisite: outboxResolveSessionPrerequisite,
};

// Exposes the pure api() coalescer core for tests, mirroring CairnOutbox above.
const CAIRN_API_CACHE = {
  createApiCoalescer,
  shouldBypassApiCache,
  shouldArmGetTimeout,
  MICRO_TTL_MS: API_MICRO_TTL_MS,
  MICRO_CACHE_PATHS: API_MICRO_CACHE_PATHS,
  GET_TIMEOUT_MS: API_GET_TIMEOUT_MS,
  ApiError: CairnApiError,
  isTransientApiFailure,
  normalizeRoute: normalizeApiRoute,
  diagnosticRoute: diagnosticApiRoute,
};

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => {
    setOffline(false);
    void flushOutbox();
  });
  if (navigator.onLine === false) setOffline(true);
  // Boot: paint any leftover queue and try to drain what a previous session held.
  if (typeof setTimeout === "function")
    setTimeout(() => {
      renderOutboxBar();
      void flushOutbox();
    }, 0);
}

Object.assign(globalThis, {
  authToken,
  withToken,
  deviceTimeZone,
  api,
  apiBinary,
  setOffline,
  CairnOutbox: CAIRN_OUTBOX,
  CairnApiCache: CAIRN_API_CACHE,
  CairnApiError,
  outboxEnqueue,
  outboxSessionDependency,
  outboxSessionGroupId,
  outboxSessionPrerequisite,
  runSessionMutation,
  outboxResolveSessionPrerequisite,
  outboxBlockSessionPrerequisite,
  flushOutbox,
  outboxCount,
});
