// @ts-check
// Pure Settings screen surface helpers: data coercion, status adapters, and slice markup.

type SettingsSurfaceDateFns = {
  relTime?: (value: string) => string;
  absDate?: (value: string) => string;
};

type SettingsSurfaceRouteEligibility = { eligible?: boolean; reason?: string } | null;

type SettingsSurfaceStatusHelpers = {
  garminStatusLine(settings: unknown, syncing: boolean): string;
  agentHealthCard(stats: unknown): string;
  agentOpLabel(op: unknown): string;
  agentActivityCard(stats: unknown): string;
  noticedCard(data: unknown): string;
  agentChipState(agent: Record<string, unknown> | null | undefined): { cls: string; label: string };
};

type SettingsSourcesSliceOptions = {
  workingModel: Pick<SettingsScreenWorkingModel, "garmin_username">;
  settings: Record<string, unknown>;
  garminStatusHtml: string;
  appleHealth?: AppleHealthUiState;
};

type AppleHealthConnectionView = {
  id: number;
  label?: string;
  shortcut_version?: string | null;
  created_at?: string;
  expires_at?: string;
  last_used_at?: string | null;
  status?: string;
};

type AppleHealthUiState = {
  loading?: boolean;
  error?: string | null;
  config?: {
    available?: boolean;
    install_url?: string | null;
    shortcut_name?: string | null;
    help_url?: string | null;
    pairing_available?: boolean;
  } | null;
  connections?: AppleHealthConnectionView[];
  dates?: SettingsSurfaceDateFns;
};

type SettingsAutomationSliceOptions = {
  workingModel: Pick<SettingsScreenWorkingModel, "enrich_enabled" | "art_enabled" | "research_enabled" | "lead_mode">;
  settings: Record<string, unknown>;
  artSpendHtml: string;
  researchEligible: SettingsSurfaceRouteEligibility;
};

const SETTINGS_SURFACE_SEGMENTS: readonly ClientSegment[] = [
  ["you", "You"],
  ["agents", "Agents"],
  ["system", "System"],
  ["sources", "Sources"],
  ["automation", "Automation"],
  ["data", "Data"],
];

function settingsSurfaceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function settingsSurfaceString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function settingsSurfaceNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function settingsSurfaceBool(value: unknown, fallback = false): boolean {
  return value == null ? fallback : !!value;
}

function settingsSurfaceChatBindings(value: unknown): Record<string, Record<string, Record<string, unknown>>> {
  const raw = settingsSurfaceRecord(value);
  const bindings: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [provider, lanesValue] of Object.entries(raw)) {
    const lanes = settingsSurfaceRecord(lanesValue);
    bindings[provider] = {};
    for (const [lane, profileValue] of Object.entries(lanes)) {
      bindings[provider][lane] = { ...settingsSurfaceRecord(profileValue) };
    }
  }
  return bindings;
}

function settingsData(value: unknown): SettingsScreenData {
  const row = settingsSurfaceRecord(value);
  const agents = Array.isArray(row.agents)
    ? row.agents
        .map((agent) => settingsSurfaceRecord(agent))
        .filter((agent): agent is SettingsScreenAgent => typeof agent.name === "string")
    : [];
  const eligible = row.research_auto_eligible;
  return {
    settings: settingsSurfaceRecord(row.settings),
    agents,
    research_auto_eligible:
      typeof eligible === "boolean" || (eligible && typeof eligible === "object")
        ? (eligible as SettingsScreenData["research_auto_eligible"])
        : undefined,
  };
}

function settingsWorkingModel(data: SettingsScreenData): SettingsScreenWorkingModel {
  const s = data.settings;
  const agents = data.agents;
  return {
    agent_strategy: settingsSurfaceString(s.agent_strategy, "round_robin"),
    order: agents.map((agent) => agent.name),
    disabled: new Set(agents.filter((agent) => !agent.enabled).map((agent) => agent.name)),
    routes: { ...settingsSurfaceRecord(s.agent_routes) } as Record<string, string>,
    chat_routing_mode: s.chat_routing_mode === "single" ? "single" : "adaptive",
    // Keep provider/lane entries the current UI cannot render; saving an unrelated
    // setting must not erase a future provider's profile preferences.
    chat_profile_bindings: settingsSurfaceChatBindings(s.chat_profile_bindings),
    enrich_enabled: settingsSurfaceBool(s.enrich_enabled),
    art_enabled: settingsSurfaceBool(s.art_enabled, true),
    research_enabled: settingsSurfaceBool(s.research_enabled),
    gemini_api_key: "",
    garmin_username: settingsSurfaceString(s.garmin_username),
    garmin_password: "",
    coach_day: settingsSurfaceNumber(s.coach_day),
    coach_hour: settingsSurfaceNumber(s.coach_hour),
    time_zone: settingsSurfaceString(s.time_zone),
    update_check_enabled: settingsSurfaceBool(s.update_check_enabled, true),
    lead_mode: ["lead", "announce_first", "review_everything"].includes(settingsSurfaceString(s.lead_mode))
      ? (settingsSurfaceString(s.lead_mode) as SettingsScreenWorkingModel["lead_mode"])
      : "lead",
  };
}

