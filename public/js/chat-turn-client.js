// @ts-check
// ==== chat-turn-client.js ====
// Durable chat turns: queue monitor, SSE streaming markdown, cancellation,
// reconnect, jump-to-latest, draft storage, and chat viewport sizing.
(() => {
    const CHAT_DRAFT_KEY = "cairn.chat.draft";
    const root = globalThis;
    let chatStream = null;
    let chatStreamId = null;
    const chatPendingBubbles = new Map();
    const chatStreamText = new Map();
    const chatStreamRenderQueued = new Set();
    const chatStreamRenderVersion = new Map();
    const chatDoneTurns = new Set();
    function chatTurnRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function chatTurnRows(value) {
        return Array.isArray(value)
            ? value.filter((row) => !!row && typeof row === "object" && Number.isFinite(Number(row.id)))
            : [];
    }
    function turnId(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    function parseTurnEvent(event) {
        const data = event.data;
        if (typeof data !== "string" || !data)
            return null;
        try {
            const parsed = JSON.parse(data);
            return chatTurnRecord(parsed);
        }
        catch {
            return null;
        }
    }
    function saveChatDraft(value) {
        try {
            value ? localStorage.setItem(CHAT_DRAFT_KEY, value) : localStorage.removeItem(CHAT_DRAFT_KEY);
        }
        catch { }
    }
    function loadChatDraft() {
        try {
            return localStorage.getItem(CHAT_DRAFT_KEY) || "";
        }
        catch {
            return "";
        }
    }
    function chatPhaseCaption(turn) {
        if (!turn)
            return "Thinking…";
        if (turn.status === "queued")
            return "Queued";
        if (turn.phase === "applying")
            return "Saving…";
        return turn.image_url ? "Reading your plate…" : "Thinking…";
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
    function renderStreamMarkdown(id) {
        const el = chatPendingBubbles.get(id);
        if (!el || !el.isConnected || !el.classList.contains("streaming") || !chatStreamText.has(id))
            return;
        const body = el.querySelector(".stream-text");
        if (!(body instanceof HTMLElement))
            return;
        body.innerHTML = mdToHtml(chatStreamText.get(id) || "");
        const caret = document.createElement("span");
        caret.className = "stream-caret";
        caret.setAttribute("aria-hidden", "true");
        const last = body.lastElementChild;
        const inlineish = last && /^(P|H3|H4|H5|H6|LI|BLOCKQUOTE)$/i.test(last.tagName);
        (inlineish ? last : body).appendChild(caret);
    }
    function scheduleStreamMarkdown(id) {
        if (chatStreamRenderQueued.has(id))
            return;
        const version = chatStreamRenderVersion.get(id) || 0;
        chatStreamRenderQueued.add(id);
        requestAnimationFrame(() => {
            chatStreamRenderQueued.delete(id);
            if ((chatStreamRenderVersion.get(id) || 0) !== version)
                return;
            renderStreamMarkdown(id);
        });
    }
    function appendStreamDelta(id, text) {
        const chunk = typeof text === "string" ? text : "";
        if (!chunk)
            return;
        const el = ensureStreamingBubble(id);
        if (!el)
            return;
        chatStreamText.set(id, (chatStreamText.get(id) || "") + chunk);
        scheduleStreamMarkdown(id);
        const log = $("#chatlog");
        if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 200)
            log.scrollTop = log.scrollHeight;
    }
    function setTurnProgress(id, text) {
        const el = chatPendingBubbles.get(id);
        if (!el || !el.isConnected || el.classList.contains("streaming"))
            return;
        const clean = String(text || "").trim();
        if (clean)
            setPendingCaption(el, clean);
    }
    function resetStreamingBubble(id) {
        chatStreamText.delete(id);
        chatStreamRenderQueued.delete(id);
        chatStreamRenderVersion.set(id, (chatStreamRenderVersion.get(id) || 0) + 1);
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
        const el = makePendingBubble({ ...turn, id });
        const anchor = findChatMessageAnchor(log, turn.user_message_id);
        if (anchor && anchor.parentElement === log)
            anchor.after(el);
        else
            log.appendChild(el);
        chatPendingBubbles.set(id, el);
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
            chatStreamText.delete(id);
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
            chatStreamText.delete(id);
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
        if (chatStreamId === id)
            closeChatStream();
        chatMonitorEnsure();
    }
    function closeChatStream() {
        if (chatStream) {
            try {
                chatStream.close();
            }
            catch { }
        }
        chatStream = null;
        chatStreamId = null;
    }
    function chatTeardownMonitor() {
        closeChatStream();
        chatPendingBubbles.clear();
        chatStreamText.clear();
        chatStreamRenderQueued.clear();
        chatStreamRenderVersion.clear();
        chatDoneTurns.clear();
    }
    function chatMonitorEnsure() {
        if (chatStream || state.tab !== "chat")
            return;
        const ids = [...chatPendingBubbles.keys()]
            .filter((id) => chatPendingBubbles.get(id)?.isConnected)
            .sort((a, b) => a - b);
        if (!ids.length)
            return;
        chatOpenStream(ids[0]);
    }
    function streamTerminal(es) {
        if (chatStream === es)
            closeChatStream();
        else {
            try {
                es.close();
            }
            catch { }
        }
        chatMonitorEnsure();
    }
    function chatOpenStream(id) {
        chatStreamId = id;
        let es;
        try {
            es = new EventSource(withToken(`/api/chat/turns/${id}/stream`));
        }
        catch {
            chatStreamId = null;
            return;
        }
        chatStream = es;
        const guard = () => {
            if (state.tab === "chat" && document.getElementById("chatlog"))
                return false;
            if (chatStream === es)
                closeChatStream();
            else {
                try {
                    es.close();
                }
                catch { }
            }
            return true;
        };
        const phase = (turn) => {
            const el = chatPendingBubbles.get(id);
            if (el?.isConnected)
                setPendingCaption(el, chatPhaseCaption(chatTurnRecord(turn)));
        };
        es.addEventListener("snapshot", (event) => {
            if (guard())
                return;
            const row = parseTurnEvent(event);
            if (!row)
                return;
            const turn = chatTurnRecord(row.turn);
            if (turn.status && ["done", "error", "canceled"].includes(String(turn.status))) {
                if (turn.status === "canceled")
                    finalizeCanceled(turn);
                else
                    finalizeTurn(turn, row.message);
                streamTerminal(es);
                return;
            }
            phase(row.turn || row);
        });
        es.addEventListener("phase", (event) => { if (!guard())
            phase(parseTurnEvent(event)?.turn); });
        es.addEventListener("progress", (event) => { if (!guard())
            setTurnProgress(id, parseTurnEvent(event)?.text); });
        es.addEventListener("delta", (event) => { if (!guard())
            appendStreamDelta(id, parseTurnEvent(event)?.text); });
        es.addEventListener("reset", () => { if (!guard())
            resetStreamingBubble(id); });
        es.addEventListener("done", (event) => {
            if (guard())
                return;
            const row = parseTurnEvent(event);
            if (!row)
                return;
            finalizeTurn(row.turn, row.message);
            streamTerminal(es);
        });
        es.addEventListener("canceled", (event) => {
            if (guard())
                return;
            finalizeCanceled(parseTurnEvent(event)?.turn);
            streamTerminal(es);
        });
        es.addEventListener("error", (event) => {
            const data = event.data;
            if (!data)
                return;
            if (guard())
                return;
            const row = parseTurnEvent(event);
            if (!row)
                return;
            finalizeTurn(row.turn, row.message);
            streamTerminal(es);
        });
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
    function wireChatJump(log, jump) {
        if (!log || !jump)
            return;
        const update = () => {
            const off = log.scrollHeight - log.scrollTop - log.clientHeight;
            jump.hidden = off < 120;
        };
        log.addEventListener("scroll", update, { passive: true });
        jump.addEventListener("click", () => log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" }));
        update();
    }
    function autosizeChatInput(el) {
        if (!el)
            return;
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
    function measureChatTop() {
        const cv = document.querySelector(".chatview");
        if (!cv)
            return;
        if (cv.style.height)
            cv.style.height = "";
        const header = document.querySelector("header");
        const tab = document.querySelector(".tabbar");
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
        if (tab)
            rootEl.style.setProperty("--tabbar-h", `${Math.round(tab.getBoundingClientRect().height)}px`);
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
