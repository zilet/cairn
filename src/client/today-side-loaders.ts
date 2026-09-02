// @ts-check
// Today side loaders: slot-bound async panels that sit around the main render path.

// The slim projection from listMealPlansSummary() (server: src/repo/nutrition.ts) —
// only what this screen renders, plus the `adequate` verdict the server already
// computed so this loader never needs the kcal/protein totals a full plan carries.
type TodaySideMealPlan = {
  id?: number;
  status?: string;
  constraint_state?: { status?: string } | null;
  adequate?: boolean;
  days?: Array<{ day?: string; meals?: Array<{ name?: string }> }>;
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

type TodaySideComposite = Record<string, unknown>;

(() => {
  function isCurrentToday(deps: TodaySideLoaderDeps): boolean {
    return deps.state.tab === "today";
  }

  // ---- the composite side read (GET /today-side), primed once per render ----
  // These panels are independent small GETs fired in the same burst, so the render
  // that starts them can ask for all of them in ONE trip instead (see
  // src/routes/today-side.ts). The composite is a PREFETCH, never a requirement:
  // a loader takes its key if one was primed for the date it is drawing, and
  // otherwise fetches exactly as it did before — so every call site that isn't the
  // Today post-render wiring (compat bridges, the phase-2 health lever after the
  // prime was already spent) keeps working untouched.
  //
  // Each key is handed out AT MOST ONCE. A second draw of the same panel is a
  // deliberate refresh, and a one-shot prime can never age into a stale answer
  // that outlives the render it belongs to.
  let sidePrefetch: { date: string; promise: Promise<TodaySideComposite | null>; taken: Set<string> } | null = null;

  function primeTodaySide(date: unknown, promise: Promise<unknown> | unknown): void {
    sidePrefetch = {
      date: String(date || ""),
      promise: Promise.resolve(promise)
        .then((value) => (value && typeof value === "object" ? value as TodaySideComposite : null))
        .catch(() => null),
      taken: new Set<string>(),
    };
  }

  // The primed value for `key`, or `undefined` when the caller should fetch its
  // own. A key the server could not read comes back null (per-key degradation) —
  // that reads as `undefined` here too, so the individual route still gets its
  // chance rather than the panel silently going dark.
  async function sideValue(deps: TodaySideLoaderDeps, key: string): Promise<unknown> {
    const prime = sidePrefetch;
    if (!prime || prime.date !== deps.state.logDate || prime.taken.has(key)) return undefined;
    prime.taken.add(key);
    const data = await prime.promise;
    const value = data ? data[key] : undefined;
    return value == null ? undefined : value;
  }

  // Today: the "body's reaction" card for a strength session reconciled from Garmin.
  function garminSessionCard(value: unknown): string {
    return CairnTodayLately.garminSessionCard(value);
  }

  // Today: personal-baseline recovery bands under the wearable strip — today's
  // HRV / resting HR / sleep read against the athlete's OWN range in plain words
  // (no score). Independent of the Garmin cell strip below: it draws from the
  // unified recovery view, so it surfaces even when only Apple/Oura data is
  // present. Absent/thin → the slot stays empty (the client degrades silently).
  //
  // A dimension whose newest reading is too old to speak for today arrives with
  // `position: null` — the band draws WITHOUT a dot (never a stale value placed as
  // though it were current) and picks up a quiet "last reading N ago" note so the
  // range is dated honestly. Information, not a nudge to go put the watch on.
  //
  // A dot present is NOT the same claim as "the range is fresh": the sample-
  // anchored band (src/repo/baseline-bands.ts) can span months for an episodic
  // wearer sitting behind a single recent reading — the newest 28 readings within
  // 180 days, not the newest 28 DAYS. Past this many days of span the range is
  // disclosed even WITH a dot, so a months-wide range never quietly passes as a
  // tight recent one. A daily wearer's span sits well under this, so their row
  // stays exactly as it read before.
  const BAND_SPAN_DISCLOSURE_DAYS = 45;

  // A short, calm, fixed qualifier — a UI row fragment (like the phrase/label sets
  // in baseline-bands.ts), not the day read's rotating prose, so one fixed
  // template is the right shape here rather than a variant set.
  function spanQualifier(spanDays: number): string {
    if (spanDays >= 60) {
      const months = Math.max(1, Math.round(spanDays / 30));
      return `range from readings over the last ~${months} month${months === 1 ? "" : "s"}`;
    }
    const weeks = Math.max(1, Math.round(spanDays / 7));
    return `range from readings over the last ~${weeks} week${weeks === 1 ? "" : "s"}`;
  }

  function recoveryBandPhrase(d: Record<string, unknown>, hasDot: boolean): string {
    const phrase = d.phrase == null ? "" : String(d.phrase);
    const last = typeof d.last_reading_date === "string" ? d.last_reading_date : "";
    const span = typeof d.span_days === "number" && Number.isFinite(d.span_days) ? d.span_days : null;
    if (!hasDot) {
      if (!last) return phrase;
      const age = relAge(last);
      return age ? (phrase ? `${phrase} · last reading ${age}` : `last reading ${age}`) : phrase;
    }
    if (span != null && span > BAND_SPAN_DISCLOSURE_DAYS) {
      const qualifier = spanQualifier(span);
      return phrase ? `${phrase} · ${qualifier}` : qualifier;
    }
    return phrase;
  }

  async function loadRecoveryBands(deps: TodaySideLoaderDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#wearBands");
    if (!slot) return;
    let data: unknown = await sideValue(deps, "recovery_baseline");
    if (data === undefined) {
      try { data = await deps.api("/recovery/baseline"); } catch { return; }
    }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const dims = data && typeof data === "object" && Array.isArray((data as { dimensions?: unknown }).dimensions)
      ? ((data as { dimensions: Array<Record<string, unknown>> }).dimensions)
      : [];
    if (!dims.length) { slot.innerHTML = ""; return; }
    const rows = dims
      .map((d) => {
        const hasDot = typeof d.position === "number" && Number.isFinite(d.position);
        return CairnUiReads.baselineBandHtml({
          label: d.label,
          position: hasDot ? d.position : null,
          rangeStart: d.range_start,
          rangeEnd: d.range_end,
          phrase: recoveryBandPhrase(d, hasDot),
          hot: hasDot && d.hot === true,
        });
      })
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
    let rows: unknown = await sideValue(deps, "garmin_daily");
    if (rows === undefined) {
      try { rows = await deps.api("/garmin/daily?limit=1"); } catch { return; }
    }
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

  // Mirror the server's canonical-current selection (listMealPlansSummary already
  // carries the server's own assessMealPlanAdequacy() verdict as `adequate`, so
  // there's no need to re-derive it from kcal/protein totals the slim shape omits):
  // a kept/accepted/applied adequate plan wins, else an adequate draft, else none.
  const KEPT_MEAL_PLAN_STATUSES = ["accepted", "applied", "kept"];
  function currentMealPlanSummary(plans: TodaySideMealPlan[]): TodaySideMealPlan | null {
    return (
      plans.find((plan) => KEPT_MEAL_PLAN_STATUSES.includes(String(plan.status)) && plan.adequate) ||
      plans.find((plan) => plan.status === "draft" && plan.adequate) ||
      null
    );
  }

  // Today: a one-line pointer to the day's planned meals.
  async function loadTableHint(deps: TodaySideLoaderDeps): Promise<void> {
    const wrap = deps.root.querySelector<HTMLElement>("#tableHint");
    if (!wrap) return;
    const primedPlans = await sideValue(deps, "mealplans");
    let plans: TodaySideMealPlan[] = [];
    if (primedPlans === undefined) {
      try { plans = await deps.api("/mealplans?limit=6&fields=summary") as TodaySideMealPlan[]; } catch { return; }
    } else {
      plans = primedPlans as TodaySideMealPlan[];
    }
    if (!isCurrentToday(deps) || !wrap.isConnected) return;
    const p = currentMealPlanSummary(plans);
    if (p?.constraint_state?.status === "refresh_needed") return;
    const days = Array.isArray(p?.days) ? p.days : [];
    const lbl = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(deps.state.logDate + "T12:00:00").getDay()];
    const day = days.find((d) => String(d.day || "").toLowerCase().startsWith(lbl));
    const meals = day && Array.isArray(day.meals) ? day.meals : [];
    if (!meals.length) return;
    const first = meals[0].name || "";
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
    const primedEvents = await sideValue(deps, "context_events");
    let events: TodaySideContextEvent[] = [];
    if (primedEvents === undefined) {
      try { events = await deps.api("/context-events?active=1") as TodaySideContextEvent[]; } catch { events = []; }
    } else {
      events = primedEvents as TodaySideContextEvent[];
    }
    if (!isCurrentToday(deps) || !wrap.isConnected) return;
    wrap.innerHTML = CairnTodayContext.contextBannerHtml(events);
  }

  // Today: one quiet health-focus line from the latest whole-picture review.
  async function loadHealthFocusBanner(deps: TodaySideLoaderDeps): Promise<void> {
    const wrap = deps.root.querySelector<HTMLElement>("#ctxHealth");
    if (!wrap) return;
    const primedSynthesis = await sideValue(deps, "health_synthesis");
    let data: TodaySideHealthSynthesisBanner | null = null;
    if (primedSynthesis === undefined) {
      try { data = await deps.api("/health/synthesis") as TodaySideHealthSynthesisBanner; } catch { data = null; }
    } else {
      data = primedSynthesis as TodaySideHealthSynthesisBanner;
    }
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
    primeTodaySide,
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
