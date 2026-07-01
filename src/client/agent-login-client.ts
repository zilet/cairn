// @ts-check
// Stable Settings entry point for the in-app agent-login terminal.

(() => {
  function agentLoginModel(): AgentLoginModelApi | null {
    return (globalThis as { CairnAgentLoginModel?: AgentLoginModelApi }).CairnAgentLoginModel || null;
  }

  function agentLoginModal(): AgentLoginModalApi | null {
    return (globalThis as { CairnAgentLoginModal?: AgentLoginModalApi }).CairnAgentLoginModal || null;
  }

  function agentLoginSession(): AgentLoginSessionApi | null {
    return (globalThis as { CairnAgentLoginSession?: AgentLoginSessionApi }).CairnAgentLoginSession || null;
  }

  async function openAgentLoginModal(agentName: unknown): Promise<void> {
    const model = agentLoginModel();
    const modal = agentLoginModal();
    const session = agentLoginSession();
    if (!model || !modal || !session) return;

    const name = model.normalizeName(agentName);
    if (!name) return;

    const handle = modal.create(name, (retryName) => { void openAgentLoginModal(retryName); });
    if (!handle) return;
    await session.start(name, handle);
  }

  Object.assign(globalThis, { openAgentLoginModal });

  if (typeof window !== "undefined") {
    Object.assign(window, { openAgentLoginModal });
  }
})();
