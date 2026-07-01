(() => {
// @ts-check
// Chat composer focus recovery for mobile native pickers and soft keyboards.
// Kept out of chat-screen so the iOS/Android tap sequence is explicit and testable.
function chatComposerSettleViewport(options) {
    const raf = options.requestFrame || requestAnimationFrame;
    const timer = options.setTimer || setTimeout;
    options.measure();
    raf(() => raf(options.measure));
    for (const delay of [80, 160, 260, 380, 520]) {
        timer(() => { if (options.isActive())
            options.measure(); }, delay);
    }
}
function chatComposerFocusInput(input) {
    try {
        input.focus({ preventScroll: true });
    }
    catch {
        input.focus();
    }
}
function chatComposerReleaseStaleInputFocus(options) {
    // Never blur on pointerdown. The old blur-then-refocus-within-one-tap (blur here,
    // refocus on pointerup) flickered the keyboard; worse, a stale "geometry closed"
    // read blurred a composer whose keyboard was actually up. Recovery is refocus-only
    // (recoverInputFocusFromTap on pointerup/click); this just re-measures the column.
    options.measure();
}
function chatComposerRecoverInputFocusFromTap(options) {
    if (!options.isSoftKeyboard() || !options.isActive() || !options.input.isConnected)
        return;
    chatComposerFocusInput(options.input);
    chatComposerSettleViewport({
        isActive: options.isActive,
        measure: options.measure,
        requestFrame: options.requestFrame,
        setTimer: options.setTimer,
    });
}
function chatComposerWireFocus(options) {
    const settleViewport = () => chatComposerSettleViewport(options);
    const releaseStaleInputFocus = () => chatComposerReleaseStaleInputFocus(options);
    const recoverInputFocusFromTap = () => chatComposerRecoverInputFocusFromTap(options);
    options.input.addEventListener("pointerdown", releaseStaleInputFocus);
    options.input.addEventListener("pointerup", recoverInputFocusFromTap, { passive: true });
    options.input.addEventListener("click", recoverInputFocusFromTap);
    for (const ev of ["focus", "blur"])
        options.input.addEventListener(ev, settleViewport);
    return { releaseStaleInputFocus, recoverInputFocusFromTap, settleViewport };
}
const CAIRN_CHAT_COMPOSER_FOCUS = {
    focusInput: chatComposerFocusInput,
    releaseStaleInputFocus: chatComposerReleaseStaleInputFocus,
    recoverInputFocusFromTap: chatComposerRecoverInputFocusFromTap,
    settleViewport: chatComposerSettleViewport,
    wireFocus: chatComposerWireFocus,
};
Object.assign(globalThis, { CairnChatComposerFocus: CAIRN_CHAT_COMPOSER_FOCUS });
if (typeof window !== "undefined") {
    window.CairnChatComposerFocus = CAIRN_CHAT_COMPOSER_FOCUS;
}
})();
