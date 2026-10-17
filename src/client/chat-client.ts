// @ts-check
// Pure chat helpers for the vanilla PWA.

type ClientChatMessage = import("../contracts/client.js").ClientChatMessage;
type ClientChatSearchHit = import("../contracts/client.js").ClientChatSearchHit;
type ClientChatSessionSummary = import("../contracts/client.js").ClientChatSessionSummary;
type ChatClientDayIntake = import("../contracts/client.js").ClientDayIntake;

type ChatAppliedAction = { type?: unknown };
type ChatMessageMeta = {
  image?: unknown;
  applied?: ChatAppliedAction[];
  routing?: { reason_codes?: unknown };
};
type ChatImagePayload = { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
type ChatFuelSurfaceOptions = { todayISO: string; dayISO: (timestamp: unknown) => string };

const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_IMAGE_EDGE_STEPS = [1280, 1024, 768];
const CHAT_IMAGE_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52];
const CHAT_STARTERS = ["Plan my week", "Evaluate my last meal", "How's my progress?", "Swap today's workout"];
const CHAT_FOOD_RE =
  /\b(food|meal|meals|breakfast|lunch|dinner|snack|plate|bowl|ate|eaten|eating|calor(?:y|ies)|kcal|macro|macros|protein|carb|carbs|fiber|fuel|refuel|grams?|ounces?|oz|serving|portion|recipe|restaurant|menu|label|appetizer|starter|entr[eé]e|dessert|side\s+dish|logged?|logging)\b/i;
const CHAT_NON_FOOD_PHOTO_RE =
  /\b(physique|body|mirror|pose|form|equipment|bike|run|shoe|injur(?:y|ed)?|pain|dexa|scan|lab|blood|chart|screenshot)\b/i;
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

function chatMeta(value: unknown): ChatMessageMeta {
  return value && typeof value === "object" ? (value as ChatMessageMeta) : {};
}

function base64DecodedBytes(base64: unknown): number {
  const source = String(base64 || "").replace(/\s/g, "");
  const pad = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((source.length * 3) / 4) - pad);
}

function chatImagePayload(dataUrl: unknown): ChatImagePayload {
  const full = String(dataUrl || "");
  const base64 = full.split(",")[1] || "";
  return { dataUrl: full, base64, mime: "image/jpeg", bytes: base64DecodedBytes(base64) };
}

// Reused mic glyph from capture-voice-client.ts (loaded earlier in bundle
// order) — a function, not a top-level const, so it's read lazily at render
// time rather than at module-parse time.
function chatMicGlyph(): string {
  return (globalThis as unknown as { CairnCaptureVoice?: Window["CairnCaptureVoice"] }).CairnCaptureVoice?.micGlyph ?? "";
}

function chatShellHtml(): string {
  return `<div class="chatview">
      <div class="chatlog-wrap">
        <div id="chatlog" class="chatlog" aria-live="polite"></div>
        <button id="chatJump" class="chat-jump" hidden aria-label="Jump to latest">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="chatdock" data-occludes="bottom">
        <div id="chatFuelSlot" class="chatfuel-slot"></div>
        <div id="chatPreview" class="chat-preview" hidden>
          <img alt="Attached photo">
          <span class="chat-preview-hint">Photo attached — I'll estimate &amp; log it</span>
          <button id="chatPreviewX" class="xbtn chip-x" aria-label="Remove photo">✕</button>
        </div>
        <div id="chatFreqSlot" class="chat-freq-slot" hidden></div>
        <div class="chatbar">
          <button id="chatAttach" class="attachbtn" aria-label="Attach a photo — camera, library, or files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 5.5v13M5.5 12h13"/>
            </svg>
          </button>
          <input id="chatFile" type="file" accept="image/*" hidden>
          <div class="chat-field">
            <textarea id="chatInput" rows="1" autocomplete="off" aria-label="Message Cairn" placeholder="Ask, log, or snap a plate…"></textarea>
            <button id="chatMic" class="qlmic" type="button" hidden aria-label="Dictate" title="Say it out loud">${chatMicGlyph()}</button>
          </div>
          <button id="chatSend" class="logbtn" aria-label="Send">↑</button>
        </div>
        <div class="chatnote">Logs save instantly. Small coaching adjustments land quietly in your plan; bigger restructures wait for review.</div>
      </div>
    </div>`;
}

function chatHeaderActionsHtml(): string {
  return `<div id="hdrChatActions" class="hdr-chat-actions"><button id="hdrChanges" class="hdr-changes" type="button" aria-label="Changes the team made">Changes</button>
    <button id="hdrHistory" class="hdrcircbtn" type="button" aria-label="Past conversations &amp; search">
      ${CHAT_HISTORY_ICON}
    </button>
    <button id="hdrFresh" class="freshbtn" type="button" hidden aria-label="Start a fresh conversation">
      ${CHAT_FRESH_ICON}<span class="freshbtn-txt">Start fresh?</span>
    </button>
  </div>`;
}

