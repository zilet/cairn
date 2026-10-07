// @ts-check
// Settings, the working model: the coercers (`settingsSurface*`) and the two builders that
// shape GET /api/settings into SettingsScreenData and the one in-memory working model every
// slice edits (settingsData, settingsWorkingModel), split out of settings-surface-client.ts,
// which loads right after and publishes them through CairnSettingsSurface. Pure; no DOM.

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
    garmin_last_export_at: typeof row.garmin_last_export_at === "string" ? row.garmin_last_export_at : null,
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
    // Defaults OFF: meal plans are ideas drafted when asked, not on a weekly clock.
    meal_plan_auto_draft: settingsSurfaceBool(s.meal_plan_auto_draft),
    gemini_api_key: "",
    garmin_username: settingsSurfaceString(s.garmin_username),
    garmin_password: "",
    // Defaults ON: a finished Cairn session belongs on the athlete's Garmin history.
    garmin_export_strength: settingsSurfaceBool(s.garmin_export_strength, true),
    coach_day: settingsSurfaceNumber(s.coach_day),
    coach_hour: settingsSurfaceNumber(s.coach_hour),
    time_zone: settingsSurfaceString(s.time_zone),
    update_check_enabled: settingsSurfaceBool(s.update_check_enabled, true),
    usage_ping_enabled: settingsSurfaceBool(s.usage_ping_enabled), // opt-in only
    lead_mode: ["lead", "announce_first", "review_everything"].includes(settingsSurfaceString(s.lead_mode))
      ? (settingsSurfaceString(s.lead_mode) as SettingsScreenWorkingModel["lead_mode"])
      : "lead",
    // Units: Settings is their only writer (every surface reads them through CairnFmt).
    run_units: runUnits(s.run_units),
    weight_units: s.weight_units === "kg" ? "kg" : "lb",
    // No training_drive here on purpose: the drive is written only through the stance door
    // (PUT /api/training-drive, settings-drive-controller.ts), never by the save bar, so a
    // stale screen can never re-send a drive and end — or fake — a dated push.
  };
}

// Each source file is built as its own closure, so settings-surface-client.ts and the settings
// screen read these off the global scope at call time.
Object.assign(globalThis, {
  settingsSurfaceRecord,
  settingsSurfaceString,
  settingsSurfaceNumber,
  settingsSurfaceBool,
  settingsSurfaceChatBindings,
  settingsData,
  settingsWorkingModel,
});
