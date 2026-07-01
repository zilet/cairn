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
type CaptureInsight = import("../contracts/client.js").ClientInsight & {
  confidence?: unknown;
  kind?: string | null;
  next_step?: unknown;
  rationale?: unknown;
  uncertain?: unknown;
};
type CaptureInsightResult = {
  ok?: boolean;
  insight?: CaptureInsight | null;
  error?: unknown;
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
