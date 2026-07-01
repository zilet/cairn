// @ts-check
// ==== 09-plan-chat.js ====
// Plan editor and Plan Endurance screen orchestration live in /js/plan-editor-client.js and /js/plan-endurance-client.js.

type ChatScreenMessage = Partial<import("../contracts/client.js").ClientChatMessage> &
  Record<string, unknown> & {
    pending?: boolean;
    meta?: unknown;
  };
type ChatScreenMeta = {
  image?: unknown;
  applied?: unknown;
  drafts?: unknown;
  [key: string]: unknown;
};
type ChatScreenAppliedAction = { type?: unknown; error?: unknown };
type ChatScreenDraft = {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  summary?: unknown;
};
type ChatScreenImagePayload = { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
type ChatScreenGroup = { iso: string; msgs: ChatScreenMessage[] };
type ChatScreenAppendOptions = { readonly?: boolean; before?: Element | null };
type ChatScreenJobHandlers = {
  guard?: () => boolean;
  onDone?: (result: unknown) => unknown;
  onError?: (error?: unknown) => unknown;
  onCanceled?: () => unknown;
};
type ChatScreenHeaderButtons = { freshBtn: HTMLElement | null; historyBtn: HTMLElement | null };

declare function enqueueJob(path: string, body?: Record<string, unknown>): Promise<unknown>;
declare function openJobStream(jobId: string | number, handlers?: ChatScreenJobHandlers): void;
declare function openChatHistory(options?: { session?: string | null }): void;
declare function saveChatDraft(value: string): void;
declare function loadChatDraft(): string;
declare function spawnPendingBubble(turnValue: unknown): Element | null;
declare function chatMonitorEnsure(): void;
declare function chatReconnect(): Promise<void>;
declare function wireChatJump(log: HTMLElement | null, jump: HTMLElement | null): void;

function chatScreenRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function chatScreenRows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row): row is T => !!row && typeof row === "object") : [];
}

function chatScreenMessages(value: unknown): ChatScreenMessage[] {
  return chatScreenRows<ChatScreenMessage>(value);
}

function chatScreenMeta(value: unknown): ChatScreenMeta {
  return chatScreenRecord(value) as ChatScreenMeta;
}

function chatScreenApplied(value: unknown): ChatScreenAppliedAction[] {
  return chatScreenRows<ChatScreenAppliedAction>(value);
}

function chatScreenDrafts(value: unknown): ChatScreenDraft[] {
  return chatScreenRows<ChatScreenDraft>(value);
}

function chatScreenString(value: unknown): string {
  return value == null ? "" : String(value);
}

function chatScreenHtml<T extends HTMLElement = HTMLElement>(value: Element | null | undefined): T | null {
  return value instanceof HTMLElement ? value as T : null;
}

// ---------- Chat ----------
// Document-level paste listener for the chat view; swapped on every renderChat.
let chatPasteHandler: ((event: ClipboardEvent) => void) | null = null;
let chatFuelContext: ChatScreenMessage[] = [];

// Convert a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") to a local YYYY-MM-DD
// for day grouping; falls back to today on anything unparseable.
function chatScreenDayISO(ts: unknown): string {
  return CairnChatClient.dayISO(ts, localISO);
}

