// @ts-check
// Stateful Today Brief controller: fetch/cache and reconnect wiring.

type TodayBriefControllerDayRead = import("../contracts/client.js").ClientDayRead & {
  _provisional?: boolean;
  // Painted instantly from the last-known real read for this date (localStorage);
  // reconciled silently against the network fetch post-render.
  _cached?: boolean;
  // Set once the /today-read fetch has definitively failed (network error or a
  // malformed response), distinguishing a terminal fallback from a placeholder
  // that's still genuinely in flight — see loadBrief's fetchRead.
  _failed?: boolean;
  override?: string | null;
};

type TodayBriefControllerPlanDay = {
  day_number?: number;
  name?: string | null;
  items?: unknown[] | null;
};

type TodayBriefControllerState = {
  tab?: string;
  logDate: string;
  // Which programmed day the plan surface currently has selected; null until the
  // session preparation resolves one.
  day?: number | null;
  brief?: { date: string; override: string; read: TodayBriefControllerDayRead } | null;
  _briefInflight?: { date: string; override: string; promise: Promise<TodayBriefControllerDayRead> } | null;
  _briefMorph?: boolean;
  plan: TodayBriefControllerPlanDay[];
  planReveal?: { date: string; on: boolean; blank?: boolean } | null;
  progressSeg?: string;
};

type TodayBriefControllerRunOptions = ClientAgentOpHandlers & {
  path: "/today-read/reshape";
  anchor: ".brief";
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => void;
  onFail: (error: unknown) => void;
};

type TodayBriefControllerDeps = {
  root: HTMLElement;
  state: TodayBriefControllerState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  invalidate(key: string): void;
  renderToday(opts?: Record<string, unknown>): unknown;
  withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
  runOp(kind: "day_read_override", body: Record<string, unknown>, options: TodayBriefControllerRunOptions): Promise<unknown>;
  runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
  reducedMotion(): boolean;
  collapseEl(el: Element, done?: () => void): void;
  activateTab(tab: string): unknown;
  toast(message: string): void;
  localISO(date?: Date): string;
  escapeHtml(value: unknown): string;
  loadTrainingProvenance(isToday?: boolean): unknown;
  revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
  revealSessionComposer(): unknown;
  askForSession(opts?: { minutes?: unknown; focus?: unknown; constraints?: unknown; autoUse?: boolean }): unknown;
};

