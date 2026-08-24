// Capture-only browser contracts. Kept out of capture.ts so the runtime surface
// stays focused on behavior while the classic-script build remains import-free.
type CaptureDirective = import("../contracts/client.js").ClientDirective & {
  citation?: unknown;
  directive?: unknown;
  uncertain?: unknown;
};
type CaptureActivity = import("../contracts/client.js").ClientActivity & { error?: string };
type CaptureFoodNote = import("../contracts/client.js").ClientFoodNote & { error?: string };
type CaptureFrequentFood = import("../contracts/client.js").ClientFrequentFood & {
  kcal?: number | string | null;
};
type CaptureCheckin = import("../contracts/client.js").ClientCheckin & { error?: string };
type CaptureContextTagDef = import("../contracts/client.js").ClientContextTagDef;
type CaptureContextTag = import("../contracts/client.js").ClientContextTag;
type CaptureContextTagToggleResponse = import("../contracts/client.js").ClientContextTagToggleResponse & {
  error?: string;
};
type CaptureInsight = import("../contracts/client.js").ClientInsight & {
  confidence?: unknown;
  kind?: string | null;
  next_step?: unknown;
  rationale?: unknown;
  uncertain?: unknown;
  stale?: unknown;
  stale_note?: unknown;
};
type CaptureInsightResult = {
  ok?: boolean;
  insight?: CaptureInsight | null;
  error?: unknown;
};
type CaptureReadsDeps = {
  root: ParentNode;
  state: Pick<ClientAppState, "tab">;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): unknown;
  toast(message: string): void;
  collapseEl(el: Element, done?: () => void): void;
  escapeHtml(value: unknown): string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};
type CaptureReadsController = {
  weekRangeLabel(iso: unknown): string;
  loadTodayReads(): Promise<void>;
  reconnectInsight(): ClientAgentOpHandlers | null;
};
type CaptureReadsRuntime = {
  createController(deps: CaptureReadsDeps): CaptureReadsController;
  weekRangeLabel(iso: unknown): string;
};
type CaptureReadDateApi = {
  weekRangeLabel(iso: unknown): string;
};
type CaptureReadCardDeps = {
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  toast(message: string): void;
  collapseEl(el: Element, done?: () => void): void;
  escapeHtml(value: unknown): string;
  weekRangeLabel(iso: unknown): string;
  // Pull-only re-read of the weekly card — regenerates through the existing
  // weekly-read op, bypassing the calendar/cooldown gates on an explicit tap.
  rereadWeekly?(): void;
};
type CaptureTeamWeek = import("../contracts/client-api.js").ClientTeamWeek;
type CaptureReadCardsApi = {
  renderInsightInSlot(target: HTMLElement, insight: CaptureInsight, deps: CaptureReadCardDeps): void;
  renderWeeklyInSlot(
    target: HTMLElement,
    insight: CaptureInsight,
    deps: CaptureReadCardDeps,
    team?: CaptureTeamWeek | null,
  ): void;
  renderTeamWeekInSlot(target: HTMLElement, team: CaptureTeamWeek | null, deps: CaptureReadCardDeps): void;
  teamWeekSectionsHtml(
    team: CaptureTeamWeek | null | undefined,
    esc: (value: unknown) => string,
    opts?: { omitConnections?: boolean },
  ): string;
  teamWeekHasContent(team: CaptureTeamWeek | null | undefined): boolean;
  weeklyFeedbackBody(dir: string | undefined): { feedback: string; status: string };
};
type CaptureReadJobsDeps = {
  state: Pick<ClientAppState, "tab">;
  runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): unknown;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  slot(selector: string): HTMLElement | null;
  renderInsightInSlot(target: HTMLElement, insight: CaptureInsight): void;
  renderWeeklyInSlot(target: HTMLElement, insight: CaptureInsight): void;
};
type CaptureReadJobsController = {
  maybeGenerateInsight(): void;
  maybeGenerateWeekly(): void;
  forceGenerateWeekly(): void;
  reconnectInsight(): ClientAgentOpHandlers | null;
};
type CaptureReadJobsApi = {
  createController(deps: CaptureReadJobsDeps): CaptureReadJobsController;
};
type CaptureSpeechAlternative = { transcript: string };
type CaptureSpeechResult = {
  readonly 0: CaptureSpeechAlternative;
  isFinal: boolean;
};
type CaptureSpeechResultList = {
  length: number;
  [index: number]: CaptureSpeechResult;
};
type CaptureSpeechEvent = {
  resultIndex: number;
  results: CaptureSpeechResultList;
};
type CaptureSpeechErrorEvent = {
  error?: string;
};
type CaptureSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: CaptureSpeechEvent) => void) | null;
  onerror: ((event: CaptureSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
type CaptureSpeechRecognitionCtor = new () => CaptureSpeechRecognition;
