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

function settingsChatProfileAgents(deps: ClientSettingsAgentsControllerDeps): Array<Record<string, unknown> & { name: string }> {
  return deps.workingModel.order
    .map((name) => deps.meta[name])
    .filter((agent): agent is Record<string, unknown> & { name: string } => {
      const capabilities = agent && typeof agent.capabilities === "object" ? agent.capabilities as Record<string, unknown> : {};
      return !!agent && agent.usable !== false && capabilities.execution_profile_noop !== true;
    });
}

function settingsChatProfileValue(value: string): string {
  return value.trim().slice(0, 160);
}

function updateSettingsChatProfile(deps: ClientSettingsAgentsControllerDeps, provider: string, lane: string, key: "model" | "reasoning", value: string): void {
  if (!provider || !["capture", "coach", "deep"].includes(lane)) return;
  const defaults: Record<string, string> = { capture: "low", coach: "medium", deep: "high" };
  const bindings = deps.workingModel.chat_profile_bindings;
  const profile = { ...(bindings[provider]?.[lane] || {}) };
  if (key === "model") {
    const model = settingsChatProfileValue(value);
    if (model) profile.model = model;
    else delete profile.model;
  } else {
    const capabilities = deps.meta[provider]?.capabilities as Record<string, unknown> | undefined;
    const levels = Array.isArray(capabilities?.reasoning) ? capabilities.reasoning.filter((item): item is string => typeof item === "string") : [];
    if (!levels.includes(value)) return;
    if (value === defaults[lane]) delete profile.reasoning;
    else profile.reasoning = value;
  }
  if (Object.keys(profile).length) {
    bindings[provider] = { ...(bindings[provider] || {}), [lane]: profile };
  } else if (bindings[provider]) {
    delete bindings[provider][lane];
    if (!Object.keys(bindings[provider]).length) delete bindings[provider];
  }
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
    agentStateHtml: deps.agentStateHtml || "",
    coachDay: deps.workingModel.coach_day,
    coachHour: deps.workingModel.coach_hour,
    timeZone: deps.workingModel.time_zone,
    dayNames: deps.dayNames,
    chatRoutingMode: deps.workingModel.chat_routing_mode,
    chatProfileBindings: deps.workingModel.chat_profile_bindings,
    chatProfileAgents: settingsChatProfileAgents(deps),
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
  settingsAgentsRequired<HTMLSelectElement>(deps.root, "#chatRoutingMode").addEventListener("change", (event) => {
    deps.workingModel.chat_routing_mode = settingsAgentsSelect(event).value === "single" ? "single" : "adaptive";
    deps.markDirty();
    renderSettingsAgents(deps);
  });
  deps.root.querySelectorAll<HTMLInputElement>("[data-chat-model]").forEach((input) => input.addEventListener("change", () => {
    updateSettingsChatProfile(deps, input.dataset.provider || "", input.dataset.lane || "", "model", input.value);
    deps.markDirty();
  }));
  deps.root.querySelectorAll<HTMLSelectElement>("[data-chat-reasoning]").forEach((select) => select.addEventListener("change", () => {
    updateSettingsChatProfile(deps, select.dataset.provider || "", select.dataset.lane || "", "reasoning", select.value);
    deps.markDirty();
  }));
  deps.root.querySelectorAll<HTMLSelectElement>("[data-route]").forEach((select) => select.addEventListener("change", () => {
    const task = select.dataset.route || "";
    if (select.value) deps.workingModel.routes[task] = select.value;
    else delete deps.workingModel.routes[task];
  }));

  renderSettingsAgentList(deps);
  wireSettingsCliUpdate(deps);
}

// The installer run this device last saw. Server truth (GET /agent-clis/update) wins on
// every poll and on every visit to Settings, so a reload or a trip to another screen
// lands on the true state; this is only what the cards draw from between polls.
let settingsCli: SettingsAgentCli | null = null;
let settingsCliFollower = 0;
let settingsCliTicker: ReturnType<typeof setInterval> | null = null;

