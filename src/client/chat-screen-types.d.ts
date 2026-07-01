// Chat-screen-only browser contracts. Kept out of chat-screen.ts so the runtime
// surface stays focused on behavior while the classic-script build remains
// import-free.
type ChatScreenMessage = Partial<import("../contracts/client.js").ClientChatMessage> &
  Record<string, unknown> & {
    pending?: boolean;
    meta?: unknown;
  };
type ChatScreenMeta = {
  image?: unknown;
  applied?: unknown;
  drafts?: unknown;
  [key: string]: unknown;
};
type ChatScreenAppliedAction = { type?: unknown; error?: unknown };
type ChatScreenDraft = {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  summary?: unknown;
};
type ChatScreenImagePayload = { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
type ChatScreenGroup = { iso: string; msgs: ChatScreenMessage[] };
type ChatScreenAppendOptions = { readonly?: boolean; before?: Element | null };
type ChatScreenJobHandlers = {
  guard?: () => boolean;
  onDone?: (result: unknown) => unknown;
  onError?: (error?: unknown) => unknown;
  onCanceled?: () => unknown;
};
type ChatScreenHeaderButtons = { freshBtn: HTMLElement | null; historyBtn: HTMLElement | null };

declare function enqueueJob(path: string, body?: Record<string, unknown>): Promise<unknown>;
declare function openJobStream(jobId: string | number, handlers?: ChatScreenJobHandlers): void;
declare function openChatHistory(options?: { session?: string | null }): void;
declare function saveChatDraft(value: string): void;
declare function loadChatDraft(): string;
declare function spawnPendingBubble(turnValue: unknown): Element | null;
declare function chatMonitorEnsure(): void;
declare function chatReconnect(): Promise<void>;
declare function wireChatJump(log: HTMLElement | null, jump: HTMLElement | null): void;
