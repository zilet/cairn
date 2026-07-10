// @ts-check
// Best-effort, local-first browser diagnostics. This module intentionally uses
// a direct guarded fetch instead of api(): a failure in reporting must be
// invisible and can never report itself recursively.

type ClientDiagnosticKind = "api_failure" | "render_error" | "unhandled_error" | "unhandled_rejection";
type ClientDiagnosticLevel = "warning" | "error";
type ClientDiagnosticEvent = {
  kind: ClientDiagnosticKind;
  level: ClientDiagnosticLevel;
  message: string;
  stack?: string;
  route?: string;
  method?: string;
  status?: number;
  duration_ms?: number;
  request_id?: string;
  tab?: string;
  online?: boolean;
  release?: string;
  fingerprint: string;
};
type ClientDiagnosticInput = Omit<ClientDiagnosticEvent, "fingerprint" | "message"> & {
  message?: unknown;
  fingerprint?: string;
};
type ClientDiagnosticStore = Pick<Storage, "getItem" | "setItem">;
type ClientDiagnosticReporter = {
  report(input: ClientDiagnosticInput): boolean;
  reportError(kind: ClientDiagnosticKind, error: unknown, extra?: Partial<ClientDiagnosticInput>): boolean;
  flush(): Promise<void>;
  pending(): ClientDiagnosticEvent[];
  installGlobalHandlers(target?: Window): void;
};

const CLIENT_DIAGNOSTIC_KEY = "cairn.diagnostics.v1";
const CLIENT_DIAGNOSTIC_MAX = 50;
const CLIENT_DIAGNOSTIC_BATCH = 20;
const CLIENT_DIAGNOSTIC_DEDUPE_MS = 30_000;
const CLIENT_DIAGNOSTIC_FLUSH_MS = 750;

