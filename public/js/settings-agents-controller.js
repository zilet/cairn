(() => {
// @ts-check
// Settings -> Agents controller: route pins, agent card wiring, and CLI update polling.
{
    function settingsAgentsRequired(root, selector) {
        const el = root.querySelector(selector);
        if (!el)
            throw new Error(`Missing Settings Agents element: ${selector}`);
        return el;
    }
    function settingsAgentsOptional(root, selector) {
        return root.querySelector(selector);
    }
    function settingsAgentsInput(event) {
        return event.currentTarget;
    }
    function settingsAgentsSelect(event) {
        return event.currentTarget;
    }
    function settingsAgentsEnabled(deps) {
        return deps.workingModel.order
            .map((name) => deps.meta[name])
            .filter((agent) => !!agent && !deps.workingModel.disabled.has(agent.name));
    }
    function renderSettingsAgents(deps) {
        const enabledAgents = settingsAgentsEnabled(deps);
        if (deps.pruneRoutes) {
            deps.workingModel.routes = deps.pruneRoutes(deps.workingModel.routes, deps.routeTasks, enabledAgents);
        }
        const pinnedRouteCount = Object.keys(deps.workingModel.routes || {}).length;
        const routeSummary = `Route tasks to agents${pinnedRouteCount ? ` · ${pinnedRouteCount} pinned` : ""}`;
        const routeRowsHtml = deps.routeRowsHtml ? deps.routeRowsHtml(deps.routeTasks, enabledAgents, deps.workingModel.routes) : "";
        deps.root.innerHTML = CairnSettingsAgents.agentsSliceHtml({
            agentStrategy: deps.workingModel.agent_strategy,
            routeSummary,
            routeRowsHtml,
            agentHealthHtml: deps.agentHealthHtml,
            agentActivityHtml: deps.agentActivityHtml,
            noticedHtml: deps.noticedHtml,
            coachEnabled: deps.workingModel.coach_enabled,
            coachDay: deps.workingModel.coach_day,
            coachHour: deps.workingModel.coach_hour,
            dayNames: deps.dayNames,
        });
        settingsAgentsRequired(deps.root, "#strat").addEventListener("change", (event) => {
            deps.workingModel.agent_strategy = settingsAgentsSelect(event).value;
        });
        settingsAgentsRequired(deps.root, "#coachEnabled").addEventListener("change", (event) => {
            deps.workingModel.coach_enabled = settingsAgentsInput(event).checked;
        });
        settingsAgentsRequired(deps.root, "#coachDay").addEventListener("change", (event) => {
            deps.workingModel.coach_day = +settingsAgentsSelect(event).value;
        });
        settingsAgentsRequired(deps.root, "#coachHour").addEventListener("change", (event) => {
            deps.workingModel.coach_hour = +settingsAgentsSelect(event).value;
        });
        deps.root.querySelectorAll("[data-route]").forEach((select) => select.addEventListener("change", () => {
            const task = select.dataset.route || "";
            if (select.value)
                deps.workingModel.routes[task] = select.value;
            else
                delete deps.workingModel.routes[task];
        }));
        renderSettingsAgentList(deps);
        wireSettingsCliUpdate(deps);
    }
    function renderSettingsAgentList(deps) {
        const wrap = settingsAgentsOptional(deps.root, "#agentlist");
        if (!wrap)
            return;
        wrap.innerHTML = CairnSettingsAgents.agentListHtml({
            order: deps.workingModel.order,
            disabled: deps.workingModel.disabled,
            meta: deps.meta,
            agentInfo: deps.agentInfo,
            agentModels: deps.agentModels,
            stagger: deps.stagger,
        });
        wrap.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
            const name = button.dataset.toggle || "";
            if (deps.workingModel.disabled.has(name))
                deps.workingModel.disabled.delete(name);
            else
                deps.workingModel.disabled.add(name);
            deps.markDirty();
            renderSettingsAgentList(deps);
        }));
        wrap.querySelectorAll("[data-up]").forEach((button) => button.addEventListener("click", () => {
            const index = deps.workingModel.order.indexOf(button.dataset.up || "");
            if (index > 0) {
                [deps.workingModel.order[index - 1], deps.workingModel.order[index]] = [deps.workingModel.order[index], deps.workingModel.order[index - 1]];
                deps.markDirty();
                renderSettingsAgentList(deps);
            }
        }));
        wrap.querySelectorAll("[data-down]").forEach((button) => button.addEventListener("click", () => {
            const index = deps.workingModel.order.indexOf(button.dataset.down || "");
            if (index < deps.workingModel.order.length - 1) {
                [deps.workingModel.order[index + 1], deps.workingModel.order[index]] = [deps.workingModel.order[index], deps.workingModel.order[index + 1]];
                deps.markDirty();
                renderSettingsAgentList(deps);
            }
        }));
        wrap.querySelectorAll("[data-connect]").forEach((button) => button.addEventListener("click", () => {
            const loginModal = deps.openAgentLoginModal ? deps.openAgentLoginModal() : undefined;
            if (loginModal)
                loginModal(button.dataset.connect || "");
            else
                deps.toast("Agent connect is unavailable here");
        }));
        wrap.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", async () => {
            const name = button.dataset.detail || "";
            if (deps.agentInfo[name])
                return;
            button.disabled = true;
            button.textContent = "checking…";
            try {
                const response = await deps.api(`/agents/${encodeURIComponent(name)}/info`);
                deps.agentInfo[name] = response.ok
                    ? { version: response.version ?? null, model_current: response.model_current ?? null, update_available: !!response.update_available }
                    : { version: null, model_current: null, update_available: false };
            }
            catch {
                deps.agentInfo[name] = { version: null, model_current: null, update_available: false };
            }
            renderSettingsAgentList(deps);
        }));
        wrap.querySelectorAll("[data-models]").forEach((button) => button.addEventListener("click", async () => {
            const name = button.dataset.models || "";
            if (Array.isArray(deps.agentModels[name])) {
                delete deps.agentModels[name];
                renderSettingsAgentList(deps);
                return;
            }
            button.disabled = true;
            button.textContent = "loading…";
            try {
                const response = await deps.api(`/agents/${encodeURIComponent(name)}/models`);
                deps.agentModels[name] = response && response.ok && Array.isArray(response.models) ? response.models : [];
            }
            catch {
                deps.agentModels[name] = [];
            }
            renderSettingsAgentList(deps);
        }));
    }
    function renderSettingsCliStatus(deps, result) {
        const el = settingsAgentsOptional(deps.root, "#agentCliUpdateStatus");
        if (!el || !result)
            return;
        if (result.status === "running")
            el.textContent = `Updating since ${(result.started_at || "").replace("T", " ").slice(0, 16)}`;
        else if (result.status === "succeeded")
            el.textContent = `Updated ${(result.finished_at || "").replace("T", " ").slice(0, 16)}`;
        else if (result.status === "failed")
            el.textContent = `Update failed${result.error ? `: ${result.error}` : ""}`;
        else
            el.textContent = "";
    }
    async function pollSettingsCliStatus(deps) {
        const btn = settingsAgentsOptional(deps.root, "#updateAgentClis");
        if (!btn)
            return;
        let result = await deps.api("/agent-clis/update");
        renderSettingsCliStatus(deps, result);
        if (!btn.isConnected)
            return;
        btn.disabled = result.status === "running";
        while (result.status === "running") {
            await deps.sleep(2000);
            result = await deps.api("/agent-clis/update");
            if (!settingsAgentsOptional(deps.root, "#agentCliUpdateStatus"))
                return;
            renderSettingsCliStatus(deps, result);
            const nextBtn = settingsAgentsOptional(deps.root, "#updateAgentClis");
            if (nextBtn)
                nextBtn.disabled = result.status === "running";
        }
    }
    function wireSettingsCliUpdate(deps) {
        settingsAgentsRequired(deps.root, "#updateAgentClis").addEventListener("click", async () => {
            const btn = settingsAgentsRequired(deps.root, "#updateAgentClis");
            btn.disabled = true;
            renderSettingsCliStatus(deps, { status: "running", started_at: new Date().toISOString() });
            await deps.api("/agent-clis/update", { method: "POST" });
            await pollSettingsCliStatus(deps);
            deps.toast("CLI update finished");
        });
        pollSettingsCliStatus(deps).catch(() => { });
    }
    const CAIRN_SETTINGS_AGENTS_CONTROLLER = {
        render: renderSettingsAgents,
        renderList: renderSettingsAgentList,
    };
    Object.assign(globalThis, { CairnSettingsAgentsController: CAIRN_SETTINGS_AGENTS_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnSettingsAgentsController = CAIRN_SETTINGS_AGENTS_CONTROLLER;
    }
}
})();
