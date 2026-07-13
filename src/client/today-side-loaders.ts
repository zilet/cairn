// @ts-check
// Today side loaders: slot-bound async panels that sit around the main render path.

type TodaySideMealPlan = Record<string, unknown> & {
  status?: string;
  parsed?: { days?: Array<Record<string, unknown> & { meals?: Array<Record<string, unknown>> }> };
};

type TodaySideContextEvent = Record<string, unknown> & {
  kind?: string;
  title?: string;
  start_date?: string | null;
  end_date?: string | null;
  archived?: boolean;
  meta_json?: unknown;
};

type TodaySideHealthSynthesisBanner = {
  synthesis?: { one_change?: unknown; headline?: unknown } | null;
  focus?: {
    lead?: {
      group?: unknown;
      why?: unknown;
      moves?: { nutrition?: unknown; training?: unknown; watch?: unknown } | null;
    } | null;
  } | null;
};

type TodaySideLoaderState = {
  tab?: string;
  logDate: string;
  planJump?: string | null;
  meSeg?: string | null;
  standSeg?: string | null;
};

type TodaySideLoaderDeps = {
  root: ParentNode;
  state: TodaySideLoaderState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  activateTab(tab: string): unknown;
  runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
  escapeHtml(value: unknown): string;
  localISO(date?: Date): string;
  stagger(index?: number | null): string;
};