(() => {
  // localStorage key holding the most recent REAL (agentic, no-override) day read
  // so a warm reopen paints the true sentence INSTANTLY — no invented placeholder,
  // no visible swap when nothing changed. Bumped if the shape ever changes.
  const BRIEF_LS_KEY = "cairn.brief.v1";

  function briefStore(): Storage | null {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  }

  // The stored real read IFF it's for exactly this date (a previous day's read must
  // never paint for today). Returns a clean read (no internal flags) or null.
  function readCachedBrief(date: string): TodayBriefControllerDayRead | null {
    const store = briefStore();
    if (!store) return null;
    try {
      const raw = store.getItem(BRIEF_LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { date?: unknown; read?: TodayBriefControllerDayRead } | null;
      if (!parsed || parsed.date !== date || !parsed.read || !parsed.read.kind) return null;
      if (parsed.read._provisional) return null;
      return parsed.read;
    } catch {
      return null;
    }
  }

  // Persist the last-known real read. Only ever the canonical (no-override) read —
  // an override ("rough night") is transient and must not poison the next open —
  // and never a provisional/placeholder. Strips internal flags before storing.
  function persistCachedBrief(date: string, override: string, read: TodayBriefControllerDayRead | null | undefined): void {
    if (override || !read || read._provisional || !read.kind) return;
    const store = briefStore();
    if (!store) return;
    try {
      const clean = { ...read } as TodayBriefControllerDayRead;
      delete clean._provisional;
      delete clean._cached;
      store.setItem(BRIEF_LS_KEY, JSON.stringify({ date, read: clean }));
    } catch {}
  }

  function provisionalRead(_date: string): TodayBriefControllerDayRead {
    return CairnTodayBrief.provisionalRead();
  }

  async function loadBrief(
    date: string,
    override: string,
    deps: TodayBriefControllerDeps,
    opts: { fast?: boolean } = {},
  ): Promise<TodayBriefControllerDayRead> {
    const cached = deps.state.brief;
    // A same-date in-memory sentence is only an instant paint, not permanent
    // truth. Activity/recovery signals can change underneath this controller
    // (notably a Garmin run arriving after the morning open), so every render
    // revalidates it against /today-read while preserving the warm paint.
    const memoryCached =
      cached && cached.date === date && cached.override === (override || "") && !cached.read._provisional
        ? cached.read
        : null;
    const fetchRead: Promise<TodayBriefControllerDayRead> = (async () => {
      let read: TodayBriefControllerDayRead | null = null;
      try {
        const qs = new URLSearchParams({ date, agent: "auto" });
        if (override) qs.set("override", override);
        read = await deps.api("/today-read?" + qs.toString()) as TodayBriefControllerDayRead;
      } catch {
        read = null;
      }
      if (!read || !read.kind) read = { ...provisionalRead(date), _failed: true };
      persistCachedBrief(date, override || "", read);
      return read;
    })();

    if (opts.fast) {
      // Instant truth: if we've seen today's REAL read before (and there's no
      // override steer), paint it NOW as a normal read and reconcile silently
      // against the fetch post-render. The invented placeholder is reserved for a
      // genuinely first-ever open with nothing cached for this date.
      if (!override) {
        const stored = memoryCached || readCachedBrief(date);
        if (stored) {
          const instant: TodayBriefControllerDayRead = { ...stored, _cached: true };
          deps.state._briefInflight = { date, override: "", promise: fetchRead };
          deps.state.brief = { date, override: "", read: instant };
          return instant;
        }
      }
      const timeout = 1200;
      const raced: { r: TodayBriefControllerDayRead } | null = await Promise.race([
        fetchRead.then((r) => ({ r })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
      ]);
      if (raced && raced.r && !raced.r._provisional) {
        deps.state.brief = { date, override: override || raced.r.override || "", read: raced.r };
        return raced.r;
      }
      deps.state._briefInflight = { date, override: override || "", promise: fetchRead };
      const prov = (raced && raced.r) || provisionalRead(date);
      deps.state.brief = { date, override: override || "", read: prov };
      return prov;
    }

    deps.state._briefInflight = null;
    const read = await fetchRead;
    deps.state.brief = { date, override: override || read.override || "", read };
    return read;
  }

  // The freshness stamp is deliberately NOT a material difference (a bare clock tick
  // rewriting the whole Brief is the churn `materiallyDiffers` exists to prevent) —
  // but it was then simply left stale, so "Updated 4:00 AM" stood over a 7:39 row all
  // morning. Patch the one node instead: the cheapest possible repaint, and the
  // sentence above it never moves.
  function patchBriefStamp(
    briefEl: HTMLElement | null | undefined,
    read: TodayBriefControllerDayRead | null | undefined,
    isToday: boolean,
  ): void {
    const stamp = briefEl ? briefEl.querySelector(".brief-updated") : null;
    if (!stamp) return;
    const inner = CairnTodayBrief.updatedInnerHtml(read, CairnTodayBrief.kind(read), isToday);
    if (!inner) return;
    stamp.innerHTML = inner;
  }

  // The check-in mounts INSIDE the Brief now, so any repaint that replaces the Brief
  // node drops it. Re-run its loader against the fresh DOM; it is a no-op whenever
  // the slot is absent (a train/done read) or the day is already answered.
  function remountCheckin(): void {
    const load = (globalThis as { loadCheckin?: () => unknown }).loadCheckin;
    if (typeof load === "function") {
      try {
        void load();
      } catch {}
    }
  }

  async function upgradeBriefInPlace(date: string, isToday: boolean, deps: TodayBriefControllerDeps): Promise<void> {
    const inflight = deps.state._briefInflight;
    if (!inflight || inflight.date !== date) return;
    // What's painted right now: a `_cached` read reconciles SILENTLY (it's already
    // the true sentence, so no "thinking" flash and no swap unless content really
    // changed); a `_provisional` placeholder gets the visible thinking → settle.
    const shown = deps.state.brief && deps.state.brief.date === date ? deps.state.brief.read : null;
    const silent = !!(shown && shown._cached && !shown._provisional);
    const briefEl = deps.root.querySelector<HTMLElement>(".brief");
    if (briefEl && !silent && !deps.reducedMotion()) briefEl.classList.add("is-thinking");
    let read: TodayBriefControllerDayRead | null = null;
    try {
      read = await inflight.promise;
    } catch {
      read = null;
    }
    if (deps.state.tab !== "today" || deps.state.logDate !== date) return;
    if (deps.state._briefInflight === inflight) deps.state._briefInflight = null;
    if (!read || read._provisional) {
      // Refetch failed / not ready — keep whatever's painted (cached read stands).
      briefEl?.classList.remove("is-thinking");
      // If nothing real was cached (the paint IS the placeholder) and this was a
      // genuine terminal failure, adopt it so a later re-render doesn't re-add
      // the shimmer for a fetch that's already given up.
      if (read?._failed && shown && shown._provisional) {
        deps.state.brief = { date, override: inflight.override || "", read };
      }
      return;
    }
    // A cached paint that matches the network truth: adopt the fresh read into
    // state (drops the _cached flag) but touch ZERO DOM apart from the stamp — no
    // settle animation, no rewritten sentence.
    if (silent && shown && !CairnTodayBrief.materiallyDiffers(shown, read)) {
      deps.state.brief = { date, override: inflight.override || read.override || "", read };
      patchBriefStamp(briefEl, read, isToday);
      briefEl?.classList.remove("is-thinking");
      return;
    }
    deps.state.brief = { date, override: inflight.override || read.override || "", read };
    // A temporal-state change reshapes more than the sentence: train can mount a
    // Start-session card, while done/rest/easy must remove it. Re-render the whole
    // Today composition so a freshly synced run cannot leave a stale Start CTA
    // underneath an otherwise-correct completed Brief.
    if (shown && shown.kind !== read.kind) {
      briefEl?.classList.remove("is-thinking");
      await deps.renderToday({ soft: true });
      return;
    }
    const live = deps.root.querySelector(".brief");
    if (!live) return;
    // The Today tab renders the showPlan state as the session LAUNCH card
    // (.sess-launch), not the .plansurface branch — recognize both, or a same-kind
    // 'done' upgrade would think nothing below offers an entry and inject a
    // redundant "Log training" action above the live Continue card.
    const showPlan = !!(deps.root.querySelector(".plansurface") || deps.root.querySelector(".sess-launch"));
    const showDone = !!deps.root.querySelector(".sessiondone");
    const tmp = document.createElement("div");
    tmp.innerHTML = briefHtml(read, { showPlan, showDone, isToday }, deps);
    const fresh = tmp.firstElementChild;
    if (!fresh) {
      live.classList.remove("is-thinking");
      return;
    }
    fresh.classList.add(deps.reducedMotion() ? "" : "brief-settle");
    live.replaceWith(fresh);
    wireBrief(read, { isToday }, deps);
    remountCheckin();
    deps.runCountUps(fresh);
    if (showPlan) deps.loadTrainingProvenance(isToday);
  }

  async function reshapeToday(deps: TodayBriefControllerDeps): Promise<void> {
    deps.state.brief = null;
    deps.invalidate("today:session:" + deps.state.logDate);
    deps.invalidate("stats");
    deps.invalidate("progress:energy");
    if (deps.state.tab !== "today") return;
    await loadBrief(deps.state.logDate, "", deps);
    if (deps.state.tab !== "today") return;
    const morph = !deps.reducedMotion();
    if (morph) {
      deps.root.querySelector(".brief")?.classList.add("brief-morph");
      deps.state._briefMorph = true;
    }
    try {
      await deps.withViewTransition(() => deps.renderToday());
    } finally {
      deps.state._briefMorph = false;
      deps.root.querySelector(".brief")?.classList.remove("brief-morph");
    }
  }

  // The name of the programmed day this read is pointing at, for the action label
  // once the athlete's own pattern has earned it. The read's OWN plan selection
  // leads (`signals.plan_selection.selected.day_number` — the day the server chose
  // for this morning); the surface's current selection is the fallback. No match in
  // the loaded plan means no name, and the generic label stands — a button naming
  // the wrong day would be worse than one naming none.
  function briefPlanDayName(read: TodayBriefControllerDayRead | null | undefined, deps: TodayBriefControllerDeps): string {
    const plan = Array.isArray(deps.state.plan) ? deps.state.plan : [];
    if (!plan.length) return "";
    const signals = read?.signals && typeof read.signals === "object" ? (read.signals as Record<string, unknown>) : {};
    const selection =
      signals.plan_selection && typeof signals.plan_selection === "object"
        ? (signals.plan_selection as Record<string, unknown>)
        : null;
    const selected =
      selection && selection.selected && typeof selection.selected === "object"
        ? (selection.selected as Record<string, unknown>)
        : null;
    const candidates = [selected?.day_number, deps.state.day];
    for (const candidate of candidates) {
      if (candidate == null) continue;
      const dayNumber = Number(candidate);
      if (!Number.isFinite(dayNumber)) continue;
      const match = plan.find((day) => Number(day?.day_number) === dayNumber);
      const name = String(match?.name ?? "").trim();
      if (name) return name;
    }
    return "";
  }

  function briefHtml(
    read: TodayBriefControllerDayRead | null | undefined,
    options: { showPlan?: unknown; showDone?: unknown; isToday?: unknown } = {},
    deps: TodayBriefControllerDeps,
  ): string {
    const activeOverride = deps.state.brief && deps.state.brief.date === deps.state.logDate ? deps.state.brief.override : "";
    return CairnTodayBrief.briefHtml(read, {
      showPlan: !!options.showPlan,
      showDone: !!options.showDone,
      isToday: !!options.isToday,
      activeOverride,
      planDayName: briefPlanDayName(read, deps),
      morph: !!deps.state._briefMorph,
      reducedMotion: deps.reducedMotion(),
      offlineDismissed: CairnTodayBriefActionsClient.offlineDismissed(),
      tradeRefused: CairnTodayBriefActionsClient.tradeRefusedOn(deps.state.logDate),
    });
  }

  function briefSignalsText(read: TodayBriefControllerDayRead | null | undefined): string {
    return CairnTodayBrief.signalsText(read);
  }

  function wireBrief(
    read: TodayBriefControllerDayRead,
    options: { isToday?: boolean },
    deps: TodayBriefControllerDeps,
  ): void {
    CairnTodayBriefActionsClient.wireBriefActions(read, options, deps);
  }

  function paintBriefReshaping(brief: Element, chip: HTMLElement | null, deps: TodayBriefControllerDeps): void {
    CairnTodayBriefOverrideClient.paintBriefReshaping(brief, chip, deps);
  }

  function dayReadOverrideOpOpts(args: { intent?: string; prevFocus?: unknown } = {}, deps: TodayBriefControllerDeps): TodayBriefControllerRunOptions {
    return CairnTodayBriefOverrideClient.dayReadOverrideOpOpts(args, deps);
  }

  function reconnectDayReadOverride(job: unknown, deps: TodayBriefControllerDeps): ClientAgentOpHandlers | null {
    return CairnTodayBriefOverrideClient.reconnectDayReadOverride(job, deps);
  }

  const CAIRN_TODAY_BRIEF_CONTROLLER = {
    briefHtml,
    briefSignalsText,
    dayReadOverrideOpOpts,
    loadBrief,
    paintBriefReshaping,
    provisionalRead,
    reconnectDayReadOverride,
    reshapeToday,
    upgradeBriefInPlace,
    wireBrief,
  };

  Object.assign(globalThis, { CairnTodayBriefController: CAIRN_TODAY_BRIEF_CONTROLLER });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayBriefController: CAIRN_TODAY_BRIEF_CONTROLLER });
  }
})();
