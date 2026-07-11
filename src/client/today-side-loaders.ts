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

  // Today: slim Garmin wearable strip under the compass.
  async function loadWearable(isToday: unknown, deps: TodaySideLoaderDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#wearStrip");
    if (!slot || !isToday) return;
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
    const p = (plans || []).find((x) => x.status === "accepted" && x.parsed) ||
      (plans || []).find((x) => x.status === "draft" && x.parsed);
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

  // Today: quiet card only for a genuine review-posture draft. Lead-mode changes
  // already appear in the forward-looking decision rail and must not also nag for Apply.
  async function loadDraftProposals(deps: TodaySideLoaderDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#draftSlot");
    if (!slot) return;
    let plans: unknown = [];
    try { plans = await deps.api("/proposals?limit=8"); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const drafts = (Array.isArray(plans) ? plans : [])
      .filter((p) => {
        if (!p || typeof p !== "object" || (p as { status?: unknown }).status !== "draft") return false;
        const autonomy = (p as { autonomy?: { status?: unknown } }).autonomy;
        return autonomy?.status !== "announced" && autonomy?.status !== "pending";
      });
    if (!drafts.length) { slot.innerHTML = ""; return; }
    const head = drafts.length > 1 ? `${drafts.length} decisions need your call` : "A plan decision needs your call";
    const raw = String((drafts[0] as { instruction?: unknown }).instruction || "").replace(/^(auto|chat):\s*/i, "").trim();
    const sub = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Drafted by your coach";
    slot.innerHTML = `<button class="draft-card reveal" id="draftCard" style="--i:0" type="button">
      <span class="draft-ico" aria-hidden="true">✦</span>
      <span class="draft-body">
        <span class="draft-h">${deps.escapeHtml(head)}</span>
        <span class="draft-sub">${deps.escapeHtml(sub)} · review posture</span>
      </span>
      <span class="draft-go" aria-hidden="true">→</span>
    </button>`;
    slot.querySelector("#draftCard")?.addEventListener("click", () => {
      deps.state.planJump = "coach";
      deps.activateTab("plan");
    });
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
    loadTableHint,
    loadContextBanner,
    loadDraftProposals,
    loadHealthFocusBanner,
  };

  Object.assign(globalThis, { CairnTodaySideLoaders: CAIRN_TODAY_SIDE_LOADERS });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodaySideLoaders: CAIRN_TODAY_SIDE_LOADERS });
  }
})();
