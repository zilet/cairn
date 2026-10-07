// @ts-check
// The friendly sign-in panel: what a person sees while an AI provider's sign-in runs.
//
// It never looks like a terminal. The session (agent-login-session-client.ts) reports
// what the CLI printed, and this panel turns it into ordinary controls:
//   - the sign-in link → one primary button, "Open <Provider> sign-in" (+ Copy link);
//   - a device code    → shown large, with Copy;
//   - a provider that hands back a code to paste (Claude) → "Paste the code <Provider>
//     shows you", sent to the CLI as if typed;
//   - the raw terminal → folded under "Show details" (open from the start only for
//     Antigravity, whose sign-in is an interactive screen of its own).
// The Settings → Agents modal and the welcome's Connect step both host it.

(() => {
  type PanelPhase = "starting" | "waiting" | "link" | "pasted" | "connected" | "failed";

  // Providers whose sign-in page shows a code the person pastes back here.
  const PASTE_PROVIDERS = new Set(["claude"]);
  // Providers whose sign-in never exits on its own: the person says when they're done.
  const SELF_REPORT_PROVIDERS = new Set(["antigravity"]);

  function model(): AgentLoginModelApi {
    const api = (globalThis as { CairnAgentLoginModel?: AgentLoginModelApi }).CairnAgentLoginModel;
    if (!api) throw new Error("agent login model unavailable");
    return api;
  }

  function session(): AgentLoginSessionApi | null {
    return (globalThis as { CairnAgentLoginSession?: AgentLoginSessionApi }).CairnAgentLoginSession || null;
  }

  function pastesCode(name: string): boolean {
    return PASTE_PROVIDERS.has(String(name || "").toLowerCase());
  }

  function isTouch(): boolean {
    return (
      (typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 0) ||
      (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches)
    );
  }

  let seq = 0;

  function panelHtml(opts: AgentLoginPanelOptions, id: string): string {
    const label = escHtml(opts.label);
    const name = String(opts.name || "").toLowerCase();
    const open = !!opts.detailsOpen;
    const typeLine = !pastesCode(name) && isTouch();
    return `<div class="alp" data-alp-phase="starting">
      <p class="alp-status" role="status" aria-live="polite"><span class="aspin aspin-xs" aria-hidden="true"></span><span class="alp-status-t">${escHtml(model().status("connecting"))}</span></p>
      <div class="alp-link" hidden>
        <a class="alp-open btn btn-solid" target="_blank" rel="noopener">Open ${label} sign-in</a>
        <button class="linkbtn-quiet" type="button" data-alp-copy="link">Copy link</button>
      </div>
      <div class="alp-code" hidden>
        <span class="alp-code-lbl" id="${id}-code-lbl">Enter this code on the sign-in page</span>
        <span class="alp-code-row"><output class="alp-code-val" aria-labelledby="${id}-code-lbl"></output>
        <button class="btn" type="button" data-alp-copy="code">Copy</button></span>
      </div>
      ${pastesCode(name) ? pasteFormHtml(`${id}-paste`, `Paste the code ${label} shows you`, "Paste code", "alp-paste") : ""}
      ${SELF_REPORT_PROVIDERS.has(name) ? `<button class="btn alp-done" type="button" data-alp-done hidden>I've signed in</button>` : ""}
      <div class="alp-more">
        <button class="linkbtn-quiet alp-more-btn" type="button" aria-expanded="${open}" aria-controls="${id}-details">${open ? "Hide details" : "Show details"}</button>
      </div>
      <div class="alp-details${open ? " is-open" : ""}" id="${id}-details">
        <div class="alp-details-in">
          <div class="alp-term"></div>
          ${typeLine ? pasteFormHtml(`${id}-type`, "Type into the sign-in", "Text to send", "alp-type") : ""}
          ${model().providerHintHtml(name)}
        </div>
      </div>
    </div>`;
  }

  function pasteFormHtml(id: string, label: string, placeholder: string, cls: string): string {
    return `<form class="alp-paste ${cls}"${cls === "alp-paste" ? " hidden" : ""} novalidate>
      <label class="alp-paste-lbl" for="${id}">${escHtml(label)}</label>
      <span class="alp-paste-row">
        <input class="alp-paste-in" id="${id}" type="text" autocomplete="one-time-code" autocapitalize="off"
          autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="${escAttr(placeholder)}">
        <button class="btn btn-solid alp-paste-send" type="submit">Send</button>
      </span>
    </form>`;
  }

  function mount(host: HTMLElement, opts: AgentLoginPanelOptions): AgentLoginPanelHandle {
    const id = `alp${++seq}`;
    const label = String(opts.label || opts.name);
    host.innerHTML = panelHtml(opts, id);
    const root = host.querySelector<HTMLElement>(".alp");
    const q = <T extends Element>(sel: string): T | null => (root ? root.querySelector<T>(sel) : null);
    const statusEl = q<HTMLElement>(".alp-status");
    const statusText = q<HTMLElement>(".alp-status-t");
    const linkRow = q<HTMLElement>(".alp-link");
    const openLink = q<HTMLAnchorElement>(".alp-open");
    const codeRow = q<HTMLElement>(".alp-code");
    const codeVal = q<HTMLElement>(".alp-code-val");
    const pasteForm = q<HTMLFormElement>("form.alp-paste:not(.alp-type)");
    const doneBtn = q<HTMLButtonElement>("[data-alp-done]");
    const moreBtn = q<HTMLButtonElement>(".alp-more-btn");
    const details = q<HTMLElement>(".alp-details");
    const termHost = q<HTMLElement>(".alp-term");

    let closed = false;
    let phase: PanelPhase = "starting";
    let url = "";
    let code = "";
    let handle: AgentLoginSessionHandle | null = null;

    const setPhase = (next: PanelPhase, text: string, busy = false): void => {
      phase = next;
      root?.setAttribute("data-alp-phase", next);
      if (statusText) statusText.textContent = text;
      const spin = statusEl?.querySelector(".aspin");
      if (busy && !spin) statusEl?.insertAdjacentHTML("afterbegin", `<span class="aspin aspin-xs" aria-hidden="true"></span>`);
      if (!busy) spin?.remove();
      statusEl?.classList.toggle("is-ok", next === "connected");
      statusEl?.classList.toggle("is-err", next === "failed");
    };

    const linkStatus = (): string => {
      if (code) return `Open the ${label} sign-in and enter the code below. This page notices when you're done.`;
      if (pastesCode(opts.name)) return `Open the ${label} sign-in, approve it, then paste the code it shows you.`;
      if (SELF_REPORT_PROVIDERS.has(String(opts.name).toLowerCase())) return `Open the ${label} sign-in and approve it.`;
      return `Open the ${label} sign-in and approve it. This page notices when you're done.`;
    };

    const onEvent = (event: AgentLoginEvent): void => {
      if (closed) return;
      switch (event.t) {
        case "status":
          if (phase === "starting" || phase === "waiting") {
            setPhase(event.key === "ready" ? "waiting" : "starting", model().status(event.key), true);
          }
          break;
        case "link":
          url = event.url;
          if (openLink) openLink.href = url; // a DOM property, never markup
          if (linkRow) linkRow.hidden = false;
          if (pasteForm) pasteForm.hidden = false;
          if (doneBtn) doneBtn.hidden = false;
          if (phase !== "pasted" && phase !== "connected" && phase !== "failed") setPhase("link", linkStatus());
          break;
        case "code":
          code = event.code;
          if (codeVal) codeVal.textContent = code;
          if (codeRow) codeRow.hidden = false;
          if (phase === "link" || phase === "waiting" || phase === "starting") setPhase("link", linkStatus());
          break;
        case "connected":
          setPhase("connected", `Signed in to ${label}`);
          opts.onConnected?.();
          break;
        case "busy":
          setPhase("failed", event.message);
          opts.onBusy?.(event.message);
          break;
        case "failed":
          setPhase("failed", event.message);
          opts.onFailed?.(event.message, event.reason);
          break;
      }
    };

    const copy = async (btn: HTMLButtonElement, value: string, idle: string): Promise<void> => {
      if (!value) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(value);
        ok = true;
      } catch {}
      btn.textContent = ok ? "Copied" : "Copy didn't work";
      setTimeout(() => {
        if (btn.isConnected) btn.textContent = idle;
      }, 1600);
    };

    root?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const copyBtn = target?.closest<HTMLButtonElement>("[data-alp-copy]");
      if (copyBtn) {
        const which = copyBtn.dataset.alpCopy;
        void copy(copyBtn, which === "code" ? code : url, which === "code" ? "Copy" : "Copy link");
        return;
      }
      if (target?.closest(".alp-more-btn") && moreBtn && details) {
        const open = !details.classList.contains("is-open");
        details.classList.toggle("is-open", open);
        moreBtn.setAttribute("aria-expanded", String(open));
        moreBtn.textContent = open ? "Hide details" : "Show details";
        return;
      }
      if (target?.closest("[data-alp-done]")) {
        setPhase("connected", `Signed in to ${label}`);
        opts.onConnected?.();
      }
    });
    root?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      const input = form?.querySelector<HTMLInputElement>(".alp-paste-in");
      if (!input) return;
      const sent = handle?.send(input.value) ?? false;
      if (!sent) return;
      input.value = "";
      if (form === pasteForm) setPhase("pasted", "Checking the code…", true);
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        handle?.close();
      } catch {}
      handle = null;
    };

    const api = session();
    if (!api || !termHost) {
      setPhase("failed", model().status("terminalLoadError"));
      opts.onFailed?.(model().status("terminalLoadError"), "terminal");
      return { close };
    }
    void api
      .start(opts.name, { termHost, alive: () => !closed && host.isConnected, emit: onEvent })
      .then((h) => {
        if (closed) h?.close();
        else handle = h;
      });
    return { close };
  }

  const CAIRN_AGENT_LOGIN_PANEL: AgentLoginPanelApi = { mount, pastesCode };

  Object.assign(globalThis, { CairnAgentLoginPanel: CAIRN_AGENT_LOGIN_PANEL });
})();