function chatFreshPillHtml(distilled: unknown): string {
  const count = Number(distilled) || 0;
  const label = count ? `${count} thing${count === 1 ? "" : "s"} remembered` : "Fresh start";
  return `<span class="distill-check">✓</span><span>${escHtml(label)}</span>`;
}

function chatEmptyHtml(): string {
  return `<div class="empty">Say hi, log a ride, or ask the coach to change your plan.</div>`;
}

// "Usual around now" — the foods most often logged near this hour, offered as
// PREFILL drafts above the composer (never a one-tap re-log: meals vary, so the
// frequent is a starting sentence the athlete edits, and the estimate is
// re-derived from what they actually send). Empty string when nothing qualifies.
function chatFrequentChipsHtml(foods: unknown): string {
  const rows = Array.isArray(foods) ? foods : [];
  const chips = rows.slice(0, 3).map((f) => {
    const row = f && typeof f === "object" ? (f as Record<string, unknown>) : {};
    const summary = String(row.summary || "").trim();
    if (!summary) return "";
    const kcal = row.kcal != null && Number.isFinite(Number(row.kcal))
      ? `<span class="freq-chip-kcal">${Math.round(Number(row.kcal))}</span>`
      : "";
    return `<button class="freq-chip" type="button" data-freq="${escAttr(summary)}">
        <span class="freq-chip-name">${escHtml(summary)}</span>${kcal}
      </button>`;
  }).join("");
  if (!chips) return "";
  return `<div class="chat-freq rail"><span class="freq-head lbl">usual around now</span><div class="freq-chips">${chips}</div></div>`;
}

function chatStarterChipsHtml(starters: readonly unknown[] = CHAT_STARTERS): string {
  const chips = (Array.isArray(starters) ? starters : CHAT_STARTERS)
    .map((text, index) => `<button class="chat-chip" type="button" style="--i:${index}">${escHtml(text)}</button>`)
    .join("");
  return `<div class="chat-chips">${chips}</div>`;
}

function chatDividerHtml(iso: unknown, label: unknown): string {
  return `<div class="chat-divider" data-day="${escAttr(iso)}"><span>${escHtml(label)}</span></div>`;
}

function chatEarlierBarHtml(): string {
  return `<div class="chat-earlierbar"><button class="earlierbtn" type="button">Show earlier ↑</button></div>`;
}

