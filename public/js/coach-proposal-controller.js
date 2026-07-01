(() => {
// @ts-check
// Coach proposal orchestration: durable draft jobs, apply/discard, and reconnect.
(() => {
    const lastApplyClamp = {};
    function isCoachProposalControllerRecord(value) {
        return !!value && typeof value === "object";
    }
    function coachProposalControllerRecord(value) {
        return isCoachProposalControllerRecord(value) ? value : {};
    }
    function coachProposalControllerRestoreBusy(value) {
        value?._busyRestore?.();
    }
    // Plain-words failure line for a proposal draft: honest about cause (no agent vs
    // agent failed vs unreachable), mirroring mealDraftFailLine.
    function proposalDraftFailLine(err) {
        if (coachProposalControllerRecord(err).agent_status === "unconfigured") {
            return "Drafting a plan needs a coaching agent — connect one in Settings.";
        }
        if (err)
            return "The coach replied but didn't return a plan — try again, or pick another agent in Settings.";
        return "Couldn't reach the coach — check your connection.";
    }
    // Shared runOp options for a Coach-view proposal draft, used by the trigger and
    // reload reconnector so render/fail behavior stays identical.
    function coachProposalOpOpts() {
        return {
            path: "/agent/run",
            anchor: "#runstatus",
            caption: "proposal",
            guard: () => !$("#runstatus")?.isConnected,
            isFail: (r) => coachProposalControllerRecord(r).ok !== true,
            render: async () => {
                const status = $("#runstatus");
                if (status)
                    status.textContent = "Draft ready — review below.";
                coachProposalControllerRestoreBusy($("#runbtn"));
                try {
                    renderProposals(await api("/proposals?limit=10"));
                }
                catch { }
            },
            onFail: async (err) => {
                const status = $("#runstatus");
                if (status)
                    status.textContent = proposalDraftFailLine(err);
                coachProposalControllerRestoreBusy($("#runbtn"));
                try {
                    renderProposals(await api("/proposals?limit=10"));
                }
                catch { }
            },
        };
    }
    // Draft a plan-update proposal from the Coach sub-view (#runbtn). Runs as a
    // durable background job so long drafts survive reloads and reconnect into
    // #runstatus; when background ops are off, runOp renders inline immediately.
    function runCoachProposal(agent, instruction) {
        const status = $("#runstatus");
        const btn = $("#runbtn");
        if (btn)
            btnBusy(btn, "Drafting…");
        if (status)
            status.innerHTML = CairnUi.jobCaptionHtml();
        runOp("proposal", { agent, instruction }, coachProposalOpOpts());
    }
    // Apply one proposal by id. This is the single apply path shared by the Coach
    // list and the Plan -> Endurance composer.
    async function applyProposalById(id, btn) {
        if (btn)
            btnBusy(btn, "Applying…");
        let r = null;
        try {
            r = await api(`/proposals/${id}/apply`, { method: "POST" });
        }
        catch {
            r = null;
        }
        const m = applyResultMessage(r);
        if (m.failed) {
            toast(m.message);
            return r;
        }
        if (Array.isArray(r?.clamped) && r.clamped.length)
            lastApplyClamp[String(id)] = r.clamped;
        toast(m.message);
        state.plan = [];
        swrInvalidate("plan");
        return r;
    }
    // Light refresh of just the proposals list: re-fetch + re-render, no full view
    // rebuild, preserving scroll and the apply transition.
    async function refreshProposals() {
        try {
            renderProposals(await api("/proposals?limit=10"));
        }
        catch { /* keep last paint */ }
    }
    function renderProposals(proposals) {
        const wrap = $("#proplist");
        if (!wrap)
            return;
        wrap.innerHTML = CairnProposal.coachProposalListHtml(proposals, lastApplyClamp);
        wrap.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
            await applyProposalById(b.dataset.apply, b);
            refreshProposals();
        }));
        wrap.querySelectorAll("[data-discard]").forEach((b) => b.addEventListener("click", async () => {
            try {
                await api(`/proposals/${b.dataset.discard}/discard`, { method: "POST" });
            }
            catch { }
            refreshProposals();
        }));
    }
    // The single registered reconnector for `proposal` jobs: Coach drafts and the
    // Plan -> Endurance composer enqueue the same kind, so this selects whichever
    // surface is currently mounted.
    function reconnectProposal() {
        if (view.querySelector("#endDraftStatus")) {
            enduranceComposerLock();
            return CairnMealPlannerController.reconnectStatusHost(enduranceProposalOpOpts(), "#endDraftStatus", "#endDraftBtn", false);
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
})();
