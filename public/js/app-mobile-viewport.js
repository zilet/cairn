(() => {
// @ts-check
{
    let installed = false;
    function installMobileViewportGuards() {
        if (installed)
            return;
        installed = true;
        // Keep the bottom-fixed UI (tab bar, rest timer, toast) clear of the mobile
        // browser's bottom toolbar. iOS Safari anchors position:fixed;bottom:0 to the
        // full layout viewport, so a visible address/tool bar overlaps the tab bar and
        // clips its labels (env(safe-area-inset-bottom) is 0 in a normal tab, only the
        // installed PWA gets it). visualViewport tells us how much layout viewport is
        // hidden at the bottom; we lift everything by that much via the --vvb variable.
        // Re-measure the chat column whenever the viewport shifts (zoom, keyboard,
        // orientation, window resize). Cheap and idempotent — bails immediately when
        // Chat isn't on screen.
        const syncChatViewport = () => { if (state.tab === "chat")
            measureChatTop(); };
        window.addEventListener("resize", syncChatViewport);
        window.addEventListener("orientationchange", syncChatViewport);
        const vv = window.visualViewport;
        if (!vv)
            return;
        const root = document.documentElement;
        // On touch devices, focus/tap is useful as an early "keyboard requested" signal,
        // but it is not durable truth: iOS can dismiss the keyboard while keeping the
        // textarea focused. The lasting state comes from visualViewport geometry. Compare
        // both innerHeight-vs-vv.height (Safari tab) and vvMax-vs-vv.height (installed
        // PWA, where the layout viewport can shrink with the visual viewport). Pointer
        // devices are excluded from the intent path so desktop chat auto-focus does not
        // briefly hide the bottom bar.
        const TEXTY = /^(|text|search|email|url|tel|password|number)$/;
        const softKeyboard = () => !matchMedia("(hover:hover)").matches;
        const textInputEl = (el) => {
            if (!(el instanceof Element) || el === document.body)
                return false;
            if (el.tagName === "TEXTAREA")
                return true;
            if (el.tagName === "INPUT")
                return TEXTY.test((el.getAttribute("type") || "").toLowerCase());
            return el instanceof HTMLElement && el.isContentEditable === true;
        };
        const focusedTextInput = () => softKeyboard() && textInputEl(document.activeElement);
        // The tallest visual viewport seen this orientation approximates the no-keyboard
        // height. Used to tell "keyboard is actually on screen" from "keyboard is gone"
        // in both Safari tabs and installed PWAs.
        let vvMax = vv.height;
        let keyboardIntentUntil = 0;
        let chatFocusGraceUntil = 0;
        let settleTimer = 0;
        let staleChatFocusTimer = 0;
        let geometryWasOpen = false;
        const keyboardThreshold = () => Math.max(140, window.innerHeight * 0.18);
        const keyboardGeometryOpen = () => {
            const layoutShrink = Math.max(0, window.innerHeight - vv.height);
            const visualShrink = Math.max(0, vvMax - vv.height);
            return Math.max(layoutShrink, visualShrink) > keyboardThreshold();
        };
        const keyboardIntentOpen = () => Date.now() < keyboardIntentUntil;
        const isChatTextInput = (el) => textInputEl(el) && Boolean(el.closest?.(".chatview"));
        const releaseStaleChatFocus = () => {
            const el = document.activeElement;
            if (!softKeyboard() || !textInputEl(el))
                return;
            if (!document.body.classList.contains("chat-mode") || !el.closest?.(".chatview"))
                return;
            if (Date.now() < chatFocusGraceUntil)
                return;
            el.blur();
        };
        const scheduleStaleChatFocusRelease = () => {
            if (staleChatFocusTimer)
                clearTimeout(staleChatFocusTimer);
            const delay = Math.max(0, chatFocusGraceUntil - Date.now() + 20);
            staleChatFocusTimer = setTimeout(() => {
                staleChatFocusTimer = 0;
                if (!keyboardGeometryOpen()) {
                    chatFocusGraceUntil = 0;
                    releaseStaleChatFocus();
                    syncChatViewport();
                }
            }, delay);
        };
        const settle = (long = false) => {
            if (settleTimer)
                clearTimeout(settleTimer);
            settleTimer = setTimeout(sync, long ? 960 : 420);
        };
        const requestKeyboard = (target = document.activeElement) => {
            if (!softKeyboard())
                return;
            const isChatTarget = isChatTextInput(target);
            keyboardIntentUntil = Date.now() + (isChatTarget ? 1500 : 900);
            if (isChatTarget)
                chatFocusGraceUntil = Date.now() + 1700;
            sync();
            settle(true);
        };
        const applyVvb = (kbOpen) => {
            // Pin the fixed bottom bars to the VISUAL viewport's bottom edge:
            // settled PWA -> 0; browser tab with a bottom toolbar -> positive.
            // Keyboard open -> 0 because chat hides the bar behind the keyboard anyway.
            const rawVvb = window.innerHeight - (vv.offsetTop + vv.height);
            const vvb = kbOpen ? 0 : Math.max(0, rawVvb);
            root.style.setProperty("--vvb", `${Math.round(vvb)}px`);
        };
        const sync = () => {
            if (vv.height > vvMax)
                vvMax = vv.height;
            const geometryOpen = keyboardGeometryOpen();
            if (geometryOpen)
                keyboardIntentUntil = 0;
            const kbOpen = geometryOpen || keyboardIntentOpen();
            document.body.classList.toggle("kb-geometry-open", geometryOpen);
            document.body.classList.toggle("kb-open", kbOpen);
            applyVvb(kbOpen);
            syncChatViewport();
            // iOS can dismiss the keyboard without blurring the textarea. Release stale
            // chat focus once geometry says the keyboard is gone.
            if (geometryOpen)
                geometryWasOpen = true;
            if (!kbOpen && geometryWasOpen) {
                geometryWasOpen = false;
                releaseStaleChatFocus();
            }
        };
        vv.addEventListener("resize", sync);
        vv.addEventListener("scroll", sync); // keyboard open/close shifts offsetTop
        window.addEventListener("orientationchange", () => { vvMax = vv.height; sync(); });
        // Focus/tap is an early intent signal, not proof that the keyboard is open.
        document.addEventListener("pointerdown", (e) => { if (textInputEl(e.target))
            requestKeyboard(e.target); }, true);
        document.addEventListener("focusin", (e) => { if (focusedTextInput())
            requestKeyboard(e.target);
        else
            sync(); }, true);
        document.addEventListener("focusout", () => {
            sync();
            requestAnimationFrame(() => requestAnimationFrame(sync));
            setTimeout(sync, 300);
        }, true);
        // Resume paths can leave visualViewport metrics stale; re-measure after pageshow,
        // focus, app-visible, and explicit chat keyboard-settle notifications.
        const resync = () => { sync(); requestAnimationFrame(() => requestAnimationFrame(sync)); };
        window.addEventListener("pageshow", resync);
        window.addEventListener("focus", resync);
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible")
            resync(); });
        document.addEventListener("cairn:keyboard-settle", (event) => {
            const detail = event instanceof CustomEvent && event.detail && typeof event.detail === "object"
                ? event.detail
                : null;
            const chatFocusGraceMs = Number(detail?.chatFocusGraceMs) || 0;
            if (chatFocusGraceMs > 0) {
                chatFocusGraceUntil = Math.max(chatFocusGraceUntil, Date.now() + Math.min(chatFocusGraceMs, 2400));
                scheduleStaleChatFocusRelease();
            }
            keyboardIntentUntil = 0;
            resync();
            settle(true);
        });
        sync();
    }
    Object.assign(globalThis, { installMobileViewportGuards });
    if (typeof window !== "undefined") {
        window.installMobileViewportGuards = installMobileViewportGuards;
    }
}
})();