function routeEligible(data: SettingsScreenData): SettingsSurfaceRouteEligibility {
  const eligible = data.research_auto_eligible;
  if (!eligible || typeof eligible !== "object") return null;
  return eligible;
}

function settingsStatusHelpers(options: SettingsSurfaceDateFns = {}): SettingsSurfaceStatusHelpers {
  return {
    garminStatusLine(settings: unknown, syncing: boolean): string {
      return CairnSettingsClient.garminStatusLine(settings, syncing, { relTime: options.relTime });
    },
    agentHealthCard(stats: unknown): string {
      return CairnSettingsClient.agentHealthCard(stats);
    },
    agentOpLabel(op: unknown): string {
      return CairnSettingsClient.agentOpLabel(op);
    },
    agentActivityCard(stats: unknown): string {
      return CairnSettingsClient.agentActivityCard(stats, { relTime: options.relTime, absDate: options.absDate });
    },
    noticedCard(data: unknown): string {
      return CairnSettingsClient.noticedCard(data, { relTime: options.relTime, absDate: options.absDate });
    },
    agentChipState(agent: Record<string, unknown> | null | undefined): { cls: string; label: string } {
      return CairnSettingsClient.agentChipState(agent || {});
    },
  };
}

function settingsArtSpendCardHtml(stats: unknown): string {
  if (!stats) return "";
  const artStats = settingsSurfaceRecord(stats);
  const money = (value: unknown): string => {
    const n = Number(value) || 0;
    return "$" + (n && n < 0.005 ? n.toFixed(4) : n.toFixed(2));
  };
  const recent = settingsSurfaceRecord(artStats.since_enabled);
  const all = settingsSurfaceRecord(artStats.all_time);
  const since = artStats.enabled_at ? `since ${escHtml(String(artStats.enabled_at).slice(0, 10))}` : "all-time";
  return `
    <div class="sess" style="margin-top:10px">
      <div class="sess-line"><b>${money(recent.est_cost_usd)}</b> est. spend ${since} · ${recent.images_generated} image${recent.images_generated === 1 ? "" : "s"} generated · ${recent.reused} reused (~${money(recent.est_saved_usd)} saved)</div>
      <div class="sess-line" style="color:var(--muted)">All-time: ${money(all.est_cost_usd)} spent · ${all.images_generated} images · ${artStats.cached_assets} cached, served from cache forever after.</div>
    </div>`;
}

function settingsSourcesSliceHtml(options: SettingsSourcesSliceOptions): string {
  const s = settingsSurfaceRecord(options.settings);
  const wm = options.workingModel;
  const garminPlaceholder = s.garmin_password_configured
    ? `Configured via ${escAttr(s.garmin_credentials_source)}`
    : "Optional: GARMIN_PASSWORD";
  return `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Where your recovery and activity data come in. Both are optional and gracefully absent.</p>

        <h1 class="lbl" style="margin:14px 0 8px">Garmin Connect</h1>
        <div class="field"><label>Garmin email</label>
          <input id="garminUsername" type="email" autocomplete="username" value="${escAttr(wm.garmin_username)}" placeholder="you@example.com">
        </div>
        <div class="field"><label>Garmin password</label>
          <input id="garminPassword" type="password" autocomplete="current-password" placeholder="${garminPlaceholder}">
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings credentials override GARMIN_USERNAME / GARMIN_PASSWORD. Garmin remains an input source for coaching context.</div>
        <div class="syncrow">
          <div class="syncstatus" id="garminStatus">${options.garminStatusHtml}</div>
          <button id="garminSyncBtn" class="ghostbtn syncbtn">Sync now</button>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Once configured, Cairn syncs automatically every ~6 hours.</div>

        <div id="appleHealthCard">${appleHealthCardHtml(options.appleHealth ?? { loading: true })}</div>
      </section>`;
}

