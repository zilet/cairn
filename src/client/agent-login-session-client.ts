// @ts-check
// Agent-login terminal and WebSocket PTY session wiring.

(() => {
  function agentLoginAssets(): AgentLoginAssetsApi {
    const api = (globalThis as { CairnAgentLoginAssets?: AgentLoginAssetsApi }).CairnAgentLoginAssets;
    if (!api) throw new Error("agent login assets unavailable");
    return api;
  }

  function agentLoginModel(): AgentLoginModelApi {
    const api = (globalThis as { CairnAgentLoginModel?: AgentLoginModelApi }).CairnAgentLoginModel;
    if (!api) throw new Error("agent login model unavailable");
    return api;
  }

  function agentLoginModal(): AgentLoginModalApi {
    const api = (globalThis as { CairnAgentLoginModal?: AgentLoginModalApi }).CairnAgentLoginModal;
    if (!api) throw new Error("agent login modal unavailable");
    return api;
  }

  function agentLoginWsUrl(name: string): string {
    const token = (typeof authToken === "function" && authToken()) || "";
    return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host +
      "/api/agent-login/ws?agent=" + encodeURIComponent(name) +
      (token ? "&token=" + encodeURIComponent(token) : "");
  }

  async function startAgentLoginSession(name: string, modal: AgentLoginModalHandle): Promise<void> {
    const model = agentLoginModel();
    let Terminal: AgentLoginXtermConstructor | undefined;
    let FitAddon: AgentLoginFitAddonConstructor | undefined;
    try {
      const assets = agentLoginAssets();
      await assets.load();
      const globals = assets.globals();
      Terminal = globals.Terminal;
      FitAddon = globals.FitAddon?.FitAddon;
      if (typeof Terminal !== "function" || typeof FitAddon !== "function") {
        throw new Error("terminal library unavailable");
      }
    } catch {
      modal.setStatus(model.status("terminalLoadError"), "is-err");
      return;
    }
    if (!modal.overlay.isConnected) return;

    const term = new Terminal({
      convertEol: false,
      fontSize: 13,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: {
        background: "#2c2620",
        foreground: "#ece6da",
        cursor: "#d9b48a",
        selectionBackground: "#3a3733",
        black: "#2c2620",
        red: "#d2795a",
        green: "#9bb07e",
        yellow: "#d9b48a",
        blue: "#7f9bb0",
        magenta: "#b08a9b",
        cyan: "#7fb0a8",
        white: "#ece6da",
      },
    });
    const fit = new FitAddon();
    term.loadAddon?.(fit);
    term.open(modal.termHost);
    try { fit.fit(); } catch {}
    modal.overlay._term = term;
    modal.overlay._onResize = () => { try { fit.fit(); } catch {} };
    window.addEventListener("resize", modal.overlay._onResize);

    let ws: WebSocket;
    try {
      ws = new WebSocket(agentLoginWsUrl(name));
    } catch {
      modal.setStatus(model.status("connectionOpenError"), "is-err");
      return;
    }
    ws.binaryType = "arraybuffer";
    modal.overlay._ws = ws;

    const handleControl = (message: unknown): void => {
      const msg = model.control(message);
      switch (msg.t) {
        case "exit": {
          if (msg.code === 0) {
            modal.setStatus(model.status("connected"), "is-ok");
            setTimeout(() => {
              agentLoginModal().close(modal.overlay);
              if (typeof renderSettings === "function") renderSettings();
            }, 1200);
          } else {
            modal.markFailed(model.status("loginIncomplete"));
          }
          break;
        }
        case "busy":
          if (typeof toast === "function") toast(model.status("busy"));
          agentLoginModal().close(modal.overlay);
          break;
        case "error":
          modal.markFailed(msg.message ? String(msg.message) : model.status("genericError"));
          break;
        default:
          break;
      }
    };

    ws.onopen = () => {
      modal.setStatus(model.status("ready"));
      try { term.focus?.(); } catch {}
    };
    ws.onmessage = (event): void => {
      if (typeof event.data === "string") {
        try { handleControl(JSON.parse(event.data)); } catch {}
      } else if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };
    ws.onerror = () => {
      if (!modal.overlay._failed) modal.markFailed(model.status("connectionError"));
    };
    ws.onclose = () => {
      if (modal.overlay.isConnected && !modal.overlay.dataset.closing && !modal.overlay._failed && !modal.isOk()) {
        modal.markFailed(model.status("disconnected"));
      }
    };

    term.onData?.((data: string) => {
      if (ws.readyState === 1) ws.send(data);
    });
    term.onResize?.(({ cols, rows }: { cols: number; rows: number }) => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ t: "resize", cols, rows })); } catch {}
      }
    });
    ws.addEventListener("open", () => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ t: "resize", cols: term.cols || 0, rows: term.rows || 0 })); } catch {}
      }
    });
  }

  const CAIRN_AGENT_LOGIN_SESSION: AgentLoginSessionApi = {
    start: startAgentLoginSession,
  };

  Object.assign(globalThis, { CairnAgentLoginSession: CAIRN_AGENT_LOGIN_SESSION });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnAgentLoginSession: CAIRN_AGENT_LOGIN_SESSION });
  }
})();
