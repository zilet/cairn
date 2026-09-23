// @ts-check
// Today rail slot loaders: side-effectful card hydration for agenda-selected rail cards.

type TodayRailDayIntake = import("../contracts/client.js").ClientDayIntake;
type TodayRailRecentTrainingFeedRow = import("../contracts/client.js").ClientRecentTrainingFeedRow;

type TodayRailLoadersApi = {
  loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void>;
  loadFuelingFollowup(deps: ClientTodayRailControllerDeps): Promise<void>;
  loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void>;
  loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void>;
  loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void>;
  loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void>;
  prefetchRail(keys: readonly string[], deps: ClientTodayRailControllerDeps): void;
};

(() => {
  function isCurrentToday(deps: ClientTodayRailControllerDeps): boolean {
    return !deps.state.tab || deps.state.tab === "today";
  }

  // A rail GET: the promise renderToday already started for this path the moment
  // the agenda named the card (CairnTodayPrefetch, one-shot), else the loader's own.
  function railGet(deps: ClientTodayRailControllerDeps, path: string): Promise<unknown> {
    const prefetch = (globalThis as { CairnTodayPrefetch?: TodayPrefetchApi }).CairnTodayPrefetch;
    return prefetch?.take(path) ?? deps.api(path);
  }

  // The exact GET path each loader asks for — the one map the render's prefetch
  // and the loaders below share, so the two can never drift apart.
  const RAIL_PATHS = {
    fuel: (date: string) => `/nutrition/day?date=${encodeURIComponent(date)}`,
    fuelingFollowup: "/nutrition/fueling-followup",
    weekAhead: "/week-ahead",
    programAdjustments: "/program/adjustments",
    recentTraining: "/recent-training?limit=6",
    garminUnreconciled: "/garmin/unreconciled",
  } as const;

  async function loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#fuelSlot");
    if (!slot) return;
    let day: unknown = null;
    try { day = await railGet(deps, RAIL_PATHS.fuel(date || deps.state.logDate)); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const count = day && typeof day === "object" ? Number((day as { count?: unknown }).count) : 0;
    if (!(count > 0)) { slot.innerHTML = ""; return; }
    slot.innerHTML = CairnTodayAgenda.fuelCardHtml(day as TodayRailDayIntake);
    const card = slot.querySelector("#fuelCard");
    if (card) card.addEventListener("click", () => { deps.state.planJump = "food"; deps.activateTab("plan"); });
    deps.runCountUps(slot);
  }

  // Fueling follow-through: after a nutrition-target change applied, offer one calm 1-tap
  // read. Fetches the due-check; renders nothing unless due (the server gates it to the
  // change's 7-day window, a day with logged food, and "not answered yet"). On a tap it
  // POSTs the read and melts into a quiet one-line acknowledgement; the ✕ hides it for now.
  // Copy is static client text and adherence-neutral — no numbers shown.
  async function loadFuelingFollowup(deps: ClientTodayRailControllerDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#fuelingSlot");
    if (!slot) return;
    let followup: unknown = null;
    try { followup = await railGet(deps, RAIL_PATHS.fuelingFollowup); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const due = followup && typeof followup === "object" && (followup as { due?: unknown }).due === true;
    if (!due) { slot.innerHTML = ""; return; }
    slot.innerHTML =
      `<div class="fueling-card reveal" style="--i:0">` +
        `<div class="fueling-lead"><span class="fueling-kicker lbl">Since the target change</span></div>` +
        `<div class="fueling-copy">How's fueling feeling?</div>` +
        `<div class="fueling-opts">` +
          `<button class="fueling-opt" data-energy="1" type="button">Running low</button>` +
          `<button class="fueling-opt" data-energy="2" type="button">Steady</button>` +
          `<button class="fueling-opt" data-energy="3" type="button">Plenty</button>` +
        `</div>` +
        `<button class="fueling-skip" id="fuelingSkip" type="button" aria-label="Not now">✕</button>` +
      `</div>`;
    slot.querySelector("#fuelingSkip")?.addEventListener("click", () => { slot.innerHTML = ""; });
    slot.querySelectorAll<HTMLElement>(".fueling-opt").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const energy = Number(btn.dataset.energy);
        slot.querySelectorAll<HTMLButtonElement>(".fueling-opt").forEach((b) => { b.disabled = true; });
        try {
          await deps.api("/nutrition/fueling-feedback", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ energy }),
          });
        } catch {
          slot.querySelectorAll<HTMLButtonElement>(".fueling-opt").forEach((b) => { b.disabled = false; });
          deps.toast("Couldn't save that — try again.");
          return;
        }
        if (!slot.isConnected) return;
        slot.innerHTML =
          `<div class="fueling-done chip-in"><span class="fueling-done-mark" aria-hidden="true">✓</span> Noted — thanks for the read.</div>`;
      }));
  }

  async function loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#weekAheadSlot");
    if (!slot) return;
    let response: unknown = null;
    try { response = await railGet(deps, RAIL_PATHS.weekAhead); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    slot.innerHTML = CairnTodayWeekAhead.cardHtml(response);
  }

  async function loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#adjustSlot");
    if (!slot) return;
    let rows: unknown = null;
    try { rows = await railGet(deps, RAIL_PATHS.programAdjustments); } catch { rows = null; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) { slot.innerHTML = ""; return; }
    const more = CairnTodayProgramAdjustments.extraCount(list);
    slot.innerHTML = CairnTodayProgramAdjustments.bannerHtml(list);
    const card = slot.querySelector(".adjust-card");
    if (!card) return;
    card.addEventListener("click", (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      const act = target?.closest<HTMLElement>(".adjust-act");
      if (act) {
        deps.state.chatPrefill = act.getAttribute("data-req") || "";
        deps.activateTab("chat");
        return;
      }
      if (target?.closest("#adjustAll")) { deps.activateTab("plan"); return; }
      const moreBtn = target?.closest<HTMLButtonElement>("#adjustMore");
      if (moreBtn) {
        const open = card.classList.toggle("adjust-open");
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
        moreBtn.textContent = open ? "Show less" : `+${more} more in your program`;
        return;
      }
      const item = target?.closest<HTMLElement>(".adjust-item");
      if (item) {
        const open = item.getAttribute("aria-expanded") === "true";
        item.setAttribute("aria-expanded", open ? "false" : "true");
        const detail = item.parentElement?.querySelector<HTMLElement>(".adjust-detail");
        if (detail) detail.hidden = open;
      }
    });
  }

  async function loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void> {
    const wrap = deps.root.querySelector<HTMLElement>("#qlRecent");
    if (!wrap) return;
    let rows: TodayRailRecentTrainingFeedRow[] = [];
    try { rows = await railGet(deps, RAIL_PATHS.recentTraining) as TodayRailRecentTrainingFeedRow[]; } catch { rows = []; }
    if (!isCurrentToday(deps) || !wrap.isConnected) return;
    if (!rows || !rows.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML =
      `<div class="lately-h"><span class="ql-recent-h lbl">Lately</span>` +
      `<button class="lately-all lbl" id="latelyAll" type="button">see all →</button></div>` +
      rows.map((row) => CairnTodayLately.rowHtml(row)).join("");

    const allBtn = wrap.querySelector("#latelyAll");
    if (allBtn) allBtn.addEventListener("click", () => deps.activateTab("progress"));

    wrap.querySelectorAll<HTMLElement>('.lately-head[role="button"]').forEach((head) => {
      const toggle = () => {
        const row = head.closest(".lately-row");
        const detail = row && row.querySelector<HTMLElement>(".lately-detail");
        if (!detail) return;
        const open = detail.hidden !== false;
        detail.hidden = !open;
        row.classList.toggle("lately-open", open);
        head.setAttribute("aria-expanded", open ? "true" : "false");
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  async function loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void> {
    await CairnTodayGarminReconciliation.load({
      root: deps.root,
      date: deps.state.logDate,
      isCurrentToday: () => isCurrentToday(deps),
      // Only the unreconciled read may come from the prefetch; the reconcile POST
      // (and anything else) goes straight to the network.
      api: (path: string, opts?: RequestInit & { headers?: Record<string, string> }) =>
        !opts && path === RAIL_PATHS.garminUnreconciled ? railGet(deps, path) : deps.api(path, opts),
      escapeHtml: deps.escapeHtml,
      toast: deps.toast,
      invalidate: deps.invalidate,
      refreshToday: deps.refreshToday,
    });
  }

  // Start every GET the named rail cards are about to make, so the rail hydrates
  // from requests already in flight once its slots mount. Only cards that WILL run
  // are named by the caller (the agenda's own buckets, or the fallback set), so
  // nothing is fetched that no loader will take.
  function prefetchRail(keys: readonly string[], deps: ClientTodayRailControllerDeps): void {
    const prefetch = (globalThis as { CairnTodayPrefetch?: TodayPrefetchApi }).CairnTodayPrefetch;
    if (!prefetch) return;
    const start = (path: string) => {
      prefetch.prefetch(path, () => deps.api(path));
    };
    const want = new Set(keys);
    if (want.has("fuel")) start(RAIL_PATHS.fuel(deps.state.logDate));
    if (want.has("fueling-followup")) start(RAIL_PATHS.fuelingFollowup);
    if (want.has("week-ahead")) start(RAIL_PATHS.weekAhead);
    if (want.has("program-adjustments")) start(RAIL_PATHS.programAdjustments);
    if (want.has("garmin-reconcile")) start(RAIL_PATHS.garminUnreconciled);
    if (want.has("lately")) start(RAIL_PATHS.recentTraining);
    const reads = (globalThis as { CairnCaptureReads?: CaptureReadsRuntime }).CairnCaptureReads;
    reads?.prefetch?.({ weekly: want.has("weekly-read"), insight: want.has("connection-insight") }, (path) =>
      deps.api(path)
    );
  }

  const CAIRN_TODAY_RAIL_LOADERS: TodayRailLoadersApi = {
    prefetchRail,
    loadFuelToday,
    loadFuelingFollowup,
    loadGarminReconcile,
    loadProgramAdjustmentsBanner,
    loadRecentActivities,
    loadWeekAhead,
  };

  Object.assign(globalThis, { CairnTodayRailLoaders: CAIRN_TODAY_RAIL_LOADERS });

  if (typeof window !== "undefined") {
    window.CairnTodayRailLoaders = CAIRN_TODAY_RAIL_LOADERS;
  }
})();
