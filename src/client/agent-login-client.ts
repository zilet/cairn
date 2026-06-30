// @ts-check
// In-app agent-login terminal (xterm over a WebSocket PTY).

type AgentLoginRecord = Record<string, unknown>;
type AgentLoginOverlay = HTMLDivElement & {
  _failed?: boolean;
  _onKey?: (event: KeyboardEvent) => void;
  _onResize?: () => void;
  _term?: { dispose?: () => void };
  _ws?: WebSocket;
};
type AgentLoginXtermConstructor = new (options: AgentLoginRecord) => {
  open(el: Element): void;
  write(text: string | Uint8Array): void;
  dispose(): void;
  onData?(handler: (data: string) => void): void;
  onResize?(handler: (size: { cols: number; rows: number }) => void): void;
  focus?(): void;
  loadAddon?(addon: unknown): void;
  cols?: number;
  rows?: number;
};
type AgentLoginFitAddonConstructor = new () => { fit(): void };

(() => {
  let xtermAssets: Promise<void> | null = null;

  function agentLoginRecord(value: unknown): AgentLoginRecord {
    return value && typeof value === "object" ? value as AgentLoginRecord : {};
  }

  function xtermWindow(): { Terminal?: AgentLoginXtermConstructor; FitAddon?: { FitAddon?: AgentLoginFitAddonConstructor } } {
    return window as unknown as { Terminal?: AgentLoginXtermConstructor; FitAddon?: { FitAddon?: AgentLoginFitAddonConstructor } };
  }

  function loadXtermAssets(): Promise<void> {
    if (xtermAssets) return xtermAssets;
    xtermAssets = new Promise<void>((resolve, reject) => {
      try {
        if (!document.querySelector('link[data-xterm-css]')) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = "/vendor/xterm.css";
          link.setAttribute("data-xterm-css", "1");
          document.head.appendChild(link);
        }
        const globals = xtermWindow();
        if (globals.Terminal && globals.FitAddon) { resolve(); return; }
        const loadScript = (src: string): Promise<void> => new Promise<void>((res, rej) => {
          let el = document.querySelector<HTMLScriptElement>(`script[data-xterm-src="${src}"]`);
          if (el) {
            el.addEventListener("load", () => res());
            el.addEventListener("error", () => rej(new Error("load " + src)));
            if (el.dataset.loaded) res();
            return;
          }
          el = document.createElement("script");
          el.src = src;
          el.async = false;
          el.setAttribute("data-xterm-src", src);
          el.addEventListener("load", () => { el.dataset.loaded = "1"; res(); });
          el.addEventListener("error", () => rej(new Error("load " + src)));
          document.head.appendChild(el);
        });
        loadScript("/vendor/xterm.js")
          .then(() => loadScript("/vendor/xterm-addon-fit.js"))
          .then(() => resolve())
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    });
    return xtermAssets;
  }

  function ensureAgentLoginStyles(): void {
    if (document.getElementById("agent-login-styles")) return;
    const style = document.createElement("style");
    style.id = "agent-login-styles";
    style.textContent = `
.agent-login-ov{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
  padding:max(env(safe-area-inset-top),18px) 16px max(env(safe-area-inset-bottom),18px);
  background:rgba(33,29,23,.46);backdrop-filter:saturate(1.1) blur(2px);
  animation:agentLoginFade .16s ease both}
@keyframes agentLoginFade{from{opacity:0}to{opacity:1}}
.agent-login{width:min(720px,100%);max-height:100%;display:flex;flex-direction:column;
  background:var(--card,#fffdf8);color:var(--ink,#211d17);border:1px solid var(--line,#e7dfd2);
  border-radius:var(--radius,18px);box-shadow:var(--shadow-lg,0 28px 64px rgba(0,0,0,.3));
  overflow:hidden;font-family:var(--font-ui,system-ui,sans-serif)}
.agent-login-hd{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line,#e7dfd2)}
.agent-login-hd h2{margin:0;font-family:var(--font-display,Georgia,serif);font-size:19px;font-weight:600;flex:1;line-height:1.2}
.agent-login-x{appearance:none;border:0;background:transparent;color:var(--muted,#746c5c);
  font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px}
.agent-login-x:hover{color:var(--ink,#211d17);background:var(--paper,#f4efe7)}
.agent-login-bd{padding:14px 16px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.agent-login-term{background:var(--stone-deep,#2c2620);border-radius:12px;padding:10px 8px 8px;
  border:1px solid var(--stone,#473f36);min-height:180px;height:clamp(180px,42vh,340px)}
.agent-login-term .xterm{padding:0}
.agent-login-status{font-size:13px;color:var(--muted,#746c5c);min-height:18px;display:flex;align-items:center;gap:6px}
.agent-login-status.is-ok{color:var(--sage,#6e7f5c);font-weight:600}
.agent-login-status.is-err{color:var(--accent,#b4552d);font-weight:600}
.agent-login-hint{font-size:12.5px;color:var(--muted,#746c5c);line-height:1.5;margin:0}
.agent-login-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
  background:var(--paper,#f4efe7);padding:1px 5px;border-radius:5px;border:1px solid var(--line,#e7dfd2)}
.agent-login-ft{display:flex;justify-content:flex-end;gap:10px;padding-top:2px}
.agent-login-btn{appearance:none;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;
  padding:9px 16px;border-radius:11px;border:1px solid var(--line,#e7dfd2);
  background:var(--paper,#f4efe7);color:var(--ink,#211d17)}
.agent-login-btn:hover{background:var(--card,#fffdf8)}
.agent-login-btn:focus-visible,.agent-login-x:focus-visible{outline:2px solid var(--accent,#b4552d);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.agent-login-ov{animation:none}}
`;
    document.head.appendChild(style);
  }

  function closeAgentLoginModal(overlay: AgentLoginOverlay | null | undefined): void {
    if (!overlay || overlay.dataset.closing) return;
    overlay.dataset.closing = "1";
    try { overlay._ws?.close(); } catch {}
    try { overlay._term?.dispose?.(); } catch {}
    try { if (overlay._onResize) window.removeEventListener("resize", overlay._onResize); } catch {}
    try { if (overlay._onKey) document.removeEventListener("keydown", overlay._onKey); } catch {}
    overlay.remove();
  }

  async function openAgentLoginModal(agentName: unknown): Promise<void> {
    const name = String(agentName || "").trim();
    if (!name) return;
    ensureAgentLoginStyles();

    const overlay = document.createElement("div") as AgentLoginOverlay;
    overlay.className = "agent-login-ov";
    const grokNote = name.toLowerCase() === "grok"
      ? `<p class="agent-login-hint">Grok can also authenticate with an API key &mdash; set <code>XAI_API_KEY</code> in the server environment instead of this device login.</p>`
      : "";
    overlay.innerHTML = `
    <div class="agent-login" role="dialog" aria-modal="true" aria-label="Connect ${escAttr(name)}">
      <div class="agent-login-hd">
        <h2>Connect ${escHtml(name)}</h2>
        <button class="agent-login-x" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="agent-login-bd">
        <div class="agent-login-status" role="status">Connecting&hellip;</div>
        <div class="agent-login-term"></div>
        ${grokNote}
        <p class="agent-login-hint">Follow the prompts. If a URL and a code appear, open the URL in your browser to authorize.</p>
        <div class="agent-login-ft">
          <button class="agent-login-btn" type="button" data-close>Cancel</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const statusEl = overlay.querySelector<HTMLElement>(".agent-login-status");
    const termHost = overlay.querySelector<HTMLElement>(".agent-login-term");
    const closeBtn = overlay.querySelector<HTMLButtonElement>(".agent-login-ft [data-close]");
    const footer = overlay.querySelector<HTMLElement>(".agent-login-ft");
    if (!statusEl || !termHost || !closeBtn || !footer) {
      overlay.remove();
      return;
    }
    const setStatus = (text: string, cls?: string) => {
      statusEl.textContent = text;
      statusEl.classList.remove("is-ok", "is-err");
      if (cls) statusEl.classList.add(cls);
    };
    const markFailed = (msg: string) => {
      setStatus(msg, "is-err");
      overlay._failed = true;
      closeBtn.textContent = "Close";
      if (!footer.querySelector("[data-retry]")) {
        const retry = document.createElement("button");
        retry.className = "agent-login-btn";
        retry.type = "button";
        retry.dataset.retry = "1";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => { closeAgentLoginModal(overlay); openAgentLoginModal(name); });
        footer.insertBefore(retry, closeBtn);
      }
    };
    overlay._onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeAgentLoginModal(overlay); return; }
      if (event.key !== "Tab") return;
      const focusable = [...overlay.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.offsetParent !== null);
      if (focusable.length < 2) return;
      const first = focusable[0], last = focusable[focusable.length - 1], active = document.activeElement;
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", overlay._onKey);
    overlay.querySelector(".agent-login-x")?.addEventListener("click", () => closeAgentLoginModal(overlay));
    closeBtn.addEventListener("click", () => closeAgentLoginModal(overlay));

    let Terminal: AgentLoginXtermConstructor | undefined;
    let FitAddon: AgentLoginFitAddonConstructor | undefined;
    try {
      await loadXtermAssets();
      const globals = xtermWindow();
      Terminal = globals.Terminal;
      FitAddon = globals.FitAddon?.FitAddon;
      if (typeof Terminal !== "function" || typeof FitAddon !== "function") {
        throw new Error("terminal library unavailable");
      }
    } catch {
      setStatus("Couldn't load the terminal. Reload and try again.", "is-err");
      return;
    }
    if (!overlay.isConnected) return;

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
        black: "#2c2620", red: "#d2795a", green: "#9bb07e", yellow: "#d9b48a",
        blue: "#7f9bb0", magenta: "#b08a9b", cyan: "#7fb0a8", white: "#ece6da",
      },
    });
    const fit = new FitAddon();
    term.loadAddon?.(fit);
    term.open(termHost);
    try { fit.fit(); } catch {}
    overlay._term = term;
    overlay._onResize = () => { try { fit.fit(); } catch {} };
    window.addEventListener("resize", overlay._onResize);

    const token = (typeof authToken === "function" && authToken()) || "";
    const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host +
      "/api/agent-login/ws?agent=" + encodeURIComponent(name) +
      (token ? "&token=" + encodeURIComponent(token) : "");

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      setStatus("Couldn't open the connection.", "is-err");
      return;
    }
    ws.binaryType = "arraybuffer";
    overlay._ws = ws;

    const handleControl = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const msg = agentLoginRecord(message);
      switch (msg.t) {
        case "exit": {
          if (msg.code === 0) {
            setStatus("\u2713 Connected", "is-ok");
            setTimeout(() => {
              closeAgentLoginModal(overlay);
              if (typeof renderSettings === "function") renderSettings();
            }, 1200);
          } else {
            markFailed("Login didn't complete \u2014 check the terminal above, then try again.");
          }
          break;
        }
        case "busy":
          if (typeof toast === "function") toast("Another login is already running \u2014 try again in a moment.");
          closeAgentLoginModal(overlay);
          break;
        case "error":
          markFailed(msg.message ? String(msg.message) : "Something went wrong.");
          break;
        default:
          break;
      }
    };

    ws.onopen = () => {
      setStatus("Connected \u2014 follow the prompts below.");
      try { term.focus?.(); } catch {}
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try { handleControl(JSON.parse(event.data)); } catch {}
      } else if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };
    ws.onerror = () => {
      if (!overlay._failed) markFailed("Connection error \u2014 make sure the server is reachable, then try again.");
    };
    ws.onclose = () => {
      if (overlay.isConnected && !overlay.dataset.closing && !overlay._failed && !statusEl.classList.contains("is-ok")) {
        markFailed("Disconnected before the login finished \u2014 try again.");
      }
    };

    term.onData?.((data: string) => { if (ws.readyState === 1) ws.send(data); });
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

  Object.assign(globalThis, { openAgentLoginModal });

  if (typeof window !== "undefined") {
    Object.assign(window, { openAgentLoginModal });
  }
})();
