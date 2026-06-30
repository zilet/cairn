// @ts-check
// ==== chat-history-client.js ====
// Read-only chat history/search overlay for the Chat surface.

type ChatHistoryMessage = import("../contracts/client.js").ClientChatMessage & Record<string, unknown>;
type ChatHistoryCompat = {
  chatDayISO?: (timestamp: unknown) => string;
  chatDivider?: (iso: string) => Element | null;
  appendMsg?: (
    message: Partial<ChatHistoryMessage> | Record<string, unknown>,
    noScroll?: boolean,
    parent?: Element | null,
    opts?: { readonly?: boolean },
  ) => Element | null;
  openChatHistory?: (options?: { session?: string | null }) => void;
};

(() => {
const root = globalThis as unknown as ChatHistoryCompat;

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    : [];
}

function chatDay(timestamp: unknown): string {
  return root.chatDayISO ? root.chatDayISO(timestamp) : CairnChatClient.dayISO(timestamp, localISO);
}

function historyDivider(iso: string): Element {
  const existing = root.chatDivider?.(iso);
  if (existing) return existing;
  const template = document.createElement("template");
  template.innerHTML = CairnChatClient.dividerHtml(iso, dateLabel(iso)).trim();
  const el = template.content.firstElementChild;
  if (el) return el;
  const fallback = document.createElement("div");
  fallback.className = "chat-divider";
  fallback.dataset.day = iso;
  fallback.textContent = dateLabel(iso);
  return fallback;
}

function appendHistoryMessage(message: Record<string, unknown>, host: Element): void {
  root.appendMsg?.(message, true, host, { readonly: true });
}

function histWhen(timestamp: unknown): string {
  return humanDate(chatDay(timestamp));
}

function histSessionRow(session: Record<string, unknown>): string {
  return CairnChatClient.historySessionRow(session, histWhen(session.ended_at));
}

function histHitRow(hit: Record<string, unknown>, query: string): string {
  return CairnChatClient.historyHitRow(hit, query, histWhen(hit.created_at));
}

// Open the read-only history/search overlay. The detail scaffold owns close on
// Escape/backdrop/tab switch; this module owns only the data reads and view state.
function openChatHistory(options: { session?: string | null } = {}): void {
  const detail = mountDetail(`
    <div class="chat-hist">
      <h2 class="detail-title">Conversations</h2>
      <div class="chat-hist-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="chatHistSearch" type="search" placeholder="Search every conversation…" autocomplete="off" autocapitalize="off">
      </div>
      <div id="chatHistBody" class="chat-hist-body"></div>
    </div>`);
  const body = detail.querySelector<HTMLElement>("#chatHistBody");
  const searchInput = detail.querySelector<HTMLInputElement>("#chatHistSearch");
  if (!body || !searchInput) return;

  const renderSessions = async (): Promise<void> => {
    body.innerHTML = loadingState("Gathering your conversations…");
    let sessions: Record<string, unknown>[] = [];
    try { sessions = asRows(await api("/chat/sessions")); } catch { sessions = []; }
    if (!detail.isConnected || searchInput.value.trim()) return;
    if (!sessions.length) {
      body.innerHTML = `<div class="empty">No past conversations yet.<br>Start one, and a “fresh start” will tuck it here.</div>`;
      return;
    }
    body.innerHTML = `<div class="chat-hist-list">${sessions.map(histSessionRow).join("")}</div>`;
    body.querySelectorAll<HTMLElement>("[data-session]").forEach((el) =>
      el.addEventListener("click", () => openConversation(el.dataset.session || "", { syncRoute: true })));
  };

  const runSearch = async (query: string): Promise<void> => {
    body.innerHTML = loadingState("Searching…");
    let hits: Record<string, unknown>[] = [];
    try { hits = asRows(await api("/chat/search?q=" + encodeURIComponent(query))); } catch { hits = []; }
    if (!detail.isConnected || searchInput.value.trim() !== query) return;
    if (!hits.length) {
      body.innerHTML = `<div class="empty">No matches for “${escHtml(query)}”.</div>`;
      return;
    }
    body.innerHTML = `<div class="chat-hist-list">${hits.map((hit) => histHitRow(hit, query)).join("")}</div>`;
    body.querySelectorAll<HTMLElement>("[data-open]").forEach((el) => el.addEventListener("click", () => {
      const session = el.dataset.open || "";
      if (session === "live") { closeDetail(); toast("In your current conversation"); return; }
      openConversation(session, { syncRoute: true });
    }));
  };

  const openConversation = async (sessionId: string | null | undefined, opts: { syncRoute?: boolean } = {}): Promise<void> => {
    if (!sessionId) return;
    if (opts.syncRoute) {
      state.pendingChatSession = sessionId;
      if (typeof syncRouteFromState === "function") syncRouteFromState();
    }
    body.innerHTML = loadingState("Opening…");
    let messages: Record<string, unknown>[] = [];
    try { messages = asRows(await api("/chat/sessions/" + encodeURIComponent(sessionId))); } catch { messages = []; }
    if (!detail.isConnected) return;
    body.innerHTML = `<button class="chat-hist-back">← All conversations</button><div id="chatHistConvo" class="chatlog chat-hist-convo"></div>`;
    body.querySelector(".chat-hist-back")?.addEventListener("click", () => {
      state.pendingChatSession = null;
      if (typeof syncRouteFromState === "function") syncRouteFromState();
      searchInput.value = "";
      void renderSessions();
    });
    const conversation = body.querySelector<HTMLElement>("#chatHistConvo");
    if (!conversation) return;
    let lastDay: string | null = null;
    for (const message of messages) {
      const day = chatDay(message.created_at);
      if (day !== lastDay) {
        conversation.appendChild(historyDivider(day));
        lastDay = day;
      }
      appendHistoryMessage(message, conversation);
    }
  };

  let searchTimer = 0;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    if (!query) { void renderSessions(); return; }
    searchTimer = window.setTimeout(() => { void runSearch(query); }, 250);
  });

  if (options.session) void openConversation(options.session);
  else void renderSessions();
}

Object.assign(globalThis, { openChatHistory });

if (typeof window !== "undefined") {
  (window as unknown as ChatHistoryCompat).openChatHistory = openChatHistory;
}
})();
