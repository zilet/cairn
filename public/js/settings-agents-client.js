(() => {
// @ts-check
// Pure Settings -> Agents render helpers.
function settingsAgentStrategyOption(current, value, label) {
    return `<option value="${escAttr(value)}" ${current === value ? "selected" : ""}>${escHtml(label)}</option>`;
}
function settingsAgentDayOptions(dayNames, selectedDay) {
    return dayNames
        .map((day, index) => `<option value="${index}" ${selectedDay === index ? "selected" : ""}>${escHtml(day)}</option>`)
        .join("");
}
function settingsAgentHourOptions(selectedHour) {
    return Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${selectedHour === hour ? "selected" : ""}>${String(hour).padStart(2, "0")}:00</option>`).join("");
}
function settingsAgentsSliceHtml(options) {
    return `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">The agent brain. When you draft without naming an agent (the Coach <b>Auto</b> option and the weekly auto-coach), Cairn rotates across the agents you enable here.</p>

        <div class="field" style="margin-top:14px"><label>Selection strategy</label>
          <select id="strat">
            ${settingsAgentStrategyOption(options.agentStrategy, "round_robin", "Round-robin · even rotation")}
            ${settingsAgentStrategyOption(options.agentStrategy, "random", "Random · dice")}
            ${settingsAgentStrategyOption(options.agentStrategy, "priority", "Priority · top first, fall back on failure")}
          </select></div>

        <h1 class="lbl" style="margin:18px 0 8px">Agents</h1>
        <div id="agentlist"></div>
        <div class="agent-update">
          <button id="updateAgentClis" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Update CLI tools</button>
          <div id="agentCliUpdateStatus" class="sess-line agent-update-status"></div>
        </div>
        ${options.agentHealthHtml}
        ${options.agentActivityHtml}
        ${options.noticedHtml}

        <details class="route-card">
          <summary><h1 class="lbl" style="margin:22px 0 8px;display:inline">${escHtml(options.routeSummary)}</h1></summary>
          <p class="set-group-sub" style="margin-top:2px">Optional. Pin a specific agent to a task — say chat to one, meal drafts to another. Leave any task on <b>Auto</b> to use the rotation above. Only enabled agents appear.</p>
          <div id="routelist" class="route-list">${options.routeRowsHtml}</div>
        </details>

        <h1 class="lbl" style="margin:22px 0 8px">Weekly auto-coach</h1>
        <label class="toggle"><input type="checkbox" id="coachEnabled" ${options.coachEnabled ? "checked" : ""}>
          <span>Draft a proposal automatically each week</span></label>
        <div class="logrow" style="margin-top:12px">
          <select id="coachDay" class="selflex">${settingsAgentDayOptions(options.dayNames, options.coachDay)}</select>
          <select id="coachHour" class="selflex">${settingsAgentHourOptions(options.coachHour)}</select>
        </div>
      </section>`;
}
function settingsAgentInfoLine(info) {
    if (!info)
        return "";
    const version = info.version ? `v${escHtml(String(info.version))}` : "version —";
    const model = escHtml(String(info.model_current || "—"));
    const update = info.update_available ? ` · <span class="agent-upd">update available</span>` : "";
    return `CLI ${version} · model: ${model}${update}`;
}
function settingsAgentModelsHtml(models) {
    if (!Array.isArray(models))
        return "";
    return models.length
        ? models.map((model) => `<li>${escHtml(String(model))}</li>`).join("")
        : `<li class="agent-models-empty">No models reported.</li>`;
}
function settingsAgentCardHtml(options, name, index) {
    const agent = options.meta[name] || { name };
    const off = options.disabled.has(name);
    const chip = CairnSettingsClient.agentChipState(agent);
    const cached = options.agentInfo[name];
    const infoLine = settingsAgentInfoLine(cached);
    const models = options.agentModels[name];
    const modelsList = settingsAgentModelsHtml(models);
    const staggerStyle = options.stagger ? options.stagger(index) : "";
    return `<div class="agent-card${off ? " off" : ""} reveal" style="${escAttr(staggerStyle)}">
        <div class="agent-card-top">
          <div class="agentmeta">
            <div class="agentname">${escHtml(name)}</div>
            <div class="agentdesc">${escHtml(agent.description || "")}</div>
          </div>
          <span class="agent-chip ${escAttr(chip.cls)}">${escHtml(chip.label)}</span>
        </div>
        <div class="agent-card-ctl">
          <div class="agentctl">
            <button class="ordbtn" data-up="${escAttr(name)}" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button class="ordbtn" data-down="${escAttr(name)}" ${index === options.order.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            <button class="togglebtn${off ? "" : " on"}" data-toggle="${escAttr(name)}">${off ? "OFF" : "ON"}</button>
          </div>
          <div class="agent-card-actions">
            ${agent.can_login ? `<button class="ghostbtn agent-connect-btn" data-connect="${escAttr(name)}">Connect</button>` : ""}
            <button class="linkbtn-quiet agent-detail-link" data-detail="${escAttr(name)}">${cached ? "details" : "check"}</button>
            ${agent.models_list ? `<button class="linkbtn-quiet agent-detail-link" data-models="${escAttr(name)}">${Array.isArray(models) ? "hide models" : "view models"}</button>` : ""}
          </div>
        </div>
        ${agent.configured === false ? `<div class="agent-card-note">Not in rotation until connected${agent.can_login ? " — tap Connect" : ""}.</div>` : ""}
        ${infoLine ? `<div class="agent-info-line">${infoLine}</div>` : ""}
        ${Array.isArray(models) ? `<ul class="agent-models">${modelsList}</ul>` : ""}
      </div>`;
}
function settingsAgentListHtml(options) {
    return options.order.map((name, index) => settingsAgentCardHtml(options, name, index)).join("");
}
const CAIRN_SETTINGS_AGENTS = {
    agentsSliceHtml: settingsAgentsSliceHtml,
    agentListHtml: settingsAgentListHtml,
};
Object.assign(globalThis, { CairnSettingsAgents: CAIRN_SETTINGS_AGENTS });
if (typeof window !== "undefined") {
    window.CairnSettingsAgents = CAIRN_SETTINGS_AGENTS;
}
})();
