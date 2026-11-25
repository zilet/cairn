// @ts-check
// Today rail salience wiring: agenda fetch, slot loaders, and generic-card actions.

type TodayRailAgenda = import("../contracts/client.js").ClientTodayAgenda;
type TodayRailCandidate = import("../contracts/client.js").ClientTodayAgendaCandidate;

type TodayRailState = {
  tab?: string;
  logDate: string;
  planJump?: string | null;
  chatPrefill?: string | null;
  meSeg?: string | null;
  standSeg?: string | null;
  progressSeg?: string | null;
};

type TodayRailLoaderKey =
  | "fuel"
  | "fueling-followup"
  | "week-ahead"
  | "program-adjustments"
  | "weekly-read"
  | "connection-insight"
  | "garmin-reconcile"
  | "lately";

type TodayRailAttention = import("../contracts/client.js").ClientTodayAttention;

type TodayRailDeps = {
  root: ParentNode;
  state: TodayRailState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  activateTab(tab: string): unknown;
  gotoChatWith(text: string): unknown;
  collapseEl(el: Element, done?: () => void): void;
  loadTodayReads(): unknown;
  runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
  escapeHtml(value: unknown): string;
  toast(message: string): void;
  invalidate(key: string): void;
  refreshToday(options: { soft: boolean }): unknown;
};

