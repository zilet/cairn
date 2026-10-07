// @ts-check
// The friendly sign-in panel: what a person sees while an AI provider's sign-in runs.
//
// It never looks like a terminal. The session (agent-login-session-client.ts) reports
// what the CLI printed, and this panel turns it into ordinary controls:
//   - the sign-in link → one primary button, "Open <Provider> sign-in" (+ Copy link);
//   - a device code    → shown large, with Copy;
//   - a provider that hands back a code to paste (Claude, Google) → "Paste the code
//     <Provider> shows you", sent to the CLI as if typed;
//   - the raw terminal → folded under "Show details".
// Google's sign-in (agy print mode) gives up after a fixed minute, so its CLI starts on
// the person's tap — never on render — and a window that closed offers a fresh one.
// The Settings → Agents modal and the welcome's Connect step both host it.

(() => {
  type PanelPhase = "idle" | "starting" | "waiting" | "link" | "pasted" | "connected" | "failed";

  // Providers whose sign-in page shows a code the person pastes back here.
  const PASTE_PROVIDERS = new Set(["claude", "antigravity"]);
  // Providers whose CLI waits only a fixed few seconds for that code (agy: 60), so the
  // sign-in starts when the person taps Open, never when the panel renders.
  const TAP_TO_START: Record<string, number> = { antigravity: 60 };

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

  function tapWindow(name: string): number {
    return TAP_TO_START[String(name || "").toLowerCase()] || 0;
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
    const tap = tapWindow(name) > 0;
    const typeLine = !pastesCode(name) && isTouch();
    const status = tap
      ? `<span class="alp-status-t">${escHtml(`When you tap Open, the ${opts.label} sign-in opens in a new tab. Approve it there, then paste the code it shows you back here.`)}</span>`
      : `<span class="aspin aspin-xs" aria-hidden="true"></span><span class="alp-status-t">${escHtml(model().status("connecting"))}</span>`;
    return `<div class="alp" data-alp-phase="${tap ? "idle" : "starting"}">
      <p class="alp-status" role="status" aria-live="polite">${status}</p>
      <div class="alp-link"${tap ? "" : " hidden"}>
        ${tap ? `<button class="alp-open btn btn-solid" type="button" data-alp-launch>Open ${label} sign-in</button>` : ""}
        <a class="alp-open btn btn-solid" target="_blank" rel="noopener"${tap ? " hidden" : ""}>Open ${label} sign-in</a>
        <button class="linkbtn-quiet" type="button" data-alp-copy="link"${tap ? " hidden" : ""}>Copy link</button>
      </div>
      <div class="alp-code" hidden>
        <span class="alp-code-lbl" id="${id}-code-lbl">Enter this code on the sign-in page</span>
        <span class="alp-code-row"><output class="alp-code-val" aria-labelledby="${id}-code-lbl"></output>
        <button class="btn" type="button" data-alp-copy="code">Copy</button></span>
      </div>
      ${pastesCode(name) ? pasteFormHtml(`${id}-paste`, `Paste the code ${opts.label} shows you`, "Paste code", "alp-paste", tap ? "Sign in" : "Send") : ""}
      ${tap ? `<p class="alp-hint" hidden>${escHtml(`${opts.label} gives you about a minute.`)} <span class="alp-left"></span></p>` : ""}
      <div class="alp-more">
        <button class="linkbtn-quiet alp-more-btn" type="button" aria-expanded="${open}" aria-controls="${id}-details">${open ? "Hide details" : "Show details"}</button>
      </div>
      <div class="alp-details${open ? " is-open" : ""}" id="${id}-details">
        <div class="alp-details-in">
          <div class="alp-term"></div>
          ${typeLine ? pasteFormHtml(`${id}-type`, "Type into the sign-in", "Text to send", "alp-type", "Send") : ""}
          ${model().providerHintHtml(name)}
        </div>
      </div>
    </div>`;
  }

  function pasteFormHtml(id: string, label: string, placeholder: string, cls: string, submit: string): string {
    return `<form class="alp-paste ${cls}"${cls === "alp-paste" ? " hidden" : ""} novalidate>
      <label class="alp-paste-lbl" for="${id}">${escHtml(label)}</label>
      <span class="alp-paste-row">
        <input class="alp-paste-in" id="${id}" type="text" autocomplete="one-time-code" autocapitalize="off"
          autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="${escAttr(placeholder)}">
        <button class="btn btn-solid alp-paste-send" type="submit">${escHtml(submit)}</button>
      </span>
    </form>`;
  }

  function mount(host: HTMLElement, opts: AgentLoginPanelOptions): AgentLoginPanelHandle {
    const id = `alp${++seq}`;
    const label = String(opts.label || opts.name);
    const tapSeconds = tapWindow(opts.name);
    host.innerHTML = panelHtml(opts, id);
    const root = host.querySelector<HTMLElement>(".alp");
    const q = <T extends Element>(sel: string): T | null => (root ? root.querySelector<T>(sel) : null);
    const statusEl = q<HTMLElement>(".alp-status");
    const linkRow = q<HTMLElement>(".alp-link");
    const launchBtn = q<HTMLButtonElement>("[data-alp-launch]");
    const openLink = q<HTMLAnchorElement>("a.alp-open");
    const copyLink = q<HTMLButtonElement>('[data-alp-copy="link"]');
    const codeRow = q<HTMLElement>(".alp-code");
    const codeVal = q<HTMLElement>(".alp-code-val");
    const pasteForm = q<HTMLFormElement>("form.alp-paste:not(.alp-type)");
    const hint = q<HTMLElement>(".alp-hint");
    const left = q<HTMLElement>(".alp-left");
    const moreBtn = q<HTMLButtonElement>(".alp-more-btn");
    const details = q<HTMLElement>(".alp-details");
    const termHost = q<HTMLElement>(".alp-term");

    let closed = false;
    let phase: PanelPhase = tapSeconds ? "idle" : "starting";
    let url = "";
    let code = "";
    let handle: AgentLoginSessionHandle | null = null;
    // Which session's events still count: a closed window's late frames never repaint
    // the fresh one.
    let generation = 0;
    // The tab opened blank inside the tap, pointed at the sign-in once its link arrives.
    let pendingTab: Window | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;

    const setPhase = (next: PanelPhase, text: string, busy = false): void => {
      phase = next;
      root?.setAttribute("data-alp-phase", next);
      const statusText = statusEl?.querySelector(".alp-status-t");
      if (statusText) statusText.textContent = text;
      const spin = statusEl?.querySelector(".aspin");
      if (busy && !spin) statusEl?.insertAdjacentHTML("afterbegin", `<span class="aspin aspin-xs" aria-hidden="true"></span>`);
      if (!busy) spin?.remove();
      statusEl?.classList.toggle("is-ok", next === "connected");
      statusEl?.classList.toggle("is-err", next === "failed");
    };

    const linkStatus = (navigated: boolean): string => {
      if (code) return `Open the ${label} sign-in and enter the code below. This page notices when you're done.`;
      if (tapSeconds) {
        return navigated
          ? `Approve it in the ${label} tab, then paste the code it shows you here.`
          : `Open the ${label} sign-in, approve it, then paste the code it shows you here.`;
      }
      if (pastesCode(opts.name)) return `Open the ${label} sign-in, approve it, then paste the code it shows you.`;
      return `Open the ${label} sign-in and approve it. This page notices when you're done.`;
    };

    const stopTicker = (): void => {
      if (ticker !== null && typeof clearInterval === "function") clearInterval(ticker);
      ticker = null;
    };

    // A quiet count of the CLI's own wait, so the code goes in before the window shuts.
    const startTicker = (): void => {
      stopTicker();
      if (!hint || !left) return;
      hint.hidden = false;
      const deadline = Date.now() + tapSeconds * 1000;
      const paint = (): void => {
        const secs = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        left.textContent = secs > 0 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} left` : "Nearly out of time.";
        if (!secs) stopTicker();
      };
      paint();
      if (typeof setInterval === "function") ticker = setInterval(paint, 1000);
    };

    const dropTab = (): void => {
      // Only a tab still blank is ours to close; one showing the sign-in is the person's.
      try { pendingTab?.close(); } catch {}
      pendingTab = null;
    };

    const onEvent = (event: AgentLoginEvent): void => {
      if (closed) return;
      switch (event.t) {
        case "status":
          if (phase === "starting" || phase === "waiting") {
            setPhase(event.key === "ready" ? "waiting" : "starting", model().status(event.key), true);
          }
          break;
        case "link": {
          url = event.url;
          let navigated = false;
          if (pendingTab) {
            try {
              if (!pendingTab.closed) {
                pendingTab.location.href = url;
                navigated = true;
              }
            } catch {}
            pendingTab = null;
          }
          if (openLink) {
            openLink.href = url; // a DOM property, never markup
            openLink.hidden = false;
            // The tab already shows the sign-in: reopening it is a quiet second choice.
            openLink.classList.toggle("btn", !navigated);
            openLink.classList.toggle("btn-solid", !navigated);
            openLink.classList.toggle("linkbtn-quiet", navigated);
            if (navigated) openLink.textContent = "Open it again";
          }
          if (copyLink) copyLink.hidden = false;
          if (linkRow) linkRow.hidden = false;
          if (pasteForm) pasteForm.hidden = false;
          if (tapSeconds && phase !== "link") startTicker();
          if (phase !== "pasted" && phase !== "connected" && phase !== "failed") setPhase("link", linkStatus(navigated));
          break;
        }
        case "code":
          code = event.code;
          if (codeVal) codeVal.textContent = code;
          if (codeRow) codeRow.hidden = false;
          if (phase === "link" || phase === "waiting" || phase === "starting") setPhase("link", linkStatus(false));
          break;
        case "connected":
          stopTicker();
          setPhase("connected", `Signed in to ${label}`);
          opts.onConnected?.();
          break;
        case "busy":
          stopTicker();
          dropTab();
          setPhase("failed", event.message);
          opts.onBusy?.(event.message);
          break;
        case "failed":
          stopTicker();
          dropTab();
          if (tapSeconds && event.reason === "expired") {
            rearm();
            break;
          }
          setPhase("failed", event.message);
          opts.onFailed?.(event.message, event.reason);
          break;
      }
    };

    // The CLI gave up waiting: its link and code are dead. Calmly offer a fresh one.
    function rearm(): void {
      try { handle?.close(); } catch {}
      handle = null;
      generation += 1;
      url = "";
      if (openLink) openLink.hidden = true;
      if (copyLink) copyLink.hidden = true;
      if (pasteForm) pasteForm.hidden = true;
      if (hint) hint.hidden = true;
      if (launchBtn) launchBtn.hidden = false;
      if (linkRow) linkRow.hidden = false;
      setPhase("idle", "That sign-in window closed. Open a fresh one when you're ready.");
    }

    const start = (): void => {
      const api = session();
      if (!api || !termHost) {
        setPhase("failed", model().status("terminalLoadError"));
        opts.onFailed?.(model().status("terminalLoadError"), "terminal");
        return;
      }
      const mine = ++generation;
      void api
        .start(opts.name, { termHost, alive: () => !closed && mine === generation && host.isConnected, emit: (e) => { if (mine === generation) onEvent(e); } })
        .then((h) => {
          if (closed || mine !== generation) h?.close();
          else handle = h;
        });
    };

    // The tap that starts a tap-to-start sign-in. iOS Safari opens a tab only inside
    // the tap itself — never after an await — so the tab opens blank NOW and is pointed
    // at the sign-in once the CLI prints its link; with no tab, the link button shows.
    const launch = (): void => {
      if (closed || handle || phase === "starting" || phase === "waiting") return;
      pendingTab = null;
      try { pendingTab = window.open("", "_blank"); } catch {}
      try { if (pendingTab) pendingTab.opener = null; } catch {}
      url = "";
      if (launchBtn) launchBtn.hidden = true;
      if (linkRow) linkRow.hidden = true;
      setPhase("starting", model().status("connecting"), true);
      start();
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
      if (target?.closest("[data-alp-launch]")) {
        launch();
        return;
      }
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
      if (form !== pasteForm) return;
      stopTicker();
      if (hint) hint.hidden = true;
      setPhase("pasted", "Checking the code…", true);
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      stopTicker();
      dropTab();
      try {
        handle?.close();
      } catch {}
      handle = null;
    };

    if (!tapSeconds) start();
    return { close };
  }

  const CAIRN_AGENT_LOGIN_PANEL: AgentLoginPanelApi = { mount, pastesCode };

  Object.assign(globalThis, { CairnAgentLoginPanel: CAIRN_AGENT_LOGIN_PANEL });
})();
