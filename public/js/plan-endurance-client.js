(() => {
// @ts-check
// Plan -> Endurance renderers plus the running-plan screen orchestration.
(() => {
    const enduranceModel = () => CairnPlanEnduranceModel;
    async function renderPlanEndurance() {
        headerTitle.textContent = "Plan";
        state.planSeg = "endurance";
        view.innerHTML = segBar("endurance", planSeg()) + `<div id="endPlanBody">${loadingState("Reading your running…")}</div>`;
        wireSeg(PLAN_HANDLERS);
        const token = ++pollToken;
        let goal = null;
        let compliance = null;
        let plan = [];
        let settings = null;
        try {
            [goal, compliance, plan, settings] = await Promise.all([
                api("/endurance-goal").catch(() => null),
                api("/run-compliance").catch(() => null),
                api("/plan").catch(() => []),
                api("/settings").then((response) => enduranceModel().record(response).settings || null).catch(() => null),
            ]);
        }
        catch { /* paint with whatever resolved */ }
        if (token !== pollToken || !view.querySelector("#endPlanBody"))
            return;
        paintPlanEndurance(goal, compliance, plan, settings);
    }
    function paintPlanEndurance(goalValue, compliance, plan, settings) {
        const body = view.querySelector("#endPlanBody");
        if (!body)
            return;
        _endDrafting = false;
        const goal = goalValue;
        const goalHtml = goal
            ? enduranceGoalCard(goal)
            : `<div class="end-goal reveal" style="${stagger(0)}">
         <div class="end-goal-head"><span class="lbl">Running goal</span></div>
         <div class="end-goal-name">No goal set yet</div>
         <div class="end-goal-sub">Set a race or a standing readiness target in <b>Me → Profile</b> and the coach will periodize your running toward it.</div>
       </div>`;
        const rampHtml = rampHtmlForGoal(goal);
        const standingNote = goal && goal.mode === "standing"
            ? `<div class="end-ramp-note reveal" style="${stagger(1)}"><span class="lbl">Steady readiness</span> — no race to peak for, so the plan holds a sustainable rhythm rather than ramping.${goal.weekly_km ? ` Target around <b>${escHtml(goal.weekly_km)} km/wk</b>.` : ""}</div>`
            : "";
        const runs = enduranceModel().runs(plan);
        const totalKm = runs.reduce((sum, { it }) => sum + (Number(it.target_distance_km) || 0), 0);
        const totalMin = runs.reduce((sum, { it }) => sum + (Number(it.target_duration_min) || 0), 0);
        let volumeText = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
        if (totalKm > 0)
            volumeText += ` · ${fmtKm(totalKm)} km planned`;
        else if (totalMin > 0)
            volumeText += ` · ${Math.round(totalMin)} min planned`;
        if (totalKm > 0 && goal && goal.weekly_km)
            volumeText += ` · target ~${goal.weekly_km} km/wk`;
        const volumeLine = runs.length ? `<div class="end-runs-total numeral">${escHtml(volumeText)}</div>` : "";
        const runRows = runs.map(({ it, day_number }, index) => `
      <div class="end-run-row reveal" style="${stagger(index + 2)}">
        <span class="run-pin" aria-hidden="true">▸</span>
        <div class="end-run-main">
          <span class="end-run-name">${escHtml(cardioLabel(it))}</span>
          <span class="end-run-day lbl">Day ${escHtml(day_number)}</span>
        </div>
        <span class="end-run-pres numeral">${escHtml(cardioPrescription(it) || "—")}</span>
      </div>`).join("");
        const complianceHtml = typeof runComplianceLine === "function" ? runComplianceLine(compliance) : "";
        const syncHtml = typeof cardioSyncLine === "function" ? cardioSyncLine(settings, {}) : "";
        const runsSection = runs.length
            ? `<div class="end-runs reveal" style="${stagger(2)}">
         <div class="end-runs-h"><span class="lbl">This week's runs</span>
           <button class="end-link" id="endEditRuns">Edit in Training →</button></div>
         ${volumeLine}
         ${runRows}
       </div>${complianceHtml}${syncHtml}`
            : `<div class="end-runs-empty reveal" style="${stagger(2)}">
         <div class="lbl">This week's runs</div>
         <p>No runs in your plan yet. Ask the coach below to build your week — each run lands on its day and keeps your lifts intact.</p>
       </div>${complianceHtml}${syncHtml}`;
        const presets = enduranceModel().presets(goal);
        const chips = presets.map((preset, index) => `<button class="end-chip" data-egi="${index}">${escHtml(preset.t)}</button>`).join("");
        const composer = `<div class="end-shape reveal" style="${stagger(3)}">
      <div class="end-shape-h"><span class="lbl">Shape your running</span></div>
      <p class="end-shape-sub">Tell the coach what you want — it drafts run prescriptions you review and apply. Your lifting plan is never touched.</p>
      <div class="end-chips">${chips}</div>
      <textarea id="endInstr" class="form-textarea" rows="2" placeholder="e.g. ease my long run, my knee's cranky — or add a tempo on Thursday"></textarea>
      <button id="endDraftBtn" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ASK THE COACH</button>
      <div id="endDraftStatus" class="end-shape-status"></div>
      <div id="endDraft"></div>
    </div>`;
        const leadHtml = goal
            ? `<p class="end-lead">Your running plan — the build, this week's runs, and a quick way to shape them.</p>`
            : "";
        body.innerHTML = goalHtml + leadHtml + rampHtml + standingNote + runsSection + composer;
        body.querySelector("#endEditRuns")?.addEventListener("click", () => renderPlanEditor());
        if (syncHtml && typeof wireCardioSync === "function")
            wireCardioSync(body, () => renderPlanEndurance());
        body.querySelectorAll(".end-chip").forEach((button) => button.addEventListener("click", () => {
            const preset = presets[Number(button.dataset.egi) || 0];
            if (preset)
                draftEnduranceRuns(preset.i);
        }));
        body.querySelector("#endDraftBtn")?.addEventListener("click", () => {
            const instruction = (body.querySelector("#endInstr")?.value || "").trim();
            draftEnduranceRuns(instruction || presets[0].i);
        });
    }
    function rampHtmlForGoal(goal) {
        return enduranceModel().rampHtml(goal);
    }
    let _endDrafting = false;
    function enduranceComposerLock() {
        _endDrafting = true;
        view.querySelectorAll(".end-chip").forEach((chip) => { chip.disabled = true; });
    }
    function enduranceComposerRestore() {
        view.querySelectorAll(".end-chip").forEach((chip) => { chip.disabled = false; });
        view.querySelector("#endDraftBtn")?._busyRestore?.();
        _endDrafting = false;
    }
    function draftEnduranceRuns(instruction) {
        if (_endDrafting)
            return;
        enduranceComposerLock();
        const button = view.querySelector("#endDraftBtn");
        if (button)
            btnBusy(button, "Asking…");
        const status = view.querySelector("#endDraftStatus");
        if (status)
            status.innerHTML = CairnUi.jobCaptionHtml();
        const draftWrap = view.querySelector("#endDraft");
        if (draftWrap)
            draftWrap.innerHTML = "";
        runOp("proposal", { agent: "auto", instruction: String(instruction || "") }, enduranceProposalOpOpts());
    }
    function enduranceProposalOpOpts() {
        return {
            path: "/agent/run",
            anchor: "#endDraftStatus",
            caption: "endurance_runs",
            guard: () => !view.querySelector("#endDraftStatus")?.isConnected,
            isFail: (result) => {
                const row = enduranceModel().record(result);
                const proposal = enduranceModel().record(row.proposal);
                return !result || row.ok === false || !row.proposal || !proposal.parsed;
            },
            render: (result) => renderEnduranceDraftResult(enduranceModel().record(result).proposal),
            onFail: (error) => {
                enduranceComposerRestore();
                const status = view.querySelector("#endDraftStatus");
                if (!status)
                    return;
                status.textContent = enduranceModel().record(error).agent_status === "unconfigured"
                    ? "Drafting runs needs a coaching agent — connect one in Settings. You can still edit runs in Training."
                    : "The coach couldn't finish — try again, or pick another agent in Settings.";
            },
        };
    }
    function renderEnduranceDraftResult(proposal) {
        enduranceComposerRestore();
        const status = view.querySelector("#endDraftStatus");
        const draftWrap = view.querySelector("#endDraft");
        if (!status || !draftWrap)
            return;
        const p = enduranceModel().record(proposal);
        const cardio = p.parsed && Array.isArray(p.parsed.cardio) ? p.parsed.cardio : [];
        if (!cardio.length) {
            status.innerHTML = `The coach proposed plan changes but no runs this time. <button class="end-link" id="endToCoach">Review in Coach →</button>`;
            status.querySelector("#endToCoach")?.addEventListener("click", () => renderCoach());
            return;
        }
        status.textContent = "";
        draftWrap.innerHTML = enduranceModel().draftCardHtml(p);
        draftWrap.querySelector("[data-egapply]")?.addEventListener("click", async (event) => {
            const button = event.currentTarget instanceof Element ? event.currentTarget : null;
            if (!button)
                return;
            await applyProposalById(button.dataset.egapply, button);
            renderPlanEndurance();
        });
        draftWrap.querySelector("[data-egdiscard]")?.addEventListener("click", async (event) => {
            const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
            try {
                await api(`/proposals/${button?.dataset.egdiscard}/discard`, { method: "POST" });
            }
            catch { }
            draftWrap.innerHTML = "";
            status.textContent = "Discarded.";
        });
    }
    const CAIRN_PLAN_ENDURANCE = enduranceModel();
    Object.assign(globalThis, { CairnPlanEndurance: CAIRN_PLAN_ENDURANCE });
    Object.assign(globalThis, {
        renderPlanEndurance,
        paintPlanEndurance,
        enduranceComposerLock,
        enduranceComposerRestore,
        draftEnduranceRuns,
        enduranceProposalOpOpts,
        renderEnduranceDraftResult,
    });
    if (typeof window !== "undefined") {
        window.CairnPlanEndurance = CAIRN_PLAN_ENDURANCE;
        Object.assign(window, {
            renderPlanEndurance,
            paintPlanEndurance,
            enduranceComposerLock,
            enduranceComposerRestore,
            draftEnduranceRuns,
            enduranceProposalOpOpts,
            renderEnduranceDraftResult,
        });
    }
})();
})();
