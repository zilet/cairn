// @ts-check
// Bottom rest timer shown after logging a set.
//
// DEADLINE-BASED, NOT A COUNTER. An installed PWA is suspended the moment the
// phone locks (and background tabs are throttled), so a setInterval that
// decrements a number freezes mid-rest and resumes stale — the athlete comes
// back to a countdown that under-reports the rest they actually took. The truth
// here is a pair of epoch timestamps persisted to localStorage; the interval is
// only a repaint pump, and every resume path (visibilitychange, pageshow, focus)
// re-derives the real remaining time from the clock.
//
// Persisting also survives the service-worker `controllerchange` reload, which
// would otherwise wipe an in-flight rest on every deploy.
//
// After the countdown lands the bar does NOT disappear: it flips to a quiet
// count-UP from the moment the rest started ("Rested 2:40"), which is the
// readout that matters on a heavy lift. It clears when the next set is logged
// (that restarts the rest), when the session finishes, or when the athlete taps
// Done.

type RestPhase = "counting" | "rested";

type RestTimerState = {
  id: ReturnType<typeof setInterval> | null;
  // Epoch ms. `startedAt` anchors the count-up; `endsAt` is the countdown
  // deadline; `total` is the intended rest length in seconds (the fill's
  // denominator, and what a ±15 adjust teaches the next set).
  startedAt: number;
  endsAt: number;
  total: number;
  phase: RestPhase;
  announced: boolean;
};

type PersistedRest = {
  startedAt: number;
  endsAt: number;
  total: number;
  phase: RestPhase;
  announced: boolean;
};

const REST_STORE_KEY = "cairn.rest.v1";
const REST_PREF_KEY = "restSec";
const DEFAULT_REST_SEC = 120;
const REST_PREF_MIN_SEC = 30;
const REST_PREF_MAX_SEC = 600;
// A rest older than this is not a rest any more — they walked away, put the
// phone down, came back tomorrow. Restore silently drops it rather than
// resurrecting a bar (or firing a toast) about a set logged half an hour ago.
const REST_STALE_MS = 30 * 60 * 1000;

const rest: RestTimerState = {
  id: null,
  startedAt: 0,
  endsAt: 0,
  total: 0,
  phase: "counting",
  announced: false,
};

function restNow(): number {
  return Date.now();
}

// Unknown visibility (a non-browser host, an older engine) reads as visible:
// the conservative choice is to announce, never to swallow the completion.
function restVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function fmtRestClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function restIsStale(startedAt: number, now: number = restNow()): boolean {
  return startedAt > 0 && now - startedAt > REST_STALE_MS;
}

function persistRest(): void {
  try {
    localStorage.setItem(
      REST_STORE_KEY,
      JSON.stringify({
        startedAt: rest.startedAt,
        endsAt: rest.endsAt,
        total: rest.total,
        phase: rest.phase,
        announced: rest.announced,
      } satisfies PersistedRest)
    );
  } catch {
    // A full or blocked store must never cost the athlete their rest timer —
    // it just loses the ability to survive a suspend.
  }
}

function clearPersistedRest(): void {
  try {
    localStorage.removeItem(REST_STORE_KEY);
  } catch {}
}

function readPersistedRest(): PersistedRest | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(REST_STORE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedRest> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const startedAt = Number(parsed.startedAt);
    const endsAt = Number(parsed.endsAt);
    const total = Number(parsed.total);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endsAt) || !Number.isFinite(total)) return null;
    if (startedAt <= 0 || total <= 0) return null;
    return {
      startedAt,
      endsAt,
      total,
      phase: parsed.phase === "rested" ? "rested" : "counting",
      announced: !!parsed.announced,
    };
  } catch {
    return null;
  }
}

