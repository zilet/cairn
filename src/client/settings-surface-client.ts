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
  workingModel: Pick<SettingsScreenWorkingModel, "garmin_username" | "garmin_export_strength">;
  settings: Record<string, unknown>;
  garminStatusHtml: string;
  lastExportAt?: string | null;
  dates?: SettingsSurfaceDateFns;
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
  workingModel: Pick<
    SettingsScreenWorkingModel,
    "enrich_enabled" | "art_enabled" | "research_enabled" | "meal_plan_auto_draft" | "lead_mode" | "run_units" | "weight_units" | "lab_units"
  >;
  settings: Record<string, unknown>;
  artSpendHtml: string;
  researchEligible: SettingsSurfaceRouteEligibility;
};

const SETTINGS_SURFACE_SEGMENTS: readonly ClientSegment[] = [
  ["sources", "Sources"],
  ["automation", "Automation"],
  ["data", "Data"],
  ["agents", "Agents"],
  ["devices", "Devices"],
  ["system", "System"],
];

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
  const since = artStats.enabled_at ? `since ${escHtml(CairnFmt.date(String(artStats.enabled_at).slice(0, 10)))}` : "all-time";
  return `
    <div class="sess" style="margin-top:10px">
      <div class="sess-line"><b>${money(recent.est_cost_usd)}</b> est. spend ${since} · ${recent.images_generated} image${recent.images_generated === 1 ? "" : "s"} generated · ${recent.reused} reused (~${money(recent.est_saved_usd)} saved)</div>
      <div class="sess-line" style="color:var(--muted)">All-time: ${money(all.est_cost_usd)} spent · ${all.images_generated} images · ${artStats.cached_assets} cached, served from cache forever after.</div>
      ${artStats.art_enabled && artStats.gemini_configured ? settingsArtHealthLineHtml(artStats.health) : ""}
    </div>`;
}

/**
 * One calm line about whether art is actually rendering. Observational, never an
 * alarm: it reports when a new image last arrived and how many attempts didn't
 * come back, and says plainly when the pipeline has paused itself.
 *
 * Only rendered when art is switched ON and a Gemini key is configured. A fresh
 * or seeded install has neither, and "No image has rendered yet" would read as a
 * fault where nothing was ever asked to run.
 */
function settingsArtHealthLineHtml(health: unknown): string {
  if (!health) return "";
  const row = settingsSurfaceRecord(health);
  const circuit = settingsSurfaceRecord(row.circuit);
  const lastSuccess = row.last_success_at ? String(row.last_success_at).slice(0, 10) : "";
  const failures = Number(row.failures_7d) || 0;
  const parts: string[] = [
    lastSuccess ? `Last new image ${escHtml(lastSuccess)}` : "No image has rendered yet",
  ];
  if (failures) parts.push(`${failures} attempt${failures === 1 ? "" : "s"} didn't come back in the last 7 days`);
  if (circuit.open) parts.push("paused for a while, then it tries again on its own");
  return `<div class="sess-line" style="color:var(--muted)">${parts.join(" · ")}.</div>`;
}

/**
 * One quiet line of write-back state under the toggle: enough to answer "is this
 * doing anything?" and nothing more. No activity counts, no Garmin ids — what is on
 * the athlete's Garmin account is Garmin's to show, not ours to tally.
 */
