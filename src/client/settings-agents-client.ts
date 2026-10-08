// @ts-check
// Pure Settings -> Agents render helpers.

type SettingsAgentsAgent = {
  name: string;
  description?: string;
  configured?: boolean;
  quota?: { group: string; window: string; remaining_fraction: number; reset_time: string | null }[];
  present?: boolean;
  can_login?: boolean;
  models_list?: boolean;
  installable?: boolean;
  install_version?: string | null;
  model_choices?: unknown[];
} & Record<string, unknown>;

type SettingsAgentsInfo = {
  version: unknown;
  model_current: unknown;
  update_available?: boolean;
};

type SettingsAgentsSliceOptions = {
  agentStrategy: string;
  routeSummary: string;
  routeRowsHtml: string;
  agentHealthHtml: string;
  agentActivityHtml: string;
  noticedHtml: string;
  agentStateHtml?: string;
  coachDay: number;
  coachHour: number;
  timeZone: string;
  dayNames: string[];
  chatRoutingMode: "adaptive" | "single";
  chatProfileBindings: Record<string, Record<string, Record<string, unknown>>>;
  chatProfileAgents: SettingsAgentsAgent[];
};

type SettingsAgentsListOptions = {
  order: string[];
  disabled: ReadonlySet<string>;
  meta: Record<string, SettingsAgentsAgent | undefined>;
  agentInfo: Record<string, SettingsAgentsInfo | undefined>;
  agentModels: Record<string, unknown[] | undefined>;
  stagger?: (index: number) => string;
  cli?: SettingsAgentCli | null;
  /** Date.now() for elapsed time (injected so the render stays pure). */
  now?: number;
  /** false on a progress re-render: the cards are already on screen, don't replay the entrance. */
  reveal?: boolean;
  /** The person's model per provider and class (settings.model_class_bindings). */
  modelClassBindings?: Record<string, Record<string, unknown>>;
  /** Each provider's LIVE model catalog: undefined/null until it arrives (the curated list shows meanwhile). */
  agentCatalog?: Record<string, unknown[] | null | undefined>;
};

// The installer run the server reports (GET /agent-clis/update), plus two client-only
// fields: `seen_at` is when this device last observed it, so elapsed time never leans on
// a device clock matching the server's.
type SettingsAgentCli = {
  status?: string;
  action?: string;
  agents?: string[];
  phase?: string | null;
  elapsed_sec?: number | null;
  seen_at?: number;
  failure?: { reason?: string; message?: string } | null;
  error?: string;
};

type SettingsAgentCliCard =
  | { kind: "busy"; action: "install" | "remove"; phase: string; label: string; elapsed: string }
  | { kind: "failed"; action: "install" | "remove"; headline: string }
  | null;

const SETTINGS_CLI_PHASE_WORDS: Record<string, string> = {
  starting: "Starting",
  checking_disk: "Checking disk space",
  downloading: "Downloading and installing",
  verifying: "Checking it starts",
  removing: "Removing",
};

function settingsCliElapsedSeconds(cli: SettingsAgentCli | null | undefined, now: number): number {
  if (!cli) return 0;
  const base = typeof cli.elapsed_sec === "number" && Number.isFinite(cli.elapsed_sec) ? cli.elapsed_sec : 0;
  const seen = typeof cli.seen_at === "number" ? cli.seen_at : now;
  return Math.max(0, Math.floor(base + (now - seen) / 1000));
}

function settingsCliClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// What one card should say about the installer run: busy only for the agent the run is
// ABOUT, a failure headline (the installer's own classified message) until a newer run.
function settingsCliCardState(cli: SettingsAgentCli | null | undefined, name: string, now: number): SettingsAgentCliCard {
  if (!cli || !Array.isArray(cli.agents) || !cli.agents.includes(name)) return null;
  const action = cli.action === "remove" ? "remove" : "install";
  if (cli.status === "running") {
    const phase = action === "remove" ? "removing" : cli.phase && SETTINGS_CLI_PHASE_WORDS[cli.phase] ? cli.phase : "starting";
    return { kind: "busy", action, phase, label: `${SETTINGS_CLI_PHASE_WORDS[phase]}…`, elapsed: settingsCliClock(settingsCliElapsedSeconds(cli, now)) };
  }
  if (cli.status === "failed") {
    const headline = cli.failure?.message || cli.error || `${action === "remove" ? "Remove" : "Install"} didn't finish`;
    return { kind: "failed", action, headline: headline.slice(0, 600) };
  }
  return null;
}

