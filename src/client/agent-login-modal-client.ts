// @ts-check
// Settings → Agents "Connect": the friendly sign-in panel (agent-login-panel-client.ts)
// in a sheet, with its one way out (Escape, backdrop, ✕, Cancel) and, after a failed
// sign-in, Try again. Styles live in src/styles/welcome/connect.css with the panel's.

(() => {
  function agentLoginModel(): AgentLoginModelApi {
    const api = (globalThis as { CairnAgentLoginModel?: AgentLoginModelApi }).CairnAgentLoginModel;
    if (!api) throw new Error("agent login model unavailable");
    return api;
  }

  function agentLoginPanel(): AgentLoginPanelApi | null {
    return (globalThis as { CairnAgentLoginPanel?: AgentLoginPanelApi }).CairnAgentLoginPanel || null;
  }

  function closeAgentLoginModal(overlay: AgentLoginOverlay | null | undefined): void {
    if (!overlay || overlay.dataset.closing) return;
    overlay.dataset.closing = "1";
    try { overlay._panel?.close(); } catch {}
    const sheet = CairnUiSheet.sheetFor(overlay);
    if (sheet) sheet.close();
    else overlay.remove();
  }

  function createAgentLoginModal(name: string, retryLogin: AgentLoginRetry): AgentLoginModalHandle | null {
    const model = agentLoginModel();
    const label = model.label(name) || name;
    let overlayRef: AgentLoginOverlay | null = null;
    const sheet = CairnUiSheet.open({
      overlayClass: "agent-login-ov",
      sheetClass: "agent-login",
      label: `Connect ${label}`,
      closeSelector: ".agent-login-x, .agent-login-ft [data-close]",
      onClose: () => closeAgentLoginModal(overlayRef),
      html: `
      <div class="agent-login-hd">
        <h2>Connect ${escHtml(label)}</h2>
        <button class="agent-login-x iconbtn" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="agent-login-bd">
        <div class="agent-login-panel"></div>
        <div class="agent-login-ft">
          <button class="btn" type="button" data-close>Cancel</button>
        </div>
      </div>`,
    });
    const overlay = sheet.overlay as AgentLoginOverlay;
    overlayRef = overlay;
    const panelHost = overlay.querySelector<HTMLElement>(".agent-login-panel");
    const footer = overlay.querySelector<HTMLElement>(".agent-login-ft");
    const closeBtn = overlay.querySelector<HTMLButtonElement>(".agent-login-ft [data-close]");
    const panel = agentLoginPanel();
    if (!panelHost || !footer || !closeBtn) {
      closeAgentLoginModal(overlay);
      return null;
    }

    const offerRetry = (): void => {
      closeBtn.textContent = "Close";
      if (footer.querySelector("[data-retry]")) return;
      const retry = document.createElement("button");
      retry.className = "btn btn-solid";
      retry.type = "button";
      retry.dataset.retry = "1";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => {
        closeAgentLoginModal(overlay);
        retryLogin(name);
      });
      footer.insertBefore(retry, closeBtn);
    };

    if (panel) {
      overlay._panel = panel.mount(panelHost, {
        name,
        label,
        detailsOpen: name.toLowerCase() === "antigravity",
        onConnected: () => {
          closeBtn.textContent = "Done";
          setTimeout(() => {
            closeAgentLoginModal(overlay);
            if (typeof renderSettings === "function") renderSettings();
          }, 1200);
        },
        onFailed: offerRetry,
        onBusy: (message) => {
          if (typeof toast === "function") toast(message);
          closeAgentLoginModal(overlay);
        },
      });
    }

    return { overlay, close: () => closeAgentLoginModal(overlay) };
  }

  const CAIRN_AGENT_LOGIN_MODAL: AgentLoginModalApi = {
    close: closeAgentLoginModal,
    create: createAgentLoginModal,
  };

  Object.assign(globalThis, { CairnAgentLoginModal: CAIRN_AGENT_LOGIN_MODAL });
})();