function settingsGarminExportStateHtml(options: SettingsSourcesSliceOptions): string {
  const at = String(options.lastExportAt ?? "").trim();
  const rel = at ? (options.dates?.relTime ? options.dates.relTime(at) : at) : "";
  const title = at && options.dates?.absDate ? ` title="${escAttr(options.dates.absDate(at.slice(0, 10)))}"` : "";
  const text = rel ? `Last sent ${escHtml(rel)}` : "Nothing sent yet";
  // "Last sent" only ever moves on a write that LANDED, so on its own it cannot tell a
  // feature nobody uses from one that has been failing for two days. The attempt line
  // says which, and only while the last attempt actually failed.
  const settings = settingsSurfaceRecord(options.settings);
  const failedAt = String(settings.garmin_last_export_attempt_at ?? "").trim();
  const failed = String(settings.garmin_last_export_status ?? "").startsWith("failed");
  const retry =
    failed && failedAt
      ? `<div class="sess-line" style="color:var(--muted);margin-top:4px">Last attempt didn't land ${escHtml(
          options.dates?.relTime ? options.dates.relTime(failedAt) : failedAt
        )} — it retries on the next sync.</div>`
      : "";
  return `<div class="sess-line" style="color:var(--muted);margin-top:6px"><span${title}>${text}</span></div>${retry}`;
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

        <div class="set-card">
          <div class="set-card-head"><h2 class="set-card-h">Garmin Connect</h2><span class="lbl">runs · sleep · recovery</span></div>
          <div class="syncrow"><div class="syncstatus" id="garminStatus">${options.garminStatusHtml}</div><button id="garminSyncBtn" class="ghostbtn syncbtn">Sync now</button></div>
          <div class="field"><label>Garmin email</label>
            <input id="garminUsername" type="email" autocomplete="username" value="${escAttr(wm.garmin_username)}" placeholder="you@example.com"></div>
          <div class="field"><label>Garmin password</label>
            <input id="garminPassword" type="password" autocomplete="current-password" placeholder="${garminPlaceholder}"></div>
          <label class="toggle set-toggle"><input type="checkbox" id="garminExportStrength" ${wm.garmin_export_strength ? "checked" : ""}>
            <span>Send finished strength sessions back to Garmin</span></label>
          ${settingsGarminExportStateHtml(options)}
          <details class="set-more"><summary>How Garmin works here</summary>
            <div class="sess-line">Once configured, Cairn syncs automatically every ~6 hours. Settings credentials override GARMIN_USERNAME / GARMIN_PASSWORD. Runs, sleep and recovery come in from Garmin; finished strength sessions can go back out.</div>
            <div class="sess-line">When you finish a session here, its exercises and sets are added to that day on Garmin — onto the watch's own recording when there is one, so heart rate and calories stay as they are. A day Garmin already logged itself is left alone.</div>
          </details>
        </div>

        <div id="appleHealthCard" class="set-card">${appleHealthCardHtml(options.appleHealth ?? { loading: true })}</div>
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
    <div class="set-card-head"><h2 class="set-card-h">Apple Health</h2><span class="lbl">steps · sleep · recovery</span></div>
    ${
      state.loading
        ? `<div class="sess-line" style="color:var(--muted);margin-top:10px">Checking connection…</div>`
        : `
      <div class="ah-rows">${rows}</div>
      ${error}
      <div class="ah-builder-actions">${install}${connect}<button id="ahRefresh" class="ghostbtn" type="button">Refresh status</button></div>`
    }
    <details class="set-more"><summary>How the Shortcut works</summary>
      <div class="sess-line">Install the Shortcut, tap Connect &amp; test to pair it without copying the owner token, then open it once in the Shortcuts app to allow Health access. Apple asks you to confirm Add Shortcut and each Health permission.</div>
      <div class="ah-fields"><span>steps</span><span>sleep</span><span>resting HR</span><span>HRV</span><span>active energy</span><span>VO₂ max</span></div>
      <div class="sess-line"><a href="${escAttr(helpUrl)}" target="_blank" rel="noopener">Apple Health setup, privacy, and limitations</a></div>
    </details>
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
  // Screen wake lock is a DEVICE preference, not an account one — it lives in
  // this browser's localStorage and applies the moment it's flipped, so it is
  // deliberately not part of the working model the Save button posts.
  const wakeLockOk = typeof wakeLockSupported === "function" && wakeLockSupported();
  const wakeLockOn = wakeLockOk && typeof wakeLockEnabled === "function" && wakeLockEnabled();
  const wakeLockNote = wakeLockOk
    ? "This device only. Applies while a session is open, and lets the screen sleep again the moment you finish or leave. On iPhone it needs iOS 18.4+ with Cairn added to the Home Screen."
    : "This browser can't hold the screen awake. On iPhone that needs iOS 18.4+ with Cairn added to the Home Screen.";
  return `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Background touches that make logging effortless. Everything falls back gracefully when off.</p>

        <h1 class="lbl" style="margin:14px 0 8px">Units</h1>
        <div class="field"><label for="runUnits">Distance and pace</label>
          <select id="runUnits">
            <option value="km" ${wm.run_units === "km" ? "selected" : ""}>Kilometres</option>
            <option value="mi" ${wm.run_units === "mi" ? "selected" : ""}>Miles</option>
          </select></div>
        <div class="field"><label for="weightUnits">Weight</label>
          <select id="weightUnits">
            <option value="lb" ${wm.weight_units === "lb" ? "selected" : ""}>Pounds</option>
            <option value="kg" ${wm.weight_units === "kg" ? "selected" : ""}>Kilograms</option>
          </select></div>
        <div class="field"><label for="labUnits">Lab results</label>
          <select id="labUnits">
            <option value="auto" ${wm.lab_units === "auto" ? "selected" : ""}>Automatic (${wm.weight_units === "kg" ? "SI" : "US"}, follows weight)</option>
            <option value="us" ${wm.lab_units === "us" ? "selected" : ""}>US conventional (mg/dL)</option>
            <option value="si" ${wm.lab_units === "si" ? "selected" : ""}>SI / international (mmol/L)</option>
          </select></div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Every surface and every sentence follows these, body measurements too (centimetres with kilograms, inches with pounds). Your data stays as recorded; only the words change. Lab results from any lab are compared in one unit either way, and the value as your lab printed it stays one tap away.${
          s.units_source === "detected" ? " These were set from this device's region when Cairn first opened; change them any time." : ""
        }</div>

        <h1 class="lbl" style="margin:22px 0 8px">How much should Cairn lead?</h1>
        <div class="field">
          <select id="leadMode" aria-label="How much should Cairn lead?">
            <option value="lead" ${wm.lead_mode === "lead" ? "selected" : ""}>Lead</option>
            <option value="announce_first" ${wm.lead_mode === "announce_first" ? "selected" : ""}>Announce first</option>
            <option value="review_everything" ${wm.lead_mode === "review_everything" ? "selected" : ""}>Review everything</option>
          </select>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Lead lets Cairn make bounded, reversible coaching changes at natural boundaries and explain them where they land. Announce first tells you before they take effect. Review everything keeps the classic approval flow. Goal-level and clinical decisions always stay with you.</div>

        <div class="set-card drive-card" id="driveCard" data-save-ignore></div>

        <h1 class="lbl" style="margin:22px 0 8px">While you train</h1>
        <label class="toggle"><input type="checkbox" id="wakeLockEnabled"${wakeLockOn ? " checked" : ""}${wakeLockOk ? "" : " disabled"}>
          <span>Keep the screen awake while a session is open</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">${wakeLockNote}</div>

        <h1 class="lbl" style="margin:22px 0 8px">Agentic enrichment</h1>
        <label class="toggle"><input type="checkbox" id="enrichEnabled" ${wm.enrich_enabled ? "checked" : ""}>
          <span>Refine free-text logs &amp; capture coaching notes via an agent</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Logs stay instant; an agent upgrades them in the background. Falls back to offline parsing when off.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Meal plans</h1>
        <label class="toggle"><input type="checkbox" id="mealPlanAutoDraft" ${wm.meal_plan_auto_draft ? "checked" : ""}>
          <span>Draft a fresh meal plan each week on its own</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Off by default — a meal plan is a set of ideas you ask for, from Food or chat. On, Cairn drafts one each week, starting with this week's, and reshapes it when your target or a health finding moves. Your target and findings shape every plan either way.</div>

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
        <div class="sess-line" style="color:var(--muted);margin-top:6px">On by default. Your findings are researched against current, cited sources by a web-capable agent — quickly for most, and with a deeper pass when a reading sits outside the lab's range or a first look comes back thin. Every claim must carry a real source to be kept; open them under “see the evidence” on your <b>Health</b> read. Trusted clinical guidelines (AHA/ACC, Endocrine Society, KDIGO…) stay cited offline either way, so turning this off keeps Cairn deterministic and off the network. Informational, never medical advice.</div>
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
