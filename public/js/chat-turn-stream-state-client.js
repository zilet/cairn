(() => {
// @ts-check
// SSE chat-turn stream text state and markdown render scheduling.
function createChatTurnStreamState(deps) {
    const streamText = new Map();
    const renderQueued = new Set();
    const renderVersion = new Map();
    const raf = deps.requestFrame || requestAnimationFrame;
    const doc = deps.document || document;
    function renderStreamMarkdown(id) {
        const el = deps.getBubble(id);
        if (!el || !el.isConnected || !el.classList.contains("streaming") || !streamText.has(id))
            return;
        const body = el.querySelector(".stream-text");
        if (!(body instanceof HTMLElement))
            return;
        // Measure proximity from the CURRENTLY PAINTED state, then grow the DOM, then
        // pin — so the scroll follows the render by one atomic step instead of running
        // a frame ahead of it (which left the caret drifting below the fold). A user
        // who scrolled up to read (>200px off the bottom) is never yanked down.
        const log = deps.getLog();
        const stick = !!log && log.scrollHeight - log.scrollTop - log.clientHeight < 200;
        body.innerHTML = deps.markdownToHtml(streamText.get(id) || "");
        const caret = doc.createElement("span");
        caret.className = "stream-caret";
        caret.setAttribute("aria-hidden", "true");
        const last = body.lastElementChild;
        const inlineish = last && /^(P|H3|H4|H5|H6|LI|BLOCKQUOTE)$/i.test(last.tagName);
        (inlineish ? last : body).appendChild(caret);
        if (log && stick)
            log.scrollTop = log.scrollHeight;
    }
    function scheduleStreamMarkdown(id) {
        if (renderQueued.has(id))
            return;
        const version = renderVersion.get(id) || 0;
        renderQueued.add(id);
        raf(() => {
            renderQueued.delete(id);
            if ((renderVersion.get(id) || 0) !== version)
                return;
            renderStreamMarkdown(id);
        });
    }
    function appendDelta(id, text) {
        const chunk = typeof text === "string" ? text : "";
        if (!chunk)
            return;
        const el = deps.ensureStreamingBubble(id);
        if (!el)
            return;
        streamText.set(id, (streamText.get(id) || "") + chunk);
        scheduleStreamMarkdown(id); // render + scroll-pin happen together, next frame
    }
    // REPLACE the streamed text wholesale (SSE reconnect snapshot / poll fallback):
    // an interrupted stream is handed the server's streamed-so-far prose so the
    // bubble is rebuilt filled, not appended-to on top of a partial it may already show.
    function setText(id, text) {
        const el = deps.ensureStreamingBubble(id);
        if (!el)
            return;
        streamText.set(id, typeof text === "string" ? text : "");
        scheduleStreamMarkdown(id);
    }
    function clear() {
        streamText.clear();
        renderQueued.clear();
        renderVersion.clear();
    }
    function deleteTurn(id) {
        streamText.delete(id);
    }
    function reset(id) {
        streamText.delete(id);
        renderQueued.delete(id);
        renderVersion.set(id, (renderVersion.get(id) || 0) + 1);
    }
    return { appendDelta, setText, clear, deleteTurn, reset };
}
const CAIRN_CHAT_TURN_STREAM_STATE = {
    create: createChatTurnStreamState,
};
Object.assign(globalThis, { CairnChatTurnStreamState: CAIRN_CHAT_TURN_STREAM_STATE });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnChatTurnStreamState: CAIRN_CHAT_TURN_STREAM_STATE });
}
})();