// A row has to answer "is this thing working, and if not what do I do?" on its
// own: the pairing exchange alone flips a connection to "connected", but no
// Health data moves until the athlete opens the Shortcut once on the phone.
function appleHealthConnectionRowHtml(
  connection: AppleHealthConnectionView,
  shortcutName: string,
  dates: SettingsSurfaceDateFns
): string {
  const stamp = (iso: string | null | undefined): { text: string; title: string } => {
    const raw = String(iso || "");
    if (!raw) return { text: "", title: "" };
    return {
      text: dates.relTime ? dates.relTime(raw) : raw,
      title: dates.absDate ? dates.absDate(raw.slice(0, 10)) : raw.slice(0, 10),
    };
  };
  const paired = stamp(connection.created_at);
  const used = stamp(connection.last_used_at);
  const pairedSuffix = paired.text
    ? ` · <span title="${escAttr(paired.title)}">paired ${escHtml(paired.text)}</span>`
    : "";
  const lead = used.text
    ? `<span title="${escAttr(used.title)}">Last update ${escHtml(used.text)}</span>${pairedSuffix}`
    : `Waiting for its first update${pairedSuffix}`;
  const hint = used.text
    ? ""
    : `<br><span style="color:var(--muted)">Open the Shortcuts app and tap ${escHtml(shortcutName || "the Shortcut")} once to allow Health access and send today.</span>`;
  return `<div class="syncrow ah-connection">
        <div class="syncstatus"><b>${escHtml(connection.label || "Apple Health Shortcut")}</b><br><span style="color:var(--muted)">${lead}</span>${hint}</div>
        <button class="ghostbtn ah-revoke" type="button" data-connection-id="${Number(connection.id)}">Revoke</button>
      </div>`;
}

function appleHealthCardHtml(state: AppleHealthUiState): string {
  const config = state.config ?? null;
  const connections = Array.isArray(state.connections) ? state.connections : [];
  const active = connections.filter((connection) => connection.status === "connected");
  const helpUrl = config?.help_url || "https://github.com/zilet/cairn/blob/main/docs/APPLE_HEALTH.md";
  const shortcutName = typeof config?.shortcut_name === "string" && config.shortcut_name ? config.shortcut_name : "";
  const install =
    config?.available && config.install_url
      ? `<a class="ghostbtn ah-install" href="${escAttr(config.install_url)}" target="_blank" rel="noopener">Install Apple Health Sync</a>`
      : `<div class="sess-line ah-unavailable" style="color:var(--muted)">This server has no install link configured — <a href="${escAttr(helpUrl)}" target="_blank" rel="noopener">the setup guide</a> covers publishing your own Shortcut link or installing it by hand, and Connect &amp; test works either way.</div>`;
  const connect =
    config?.shortcut_name && config.pairing_available
      ? `<button id="ahConnect" class="ghostbtn" type="button">Connect &amp; test</button>`
      : config && !config.pairing_available
        ? `<div class="sess-line" style="color:var(--muted)">Secure pairing requires <code>CAIRN_AUTH_TOKEN</code> on this instance.</div>`
        : "";
  const rows = active.length
    ? active.map((connection) => appleHealthConnectionRowHtml(connection, shortcutName, state.dates ?? {})).join("")
    : `<div class="sess-line" style="color:var(--muted)">Not connected yet.</div>`;
  const error = state.error
    ? `<div class="sess-line" id="ahError" style="color:var(--danger,#b33)">${escHtml(state.error)} <button id="ahRetry" class="ghostbtn" type="button">Retry</button></div>`
    : "";
  return `
    <h1 class="lbl" style="margin:22px 0 8px">Apple Health (steps, sleep, recovery)</h1>
    <div class="sess-line" style="color:var(--muted)">Install the Shortcut, tap Connect &amp; test to pair it without copying the owner token, then open it once in the Shortcuts app to allow Health access. Apple asks you to confirm Add Shortcut and each Health permission.</div>
    <div class="ah-fields"><span>steps</span><span>sleep</span><span>resting HR</span><span>HRV</span><span>active energy</span><span>VO₂ max</span></div>
    ${
      state.loading
        ? `<div class="sess-line" style="color:var(--muted);margin-top:10px">Checking connection…</div>`
        : `
      <div class="ah-builder-actions">${install}${connect}<button id="ahRefresh" class="ghostbtn" type="button">Refresh status</button></div>
      ${error}
      <div style="margin-top:10px">${rows}</div>
      <div class="sess-line" style="color:var(--muted);margin-top:8px"><a href="${escAttr(helpUrl)}" target="_blank" rel="noopener">Apple Health setup, privacy, and limitations</a></div>`
    }
  `;
}

