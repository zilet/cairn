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

  function fallbackRailHtml(isToday: boolean): string {
    return `<aside class="today-rail">
    ${isToday ? `<div id="weekAheadSlot" class="weekahead-slot"></div>` : ""}
    ${isToday ? `<div id="adjustSlot" class="adjust-slot"></div>` : ""}
    <div id="weeklySlot" class="weekly-slot"></div>
    <div id="insightSlot" class="insight-slot"></div>
    ${isToday ? `<div id="garminReconcileSlot" class="garmin-reconcile-slot"></div>` : ""}
    <div id="qlRecent" class="ql-recent lately-slot"></div>
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

  function runFallbackRail(isToday: boolean, deps: TodayRailDeps): void {
    railLoaders().loadRecentActivities(deps);
    if (!isToday) return;
    try {
      deps.loadTodayReads();
    } catch {}
    railLoaders().loadGarminReconcile(deps);
    railLoaders().loadWeekAhead(deps);
    railLoaders().loadProgramAdjustmentsBanner(deps);
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
          const decisionId = Number(payload);
          if (!Number.isFinite(decisionId) || button.dataset.busy === "1") return;
          button.dataset.busy = "1";
          button.setAttribute("aria-busy", "true");
          void (async () => {
            try {
              const result = (await deps.api(`/brain/decisions/${decisionId}/revert`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason: "hold on — keep my current plan" }),
              })) as { ok?: boolean; error?: string } | null;
              if (!result?.ok) throw new Error(result?.error || "That change can no longer be held.");
              deps.toast("Held — your current plan stays");
              await deps.refreshToday({ soft: true });
            } catch (error) {
              deps.toast(error instanceof Error ? error.message : "Could not hold that change");
              button.dataset.busy = "";
              button.removeAttribute("aria-busy");
            }
          })();
          return;
        }
        if (kind === "undo-decision") {
          // Same server revert path as "hold-decision", but for a change that
          // ALREADY landed quietly (e.g. a Garmin reconcile) rather than one still
          // waiting at its natural boundary — same one tap, different wording.
          const decisionId = Number(payload);
          if (!Number.isFinite(decisionId) || button.dataset.busy === "1") return;
          button.dataset.busy = "1";
          button.setAttribute("aria-busy", "true");
          void (async () => {
            try {
              const result = (await deps.api(`/brain/decisions/${decisionId}/revert`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason: "undo — put it back" }),
              })) as { ok?: boolean; error?: string } | null;
              if (!result?.ok) throw new Error(result?.error || "That change could not be undone.");
              deps.toast("Undone");
              await deps.refreshToday({ soft: true });
            } catch (error) {
              deps.toast(error instanceof Error ? error.message : "Could not undo that change");
              button.dataset.busy = "";
              button.removeAttribute("aria-busy");
            }
          })();
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
    promoteAttentionLead,
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
