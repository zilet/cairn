(() => {
// @ts-check
// Agent-login modal rendering, focus trap, and close/retry controls.
(() => {
    function agentLoginModel() {
        const api = globalThis.CairnAgentLoginModel;
        if (!api)
            throw new Error("agent login model unavailable");
        return api;
    }
    function ensureAgentLoginStyles() {
        if (document.getElementById("agent-login-styles"))
            return;
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
    function closeAgentLoginModal(overlay) {
        if (!overlay || overlay.dataset.closing)
            return;
        overlay.dataset.closing = "1";
        try {
            overlay._ws?.close();
        }
        catch { }
        try {
            overlay._term?.dispose?.();
        }
        catch { }
        try {
            if (overlay._onResize)
                window.removeEventListener("resize", overlay._onResize);
        }
        catch { }
        try {
            if (overlay._onKey)
                document.removeEventListener("keydown", overlay._onKey);
        }
        catch { }
        overlay.remove();
    }
    function createAgentLoginModal(name, retryLogin) {
        ensureAgentLoginStyles();
        const model = agentLoginModel();
        const overlay = document.createElement("div");
        overlay.className = "agent-login-ov";
        overlay.innerHTML = `
    <div class="agent-login" role="dialog" aria-modal="true" aria-label="Connect ${escAttr(name)}">
      <div class="agent-login-hd">
        <h2>Connect ${escHtml(name)}</h2>
        <button class="agent-login-x" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="agent-login-bd">
        <div class="agent-login-status" role="status">${model.status("connecting")}</div>
        <div class="agent-login-term"></div>
        ${model.providerHintHtml(name)}
        <p class="agent-login-hint">Follow the prompts. If a URL and a code appear, open the URL in your browser to authorize.</p>
        <div class="agent-login-ft">
          <button class="agent-login-btn" type="button" data-close>Cancel</button>
        </div>
      </div>
    </div>`;
        document.body.appendChild(overlay);
        const statusEl = overlay.querySelector(".agent-login-status");
        const termHost = overlay.querySelector(".agent-login-term");
        const closeBtn = overlay.querySelector(".agent-login-ft [data-close]");
        const footer = overlay.querySelector(".agent-login-ft");
        if (!statusEl || !termHost || !closeBtn || !footer) {
            overlay.remove();
            return null;
        }
        const setStatus = (text, cls) => {
            statusEl.textContent = text;
            statusEl.classList.remove("is-ok", "is-err");
            if (cls)
                statusEl.classList.add(cls);
        };
        const markFailed = (message) => {
            setStatus(message, "is-err");
            overlay._failed = true;
            closeBtn.textContent = "Close";
            if (!footer.querySelector("[data-retry]")) {
                const retry = document.createElement("button");
                retry.className = "agent-login-btn";
                retry.type = "button";
                retry.dataset.retry = "1";
                retry.textContent = "Try again";
                retry.addEventListener("click", () => {
                    closeAgentLoginModal(overlay);
                    retryLogin(name);
                });
                footer.insertBefore(retry, closeBtn);
            }
        };
        overlay._onKey = (event) => {
            if (event.key === "Escape") {
                closeAgentLoginModal(overlay);
                return;
            }
            if (event.key !== "Tab")
                return;
            const focusable = [...overlay.querySelectorAll("button")]
                .filter((button) => button.offsetParent !== null);
            if (focusable.length < 2)
                return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (!first || !last)
                return;
            if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", overlay._onKey);
        overlay.querySelector(".agent-login-x")?.addEventListener("click", () => closeAgentLoginModal(overlay));
        closeBtn.addEventListener("click", () => closeAgentLoginModal(overlay));
        return {
            overlay,
            termHost,
            isOk: () => statusEl.classList.contains("is-ok"),
            markFailed,
            setStatus,
        };
    }
    const CAIRN_AGENT_LOGIN_MODAL = {
        close: closeAgentLoginModal,
        create: createAgentLoginModal,
    };
    Object.assign(globalThis, { CairnAgentLoginModal: CAIRN_AGENT_LOGIN_MODAL });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnAgentLoginModal: CAIRN_AGENT_LOGIN_MODAL });
    }
})();
})();
