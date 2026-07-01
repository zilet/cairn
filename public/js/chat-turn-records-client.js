(() => {
// @ts-check
// Durable chat-turn record normalization, SSE event parsing, draft storage, and status captions.
const CHAT_TURN_DRAFT_KEY = "cairn.chat.draft";
function chatTurnRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function chatTurnRows(value) {
    return Array.isArray(value)
        ? value.filter((row) => !!row && typeof row === "object" && Number.isFinite(Number(row.id)))
        : [];
}
function chatTurnId(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function parseChatTurnEvent(event) {
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
function saveChatTurnDraft(value) {
    try {
        value ? localStorage.setItem(CHAT_TURN_DRAFT_KEY, value) : localStorage.removeItem(CHAT_TURN_DRAFT_KEY);
    }
    catch { }
}
function loadChatTurnDraft() {
    try {
        return localStorage.getItem(CHAT_TURN_DRAFT_KEY) || "";
    }
    catch {
        return "";
    }
}
function chatTurnPhaseCaption(turn) {
    if (!turn)
        return "Thinking…";
    if (turn.status === "queued")
        return "Queued";
    if (turn.phase === "applying")
        return "Saving…";
    return turn.image_url ? "Reading your plate…" : "Thinking…";
}
const CAIRN_CHAT_TURN_RECORDS = {
    event: parseChatTurnEvent,
    id: chatTurnId,
    loadDraft: loadChatTurnDraft,
    phaseCaption: chatTurnPhaseCaption,
    record: chatTurnRecord,
    rows: chatTurnRows,
    saveDraft: saveChatTurnDraft,
};
Object.assign(globalThis, { CairnChatTurnRecords: CAIRN_CHAT_TURN_RECORDS });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnChatTurnRecords: CAIRN_CHAT_TURN_RECORDS });
}
})();