function chatDivider(iso: string): Element {
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

// Starter chips shown while the conversation is empty (fresh chat / after a
// fresh start); tapping one prefills the input and sends through the normal
// send path. They vanish as soon as the first message lands (appendMsg removes them).
function drawChatChips(log: Element): void {
  const template = document.createElement("template");
  template.innerHTML = CairnChatClient.starterChipsHtml().trim();
  const wrap = template.content.firstElementChild;
  if (!wrap) return;
  log.appendChild(wrap);
  wrap.querySelectorAll(".chat-chip").forEach((b) => b.addEventListener("click", () => {
    const input = $<HTMLTextAreaElement>("#chatInput");
    if (!input) return;
    input.value = b.textContent || "";
    const send = $("#chatSend");
    if (send) (send as HTMLElement).click();
  }));
}

// Chat gets the logged-food glance only when the active thread is already about
// food capture or today's fuel. The durable food log still feeds the coach prompt
// everywhere; this UI guard keeps broad health/nutrition chats from carrying a
// persistent food banner.
function chatScreenMessageHasFoodAction(m: Partial<ChatScreenMessage> | null | undefined): boolean {
  return CairnChatClient.messageHasFoodAction(m);
}

function chatScreenUserMessageSuggestsFood(m: Partial<ChatScreenMessage> | null | undefined): boolean {
  return CairnChatClient.userMessageSuggestsFood(m);
}

function chatScreenWantsFuelSurface(messages: Partial<ChatScreenMessage>[] = chatFuelContext): boolean {
  return CairnChatClient.wantsFuelSurface(messages, { todayISO: localISO(), dayISO: chatScreenDayISO });
}

function rememberChatFuelContext(...msgs: Array<Partial<ChatScreenMessage> | null | undefined>): ChatScreenMessage[] {
  const next = [...chatFuelContext, ...msgs.filter((msg): msg is ChatScreenMessage => !!msg && typeof msg === "object")];
  chatFuelContext = next.slice(-24);
  return chatFuelContext;
}

// Expand the collapsed history block at the top of the chat log: smooth
// max-height + fade per the motion rules, while keeping the messages the
// athlete is looking at visually still. Anchoring re-measures the first
// visible element every frame (rather than accumulating deltas), so scroll
// clamping while the scroller is still shorter than its viewport self-corrects.
function expandChatEarlier(log: HTMLElement, bar: Element, block: HTMLElement): void {
  const logTop = log.getBoundingClientRect().top;
  const anchor = [...log.children].find((el) => el !== bar && el !== block && el.getBoundingClientRect().bottom > logTop) || null;
  const anchorY = anchor ? anchor.getBoundingClientRect().top : 0;
  const keep = () => { if (anchor) log.scrollTop += anchor.getBoundingClientRect().top - anchorY; };
  if (reducedMotion()) {
    bar.remove();
    block.hidden = false;
    keep();
    return;
  }
  block.hidden = false;
  block.style.overflow = "hidden";
  block.style.maxHeight = "0px";
  block.style.opacity = "0";
  bar.remove();
  keep();
  const target = block.scrollHeight;
  void block.offsetHeight; // commit the collapsed start state
  block.style.transition = "max-height var(--dur-3) var(--ease), opacity var(--dur-3) var(--ease)";
  block.style.maxHeight = `${target}px`;
  block.style.opacity = "1";
  const t0 = performance.now();
  const step = (t: number) => {
    if (!block.isConnected) return;
    keep();
    if (t - t0 < 600) { requestAnimationFrame(step); return; } // --dur-3 + settle
    block.style.maxHeight = "";
    block.style.overflow = "";
    block.style.transition = "";
    block.style.opacity = "";
    keep();
  };
  requestAnimationFrame(step);
}

// Fresh-start affordance in the global header (sparkle, two-tap confirm).
// Re-created idempotently on every renderChat; renderTab removes it when the
// athlete leaves the Chat tab -- no listeners outlive their element.
// Header affordances for Chat: a history/search button + the fresh-start
// (distill & archive) button, in one flex cluster anchored to the header.
// Re-created idempotently per renderChat; renderTab removes the cluster when
// the athlete leaves Chat -- no listeners outlive their elements.
function ensureChatHeaderBtns(): ChatScreenHeaderButtons {
  document.getElementById("hdrChatActions")?.remove();
  const template = document.createElement("template");
  template.innerHTML = CairnChatClient.headerActionsHtml().trim();
  const wrap = template.content.firstElementChild;
  const hist = chatScreenHtml(wrap?.querySelector("#hdrHistory"));
  const b = chatScreenHtml(wrap?.querySelector("#hdrFresh"));
  if (!wrap || !hist || !b) return { freshBtn: null, historyBtn: null };
  hist.addEventListener("click", () => openChatHistory());

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
    void chatFreshStart();
  });

  document.querySelector("header")!.appendChild(wrap);
  return { freshBtn: b, historyBtn: hist };
}

