(() => {
// @ts-check
// Stable Settings entry point for the in-app agent-login terminal.
(() => {
    function agentLoginModel() {
        return globalThis.CairnAgentLoginModel || null;
    }
    function agentLoginModal() {
        return globalThis.CairnAgentLoginModal || null;
    }
    function agentLoginSession() {
        return globalThis.CairnAgentLoginSession || null;
    }
    async function openAgentLoginModal(agentName) {
        const model = agentLoginModel();
        const modal = agentLoginModal();
        const session = agentLoginSession();
        if (!model || !modal || !session)
            return;
        const name = model.normalizeName(agentName);
        if (!name)
            return;
        const handle = modal.create(name, (retryName) => { void openAgentLoginModal(retryName); });
        if (!handle)
            return;
        await session.start(name, handle);
    }
    Object.assign(globalThis, { openAgentLoginModal });
    if (typeof window !== "undefined") {
        Object.assign(window, { openAgentLoginModal });
    }
})();
})();