// A progress redraw: the cards are already on screen, so they must not replay their entrance.
let settingsCliQuiet = false;
function redrawSettingsAgentCards(deps: ClientSettingsAgentsControllerDeps): void {
  settingsCliQuiet = true;
  try {
    renderSettingsAgentList(deps);
  } finally {
    settingsCliQuiet = false;
  }
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
    cli: settingsCli,
    now: Date.now(),
    reveal: !settingsCliQuiet,
    modelClassBindings: deps.workingModel.model_class_bindings,
    agentCatalog: CairnSettingsAgentModels.catalog(deps),
  });
  CairnSettingsAgentModels.wire(deps, wrap, () => redrawSettingsAgentCards(deps));

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
  wireSettingsCliRemoveButtons(deps);
}

function renderSettingsCliStatus(deps: ClientSettingsAgentsControllerDeps, result: SettingsScreenCliUpdateStatus | null): void {
  const el = settingsAgentsOptional<HTMLElement>(deps.root, "#agentCliUpdateStatus");
  if (!el || !result) return;
    const names = Array.isArray(result.agents) ? result.agents.join(", ") : "";
  const removing = result.action === "remove";
  if (result.status === "running") el.textContent = `${removing ? "Removing" : "Installing"} ${names || "tool"}…`;
  else if (result.status === "succeeded" && names)
    el.textContent = `${names} ${removing ? "removed" : "ready"} · ${(result.finished_at || "").replace("T", " ").slice(0, 16)}`;
    // The installer's classified failure leads (a full disk says what to do); the raw
    // log stays in the details below.
    else if (result.status === "failed")
      el.textContent = result.failure?.message || `${removing ? "Remove" : "Install"} failed${result.error ? `: ${result.error}` : ""}`;
    else el.textContent = "";
    const log = settingsAgentsOptional<HTMLElement>(deps.root, "#agentCliUpdateLog");
    if (log) {
      const output = [(result.stdout_tail || "").replace(/^CAIRN_PHASE .*\n?/gm, ""), (result.stderr_tail || "").replace(/^CAIRN_INSTALL_FAILURE .*\n?/gm, "")]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n")
        .trim();
      log.textContent = output || (result.status === "running" ? "Preparing installer…" : "");
      log.hidden = !log.textContent;
      if (!log.hidden) log.scrollTop = log.scrollHeight;
    }
}


// The card-facing identity of a run: the cards redraw only when this changes, and the
// elapsed clock ticks in place between redraws.
function settingsCliKey(cli: SettingsAgentCli | null): string {
  return cli ? [cli.status, cli.action, cli.phase, (cli.agents || []).join(","), cli.failure?.reason, cli.error].join("|") : "";
}

function adoptSettingsCli(deps: ClientSettingsAgentsControllerDeps, next: SettingsScreenCliUpdateStatus | null): void {
  const before = settingsCliKey(settingsCli);
  settingsCli = next ? { ...next, seen_at: Date.now() } : null;
  if (settingsCliKey(settingsCli) !== before) redrawSettingsAgentCards(deps);
  if (settingsCli?.status === "running" && !settingsCliTicker && typeof setInterval === "function") {
    settingsCliTicker = setInterval(() => {
      const el = deps.root.isConnected !== false ? deps.root.querySelectorAll<HTMLElement>("[data-cli-elapsed]") : [];
      if (!el.length || settingsCli?.status !== "running") {
        if (settingsCliTicker) clearInterval(settingsCliTicker);
        settingsCliTicker = null;
        return;
      }
      const text = CairnSettingsAgents.cliClock(CairnSettingsAgents.cliElapsedSeconds(settingsCli, Date.now()));
      el.forEach((node) => { node.textContent = text; });
    }, 1000);
  }
}