// POST /api/chat/reset -- non-blocking fresh start. The server ARCHIVES the live
// conversation at once (so the composer is usable instantly -- never disabled) and
// distills durable facts into memory in the BACKGROUND as a chat_distill job. We
// optimistically clear the log to an empty, fully-enabled composer, then settle a
// quiet "✓ N remembered" / "Fresh start" pill when the distill job lands. A message
// typed during the distill just queues as a normal chat turn (the server orders
// archive-before-turn). bg_ops OFF -> the response carries `distilled` inline.
async function chatFreshStart(): Promise<void> {
  const log = $("#chatlog");
  if (!log || state.tab !== "chat") return;
  const token = pollToken; // any full re-render bumps this -- treat as stale
  const fresh = document.getElementById("hdrFresh");
  if (fresh) fresh.hidden = true; // the thread is empty now
  // Optimistic clear -- empty state + chips, composer stays fully enabled & focused.
  chatFuelContext = [];
  drawChat([]);
  const fuelSlot = $("#chatFuelSlot");
  if (fuelSlot) fuelSlot.innerHTML = "";
  const input = $<HTMLTextAreaElement>("#chatInput");
  if (input && matchMedia("(hover:hover)").matches) input.focus();
  let r: Record<string, unknown> | null = null;
  try {
    r = chatScreenRecord(await enqueueJob("/chat/reset", {}));
  } catch {
    /* the archive happens server-side; a blip just means no pill */
    return;
  }
  if (token !== pollToken || state.tab !== "chat") return;

  // bg_ops OFF (legacy): the distilled count is already on the response -- settle now.
  if (!r || !r.distilling) { settleFreshPill(r && r.ok ? r.distilled : 0, token); return; }

  // bg_ops ON: stream the distill job; settle the pill on done. The job lives
  // server-side, so it survives a reload (a re-render's chatReconnect leaves the
  // turn stream alone; this pill is best-effort and simply won't reappear).
  const distilling = r.distilling;
  if (typeof distilling !== "string" && typeof distilling !== "number") return;
  openJobStream(distilling, {
    guard: () => state.tab !== "chat" || token !== pollToken,
    onDone: (result) => settleFreshPill(chatScreenRecord(result).ok ? chatScreenRecord(result).distilled : 0, token),
    onError: () => {},
    onCanceled: () => {},
  });
}

