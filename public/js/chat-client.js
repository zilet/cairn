(() => {
// @ts-check
// Pure chat helpers for the vanilla PWA.
const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_IMAGE_EDGE_STEPS = [1280, 1024, 768];
const CHAT_IMAGE_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52];
const CHAT_STARTERS = ["Plan my week", "Evaluate my last meal", "How's my progress?", "Swap today's workout"];
const CHAT_FOOD_RE = /\b(food|meal|meals|breakfast|lunch|dinner|snack|plate|bowl|ate|eaten|eating|calor(?:y|ies)|kcal|macro|macros|protein|carb|carbs|fiber|fuel|refuel|grams?|ounces?|oz|serving|portion|recipe|restaurant|menu|label|logged?|logging)\b/i;
const CHAT_NON_FOOD_PHOTO_RE = /\b(physique|body|mirror|pose|form|equipment|bike|run|shoe|injur(?:y|ed)?|pain|dexa|scan|lab|blood|chart|screenshot)\b/i;
const CHAT_FOOD_ACTION_TYPES = new Set(["log_food", "update_food_note"]);
const HIST_CHEV = `<span class="chat-hist-chev" aria-hidden="true">›</span>`;
const CHAT_HISTORY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3.5 12a8.5 8.5 0 1 1 2.5 6"/><path d="M3.5 12H6M3.5 12V9.5"/><path d="M12 7.5V12l3 2"/>
    </svg>`;
const CHAT_FRESH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 4.2l1.7 4.1 4.1 1.7-4.1 1.7L12 15.8l-1.7-4.1-4.1-1.7 4.1-1.7Z"/>
      <path d="M18.6 14.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7Z"/>
      <path d="M5.4 16.2l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55Z"/>
    </svg>`;
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
function chatShellHtml() {
    return `<div class="chatview">
      <div class="chatlog-wrap">
        <div id="chatlog" class="chatlog" aria-live="polite"></div>
        <button id="chatJump" class="chat-jump" hidden aria-label="Jump to latest">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="chatdock">
        <div id="chatFuelSlot" class="chatfuel-slot"></div>
        <div id="chatPreview" class="chat-preview" hidden>
          <img alt="">
          <span class="chat-preview-hint">Photo attached — I'll estimate &amp; log it</span>
          <button id="chatPreviewX" class="chip-x" aria-label="Remove photo">✕</button>
        </div>
        <div class="chatbar">
          <button id="chatAttach" class="attachbtn" aria-label="Attach a photo — camera, library, or files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 5.5v13M5.5 12h13"/>
            </svg>
          </button>
          <input id="chatFile" type="file" accept="image/*" hidden>
          <textarea id="chatInput" rows="1" autocomplete="off" aria-label="Message Cairn" placeholder="Ask, log, or snap a plate…"></textarea>
          <button id="chatSend" class="logbtn" aria-label="Send">↑</button>
        </div>
        <div class="chatnote">Logs save instantly. Plan changes arrive as drafts for you to apply.</div>
      </div>
    </div>`;
}
function chatHeaderActionsHtml() {
    return `<div id="hdrChatActions" class="hdr-chat-actions">
    <button id="hdrHistory" class="hdrcircbtn" type="button" aria-label="Past conversations &amp; search">
      ${CHAT_HISTORY_ICON}
    </button>
    <button id="hdrFresh" class="freshbtn" type="button" hidden aria-label="Start a fresh conversation">
      ${CHAT_FRESH_ICON}<span class="freshbtn-txt">Start fresh?</span>
    </button>
  </div>`;
}
function chatFreshPillHtml(distilled) {
    const count = Number(distilled) || 0;
    const label = count ? `${count} thing${count === 1 ? "" : "s"} remembered` : "Fresh start";
    return `<span class="distill-check">✓</span><span>${escHtml(label)}</span>`;
}
function chatEmptyHtml() {
    return `<div class="empty">Say hi, log a ride, or ask the coach to change your plan.</div>`;
}
function chatStarterChipsHtml(starters = CHAT_STARTERS) {
    const chips = (Array.isArray(starters) ? starters : CHAT_STARTERS)
        .map((text, index) => `<button class="chat-chip" type="button" style="--i:${index}">${escHtml(text)}</button>`)
        .join("");
    return `<div class="chat-chips">${chips}</div>`;
}
function chatDividerHtml(iso, label) {
    return `<div class="chat-divider" data-day="${escAttr(iso)}"><span>${escHtml(label)}</span></div>`;
}
function chatEarlierBarHtml() {
    return `<div class="chat-earlierbar"><button class="earlierbtn" type="button">Show earlier ↑</button></div>`;
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
    CHAT_STARTERS,
    base64DecodedBytes,
    imagePayload: chatImagePayload,
    shellHtml: chatShellHtml,
    headerActionsHtml: chatHeaderActionsHtml,
    freshPillHtml: chatFreshPillHtml,
    emptyHtml: chatEmptyHtml,
    starterChipsHtml: chatStarterChipsHtml,
    dividerHtml: chatDividerHtml,
    earlierBarHtml: chatEarlierBarHtml,
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
})();
