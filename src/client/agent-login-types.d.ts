type AgentLoginRecord = Record<string, unknown>;

type AgentLoginControlMessage = AgentLoginRecord & {
  code?: unknown;
  message?: unknown;
  t?: unknown;
};

type AgentLoginStatusKey =
  | "connecting"
  | "ready"
  | "terminalLoadError"
  | "connectionOpenError"
  | "connected"
  | "loginIncomplete"
  | "busy"
  | "genericError"
  | "connectionError"
  | "disconnected";

type AgentLoginOverlay = HTMLDivElement & {
  _failed?: boolean;
  _onKey?: (event: KeyboardEvent) => void;
  _onResize?: () => void;
  _term?: { dispose?: () => void };
  _ws?: WebSocket;
};

type AgentLoginXtermBufferLine = {
  isWrapped?: boolean;
  translateToString?(trimRight?: boolean): string;
};

type AgentLoginXtermConstructor = new (options: AgentLoginRecord) => {
  open(el: Element): void;
  write(text: string | Uint8Array): void;
  dispose(): void;
  onData?(handler: (data: string) => void): void;
  onResize?(handler: (size: { cols: number; rows: number }) => void): void;
  focus?(): void;
  loadAddon?(addon: unknown): void;
  resize?(cols: number, rows: number): void;
  cols?: number;
  rows?: number;
  buffer?: { active?: { length: number; getLine(index: number): AgentLoginXtermBufferLine | undefined } };
};

type AgentLoginFitAddonConstructor = new () => { fit(): void };

type AgentLoginXtermGlobals = {
  Terminal?: AgentLoginXtermConstructor;
  FitAddon?: { FitAddon?: AgentLoginFitAddonConstructor };
};

type AgentLoginModelApi = {
  control(value: unknown): AgentLoginControlMessage;
  normalizeName(value: unknown): string;
  providerHintHtml(name: string): string;
  record(value: unknown): AgentLoginRecord;
  status(key: AgentLoginStatusKey): string;
};

type AgentLoginAssetsApi = {
  globals(): AgentLoginXtermGlobals;
  load(): Promise<void>;
};

type AgentLoginModalHandle = {
  overlay: AgentLoginOverlay;
  termHost: HTMLElement;
  pasteInput: HTMLInputElement;
  pasteSend: HTMLButtonElement;
  isOk(): boolean;
  markFailed(message: string): void;
  setStatus(text: string, cls?: string): void;
  showAuthLink(url: string): void;
};

type AgentLoginRetry = (agentName: string) => unknown;

type AgentLoginModalApi = {
  close(overlay: AgentLoginOverlay | null | undefined): void;
  create(name: string, retryLogin: AgentLoginRetry): AgentLoginModalHandle | null;
};

type AgentLoginSessionApi = {
  start(name: string, modal: AgentLoginModalHandle): Promise<void>;
};
