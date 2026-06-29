// @ts-check
// Pure chat helpers for the vanilla PWA.
const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_IMAGE_EDGE_STEPS = [1280, 1024, 768];
const CHAT_IMAGE_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52];
const CHAT_FOOD_RE = /\b(food|meal|meals|breakfast|lunch|dinner|snack|plate|bowl|ate|eaten|eating|calor(?:y|ies)|kcal|macro|macros|protein|carb|carbs|fiber|fuel|refuel|grams?|ounces?|oz|serving|portion|recipe|restaurant|menu|label|logged?|logging)\b/i;
const CHAT_NON_FOOD_PHOTO_RE = /\b(physique|body|mirror|pose|form|equipment|bike|run|shoe|injur(?:y|ed)?|pain|dexa|scan|lab|blood|chart|screenshot)\b/i;
const CHAT_FOOD_ACTION_TYPES = new Set(["log_food", "update_food_note"]);
const HIST_CHEV = `<span class="chat-hist-chev" aria-hidden="true">›</span>`;
function chatMeta(value) {
    return value && typeof value === "object" ? value : {};
}
function base64DecodedBytes(base64) {
    const source = String(base64 || "").replace(/\s/g, "");
    const pad = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((source.length * 3) / 4) - pad);
}
function chatImagePayload(dataUrl) {
    const full = String(dataUrl || "");
    const base64 = full.split(",")[1] || "";
    return { dataUrl: full, base64, mime: "image/jpeg", bytes: base64DecodedBytes(base64) };
}
function chatDayISO(timestamp, localISO) {
    if (!timestamp)
        return localISO();
    const date = new Date(`${String(timestamp).replace(" ", "T")}Z`);
    return Number.isNaN(date.getTime()) ? localISO() : localISO(date);
}
function chatMessageHasFoodAction(message) {
    if (!message)
        return false;
    const meta = chatMeta(message.meta);
    return Array.isArray(meta.applied) && meta.applied.some((action) => CHAT_FOOD_ACTION_TYPES.has(String(action?.type || "")));
}
function chatUserMessageSuggestsFood(message) {
    if (!message || String(message.role || "") !== "user")
        return false;
    const content = String(message.content || "");
    const meta = chatMeta(message.meta);
    if (CHAT_FOOD_RE.test(content))
        return true;
    if (meta.image && (!content || content === "(photo)" || !CHAT_NON_FOOD_PHOTO_RE.test(content)))
        return true;
    return false;
}
function chatWantsFuelSurface(messages, options) {
    const recentToday = (Array.isArray(messages) ? messages : [])
        .filter((message) => !message?.created_at || options.dayISO(message.created_at) === options.todayISO)
        .slice(-12);
    let latestUserIdx = -1;
    for (let index = recentToday.length - 1; index >= 0; index--) {
        if (String(recentToday[index]?.role || "") === "user") {
            latestUserIdx = index;
            break;
        }
    }
    if (latestUserIdx < 0)
        return false;
    const latestUser = recentToday[latestUserIdx];
    const sinceLatestUser = recentToday.slice(latestUserIdx);
    return chatUserMessageSuggestsFood(latestUser) || sinceLatestUser.some(chatMessageHasFoodAction);
}
function chatFuelHtml(day) {
    const count = Number(day?.count) || 0;
    if (!count)
        return "";
    const totals = day?.totals || {};
    const kcal = Math.round(Number(totals.kcal) || 0);
    const protein = Math.round(Number(totals.protein_g) || 0);
    let remaining = "";
    if (day?.remaining && day.target) {
        const left = Math.round(Number(day.remaining.kcal));
        remaining = left > 0 ? ` · ~${left.toLocaleString()} left` : " · fuel's in";
    }
    return `<button id="chatFuelCard" class="chatfuel-card" type="button" title="Review &amp; edit today's food">
      <span class="chatfuel-mark" aria-hidden="true">◷</span>
      <span class="chatfuel-main">
        <span class="chatfuel-label lbl">Today's fuel · ${count} item${count === 1 ? "" : "s"}</span>
        <span class="chatfuel-stats">${kcal.toLocaleString()} kcal · ${protein.toLocaleString()}g protein${escHtml(remaining)}</span>
      </span>
      <span class="chatfuel-go" aria-hidden="true">→</span>
    </button>`;
}
function highlightTerm(text, query) {
    const escaped = escHtml(text);
    const term = String(query || "").trim();
    if (!term)
        return escaped;
    try {
        const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
        return escaped.replace(re, "<mark>$1</mark>");
    }
    catch {
        return escaped;
    }
}
function chatHistorySessionRow(session, whenLabel) {
    const sessionId = session.session_id || session.archived_at || "";
    const count = Number(session.count) || 0;
    return `<button class="chat-hist-item" data-session="${escAttr(sessionId)}">
    <span class="chat-hist-main">
      <span class="chat-hist-preview">${escHtml(session.preview || "Conversation")}</span>
      <span class="chat-hist-meta">${escHtml(whenLabel)} · ${count} message${count === 1 ? "" : "s"}</span>
    </span>${HIST_CHEV}</button>`;
}
function chatHistoryHitRow(hit, query, whenLabel) {
    const sessionId = hit.session_id || hit.archived_at || "live";
    return `<button class="chat-hist-item" data-open="${escAttr(sessionId)}">
    <span class="chat-hist-main">
      <span class="chat-hist-preview">${highlightTerm(hit.snippet || "", query)}</span>
      <span class="chat-hist-meta">${hit.role === "user" ? "You" : "Coach"} · ${escHtml(whenLabel)}${hit.archived_at ? "" : " · current"}</span>
    </span>${HIST_CHEV}</button>`;
}
const CAIRN_CHAT_CLIENT = {
    CHAT_IMAGE_MAX_BYTES,
    CHAT_IMAGE_EDGE_STEPS,
    CHAT_IMAGE_QUALITY_STEPS,
    base64DecodedBytes,
    imagePayload: chatImagePayload,
    dayISO: chatDayISO,
    messageHasFoodAction: chatMessageHasFoodAction,
    userMessageSuggestsFood: chatUserMessageSuggestsFood,
    wantsFuelSurface: chatWantsFuelSurface,
    fuelHtml: chatFuelHtml,
    highlightTerm,
    historySessionRow: chatHistorySessionRow,
    historyHitRow: chatHistoryHitRow,
};
Object.assign(globalThis, { CairnChatClient: CAIRN_CHAT_CLIENT });
if (typeof window !== "undefined") {
    window.CairnChatClient = CAIRN_CHAT_CLIENT;
}
