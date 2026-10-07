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
  /** The mounted sign-in panel; closing the modal closes it (socket + terminal) once. */
  _panel?: AgentLoginPanelHandle;
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
  /** The provider's plain name ("claude" → "Claude", "codex" → "ChatGPT"). */
  label(name: string): string;
  normalizeName(value: unknown): string;
  providerHintHtml(name: string): string;
  record(value: unknown): AgentLoginRecord;
  status(key: AgentLoginStatusKey): string;
};

type AgentLoginAssetsApi = {
  globals(): AgentLoginXtermGlobals;
  load(): Promise<void>;
};

type AgentLoginFailReason = "terminal" | "connection" | "incomplete" | "error" | "disconnected";

/** What a running sign-in session reports to whoever hosts it (the friendly panel). */
type AgentLoginEvent =
  | { t: "status"; key: "connecting" | "ready" }
  | { t: "link"; url: string }
  | { t: "code"; code: string }
  | { t: "connected" }
  | { t: "busy"; message: string }
  | { t: "failed"; reason: AgentLoginFailReason; message: string };

type AgentLoginHost = {
  /** Where xterm mounts. It may sit folded behind "Show details"; it still gets every byte. */
  termHost: HTMLElement;
  /** False once the host left the page: a late load stops instead of mounting. */
  alive(): boolean;
  emit(event: AgentLoginEvent): void;
};

type AgentLoginSessionHandle = {
  /** Type `text` into the CLI, then Enter. False when the socket is not open. */
  send(text: string): boolean;
  focusTerminal?(): void;
  close(): void;
};

type AgentLoginSessionApi = {
  start(name: string, host: AgentLoginHost): Promise<AgentLoginSessionHandle | null>;
  findAuthUrl(lines: string[]): string;
  findDeviceCode(lines: string[]): string;
};

type AgentLoginPanelOptions = {
  /** The agent key (claude, codex, ...). */
  name: string;
  /** The provider's plain name for copy ("Claude", "ChatGPT"). */
  label: string;
  /** Open the terminal details from the start (antigravity's login is an interactive TUI). */
  detailsOpen?: boolean;
  onConnected?(): void;
  onFailed?(message: string, reason: AgentLoginFailReason): void;
  onBusy?(message: string): void;
};

type AgentLoginPanelHandle = {
  close(): void;
};

type AgentLoginPanelApi = {
  /** Paint the friendly sign-in panel into `host` and start the session. */
  mount(host: HTMLElement, opts: AgentLoginPanelOptions): AgentLoginPanelHandle;
  /** The provider asks for its code to be pasted back (Claude). */
  pastesCode(name: string): boolean;
};

type AgentLoginModalHandle = {
  overlay: AgentLoginOverlay;
  close(): void;
};

type AgentLoginRetry = (agentName: string) => unknown;

type AgentLoginModalApi = {
  close(overlay: AgentLoginOverlay | null | undefined): void;
  create(name: string, retryLogin: AgentLoginRetry): AgentLoginModalHandle | null;
};