(() => {
  function isCurrentToday(deps: TodaySideLoaderDeps): boolean {
    return deps.state.tab === "today";
  }

  // Today: the "body's reaction" card for a strength session reconciled from Garmin.
  function garminSessionCard(value: unknown): string {
    return CairnTodayLately.garminSessionCard(value);
  }

  // Today: personal-baseline recovery bands under the wearable strip — today's
  // HRV / resting HR / sleep read against the athlete's OWN last-28-day range in
  // plain words (no score). Independent of the Garmin cell strip below: it draws
  // from the unified recovery view, so it surfaces even when only Apple/Oura data
  // is present. Absent/thin → the slot stays empty (the client degrades silently).
  async function loadRecoveryBands(deps: TodaySideLoaderDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#wearBands");
    if (!slot) return;
    let data: unknown;
    try { data = await deps.api("/recovery/baseline"); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const dims = data && typeof data === "object" && Array.isArray((data as { dimensions?: unknown }).dimensions)
      ? ((data as { dimensions: Array<Record<string, unknown>> }).dimensions)
      : [];
    if (!dims.length) { slot.innerHTML = ""; return; }
    const rows = dims
      .map((d) => CairnUiReads.baselineBandHtml({
        label: d.label,
        position: d.position,
        rangeStart: d.range_start,
        rangeEnd: d.range_end,
        phrase: d.phrase,
        hot: d.hot === true,
      }))
      .filter(Boolean)
      .join("");
    // Layout-only inline styles (band visuals come from the §04d .read-band
    // primitive); no new CSS, so no service-worker cache bump is needed here.
    slot.innerHTML = rows
      ? `<div class="wear-bands" style="display:flex;flex-direction:column;gap:12px;margin-top:14px">${rows}</div>`
      : "";
  }

  // Today: slim Garmin wearable strip under the compass.
  async function loadWearable(isToday: unknown, deps: TodaySideLoaderDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#wearStrip");
    if (!slot || !isToday) return;
    // The recovery bands share the wearable card's fold but their own slot + data
    // source, so kick them off independently of the Garmin-cell early returns below.
    void loadRecoveryBands(deps);
    let rows: unknown = [];
    try { rows = await deps.api("/garmin/daily?limit=1"); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const m = Array.isArray(rows) ? rows[0] as Record<string, unknown> : null;
    if (!m || !m.date) return;
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    if (m.date !== deps.localISO() && m.date !== deps.localISO(yest)) return;
    const cells: string[] = [];
    if (m.steps != null) {
      cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Number(m.steps) || 0}" data-cufmt="k">0</span><span class="wear-l lbl">steps</span></span>`);
    }
    if (m.sleep_min != null) {
      const v = Math.max(0, Math.round(Number(m.sleep_min) || 0));
      const score = m.sleep_score != null ? ` · ${Math.round(Number(m.sleep_score))}` : "";
      cells.push(`<span class="wear-cell"><span class="wear-n numeral">${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}</span><span class="wear-l lbl">sleep${score}</span></span>`);
    }
    if (m.resting_hr != null) {
      cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.resting_hr)) || 0}">0</span><span class="wear-l lbl">rest hr</span></span>`);
    }
    if (m.hrv_ms != null && cells.length < 4) {
      cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.hrv_ms)) || 0}">0</span><span class="wear-l lbl">hrv</span></span>`);
    }
    if (m.body_battery_avg != null && cells.length < 4) {
      cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.body_battery_avg)) || 0}">0</span><span class="wear-l lbl">battery</span></span>`);
    }
    if (!cells.length) return;
    slot.innerHTML = `<div class="wearstrip reveal" style="${deps.stagger(0)}">
      <span class="wear-kicker lbl">Garmin${m.date !== deps.localISO() ? " · yest" : ""}</span>
      ${cells.join("")}
    </div>`;
    deps.runCountUps(slot);
  }

  // Today: a one-line pointer to the day's planned meals.
  async function loadTableHint(deps: TodaySideLoaderDeps): Promise<void> {
    const wrap = deps.root.querySelector<HTMLElement>("#tableHint");
    if (!wrap) return;
    let plans: TodaySideMealPlan[] = [];
    try { plans = await deps.api("/mealplans?limit=6") as TodaySideMealPlan[]; } catch { return; }
    if (!isCurrentToday(deps) || !wrap.isConnected) return;
    const p = CairnMealPlan.currentMealPlan(plans) as TodaySideMealPlan | null;
    const parsed = p?.parsed;
    const days = parsed && Array.isArray(parsed.days) ? parsed.days : [];
    const lbl = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(deps.state.logDate + "T12:00:00").getDay()];
    const day = days.find((d) => String(d.day || "").toLowerCase().startsWith(lbl));
    const meals = day && Array.isArray(day.meals) ? day.meals : [];
    if (!meals.length) return;
    const first = meals[0].name || meals[0].meal || "";
    wrap.innerHTML = `<button class="tablehint" id="tableHintBtn">
      <span class="lbl">Table</span> ${deps.escapeHtml(first)}${meals.length > 1 ? `<span class="tablehint-more"> +${meals.length - 1}</span>` : ""}<span class="tablehint-go">→</span>
    </button>`;
    wrap.querySelector("#tableHintBtn")?.addEventListener("click", () => {
      deps.state.planJump = "meals";
      deps.activateTab("plan");
    });
  }

  async function loadContextBanner(deps: TodaySideLoaderDeps): Promise<void> {
    const wrap = deps.root.querySelector<HTMLElement>("#ctxEvents");
    if (!wrap) return;
    let events: TodaySideContextEvent[] = [];
    try { events = await deps.api("/context-events?active=1") as TodaySideContextEvent[]; } catch { events = []; }
    if (!isCurrentToday(deps) || !wrap.isConnected) return;
    wrap.innerHTML = CairnTodayContext.contextBannerHtml(events);
  }

  // Today: one quiet health-focus line from the latest whole-picture review.
  async function loadHealthFocusBanner(deps: TodaySideLoaderDeps): Promise<void> {
    const wrap = deps.root.querySelector<HTMLElement>("#ctxHealth");
    if (!wrap) return;
    let data: TodaySideHealthSynthesisBanner | null = null;
    try { data = await deps.api("/health/synthesis") as TodaySideHealthSynthesisBanner; } catch { data = null; }
    if (!isCurrentToday(deps) || !wrap.isConnected) return;
    wrap.innerHTML = CairnTodayContext.healthFocusBannerHtml(data);
    if (!wrap.innerHTML) return;
    wrap.querySelector("#ctxHealthGo")?.addEventListener("click", () => {
      // The whole-picture read lives on the Stand overview now.
      deps.state.standSeg = null;
      deps.activateTab("stand");
    });
  }

  const CAIRN_TODAY_SIDE_LOADERS = {
    garminSessionCard,
    loadWearable,
    loadRecoveryBands,
    loadTableHint,
    loadContextBanner,
    loadHealthFocusBanner,
  };

  Object.assign(globalThis, { CairnTodaySideLoaders: CAIRN_TODAY_SIDE_LOADERS });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodaySideLoaders: CAIRN_TODAY_SIDE_LOADERS });
  }
})();
