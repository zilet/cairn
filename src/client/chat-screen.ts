// @ts-check
// ==== 09-plan-chat.js ====
// Plan editor orchestration lives in /js/plan-editor-controller.js; Plan Endurance lives in /js/plan-endurance-client.js.

function chatScreenRows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row): row is T => !!row && typeof row === "object") : [];
}

function chatScreenMessages(value: unknown): ChatScreenMessage[] {
  return chatScreenRows<ChatScreenMessage>(value);
}

const CHAT_LIVE_CACHE_KEY = "chat:live:limit:200";

function chatMessagesSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ---------- Chat ----------
function chatStarterChips(): ChatStarterChipsApi {
  return (globalThis as unknown as { CairnChatStarterChips: ChatStarterChipsApi }).CairnChatStarterChips;
}

function chatFuelContextApi(): ChatFuelContextApi {
  return (globalThis as unknown as { CairnChatFuelContext: ChatFuelContextApi }).CairnChatFuelContext;
}

function chatEarlierHistory(): ChatEarlierHistoryApi {
  return (globalThis as unknown as { CairnChatEarlierHistory: ChatEarlierHistoryApi }).CairnChatEarlierHistory;
}

// Starter chips shown while the conversation is empty (fresh chat / after a
// fresh start); tapping one prefills the input and sends through the normal
// send path. They vanish as soon as the first message lands (appendMsg removes them).
function drawChatChips(log: Element): void {
  chatStarterChips().draw(log);
}

// Chat gets the logged-food glance only when the active thread is already about
// food capture or today's fuel. The durable food log still feeds the coach prompt
// everywhere; this UI guard keeps broad health/nutrition chats from carrying a
// persistent food banner.
function chatScreenMessageHasFoodAction(m: Partial<ChatScreenMessage> | null | undefined): boolean {
  return chatFuelContextApi().messageHasFoodAction(m);
}

function chatScreenUserMessageSuggestsFood(m: Partial<ChatScreenMessage> | null | undefined): boolean {
  return chatFuelContextApi().userMessageSuggestsFood(m);
}

function chatScreenWantsFuelSurface(messages: Partial<ChatScreenMessage>[] = chatFuelContextApi().current()): boolean {
  return chatFuelContextApi().wants(messages);
}

function rememberChatFuelContext(...msgs: Array<Partial<ChatScreenMessage> | null | undefined>): ChatScreenMessage[] {
  return chatFuelContextApi().remember(...msgs);
}

// Expand the collapsed history block at the top of the chat log: smooth
// max-height + fade per the motion rules, while keeping the messages the
// user is looking at visually still. Anchoring re-measures the first
// visible element every frame (rather than accumulating deltas), so scroll
// clamping while the scroller is still shorter than its viewport self-corrects.
function expandChatEarlier(log: HTMLElement, bar: Element, block: HTMLElement): void {
  chatEarlierHistory().expand(log, bar, block);
}

function chatScreenFuelHtml(d: import("../contracts/client.js").ClientDayIntake | null | undefined): string {
  return chatFuelContextApi().html(d);
}

async function loadChatFuel(token: number, messages: Partial<ChatScreenMessage>[] = chatFuelContextApi().current()): Promise<void> {
  return chatFuelContextApi().load(token, messages, {
    currentToken: () => pollToken,
    currentTab: () => state.tab,
    openFoodReview: () => { state.planJump = "food"; activateTab("plan"); },
  });
}

// Ask's second room, the team's record of changes (ask/changes).
function openChatChanges(): void {
  state.planJump = "coach";
  activateTab("plan");
}

function chatSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

// The what-if ripple card's deps (ripple-card-controller.ts): the card lives inline at
// the foot of the thread, and "Talk it through" hands its question to the composer.
function chatRippleDeps(): ClientRippleCardDeps {
  return {
    api,
    toast,
    openJobStream,
    reducedMotion,
    openChanges: openChatChanges,
    talkItThrough: (question) => {
      const input = $<HTMLTextAreaElement>("#chatInput");
      if (!input) return;
      input.value = question;
      autosizeChatInput(input);
      input.focus();
    },
    isLive: () => state.tab === "chat",
    invalidate: swrInvalidate,
    storage: chatSessionStorage(),
    restoreEmpty: (log) => {
      log.innerHTML = CairnChatClient.emptyHtml();
      drawChatChips(log);
    },
  };
}

function openChatWhatIf(draft?: string): void {
  const log = $<HTMLElement>("#chatlog");
  if (!log) return;
  CairnRippleCardController.open(log, chatRippleDeps(), { draft });
}

function chatHeaderDeps(): ChatHeaderControllerDeps {
  return {
    state,
    currentToken: () => pollToken,
    clearFuelContext: () => chatFuelContextApi().clear(),
    drawEmptyChat: () => {
      swrSet(CHAT_LIVE_CACHE_KEY, []);
      drawChat([]);
    },
    enqueueJob,
    openJobStream,
    openChatHistory,
    openChanges: openChatChanges,
  };
}