function settingsAutomationSliceHtml(options: SettingsAutomationSliceOptions): string {
  const s = settingsSurfaceRecord(options.settings);
  const wm = options.workingModel;
  const researchEligible = options.researchEligible;
  const geminiPlaceholder = s.gemini_api_key_configured
    ? `Configured via ${escAttr(s.gemini_api_key_source)}`
    : "Optional: GOOGLE_AI_KEY / GEMINI_API_KEY";
  const researchSuggest =
    !wm.research_enabled && researchEligible?.eligible
      ? `<div class="sess-line" id="researchSuggest" style="margin-top:6px">✦ ${researchEligible.reason === "web_agent_connected" ? "Your coach agent can browse — turn this on for live, cited research." : "An agent is connected — you can try live evidence research."}</div>`
      : "";
  return `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Background touches that make logging effortless. Everything falls back gracefully when off.</p>

        <h1 class="lbl" style="margin:14px 0 8px">How much should Cairn lead?</h1>
        <div class="field">
          <select id="leadMode" aria-label="How much should Cairn lead?">
            <option value="lead" ${wm.lead_mode === "lead" ? "selected" : ""}>Lead</option>
            <option value="announce_first" ${wm.lead_mode === "announce_first" ? "selected" : ""}>Announce first</option>
            <option value="review_everything" ${wm.lead_mode === "review_everything" ? "selected" : ""}>Review everything</option>
          </select>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Lead lets Cairn make bounded, reversible coaching changes at natural boundaries and explain them where they land. Announce first tells you before they take effect. Review everything keeps the classic approval flow. Goal-level and clinical decisions always stay with you.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Agentic enrichment</h1>
        <label class="toggle"><input type="checkbox" id="enrichEnabled" ${wm.enrich_enabled ? "checked" : ""}>
          <span>Refine free-text logs &amp; capture coaching notes via an agent</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Logs stay instant; an agent upgrades them in the background. Falls back to offline parsing when off.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Artwork generation</h1>
        <label class="toggle"><input type="checkbox" id="artEnabled" ${wm.art_enabled ? "checked" : ""}>
          <span>Generate studio photos for foods, exercises &amp; activities</span></label>
        <div class="field" style="margin-top:10px"><label>Gemini API key</label>
          <input id="geminiApiKey" type="password" autocomplete="off" placeholder="${geminiPlaceholder}">
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings key overrides GOOGLE_AI_KEY / GEMINI_API_KEY from the server environment. Blank preserves the current key.</div>
        ${options.artSpendHtml}

        <h1 class="lbl" style="margin:22px 0 8px">Research &amp; grounding</h1>
        <label class="toggle"><input type="checkbox" id="researchEnabled" ${wm.research_enabled ? "checked" : ""}>
          <span>Let Cairn research your findings and cite real sources</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Cairn already cites trusted clinical guidelines (AHA/ACC, Endocrine Society, KDIGO…) <b>offline</b> on your directives — no network needed. Turn this on to also let a web-capable agent fetch fresh, cited sources and attach them behind each directive — open them under “see the evidence” on your <b>Stand</b> read. Off by default; deterministic and offline when off. Informational, never medical advice.</div>
        ${researchSuggest}
      </section>`;
}

const CAIRN_SETTINGS_SURFACE = {
  SET_SEG: SETTINGS_SURFACE_SEGMENTS,
  record: settingsSurfaceRecord,
  string: settingsSurfaceString,
  number: settingsSurfaceNumber,
  bool: settingsSurfaceBool,
  settingsData,
  workingModel: settingsWorkingModel,
  routeEligible,
  statusHelpers: settingsStatusHelpers,
  artSpendCardHtml: settingsArtSpendCardHtml,
  sourcesSliceHtml: settingsSourcesSliceHtml,
  appleHealthCardHtml,
  automationSliceHtml: settingsAutomationSliceHtml,
};

Object.assign(globalThis, { CairnSettingsSurface: CAIRN_SETTINGS_SURFACE });

if (typeof window !== "undefined") {
  window.CairnSettingsSurface = CAIRN_SETTINGS_SURFACE;
}
