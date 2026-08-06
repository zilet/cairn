// @ts-check
// Today session-suggestion execution wiring: request lifecycle, reconnect, and actions.

type TodaySuggestedSession = import("../contracts/client.js").ClientSessionSuggestion;
type TodaySessionSuggestState = {
  logDate?: string;
  suggestedSession?: TodaySuggestedSession | null;
  suggestedSessionContext?: {
    agentJobId?: number | null;
    constraints?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  } | null;
};

type TodaySessionSuggestRunOptions = {
  path: "/session-suggest";
  anchor: "#sugSlot";
  caption: "session_suggest";
  stream: true;
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown, job?: unknown) => void;
  onFail: (result?: unknown) => void;
};

type TodaySessionSuggestReconnectHandlers = TodaySessionSuggestRunOptions & {
  onDone(result: unknown): void;
  onError(): void;
  onCanceled(): void;
};

type TodaySessionSuggestAskOptions = {
  minutes?: unknown;
  focus?: unknown;
  equipment?: unknown;
  constraints?: unknown;
  // One-tap entries (the Brief's recovery menu) accept the draft as soon as it
  // lands instead of painting a card and waiting for "Use this session". The card
  // is still rendered first, so a failed accept leaves the athlete looking at the
  // session they asked for with the button they need.
  autoUse?: boolean;
};

type TodaySessionSuggestDeps = {
  root: ParentNode;
  state: TodaySessionSuggestState;
  api(
    path: string,
    opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
  ): Promise<unknown>;
  storeCached(key: string, data: unknown): void;
  invalidate(key: string): void;
  openSession(date?: string | null, options?: Record<string, unknown>): unknown;
  runOp(
    kind: "session_suggest",
    body: Record<string, unknown>,
    options: TodaySessionSuggestRunOptions
  ): Promise<unknown>;
  thinkingCaption(el: Element, op?: string): () => void;
  runCountUps(scope?: ParentNode | null, options?: { snap?: boolean }): void;
  collapseEl(el: Element, done?: () => void): void;
  reducedMotion(): boolean;
  toast(message: string): void;
};

type TodaySessionPrepareRunResult<T> =
  | { current: boolean; ok: true; value: T }
  | { current: boolean; ok: false; error: unknown };

type TodaySessionPrepareCoordinator = {
  run<T>(date: string, task: () => Promise<T>): Promise<TodaySessionPrepareRunResult<T>>;
};

type TodayOfflineStageInput = {
  date: string;
  request: Record<string, unknown>;
  plan: Array<Record<string, unknown>>;
  selectedDay: number | null;
  suggestedSession?: Record<string, unknown> | null;
  localPrepareId: string;
};

type TodaySnapshotRecovery = {
  body: Record<string, unknown>;
  intent: Record<string, unknown>;
};

