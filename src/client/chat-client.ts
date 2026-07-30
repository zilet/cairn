// @ts-check
// Pure chat helpers for the vanilla PWA.

type ClientChatMessage = import("../contracts/client.js").ClientChatMessage;
type ClientChatSearchHit = import("../contracts/client.js").ClientChatSearchHit;
type ClientChatSessionSummary = import("../contracts/client.js").ClientChatSessionSummary;
type ChatClientDayIntake = import("../contracts/client.js").ClientDayIntake;

type ChatAppliedAction = { type?: unknown };
type ChatMessageMeta = { image?: unknown; applied?: ChatAppliedAction[] };
type ChatImagePayload = { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
type ChatFuelSurfaceOptions = { todayISO: string; dayISO: (timestamp: unknown) => string };

const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_IMAGE_EDGE_STEPS = [1280, 1024, 768];
const CHAT_IMAGE_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52];
const CHAT_STARTERS = ["Plan my week", "Evaluate my last meal", "How's my progress?", "Swap today's workout"];
const CHAT_FOOD_RE =
  /\b(food|meal|meals|breakfast|lunch|dinner|snack|plate|bowl|ate|eaten|eating|calor(?:y|ies)|kcal|macro|macros|protein|carb|carbs|fiber|fuel|refuel|grams?|ounces?|oz|serving|portion|recipe|restaurant|menu|label|logged?|logging)\b/i;
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

