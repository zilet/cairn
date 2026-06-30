// @ts-check
// ==== chat-turn-client.js ====
// Durable chat turns: queue monitor, SSE streaming markdown, cancellation,
// reconnect, jump-to-latest, draft storage, and chat viewport sizing.

type ChatTurnRecord = Record<string, unknown>;
type ChatTurn = ChatTurnRecord & {
  id: number;
  status?: string;
  phase?: string | null;
  image_url?: string | null;
  user_message_id?: number | string | null;
  reply?: string | null;
  error?: string | null;
  meta?: { drafts?: unknown[]; [key: string]: unknown } | null;
  finished_at?: string | null;
  assistant_message_id?: number | string | null;
};
type ChatMessage = import("../contracts/client.js").ClientChatMessage & Record<string, unknown>;
type ChatTurnRoot = typeof globalThis & {
  appendMsg?: (message: Partial<ChatMessage> | ChatTurnRecord, noScroll?: boolean, parent?: Element | null, opts?: ChatTurnRecord) => Element | null;
  rememberChatFuelContext?: (...messages: unknown[]) => unknown;
  loadChatFuel?: (token: number, messages?: unknown[]) => Promise<void>;
};

(() => {
const CHAT_DRAFT_KEY = "cairn.chat.draft";
const root = globalThis as ChatTurnRoot;

let chatStream: EventSource | null = null;
let chatStreamId: number | null = null;
const chatPendingBubbles = new Map<number, HTMLElement>();
const chatStreamText = new Map<number, string>();
const chatStreamRenderQueued = new Set<number>();
const chatStreamRenderVersion = new Map<number, number>();
const chatDoneTurns = new Set<number>();

function chatTurnRecord(value: unknown): ChatTurnRecord {
  return value && typeof value === "object" ? value as ChatTurnRecord : {};
}

function chatTurnRows(value: unknown): ChatTurn[] {
  return Array.isArray(value)
    ? value.filter((row) => !!row && typeof row === "object" && Number.isFinite(Number((row as ChatTurnRecord).id))) as ChatTurn[]
    : [];
}

function turnId(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTurnEvent(event: Event): ChatTurnRecord | null {
  const data = (event as MessageEvent).data;
  if (typeof data !== "string" || !data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return chatTurnRecord(parsed);
  } catch {
    return null;
  }
}

function saveChatDraft(value: string): void {
  try {
    value ? localStorage.setItem(CHAT_DRAFT_KEY, value) : localStorage.removeItem(CHAT_DRAFT_KEY);
  } catch {}
}

function loadChatDraft(): string {
  try { return localStorage.getItem(CHAT_DRAFT_KEY) || ""; } catch { return ""; }
}

function chatPhaseCaption(turn: ChatTurn | null | undefined): string {
  if (!turn) return "Thinking…";
  if (turn.status === "queued") return "Queued";
  if (turn.phase === "applying") return "Saving…";
  return turn.image_url ? "Reading your plate…" : "Thinking…";
}

function makePendingBubble(turn: ChatTurn): HTMLElement {
  const el = document.createElement("div");
  el.className = "bubble assistant pending bubble-in";
  el.setAttribute("role", "status");
  el.setAttribute("aria-busy", "true");
  el.dataset.turn = String(turn.id);
  const cap = chatPhaseCaption(turn);
  el.innerHTML = `<div class="bubble-text"><span class="typing-cap">${escHtml(cap)} </span>` +
    `<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>` +
    `<button class="turn-stop" type="button" aria-label="Stop this turn">Stop</button></div>`;
  el.querySelector(".turn-stop")?.addEventListener("click", () => cancelTurn(turn.id));
  return el;
}

function setPendingCaption(el: Element | null | undefined, text: unknown): void {
  const cap = el?.querySelector(".typing-cap");
  if (!(cap instanceof HTMLElement)) return;
  cap.textContent = `${String(text || "").trim() || "Thinking…"} `;
  if (!reducedMotion()) {
    cap.style.animation = "none";
    void cap.offsetWidth;
    cap.style.animation = "";
  }
}

function ensureStreamingBubble(id: number): HTMLElement | null {
  const el = chatPendingBubbles.get(id);
  if (!el || !el.isConnected) return null;
  if (!el.classList.contains("streaming")) {
    el.classList.remove("pending");
    el.removeAttribute("aria-busy");
    el.classList.add("streaming");
    el.innerHTML =
      `<div class="bubble-text md stream-text"></div>` +
      `<button class="turn-stop" type="button" aria-label="Stop this turn">Stop</button>`;
    el.querySelector(".turn-stop")?.addEventListener("click", () => cancelTurn(id));
  }
  return el;
}

function renderStreamMarkdown(id: number): void {
  const el = chatPendingBubbles.get(id);
  if (!el || !el.isConnected || !el.classList.contains("streaming") || !chatStreamText.has(id)) return;
  const body = el.querySelector(".stream-text");
  if (!(body instanceof HTMLElement)) return;
  body.innerHTML = mdToHtml(chatStreamText.get(id) || "");
  const caret = document.createElement("span");
  caret.className = "stream-caret";
  caret.setAttribute("aria-hidden", "true");
  const last = body.lastElementChild;
  const inlineish = last && /^(P|H3|H4|H5|H6|LI|BLOCKQUOTE)$/i.test(last.tagName);
  (inlineish ? last : body).appendChild(caret);
}

function scheduleStreamMarkdown(id: number): void {
  if (chatStreamRenderQueued.has(id)) return;
  const version = chatStreamRenderVersion.get(id) || 0;
  chatStreamRenderQueued.add(id);
  requestAnimationFrame(() => {
    chatStreamRenderQueued.delete(id);
    if ((chatStreamRenderVersion.get(id) || 0) !== version) return;
    renderStreamMarkdown(id);
  });
}

function appendStreamDelta(id: number, text: unknown): void {
  const chunk = typeof text === "string" ? text : "";
  if (!chunk) return;
  const el = ensureStreamingBubble(id);
  if (!el) return;
  chatStreamText.set(id, (chatStreamText.get(id) || "") + chunk);
  scheduleStreamMarkdown(id);
  const log = $<HTMLElement>("#chatlog");
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 200) log.scrollTop = log.scrollHeight;
}

function setTurnProgress(id: number, text: unknown): void {
  const el = chatPendingBubbles.get(id);
  if (!el || !el.isConnected || el.classList.contains("streaming")) return;
  const clean = String(text || "").trim();
  if (clean) setPendingCaption(el, clean);
}

function resetStreamingBubble(id: number): void {
  chatStreamText.delete(id);
  chatStreamRenderQueued.delete(id);
  chatStreamRenderVersion.set(id, (chatStreamRenderVersion.get(id) || 0) + 1);
  const el = chatPendingBubbles.get(id);
  if (!el || !el.isConnected) return;
  el.classList.remove("streaming");
  el.classList.add("pending");
  el.setAttribute("aria-busy", "true");
  el.innerHTML =
    `<div class="bubble-text"><span class="typing-cap">Thinking… </span>` +
    `<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>` +
    `<button class="turn-stop" type="button" aria-label="Stop this turn">Stop</button></div>`;
  el.querySelector(".turn-stop")?.addEventListener("click", () => cancelTurn(id));
}

function findChatMessageAnchor(log: HTMLElement, messageId: unknown): HTMLElement | null {
  const wanted = String(messageId || "");
  if (!wanted) return null;
  for (const candidate of log.querySelectorAll<HTMLElement>("[data-mid]")) {
    if (candidate.dataset.mid === wanted) return candidate;
  }
  return null;
}

function spawnPendingBubble(turnValue: unknown): HTMLElement | null {
  const row = chatTurnRecord(turnValue);
  const id = turnId(row.id);
  if (id == null) return null;
  const turn = row as ChatTurn;
  const log = $<HTMLElement>("#chatlog");
  if (!log) return null;
  if (chatPendingBubbles.has(id)) return chatPendingBubbles.get(id) || null;
  const el = makePendingBubble({ ...turn, id });
  const anchor = findChatMessageAnchor(log, turn.user_message_id);
  if (anchor && anchor.parentElement === log) anchor.after(el);
  else log.appendChild(el);
  chatPendingBubbles.set(id, el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function appendFinalMessage(message: Partial<ChatMessage> | ChatTurnRecord, before: Element | null | undefined): void {
  root.appendMsg?.(message, false, null, { before: before || null });
}

function finalizeTurn(turnValue: unknown, messageValue?: unknown): void {
  const row = chatTurnRecord(turnValue);
  const id = turnId(row.id);
  if (id != null) {
    if (chatDoneTurns.has(id)) return;
    chatDoneTurns.add(id);
  }
  const el = id == null ? null : chatPendingBubbles.get(id);
  if (id != null) {
    chatPendingBubbles.delete(id);
    chatStreamText.delete(id);
  }
  const message = messageValue && typeof messageValue === "object"
    ? messageValue as ChatTurnRecord
    : {
        role: "assistant",
        content: (typeof row.reply === "string" && row.reply) || (typeof row.error === "string" && row.error) || "(no reply)",
        meta: row.meta,
        created_at: row.finished_at,
        id: row.assistant_message_id,
      };
  appendFinalMessage(message, el);
  root.rememberChatFuelContext?.(message);
  if (el && el.isConnected) el.remove();
  const drafts = Array.isArray(chatTurnRecord(row.meta).drafts) ? chatTurnRecord(row.meta).drafts as unknown[] : [];
  if (drafts.length) { state.plan = []; toast("Draft ready — Apply below"); }
  if (state.tab === "chat") root.loadChatFuel?.(pollToken);
}

function finalizeCanceled(turnValue: unknown): void {
  const id = turnId(chatTurnRecord(turnValue).id);
  if (id != null) {
    if (chatDoneTurns.has(id)) return;
    chatDoneTurns.add(id);
  }
  const el = id == null ? null : chatPendingBubbles.get(id);
  if (id != null) {
    chatPendingBubbles.delete(id);
    chatStreamText.delete(id);
  }
  if (el && el.isConnected) {
    el.classList.remove("pending");
    el.removeAttribute("aria-busy");
    el.classList.add("turn-stopped");
    el.innerHTML = `<span class="turn-stopped-note">Stopped</span>`;
  }
}

async function cancelTurn(id: number): Promise<void> {
  let response: unknown = null;
  try { response = await api(`/chat/turns/${id}/cancel`, { method: "POST" }); } catch {}
  finalizeCanceled(chatTurnRecord(response).turn || { id });
  if (chatStreamId === id) closeChatStream();
  chatMonitorEnsure();
}

function closeChatStream(): void {
  if (chatStream) { try { chatStream.close(); } catch {} }
  chatStream = null;
  chatStreamId = null;
}

function chatTeardownMonitor(): void {
  closeChatStream();
  chatPendingBubbles.clear();
  chatStreamText.clear();
  chatStreamRenderQueued.clear();
  chatStreamRenderVersion.clear();
  chatDoneTurns.clear();
}

function chatMonitorEnsure(): void {
  if (chatStream || state.tab !== "chat") return;
  const ids = [...chatPendingBubbles.keys()]
    .filter((id) => chatPendingBubbles.get(id)?.isConnected)
    .sort((a, b) => a - b);
  if (!ids.length) return;
  chatOpenStream(ids[0]);
}

function streamTerminal(es: EventSource): void {
  if (chatStream === es) closeChatStream();
  else { try { es.close(); } catch {} }
  chatMonitorEnsure();
}

function chatOpenStream(id: number): void {
  chatStreamId = id;
  let es: EventSource;
  try { es = new EventSource(withToken(`/api/chat/turns/${id}/stream`)); }
  catch { chatStreamId = null; return; }
  chatStream = es;

  const guard = () => {
    if (state.tab === "chat" && document.getElementById("chatlog")) return false;
    if (chatStream === es) closeChatStream();
    else { try { es.close(); } catch {} }
    return true;
  };
  const phase = (turn: unknown) => {
    const el = chatPendingBubbles.get(id);
    if (el?.isConnected) setPendingCaption(el, chatPhaseCaption(chatTurnRecord(turn) as ChatTurn));
  };

  es.addEventListener("snapshot", (event) => {
    if (guard()) return;
    const row = parseTurnEvent(event);
    if (!row) return;
    const turn = chatTurnRecord(row.turn);
    if (turn.status && ["done", "error", "canceled"].includes(String(turn.status))) {
      if (turn.status === "canceled") finalizeCanceled(turn);
      else finalizeTurn(turn, row.message);
      streamTerminal(es);
      return;
    }
    phase(row.turn || row);
  });
  es.addEventListener("phase", (event) => { if (!guard()) phase(parseTurnEvent(event)?.turn); });
  es.addEventListener("progress", (event) => { if (!guard()) setTurnProgress(id, parseTurnEvent(event)?.text); });
  es.addEventListener("delta", (event) => { if (!guard()) appendStreamDelta(id, parseTurnEvent(event)?.text); });
  es.addEventListener("reset", () => { if (!guard()) resetStreamingBubble(id); });
  es.addEventListener("done", (event) => {
    if (guard()) return;
    const row = parseTurnEvent(event);
    if (!row) return;
    finalizeTurn(row.turn, row.message);
    streamTerminal(es);
  });
  es.addEventListener("canceled", (event) => {
    if (guard()) return;
    finalizeCanceled(parseTurnEvent(event)?.turn);
    streamTerminal(es);
  });
  es.addEventListener("error", (event) => {
    const data = (event as MessageEvent).data;
    if (!data) return;
    if (guard()) return;
    const row = parseTurnEvent(event);
    if (!row) return;
    finalizeTurn(row.turn, row.message);
    streamTerminal(es);
  });
}

async function chatReconnect(): Promise<void> {
  let turns: ChatTurn[] = [];
  try { turns = chatTurnRows(await api("/chat/turns")); } catch { turns = []; }
  if (state.tab !== "chat" || !$<HTMLElement>("#chatlog")) return;
  for (const turn of turns) spawnPendingBubble(turn);
  chatMonitorEnsure();
}

function wireChatJump(log: HTMLElement | null, jump: HTMLElement | null): void {
  if (!log || !jump) return;
  const update = () => {
    const off = log.scrollHeight - log.scrollTop - log.clientHeight;
    jump.hidden = off < 120;
  };
  log.addEventListener("scroll", update, { passive: true });
  jump.addEventListener("click", () =>
    log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" }));
  update();
}

function autosizeChatInput(el: HTMLTextAreaElement | HTMLInputElement | null): void {
  if (!el) return;
  const max = 140;
  if (!el.value) {
    el.style.height = "";
    el.style.overflowY = "hidden";
    return;
  }
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

function measureChatTop(): void {
  const cv = document.querySelector<HTMLElement>(".chatview");
  if (!cv) return;
  if (cv.style.height) cv.style.height = "";
  const header = document.querySelector<HTMLElement>("header");
  const tab = document.querySelector<HTMLElement>(".tabbar");
  const vv = window.visualViewport;
  const vh = vv ? vv.height : window.innerHeight;
  const offTop = vv ? vv.offsetTop : 0;
  const rootEl = document.documentElement;
  if (matchMedia("(min-width:960px)").matches) {
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    rootEl.style.setProperty("--cvt", "0px");
    rootEl.style.setProperty("--chat-top", "0px");
    rootEl.style.setProperty("--chat-h", `${Math.max(220, vh - headerBottom - 18)}px`);
    return;
  }
  const headerH = header ? header.getBoundingClientRect().height : 0;
  rootEl.style.setProperty("--cvt", `${Math.round(offTop)}px`);
  rootEl.style.setProperty("--chat-top", `${Math.round(headerH)}px`);
  if (tab) rootEl.style.setProperty("--tabbar-h", `${Math.round(tab.getBoundingClientRect().height)}px`);
}

Object.assign(globalThis, {
  saveChatDraft,
  loadChatDraft,
  spawnPendingBubble,
  chatMonitorEnsure,
  chatReconnect,
  chatTeardownMonitor,
  wireChatJump,
  autosizeChatInput,
  measureChatTop,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    saveChatDraft,
    loadChatDraft,
    spawnPendingBubble,
    chatMonitorEnsure,
    chatReconnect,
    chatTeardownMonitor,
    wireChatJump,
    autosizeChatInput,
    measureChatTop,
  });
}
})();
