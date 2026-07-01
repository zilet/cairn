// @ts-check
// ==== 09-plan-chat.js ====
// Plan editor orchestration lives in /js/plan-editor-controller.js; Plan Endurance lives in /js/plan-endurance-client.js.

function chatScreenRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function chatScreenRows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row): row is T => !!row && typeof row === "object") : [];
}

function chatScreenMessages(value: unknown): ChatScreenMessage[] {
  return chatScreenRows<ChatScreenMessage>(value);
}

function chatScreenString(value: unknown): string {
  return value == null ? "" : String(value);
}

// ---------- Chat ----------
// Document-level paste listener for the chat view; swapped on every renderChat.
let chatPasteHandler: ((event: ClipboardEvent) => void) | null = null;
let chatFuelContext: ChatScreenMessage[] = [];

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
  return CairnChatClient.wantsFuelSurface(messages, { todayISO: localISO(), dayISO: chatDayISO });
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

function chatHeaderDeps(): ChatHeaderControllerDeps {
  return {
    state,
    currentToken: () => pollToken,
    clearFuelContext: () => { chatFuelContext = []; },
    drawEmptyChat: () => drawChat([]),
    enqueueJob,
    openJobStream,
    openChatHistory,
  };
}

async function renderChat(): Promise<void> {
  headerTitle.textContent = "Chat";
  document.body.classList.add("chat-mode"); // the chat column owns the viewport; drop body's tab-bar padding
  chatTeardownMonitor(); // the log is about to be rebuilt -- drop the old stream + bubble map
  const token = ++pollToken; // bump so the async hydrate below can detect a stale tab
  const { freshBtn } = CairnChatHeaderController.ensureChatHeaderBtns(chatHeaderDeps());
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

  const isChatActive = () => state.tab === "chat";
  const isSoftKeyboardChat = () => !matchMedia("(hover:hover)").matches;
  const isChatKeyboardGeometryOpen = () => document.body.classList.contains("kb-geometry-open");
  const resetChatFocusAfterNativePicker = () => CairnChatAttachment.resetFocusAfterNativePicker({
    input,
    fileInput,
    isSoftKeyboard: isSoftKeyboardChat,
  });
  const settleChatAfterNativePicker = () => CairnChatAttachment.settleAfterNativePicker({
    isActive: isChatActive,
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
  // Re-pin the column across the whole keyboard slide, and recover stale iOS
  // textarea focus from the next real tap after a native image picker closes.
  CairnChatComposerFocus.wireFocus({
    input,
    isActive: isChatActive,
    isSoftKeyboard: isSoftKeyboardChat,
    isKeyboardGeometryOpen: isChatKeyboardGeometryOpen,
    measure: measureChatTop,
  });
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
    const iso = chatDayISO(m.created_at);
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

Object.assign(globalThis, {
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
// Static chat message rendering lives in /js/chat-message-client.js.
// ============================================================================

// ============================================================================
// Chat history/search helpers live in /js/chat-history-client.js.
// ============================================================================