// A quiet, self-dismissing "✓ N remembered" / "Fresh start" pill in the chat header
// actions row -- stale-guarded on token + tab so it never lands on a navigated-away
// view. Replaces any prior pill so a fast double fresh-start doesn't stack.
function settleFreshPill(distilled: unknown, token: number): void {
  if (token !== pollToken || state.tab !== "chat") return;
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

function chatScreenFuelHtml(d: import("../contracts/client.js").ClientDayIntake | null | undefined): string {
  return CairnChatClient.fuelHtml(d);
}

async function loadChatFuel(token: number, messages: Partial<ChatScreenMessage>[] = chatFuelContext): Promise<void> {
  const slot = $("#chatFuelSlot");
  if (!slot) return;
  if (!chatScreenWantsFuelSurface(messages)) { slot.innerHTML = ""; return; }
  let d: import("../contracts/client.js").ClientDayIntake | null = null;
  try { d = await api("/nutrition/day"); } catch { slot.innerHTML = ""; return; }
  if (token !== pollToken || state.tab !== "chat" || !slot.isConnected) return;
  slot.innerHTML = chatScreenFuelHtml(d);
  const card = slot.querySelector("#chatFuelCard");
  if (card) card.addEventListener("click", () => { state.planJump = "food"; activateTab("plan"); });
}

async function renderChat(): Promise<void> {
  headerTitle.textContent = "Chat";
  document.body.classList.add("chat-mode"); // the chat column owns the viewport; drop body's tab-bar padding
  chatTeardownMonitor(); // the log is about to be rebuilt -- drop the old stream + bubble map
  const token = ++pollToken; // bump so the async hydrate below can detect a stale tab
  const { freshBtn } = ensureChatHeaderBtns();
  chatFuelContext = [];
  // Paint the shell FIRST so the composer is usable instantly; the log hydrates
  // in the background. The flex viewport column keeps the composer pinned above
  // the tab bar no matter how the OS zooms (height is re-measured, not magic).
  view.innerHTML = CairnChatClient.shellHtml();

  const log = $<HTMLElement>("#chatlog");
  if (!log) return;
  log.innerHTML = loadingState("Catching up…");
  wireChatJump(log, $<HTMLElement>("#chatJump"));
  measureChatTop();
  requestAnimationFrame(measureChatTop); // re-measure once layout/fonts settle

  const input = $<HTMLTextAreaElement>("#chatInput");
  const sendBtn = $<HTMLButtonElement>("#chatSend");
  const fileInput = $<HTMLInputElement>("#chatFile");
  const attachBtn = $<HTMLButtonElement>("#chatAttach");
  const preview = $<HTMLElement>("#chatPreview");
  if (!input || !sendBtn || !fileInput || !attachBtn || !preview) return;
  let attached: ChatScreenImagePayload | null = null;

  const isSoftKeyboardChat = () => !matchMedia("(hover:hover)").matches;
  const resetChatFocusAfterNativePicker = () => CairnChatAttachment.resetFocusAfterNativePicker({
    input,
    fileInput,
    isSoftKeyboard: isSoftKeyboardChat,
  });
  const settleChatAfterNativePicker = () => CairnChatAttachment.settleAfterNativePicker({
    isActive: () => state.tab === "chat",
    measure: measureChatTop,
    graceMs: 1200,
  });
  const clearAttach = () => {
    attached = null;
    fileInput.value = "";
    preview.hidden = true;
    attachBtn.classList.remove("has-img");
    settleChatAfterNativePicker();
  };
  const attachFile = async (f: File | null | undefined) => {
    if (!f) return;
    try {
      attached = await CairnChatAttachment.compressImage(f);
      const img = CairnChatAttachment.previewImage(preview.querySelector("img"));
      if (img) img.src = attached.dataUrl;
      preview.hidden = false;
      attachBtn.classList.add("has-img");
    } catch (e) {
      const tooLarge = e instanceof Error && e.message === "image-too-large";
      toast(tooLarge ? "That photo is too large — try a closer crop." : "Couldn't read that image — try another.");
      clearAttach();
    } finally {
      settleChatAfterNativePicker();
    }
  };
  // One "+" control. On iOS a file input with no `capture` opens the native
  // sheet (Take Photo / Photo Library / Choose File); desktop opens the file
  // dialog. Attaching is occasional, so this keeps the bar to input + send.
  attachBtn.addEventListener("click", () => {
    resetChatFocusAfterNativePicker();
    settleChatAfterNativePicker();
    fileInput.click();
  });
  $("#chatPreviewX")?.addEventListener("click", clearAttach);
  fileInput.addEventListener("change", () => {
    resetChatFocusAfterNativePicker();
    const f = fileInput.files && fileInput.files[0];
    if (f) void attachFile(f);
    else settleChatAfterNativePicker();
  });
  // Paste-an-image support (desktop screenshots, iOS "Copy Photo"). One live
  // handler at a time: re-renders swap it out, and it bails when chat isn't
  // the active tab so it never touches a stale DOM.
  if (chatPasteHandler) document.removeEventListener("paste", chatPasteHandler);
  chatPasteHandler = (e: ClipboardEvent) => {
    if (state.tab !== "chat" || !input.isConnected) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); void attachFile(f); }
        return;
      }
    }
  };
  document.addEventListener("paste", chatPasteHandler);

  // Send = enqueue a durable turn and return immediately; the input never blocks,
  // so a follow-up typed while the coach is thinking simply queues (its own turn,
  // drained serially server-side). The monitor streams real progress + finalizes.
  const send = async () => {
    const text = input.value.trim();
    const img = attached;
    if (!text && !img) return;
    input.value = "";
    autosizeChatInput(input); // collapse the composer back to one line
    saveChatDraft("");
    clearAttach();
    // Optimistic user bubble lands instantly (the server persists it too; a full
    // re-render later draws from server truth, so no duplicate).
    const userMsg: ChatScreenMessage = { role: "user", content: text || "(photo)", meta: img ? { image: img.dataUrl } : null };
    const userBubble = appendMsg(userMsg);
    rememberChatFuelContext(userMsg);
    void loadChatFuel(token);
    try {
      const body: Record<string, unknown> = { message: text };
      if (img) { body.image_base64 = img.base64; body.image_mime = img.mime; }
      const r = chatScreenRecord(await api("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (r.turn) { spawnPendingBubble(r.turn); chatMonitorEnsure(); }
      else appendMsg({ role: "assistant", content: chatScreenString(r.error) || "(no reply)" });
    } catch {
      // Couldn't even enqueue (offline): roll the optimistic bubble back and put
      // the text back in the composer so nothing is lost -- the offline banner says why.
      userBubble?.remove();
      if (!input.value) { input.value = text; saveChatDraft(text); autosizeChatInput(input); }
      toast("Couldn't send — check your connection");
    } finally {
      if (matchMedia("(hover:hover)").matches) input.focus();
    }
  };
  // Tapping send must NOT blur the textarea (that just dismisses the keyboard,
  // and as the layout reflows the button slides out from under your finger so
  // the first tap never sends). preventDefault on pointerdown keeps the input
  // focused -- but on iOS WebKit that ALSO suppresses the synthesized click, so
  // we send on pointerup instead (fires on both touch and mouse). The click
  // handler stays for keyboard activation (Enter/Space on the focused button);
  // send()'s empty-input guard makes any second call a no-op, so pointer
  // devices never double-send. (The "+" is left alone -- it opens a file picker.)
  sendBtn.addEventListener("pointerdown", (e) => e.preventDefault());
  sendBtn.addEventListener("pointerup", () => { void send(); });
  sendBtn.addEventListener("click", () => { void send(); });
  // Desktop: Enter sends, Shift+Enter drops a newline. Touch keyboards keep
  // Enter as a newline (so multi-line capture -- pasting findings, describing a
  // meal -- just works) and send via the arrow button.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && matchMedia("(hover:hover)").matches) {
      e.preventDefault();
      void send();
    }
  });
  // Re-pin the column across the WHOLE keyboard slide. iOS animates the keyboard
  // over ~300ms and reports its visual-viewport metrics in steps, so a single
  // double-rAF (~32ms) catches a transitional offsetTop -- the styled bar and the
  // real caret desync ("typing in the gap underneath the input"). Re-measure on
  // a few beats spanning the animation so the dock settles flush to the keyboard,
  // and once more after it drops to clear any stale gap.
  const settleChatViewport = () => {
    measureChatTop();
    requestAnimationFrame(() => requestAnimationFrame(measureChatTop));
    for (const d of [80, 160, 260, 380, 520]) setTimeout(() => { if (state.tab === "chat") measureChatTop(); }, d);
  };
  const releaseStaleChatInputFocus = () => {
    if (!isSoftKeyboardChat()) return;
    const kbGeometryOpen = document.body.classList.contains("kb-geometry-open");
    if (!kbGeometryOpen && document.activeElement === input) input.blur();
    settleChatViewport();
  };
  const recoverChatInputFocus = () => {
    if (!isSoftKeyboardChat()) return;
    setTimeout(() => {
      if (state.tab !== "chat" || !input.isConnected) return;
      const kbGeometryOpen = document.body.classList.contains("kb-geometry-open");
      const alreadyFocused = document.activeElement === input;
      if (!alreadyFocused && !kbGeometryOpen) {
        try { input.focus({ preventScroll: true }); }
        catch { input.focus(); }
      }
      settleChatViewport();
    }, 0);
  };
  const recoverChatInputFocusAfterClick = () => {
    if (!isSoftKeyboardChat()) return;
    setTimeout(() => {
      if (state.tab !== "chat" || !input.isConnected || document.activeElement === input) return;
      try { input.focus({ preventScroll: true }); }
      catch { input.focus(); }
      settleChatViewport();
    }, 80);
  };
  input.addEventListener("pointerdown", releaseStaleChatInputFocus);
  input.addEventListener("pointerup", recoverChatInputFocus, { passive: true });
  input.addEventListener("click", recoverChatInputFocusAfterClick);
  for (const ev of ["focus", "blur"] as const) input.addEventListener(ev, settleChatViewport);
  // Persist the unsent draft on every keystroke so it survives a tab switch /
  // reload -- restored below unless a deep-link prefill takes precedence. Re-grow
  // the composer to fit what's typed/pasted.
  input.addEventListener("input", () => { saveChatDraft(input.value); autosizeChatInput(input); });
  // Deep links (e.g. the compass nudge) arrive with the question pre-written --
  // leave it editable rather than auto-sending. Otherwise restore the saved draft.
  if (state.chatPrefill) { input.value = state.chatPrefill; state.chatPrefill = null; saveChatDraft(input.value); }
  else { const d = loadChatDraft(); if (d) input.value = d; }
  autosizeChatInput(input); // fit a restored multi-line draft
  // desktop only -- on mobile, auto-focus pops the keyboard over half the view
  if (matchMedia("(hover:hover)").matches) input.focus();

  // Hydrate the log in the background -- the shell above is already interactive.
  let msgs: ChatScreenMessage[] = [];
  try { msgs = chatScreenMessages(await api("/chat?limit=200")); } catch { msgs = []; }
  if (token !== pollToken || !log.isConnected) return; // navigated away / re-rendered
  if (freshBtn) freshBtn.hidden = !msgs.length;
  chatFuelContext = msgs.slice(-24);
  drawChat(msgs);
  void loadChatFuel(token);
  // Rebuild any in-flight + queued turns from the server and resume streaming.
  void chatReconnect();
  if (state.pendingChatSession) openChatHistory({ session: state.pendingChatSession });
  requestAnimationFrame(measureChatTop);
}

