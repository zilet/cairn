(() => {
// @ts-check
// ==== 09-plan-chat.js ====
// Plan editor orchestration lives in /js/plan-editor-controller.js; Plan Endurance lives in /js/plan-endurance-client.js.
function chatScreenRows(value) {
    return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
}
function chatScreenMessages(value) {
    return chatScreenRows(value);
}
// ---------- Chat ----------
function chatStarterChips() {
    return globalThis.CairnChatStarterChips;
}
function chatFuelContextApi() {
    return globalThis.CairnChatFuelContext;
}
function chatEarlierHistory() {
    return globalThis.CairnChatEarlierHistory;
}
// Starter chips shown while the conversation is empty (fresh chat / after a
// fresh start); tapping one prefills the input and sends through the normal
// send path. They vanish as soon as the first message lands (appendMsg removes them).
function drawChatChips(log) {
    chatStarterChips().draw(log);
}
// Chat gets the logged-food glance only when the active thread is already about
// food capture or today's fuel. The durable food log still feeds the coach prompt
// everywhere; this UI guard keeps broad health/nutrition chats from carrying a
// persistent food banner.
function chatScreenMessageHasFoodAction(m) {
    return chatFuelContextApi().messageHasFoodAction(m);
}
function chatScreenUserMessageSuggestsFood(m) {
    return chatFuelContextApi().userMessageSuggestsFood(m);
}
function chatScreenWantsFuelSurface(messages = chatFuelContextApi().current()) {
    return chatFuelContextApi().wants(messages);
}
function rememberChatFuelContext(...msgs) {
    return chatFuelContextApi().remember(...msgs);
}
// Expand the collapsed history block at the top of the chat log: smooth
// max-height + fade per the motion rules, while keeping the messages the
// user is looking at visually still. Anchoring re-measures the first
// visible element every frame (rather than accumulating deltas), so scroll
// clamping while the scroller is still shorter than its viewport self-corrects.
function expandChatEarlier(log, bar, block) {
    chatEarlierHistory().expand(log, bar, block);
}
function chatScreenFuelHtml(d) {
    return chatFuelContextApi().html(d);
}
async function loadChatFuel(token, messages = chatFuelContextApi().current()) {
    return chatFuelContextApi().load(token, messages, {
        currentToken: () => pollToken,
        currentTab: () => state.tab,
        openFoodReview: () => { state.planJump = "food"; activateTab("plan"); },
    });
}
function chatHeaderDeps() {
    return {
        state,
        currentToken: () => pollToken,
        clearFuelContext: () => chatFuelContextApi().clear(),
        drawEmptyChat: () => drawChat([]),
        enqueueJob,
        openJobStream,
        openChatHistory,
    };
}
async function renderChat() {
    headerTitle.textContent = "Chat";
    document.body.classList.add("chat-mode"); // the chat column owns the viewport; drop body's tab-bar padding
    chatTeardownMonitor(); // the log is about to be rebuilt -- drop the old stream + bubble map
    const token = ++pollToken; // bump so the async hydrate below can detect a stale tab
    const { freshBtn } = CairnChatHeaderController.ensureChatHeaderBtns(chatHeaderDeps());
    chatFuelContextApi().clear();
    // Paint the shell FIRST so the composer is usable instantly; the log hydrates
    // in the background. The flex viewport column keeps the composer pinned above
    // the tab bar no matter how the OS zooms (height is re-measured, not magic).
    view.innerHTML = CairnChatClient.shellHtml();
    const log = $("#chatlog");
    if (!log)
        return;
    log.innerHTML = loadingState("Catching up…");
    wireChatJump(log, $("#chatJump"));
    measureChatTop();
    requestAnimationFrame(measureChatTop); // re-measure once layout/fonts settle
    const input = $("#chatInput");
    const sendBtn = $("#chatSend");
    const fileInput = $("#chatFile");
    const attachBtn = $("#chatAttach");
    const preview = $("#chatPreview");
    if (!input || !sendBtn || !fileInput || !attachBtn || !preview)
        return;
    CairnChatComposerController.wire({
        token,
        state,
        input,
        sendBtn,
        fileInput,
        attachBtn,
        preview,
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
    // Hydrate the log in the background -- the shell above is already interactive.
    let msgs = [];
    try {
        msgs = chatScreenMessages(await api("/chat?limit=200"));
    }
    catch {
        msgs = [];
    }
    if (token !== pollToken || !log.isConnected)
        return; // navigated away / re-rendered
    if (freshBtn)
        freshBtn.hidden = !msgs.length;
    chatFuelContextApi().seed(msgs);
    drawChat(msgs);
    void loadChatFuel(token);
    // Rebuild any in-flight + queued turns from the server and resume streaming.
    void chatReconnect();
    if (state.pendingChatSession)
        openChatHistory({ session: state.pendingChatSession });
    requestAnimationFrame(measureChatTop);
}
function drawChat(msgs) {
    const log = $("#chatlog");
    if (!log)
        return;
    log.innerHTML = "";
    if (!msgs.length) {
        log.innerHTML = CairnChatClient.emptyHtml();
        drawChatChips(log);
        return;
    }
    // Group chronologically by local calendar day, splitting only at day
    // boundaries so dividers never duplicate across the collapse seam.
    const groups = [];
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
    if (!lastGroup)
        return;
    if (lastGroup.iso !== localISO()) {
        let count = lastGroup.msgs.length;
        while (cut > 0 && count < 12) {
            cut--;
            count += groups[cut].msgs.length;
        }
    }
    const earlier = groups.slice(0, cut);
    if (earlier.length) {
        const template = document.createElement("template");
        template.innerHTML = CairnChatClient.earlierBarHtml().trim();
        const bar = template.content.firstElementChild;
        if (!bar)
            return;
        log.appendChild(bar);
        const block = document.createElement("div");
        block.className = "chat-earlier";
        block.hidden = true;
        for (const g of earlier) {
            block.appendChild(chatDivider(g.iso));
            for (const m of g.msgs)
                appendMsg(m, true, block);
        }
        log.appendChild(block);
        bar.querySelector("button")?.addEventListener("click", () => expandChatEarlier(log, bar, block));
    }
    for (const g of groups.slice(cut)) {
        log.appendChild(chatDivider(g.iso));
        for (const m of g.msgs)
            appendMsg(m, true);
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
})();
