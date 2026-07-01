(() => {
// @ts-check
// ==== 09-plan-chat.js ====
// Plan editor and Plan Endurance screen orchestration live in /js/plan-editor-client.js and /js/plan-endurance-client.js.
function chatScreenRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function chatScreenRows(value) {
    return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
}
function chatScreenMessages(value) {
    return chatScreenRows(value);
}
function chatScreenString(value) {
    return value == null ? "" : String(value);
}
function chatScreenHtml(value) {
    return value instanceof HTMLElement ? value : null;
}
// ---------- Chat ----------
// Document-level paste listener for the chat view; swapped on every renderChat.
let chatPasteHandler = null;
let chatFuelContext = [];
// Starter chips shown while the conversation is empty (fresh chat / after a
// fresh start); tapping one prefills the input and sends through the normal
// send path. They vanish as soon as the first message lands (appendMsg removes them).
function drawChatChips(log) {
    const template = document.createElement("template");
    template.innerHTML = CairnChatClient.starterChipsHtml().trim();
    const wrap = template.content.firstElementChild;
    if (!wrap)
        return;
    log.appendChild(wrap);
    wrap.querySelectorAll(".chat-chip").forEach((b) => b.addEventListener("click", () => {
        const input = $("#chatInput");
        if (!input)
            return;
        input.value = b.textContent || "";
        const send = $("#chatSend");
        if (send)
            send.click();
    }));
}
// Chat gets the logged-food glance only when the active thread is already about
// food capture or today's fuel. The durable food log still feeds the coach prompt
// everywhere; this UI guard keeps broad health/nutrition chats from carrying a
// persistent food banner.
function chatScreenMessageHasFoodAction(m) {
    return CairnChatClient.messageHasFoodAction(m);
}
function chatScreenUserMessageSuggestsFood(m) {
    return CairnChatClient.userMessageSuggestsFood(m);
}
function chatScreenWantsFuelSurface(messages = chatFuelContext) {
    return CairnChatClient.wantsFuelSurface(messages, { todayISO: localISO(), dayISO: chatDayISO });
}
function rememberChatFuelContext(...msgs) {
    const next = [...chatFuelContext, ...msgs.filter((msg) => !!msg && typeof msg === "object")];
    chatFuelContext = next.slice(-24);
    return chatFuelContext;
}
// Expand the collapsed history block at the top of the chat log: smooth
// max-height + fade per the motion rules, while keeping the messages the
// athlete is looking at visually still. Anchoring re-measures the first
// visible element every frame (rather than accumulating deltas), so scroll
// clamping while the scroller is still shorter than its viewport self-corrects.
function expandChatEarlier(log, bar, block) {
    const logTop = log.getBoundingClientRect().top;
    const anchor = [...log.children].find((el) => el !== bar && el !== block && el.getBoundingClientRect().bottom > logTop) || null;
    const anchorY = anchor ? anchor.getBoundingClientRect().top : 0;
    const keep = () => { if (anchor)
        log.scrollTop += anchor.getBoundingClientRect().top - anchorY; };
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
    const step = (t) => {
        if (!block.isConnected)
            return;
        keep();
        if (t - t0 < 600) {
            requestAnimationFrame(step);
            return;
        } // --dur-3 + settle
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
function ensureChatHeaderBtns() {
    document.getElementById("hdrChatActions")?.remove();
    const template = document.createElement("template");
    template.innerHTML = CairnChatClient.headerActionsHtml().trim();
    const wrap = template.content.firstElementChild;
    const hist = chatScreenHtml(wrap?.querySelector("#hdrHistory"));
    const b = chatScreenHtml(wrap?.querySelector("#hdrFresh"));
    if (!wrap || !hist || !b)
        return { freshBtn: null, historyBtn: null };
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
    document.querySelector("header").appendChild(wrap);
    return { freshBtn: b, historyBtn: hist };
}
// POST /api/chat/reset -- non-blocking fresh start. The server ARCHIVES the live
// conversation at once (so the composer is usable instantly -- never disabled) and
// distills durable facts into memory in the BACKGROUND as a chat_distill job. We
// optimistically clear the log to an empty, fully-enabled composer, then settle a
// quiet "✓ N remembered" / "Fresh start" pill when the distill job lands. A message
// typed during the distill just queues as a normal chat turn (the server orders
// archive-before-turn). bg_ops OFF -> the response carries `distilled` inline.
async function chatFreshStart() {
    const log = $("#chatlog");
    if (!log || state.tab !== "chat")
        return;
    const token = pollToken; // any full re-render bumps this -- treat as stale
    const fresh = document.getElementById("hdrFresh");
    if (fresh)
        fresh.hidden = true; // the thread is empty now
    // Optimistic clear -- empty state + chips, composer stays fully enabled & focused.
    chatFuelContext = [];
    drawChat([]);
    const fuelSlot = $("#chatFuelSlot");
    if (fuelSlot)
        fuelSlot.innerHTML = "";
    const input = $("#chatInput");
    if (input && matchMedia("(hover:hover)").matches)
        input.focus();
    let r = null;
    try {
        r = chatScreenRecord(await enqueueJob("/chat/reset", {}));
    }
    catch {
        /* the archive happens server-side; a blip just means no pill */
        return;
    }
    if (token !== pollToken || state.tab !== "chat")
        return;
    // bg_ops OFF (legacy): the distilled count is already on the response -- settle now.
    if (!r || !r.distilling) {
        settleFreshPill(r && r.ok ? r.distilled : 0, token);
        return;
    }
    // bg_ops ON: stream the distill job; settle the pill on done. The job lives
    // server-side, so it survives a reload (a re-render's chatReconnect leaves the
    // turn stream alone; this pill is best-effort and simply won't reappear).
    const distilling = r.distilling;
    if (typeof distilling !== "string" && typeof distilling !== "number")
        return;
    openJobStream(distilling, {
        guard: () => state.tab !== "chat" || token !== pollToken,
        onDone: (result) => settleFreshPill(chatScreenRecord(result).ok ? chatScreenRecord(result).distilled : 0, token),
        onError: () => { },
        onCanceled: () => { },
    });
}
// A quiet, self-dismissing "✓ N remembered" / "Fresh start" pill in the chat header
// actions row -- stale-guarded on token + tab so it never lands on a navigated-away
// view. Replaces any prior pill so a fast double fresh-start doesn't stack.
function settleFreshPill(distilled, token) {
    if (token !== pollToken || state.tab !== "chat")
        return;
    const host = document.getElementById("hdrChatActions");
    if (!host)
        return;
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
function chatScreenFuelHtml(d) {
    return CairnChatClient.fuelHtml(d);
}
async function loadChatFuel(token, messages = chatFuelContext) {
    const slot = $("#chatFuelSlot");
    if (!slot)
        return;
    if (!chatScreenWantsFuelSurface(messages)) {
        slot.innerHTML = "";
        return;
    }
    let d = null;
    try {
        d = await api("/nutrition/day");
    }
    catch {
        slot.innerHTML = "";
        return;
    }
    if (token !== pollToken || state.tab !== "chat" || !slot.isConnected)
        return;
    slot.innerHTML = chatScreenFuelHtml(d);
    const card = slot.querySelector("#chatFuelCard");
    if (card)
        card.addEventListener("click", () => { state.planJump = "food"; activateTab("plan"); });
}
async function renderChat() {
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
    let attached = null;
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
    const attachFile = async (f) => {
        if (!f)
            return;
        try {
            attached = await CairnChatAttachment.compressImage(f);
            const img = CairnChatAttachment.previewImage(preview.querySelector("img"));
            if (img)
                img.src = attached.dataUrl;
            preview.hidden = false;
            attachBtn.classList.add("has-img");
        }
        catch (e) {
            const tooLarge = e instanceof Error && e.message === "image-too-large";
            toast(tooLarge ? "That photo is too large — try a closer crop." : "Couldn't read that image — try another.");
            clearAttach();
        }
        finally {
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
        if (f)
            void attachFile(f);
        else
            settleChatAfterNativePicker();
    });
    // Paste-an-image support (desktop screenshots, iOS "Copy Photo"). One live
    // handler at a time: re-renders swap it out, and it bails when chat isn't
    // the active tab so it never touches a stale DOM.
    if (chatPasteHandler)
        document.removeEventListener("paste", chatPasteHandler);
    chatPasteHandler = (e) => {
        if (state.tab !== "chat" || !input.isConnected)
            return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items)
            return;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it && it.kind === "file" && it.type.startsWith("image/")) {
                const f = it.getAsFile();
                if (f) {
                    e.preventDefault();
                    void attachFile(f);
                }
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
        if (!text && !img)
            return;
        input.value = "";
        autosizeChatInput(input); // collapse the composer back to one line
        saveChatDraft("");
        clearAttach();
        // Optimistic user bubble lands instantly (the server persists it too; a full
        // re-render later draws from server truth, so no duplicate).
        const userMsg = { role: "user", content: text || "(photo)", meta: img ? { image: img.dataUrl } : null };
        const userBubble = appendMsg(userMsg);
        rememberChatFuelContext(userMsg);
        void loadChatFuel(token);
        try {
            const body = { message: text };
            if (img) {
                body.image_base64 = img.base64;
                body.image_mime = img.mime;
            }
            const r = chatScreenRecord(await api("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
            if (r.turn) {
                spawnPendingBubble(r.turn);
                chatMonitorEnsure();
            }
            else
                appendMsg({ role: "assistant", content: chatScreenString(r.error) || "(no reply)" });
        }
        catch {
            // Couldn't even enqueue (offline): roll the optimistic bubble back and put
            // the text back in the composer so nothing is lost -- the offline banner says why.
            userBubble?.remove();
            if (!input.value) {
                input.value = text;
                saveChatDraft(text);
                autosizeChatInput(input);
            }
            toast("Couldn't send — check your connection");
        }
        finally {
            if (matchMedia("(hover:hover)").matches)
                input.focus();
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
    if (state.chatPrefill) {
        input.value = state.chatPrefill;
        state.chatPrefill = null;
        saveChatDraft(input.value);
    }
    else {
        const d = loadChatDraft();
        if (d)
            input.value = d;
    }
    autosizeChatInput(input); // fit a restored multi-line draft
    // desktop only -- on mobile, auto-focus pops the keyboard over half the view
    if (matchMedia("(hover:hover)").matches)
        input.focus();
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
    chatFuelContext = msgs.slice(-24);
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