function settingsAgentStrategyOption(current: string, value: string, label: string): string {
  return `<option value="${escAttr(value)}" ${current === value ? "selected" : ""}>${escHtml(label)}</option>`;
}

function settingsAgentDayOptions(dayNames: string[], selectedDay: number): string {
  return dayNames
    .map((day, index) => `<option value="${index}" ${selectedDay === index ? "selected" : ""}>${escHtml(day)}</option>`)
    .join("");
}

function settingsAgentHourOptions(selectedHour: number): string {
  return Array.from(
    { length: 24 },
    (_, hour) =>
      `<option value="${hour}" ${selectedHour === hour ? "selected" : ""}>${String(hour).padStart(2, "0")}:00</option>`
  ).join("");
}

const SETTINGS_CHAT_LANES = [
  ["capture", "Capture", "low"],
  ["coach", "Coach", "medium"],
  ["deep", "Deep", "high"],
] as const;

function settingsChatReasoningOptions(reasoning: unknown, fallback: string, capabilities: unknown): string {
  const allowed = settingsAgentsRecord(capabilities).reasoning;
  const levels = Array.isArray(allowed)
    ? allowed.filter((value): value is string => typeof value === "string" && value.length <= 24)
    : [];
  const selected = typeof reasoning === "string" && levels.includes(reasoning) ? reasoning : fallback;
  return levels.map((level) => `<option value="${escAttr(level)}" ${selected === level ? "selected" : ""}>${escHtml(level)}</option>`).join("");
}

function settingsAgentsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function settingsChatProfilesHtml(options: SettingsAgentsSliceOptions): string {
  const rows = (options.chatProfileAgents || []).map((agent) => {
    const name = agent.name;
    const capabilities = settingsAgentsRecord(agent.capabilities);
    const bindings = settingsAgentsRecord((options.chatProfileBindings || {})[name]);
    const supportsModel = capabilities.model === true;
    const supportsReasoning = Array.isArray(capabilities.reasoning) && capabilities.reasoning.length > 0;
    const lanes = SETTINGS_CHAT_LANES.map(([lane, label, fallback]) => {
      const profile = settingsAgentsRecord(bindings[lane]);
      const model = typeof profile.model === "string" ? profile.model.slice(0, 160) : "";
      const modelField = supportsModel
        ? `<label class="field" style="margin:0"><span class="sr-only">${escHtml(name)} ${label} model</span><input data-chat-model data-provider="${escAttr(name)}" data-lane="${lane}" maxlength="160" value="${escAttr(model)}" placeholder="CLI default"></label>`
        : `<span class="sess-line" style="color:var(--muted)">CLI default</span>`;
      const reasoningField = supportsReasoning
        ? `<label class="field" style="margin:0"><span class="sr-only">${escHtml(name)} ${label} reasoning</span><select data-chat-reasoning data-provider="${escAttr(name)}" data-lane="${lane}">${settingsChatReasoningOptions(profile.reasoning, fallback, capabilities)}</select></label>`
        : `<span class="sess-line" style="color:var(--muted)">CLI default</span>`;
      return `<div class="logrow" style="align-items:center;margin-top:6px"><span class="lbl" style="min-width:58px">${label}</span>${modelField}${reasoningField}</div>`;
    }).join("");
    return `<div class="sess" style="margin-top:10px"><div class="sess-line"><b>${escHtml(name)}</b></div>${lanes}</div>`;
  }).join("");
  return `<details class="route-card" style="margin-top:14px"><summary><h1 class="lbl" style="display:inline">Advanced model profiles</h1></summary>
    <p class="set-group-sub" style="margin-top:8px">Optional provider pins. A blank model keeps that CLI’s default. Capture starts low, coaching balanced, and deeper work high unless you choose otherwise.</p>
    ${rows || `<div class="sess-line" style="color:var(--muted)">Connect an agent to tune its available profiles.</div>`}
  </details>`;
}