function drawChat(msgs: ChatScreenMessage[]): void {
  const log = $<HTMLElement>("#chatlog");
  if (!log) return;
  log.innerHTML = "";
  if (!msgs.length) {
    log.innerHTML = CairnChatClient.emptyHtml();
    drawChatChips(log);
    return;
  }
  // Group chronologically by local calendar day, splitting only at day
  // boundaries so dividers never duplicate across the collapse seam.
  const groups: ChatScreenGroup[] = [];
  for (const m of msgs) {
    const iso = chatScreenDayISO(m.created_at);
    let group = groups[groups.length - 1];
    if (!group || group.iso !== iso) {
      group = { iso, msgs: [] };
      groups.push(group);
    }
    group.msgs.push(m);
  }
  // The most recent stretch stays expanded: today's messages, or -- when today
  // is empty -- whole recent days until ~12 messages are visible.
  let cut = groups.length - 1;
  const lastGroup = groups[cut];
  if (!lastGroup) return;
  if (lastGroup.iso !== localISO()) {
    let count = lastGroup.msgs.length;
    while (cut > 0 && count < 12) { cut--; count += groups[cut].msgs.length; }
  }
  const earlier = groups.slice(0, cut);
  if (earlier.length) {
    const template = document.createElement("template");
    template.innerHTML = CairnChatClient.earlierBarHtml().trim();
    const bar = template.content.firstElementChild;
    if (!bar) return;
    log.appendChild(bar);
    const block = document.createElement("div");
    block.className = "chat-earlier";
    block.hidden = true;
    for (const g of earlier) {
      block.appendChild(chatDivider(g.iso));
      for (const m of g.msgs) appendMsg(m, true, block);
    }
    log.appendChild(block);
    bar.querySelector("button")?.addEventListener("click", () => expandChatEarlier(log, bar, block));
  }
  for (const g of groups.slice(cut)) {
    log.appendChild(chatDivider(g.iso));
    for (const m of g.msgs) appendMsg(m, true);
  }
  log.scrollTop = log.scrollHeight;
}

