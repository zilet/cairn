// @ts-check
// Durable chat-turn EventSource monitor. Owns stream lifecycle and per-event
// dispatch; the chat turn client owns DOM bubbles and final rendering.

type ChatTurnMonitorRow = Record<string, unknown>;
type ChatTurnMonitorSource = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};
type ChatTurnMonitorDeps = {
  isActive(): boolean;
  hasLog(): boolean;
  pendingIds(): number[];
  createStream(id: number): ChatTurnMonitorSource | null;
  parse(event: Event): ChatTurnMonitorRow | null;
  record(value: unknown): ChatTurnMonitorRow;
  phase(id: number, turnValue: unknown): void;
  progress(id: number, text: unknown): void;
  delta(id: number, text: unknown): void;
  reset(id: number): void;
  finish(turnValue: unknown, messageValue?: unknown): void;
  cancel(turnValue: unknown): void;
};
type ChatTurnMonitor = {
  close(): void;
  currentId(): number | null;
  ensure(): void;
  open(id: number): void;
};
type ChatTurnMonitorApi = {
  create(deps: ChatTurnMonitorDeps): ChatTurnMonitor;
};

function createChatTurnMonitor(deps: ChatTurnMonitorDeps): ChatTurnMonitor {
  let stream: ChatTurnMonitorSource | null = null;
  let streamId: number | null = null;

  function closeSource(source: ChatTurnMonitorSource | null): void {
    if (!source) return;
    try { source.close(); } catch {}
  }

  function close(): void {
    const source = stream;
    stream = null;
    streamId = null;
    closeSource(source);
  }

  function closeFor(source: ChatTurnMonitorSource): void {
    if (stream === source) close();
    else closeSource(source);
  }

  function guard(source: ChatTurnMonitorSource): boolean {
    if (deps.isActive() && deps.hasLog()) return false;
    closeFor(source);
    return true;
  }

  function ensure(): void {
    if (stream || !deps.isActive()) return;
    const ids = deps.pendingIds()
      .filter((id) => Number.isFinite(id))
      .sort((a, b) => a - b);
    if (!ids.length) return;
    open(ids[0]);
  }

  function terminal(source: ChatTurnMonitorSource): void {
    closeFor(source);
    ensure();
  }

  function eventRow(event: Event): ChatTurnMonitorRow | null {
    return deps.parse(event);
  }

  function rowTurn(row: ChatTurnMonitorRow): ChatTurnMonitorRow {
    return deps.record(row.turn);
  }

  function isTerminalStatus(status: unknown): boolean {
    return ["done", "error", "canceled"].includes(String(status || ""));
  }

  function open(id: number): void {
    if (stream) return;
    streamId = id;
    let source: ChatTurnMonitorSource | null = null;
    try {
      source = deps.createStream(id);
    } catch {
      streamId = null;
      return;
    }
    if (!source) {
      streamId = null;
      return;
    }
    stream = source;

    source.addEventListener("snapshot", (event) => {
      if (guard(source)) return;
      const row = eventRow(event);
      if (!row) return;
      const turn = rowTurn(row);
      const status = turn.status;
      if (isTerminalStatus(status)) {
        if (status === "canceled") deps.cancel(turn);
        else deps.finish(turn, row.message);
        terminal(source);
        return;
      }
      deps.phase(id, row.turn || row);
    });

    source.addEventListener("phase", (event) => {
      if (guard(source)) return;
      const row = eventRow(event);
      deps.phase(id, row?.turn);
    });
    source.addEventListener("progress", (event) => {
      if (guard(source)) return;
      deps.progress(id, eventRow(event)?.text);
    });
    source.addEventListener("delta", (event) => {
      if (guard(source)) return;
      deps.delta(id, eventRow(event)?.text);
    });
    source.addEventListener("reset", () => {
      if (!guard(source)) deps.reset(id);
    });
    source.addEventListener("done", (event) => {
      if (guard(source)) return;
      const row = eventRow(event);
      if (!row) return;
      deps.finish(row.turn, row.message);
      terminal(source);
    });
    source.addEventListener("canceled", (event) => {
      if (guard(source)) return;
      deps.cancel(eventRow(event)?.turn);
      terminal(source);
    });
    source.addEventListener("error", (event) => {
      const data = (event as MessageEvent).data;
      if (!data) return;
      if (guard(source)) return;
      const row = eventRow(event);
      if (!row) return;
      deps.finish(row.turn, row.message);
      terminal(source);
    });
  }

  return {
    close,
    currentId: () => streamId,
    ensure,
    open,
  };
}

const CAIRN_CHAT_TURN_MONITOR: ChatTurnMonitorApi = {
  create: createChatTurnMonitor,
};

Object.assign(globalThis, { CairnChatTurnMonitor: CAIRN_CHAT_TURN_MONITOR });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnChatTurnMonitor: CAIRN_CHAT_TURN_MONITOR });
}