function settingsAgentsSliceHtml(options: SettingsAgentsSliceOptions): string {
  return `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">The agent brain. Cairn ships lean: install only the provider tools you use, connect your account, then Auto rotates across the agents you enable here.</p>

        <h1 class="lbl" style="margin:18px 0 8px">Agents</h1>
        ${options.agentStateHtml || ""}
        <div id="agentlist"></div>
        ${options.noticedHtml}

        <h1 class="lbl" style="margin:22px 0 8px">Weekly review cadence</h1>
        <p class="set-group-sub">Cairn keeps learning from your input in the background. This is its weekly whole-picture review; bounded changes follow your autonomy setting and stay visible and reversible.</p>
        <div class="logrow" style="margin-top:12px">
          <select id="coachDay" class="selflex">${settingsAgentDayOptions(options.dayNames, options.coachDay)}</select>
          <select id="coachHour" class="selflex">${settingsAgentHourOptions(options.coachHour)}</select>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Times follow <b>${escHtml(options.timeZone || "the server timezone until this device reports one")}</b>. Cairn updates this automatically when your device timezone changes.</div>

        <details class="route-card" style="margin-top:18px">
          <summary><h1 class="lbl" style="display:inline">Under the hood</h1></summary>
          <p class="set-group-sub" style="margin-top:2px">How the agent rotation is tuned, and what it's been doing. Nothing here needs your attention day to day.</p>

          <div class="field" style="margin-top:14px"><label>Selection strategy</label>
            <select id="strat">
              ${settingsAgentStrategyOption(options.agentStrategy, "round_robin", "Round-robin · even rotation")}
              ${settingsAgentStrategyOption(options.agentStrategy, "random", "Random · dice")}
              ${settingsAgentStrategyOption(options.agentStrategy, "priority", "Priority · top first, fall back on failure")}
            </select></div>

          <div class="field" style="margin-top:14px"><label>Adaptive chat</label>
            <select id="chatRoutingMode">
              <option value="adaptive" ${options.chatRoutingMode === "adaptive" ? "selected" : ""}>Adaptive · recommended</option>
              <option value="single" ${options.chatRoutingMode === "single" ? "selected" : ""}>Single profile · legacy</option>
            </select>
            <div class="sess-line" style="color:var(--muted);margin-top:6px">Routine capture uses low reasoning, ordinary coaching stays balanced, and deeper or safety work gets more care. Provider pins and fallback still apply.${options.chatRoutingMode === "single" ? " Saved profiles stay ready, but are inactive in Single profile mode." : ""}</div>
          </div>

          <div id="agentCliUpdateStatus" class="sess-line agent-update-status" role="status"></div>
          <pre id="agentCliUpdateLog" class="agent-install-log" aria-label="Agent installation progress" hidden></pre>
          ${options.agentHealthHtml}
          ${options.agentActivityHtml}

          <details class="route-card" style="margin-top:14px">
            <summary><h1 class="lbl" style="margin:22px 0 8px;display:inline">${escHtml(options.routeSummary)}</h1></summary>
            <p class="set-group-sub" style="margin-top:2px">Optional. Pin a specific agent to a task — say chat to one, meal drafts to another. Leave any task on <b>Auto</b> to use the rotation above. Only enabled agents appear.</p>
            <div id="routelist" class="route-list">${options.routeRowsHtml}</div>
          </details>

          ${settingsChatProfilesHtml(options)}
        </details>
      </section>`;
}

function settingsAgentInfoLine(info: SettingsAgentsInfo | undefined): string {
  if (!info) return "";
  const version = info.version ? `v${escHtml(String(info.version))}` : "version —";
  const model = escHtml(String(info.model_current || "—"));
  const update = info.update_available ? ` · <span class="agent-upd">update available</span>` : "";
  return `CLI ${version} · model: ${model}${update}`;
}

function settingsAgentModelsHtml(models: unknown[] | undefined): string {
  if (!Array.isArray(models)) return "";
  return models.length
    ? models.map((model) => `<li>${escHtml(String(model))}</li>`).join("")
    : `<li class="agent-models-empty">No models reported.</li>`;
}

