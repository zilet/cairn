// @ts-check
// Agent-login provider and status normalization helpers.

(() => {
  const AGENT_LOGIN_STATUS: Record<AgentLoginStatusKey, string> = {
    connecting: "Connecting\u2026",
    ready: "Terminal ready \u2014 follow the prompts below.",
    terminalLoadError: "Couldn't load the terminal. Reload and try again.",
    connectionOpenError: "Couldn't open the connection.",
    connected: "\u2713 Connected",
    loginIncomplete: "Login didn't complete \u2014 check the terminal above, then try again.",
    busy: "Another login is already running \u2014 try again in a moment.",
    genericError: "Something went wrong.",
    connectionError: "Connection error \u2014 make sure the server is reachable, then try again.",
    disconnected: "Disconnected before the login finished \u2014 try again.",
  };

  function agentLoginRecord(value: unknown): AgentLoginRecord {
    return value && typeof value === "object" ? value as AgentLoginRecord : {};
  }

  function agentLoginControl(value: unknown): AgentLoginControlMessage {
    return agentLoginRecord(value) as AgentLoginControlMessage;
  }

  function normalizeAgentLoginName(value: unknown): string {
    return String(value || "").trim();
  }

  function agentLoginProviderHintHtml(name: string): string {
    const provider = name.toLowerCase();
    if (provider === "grok") {
      return `<p class="agent-login-hint">Grok can also authenticate with an API key &mdash; set <code>XAI_API_KEY</code> in the server environment instead of this device login.</p>`;
    }
    if (provider === "antigravity") {
      return `<p class="agent-login-hint">Antigravity has no login-only command yet. Complete Google OAuth; when its full prompt opens, the login is saved and you can press <b>Cancel</b> to return to Cairn.</p>`;
    }
    return "";
  }

  function agentLoginStatus(key: AgentLoginStatusKey): string {
    return AGENT_LOGIN_STATUS[key];
  }

  const CAIRN_AGENT_LOGIN_MODEL: AgentLoginModelApi = {
    control: agentLoginControl,
    normalizeName: normalizeAgentLoginName,
    providerHintHtml: agentLoginProviderHintHtml,
    record: agentLoginRecord,
    status: agentLoginStatus,
  };

  Object.assign(globalThis, { CairnAgentLoginModel: CAIRN_AGENT_LOGIN_MODEL });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnAgentLoginModel: CAIRN_AGENT_LOGIN_MODEL });
  }
})();
