(() => {
// @ts-check
// Starter chips for the empty Chat surface.
function drawChatStarterChips(log) {
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
const CAIRN_CHAT_STARTER_CHIPS = {
    draw: drawChatStarterChips,
};
Object.assign(globalThis, { CairnChatStarterChips: CAIRN_CHAT_STARTER_CHIPS });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnChatStarterChips: CAIRN_CHAT_STARTER_CHIPS });
}
})();