function settingsAgentCardHtml(options: SettingsAgentsListOptions, name: string, index: number): string {
  const agent = options.meta[name] || ({ name } as SettingsAgentsAgent);
  const present = agent.present !== false;
  const off = options.disabled.has(name) || !present;
  const chip = CairnSettingsClient.agentChipState(agent);
  const availabilityNote = CairnSettingsClient.agentAvailabilityNote(agent);
  const quotaNote = agent.configured === true && !availabilityNote ? CairnSettingsClient.agentQuotaNote(agent) : "";
  const cached = options.agentInfo[name];
  const infoLine = settingsAgentInfoLine(cached);
  const models = options.agentModels[name];
  const modelsList = settingsAgentModelsHtml(models);
  const staggerStyle = options.stagger ? options.stagger(index) : "";
  const cliState = settingsCliCardState(options.cli, name, options.now ?? Date.now());
  const busy = cliState?.kind === "busy" ? cliState : null;
  // The installer runs one job at a time: while another card's run is going, this card's
  // install/remove wait rather than silently attaching to it.
  const runningElsewhere = options.cli?.status === "running" && !busy;
  const installing = busy?.action === "install";
  const removing = busy?.action === "remove";
  const spinner = `<span class="agent-busy-dot" aria-hidden="true"></span>`;
  const installButton = agent.installable
    ? installing
      ? `<button class="ghostbtn agent-install-btn is-busy" data-install="${escAttr(name)}" disabled aria-busy="true">${spinner}${present ? "Updating…" : "Installing…"}</button>`
      : `<button class="ghostbtn agent-install-btn" data-install="${escAttr(name)}"${runningElsewhere ? " disabled" : ""}>${present ? "Update" : "Install"}</button>`
    : "";
  const removeButton = present && agent.installable
    ? removing
      ? `<button class="linkbtn-quiet agent-detail-link is-busy" data-remove="${escAttr(name)}" disabled aria-busy="true">${spinner}Removing…</button>`
      : `<button class="linkbtn-quiet agent-detail-link" data-remove="${escAttr(name)}"${busy || runningElsewhere ? " disabled" : ""} title="Free its disk space; its sign-in is kept">remove</button>`
    : "";
  const statusLine = busy
    ? `<div class="agent-cli-status" role="status" aria-live="polite"><span class="agent-cli-phase">${escHtml(busy.label)}</span> <span class="agent-cli-elapsed" data-cli-elapsed aria-hidden="true">${escHtml(busy.elapsed)}</span></div>`
    : cliState?.kind === "failed"
      ? `<div class="agent-cli-status is-failed" role="status" aria-live="polite">${escHtml(cliState.headline)}</div>`
      : "";
  return `<div class="agent-card${off ? " off" : ""}${options.reveal === false ? "" : " reveal"}" style="${escAttr(staggerStyle)}"${busy ? ` aria-busy="true"` : ""}>
        <div class="agent-card-top">
          <div class="agentmeta">
            <div class="agentname">${escHtml(name)}</div>
            <div class="agentdesc">${escHtml(agent.description || "")}</div>
            ${statusLine}
          </div>
          <span class="agent-chip ${escAttr(chip.cls)}">${escHtml(chip.label)}</span>
        </div>
        <div class="agent-card-ctl">
          <div class="agentctl">
            <button class="ordbtn" data-up="${escAttr(name)}" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button class="ordbtn" data-down="${escAttr(name)}" ${index === options.order.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            <button class="togglebtn${off ? "" : " on"}" data-toggle="${escAttr(name)}" ${!present ? "disabled" : ""} aria-disabled="${!present ? "true" : "false"}">${off ? "OFF" : "ON"}</button>
          </div>
          <div class="agent-card-actions">
            ${installButton}
            ${removeButton}
            ${present && agent.can_login ? `<button class="ghostbtn agent-connect-btn" data-connect="${escAttr(name)}"${busy ? " disabled" : ""}>Connect</button>` : ""}
            ${present ? `<button class="linkbtn-quiet agent-detail-link" data-detail="${escAttr(name)}">${cached ? "details" : "check"}</button>` : ""}
            ${present && agent.models_list ? `<button class="linkbtn-quiet agent-detail-link" data-models="${escAttr(name)}">${Array.isArray(models) ? "hide models" : "view models"}</button>` : ""}
          </div>
        </div>
        ${!present && agent.installable ? `<div class="agent-card-note">Optional · installs into your persistent Cairn tools volume only when you choose it.</div>` : ""}
        ${agent.configured === false ? `<div class="agent-card-note">Not in rotation until connected${agent.can_login ? " — tap Connect" : ""}.</div>` : ""}
        ${availabilityNote ? `<div class="agent-card-note agent-card-note-limit">${escHtml(availabilityNote)}</div>` : ""}
        ${quotaNote ? `<div class="agent-card-note">${escHtml(quotaNote)}</div>` : ""}
        ${CairnSettingsAgentModels.pickHtml(options, name)}
        ${infoLine ? `<div class="agent-info-line">${infoLine}</div>` : ""}
        ${Array.isArray(models) ? `<ul class="agent-models">${modelsList}</ul>` : ""}
      </div>`;
}

