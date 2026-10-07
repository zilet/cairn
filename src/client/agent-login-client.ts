// @ts-check
// Stable Settings entry point for the in-app agent-login terminal.

(() => {
  function agentLoginModel(): AgentLoginModelApi | null {
    return (globalThis as { CairnAgentLoginModel?: AgentLoginModelApi }).CairnAgentLoginModel || null;
  }

  function agentLoginModal(): AgentLoginModalApi | null {
    return (globalThis as { CairnAgentLoginModal?: AgentLoginModalApi }).CairnAgentLoginModal || null;
  }

  async function openAgentLoginModal(agentName: unknown): Promise<void> {
    const model = agentLoginModel();
    const modal = agentLoginModal();
    if (!model || !modal) return;

    const name = model.normalizeName(agentName);
    if (!name) return;

    // The modal mounts the friendly sign-in panel, which starts the session itself.
    modal.create(name, (retryName) => { void openAgentLoginModal(retryName); });
  }

  Object.assign(globalThis, { openAgentLoginModal });

  if (typeof window !== "undefined") {
    Object.assign(window, { openAgentLoginModal });
  }
})();
