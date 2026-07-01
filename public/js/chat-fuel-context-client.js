(() => {
// @ts-check
// Stateful fuel-context helper for the Chat surface.
let chatFuelContextMessages = [];
function chatFuelRows(messages) {
    return messages.filter((msg) => !!msg && typeof msg === "object");
}
function clearChatFuelContext() {
    chatFuelContextMessages = [];
}
function currentChatFuelContext() {
    return chatFuelContextMessages;
}
function seedChatFuelContext(messages) {
    chatFuelContextMessages = chatFuelRows(messages).slice(-24);
    return chatFuelContextMessages;
}
function rememberChatFuelContextValue(...msgs) {
    const next = [...chatFuelContextMessages, ...msgs.filter((msg) => !!msg && typeof msg === "object")];
    chatFuelContextMessages = next.slice(-24);
    return chatFuelContextMessages;
}
function chatFuelMessageHasFoodAction(m) {
    return CairnChatClient.messageHasFoodAction(m);
}
function chatFuelUserMessageSuggestsFood(m) {
    return CairnChatClient.userMessageSuggestsFood(m);
}
function chatFuelWantsSurface(messages = chatFuelContextMessages) {
    return CairnChatClient.wantsFuelSurface(messages, { todayISO: localISO(), dayISO: chatDayISO });
}
function chatFuelSurfaceHtml(d) {
    return CairnChatClient.fuelHtml(d);
}
async function loadChatFuelContext(token, messages, deps) {
    const slot = $("#chatFuelSlot");
    if (!slot)
        return;
    if (!chatFuelWantsSurface(messages || chatFuelContextMessages)) {
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
    if (token !== deps.currentToken() || deps.currentTab() !== "chat" || !slot.isConnected)
        return;
    slot.innerHTML = chatFuelSurfaceHtml(d);
    const card = slot.querySelector("#chatFuelCard");
    if (card)
        card.addEventListener("click", deps.openFoodReview);
}
const CAIRN_CHAT_FUEL_CONTEXT = {
    clear: clearChatFuelContext,
    current: currentChatFuelContext,
    seed: seedChatFuelContext,
    remember: rememberChatFuelContextValue,
    messageHasFoodAction: chatFuelMessageHasFoodAction,
    userMessageSuggestsFood: chatFuelUserMessageSuggestsFood,
    wants: chatFuelWantsSurface,
    html: chatFuelSurfaceHtml,
    load: loadChatFuelContext,
};
Object.assign(globalThis, { CairnChatFuelContext: CAIRN_CHAT_FUEL_CONTEXT });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnChatFuelContext: CAIRN_CHAT_FUEL_CONTEXT });
}
})();