function settingsAgentListHtml(options: SettingsAgentsListOptions): string {
  return options.order.map((name, index) => settingsAgentCardHtml(options, name, index)).join("");
}

// "Tue 9:12", "yesterday 18:40", "9:12" — when an agent attempt happened, in words.
function settingsWhen(iso: unknown, now: Date): string {
  const t = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return "";
  const at = new Date(t);
  const clock = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return `today ${clock}`;
  if (days === 1) return `yesterday ${clock}`;
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// What a failing attempt was, in plain words (the operator's error class stays in
// the "Under the hood" card).
const SETTINGS_AGENT_FAIL_WORDS: Record<string, string> = {
  auth_required: "an agent needs its sign-in renewed",
  quota_exhausted: "an agent reached its usage limit",
  rate_limited: "an agent was busy",
  payment_required: "an agent's plan needs credit",
  timeout: "an agent took too long",
  disk_full: "the server's disk is full — use a bigger volume or remove a provider",
  out_of_memory: "the server ran out of memory — a bigger plan or one provider at a time helps",
};

// Settings > Agents: ONE quiet line for where the agent layer stands NOW. It used to
// be a notice on the Brief that stayed after the moment passed; here it reflects the
// newest attempt (`current` on /agent-stats), so a bad morning clears itself as soon
// as a later read succeeds. No connected agent is its own calm state, not a fault.
function agentStateLine(
  stats: unknown,
  agents: ReadonlyArray<Record<string, unknown>>,
  now: Date = new Date()
): string {
  const list = Array.isArray(agents) ? agents : [];
  const usable = list.some((a) => a && a.usable !== false && a.enabled !== false && a.configured !== false);
  const row = stats && typeof stats === "object" ? (stats as Record<string, unknown>) : null;
  const current = row?.current && typeof row.current === "object" ? (row.current as Record<string, unknown>) : null;
  const line = (tone: string, text: string) =>
    `<p class="agent-state is-${tone}" role="status"><span class="agent-state-dot" aria-hidden="true"></span><span>${escHtml(text)}</span></p>`;
  if (!usable)
    return line("none", "No agent is connected yet. Cairn reads your day with its own reliable baseline until one is.");
  if (current?.state === "failing") {
    const when = settingsWhen(current.failing_since, now);
    const cause = SETTINGS_AGENT_FAIL_WORDS[String(current.error_class || "")] || "";
    return line(
      "failing",
      `Agents haven't answered since ${when || "a little while ago"}${cause ? ` (${cause})` : ""}. Cairn's own read stands in, and this clears by itself after the next good run.`
    );
  }
  if (current?.state === "ok") {
    const when = settingsWhen(current.last_ok_at, now);
    return line("ok", `Agents are answering${when ? ` · last good run ${when}` : ""}.`);
  }
  return line("ok", "Agents are connected. Nothing has run yet.");
}

const CAIRN_SETTINGS_AGENTS = {
  agentStateLine,
  agentsSliceHtml: settingsAgentsSliceHtml,
  agentListHtml: settingsAgentListHtml,
  cliCardState: settingsCliCardState,
  cliElapsedSeconds: settingsCliElapsedSeconds,
  cliClock: settingsCliClock,
};

Object.assign(globalThis, { CairnSettingsAgents: CAIRN_SETTINGS_AGENTS });

if (typeof window !== "undefined") {
  window.CairnSettingsAgents = CAIRN_SETTINGS_AGENTS;
}
