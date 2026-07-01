(() => {
// @ts-check
// Agent-login provider and status normalization helpers.
(() => {
    const AGENT_LOGIN_STATUS = {
        connecting: "Connecting\u2026",
        ready: "Connected \u2014 follow the prompts below.",
        terminalLoadError: "Couldn't load the terminal. Reload and try again.",
        connectionOpenError: "Couldn't open the connection.",
        connected: "\u2713 Connected",
        loginIncomplete: "Login didn't complete \u2014 check the terminal above, then try again.",
        busy: "Another login is already running \u2014 try again in a moment.",
        genericError: "Something went wrong.",
        connectionError: "Connection error \u2014 make sure the server is reachable, then try again.",
        disconnected: "Disconnected before the login finished \u2014 try again.",
    };
    function agentLoginRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function agentLoginControl(value) {
        return agentLoginRecord(value);
    }
    function normalizeAgentLoginName(value) {
        return String(value || "").trim();
    }
    function agentLoginProviderHintHtml(name) {
        return name.toLowerCase() === "grok"
            ? `<p class="agent-login-hint">Grok can also authenticate with an API key &mdash; set <code>XAI_API_KEY</code> in the server environment instead of this device login.</p>`
            : "";
    }
    function agentLoginStatus(key) {
        return AGENT_LOGIN_STATUS[key];
    }
    const CAIRN_AGENT_LOGIN_MODEL = {
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
})();