function clientDiagnosticBound(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clientDiagnosticNormalizeRoute(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, "https://cairn.invalid");
    return clientDiagnosticBound(parsed.pathname.replace(/\/{2,}/g, "/"), 160);
  } catch {
    return clientDiagnosticBound(raw.split(/[?#]/, 1)[0], 160);
  }
}

function clientDiagnosticSanitize(value: unknown, max = 300): string {
  let text = clientDiagnosticBound(value, max * 2);
  // Remove URL query values and common credential-shaped fragments. Do this on
  // both messages and stacks because browser/vendor errors sometimes echo URLs.
  text = text.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1");
  text = text.replace(/([?&][a-z0-9_.-]+)=([^&#\s]+)/gi, "$1=[redacted]");
  text = text.replace(/\bauthorization\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "Authorization=[redacted]");
  text = text.replace(
    /\b(authorization|bearer|token|api[_ -]?key|password|secret)\b\s*[:=]\s*[^\s,;]+/gi,
    "$1=[redacted]"
  );
  text = text.replace(/\b(sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,})\b/gi, "[redacted]");
  return clientDiagnosticBound(text, max);
}

function clientDiagnosticHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function clientDiagnosticStorage(): ClientDiagnosticStore {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {}
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => void memory.set(key, String(value)),
  };
}

function createClientDiagnosticReporter(
  options: {
    storage?: ClientDiagnosticStore;
    fetch?: typeof fetch;
    now?: () => number;
    schedule?: (fn: () => void, delay: number) => unknown;
    authToken?: () => string;
    timeZone?: () => string;
    tab?: () => string;
    online?: () => boolean | undefined;
    release?: () => string;
  } = {}
): ClientDiagnosticReporter {
  const storage = options.storage || clientDiagnosticStorage();
  const fetcher = options.fetch || ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now || (() => Date.now());
  const schedule =
    options.schedule || ((fn, delay) => (typeof setTimeout === "function" ? setTimeout(fn, delay) : undefined));
  const recent = new Map<string, number>();
  let flushing = false;
  let scheduled = false;
  let installed = false;

  function read(): ClientDiagnosticEvent[] {
    try {
      const parsed = JSON.parse(storage.getItem(CLIENT_DIAGNOSTIC_KEY) || "[]");
      return Array.isArray(parsed)
        ? parsed.filter((row) => row && typeof row === "object" && typeof row.fingerprint === "string")
        : [];
    } catch {
      return [];
    }
  }
  function write(events: ClientDiagnosticEvent[]): void {
    try {
      storage.setItem(CLIENT_DIAGNOSTIC_KEY, JSON.stringify(events.slice(-CLIENT_DIAGNOSTIC_MAX)));
    } catch {}
  }
  function headers(): Record<string, string> {
    const result: Record<string, string> = { "Content-Type": "application/json" };
    const token = clientDiagnosticBound(options.authToken?.(), 500);
    if (token) result["X-Cairn-Token"] = token;
    const zone = clientDiagnosticBound(options.timeZone?.(), 80);
    if (zone) result["X-Cairn-TZ"] = zone;
    return result;
  }
  function normalize(input: ClientDiagnosticInput): ClientDiagnosticEvent {
    const route = clientDiagnosticNormalizeRoute(input.route);
    const method = clientDiagnosticBound(input.method, 12).toUpperCase();
    const message = clientDiagnosticSanitize(input.message || input.kind.replaceAll("_", " "), 300);
    const stack = clientDiagnosticSanitize(input.stack, 1800);
    const tab = clientDiagnosticBound(input.tab || options.tab?.(), 40);
    const release = clientDiagnosticBound(input.release || options.release?.(), 40);
    const seed = [input.kind, route, method, input.status || "", message, stack.split(" ").slice(0, 12).join(" ")].join(
      "|"
    );
    const event: ClientDiagnosticEvent = {
      kind: input.kind,
      level: input.level,
      message,
      fingerprint: clientDiagnosticBound(input.fingerprint, 100) || `${input.kind}:${clientDiagnosticHash(seed)}`,
    };
    if (stack) event.stack = stack;
    if (route) event.route = route;
    if (method) event.method = method;
    if (Number.isInteger(input.status) && Number(input.status) >= 0) event.status = Number(input.status);
    if (Number.isFinite(input.duration_ms) && Number(input.duration_ms) >= 0)
      event.duration_ms = Math.round(Number(input.duration_ms));
    const requestId = clientDiagnosticBound(input.request_id, 100);
    if (requestId) event.request_id = requestId;
    if (tab) event.tab = tab;
    const online = input.online ?? options.online?.();
    if (typeof online === "boolean") event.online = online;
    if (release) event.release = release;
    return event;
  }
  function scheduleFlush(): void {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      void flush();
    }, CLIENT_DIAGNOSTIC_FLUSH_MS);
  }
  function report(input: ClientDiagnosticInput): boolean {
    try {
      const event = normalize(input);
      const seen = recent.get(event.fingerprint) || 0;
      if (now() - seen < CLIENT_DIAGNOSTIC_DEDUPE_MS) return false;
      if (read().some((queued) => queued.fingerprint === event.fingerprint)) return false;
      recent.set(event.fingerprint, now());
      write([...read(), event]);
      scheduleFlush();
      return true;
    } catch {
      return false;
    }
  }
  function reportError(
    kind: ClientDiagnosticKind,
    error: unknown,
    extra: Partial<ClientDiagnosticInput> = {}
  ): boolean {
    const row =
      error && typeof error === "object" ? (error as { name?: unknown; message?: unknown; stack?: unknown }) : null;
    // Never persist an exception message or arbitrary rejection value: either
    // can contain chat/domain text. The useful implementation location remains
    // in bounded stack frames after dropping Error.stack's message-bearing line.
    const name = clientDiagnosticBound(row?.name || "Error", 60);
    const message = row ? `${name}: browser operation failed` : "Unhandled promise rejection";
    const stack = row?.stack == null ? undefined : String(row.stack).split(/\r?\n/).slice(1).join("\n");
    return report({
      kind,
      level: "error",
      ...extra,
      message,
      stack,
    });
  }
  async function flush(): Promise<void> {
    if (flushing) return;
    const batch = read().slice(0, CLIENT_DIAGNOSTIC_BATCH);
    if (!batch.length) return;
    flushing = true;
    try {
      const response = await fetcher("/api/telemetry/client", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      });
      if (response.status >= 200 && response.status < 300) {
        write(read().slice(batch.length));
        if (read().length) scheduleFlush();
      }
    } catch {
      // Reporting is intentionally silent. The persisted bounded queue retries
      // on the next captured event or online/page lifecycle opportunity.
    } finally {
      flushing = false;
    }
  }
  function pending(): ClientDiagnosticEvent[] {
    return read();
  }
  function installGlobalHandlers(target: Window = window): void {
    if (installed || !target?.addEventListener) return;
    installed = true;
    target.addEventListener("error", (event: ErrorEvent) => {
      reportError("unhandled_error", event.error || new Error(event.message || "Unhandled browser error"));
    });
    target.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      reportError("unhandled_rejection", event.reason);
    });
    target.addEventListener("online", () => void flush());
    target.addEventListener("pagehide", () => void flush());
  }
  return { report, reportError, flush, pending, installGlobalHandlers };
}

const CairnClientDiagnostics = createClientDiagnosticReporter({
  authToken: () => {
    try {
      return (localStorage.getItem("cairn_token") || "").trim();
    } catch {
      return "";
    }
  },
  timeZone: () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  },
  tab: () => String((globalThis as { state?: { tab?: unknown } }).state?.tab || ""),
  online: () => (typeof navigator === "undefined" ? undefined : navigator.onLine),
  release: () => String((globalThis as { CAIRN_VERSION?: unknown }).CAIRN_VERSION || ""),
});

if (typeof window !== "undefined") CairnClientDiagnostics.installGlobalHandlers(window);

Object.assign(globalThis, {
  CairnClientDiagnostics,
  CairnClientDiagnosticsCore: {
    createClientDiagnosticReporter,
    normalizeRoute: clientDiagnosticNormalizeRoute,
    sanitize: clientDiagnosticSanitize,
    hash: clientDiagnosticHash,
  },
});
