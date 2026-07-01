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
};

const CHAT_TURN_DRAFT_KEY = "cairn.chat.draft";

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
};

Object.assign(globalThis, { CairnChatTurnRecords: CAIRN_CHAT_TURN_RECORDS });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnChatTurnRecords: CAIRN_CHAT_TURN_RECORDS });
}
