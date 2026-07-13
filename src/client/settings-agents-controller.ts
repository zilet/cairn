// @ts-check
// Settings -> Agents controller: route pins, agent card wiring, and CLI update polling.
{
function settingsAgentsRequired<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing Settings Agents element: ${selector}`);
  return el;
}

function settingsAgentsOptional<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function settingsAgentsSelect(event: Event): HTMLSelectElement {
  return event.currentTarget as HTMLSelectElement;
}

function settingsAgentsEnabled(deps: ClientSettingsAgentsControllerDeps): Array<Record<string, unknown> & { name: string }> {
  return deps.workingModel.order
    .map((name) => deps.meta[name])
    .filter((agent): agent is Record<string, unknown> & { name: string } => !!agent && !deps.workingModel.disabled.has(agent.name));
}

function renderSettingsAgents(deps: ClientSettingsAgentsControllerDeps): void {
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
    coachDay: deps.workingModel.coach_day,
    coachHour: deps.workingModel.coach_hour,
    timeZone: deps.workingModel.time_zone,
    dayNames: deps.dayNames,
  });

  settingsAgentsRequired<HTMLSelectElement>(deps.root, "#strat").addEventListener("change", (event) => {
    deps.workingModel.agent_strategy = settingsAgentsSelect(event).value;
  });
  settingsAgentsRequired<HTMLSelectElement>(deps.root, "#coachDay").addEventListener("change", (event) => {
    deps.workingModel.coach_day = +settingsAgentsSelect(event).value;
  });
  settingsAgentsRequired<HTMLSelectElement>(deps.root, "#coachHour").addEventListener("change", (event) => {
    deps.workingModel.coach_hour = +settingsAgentsSelect(event).value;
  });
  deps.root.querySelectorAll<HTMLSelectElement>("[data-route]").forEach((select) => select.addEventListener("change", () => {
    const task = select.dataset.route || "";
    if (select.value) deps.workingModel.routes[task] = select.value;
    else delete deps.workingModel.routes[task];
  }));

  renderSettingsAgentList(deps);
  wireSettingsCliUpdate(deps);
}

function renderSettingsAgentList(deps: ClientSettingsAgentsControllerDeps): void {
  const wrap = settingsAgentsOptional<HTMLElement>(deps.root, "#agentlist");
  if (!wrap) return;
  wrap.innerHTML = CairnSettingsAgents.agentListHtml({
    order: deps.workingModel.order,
    disabled: deps.workingModel.disabled,
    meta: deps.meta,
    agentInfo: deps.agentInfo,
    agentModels: deps.agentModels,
    stagger: deps.stagger,
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
    const name = button.dataset.toggle || "";
    if (deps.workingModel.disabled.has(name)) deps.workingModel.disabled.delete(name);
    else deps.workingModel.disabled.add(name);
    deps.markDirty();
    renderSettingsAgentList(deps);
  }));
  wrap.querySelectorAll<HTMLButtonElement>("[data-up]").forEach((button) => button.addEventListener("click", () => {
    const index = deps.workingModel.order.indexOf(button.dataset.up || "");
    if (index > 0) {
      [deps.workingModel.order[index - 1], deps.workingModel.order[index]] = [deps.workingModel.order[index], deps.workingModel.order[index - 1]];
      deps.markDirty();
      renderSettingsAgentList(deps);
    }
  }));
  wrap.querySelectorAll<HTMLButtonElement>("[data-down]").forEach((button) => button.addEventListener("click", () => {
    const index = deps.workingModel.order.indexOf(button.dataset.down || "");
    if (index < deps.workingModel.order.length - 1) {
      [deps.workingModel.order[index + 1], deps.workingModel.order[index]] = [deps.workingModel.order[index], deps.workingModel.order[index + 1]];
      deps.markDirty();
      renderSettingsAgentList(deps);
    }
  }));
  wrap.querySelectorAll<HTMLButtonElement>("[data-connect]").forEach((button) => button.addEventListener("click", () => {
    const loginModal = deps.openAgentLoginModal ? deps.openAgentLoginModal() : undefined;
    if (loginModal) loginModal(button.dataset.connect || "");
    else deps.toast("Agent connect is unavailable here");
  }));
  wrap.querySelectorAll<HTMLButtonElement>("[data-detail]").forEach((button) => button.addEventListener("click", async () => {
    const name = button.dataset.detail || "";
    if (deps.agentInfo[name]) return;
    button.disabled = true;
    button.textContent = "checking…";
    try {
      const response = await deps.api(`/agents/${encodeURIComponent(name)}/info`) as SettingsScreenAgentInfoResponse;
      deps.agentInfo[name] = response.ok
        ? { version: response.version ?? null, model_current: response.model_current ?? null, update_available: !!response.update_available }
        : { version: null, model_current: null, update_available: false };
    } catch {
      deps.agentInfo[name] = { version: null, model_current: null, update_available: false };
    }
    renderSettingsAgentList(deps);
  }));
  wrap.querySelectorAll<HTMLButtonElement>("[data-models]").forEach((button) => button.addEventListener("click", async () => {
    const name = button.dataset.models || "";
    if (Array.isArray(deps.agentModels[name])) {
      delete deps.agentModels[name];
      renderSettingsAgentList(deps);
      return;
    }
    button.disabled = true;
    button.textContent = "loading…";
    try {
      const response = await deps.api(`/agents/${encodeURIComponent(name)}/models`) as SettingsScreenAgentModelsResponse;
      deps.agentModels[name] = response && response.ok && Array.isArray(response.models) ? response.models : [];
    } catch {
      deps.agentModels[name] = [];
    }
    renderSettingsAgentList(deps);
  }));
  wireSettingsCliInstallButtons(deps);
}

function renderSettingsCliStatus(deps: ClientSettingsAgentsControllerDeps, result: SettingsScreenCliUpdateStatus | null): void {
  const el = settingsAgentsOptional<HTMLElement>(deps.root, "#agentCliUpdateStatus");
  if (!el || !result) return;
  const names = Array.isArray(result.agents) ? result.agents.join(", ") : "";
  if (result.status === "running") el.textContent = `Installing ${names || "tool"}…`;
  else if (result.status === "succeeded" && names) el.textContent = `${names} ready · ${(result.finished_at || "").replace("T", " ").slice(0, 16)}`;
  else if (result.status === "failed") el.textContent = `Install failed${result.error ? `: ${result.error}` : ""}`;
  else el.textContent = "";
  const list = settingsAgentsOptional<HTMLElement>(deps.root, "#agentlist");
  list?.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((button) => {
    button.disabled = result.status === "running";
  });
}

async function pollSettingsCliStatus(deps: ClientSettingsAgentsControllerDeps): Promise<SettingsScreenCliUpdateStatus | null> {
  if (!settingsAgentsOptional(deps.root, "#agentCliUpdateStatus")) return null;
  let result = await deps.api("/agent-clis/update") as SettingsScreenCliUpdateStatus;
  renderSettingsCliStatus(deps, result);
  while (result.status === "running") {
    await deps.sleep(2000);
    result = await deps.api("/agent-clis/update") as SettingsScreenCliUpdateStatus;
    if (!settingsAgentsOptional(deps.root, "#agentCliUpdateStatus")) return null;
    renderSettingsCliStatus(deps, result);
  }
  return result;
}

async function refreshSettingsAgentMeta(deps: ClientSettingsAgentsControllerDeps): Promise<void> {
  const agents = await deps.api("/agents") as SettingsScreenAgent[];
  if (!Array.isArray(agents)) return;
  for (const agent of agents) {
    if (agent && typeof agent.name === "string") deps.meta[agent.name] = agent;
  }
}

function wireSettingsCliInstallButtons(deps: ClientSettingsAgentsControllerDeps): void {
  const list = settingsAgentsOptional<HTMLElement>(deps.root, "#agentlist");
  list?.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((button) => button.addEventListener("click", async () => {
    const agent = button.dataset.install || "";
    if (!agent) return;
    button.disabled = true;
    renderSettingsCliStatus(deps, { status: "running", agents: [agent], started_at: new Date().toISOString() });
    let result: SettingsScreenCliUpdateStatus | null = null;
    try {
      const started = await deps.api(`/agent-clis/${encodeURIComponent(agent)}/install`, { method: "POST" }) as SettingsScreenCliUpdateStatus;
      if (Array.isArray(started.agents) && !started.agents.includes(agent)) {
        throw new Error(`Another tool is already installing (${started.agents.join(", ")})`);
      }
      result = await pollSettingsCliStatus(deps);
    } catch (error) {
      renderSettingsCliStatus(deps, {
        status: "failed",
        agents: [agent],
        error: error instanceof Error ? error.message : "request failed",
      });
    }
    if (result?.status === "succeeded") {
      delete deps.agentInfo[agent];
      delete deps.agentModels[agent];
      await refreshSettingsAgentMeta(deps);
      renderSettingsAgentList(deps);
      deps.toast(`${agent} is ready to connect`);
    } else {
      deps.toast(`${agent} install failed`);
    }
  }));
}

function wireSettingsCliUpdate(deps: ClientSettingsAgentsControllerDeps): void {
  pollSettingsCliStatus(deps).catch(() => {});
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
