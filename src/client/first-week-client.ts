// @ts-check
// The welcome's first week, outside the welcome. EAGER and small (bundle-02).
//
// The first week is the slow part of the welcome, and the person may leave to look
// around while it is composed. This follows it from anywhere in the app:
//   - while it is being built, Today (and Train's empty states) carry one calm card,
//     "Your first week is coming together", listing the days written so far — read off
//     the welcome job's phase meta through GET /api/welcome/first-week, re-read every
//     few seconds only while something is building;
//   - when it lands, ONE in-app notice says so ("Your first week is ready", a tap opens
//     Train) and the server's one-shot marker is cleared, so a person who closed the app
//     meanwhile hears it once on the next open instead. Never an OS notification, never
//     a second time. A person still on the welcome watched it land: nothing more is said.
// Once the server says there is nothing to follow (`final`), this device stops asking.
(() => {
  const DONE_KEY = "cairn.firstWeek.done";
  const POLL_MS = 4000;
  const HIDDEN_POLL_MS = 15000;
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let status: FirstWeekStatus | null = null;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let told = false;
  let finalKnown = readDone();

  function readDone(): boolean {
    try {
      return localStorage.getItem(DONE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeDone(on: boolean): void {
    finalKnown = on;
    try {
      if (on) localStorage.setItem(DONE_KEY, "1");
      else localStorage.removeItem(DONE_KEY);
    } catch {}
  }

  function normalize(raw: unknown): FirstWeekStatus | null {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const state = row?.state;
    if (state !== "building" && state !== "ready" && state !== "failed" && state !== "none") return null;
    const days = (Array.isArray(row?.days) ? row.days : [])
      .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>) : {}))
      .filter((d) => typeof d.name === "string" && d.name.trim())
      .slice(0, 7)
      .map((d) => ({
        dow: typeof d.dow === "number" && d.dow >= 0 && d.dow <= 6 ? d.dow : null,
        day_number: Number(d.day_number) || 0,
        name: String(d.name).trim(),
      }));
    return {
      state,
      job_id: Number.isFinite(Number(row?.job_id)) ? Number(row?.job_id) : null,
      days,
      week_state: typeof row?.week_state === "string" ? row.week_state : null,
      final: row?.final === true,
    };
  }

  const welcomeOpen = (): boolean => {
    try {
      return (globalThis as { CairnWelcome?: WelcomeApi }).CairnWelcome?.isOpen() === true;
    } catch {
      return false;
    }
  };

  function say(message: string, opts?: { action: string; onAction: () => void }): void {
    const fn = (globalThis as { toast?: (m: string, o?: unknown) => void }).toast;
    if (typeof fn === "function") fn(message, opts);
  }

  function dayLabel(day: FirstWeekStatus["days"][number], i: number): string {
    return day.dow != null ? DOW[day.dow] || "" : `Day ${day.day_number > 0 ? day.day_number : i + 1}`;
  }

  function rowHtml(day: FirstWeekStatus["days"][number], i: number, stagger: number): string {
    return `<li class="fw-day reveal" style="--i:${stagger}"><span class="fw-d">${escHtml(dayLabel(day, i))}</span><span class="fw-n">${escHtml(day.name)}</span></li>`;
  }

  function cardHtml(s: FirstWeekStatus | null): string {
    if (!s || (s.state !== "building" && s.state !== "ready")) return "";
    const ready = s.state === "ready";
    const days = s.days.length
      ? `<ul class="fw-days">${s.days.map((d, i) => rowHtml(d, i, i)).join("")}</ul>`
      : `<p class="fw-s">The first days are on their way.</p>`;
    return `<section class="fw-card reveal${ready ? " is-ready" : ""}" aria-live="polite" aria-label="Your first week">
      <p class="fw-t"><span class="fw-mk" aria-hidden="true"></span>${ready ? "Your first week is ready" : "Your first week is coming together"}</p>
      ${days}${ready ? `<button class="btn btn-solid fw-see" type="button" data-fw-see>See it</button>` : ""}
    </section>`;
  }

  // Repaint every slot on screen. A slot already showing this state only gains the rows
  // that are new, so a poll that changes nothing moves nothing and rows never re-animate.
  function paint(): void {
    if (typeof document === "undefined") return;
    const kind = status && (status.state === "building" || status.state === "ready") ? status.state : "";
    for (const slot of document.querySelectorAll<HTMLElement>("[data-first-week-slot]")) {
      const list = slot.querySelector<HTMLElement>(".fw-days");
      const had = list ? list.children.length : 0;
      if (kind === "building" && slot.dataset.fw === "building" && list && status && status.days.length > had) {
        list.insertAdjacentHTML(
          "beforeend",
          status.days
            .slice(had)
            .map((d, i) => rowHtml(d, had + i, i))
            .join("")
        );
        continue;
      }
      if (slot.dataset.fw === kind && (kind !== "building" || (status?.days.length ?? 0) === had)) continue;
      slot.dataset.fw = kind;
      slot.innerHTML = cardHtml(status);
    }
  }

  function openWeek(s: FirstWeekStatus | null): void {
    status = null;
    paint();
    const go = (globalThis as { activateTab?: (name: unknown) => void }).activateTab;
    if (typeof go === "function") go(s?.week_state === "draft" ? "today" : "train");
  }

  function landed(): void {
    const root = globalThis as {
      CairnWriteInvalidation?: { invalidateWrite?(name: string): unknown };
      CairnCoachLink?: CoachLinkApi;
      renderTab?: (tab: string) => unknown;
      state?: { tab?: string };
    };
    try {
      root.CairnWriteInvalidation?.invalidateWrite?.("proposal_apply");
    } catch {}
    try {
      root.CairnCoachLink?.invalidate();
    } catch {}
    const tab = root.state?.tab;
    // Today and Train's plan are where a new week shows.
    if (tab === "today" || tab === "plan") {
      try {
        root.renderTab?.(tab);
      } catch {}
    }
  }

  function markSeen(): void {
    try {
      void Promise.resolve(api("/welcome/first-week/seen", { method: "POST" })).catch(() => {});
    } catch {}
  }

  // The one notice. `live`: this page watched it build, so the screens it touched repaint.
  function tell(s: FirstWeekStatus, live: boolean): void {
    if (told) return;
    told = true;
    markSeen();
    if (live) landed();
    if (welcomeOpen()) {
      status = null; // the welcome showed it land; Today needs no card for it
      return;
    }
    if (s.state === "failed") {
      status = null;
      say("I couldn't put your first week together just now. Ask me for it any time.");
      return;
    }
    say("Your first week is ready", { action: "See it", onAction: () => openWeek(s) });
  }

  function apply(next: FirstWeekStatus | null): void {
    if (!next) return;
    const live = status?.state === "building";
    status = next;
    if (next.state === "none" && next.final) writeDone(true);
    if (next.state === "ready" || next.state === "failed") tell(next, live);
    else if (next.state === "none" && live) landed(); // it ended while we watched
    paint();
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (status?.state !== "building") return;
    const hidden = typeof document !== "undefined" && document.hidden;
    timer = setTimeout(() => void refresh(), hidden || welcomeOpen() ? HIDDEN_POLL_MS : POLL_MS);
  }

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        apply(normalize(await api("/welcome/first-week")));
      } catch {}
      inflight = null;
      schedule();
    })();
    return inflight;
  }

  // Ask once per page, unless this device already knows there is nothing to follow.
  function ensure(): void {
    if (finalKnown || inflight || status) return;
    void refresh();
  }

  function slotHtml(): string {
    ensure();
    const kind = status && (status.state === "building" || status.state === "ready") ? status.state : "";
    return `<div class="fw-slot" data-first-week-slot data-fw="${kind}">${cardHtml(status)}</div>`;
  }

  const FIRST_WEEK: FirstWeekApi = {
    slotHtml,
    building: () => status?.state === "building",
    track() {
      writeDone(false);
      told = false;
      status =
        status?.state === "building"
          ? status
          : { state: "building", job_id: null, days: [], week_state: null, final: false };
      paint();
      void refresh();
    },
    seen() {
      if (status?.state === "ready" || status?.state === "failed") status = null;
      told = true;
      markSeen();
      paint();
    },
    landed,
    refresh,
  };

  if (typeof document !== "undefined") {
    document.addEventListener("click", (event) => {
      const see = event.target instanceof Element ? event.target.closest("[data-fw-see]") : null;
      if (see) openWeek(status);
    });
    // The next open after a week landed while the app was closed: say it once, wherever
    // the app opened. A quiet read a moment after boot, skipped once there is nothing left.
    setTimeout(() => {
      if (!finalKnown && !status) void refresh();
    }, 1500);
  }

  Object.assign(globalThis, { CairnFirstWeek: FIRST_WEEK });
})();
