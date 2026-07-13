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
};

type SettingsAutomationSliceOptions = {
  workingModel: Pick<SettingsScreenWorkingModel, "enrich_enabled" | "art_enabled" | "research_enabled" | "lead_mode">;
  settings: Record<string, unknown>;
  artSpendHtml: string;
  researchEligible: SettingsSurfaceRouteEligibility;
};

const SETTINGS_SURFACE_SEGMENTS: readonly ClientSegment[] = [["you", "You"], ["agents", "Agents"], ["system", "System"], ["sources", "Sources"], ["automation", "Automation"], ["data", "Data"]];

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

function settingsData(value: unknown): SettingsScreenData {
  const row = settingsSurfaceRecord(value);
  const agents = Array.isArray(row.agents)
    ? row.agents.map((agent) => settingsSurfaceRecord(agent)).filter((agent): agent is SettingsScreenAgent => typeof agent.name === "string")
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
  const garminPlaceholder = s.garmin_password_configured ? `Configured via ${escAttr(s.garmin_credentials_source)}` : "Optional: GARMIN_PASSWORD";
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

        <h1 class="lbl" style="margin:22px 0 8px">Apple Health (steps, sleep, recovery)</h1>
        <div class="sess-line" style="color:var(--muted)">
          An iOS Shortcut can post daily metrics straight to Cairn. Missing fields are fine; Cairn
          keeps working without wearable data.
        </div>
        <div class="ah-fields">
          <span>date</span><span>steps</span><span>sleep_min</span><span>resting_hr</span><span>hrv_ms</span><span>active_calories</span>
        </div>
        <div class="field" style="margin-top:12px"><label>POST URL</label>
          <div class="ah-url"><code id="ahUrl"></code><button id="ahUrlCopy" class="ghostbtn ah-copy" type="button">Copy</button></div>
        </div>
        <div class="ah-example">
          <span class="ah-example-lbl">Shortcut body</span>
          <code>[{"date":"2026-06-13","steps":8421,"resting_hr":52}]</code>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:8px">Full Shortcut recipe: <code>docs/APPLE_HEALTH.md</code></div>
      </section>`;
}

function settingsAutomationSliceHtml(options: SettingsAutomationSliceOptions): string {
  const s = settingsSurfaceRecord(options.settings);
  const wm = options.workingModel;
  const researchEligible = options.researchEligible;
  const geminiPlaceholder = s.gemini_api_key_configured ? `Configured via ${escAttr(s.gemini_api_key_source)}` : "Optional: GOOGLE_AI_KEY / GEMINI_API_KEY";
  const researchSuggest = !wm.research_enabled && researchEligible?.eligible
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
  automationSliceHtml: settingsAutomationSliceHtml,
};

Object.assign(globalThis, { CairnSettingsSurface: CAIRN_SETTINGS_SURFACE });

if (typeof window !== "undefined") {
  window.CairnSettingsSurface = CAIRN_SETTINGS_SURFACE;
}
