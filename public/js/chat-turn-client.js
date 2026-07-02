(() => {
// @ts-check
// ==== chat-turn-client.js ====
// Durable chat turns: queue monitor, SSE streaming markdown, cancellation,
// reconnect, jump-to-latest, draft storage, and chat viewport sizing.
(() => {
    const root = globalThis;
    const chatLayout = root.CairnChatLayout;
    const chatTurnRecords = root.CairnChatTurnRecords;
    const chatTurnRecord = chatTurnRecords.record;
    const chatTurnRows = chatTurnRecords.rows;
    const turnId = chatTurnRecords.id;
    const parseTurnEvent = chatTurnRecords.event;
    const chatPhaseCaption = chatTurnRecords.phaseCaption;
    const chatPendingBubbles = new Map();
    const chatDoneTurns = new Set();
    const chatTurnStreamState = root.CairnChatTurnStreamState.create({
        getBubble: (id) => chatPendingBubbles.get(id) || null,
        ensureStreamingBubble,
        markdownToHtml: mdToHtml,
        getLog: () => $("#chatlog"),
    });
    const wireChatJump = chatLayout.wireJump;
    const autosizeChatInput = chatLayout.autosizeInput;
    const measureChatTop = chatLayout.measureTop;
    const chatTurnMonitor = root.CairnChatTurnMonitor.create({
        isActive: () => state.tab === "chat",
        hasLog: () => !!document.getElementById("chatlog"),
        pendingIds: () => [...chatPendingBubbles.keys()]
            .filter((id) => chatPendingBubbles.get(id)?.isConnected),
        createStream: (id) => typeof EventSource !== "undefined" ? new EventSource(withToken(`/api/chat/turns/${id}/stream`)) : null,
        poll: (id) => api(`/chat/turns/${id}`),
        parse: parseTurnEvent,
        record: chatTurnRecord,
        phase: setTurnPhase,
        progress: setTurnProgress,
        delta: (id, text) => chatTurnStreamState.appendDelta(id, text),
        replace: replaceStreamingBubble,
        reset: resetStreamingBubble,
        finish: finalizeTurn,
        cancel: finalizeCanceled,
    });
    function saveChatDraft(value) {
        chatTurnRecords.saveDraft(value);
    }
    function loadChatDraft() {
        return chatTurnRecords.loadDraft();
    }
    function makePendingBubble(turn) {
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
    function setPendingCaption(el, text) {
        const cap = el?.querySelector(".typing-cap");
        if (!(cap instanceof HTMLElement))
            return;
        cap.textContent = `${String(text || "").trim() || "Thinking…"} `;
        if (!reducedMotion()) {
            cap.style.animation = "none";
            void cap.offsetWidth;
            cap.style.animation = "";
        }
    }
    function ensureStreamingBubble(id) {
        const el = chatPendingBubbles.get(id);
        if (!el || !el.isConnected)
            return null;
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
    function setTurnProgress(id, text) {
        const el = chatPendingBubbles.get(id);
        if (!el || !el.isConnected || el.classList.contains("streaming"))
            return;
        const clean = String(text || "").trim();
        if (clean)
            setPendingCaption(el, clean);
    }
    // Replace a streaming bubble's text wholesale from an SSE reconnect snapshot / poll
    // (Part B): an interrupted stream comes back filled with the server's streamed-so-far
    // prose instead of a hollow "Thinking…". No-op when there's nothing streamed yet.
    function replaceStreamingBubble(id, text) {
        const clean = String(text ?? "");
        if (!clean)
            return;
        chatTurnStreamState.setText(id, clean);
    }
    // A streamed reply's prose is already on screen; while its actions apply (seconds),
    // show a calm "Saving…" footer and drop the blinking caret so the wait isn't a
    // silent blink. Non-streaming (pending) bubbles keep the caption swap as before.
    function applyStreamStatus(el, text) {
        el.classList.toggle("streaming-applying", !!text);
        let note = el.querySelector(".stream-status");
        if (text) {
            if (!(note instanceof HTMLElement)) {
                note = document.createElement("span");
                note.className = "stream-status";
                note.setAttribute("role", "status");
                const stop = el.querySelector(".turn-stop");
                if (stop)
                    el.insertBefore(note, stop);
                else
                    el.appendChild(note);
            }
            note.textContent = text;
        }
        else if (note) {
            note.remove();
        }
    }
    function setTurnPhase(id, turnValue) {
        const el = chatPendingBubbles.get(id);
        if (!el?.isConnected)
            return;
        const caption = chatPhaseCaption(chatTurnRecord(turnValue));
        if (el.classList.contains("streaming")) {
            applyStreamStatus(el, caption === "Saving…" ? caption : "");
            return;
        }
        setPendingCaption(el, caption);
    }
    function resetStreamingBubble(id) {
        chatTurnStreamState.reset(id);
        const el = chatPendingBubbles.get(id);
        if (!el || !el.isConnected)
            return;
        el.classList.remove("streaming");
        el.classList.add("pending");
        el.setAttribute("aria-busy", "true");
        el.innerHTML =
            `<div class="bubble-text"><span class="typing-cap">Thinking… </span>` +
                `<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>` +
                `<button class="turn-stop" type="button" aria-label="Stop this turn">Stop</button></div>`;
        el.querySelector(".turn-stop")?.addEventListener("click", () => cancelTurn(id));
    }
    function findChatMessageAnchor(log, messageId) {
        const wanted = String(messageId || "");
        if (!wanted)
            return null;
        for (const candidate of log.querySelectorAll("[data-mid]")) {
            if (candidate.dataset.mid === wanted)
                return candidate;
        }
        return null;
    }
    function spawnPendingBubble(turnValue) {
        const row = chatTurnRecord(turnValue);
        const id = turnId(row.id);
        if (id == null)
            return null;
        const turn = row;
        const log = $("#chatlog");
        if (!log)
            return null;
        if (chatPendingBubbles.has(id))
            return chatPendingBubbles.get(id) || null;
        // Only follow to the bottom if the reader is already near it — a queued turn's
        // bubble appearing must never yank someone reading earlier messages (D6).
        const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 200;
        const el = makePendingBubble({ ...turn, id });
        const anchor = findChatMessageAnchor(log, turn.user_message_id);
        if (anchor && anchor.parentElement === log)
            anchor.after(el);
        else
            log.appendChild(el);
        chatPendingBubbles.set(id, el);
        if (stick)
            log.scrollTop = log.scrollHeight;
        return el;
    }
    function appendFinalMessage(message, before) {
        root.appendMsg?.(message, false, null, { before: before || null });
    }
    function finalizeTurn(turnValue, messageValue) {
        const row = chatTurnRecord(turnValue);
        const id = turnId(row.id);
        if (id != null) {
            if (chatDoneTurns.has(id))
                return;
            chatDoneTurns.add(id);
        }
        const el = id == null ? null : chatPendingBubbles.get(id);
        if (id != null) {
            chatPendingBubbles.delete(id);
            chatTurnStreamState.deleteTurn(id);
        }
        const message = messageValue && typeof messageValue === "object"
            ? messageValue
            : {
                role: "assistant",
                content: (typeof row.reply === "string" && row.reply) || (typeof row.error === "string" && row.error) || "(no reply)",
                meta: row.meta,
                created_at: row.finished_at,
                id: row.assistant_message_id,
            };
        appendFinalMessage(message, el);
        root.rememberChatFuelContext?.(message);
        if (el && el.isConnected)
            el.remove();
        const drafts = Array.isArray(chatTurnRecord(row.meta).drafts) ? chatTurnRecord(row.meta).drafts : [];
        if (drafts.length) {
            state.plan = [];
            toast("Draft ready — Apply below");
        }
        if (state.tab === "chat")
            root.loadChatFuel?.(pollToken);
    }
    function finalizeCanceled(turnValue) {
        const id = turnId(chatTurnRecord(turnValue).id);
        if (id != null) {
            if (chatDoneTurns.has(id))
                return;
            chatDoneTurns.add(id);
        }
        const el = id == null ? null : chatPendingBubbles.get(id);
        if (id != null) {
            chatPendingBubbles.delete(id);
            chatTurnStreamState.deleteTurn(id);
        }
        if (el && el.isConnected) {
            el.classList.remove("pending");
            el.removeAttribute("aria-busy");
            el.classList.add("turn-stopped");
            el.innerHTML = `<span class="turn-stopped-note">Stopped</span>`;
        }
    }
    async function cancelTurn(id) {
        let response = null;
        try {
            response = await api(`/chat/turns/${id}/cancel`, { method: "POST" });
        }
        catch { }
        finalizeCanceled(chatTurnRecord(response).turn || { id });
        if (chatTurnMonitor.currentId() === id)
            chatTurnMonitor.close();
        chatMonitorEnsure();
    }
    function chatTeardownMonitor() {
        chatTurnMonitor.close();
        chatPendingBubbles.clear();
        chatTurnStreamState.clear();
        chatDoneTurns.clear();
    }
    function chatMonitorEnsure() {
        chatTurnMonitor.ensure();
    }
    async function chatReconnect() {
        let turns = [];
        try {
            turns = chatTurnRows(await api("/chat/turns"));
        }
        catch {
            turns = [];
        }
        if (state.tab !== "chat" || !$("#chatlog"))
            return;
        for (const turn of turns)
            spawnPendingBubble(turn);
        chatMonitorEnsure();
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
})();
