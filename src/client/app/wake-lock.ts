// @ts-check
// Opt-in Screen Wake Lock for an open strength session.
//
// Racking a heavy set and coming back to a locked phone is the one place the
// screen going dark actually costs something. This keeps it awake WHILE the
// session logging surface is open, and only when the athlete asked for it.
//
// The preference is DEVICE-LOCAL (localStorage, not a server setting): whether
// a screen should stay lit depends on the phone in your hand, not on the
// account — the same account on a desktop wants nothing of the sort.
//
// Everything here is feature-detected and swallowing: `navigator.wakeLock` is
// absent on older iOS (it needs 18.4+ on the Home Screen app) and on Firefox,
// and `request()` REJECTS whenever the document is hidden. Neither is an error
// worth surfacing — the session just behaves as it always did.
{
  type WakeLockSentinelLike = {
    release?: () => Promise<void> | void;
    addEventListener?: (type: string, listener: () => void) => void;
  };

  const WAKE_LOCK_KEY = "cairn.wakeLock.v1";

  let sentinel: WakeLockSentinelLike | null = null;
  // What the app WANTS right now (a session surface is open), independent of
  // whether a lock is currently held — a hidden document cannot hold one, so
  // this is what tells the resume path to take it back.
  let wanted = false;
  // In-flight request(). Two callers in the same turn (Session paint +
  // wireSessionSurface, or a visibilitychange overlapping an acquire) both
  // pass `if (sentinel)` because sentinel is assigned only AFTER request()
  // resolves — without this, the second overwrites the first and
  // releaseWakeLock() drops only the survivor.
  let pending: Promise<void> | null = null;

  function wakeLockApi(): { request: (type: "screen") => Promise<WakeLockSentinelLike> } | null {
    if (typeof navigator === "undefined") return null;
    const api = (navigator as Navigator & { wakeLock?: { request?: unknown } }).wakeLock;
    if (!api || typeof api.request !== "function") return null;
    return api as { request: (type: "screen") => Promise<WakeLockSentinelLike> };
  }

  function wakeLockSupported(): boolean {
    return !!wakeLockApi();
  }

  function wakeLockEnabled(): boolean {
    try {
      return localStorage.getItem(WAKE_LOCK_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setWakeLockEnabled(on: boolean): void {
    try {
      if (on) localStorage.setItem(WAKE_LOCK_KEY, "1");
      else localStorage.removeItem(WAKE_LOCK_KEY);
    } catch {}
    // Take effect immediately: turning it on mid-session shouldn't wait for the
    // next session, and turning it off should darken the screen on schedule.
    if (on) {
      if (wanted) void acquireWakeLock();
    } else {
      void dropSentinel();
    }
  }

  async function dropSentinel(): Promise<void> {
    const held = sentinel;
    sentinel = null;
    if (!held || typeof held.release !== "function") return;
    try {
      await held.release();
    } catch {}
  }

  async function takeWakeLock(
    api: { request: (type: "screen") => Promise<WakeLockSentinelLike> },
  ): Promise<void> {
    try {
      const held = await api.request("screen");
      // wanted / the preference may have flipped while request() was in flight.
      if (!wanted || !wakeLockEnabled()) {
        try {
          await held.release?.();
        } catch {}
        return;
      }
      sentinel = held;
      held.addEventListener?.("release", () => {
        if (sentinel === held) sentinel = null;
      });
    } catch {}
  }

  async function acquireWakeLock(): Promise<void> {
    wanted = true;
    if (pending) return pending;
    const api = wakeLockApi();
    if (!api || !wakeLockEnabled()) return;
    if (sentinel) return;
    // request() rejects on a hidden document; the visibility watcher retakes it.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    pending = takeWakeLock(api);
    try {
      await pending;
    } finally {
      pending = null;
    }
  }

  async function releaseWakeLock(): Promise<void> {
    wanted = false;
    await dropSentinel();
  }

  function installWakeLockWatcher(): void {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    // A lock is released automatically whenever the document hides, so coming
    // back to a still-open session has to take a fresh one.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        sentinel = null; // already released by the browser; don't hold a dead handle
        return;
      }
      if (wanted) void acquireWakeLock();
    });
  }

  Object.assign(globalThis, {
    acquireWakeLock,
    releaseWakeLock,
    installWakeLockWatcher,
    wakeLockSupported,
    wakeLockEnabled,
    setWakeLockEnabled,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      acquireWakeLock,
      releaseWakeLock,
      installWakeLockWatcher,
      wakeLockSupported,
      wakeLockEnabled,
      setWakeLockEnabled,
    });
  }
}