// Local clock time for a chat turn ("2:14 PM"); now when no timestamp (the
// optimistic user bubble). Empty string if unparseable.
function chatClock(ts: unknown): string {
  const d = ts ? new Date(`${String(ts).replace(" ", "T")}Z`) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  try { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

// Copy text to the clipboard with a graceful fallback + a confirming toast.
function copyText(text: unknown): void {
  const t = String(text || "");
  if (!t) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(t).then(() => toast("Copied"), () => toast("Couldn't copy"));
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand("copy"); toast("Copied"); } catch { toast("Couldn't copy"); }
  ta.remove();
}

// Touch long-press -> copy (the hover copy button is desktop-only).
function attachLongPressCopy(el: Element, text: unknown): void {
  let timer = 0;
  const cancel = () => clearTimeout(timer);
  el.addEventListener("touchstart", () => {
    cancel();
    timer = window.setTimeout(() => copyText(text), 500);
  }, { passive: true });
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
}

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>`;

// Render one chat turn. `opts.readonly` (history overlay) renders drafts as a
// static note instead of an Apply button. Consecutive same-role turns group:
// the previous one drops its tail + time, this one becomes the run's last.
function appendMsg(
  m: Partial<ChatScreenMessage>,
  noScroll = false,
  parent: Element | null = null,
  opts: ChatScreenAppendOptions = {},
): HTMLElement | null {
  const log = $<HTMLElement>("#chatlog");
  const host = parent || log;
  if (!host) return null; // log torn down (tab switch mid-stream) -- bail safely
  const readonly = !!opts.readonly;
  // Optional position-preserving insert: a streaming turn finalizes in place even
  // when a queued follow-up's pending bubble already sits below it.
  const before = opts.before && opts.before.isConnected && opts.before.parentElement === host ? opts.before : null;
  if (!noScroll && !parent && log) {
    // a live turn: clear the loading/empty state + starter chips, and make sure
    // it lands under a "Today" divider
    log.querySelector(".loadstate")?.remove();
    log.querySelector(".empty")?.remove();
    log.querySelector(".chat-chips")?.remove();
    const divs = log.querySelectorAll<HTMLElement>(".chat-divider[data-day]");
    const last = divs[divs.length - 1];
    if (!last || last.dataset.day !== localISO()) log.appendChild(chatDivider(localISO()));
    const fresh = document.getElementById("hdrFresh");
    if (fresh && state.tab === "chat") fresh.hidden = false;
  }
  const role = chatScreenString(m.role);
  // Grouping: continue a same-role run (skip for the pending typing bubble).
  const prev = m.pending ? null : (before ? before.previousElementSibling : host.lastElementChild);
  const cont = !!prev && prev.classList?.contains("bubble") && prev.classList.contains(role) && !prev.classList.contains("pending");

  if (cont) { prev.classList.add("grouped"); prev.querySelector(".bubble-time")?.remove(); }

  const el = document.createElement("div");
  el.className = `bubble ${role}${m.pending ? " pending" : ""}${cont ? " cont" : ""}${noScroll ? "" : " bubble-in"}`;
  if (m.id != null) el.dataset.mid = String(m.id); // anchor for re-attaching a turn's pending bubble after reload

  // Pending = the house typing indicator (breathing dots); an optional caption
  // ("Reading your plate…") leads, the dots follow. Early-return so a pending
  // bubble never picks up a timestamp or copy affordance.
  if (m.pending) {
    // role=status + aria-busy couples the visible "thinking" dots to a screen-
    // reader signal; the caption is the live phase ("Thinking…" -> "Drafting…").
    el.setAttribute("role", "status");
    el.setAttribute("aria-busy", "true");
    const content = chatScreenString(m.content);
    const lead = content && content !== "…" ? `${escHtml(content)} ` : "";
    el.innerHTML = `<div class="bubble-text"><span class="typing-cap">${lead}</span><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
    host.appendChild(el);
    if (!noScroll && log) log.scrollTop = log.scrollHeight;
    return el;
  }

  const meta = chatScreenMeta(m.meta);
  let extra = "";
  const applied = chatScreenApplied(meta.applied);
  if (applied.length) {
    extra += `<div class="bubble-meta">${applied.map((a) => `<span class="bubble-tag">✓ ${escHtml(String(a.type).replace(/_/g, " "))}${a.error ? " ⚠" : ""}</span>`).join("")}</div>`;
  }
  const drafts = chatScreenDrafts(meta.drafts);
  if (drafts.length) {
    // Each draft reflects its CURRENT proposal status (stamped server-side). An
    // applied one is a calm "done" note -- no more Apply button to re-trigger it.
    extra += drafts.map((d) => {
      const label = escHtml(d.summary || (d.kind === "restructure" ? "plan restructure" : "plan update"));
      if (d.status === "applied")
        return `<div class="draftbtn applied" aria-disabled="true">✓ Applied · ${label}</div>`;
      if (readonly)
        return `<div class="bubble-meta"><span class="bubble-tag">plan draft</span></div>`;
      return `<button class="draftbtn" data-apply="${escAttr(d.id)}">Apply: ${label}</button>`;
    }).join("");
  }
  const hideText = !!meta.image && (!m.content || m.content === "(photo)");
  const body = hideText ? "" : role === "assistant"
    ? `<div class="bubble-text md">${mdToHtml(m.content)}</div>`
    : `<div class="bubble-text">${escHtml(m.content)}</div>`;
  const rawPhoto = meta.image;
  const photoSrc = rawPhoto && String(rawPhoto).startsWith("/api/chat-images/")
    ? withToken(String(rawPhoto))
    : rawPhoto;
  const photo = photoSrc ? `<img class="bubble-img" alt="attached photo" loading="lazy" src="${escAttr(photoSrc)}" data-remove-on-error="1">` : "";
  const time = `<span class="bubble-time">${escHtml(chatClock(m.created_at))}</span>`;
  const canCopy = role === "assistant" && !hideText && !!m.content;
  const copyBtn = canCopy ? `<button class="bubble-copy" aria-label="Copy reply" title="Copy">${COPY_ICON}</button>` : "";
  el.innerHTML = `${copyBtn}${photo}${body}${extra}${time}`;
  if (before) host.insertBefore(el, before);
  else host.appendChild(el);
  el.querySelectorAll("[data-apply]").forEach((b) => {
    const btn = b instanceof HTMLButtonElement ? b : null;
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      let r: unknown = null;
      try { r = await api(`/proposals/${btn.dataset.apply || ""}/apply`, { method: "POST" }); } catch { r = null; }
      // Honest failure (shared with the Coach list via applyResultMessage): a transport
      // drop, a 400 {error}, or ok:false must NOT read as "Applied". Re-enable the button
      // so the draft stays actionable instead of settling into a false "done" note.
      const result = applyResultMessage(r);
      if (result.failed) { btn.disabled = false; toast(result.message); return; }
      const clamped = chatScreenRecord(r).clamped;
      const hasClamped = Array.isArray(clamped) && clamped.length > 0;
      toast(result.message);
      state.plan = [];
      swrInvalidate("plan"); // a chat-applied plan change makes the cache stale
      // Settle into the same calm "done" note the message renders on reload, so a
      // just-applied draft and a long-applied one look identical.
      const label = btn.textContent?.replace(/^Apply:\s*/, "") || "";
      const done = document.createElement("div");
      done.className = "draftbtn applied";
      done.setAttribute("aria-disabled", "true");
      done.textContent = `✓ Applied · ${label}`;
      btn.replaceWith(done);
      // A code guardrail nudged a load to a safe step -- show the honest hairline note
      // inline under the bubble's actions (it persists exactly here on this turn).
      if (hasClamped) done.insertAdjacentHTML("afterend", clampNoteHtml(clamped));
    });
  });
  if (canCopy) {
    el.querySelector(".bubble-copy")?.addEventListener("click", () => copyText(m.content));
    attachLongPressCopy(el, m.content);
  }
  if (!noScroll && log && (!before || before === host.lastElementChild)) log.scrollTop = log.scrollHeight;
  return el;
}

