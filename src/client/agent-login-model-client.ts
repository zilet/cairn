// @ts-check
// Agent-login provider and status normalization helpers.

(() => {
  // Plain words for every way a sign-in can stand. They speak to the person, never
  // about the terminal behind them (that stays folded under "Show details").
  const AGENT_LOGIN_STATUS: Record<AgentLoginStatusKey, string> = {
    connecting: "Starting the sign-in\u2026",
    ready: "Waiting for the sign-in page\u2026",
    terminalLoadError: "The sign-in couldn't load. Reload the page and try again.",
    connectionOpenError: "Couldn't reach the server to start the sign-in.",
    connected: "Signed in",
    loginIncomplete: "The sign-in didn't finish.",
    busy: "Another sign-in is already running. Try again in a moment.",
    genericError: "Something went wrong with the sign-in.",
    connectionError: "Lost the connection to the server. Make sure it's reachable, then try again.",
    disconnected: "The sign-in closed before it finished.",
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
      return `<p class="agent-login-hint">Grok also works with an xAI API key: set <code>XAI_API_KEY</code> in the server's environment instead of signing in here.</p>`;
    }
    if (provider === "antigravity") {
      return `<p class="agent-login-hint">Antigravity signs in inside its own screen below. Choose Google, approve it in the page that opens, and once its prompt appears you're signed in &mdash; then tap <b>I've signed in</b>.</p>`;
    }
    return "";
  }

  // The name a person knows each provider by. The agent key stays the server's.
  const PROVIDER_LABELS: Record<string, string> = {
    claude: "Claude",
    codex: "ChatGPT",
    antigravity: "Google",
    grok: "Grok",
  };

  function agentLoginLabel(name: string): string {
    const key = String(name || "").trim();
    const known = PROVIDER_LABELS[key.toLowerCase()];
    if (known) return known;
    return key ? key.charAt(0).toUpperCase() + key.slice(1) : "";
  }

  function agentLoginStatus(key: AgentLoginStatusKey): string {
    return AGENT_LOGIN_STATUS[key];
  }

  const CAIRN_AGENT_LOGIN_MODEL: AgentLoginModelApi = {
    control: agentLoginControl,
    label: agentLoginLabel,
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
