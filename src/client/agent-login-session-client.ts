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

  function agentLoginWsUrl(name: string, cols: number, rows: number): string {
    const token = (typeof authToken === "function" && authToken()) || "";
    // The server PTY window is fixed at spawn, so the fitted size rides the
    // connect URL — the later resize control message is best-effort only.
    return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host +
      "/api/agent-login/ws?agent=" + encodeURIComponent(name) +
      "&cols=" + encodeURIComponent(String(cols || 0)) +
      "&rows=" + encodeURIComponent(String(rows || 0)) +
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

    // A modern CLI may emit OSC 8 hyperlinks — the full URI travels in the
    // escape even when the visible text is truncated. Clicking one opens it
    // AND mirrors it onto the modal's link surface; a vendored xterm build
    // without linkHandler support just ignores the option.
    const term = new Terminal({
      convertEol: false,
      fontSize: 13,
      cursorBlink: true,
      linkHandler: {
        activate: (_event: unknown, uri: string) => {
          modal.showAuthLink(String(uri));
          try { window.open(String(uri), "_blank", "noopener"); } catch {}
        },
      },
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
    // Mirror the server's clampPtySize bounds (40–400 cols, 20–200 rows) so the
    // xterm grid and the PTY window always agree — a phone whose fit lands
    // under the floor would otherwise render 17 rows against a 20-row PTY and
    // garble every full-screen TUI. The host scrolls when the grid overflows.
    const cols = Math.min(400, Math.max(40, Math.floor(term.cols || 0) || 100));
    const rows = Math.min(200, Math.max(20, Math.floor(term.rows || 0) || 32));
    if (cols !== term.cols || rows !== term.rows) {
      try { term.resize?.(cols, rows); } catch {}
    }
    modal.overlay._term = term;
    // No refit-on-window-resize: the PTY window is fixed at spawn, so reflowing
    // the client grid mid-session (e.g. the phone keyboard opening) would only
    // desync it from the PTY. The terminal keeps its spawn size for the session.

    // Sign-in URL fallback for CLIs that print the URL as plain text: scan the
    // terminal buffer after output settles and surface the newest https URL as
    // the modal's tap-friendly link. Full-screen TUIs hard-wrap long URLs
    // inside box borders, so a URL-run may continue across following lines —
    // append lines that are pure URL characters once their border glyphs and
    // padding are stripped.
    const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%]";
    const URL_RE = new RegExp("https://" + URL_CHARS + "+", "g");
    let scanTimer: ReturnType<typeof setTimeout> | null = null;
    const scanForAuthUrl = (): void => {
      scanTimer = null;
      try {
        const buf = term.buffer?.active;
        if (!buf) return;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          const text = line?.translateToString?.(true) ?? "";
          if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
          else lines.push(text);
        }
        let found = "";
        for (let i = 0; i < lines.length; i++) {
          const matches = (lines[i] ?? "").match(URL_RE);
          if (!matches) continue;
          let url = matches[matches.length - 1] ?? "";
          // Only a URL that ran to the line's end can continue on the next line.
          if ((lines[i] ?? "").trimEnd().endsWith(url)) {
            for (let j = i + 1; j < lines.length; j++) {
              const cont = (lines[j] ?? "").replace(/[\s│┃|]+/g, " ").trim().split(" ")[0] ?? "";
              if (!cont || !new RegExp("^" + URL_CHARS + "+$").test(cont)) break;
              url += cont;
            }
          }
          found = url.replace(/[.,;:)\]]+$/, "");
        }
        if (found) modal.showAuthLink(found);
      } catch {}
    };
    const scheduleAuthUrlScan = (): void => {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanForAuthUrl, 300);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(agentLoginWsUrl(name, term.cols || 0, term.rows || 0));
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
        scheduleAuthUrlScan();
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
    // iOS never offers its paste callout on xterm's hidden textarea, so OAuth
    // codes go through this native input instead — sent as if typed + Enter.
    const sendPasted = (): void => {
      const text = modal.pasteInput.value.trim();
      if (!text || ws.readyState !== 1) return;
      ws.send(text + "\r");
      modal.pasteInput.value = "";
    };
    modal.pasteSend.addEventListener("click", sendPasted);
    modal.pasteInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendPasted();
      }
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