(() => {
  function railLoaders(): Window["CairnTodayRailLoaders"] {
    return (globalThis as unknown as { CairnTodayRailLoaders: Window["CairnTodayRailLoaders"] }).CairnTodayRailLoaders;
  }

  function loaderMap(deps: TodayRailDeps): Record<TodayRailLoaderKey, () => unknown> {
    const loadTodayReads = () => deps.loadTodayReads();
    return {
      fuel: () => railLoaders().loadFuelToday(deps.state.logDate, deps),
      "fueling-followup": () => railLoaders().loadFuelingFollowup(deps),
      "week-ahead": () => railLoaders().loadWeekAhead(deps),
      "program-adjustments": () => railLoaders().loadProgramAdjustmentsBanner(deps),
      "weekly-read": loadTodayReads,
      "connection-insight": loadTodayReads,
      "garmin-reconcile": () => railLoaders().loadGarminReconcile(deps),
      lately: () => railLoaders().loadRecentActivities(deps),
    };
  }

  async function fetchTodayAgenda(date: string, deps: TodayRailDeps): Promise<TodayRailAgenda | null> {
    try {
      const agenda = await deps.api("/today-agenda?date=" + encodeURIComponent(date || deps.state.logDate));
      const row = agenda && typeof agenda === "object" ? (agenda as Partial<TodayRailAgenda>) : null;
      if (!row || !Array.isArray(row.primary) || !Array.isArray(row.more)) return null;
      return row as TodayRailAgenda;
    } catch {
      return null;
    }
  }

  function railHtml(agenda: Partial<TodayRailAgenda> | null | undefined, genericPending: TodayRailCandidate[]): string {
    return CairnTodayAgenda.railHtml(agenda, genericPending);
  }

  // With no agenda (an older server, offline) the rail keeps only what the redesigned
  // column has no home for: the weekly read and a Garmin merge's Undo. The week ahead,
  // the program adjustments, the connection insight and "lately" live in Coming up, the
  // overnight digest, the new-connection line and This week (CairnTodayWorth.railAgenda).
  function fallbackRailHtml(isToday: boolean): string {
    return `<aside class="today-rail">
    <div id="weeklySlot" class="weekly-slot"></div>
    ${isToday ? `<div id="garminReconcileSlot" class="garmin-reconcile-slot"></div>` : ""}
  </aside>`;
  }

  function runAgendaRail(
    agenda: Partial<TodayRailAgenda> | null | undefined,
    genericPending: TodayRailCandidate[],
    deps: TodayRailDeps
  ): void {
    const called = new Set<() => unknown>();
    const loaders = loaderMap(deps);
    const buckets = CairnTodayAgenda.renderableBuckets(agenda);
    for (const candidate of [...buckets.primary, ...buckets.more]) {
      const key = candidate.client_card as TodayRailLoaderKey | undefined;
      if (!key) continue;
      const loader = loaders[key];
      if (!loader || called.has(loader)) continue;
      called.add(loader);
      try {
        loader();
      } catch {}
    }
    wireGenericAgendaCards(genericPending, deps);
  }

  // The loader keys runAgendaRail / runFallbackRail will call, in the same order
  // and with the same filtering — so the prefetch below starts exactly the reads
  // those loaders are about to make, and nothing else.
  function agendaLoaderKeys(agenda: Partial<TodayRailAgenda> | null | undefined, deps: TodayRailDeps): TodayRailLoaderKey[] {
    const loaders = loaderMap(deps);
    const keys: TodayRailLoaderKey[] = [];
    const buckets = CairnTodayAgenda.renderableBuckets(agenda);
    for (const candidate of [...buckets.primary, ...buckets.more]) {
      const key = candidate.client_card as TodayRailLoaderKey | undefined;
      if (!key || !loaders[key] || keys.includes(key)) continue;
      keys.push(key);
    }
    return keys;
  }

  function fallbackLoaderKeys(isToday: boolean): TodayRailLoaderKey[] {
    return isToday ? ["weekly-read", "garmin-reconcile"] : [];
  }

  // Start the rail's reads as soon as the agenda is known — before the first paint
  // is written — so each loader takes a request already in flight when its slot
  // mounts, instead of the rail waiting a full round trip behind the paint.
  function prefetchRail(
    agenda: Partial<TodayRailAgenda> | null | undefined,
    isToday: boolean,
    deps: TodayRailDeps
  ): void {
    const loaders = railLoaders() as Window["CairnTodayRailLoaders"] & {
      prefetchRail?: (keys: readonly string[], deps: TodayRailDeps) => void;
    };
    if (typeof loaders?.prefetchRail !== "function") return;
    try {
      loaders.prefetchRail(agenda ? agendaLoaderKeys(agenda, deps) : fallbackLoaderKeys(isToday), deps);
    } catch {}
  }

  function runFallbackRail(isToday: boolean, deps: TodayRailDeps): void {
    if (!isToday) return;
    try {
      deps.loadTodayReads();
    } catch {}
    railLoaders().loadGarminReconcile(deps);
  }

  // ---- the lead arbitration, applied to the rendered surface --------------
  // The server decides ONE surface earns today's position of prominence (see
  // src/domain/brain/today-attention.ts). Here that decision is honored by MOVING
  // the winning card's slot out of the side rail and into the main column, right
  // under the coach's voice — the same element, the same id, the same loader.
  // Nothing is duplicated, nothing is removed, and every other card stays exactly
  // where the agenda put it.
  const ATTENTION_LEAD_SELECTOR: Record<string, string> = {
    insight: "#insightSlot",
    weekly: "#weeklySlot",
    fuel: "#fuelSlot",
    // The feedback capture is bound to the finished-session card — the moment it
    // belongs to. It is MARKED as the lead there, never relocated.
    feedback: "#feedbackSlot",
  };

  // `closest` is absent under the vm test harness (mirrors today-session-feedback-client).
  function inCollapsedMore(el: Element): boolean {
    return typeof (el as Element & { closest?: (s: string) => Element | null }).closest === "function"
      ? !!el.closest("#todayMore")
      : false;
  }

  function promoteAttentionLead(root: ParentNode, attention: TodayRailAttention | null | undefined): void {
    const primary = attention && typeof attention === "object" ? String(attention.primary || "") : "";
    if (!primary || primary === "brief") return;
    const selector = ATTENTION_LEAD_SELECTOR[primary];
    if (!selector) return; // a surface this build can't draw — leave Today untouched
    const slot = root.querySelector(selector);
    if (!slot) return;
    // Deferred behind the quiet "more" disclosure means the SURPRISE BUDGET held it
    // back for today (repo/today-agenda.ts). Hoisting it inline would introduce the
    // very newcomer the budget deferred — pull, never push. Leave it waiting.
    if (inCollapsedMore(slot)) return;
    slot.setAttribute("data-attention", "lead");
    const lead = root.querySelector("#attentionLead");
    if (!lead || primary === "feedback") return;
    lead.appendChild(slot);
    // The agenda rail may now hold nothing but its masthead, and a header over no
    // cards is litter — so drop the MAST, never the aside. Removing the aside would
    // take every remaining slot with it (the FALLBACK rail's cards carry no
    // `card-stack-item` class at all), and nothing here may make a surface
    // unreachable. The fallback rail has no mast, so it is left untouched.
    const rail = root.querySelector(".today-rail");
    const remaining = rail?.querySelector(".card-stack-item, .today-more, .agenda-card");
    if (rail && !remaining) rail.querySelector(".rail-mast")?.remove();
  }

  // The changes line ("2 changes overnight") sits directly under the Brief. Its slot
  // is made here, beside the conductor slot, so a repaint that rebuilt the column
  // gets a fresh one; the component mounts into it and never looks outside it. A
  // tap opens the Changes feed the way every other Plan › Changes jump does.
  function mountChangesLine(root: ParentNode, deps: TodayRailDeps): () => void {
    const anchor = root.querySelector("#cfocusSlot") || root.querySelector("#attentionLead");
    const parent = anchor?.parentNode;
    if (!anchor || !parent) return () => {};
    let slot = root.querySelector("#changesLineSlot");
    if (!slot) {
      slot = anchor.ownerDocument.createElement("div");
      slot.id = "changesLineSlot";
      slot.className = "changes-line-slot";
      parent.insertBefore(slot, anchor);
    }
    return CairnChangesLineController.mount(slot, {
      peek: (key) => peekCached(key),
      load: (path, options) => cachedApi(path, options),
      reducedMotion: () => reducedMotion(),
      open: () => {
        deps.state.planJump = "coach";
        deps.activateTab("plan");
      },
    });
  }

  function wireGenericAgendaCards(pending: TodayRailCandidate[], deps: TodayRailDeps): void {
    if (!pending.length) return;
    deps.root.querySelectorAll<HTMLElement>("[data-agenda-act]").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", () => {
        const kind = button.getAttribute("data-agenda-act") || "";
        const id = button.getAttribute("data-agenda-id") || "";
        const candidate = pending.find((item) => item.id === id);
        // A card may carry a quieter secondary action alongside its primary one;
        // resolve which one this button is so we read the matching payload.
        const action =
          candidate?.action?.kind === kind
            ? candidate.action
            : candidate?.secondary_action?.kind === kind
              ? candidate.secondary_action
              : candidate?.action;
        const payload = action?.payload;
        if (kind === "hold-decision") {
          // Deterministic one-tap cancel: the server revert path flips the
          // announced decision to canceled (and supersedes its draft); no agent
          // turn is involved, so a held change never waits on a reachable coach.
          void CairnDecisionUndoController.revert(button, payload, deps, {
            reason: "hold on — keep my current plan",
            success: "Held — your current plan stays",
            stale: "That change can no longer be held.",
            failed: "Could not hold that change",
            after: () => deps.refreshToday({ soft: true }),
          });
          return;
        }
        if (kind === "undo-decision") {
          // Same server revert path as "hold-decision", but for a change that
          // ALREADY landed quietly (e.g. a Garmin reconcile) rather than one still
          // waiting at its natural boundary — same one tap, different wording.
          void CairnDecisionUndoController.revert(button, payload, deps, {
            reason: "undo — put it back",
            success: "Undone",
            stale: "That change could not be undone.",
            failed: "Could not undo that change",
            after: () => deps.refreshToday({ soft: true }),
          });
          return;
        }
        if (kind === "goal_checkin_confirm") {
          // "Still my goal": restart the stable clock, and the card goes now.
          const card = button.closest(".agenda-card");
          if (card) deps.collapseEl(card, () => card.remove());
          void deps.api("/goal-checkin/confirm", { method: "POST" }).catch(() => {});
          return;
        }
        if (kind.startsWith("chat")) {
          deps.gotoChatWith(typeof payload === "string" ? payload : candidate?.title || "");
          return;
        }
        if (kind === "plan-coach") {
          deps.state.planJump = "coach";
          deps.activateTab("plan");
          return;
        }
        if (kind === "plan-endurance") {
          deps.state.planJump = "endurance";
          deps.activateTab("plan");
          return;
        }
        if (kind === "me-health-standing") {
          deps.state.standSeg = null;
          deps.activateTab("stand");
          return;
        }
        if (kind === "me-health-read") {
          // Retire only this semantic presentation revision. The active health
          // directives continue shaping meals/training in the background; new or
          // materially changed evidence gets a new revision and can surface again.
          // Only a revision-carrying candidate acks — other candidates (since-last)
          // reuse this kind and must NOT fire a bogus ack (mirrors the dismiss guard).
          if (candidate?.revision) {
            void deps
              .api("/today-agenda/ack", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: candidate?.id || id, revision: candidate.revision }),
              })
              .catch(() => {});
          }
          // The whole-picture read lives on the Stand overview now.
          deps.state.standSeg = null;
          deps.activateTab("stand");
          return;
        }
        if (kind === "progress-energy") {
          deps.state.progressSeg = "energy";
          deps.activateTab("progress");
          return;
        }
        if (kind.startsWith("tab:")) deps.activateTab(kind.slice(4));
      });
    });

    deps.root.querySelectorAll<HTMLElement>("[data-agenda-dismiss]").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", () => {
        if (button.dataset.ackPending) return;
        const card = button.closest(".agenda-card");
        const id = button.getAttribute("data-agenda-dismiss") || card?.getAttribute("data-agenda-card") || "";
        const candidate = pending.find((item) => item.id === id);
        // Dismissal evidence (surface_dismissals) is independent of the ack call
        // below — it records that THIS card was dismissed today, regardless of
        // whether the card also carries a presentation revision to retire.
        // Fire-and-forget: never blocks the dismiss the athlete just asked for.
        if (id) void deps.api("/today-agenda/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }).catch(() => {});
        if (candidate?.revision) {
          button.dataset.ackPending = "1";
          void deps
            .api("/today-agenda/ack", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, revision: candidate.revision }),
            })
            .then((result) => {
              if (!(result as { ok?: unknown } | null)?.ok) return;
              if (card) deps.collapseEl(card, () => card.remove());
              else button.remove();
            })
            .catch(() => {})
            .finally(() => {
              delete button.dataset.ackPending;
            });
          return;
        }
        if (card) deps.collapseEl(card, () => card.remove());
        else button.remove();
      });
    });
  }

  const CAIRN_TODAY_RAIL_CONTROLLER = {
    fetchTodayAgenda,
    railHtml,
    fallbackRailHtml,
    runAgendaRail,
    runFallbackRail,
    prefetchRail,
    promoteAttentionLead,
    mountChangesLine,
    loadFuelToday: (date: string, deps: TodayRailDeps) => railLoaders().loadFuelToday(date, deps),
    loadWeekAhead: (deps: TodayRailDeps) => railLoaders().loadWeekAhead(deps),
    loadProgramAdjustmentsBanner: (deps: TodayRailDeps) => railLoaders().loadProgramAdjustmentsBanner(deps),
    loadRecentActivities: (deps: TodayRailDeps) => railLoaders().loadRecentActivities(deps),
    loadGarminReconcile: (deps: TodayRailDeps) => railLoaders().loadGarminReconcile(deps),
    wireGenericAgendaCards,
  };

  Object.assign(globalThis, { CairnTodayRailController: CAIRN_TODAY_RAIL_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodayRailController = CAIRN_TODAY_RAIL_CONTROLLER;
  }
})();