(() => {
  let sessionSuggestInFlight = false;

  // Athlete-voice, rotating replacement for the offline staged "why" — mirrors
  // SESSION_WHY_OVERRIDE in src/repo/adaptive-session.ts (this file compiles
  // standalone into the browser bundle and cannot import a server repo
  // module, so the algorithm below duplicates pickDayVariant's hash/day-index
  // logic instead of sharing it). Same date + key -> same phrasing.
  const SESSION_WHY_OVERRIDE: readonly string[] = [
    "Your call today.",
    "You picked this one yourself.",
    "Switched by you, not the usual order.",
  ];
  function pickOfflineDayVariant(variants: readonly string[], date: string, key: string): string {
    if (variants.length <= 1) return variants[0];
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const offset = Math.abs(hash % 9973);
    const ms = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
    const dayIndex = Number.isFinite(ms) ? Math.floor(ms / 864e5) : 0;
    const span = variants.length;
    return variants[(((dayIndex + offset) % span) + span) % span];
  }

  // One serial lane per date makes the server observe preparation intents in the
  // same order the athlete expressed them. The generation flag lets callers
  // suppress the result of an older request once a newer intent is queued.
  function createPrepareCoordinator(): TodaySessionPrepareCoordinator {
    const lanes = new Map<string, { generation: number; tail: Promise<void> }>();
    let intentEpoch = 0;
    return {
      run<T>(date: string, task: () => Promise<T>): Promise<TodaySessionPrepareRunResult<T>> {
        const intent = ++intentEpoch;
        const key = String(date || "");
        const lane = lanes.get(key) || { generation: 0, tail: Promise.resolve() };
        lane.generation += 1;
        const generation = lane.generation;
        const request = lane.tail.then(task, task);
        lane.tail = request.then(
          () => undefined,
          () => undefined
        );
        lanes.set(key, lane);
        return request.then(
          (value) => ({ current: lane.generation === generation && intentEpoch === intent, ok: true, value }),
          (error) => ({ current: lane.generation === generation && intentEpoch === intent, ok: false, error })
        );
      },
    };
  }

  function recordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      : [];
  }

  function cloneSnapshotValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(cloneSnapshotValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneSnapshotValue(entry)]),
      );
    }
    return value;
  }

  // Build the paired, reload-safe view used only while an exact prepare POST is
  // waiting in the existing outbox. It deliberately carries no composition or
  // session ID: `_local_prepare_id` pairs the two local records without ever
  // impersonating server identity.
  function stagedPrepareResponse(input: TodayOfflineStageInput): Record<string, unknown> | null {
    const source = String(input.request.source || "");
    // A train-anyway composition is authored by the server's current decision
    // envelope (including recovery/pain caps). A raw cached weekly plan cannot
    // safely impersonate it offline, so do not mount a contradictory local
    // prescription. Older queued/cached request shapes remain replayable.
    if (source === "adaptive_plan" && input.request.train_anyway === true) return null;
    const planSource = source === "adaptive_plan" || source === "manual_plan";
    let planDay: Record<string, unknown> | null = null;
    let payload: Record<string, unknown> | null = null;
    if (planSource) {
      const requested = source === "manual_plan" ? Number(input.request.day_number) : Number(input.selectedDay);
      planDay = input.plan.find((day) => Number(day.day_number) === requested) || null;
      if (!planDay) return null;
      payload = {
        title: planDay.name || "Today's session",
        focus: planDay.focus ?? null,
        why:
          source === "manual_plan"
            ? pickOfflineDayVariant(SESSION_WHY_OVERRIDE, input.date, "adaptive-session:why:override")
            : "Saved on this device; Cairn will confirm the plan when connected.",
        est_minutes: null,
        items: recordArray(planDay.items),
      };
    } else if (source === "agent_suggest") {
      payload = input.suggestedSession || null;
    } else if (source === "athlete_override") {
      payload =
        input.request.session && typeof input.request.session === "object"
          ? (input.request.session as Record<string, unknown>)
          : null;
    }
    if (!payload || !Array.isArray(payload.items)) return null;

    const localPrepareId = String(input.localPrepareId || "").trim();
    if (!localPrepareId) return null;
    const dailySession = {
      _staged_offline: true,
      _local_prepare_id: localPrepareId,
      date: input.date,
      source,
      status: "active",
      plan_day_id: planDay && Number.isInteger(Number(planDay.id)) ? Number(planDay.id) : null,
      title: payload.title ?? payload.name ?? null,
      focus: payload.focus ?? null,
      why: payload.why ?? null,
      est_minutes: payload.est_minutes ?? null,
      items: recordArray(payload.items).map((item, position) => ({ ...item, position })),
      constraints: input.request.constraints ?? null,
      provenance: input.request.provenance ?? null,
    };
    const session = {
      _staged_offline: true,
      _local_prepare_id: localPrepareId,
      date: input.date,
      sets: [],
      skips: [],
      daily_session: dailySession,
    };
    return { ok: true, staged: true, reused: false, daily_session: dailySession, session };
  }

  // Freeze the exact accepted local composition into an athlete override before
  // any mutable weekly-plan lookup can drift. The first replay still uses the
  // ordinary request; only an explicit "Use saved session" recovery uses this
  // immutable body with replace:true.
  function snapshotRecovery(
    dailySessionValue: unknown,
    originalRequestValue: unknown,
  ): TodaySnapshotRecovery | null {
    if (!dailySessionValue || typeof dailySessionValue !== "object") return null;
    const daily = dailySessionValue as Record<string, unknown>;
    const request = originalRequestValue && typeof originalRequestValue === "object"
      ? originalRequestValue as Record<string, unknown>
      : {};
    const date = String(daily.date || request.date || "");
    const recoveredFromSource = String(daily.source || request.source || "");
    const items = recordArray(daily.items).map((item) => cloneSnapshotValue(item) as Record<string, unknown>);
    if (!date || !recoveredFromSource || !Array.isArray(daily.items)) return null;
    const provenanceValue = request.provenance ?? daily.provenance;
    const originalProvenance = provenanceValue && typeof provenanceValue === "object"
      ? provenanceValue as Record<string, unknown>
      : {};
    const constraints = cloneSnapshotValue(
      daily.constraints !== undefined ? daily.constraints : (request.constraints ?? null),
    );
    const planDayId = daily.plan_day_id == null ? null : Number(daily.plan_day_id);
    const provenance: Record<string, unknown> = {
      entry: "offline_snapshot_recovery",
      recovered_from_source: recoveredFromSource,
      plan_day_id: Number.isInteger(planDayId) ? planDayId : null,
      ...(originalProvenance.entry ? { recovered_from_entry: String(originalProvenance.entry) } : {}),
      recovered_origin: {
        ...cloneSnapshotValue(originalProvenance) as Record<string, unknown>,
        source: recoveredFromSource,
        plan_day_id: Number.isInteger(planDayId) ? planDayId : null,
      },
      ...(Number.isInteger(Number(request.expected_active_id))
        ? { expected_active_id: Number(request.expected_active_id) }
        : {}),
    };
    const session = {
      name: String(daily.title || "Saved session"),
      focus: daily.focus == null ? null : String(daily.focus),
      why: daily.why == null ? null : String(daily.why),
      est_minutes: daily.est_minutes == null ? null : Number(daily.est_minutes),
      items: cloneSnapshotValue(items) as Array<Record<string, unknown>>,
    };
    const body = {
      date,
      source: "athlete_override",
      session,
      constraints,
      provenance,
      replace: true,
    };
    const intent = {
      date,
      source: "athlete_override",
      plan_day_id: null,
      title: session.name,
      focus: session.focus,
      why: session.why,
      est_minutes: session.est_minutes,
      items: cloneSnapshotValue(items) as Array<Record<string, unknown>>,
      constraints: cloneSnapshotValue(constraints),
      provenance: { ...provenance },
    };
    return { body, intent };
  }

  function meaningfulLegacySession(cachedSession: unknown, explicitReplacement: boolean): boolean {
    if (explicitReplacement || !cachedSession || typeof cachedSession !== "object") return false;
    const session = cachedSession as Record<string, unknown>;
    if (session.daily_session) return false;
    if (Array.isArray(session.sets) && session.sets.length > 0) return true;
    if (Array.isArray(session.skips) && session.skips.length > 0) return true;
    if (Array.isArray(session.skipped) && session.skipped.length > 0) return true;
    if (Number(session.skipped) > 0) return true;
    if (session.finished_at) return true;
    if (session.duration_min != null) return true;
    if (String(session.notes ?? "").trim()) return true;
    if (session.soreness != null || session.performance != null || String(session.joint_pain ?? "").trim()) return true;
    // getSessionByDate hydrates raw `garmin_json` as `garmin`; any non-null
    // value means the server row carries linked strength-activity evidence.
    if (session.garmin != null) return true;
    return false;
  }

  function cachedContinuation(
    cachedSession: unknown,
    cachedDailySession: unknown,
    explicitReplacement: boolean,
    hasPreparePrerequisite?: (id: string) => boolean,
  ): {
    ok: true;
    reused: true;
    staged: boolean;
    session: Record<string, unknown>;
    daily_session: Record<string, unknown>;
  } | null {
    if (explicitReplacement || !cachedSession || typeof cachedSession !== "object") return null;
    const session = cachedSession as Record<string, unknown>;
    const nested = session.daily_session;
    const daily =
      nested && typeof nested === "object"
        ? (nested as Record<string, unknown>)
        : cachedDailySession && typeof cachedDailySession === "object"
          ? (cachedDailySession as Record<string, unknown>)
          : null;
    if (!daily || daily.status !== "active") return null;
    let staged = false;
    if (daily._staged_offline === true) {
      const sessionPair = String(session._local_prepare_id || "");
      const dailyPair = String(daily._local_prepare_id || "");
      if (session._staged_offline !== true || !sessionPair || sessionPair !== dailyPair) return null;
      const prerequisiteExists = hasPreparePrerequisite
        ? hasPreparePrerequisite(sessionPair)
        : (() => {
            const rows = (globalThis as {
              CairnOutbox?: { list?(): Array<{ id?: unknown; kind?: unknown; state?: unknown }> };
            }).CairnOutbox?.list?.() || [];
            return rows.some((item) =>
              String(item.id || "") === sessionPair &&
              item.kind === "daily_session_prepare" &&
              item.state !== "needs_attention"
            );
          })();
      if (!prerequisiteExists) return null;
      staged = true;
    }
    return {
      ok: true,
      reused: true,
      staged,
      session: { ...session, daily_session: daily },
      daily_session: daily,
    };
  }

  function stageCachedContinuation(
    continuation: { session: Record<string, unknown>; daily_session: Record<string, unknown> },
    localPrepareId: string,
  ): { ok: true; reused: true; staged: true; session: Record<string, unknown>; daily_session: Record<string, unknown> } | null {
    const pair = String(localPrepareId || "").trim();
    if (!pair) return null;
    const dailySession = {
      ...continuation.daily_session,
      _staged_offline: true,
      _local_prepare_id: pair,
    };
    const session = {
      ...continuation.session,
      _staged_offline: true,
      _local_prepare_id: pair,
      daily_session: dailySession,
    };
    return { ok: true, reused: true, staged: true, session, daily_session: dailySession };
  }

  function suggestSlot(deps: TodaySessionSuggestDeps): Element | null {
    return deps.root.querySelector("#sugSlot");
  }

  function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  function suggestionContext(
    input: unknown,
    result?: unknown,
    job?: unknown
  ): NonNullable<TodaySessionSuggestState["suggestedSessionContext"]> {
    const request = recordValue(input);
    const row = recordValue(result);
    const jobRow = recordValue(job);
    const jobResult = recordValue(jobRow.result);
    const constraints: Record<string, unknown> = {};
    for (const key of ["minutes", "focus", "equipment", "constraints"] as const) {
      if (request[key] != null && request[key] !== "") constraints[key] = request[key];
    }
    const agentJobId = jobRow.id != null && Number.isInteger(Number(jobRow.id)) && Number(jobRow.id) > 0
      ? Number(jobRow.id)
      : null;
    const agent = jobRow.chosen_agent ?? row.agent ?? jobResult.agent;
    const tried = Array.isArray(row.tried)
      ? row.tried
      : Array.isArray(jobResult.tried)
        ? jobResult.tried
        : null;
    const verified = row.verified ?? jobResult.verified;
    return {
      agentJobId,
      constraints,
      provenance: {
        verification: "verified_agent_job",
        operation: "session_suggest",
        ...(agentJobId != null ? { agent_job_id: agentJobId } : {}),
        ...(agent != null ? { agent } : {}),
        ...(tried ? { tried: cloneSnapshotValue(tried) } : {}),
        ...(verified != null ? { verified: cloneSnapshotValue(verified) } : {}),
      },
    };
  }

  function sessionSuggestOpOpts(
    deps: TodaySessionSuggestDeps,
    request: Record<string, unknown> = {},
    autoUse = false,
  ): TodaySessionSuggestRunOptions {
    return {
      path: "/session-suggest",
      anchor: "#sugSlot",
      caption: "session_suggest",
      // Stream the session's "why" into the card as the coach writes it (stream-capable
      // agents); the done render swaps in the full session card in place.
      stream: true,
      guard: () => {
        const gone = !suggestSlot(deps)?.isConnected;
        if (gone) sessionSuggestInFlight = false;
        return gone;
      },
      isFail: (result: unknown) => {
        const row = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
        return !row || row.ok !== true || !row.session;
      },
      render: (result: unknown, job?: unknown) => {
        const row = result as { session: TodaySuggestedSession; verified?: unknown };
        sessionSuggestInFlight = false;
        const slot = suggestSlot(deps);
        if (!slot) return;
        deps.state.suggestedSession = row.session;
        deps.state.suggestedSessionContext = suggestionContext(request, result, job);
        slot.innerHTML = CairnTodaySessionSuggest.cardHtml(row.session, row.verified);
        deps.runCountUps(slot);
        wireSuggestCard(slot, deps);
        slot.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "nearest" });
        // One-tap entries accept what they just asked for. The card is painted and
        // wired FIRST so a refused/failed accept leaves a working "Use this session"
        // behind rather than an empty slot.
        if (autoUse) {
          const useButton = slot.querySelector<HTMLElement>('[data-sugaction="use"]');
          if (useButton) void acceptSuggestedSession(useButton, slot, deps);
        }
      },
      onFail: (result?: unknown) => {
        sessionSuggestInFlight = false;
        const slot = suggestSlot(deps);
        if (!slot) return;
        slot.innerHTML = CairnTodaySessionSuggest.failureHtml(result);
        wireSuggestCard(slot, deps);
      },
    };
  }

  function revealSessionComposer(deps: TodaySessionSuggestDeps): void {
    const slot = suggestSlot(deps);
    if (!slot || sessionSuggestInFlight) return;
    slot.innerHTML = CairnTodaySessionSuggest.composerHtml();
    const input = slot.querySelector<HTMLInputElement>(".sug-prompt");
    if (input && !deps.reducedMotion()) setTimeout(() => input.focus(), 60);
    const go = () => {
      const constraints = (input?.value || "").trim();
      void askForSession(constraints ? { constraints } : {}, deps);
    };
    slot.querySelector("[data-sugbuild]")?.addEventListener("click", go);
    slot.querySelector("[data-sugcancel]")?.addEventListener("click", () => {
      slot.innerHTML = "";
    });
    slot.querySelectorAll<HTMLElement>("[data-vibe]").forEach((button) =>
      button.addEventListener("click", () => {
        if (!input) return;
        input.value = input.value.trim() ? `${input.value.trim()}, ${button.dataset.vibe}` : button.dataset.vibe || "";
        input.focus();
      })
    );
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        go();
      }
    });
  }

  async function askForSession(opts: TodaySessionSuggestAskOptions = {}, deps: TodaySessionSuggestDeps): Promise<void> {
    if (sessionSuggestInFlight) {
      deps.toast("Already drafting a session…");
      return;
    }
    const slot = suggestSlot(deps);
    if (!slot) return;
    sessionSuggestInFlight = true;
    slot.innerHTML = CairnTodaySessionSuggest.loadingHtml();
    // Every caller of askForSession is the athlete explicitly asking for a session
    // (the composer's Build, Try again, a recovery-menu tap) — never a background
    // read. That ask is the training consent, so it rides with the job: on a train
    // day it changes nothing, and on a rest day it is the difference between the
    // session they were shown and an empty "Rest day" when they accept it. Agent /
    // MCP callers are untouched and must still say so themselves.
    const body: Record<string, unknown> = { date: deps.state.logDate, train_anyway: true };
    if (opts.minutes != null) body.minutes = opts.minutes;
    if (opts.focus) body.focus = opts.focus;
    if (opts.equipment) body.equipment = opts.equipment;
    if (opts.constraints) body.constraints = opts.constraints;

    await deps.runOp("session_suggest", body, sessionSuggestOpOpts(deps, body, opts.autoUse === true));
  }

  function wireSuggestCard(slot: Element, deps: TodaySessionSuggestDeps): void {
    slot.querySelectorAll<HTMLElement>("[data-sugaction]").forEach((button) =>
      button.addEventListener("click", async () => {
        const action = button.dataset.sugaction;
        const card = slot.querySelector(".sug-card");
        if (action === "dismiss") {
          deps.state.suggestedSession = null;
          deps.state.suggestedSessionContext = null;
          if (card)
            deps.collapseEl(card, () => {
              slot.innerHTML = "";
            });
          else slot.innerHTML = "";
          return;
        }
        if (action === "retry") {
          void askForSession({}, deps);
          return;
        }
        if (action !== "use") return;
        await acceptSuggestedSession(button, slot, deps);
      })
    );
  }

  // The "Use this session" body, reachable both from the button and from a
  // one-tap ask (see askForSession's autoUse). Every failure path restores the
  // button, so an auto-accept that fails degrades exactly into the manual card.
  async function acceptSuggestedSession(
    button: HTMLElement,
    slot: Element,
    deps: TodaySessionSuggestDeps,
  ): Promise<void> {
    const card = slot.querySelector(".sug-card");
    if (button.dataset.busy === "1") return;
    const session = deps.state.suggestedSession;
    if (!session || !Array.isArray(session.items)) return;
    const status = card?.querySelector<HTMLElement>(".sug-save-status");
    const original = button.textContent || "Use this session";
    const restore = () => {
      button.dataset.busy = "";
      button.removeAttribute("aria-busy");
      (button as HTMLButtonElement).disabled = false;
      button.textContent = original;
    };
    button.dataset.busy = "1";
    button.setAttribute("aria-busy", "true");
    (button as HTMLButtonElement).disabled = true;
    button.textContent = "Saving…";
    if (status) status.textContent = "Saving this session for today…";
    try {
      const context = deps.state.suggestedSessionContext || {};
      const date = String(deps.state.logDate || "");
      const opened = await deps.openSession(date, {
        source: "agent_suggest",
        agentJobId: context.agentJobId,
        constraints: context.constraints,
        provenance: context.provenance,
        replace: true,
        trigger: button,
      });
      if (opened !== true) {
        restore();
        return;
      }
      deps.state.suggestedSession = null;
      deps.state.suggestedSessionContext = null;
      const currentSlot = suggestSlot(deps);
      if (currentSlot) currentSlot.innerHTML = "";
      deps.toast("Saved for today — it will be here when you come back");
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Could not save this session. Try again when you're ready.";
      if (status) status.textContent = message;
      deps.toast(message);
      restore();
    }
  }

  function reconnectSessionSuggest(job: unknown, deps: TodaySessionSuggestDeps): TodaySessionSuggestReconnectHandlers | null {
    const slot = suggestSlot(deps);
    if (!slot) return null;
    sessionSuggestInFlight = true;
    slot.innerHTML = CairnTodaySessionSuggest.loadingHtml();
    const jobRow = recordValue(job);
    const request = recordValue(jobRow.input);
    const options = sessionSuggestOpOpts(deps, request);
    let stop = () => {};
    const capEl = slot.querySelector(".job-cap");
    if (capEl) stop = deps.thinkingCaption(capEl, options.caption);
    if (!deps.reducedMotion()) slot.classList.add("is-thinking");
    const clear = () => {
      stop();
      const currentSlot = suggestSlot(deps);
      if (currentSlot instanceof HTMLElement) {
        currentSlot.classList.remove("is-thinking", "is-thinking--determinate");
        currentSlot.style.removeProperty("--frac");
      }
    };
    return {
      ...options,
      onDone: (result: unknown) => {
        clear();
        if (options.isFail(result)) options.onFail(result);
        else options.render(result, job);
      },
      onError: () => {
        clear();
        options.onFail(null);
      },
      onCanceled: () => {
        clear();
        options.onFail(null);
      },
    };
  }

  const CAIRN_TODAY_SESSION_SUGGEST_CONTROLLER = {
    askForSession,
    cachedContinuation,
    createPrepareCoordinator,
    meaningfulLegacySession,
    reconnectSessionSuggest,
    revealSessionComposer,
    sessionSuggestOpOpts,
    snapshotRecovery,
    stageCachedContinuation,
    stagedPrepareResponse,
    wireSuggestCard,
  };

  Object.assign(globalThis, { CairnTodaySessionSuggestController: CAIRN_TODAY_SESSION_SUGGEST_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSuggestController = CAIRN_TODAY_SESSION_SUGGEST_CONTROLLER;
  }
})();