function chatDayISO(timestamp: unknown, localISO: (date?: Date) => string): string {
  if (!timestamp) return localISO();
  const date = new Date(`${String(timestamp).replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? localISO() : localISO(date);
}

function chatMessageHasFoodAction(message: Partial<ClientChatMessage> | null | undefined): boolean {
  if (!message) return false;
  const meta = chatMeta(message.meta);
  return Array.isArray(meta.applied) && meta.applied.some((action) => CHAT_FOOD_ACTION_TYPES.has(String(action?.type || "")));
}

// The server already classified the user's message when it picked the chat lane,
// and that verdict rides back on the reply's meta.routing. Trusting it here keeps
// the fuel strip from disagreeing with the lane that handled the message — the
// local CHAT_FOOD_RE stays only as a fallback for pre-routing history rows.
const CHAT_FOOD_ROUTING_REASONS = new Set(["explicit_food_log", "photo_food_default", "capture_correction"]);

function chatMessageRoutedFood(message: Partial<ClientChatMessage> | null | undefined): boolean {
  if (!message) return false;
  const codes = chatMeta(message.meta).routing?.reason_codes;
  return Array.isArray(codes) && codes.some((code) => CHAT_FOOD_ROUTING_REASONS.has(String(code)));
}

function chatUserMessageSuggestsFood(message: Partial<ClientChatMessage> | null | undefined): boolean {
  if (!message || String(message.role || "") !== "user") return false;
  const content = String(message.content || "");
  const meta = chatMeta(message.meta);
  if (CHAT_FOOD_RE.test(content)) return true;
  if (meta.image && (!content || content === "(photo)" || !CHAT_NON_FOOD_PHOTO_RE.test(content))) return true;
  return false;
}

function chatWantsFuelSurface(
  messages: Partial<ClientChatMessage>[] | null | undefined,
  options: ChatFuelSurfaceOptions,
): boolean {
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
  if (latestUserIdx < 0) return false;
  const latestUser = recentToday[latestUserIdx];
  const sinceLatestUser = recentToday.slice(latestUserIdx);
  return (
    chatUserMessageSuggestsFood(latestUser) ||
    sinceLatestUser.some((message) => chatMessageHasFoodAction(message) || chatMessageRoutedFood(message))
  );
}

function chatFuelHtml(day: ChatClientDayIntake | null | undefined): string {
  const count = Number(day?.count) || 0;
  if (!count) return "";
  const totals: Partial<ChatClientDayIntake["totals"]> = day?.totals || {};
  const kcalKnown = day?.known ? day.known.kcal === true : totals.kcal != null;
  const proteinKnown = day?.known ? day.known.protein_g === true : totals.protein_g != null;
  const kcal = Math.round(Number(totals.kcal) || 0);
  const protein = Math.round(Number(totals.protein_g) || 0);
  const parts = [
    kcalKnown ? `${kcal.toLocaleString()} kcal` : "",
    proteinKnown ? `${protein.toLocaleString()}g protein` : "",
  ].filter(Boolean);
  const pending = (day?.entries || []).some((entry) =>
    ["pending", "in_progress"].includes(String(entry.enrichment_status || ""))
  );
  const hasUnknown = !kcalKnown || !proteinKnown;
  const estimateState = pending ? "Nutrition estimate is settling…" : "Some nutrition details are still unknown.";
  const stats = parts.length
    ? `${parts.join(" · ")}${hasUnknown ? ` · ${pending ? "other details estimating…" : "some details unknown"}` : ""}`
    : estimateState;
  let remaining = "";
  if (day?.remaining && day.target && kcalKnown) {
    const left = Math.round(Number(day.remaining.kcal));
    remaining = left > 0 ? ` · ~${left.toLocaleString()} left` : " · fuel's in";
  }
  return `<button id="chatFuelCard" class="chatfuel-card" type="button" title="Review &amp; edit today's food">
      <span class="chatfuel-mark" aria-hidden="true">◷</span>
      <span class="chatfuel-main">
        <span class="chatfuel-label lbl">Today's fuel · ${count} item${count === 1 ? "" : "s"}</span>
        <span class="chatfuel-stats">${escHtml(stats)}${escHtml(remaining)}</span>
      </span>
      <span class="chatfuel-go" aria-hidden="true">→</span>
    </button>`;
}

// A plan action that did NOT go live is never a plain "✓". Two shapes:
//   * scheduled — the change is real and lands on a named day ("⏱ plan update · tomorrow");
//   * not applied — the athlete asked for today, it could not happen today, and it was
//     deliberately not moved to another day ("plan update · not applied").
// The landing word is computed server-side (`landing_label`) so the chip never does its
// own date math against a timezone it cannot see. Returns null for anything that landed,
// failed, or is not a plan action, leaving the ordinary tag in place.
function planLandingTag(action: unknown): { text: string; scheduled: boolean } | null {
  if (!action || typeof action !== "object") return null;
  const row = action as Record<string, unknown>;
  const type = String(row.type || "");
  if (type !== "plan_update" && type !== "plan_restructure") return null;
  const result = row.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : null;
  if (!result || result.ok !== true || result.applied === true || result.persisted === true) return null;
  const label = type.replace(/_/g, " ");
  if (result.held_reason === "today_scoped") return { text: `${label} · not applied`, scheduled: false };
  if (result.scheduled !== true) return null;
  const when = String(result.landing_label || result.effective_date || "").trim();
  return { text: when ? `⏱ ${label} · ${when}` : `⏱ ${label} · scheduled`, scheduled: true };
}

function highlightTerm(text: unknown, query: unknown): string {
  const escaped = escHtml(text);
  const term = String(query || "").trim();
  if (!term) return escaped;
  try {
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    return escaped.replace(re, "<mark>$1</mark>");
  } catch {
    return escaped;
  }
}

function chatHistorySessionRow(session: Partial<ClientChatSessionSummary>, whenLabel: string): string {
  const sessionId = session.session_id || session.archived_at || "";
  const count = Number(session.count) || 0;
  return `<button class="chat-hist-item" data-session="${escAttr(sessionId)}">
    <span class="chat-hist-main">
      <span class="chat-hist-preview">${escHtml(session.preview || "Conversation")}</span>
      <span class="chat-hist-meta">${escHtml(whenLabel)} · ${count} message${count === 1 ? "" : "s"}</span>
    </span>${HIST_CHEV}</button>`;
}

function chatHistoryHitRow(hit: Partial<ClientChatSearchHit>, query: unknown, whenLabel: string): string {
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
  frequentChipsHtml: chatFrequentChipsHtml,
  dividerHtml: chatDividerHtml,
  earlierBarHtml: chatEarlierBarHtml,
  dayISO: chatDayISO,
  messageHasFoodAction: chatMessageHasFoodAction,
  userMessageSuggestsFood: chatUserMessageSuggestsFood,
  wantsFuelSurface: chatWantsFuelSurface,
  fuelHtml: chatFuelHtml,
  planLandingTag,
  highlightTerm,
  historySessionRow: chatHistorySessionRow,
  historyHitRow: chatHistoryHitRow,
};

Object.assign(globalThis, { CairnChatClient: CAIRN_CHAT_CLIENT });

if (typeof window !== "undefined") {
  // The capture-chip members are added by chat-capture-chips-client.ts, which loads next.
  window.CairnChatClient = CAIRN_CHAT_CLIENT as unknown as Window["CairnChatClient"];
}
