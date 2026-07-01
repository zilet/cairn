// @ts-check
// Coach proposal orchestration: durable draft jobs, apply/discard, and reconnect.

type CoachProposalControllerResult = import("../contracts/client-api.js").ClientProposalResult & {
  clamped?: unknown[];
};
type CoachProposalControllerRecord = Record<string, unknown>;
type CoachProposalControllerBusyElement<T extends Element = HTMLElement> = T & { _busyRestore?: () => void };
type CoachProposalControllerOpOptions = ClientAgentOpHandlers & {
  path: string;
  anchor: string;
  caption: string;
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => unknown;
  onFail: (error?: unknown) => unknown;
};

(() => {
  const lastApplyClamp: Record<string, unknown[]> = {};

  function isCoachProposalControllerRecord(value: unknown): value is CoachProposalControllerRecord {
    return !!value && typeof value === "object";
  }

  function coachProposalControllerRecord(value: unknown): CoachProposalControllerRecord {
    return isCoachProposalControllerRecord(value) ? value : {};
  }

  function coachProposalControllerRestoreBusy(value: Element | null | undefined): void {
    (value as CoachProposalControllerBusyElement | null | undefined)?._busyRestore?.();
  }

  // Plain-words failure line for a proposal draft: honest about cause (no agent vs
  // agent failed vs unreachable), mirroring mealDraftFailLine.
  function proposalDraftFailLine(err: unknown): string {
    if (coachProposalControllerRecord(err).agent_status === "unconfigured") {
      return "Drafting a plan needs a coaching agent — connect one in Settings.";
    }
    if (err) return "The coach replied but didn't return a plan — try again, or pick another agent in Settings.";
    return "Couldn't reach the coach — check your connection.";
  }

  // Shared runOp options for a Coach-view proposal draft, used by the trigger and
  // reload reconnector so render/fail behavior stays identical.
  function coachProposalOpOpts(): CoachProposalControllerOpOptions {
    return {
      path: "/agent/run",
      anchor: "#runstatus",
      caption: "proposal",
      guard: () => !$("#runstatus")?.isConnected,
      isFail: (r: unknown) => coachProposalControllerRecord(r).ok !== true,
      render: async () => {
        const status = $("#runstatus");
        if (status) status.textContent = "Draft ready — review below.";
        coachProposalControllerRestoreBusy($("#runbtn"));
        try { renderProposals(await api("/proposals?limit=10")); } catch {}
      },
      onFail: async (err?: unknown) => {
        const status = $("#runstatus");
        if (status) status.textContent = proposalDraftFailLine(err);
        coachProposalControllerRestoreBusy($("#runbtn"));
        try { renderProposals(await api("/proposals?limit=10")); } catch {}
      },
    };
  }

  // Draft a plan-update proposal from the Coach sub-view (#runbtn). Runs as a
  // durable background job so long drafts survive reloads and reconnect into
  // #runstatus; when background ops are off, runOp renders inline immediately.
  function runCoachProposal(agent: string, instruction: string): void {
    const status = $("#runstatus");
    const btn = $("#runbtn");
    if (btn) btnBusy(btn, "Drafting…");
    if (status) status.innerHTML = CairnUi.jobCaptionHtml();
    runOp("proposal", { agent, instruction }, coachProposalOpOpts());
  }

  // Apply one proposal by id. This is the single apply path shared by the Coach
  // list and the Plan -> Endurance composer.
  async function applyProposalById(id: string | number | undefined, btn?: Element | null): Promise<unknown> {
    if (btn) btnBusy(btn, "Applying…");
    let r: CoachProposalControllerResult | null = null;
    try { r = await api(`/proposals/${id}/apply`, { method: "POST" }); } catch { r = null; }
    const m = applyResultMessage(r);
    if (m.failed) { toast(m.message); return r; }
    if (Array.isArray(r?.clamped) && r.clamped.length) lastApplyClamp[String(id)] = r.clamped;
    toast(m.message);
    state.plan = [];
    swrInvalidate("plan");
    return r;
  }

  // Light refresh of just the proposals list: re-fetch + re-render, no full view
  // rebuild, preserving scroll and the apply transition.
  async function refreshProposals(): Promise<void> {
    try { renderProposals(await api("/proposals?limit=10")); } catch { /* keep last paint */ }
  }

  function renderProposals(proposals: unknown): void {
    const wrap = $("#proplist");
    if (!wrap) return;
    wrap.innerHTML = CairnProposal.coachProposalListHtml(proposals, lastApplyClamp);

    wrap.querySelectorAll<HTMLElement>("[data-apply]").forEach((b) =>
      b.addEventListener("click", async () => {
        await applyProposalById(b.dataset.apply, b);
        refreshProposals();
      })
    );
    wrap.querySelectorAll<HTMLElement>("[data-discard]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await api(`/proposals/${b.dataset.discard}/discard`, { method: "POST" }); } catch {}
        refreshProposals();
      })
    );
  }

  // The single registered reconnector for `proposal` jobs: Coach drafts and the
  // Plan -> Endurance composer enqueue the same kind, so this selects whichever
  // surface is currently mounted.
  function reconnectProposal(): ClientAgentOpHandlers | null {
    if (view.querySelector("#endDraftStatus")) {
      enduranceComposerLock();
      return CairnMealPlannerController.reconnectStatusHost(
        enduranceProposalOpOpts() as CoachProposalControllerOpOptions,
        "#endDraftStatus",
        "#endDraftBtn",
        false,
      );
    }
    if (view.querySelector("#runstatus")) {
      return CairnMealPlannerController.reconnectStatusHost(coachProposalOpOpts(), "#runstatus", "#runbtn", false);
    }
    return null;
  }

  const CAIRN_COACH_PROPOSAL_CONTROLLER = {
    applyProposalById,
    coachProposalOpOpts,
    reconnectProposal,
    refreshProposals,
    renderProposals,
    runCoachProposal,
  };

  Object.assign(globalThis, {
    CairnCoachProposalController: CAIRN_COACH_PROPOSAL_CONTROLLER,
    applyProposalById,
    reconnectProposal,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnCoachProposalController: CAIRN_COACH_PROPOSAL_CONTROLLER,
      applyProposalById,
      reconnectProposal,
    });
  }
})();