function chatShellHtml(): string {
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
          <button id="chatPreviewX" class="xbtn chip-x" aria-label="Remove photo">✕</button>
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
        <div class="chatnote">Logs save instantly. Small coaching adjustments land quietly in your plan; bigger restructures wait for review.</div>
      </div>
    </div>`;
}

function chatHeaderActionsHtml(): string {
  return `<div id="hdrChatActions" class="hdr-chat-actions">
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
  return chatUserMessageSuggestsFood(latestUser) || sinceLatestUser.some(chatMessageHasFoodAction);
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

// ---- chat food-capture feedback ----------------------------------------
// A capture-lane food log links a food_notes row whose macros fill in later via
// background enrichment. The server stamps the applied log_food result with the
// note's live enrichment_status + a compact {meal,summary,kcal,protein_g}; these
// pure helpers turn that into the in-thread chip and keep it in sync as the note's
// SSE stream settles (see chat-message-client.ts).
type CaptureFoodRow = { item?: unknown; amount?: unknown; kcal?: unknown; protein_g?: unknown };
type CaptureFood = {
  meal?: unknown;
  summary?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  ingredients?: unknown;
  ingredient_count?: unknown;
  confidence?: unknown;
  basis?: unknown;
};
type CaptureFoodInfo = { id: number; status: string; food: CaptureFood; missing: boolean };

function captureFoodActive(status: unknown): boolean {
  const s = String(status || "");
  return s === "pending" || s === "in_progress";
}

function capMealLabel(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "Meal";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Pull the linked-note descriptor out of an applied log_food action, or null when
// this isn't a capture we can track (wrong type, no note id, or note deleted).
function captureFoodInfo(action: unknown): CaptureFoodInfo | null {
  const a = action && typeof action === "object" ? (action as Record<string, unknown>) : null;
  if (!a || String(a.type || "") !== "log_food") return null;
  const result = a.result && typeof a.result === "object" ? (a.result as Record<string, unknown>) : null;
  if (!result) return null;
  const id = Number(result.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const food: CaptureFood = result.food && typeof result.food === "object" ? { ...(result.food as CaptureFood) } : {};
  if (food.meal == null && result.meal != null) food.meal = result.meal;
  return { id, status: String(result.enrichment_status || ""), food, missing: result.food_note_missing === true };
}

// Map a fetched food-note row (SSE update / poll) back to {status, food} so the chip
// updates in place from the same rendering path as the initial server-stamped state.
function captureFoodFromRow(row: unknown): { status: string; food: CaptureFood } {
  const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  let parsed: unknown = r.parsed;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  if ((parsed == null || typeof parsed !== "object") && r.parsed_json) {
    try { parsed = JSON.parse(String(r.parsed_json)); } catch { parsed = null; }
  }
  const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const source = Array.isArray(p.ingredients) ? p.ingredients : Array.isArray(p.items) ? p.items : [];
  const rows = source.map(captureFoodRow).filter((row): row is CaptureFoodRow => !!row);
  return {
    status: String(r.enrichment_status || ""),
    food: {
      meal: r.meal,
      summary: p.summary,
      kcal: p.kcal,
      protein_g: p.protein_g,
      ingredients: rows.slice(0, CAPTURE_REVIEW_MAX_ROWS),
      ingredient_count: rows.length,
      confidence: p.confidence,
      basis: p.basis,
    },
  };
}

// ---- the settled review ------------------------------------------------
// Once the estimate lands, the chip alone can't answer "built from what?". The
// review under it names the components and how the numbers were obtained, so a
// guess never reads like a weighing (the one rule in src/foodCapture.ts). Rows are
// capped: the full breakdown lives in the food detail sheet, not in a chat bubble.
const CAPTURE_REVIEW_MAX_ROWS = 6;

// The same normalization the server runs in stampCaptureFood, for the SSE/poll path
// that hands us a raw food-note row instead of an already-stamped result.
function captureFoodRow(raw: unknown): CaptureFoodRow | null {
  if (typeof raw === "string") {
    const item = raw.trim();
    return item ? { item } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const item = String(row.item ?? row.name ?? row.food ?? "").trim();
  if (!item) return null;
  return {
    item,
    amount: String(row.amount ?? row.qty ?? row.quantity ?? row.portion ?? "").trim(),
    kcal: row.kcal,
    protein_g: row.protein_g,
  };
}

// How the numbers were obtained, in the athlete's register. Deliberately plain:
// these are the food-capture contract's own basis values, not a grade.
const CAPTURE_BASIS_PHRASES: Record<string, string> = {
  label: "Read off the label or menu",
  user_report: "From what you said",
  photo: "Read from the photo",
  estimated_from_foods: "Estimated from usual servings",
};

function captureFoodMacroText(row: CaptureFoodRow): string {
  const bits: string[] = [];
  const kcal = Number(row.kcal);
  const protein = Number(row.protein_g);
  if (Number.isFinite(kcal) && kcal > 0) bits.push(`~${Math.round(kcal)} kcal`);
  if (Number.isFinite(protein) && protein > 0) bits.push(`${Math.round(protein)}g P`);
  return bits.join(" · ");
}

function captureFoodBasisLine(food: CaptureFood): string {
  const bits: string[] = [];
  const basis = CAPTURE_BASIS_PHRASES[String(food.basis ?? "")];
  if (basis) bits.push(basis);
  const confidence = String(food.confidence ?? "");
  if (confidence === "low" || confidence === "medium" || confidence === "high") {
    bits.push(`${confidence} confidence`);
  }
  return bits.join(" · ");
}

// The review's inner HTML, or "" when there is nothing honest to show yet (still
// enriching, failed, or an estimate that came back with no components). Reuses the
// ingredient-row classes from the food detail sheet — same breakdown, same look.
function captureFoodReviewInner(status: unknown, food: unknown): string {
  const s = String(status || "");
  if (captureFoodActive(s) || s === "failed" || s === "skipped") return "";
  const f = food && typeof food === "object" ? (food as CaptureFood) : {};
  const rows = (Array.isArray(f.ingredients) ? f.ingredients : [])
    .map(captureFoodRow)
    .filter((row): row is CaptureFoodRow => !!row)
    .slice(0, CAPTURE_REVIEW_MAX_ROWS);
  const basisLine = captureFoodBasisLine(f);
  if (!rows.length) return "";
  const total = Number(f.ingredient_count);
  const hidden = Number.isFinite(total) ? Math.max(0, total - rows.length) : 0;
  const body = rows
    .map((row) => {
      const macros = captureFoodMacroText(row);
      const amount = String(row.amount ?? "").trim();
      return `<div class="ing-row">
        <div class="ing-main"><span>${escHtml(row.item)}</span>${amount ? `<small>${escHtml(amount)}</small>` : ""}</div>
        <div class="ing-nutri">${escHtml(macros || "estimated")}</div>
      </div>`;
    })
    .join("");
  const more = hidden ? `<div class="capture-review-more">and ${hidden} more</div>` : "";
  const foot = basisLine ? `<div class="capture-review-basis">${escHtml(basisLine)}</div>` : "";
  return `<div class="ing-breakdown">${body}</div>${more}${foot}`;
}

// The chip's inner HTML for a given status. Active -> a calm "filling in details…"
// with the spinner dot; done -> "✓ Dinner · 640 kcal · 40g protein" (or "✓ Dinner
// logged" when no macros came back); failed/skipped -> a calm "logged — details
// unavailable" (the log itself is never in doubt). escHtml is the ambient global.
function captureFoodTagInner(status: unknown, food: unknown): string {
  const s = String(status || "");
  const f = food && typeof food === "object" ? (food as CaptureFood) : {};
  if (captureFoodActive(s)) return `<span class="enr-dot" aria-hidden="true"></span>filling in details…`;
  const meal = capMealLabel(f.meal);
  if (s === "failed" || s === "skipped") return `✓ ${escHtml(meal)} logged — details unavailable`;
  const bits: string[] = [];
  const kcal = Number(f.kcal);
  const protein = Number(f.protein_g);
  if (Number.isFinite(kcal) && kcal > 0) bits.push(`${Math.round(kcal)} kcal`);
  if (Number.isFinite(protein) && protein > 0) bits.push(`${Math.round(protein)}g protein`);
  if (!bits.length) return `✓ ${escHtml(meal)} logged`;
  return `✓ ${escHtml(`${meal} · ${bits.join(" · ")}`)}`;
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
  dividerHtml: chatDividerHtml,
  earlierBarHtml: chatEarlierBarHtml,
  dayISO: chatDayISO,
  messageHasFoodAction: chatMessageHasFoodAction,
  userMessageSuggestsFood: chatUserMessageSuggestsFood,
  wantsFuelSurface: chatWantsFuelSurface,
  fuelHtml: chatFuelHtml,
  captureFoodActive,
  captureFoodInfo,
  captureFoodFromRow,
  captureFoodTagInner,
  captureFoodReviewInner,
  highlightTerm,
  historySessionRow: chatHistorySessionRow,
  historyHitRow: chatHistoryHitRow,
};

Object.assign(globalThis, { CairnChatClient: CAIRN_CHAT_CLIENT });

if (typeof window !== "undefined") {
  window.CairnChatClient = CAIRN_CHAT_CLIENT;
}
