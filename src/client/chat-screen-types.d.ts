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
  lab_confirms?: unknown;
  [key: string]: unknown;
};
type ChatScreenAppliedAction = { type?: unknown; error?: unknown };
type ChatScreenDraft = {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  summary?: unknown;
};
type ChatScreenLabConfirm = {
  id?: unknown;
  status?: unknown;
  marker_estimate?: unknown;
  summary?: unknown;
  kind?: unknown;
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
type ChatHeaderControllerDeps = {
  state: { tab?: string };
  currentToken(): number;
  clearFuelContext(): void;
  drawEmptyChat(): void;
  enqueueJob(path: string, body?: Record<string, unknown>): Promise<unknown>;
  openJobStream(jobId: string | number, handlers?: ChatScreenJobHandlers): void;
  openChatHistory(options?: { session?: string | null }): void;
};

declare function enqueueJob(path: string, body?: Record<string, unknown>): Promise<unknown>;
declare function openJobStream(jobId: string | number, handlers?: ChatScreenJobHandlers): void;
declare function openChatHistory(options?: { session?: string | null }): void;
declare function appendMsg(
  message: Partial<ChatScreenMessage>,
  noScroll?: boolean,
  parent?: Element | null,
  opts?: ChatScreenAppendOptions,
): HTMLElement | null;
declare function chatDayISO(timestamp: unknown): string;
declare function chatDivider(iso: string): Element;
declare function saveChatDraft(value: string): void;
declare function loadChatDraft(): string;
declare function spawnPendingBubble(turnValue: unknown): Element | null;
declare function chatMonitorEnsure(): void;
declare function chatReconnect(): Promise<void>;
declare function wireChatJump(log: HTMLElement | null, jump: HTMLElement | null): void;