function ensureRestBar(): HTMLElement {
  let bar = document.querySelector<HTMLElement>(".rest");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "rest";
    bar.innerHTML = `<div class="rest-fill"></div>
      <div class="rest-row">
        <button class="rest-btn" data-r="-15">−15</button>
        <span class="rest-time"></span>
        <button class="rest-btn" data-r="15">+15</button>
        <button class="rest-btn rest-skip" data-r="0">Skip</button>
      </div>`;
    document.body.appendChild(bar);
    bar.querySelectorAll<HTMLElement>("[data-r]").forEach((button) => {
      button.addEventListener("click", () => {
        const value = Number(button.dataset.r);
        if (value === 0) {
          stopRest();
          return;
        }
        adjustRest(value);
      });
    });
  }
  return bar;
}

// ±15 moves the DEADLINE, and the intended length moves with it. The old code
// only ever ratcheted `total` upward, so pressing −15 shrank the remaining time
// against an unchanged denominator and the fill visibly JUMPED BACKWARD (a
// shorter rest painting as more progress remaining). Shifting both by the same
// amount keeps elapsed fixed and the fill monotonic.
function adjustRest(deltaSeconds: number): void {
  if (rest.phase !== "counting") return;
  const now = restNow();
  // Never let an adjust land in the past: one second is the floor.
  const requestedEnds = rest.endsAt + deltaSeconds * 1000;
  const floorEnds = now + 1000;
  const floorClamped = requestedEnds < floorEnds;
  rest.endsAt = Math.max(floorEnds, requestedEnds);
  rest.total = Math.max(1, Math.round((rest.endsAt - rest.startedAt) / 1000));
  // The adjust is a preference, not a one-off: the next set rests this long.
  // A floor clamp is not a preference — −15 with 5 s left would otherwise
  // teach a junk default of "elapsed + 1s". And the stored value itself is
  // clamped to a sane rest window so a mashed +15 cannot write 20 minutes.
  if (!floorClamped) {
    const pref = Math.min(REST_PREF_MAX_SEC, Math.max(REST_PREF_MIN_SEC, rest.total));
    try {
      localStorage.setItem(REST_PREF_KEY, String(pref));
    } catch {}
  }
  persistRest();
  paintRest();
}

function paintRest(): void {
  const bar = document.querySelector<HTMLElement>(".rest");
  if (!bar || !rest.startedAt) return;
  const now = restNow();
  const resting = rest.phase === "rested";
  bar.classList.toggle("rested", resting);
  const time = bar.querySelector<HTMLElement>(".rest-time");
  if (time) {
    time.textContent = resting
      ? `Rested ${fmtRestClock((now - rest.startedAt) / 1000)}`
      : `Rest ${fmtRestClock(Math.ceil((rest.endsAt - now) / 1000))}`;
  }
  const fill = bar.querySelector<HTMLElement>(".rest-fill");
  if (fill) {
    const remaining = Math.max(0, (rest.endsAt - now) / 1000);
    fill.style.width = resting ? "100%" : `${Math.max(0, Math.min(100, (remaining / rest.total) * 100))}%`;
  }
  const skip = bar.querySelector<HTMLElement>(".rest-skip");
  if (skip) skip.textContent = resting ? "Done" : "Skip";
}

function armRestTick(): void {
  if (rest.id) clearInterval(rest.id);
  rest.id = setInterval(() => {
    if (restIsStale(rest.startedAt)) {
      stopRest();
      return;
    }
    if (rest.phase === "counting" && restNow() >= rest.endsAt) {
      enterRestedPhase();
      return;
    }
    paintRest();
  }, 1000);
}

// The countdown has landed. Keep the bar — flipped to the count-up readout —
// and announce ONCE, either here (tab visible) or on the next reconcile.
function enterRestedPhase(): void {
  if (rest.phase !== "rested") {
    rest.phase = "rested";
    persistRest();
  }
  paintRest();
  if (rest.announced) return;
  if (!restVisible()) return;
  announceRested();
}

function announceRested(): void {
  rest.announced = true;
  persistRest();
  if (typeof toast === "function") toast(`Rested ${fmtRestClock((restNow() - rest.startedAt) / 1000)}`);
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(150);
}

function showRestBar(): void {
  ensureRestBar().classList.add("show");
  document.body.classList.add("resting");
}

