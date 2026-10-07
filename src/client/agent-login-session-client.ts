// @ts-check
// Agent-login terminal and WebSocket PTY session wiring.
//
// The session knows nothing about how it is shown. It mounts xterm into the host's
// `termHost` (which may sit folded away behind "Show details" — it still receives
// every byte, so the URL and code scans keep working), and REPORTS what it learns as
// events: the sign-in link the CLI printed, a device code, the exit code. The friendly
// sign-in panel (agent-login-panel-client.ts) turns those into an "Open <Provider>
// sign-in" button, a large copyable code and a paste box — the Settings modal and the
// welcome's Connect step both host that panel, so neither looks like a terminal.

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

  // Sign-in URL fallback for CLIs that print the URL as plain text: the newest https
  // URL in the buffer. Full-screen TUIs hard-wrap long URLs inside box borders, so a
  // URL-run may continue across following lines — append lines that are pure URL
  // characters once their border glyphs and padding are stripped.
  const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%]";
  const URL_RE = new RegExp("https://" + URL_CHARS + "+", "g");
  const URL_RUN_RE = new RegExp("^" + URL_CHARS + "+$");
  // A device-authorization code ("ABCD-EFGH", "WDJB-MJHT2"): letters and digits in two
  // dash-joined groups, never inside a URL (those are stripped before the scan).
  const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/g;

  function bufferLines(term: InstanceType<AgentLoginXtermConstructor>): string[] {
    const buf = term.buffer?.active;
    if (!buf) return [];
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString?.(true) ?? "";
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
  }

  function findAuthUrl(lines: string[]): string {
    let found = "";
    for (let i = 0; i < lines.length; i++) {
      const matches = (lines[i] ?? "").match(URL_RE);
      if (!matches) continue;
      let url = matches[matches.length - 1] ?? "";
      // Only a URL that ran to the line's end can continue on the next line.
      if ((lines[i] ?? "").trimEnd().endsWith(url)) {
        for (let j = i + 1; j < lines.length; j++) {
          // A wrapped URL's tail is the WHOLE line once border glyphs are gone; a line
          // that reads as words ("2. Enter this code") is the next paragraph.
          const cont = (lines[j] ?? "").replace(/[\s│┃|]+/g, " ").trim();
          if (!cont || cont.includes(" ") || !URL_RUN_RE.test(cont)) break;
          url += cont;
        }
      }
      found = url.replace(/[.,;:)\]]+$/, "");
    }
    return found;
  }

  function findDeviceCode(lines: string[]): string {
    let found = "";
    for (const line of lines) {
      const text = line.replace(URL_RE, " ");
      const matches = text.match(CODE_RE);
      // Two letters-only halves of a sentence ("HTTP-ONLY") are not a code; a real one
      // carries a digit or sits on a line of its own.
      for (const match of matches || []) {
        if (/\d/.test(match) || text.trim() === match) found = match;
      }
    }
    return found;
  }

  async function startAgentLoginSession(name: string, host: AgentLoginHost): Promise<AgentLoginSessionHandle | null> {
    const model = agentLoginModel();
    let Terminal: AgentLoginXtermConstructor | undefined;
    let FitAddon: AgentLoginFitAddonConstructor | undefined;
    host.emit({ t: "status", key: "connecting" });
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
      host.emit({ t: "failed", reason: "terminal", message: model.status("terminalLoadError") });
      return null;
    }
    if (!host.alive()) return null;

    let closed = false;
    let lastUrl = "";
    let lastCode = "";
    let finished = false;

    // A modern CLI may emit OSC 8 hyperlinks — the full URI travels in the escape even
    // when the visible text is truncated. Activating one inside the terminal opens it
    // and mirrors it onto the panel's link button.
    // The terminal takes its well's own colour (a token), so it never shows a second
    // tone inside its frame in either theme.
    let well = "#2c2620";
    try {
      const bg = getComputedStyle(host.termHost).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) well = bg;
    } catch {}
    const term = new Terminal({
      convertEol: false,
      fontSize: 13,
      cursorBlink: true,
      linkHandler: {
        activate: (_event: unknown, uri: string) => {
          reportUrl(String(uri));
          try { window.open(String(uri), "_blank", "noopener"); } catch {}
        },
      },
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: {
        background: well,
        foreground: "#ece6da",
        cursor: "#d9b48a",
        selectionBackground: "#3a3733",
        black: well,
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
    term.open(host.termHost);
    try { fit.fit(); } catch {}
    // Mirror the server's clampPtySize bounds (40–400 cols, 20–200 rows) so the
    // xterm grid and the PTY window always agree — a phone whose fit lands under the
    // floor (or a folded-away host that measures nothing) would otherwise render a
    // grid smaller than the PTY and garble every full-screen TUI.
    const cols = Math.min(400, Math.max(40, Math.floor(term.cols || 0) || 100));
    const rows = Math.min(200, Math.max(20, Math.floor(term.rows || 0) || 32));
    if (cols !== term.cols || rows !== term.rows) {
      try { term.resize?.(cols, rows); } catch {}
    }
    // No refit-on-window-resize: the PTY window is fixed at spawn, so reflowing the
    // client grid mid-session (the phone keyboard opening) would only desync it.

    function reportUrl(url: string): void {
      if (!/^https:\/\//.test(url) || url === lastUrl) return;
      lastUrl = url;
      host.emit({ t: "link", url });
    }

    let scanTimer: ReturnType<typeof setTimeout> | null = null;
    const scan = (): void => {
      scanTimer = null;
      try {
        const lines = bufferLines(term);
        const url = findAuthUrl(lines);
        if (url) reportUrl(url);
        const code = findDeviceCode(lines);
        if (code && code !== lastCode) {
          lastCode = code;
          host.emit({ t: "code", code });
        }
      } catch {}
    };
    const scheduleScan = (): void => {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 300);
    };

    const teardown = (): void => {
      if (closed) return;
      closed = true;
      if (scanTimer) clearTimeout(scanTimer);
      try { ws?.close(); } catch {}
      try { term.dispose(); } catch {}
    };

    const fail = (reason: AgentLoginFailReason, message: string): void => {
      if (finished || closed) return;
      finished = true;
      host.emit({ t: "failed", reason, message });
    };

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(agentLoginWsUrl(name, term.cols || 0, term.rows || 0));
    } catch {
      fail("connection", model.status("connectionOpenError"));
      return { send: () => false, close: teardown };
    }
    const socket = ws;
    socket.binaryType = "arraybuffer";

    const handleControl = (message: unknown): void => {
      const msg = model.control(message);
      switch (msg.t) {
        case "exit":
          if (msg.code === 0) {
            finished = true;
            host.emit({ t: "connected" });
          } else {
            fail("incomplete", model.status("loginIncomplete"));
          }
          break;
        case "busy":
          finished = true;
          host.emit({ t: "busy", message: model.status("busy") });
          break;
        case "error":
          fail("error", msg.message ? String(msg.message) : model.status("genericError"));
          break;
        default:
          break;
      }
    };

    socket.onopen = () => {
      host.emit({ t: "status", key: "ready" });
      try { socket.send(JSON.stringify({ t: "resize", cols: term.cols || 0, rows: term.rows || 0 })); } catch {}
    };
    socket.onmessage = (event): void => {
      if (typeof event.data === "string") {
        try { handleControl(JSON.parse(event.data)); } catch {}
      } else if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
        scheduleScan();
      }
    };
    socket.onerror = () => fail("connection", model.status("connectionError"));
    socket.onclose = () => {
      if (host.alive() && !closed) fail("disconnected", model.status("disconnected"));
    };

    term.onData?.((data: string) => {
      if (socket.readyState === 1) socket.send(data);
    });
    term.onResize?.(({ cols: c, rows: r }: { cols: number; rows: number }) => {
      if (socket.readyState === 1) {
        try { socket.send(JSON.stringify({ t: "resize", cols: c, rows: r })); } catch {}
      }
    });

    return {
      // A pasted code (iOS never offers its paste callout on xterm's hidden textarea)
      // goes to the CLI as if typed, then Enter.
      send(text: string): boolean {
        const value = String(text || "").trim();
        if (!value || socket.readyState !== 1) return false;
        socket.send(value + "\r");
        return true;
      },
      focusTerminal(): void {
        try { term.focus?.(); } catch {}
      },
      close: teardown,
    };
  }

  const CAIRN_AGENT_LOGIN_SESSION: AgentLoginSessionApi = {
    start: startAgentLoginSession,
    findAuthUrl,
    findDeviceCode,
  };

  Object.assign(globalThis, { CairnAgentLoginSession: CAIRN_AGENT_LOGIN_SESSION });
})();