// Follow the installer run until it finishes, from a tap OR from arriving on Settings
// mid-run. One follower at a time; when it ends the cards return to the true state.
async function trackSettingsCli(deps: ClientSettingsAgentsControllerDeps, first?: SettingsScreenCliUpdateStatus): Promise<void> {
  // A newer follower (a tap, or a fresh visit to Settings) supersedes the one before it.
  const me = ++settingsCliFollower;
  try {
    let result = first || await deps.api("/agent-clis/update") as SettingsScreenCliUpdateStatus;
    // A run this device started is announced when it ends even if it finished before the first poll.
    let sawRunning = !!first;
    while (true) {
      if (me !== settingsCliFollower || deps.root.isConnected === false || !settingsAgentsOptional(deps.root, "#agentCliUpdateStatus")) return;
      if (result.status === "running") sawRunning = true;
      renderSettingsCliStatus(deps, result);
      adoptSettingsCli(deps, result);
      if (result.status !== "running") break;
      await deps.sleep(2000);
      result = await deps.api("/agent-clis/update") as SettingsScreenCliUpdateStatus;
    }
    if (!sawRunning) return;
    const agent = (result.agents || [])[0] || "tool";
    const removing = result.action === "remove";
    if (result.status === "succeeded") {
      delete deps.agentInfo[agent];
      delete deps.agentModels[agent];
      // The server dropped its catalog for this CLI too: re-read it with the new version.
      delete CairnSettingsAgentModels.catalog(deps)[agent];
    }
    await refreshSettingsAgentMeta(deps).catch(() => {});
    redrawSettingsAgentCards(deps);
    if (result.status === "succeeded") deps.toast(removing ? `${agent} removed` : `${agent} is ready to connect`);
    else deps.toast(removing ? `${agent} couldn't be removed` : `${agent} install failed`);
  } catch {
    // A dropped poll leaves the last drawn state; the next visit to Settings re-reads it.
  }
}

async function refreshSettingsAgentMeta(deps: ClientSettingsAgentsControllerDeps): Promise<void> {
  const agents = await deps.api("/agents") as SettingsScreenAgent[];
  if (!Array.isArray(agents)) return;
  for (const agent of agents) {
    if (agent && typeof agent.name === "string") deps.meta[agent.name] = agent;
  }
}

// Start (or attach to) an installer run: the card goes busy at once, from the tap, and
// the server's own phase takes over from the first poll.
async function startSettingsCliRun(deps: ClientSettingsAgentsControllerDeps, agent: string, action: "install" | "remove"): Promise<void> {
  adoptSettingsCli(deps, { status: "running", action, agents: [agent], phase: "starting", elapsed_sec: 0 });
  redrawSettingsAgentCards(deps);
  try {
    const started = await deps.api(
      action === "remove" ? `/agent-clis/${encodeURIComponent(agent)}/remove` : `/agent-clis/${encodeURIComponent(agent)}/install`,
      { method: "POST" }
    ) as SettingsScreenCliUpdateStatus;
    if (Array.isArray(started.agents) && !started.agents.includes(agent)) {
      throw new Error(`Another tool is already ${started.action === "remove" ? "being removed" : "installing"} (${started.agents.join(", ")})`);
    }
    await trackSettingsCli(deps, started);
  } catch (error) {
    const failed = { status: "failed", action, agents: [agent], error: error instanceof Error ? error.message : "request failed" };
    renderSettingsCliStatus(deps, failed);
    adoptSettingsCli(deps, failed);
    redrawSettingsAgentCards(deps);
    deps.toast(action === "remove" ? `${agent} couldn't be removed` : `${agent} install failed`);
  }
}

function wireSettingsCliInstallButtons(deps: ClientSettingsAgentsControllerDeps): void {
  const list = settingsAgentsOptional<HTMLElement>(deps.root, "#agentlist");
  list?.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((button) => button.addEventListener("click", async () => {
    const agent = button.dataset.install || "";
    if (agent && !button.disabled) await startSettingsCliRun(deps, agent, "install");
  }));
}

// Remove a provider's CLI to free disk: two taps (the first only arms the button), no
// dialog. Its sign-in stays in HOME, so Install brings it back without a new login.
function wireSettingsCliRemoveButtons(deps: ClientSettingsAgentsControllerDeps): void {
  const list = settingsAgentsOptional<HTMLElement>(deps.root, "#agentlist");
  list?.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => button.addEventListener("click", async () => {
    const agent = button.dataset.remove || "";
    if (!agent || button.disabled) return;
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = "tap again to remove";
      setTimeout(() => {
        if (!button.isConnected) return;
        delete button.dataset.armed;
        button.textContent = "remove";
      }, 4000);
      return;
    }
    await startSettingsCliRun(deps, agent, "remove");
  }));
}

function wireSettingsCliUpdate(deps: ClientSettingsAgentsControllerDeps): void {
  trackSettingsCli(deps).catch(() => {});
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