Object.assign(globalThis, {
  appendMsg,
  chatDayISO: chatScreenDayISO,
  chatDivider,
  chatFuelHtml: chatScreenFuelHtml,
  chatMessageHasFoodAction: chatScreenMessageHasFoodAction,
  chatUserMessageSuggestsFood: chatScreenUserMessageSuggestsFood,
  chatWantsFuelSurface: chatScreenWantsFuelSurface,
  drawChat,
  loadChatFuel,
  rememberChatFuelContext,
  renderChat,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    appendMsg,
    chatDayISO: chatScreenDayISO,
    chatDivider,
    chatFuelHtml: chatScreenFuelHtml,
    chatMessageHasFoodAction: chatScreenMessageHasFoodAction,
    chatUserMessageSuggestsFood: chatScreenUserMessageSuggestsFood,
    chatWantsFuelSurface: chatScreenWantsFuelSurface,
    drawChat,
    loadChatFuel,
    rememberChatFuelContext,
    renderChat,
  });
}

// ============================================================================
// Durable agent job helpers live in /js/agent-job-client.js.
// ============================================================================

// ============================================================================
// Durable chat turn helpers live in /js/chat-turn-client.js.
// ============================================================================

// ============================================================================
// Chat history/search helpers live in /js/chat-history-client.js.
// ============================================================================
