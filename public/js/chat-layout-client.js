(() => {
// @ts-check
// ==== chat-layout-client.js ====
// Chat viewport measurement, jump-to-latest wiring, and composer autosize.
(() => {
    // D6 · 200px proximity: is the reader parked on the newest message? Tracked off the
    // log's own scroll (below) so it reflects real reader INTENT, and read by
    // measureChatTop when the keyboard lifts the column — so we re-pin to the latest
    // turn only for someone already at the bottom, never yanking a reader scrolled up.
    let chatNearBottom = true;
    function wireChatJump(log, jump) {
        if (!log || !jump)
            return;
        const update = () => {
            const off = log.scrollHeight - log.scrollTop - log.clientHeight;
            chatNearBottom = off < 200;
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
        // Keyboard up: CSS lifts the column onto the keyboard top (bottom:var(--vvb)),
        // which shrinks the log by the occluded height and can drop the newest turn below
        // the fold. Re-pin to the bottom when the reader was already there (chatNearBottom),
        // so the latest message + composer stay in view above the keyboard while composing;
        // someone scrolled up to re-read is left where they are. Runs on every viewport sync
        // (measureChatTop is the guard's chat hook), so it also follows the keyboard's ramp.
        if (chatNearBottom && document.body.classList.contains("kb-geometry-open")) {
            const log = document.querySelector("#chatlog");
            if (log)
                log.scrollTop = log.scrollHeight;
        }
    }
    const CAIRN_CHAT_LAYOUT = {
        wireJump: wireChatJump,
        autosizeInput: autosizeChatInput,
        measureTop: measureChatTop,
    };
    Object.assign(globalThis, { CairnChatLayout: CAIRN_CHAT_LAYOUT });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnChatLayout: CAIRN_CHAT_LAYOUT });
    }
})();
})();