// Visual only: the persisted deadline and the repaint pump stay put so
// returning to a logging tab can restore a still-fresh rest. Chat / Plan /
// Progress must not keep a fixed bar (and body.resting padding) over their
// composers.
function hideRestBar(): void {
  const bar = document.querySelector<HTMLElement>(".rest");
  if (bar) bar.classList.remove("show");
  document.body.classList.remove("resting");
}

function surfaceRestBar(): void {
  if (!rest.startedAt) return;
  if (restIsStale(rest.startedAt)) {
    stopRest();
    return;
  }
  showRestBar();
  reconcileRest();
}

function startRest(seconds?: number): void {
  let preferred = 0;
  try {
    preferred = Number(localStorage.getItem(REST_PREF_KEY) || 0);
  } catch {}
  rest.total = seconds || (Number.isFinite(preferred) && preferred > 0 ? preferred : DEFAULT_REST_SEC);
  rest.startedAt = restNow();
  rest.endsAt = rest.startedAt + rest.total * 1000;
  rest.phase = "counting";
  rest.announced = false;
  persistRest();
  showRestBar();
  paintRest();
  armRestTick();
}

function stopRest(): void {
  if (rest.id) clearInterval(rest.id);
  rest.id = null;
  rest.phase = "counting";
  rest.announced = false;
  rest.startedAt = 0;
  rest.endsAt = 0;
  rest.total = 0;
  clearPersistedRest();
  const bar = document.querySelector<HTMLElement>(".rest");
  if (bar) {
    bar.classList.remove("show");
    bar.classList.remove("rested");
  }
  document.body.classList.remove("resting");
}

// Called on every resume path. The clock — not the tick count — decides what
// actually happened while we were suspended: an overdue countdown completes
// immediately (and says what it really was, "Rested 4:10", never a flat "Rest
// done" for a rest that ran four minutes past), and a rest old enough that they
// clearly walked away is dropped without a word.
function reconcileRest(): void {
  if (!rest.startedAt) return;
  if (restIsStale(rest.startedAt)) {
    stopRest();
    return;
  }
  if (rest.phase === "counting" && restNow() >= rest.endsAt) {
    enterRestedPhase();
    return;
  }
  if (rest.phase === "rested" && !rest.announced && restVisible()) announceRested();
  paintRest();
}

// Module load: pick a persisted rest back up. This is what carries an in-flight
// rest across the service worker's `controllerchange` reload and across an
// iOS standalone app being killed and reopened mid-session. Restores the
// deadline, arms the tick and reconciles; does NOT show the bar. renderAppTab
// surfaces it on Session/Today so a reload landing on Chat/Plan/Progress does
// not flash the bar over the composer.
function restoreRest(): void {
  const saved = readPersistedRest();
  if (!saved) return;
  if (restIsStale(saved.startedAt)) {
    clearPersistedRest();
    return;
  }
  rest.startedAt = saved.startedAt;
  rest.endsAt = saved.endsAt;
  rest.total = saved.total;
  rest.phase = saved.phase;
  rest.announced = saved.announced;
  armRestTick();
  reconcileRest();
}

function installRestTimerWatcher(): void {
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reconcileRest();
    });
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pageshow", () => reconcileRest());
    window.addEventListener("focus", () => reconcileRest());
  }
}

const CAIRN_REST_TIMER = {
  ensureRestBar,
  paintRest,
  startRest,
  stopRest,
  hideRestBar,
  surfaceRestBar,
  reconcileRest,
  restoreRest,
};

Object.assign(globalThis, {
  CairnRestTimer: CAIRN_REST_TIMER,
  ensureRestBar,
  paintRest,
  startRest,
  stopRest,
  hideRestBar,
  surfaceRestBar,
  reconcileRest,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnRestTimer: CAIRN_REST_TIMER,
    ensureRestBar,
    paintRest,
    startRest,
    stopRest,
    hideRestBar,
    surfaceRestBar,
    reconcileRest,
  });
}

installRestTimerWatcher();
restoreRest();
