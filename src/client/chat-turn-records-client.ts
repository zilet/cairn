// @ts-check
// Durable chat-turn record normalization, SSE event parsing, draft storage, and status captions.

type ChatTurnRecord = Record<string, unknown>;
type ChatTurn = ChatTurnRecord & {
  id: number;
  status?: string;
  phase?: string | null;
  image_url?: string | null;
  user_message_id?: number | string | null;
  reply?: string | null;
  error?: string | null;
  meta?: { drafts?: unknown[]; [key: string]: unknown } | null;
  finished_at?: string | null;
  assistant_message_id?: number | string | null;
};
type ChatTurnRecordsApi = {
  event(event: Event): ChatTurnRecord | null;
  id(value: unknown): number | null;
  loadDraft(): string;
  phaseCaption(turn: ChatTurn | null | undefined): string;
  record(value: unknown): ChatTurnRecord;
  rows(value: unknown): ChatTurn[];
  saveDraft(value: string): void;
  clearRetry(): void;
  loadRetry(): ChatTurnRetryState | null;
  saveRetry(value: ChatTurnRetryState): void;
};

type ChatTurnRetryState = {
  requestId: string;
  text: string;
  hasImage: boolean;
  expiresAt: number;
};

const CHAT_TURN_DRAFT_KEY = "cairn.chat.draft";
const CHAT_TURN_RETRY_KEY = "cairn.chat.retry.v1";
const CHAT_TURN_RETRY_TTL_MS = 15 * 60 * 1000;
let chatTurnRetryTimer: ReturnType<typeof setTimeout> | null = null;

function chatTurnRecord(value: unknown): ChatTurnRecord {
  return value && typeof value === "object" ? value as ChatTurnRecord : {};
}

function chatTurnRows(value: unknown): ChatTurn[] {
  return Array.isArray(value)
    ? value.filter((row) => !!row && typeof row === "object" && Number.isFinite(Number((row as ChatTurnRecord).id))) as ChatTurn[]
    : [];
}

function chatTurnId(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseChatTurnEvent(event: Event): ChatTurnRecord | null {
  const data = (event as MessageEvent).data;
  if (typeof data !== "string" || !data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return chatTurnRecord(parsed);
  } catch {
    return null;
  }
}

function saveChatTurnDraft(value: string): void {
  try {
    value ? localStorage.setItem(CHAT_TURN_DRAFT_KEY, value) : localStorage.removeItem(CHAT_TURN_DRAFT_KEY);
  } catch {}
}

function loadChatTurnDraft(): string {
  try { return localStorage.getItem(CHAT_TURN_DRAFT_KEY) || ""; } catch { return ""; }
}

function clearChatTurnRetry(): void {
  if (chatTurnRetryTimer != null) {
    try { clearTimeout(chatTurnRetryTimer); } catch {}
    chatTurnRetryTimer = null;
  }
  try { sessionStorage.removeItem(CHAT_TURN_RETRY_KEY); } catch {}
}

function armChatTurnRetryExpiry(expiresAt: number): void {
  if (chatTurnRetryTimer != null) {
    try { clearTimeout(chatTurnRetryTimer); } catch {}
    chatTurnRetryTimer = null;
  }
  if (typeof globalThis.setTimeout !== "function") return;
  const delay = expiresAt - Date.now();
  if (delay <= 0) {
    clearChatTurnRetry();
    return;
  }
  chatTurnRetryTimer = setTimeout(() => {
    chatTurnRetryTimer = null;
    if (Date.now() < expiresAt) {
      armChatTurnRetryExpiry(expiresAt);
      return;
    }
    const current = loadChatTurnRetry();
    if (current?.expiresAt === expiresAt) clearChatTurnRetry();
  }, delay);
}

function saveChatTurnRetry(value: ChatTurnRetryState): void {
  const requestId = String(value?.requestId || "").trim().slice(0, 160);
  const text = String(value?.text || "").slice(0, 12_000);
  const expiresAt = Number(value?.expiresAt);
  if (!requestId || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || (!text && !value?.hasImage)) {
    clearChatTurnRetry();
    return;
  }
  // Keep the retry payload deliberately small and session-scoped: no image bytes,
  // data URLs, or file names. A photo retry asks for a fresh attachment after a reload.
  try {
    sessionStorage.setItem(CHAT_TURN_RETRY_KEY, JSON.stringify({ requestId, text, hasImage: !!value.hasImage, expiresAt }));
    armChatTurnRetryExpiry(expiresAt);
  } catch {}
}

function loadChatTurnRetry(): ChatTurnRetryState | null {
  try {
    const raw = sessionStorage.getItem(CHAT_TURN_RETRY_KEY);
    if (!raw) return null;
    const value = chatTurnRecord(JSON.parse(raw));
    const requestId = String(value.requestId || "").trim().slice(0, 160);
    const text = String(value.text || "").slice(0, 12_000);
    const expiresAt = Number(value.expiresAt);
    const hasImage = value.hasImage === true;
    if (!requestId || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || (!text && !hasImage)) {
      clearChatTurnRetry();
      return null;
    }
    const retry = { requestId, text, hasImage, expiresAt };
    armChatTurnRetryExpiry(expiresAt);
    return retry;
  } catch {
    clearChatTurnRetry();
    return null;
  }
}

function chatTurnPhaseCaption(turn: ChatTurn | null | undefined): string {
  if (!turn) return "Thinking…";
  if (turn.status === "queued") return "Queued";
  if (turn.phase === "applying") return "Saving…";
  return turn.image_url ? "Reading your plate…" : "Thinking…";
}

const CAIRN_CHAT_TURN_RECORDS: ChatTurnRecordsApi = {
  event: parseChatTurnEvent,
  id: chatTurnId,
  loadDraft: loadChatTurnDraft,
  phaseCaption: chatTurnPhaseCaption,
  record: chatTurnRecord,
  rows: chatTurnRows,
  saveDraft: saveChatTurnDraft,
  clearRetry: clearChatTurnRetry,
  loadRetry: loadChatTurnRetry,
  saveRetry: saveChatTurnRetry,
};

Object.assign(globalThis, { CairnChatTurnRecords: CAIRN_CHAT_TURN_RECORDS });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnChatTurnRecords: CAIRN_CHAT_TURN_RECORDS });
}
