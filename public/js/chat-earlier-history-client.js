(() => {
// @ts-check
// Expansion behavior for the collapsed earlier-history block in Chat.
function expandChatEarlierHistory(log, bar, block) {
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
const CAIRN_CHAT_EARLIER_HISTORY = {
    expand: expandChatEarlierHistory,
};
Object.assign(globalThis, { CairnChatEarlierHistory: CAIRN_CHAT_EARLIER_HISTORY });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnChatEarlierHistory: CAIRN_CHAT_EARLIER_HISTORY });
}
})();