async function renderChat(): Promise<void> {
  headerTitle.textContent = "Ask";
  document.body.classList.add("chat-mode"); // the chat column owns the viewport; drop body's tab-bar padding
  chatTeardownMonitor(); // the log is about to be rebuilt -- drop the old stream + bubble map
  const token = ++pollToken; // bump so the async hydrate below can detect a stale tab
  const { freshBtn } = CairnChatHeaderController.ensureChatHeaderBtns(chatHeaderDeps());
  chatFuelContextApi().clear();
  // Paint the shell FIRST so the composer is usable instantly; the log hydrates
  // in the background. The flex viewport column keeps the composer pinned above
  // the tab bar no matter how the OS zooms (height is re-measured, not magic).
  view.innerHTML = CairnChatClient.shellHtml();

  const log = $<HTMLElement>("#chatlog");
  if (!log) return;
  wireChatJump(log, $<HTMLElement>("#chatJump"));
  measureChatTop();
  requestAnimationFrame(measureChatTop); // re-measure once layout/fonts settle

  const input = $<HTMLTextAreaElement>("#chatInput");
  const sendBtn = $<HTMLButtonElement>("#chatSend");
  const fileInput = $<HTMLInputElement>("#chatFile");
  const attachBtn = $<HTMLButtonElement>("#chatAttach");
  const preview = $<HTMLElement>("#chatPreview");
  if (!input || !sendBtn || !fileInput || !attachBtn || !preview) return;
  // The one food composer, mounted on the shell's own composer markup: photo,
  // paste, press-to-talk dictation (hidden where Web Speech is absent) and the
  // "usual around now" prefill chips all come with it.
  CairnChatComposerController.wire({
    token,
    state,
    host: $<HTMLElement>(".chatdock"),
    input,
    sendBtn,
    fileInput,
    attachBtn,
    preview,
    mic: $<HTMLElement>("#chatMic"),
    freqSlot: $<HTMLElement>("#chatFreqSlot"),
    api,
    toast,
    appendMsg,
    rememberFuelContext: rememberChatFuelContext,
    loadFuel: loadChatFuel,
    saveDraft: saveChatDraft,
    loadDraft: loadChatDraft,
    autosizeInput: autosizeChatInput,
    measure: measureChatTop,
    spawnPendingBubble,
    ensureMonitor: chatMonitorEnsure,
  });
  // No AI coach connected: the composer gives way to one calm connect card, so a
  // message never ends in a "No agents enabled" error bubble.
  const dock = $<HTMLElement>(".chatdock");
  if (dock) CairnCoachLink.mountAsk(dock);

  const cachedMessages = peekCached<ChatScreenMessage[]>(CHAT_LIVE_CACHE_KEY);
  if (cachedMessages) {
    if (freshBtn) freshBtn.hidden = !cachedMessages.data.length;
    chatFuelContextApi().seed(cachedMessages.data);
    drawChat(cachedMessages.data);
    void loadChatFuel(token);
    if (!cachedMessages.fresh) markRefreshing(true);
  } else {
    log.innerHTML = loadingState("Catching up…");
  }

  // Hydrate the log in the background -- the shell above is already interactive.
  let msgs: ChatScreenMessage[] = [];
  let fetched = false;
  try {
    msgs = chatScreenMessages(await api("/chat?limit=200"));
    fetched = true;
  } catch {
    msgs = [];
  }
  if (token !== pollToken || !log.isConnected) return; // navigated away / re-rendered
  markRefreshing(false);
  // A what-if asked before this render (or before a trip to Changes) comes back, even
  // when the thread refresh failed and the cached thread stands.
  const resumeRipple = () => void CairnRippleCardController.resume(log, chatRippleDeps());
  if (!fetched && cachedMessages) return resumeRipple();
  swrSet(CHAT_LIVE_CACHE_KEY, msgs);
  if (freshBtn) freshBtn.hidden = !msgs.length;
  chatFuelContextApi().seed(msgs);
  if (!cachedMessages || !chatMessagesSame(cachedMessages.data, msgs)) drawChat(msgs);
  void loadChatFuel(token);
  // Rebuild any in-flight + queued turns from the server and resume streaming.
  void chatReconnect();
  resumeRipple();
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
    CairnRippleCardController.reattach(log);
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
  // The open what-if card stays at the foot of the rebuilt thread.
  CairnRippleCardController.reattach(log);
  log.scrollTop = log.scrollHeight;
}

Object.assign(globalThis, {
  chatFuelHtml: chatScreenFuelHtml,
  chatMessageHasFoodAction: chatScreenMessageHasFoodAction,
  chatUserMessageSuggestsFood: chatScreenUserMessageSuggestsFood,
  chatWantsFuelSurface: chatScreenWantsFuelSurface,
  drawChat,
  loadChatFuel,
  openChatWhatIf,
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
    openChatWhatIf,
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
