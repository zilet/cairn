// @ts-check
// Chat header controls: history/search and fresh-start archive/distill flow.

(() => {
  function headerControllerRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  function headerControllerHtml<T extends HTMLElement = HTMLElement>(value: Element | null | undefined): T | null {
    return value instanceof HTMLElement ? (value as T) : null;
  }

  function settleFreshPill(distilled: unknown, token: number, deps: ChatHeaderControllerDeps): void {
    if (token !== deps.currentToken() || deps.state.tab !== "chat") return;
    const host = document.getElementById("hdrChatActions");
    if (!host) return;
    const n = Number(distilled) || 0;
    host.querySelector(".fresh-pill")?.remove();
    const pill = document.createElement("span");
    pill.className = "fresh-pill";
    pill.innerHTML = CairnChatClient.freshPillHtml(n);
    host.prepend(pill);
    requestAnimationFrame(() => pill.classList.add("fresh-pill-in"));
    setTimeout(() => {
      pill.classList.remove("fresh-pill-in");
      setTimeout(() => pill.remove(), 360);
    }, 2600);
  }

  async function chatFreshStart(deps: ChatHeaderControllerDeps): Promise<void> {
    const log = document.getElementById("chatlog");
    if (!log || deps.state.tab !== "chat") return;
    const token = deps.currentToken(); // any full re-render bumps this -- treat as stale
    const fresh = document.getElementById("hdrFresh");
    if (fresh) fresh.hidden = true; // the thread is empty now

    // Optimistic clear -- empty state + chips, composer stays fully enabled & focused.
    deps.clearFuelContext();
    deps.drawEmptyChat();
    const fuelSlot = document.getElementById("chatFuelSlot");
    if (fuelSlot) fuelSlot.innerHTML = "";
    const input = document.getElementById("chatInput");
    if (input instanceof HTMLTextAreaElement && matchMedia("(hover:hover)").matches) input.focus();

    let r: Record<string, unknown> | null = null;
    try {
      r = headerControllerRecord(await deps.enqueueJob("/chat/reset", {}));
    } catch {
      /* the archive happens server-side; a blip just means no pill */
      return;
    }
    if (token !== deps.currentToken() || deps.state.tab !== "chat") return;

    // Compatibility with an older server that returned the distilled count inline.
    if (!r || !r.distilling) {
      settleFreshPill(r && r.ok ? r.distilled : 0, token, deps);
      return;
    }

    // Current server: stream the durable distill job; settle the pill on done. The job lives
    // server-side, so it survives a reload (a re-render's chatReconnect leaves the
    // turn stream alone; this pill is best-effort and simply won't reappear).
    const distilling = r.distilling;
    if (typeof distilling !== "string" && typeof distilling !== "number") return;
    deps.openJobStream(distilling, {
      guard: () => deps.state.tab !== "chat" || token !== deps.currentToken(),
      onDone: (result) => {
        const row = headerControllerRecord(result);
        settleFreshPill(row.ok ? row.distilled : 0, token, deps);
      },
      onError: () => {},
      onCanceled: () => {},
    });
  }

  function ensureChatHeaderBtns(deps: ChatHeaderControllerDeps): ChatScreenHeaderButtons {
    document.getElementById("hdrChatActions")?.remove();
    const template = document.createElement("template");
    template.innerHTML = CairnChatClient.headerActionsHtml().trim();
    const wrap = template.content.firstElementChild;
    const hist = headerControllerHtml(wrap?.querySelector("#hdrHistory"));
    const b = headerControllerHtml(wrap?.querySelector("#hdrFresh"));
    if (!wrap || !hist || !b) return { freshBtn: null, historyBtn: null };
    hist.addEventListener("click", () => deps.openChatHistory());

    // fresh start (sparkle, two-tap confirm) -- unchanged behavior.
    let disarm = 0;
    b.addEventListener("click", () => {
      if (!b.classList.contains("armed")) {
        b.classList.add("armed");
        clearTimeout(disarm);
        disarm = window.setTimeout(() => b.classList.remove("armed"), 4000);
        return;
      }
      clearTimeout(disarm);
      b.classList.remove("armed");
      void chatFreshStart(deps);
    });

    document.querySelector("header")!.appendChild(wrap);
    return { freshBtn: b, historyBtn: hist };
  }

  const CAIRN_CHAT_HEADER_CONTROLLER = {
    ensureChatHeaderBtns,
    chatFreshStart,
    settleFreshPill,
  };

  Object.assign(globalThis, { CairnChatHeaderController: CAIRN_CHAT_HEADER_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnChatHeaderController = CAIRN_CHAT_HEADER_CONTROLLER;
  }
})();
