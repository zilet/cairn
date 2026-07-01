// @ts-check
// Capture voice dictation: Web Speech feature detection, mic glyph, and
// press-to-talk lifecycle for the free-text quick log.

type CaptureVoiceDeps = {
  root: ParentNode;
  quickLog(): Promise<void>;
};

type SpeechWindow = Window & {
  SpeechRecognition?: CaptureSpeechRecognitionCtor;
  webkitSpeechRecognition?: CaptureSpeechRecognitionCtor;
};

// Inline mic glyph: static SVG, no caller text, safe for innerHTML.
const CAPTURE_MIC_GLYPH = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>`;

// Feature-detect once. Absent (e.g. Firefox/older Safari) -> the mic stays hidden.
const CAPTURE_SPEECH_REC: CaptureSpeechRecognitionCtor | null =
  (window as SpeechWindow).SpeechRecognition
  || (window as SpeechWindow).webkitSpeechRecognition
  || null;

let _captureVoiceRec: CaptureSpeechRecognition | null = null;

// Press-to-talk dictation into #qlInput. The transcript (interim + final) flows
// through the same quick-log routing as typed text. Degrades to text-only where
// speech is absent.
function setupCaptureVoice(deps: CaptureVoiceDeps): void {
  const mic = deps.root.querySelector<HTMLElement>("#qlMic");
  const inp = deps.root.querySelector<HTMLInputElement>("#qlInput");
  if (!mic || !inp) return;
  if (!CAPTURE_SPEECH_REC) { mic.hidden = true; return; }
  mic.hidden = false;

  const stop = () => {
    if (_captureVoiceRec) { try { _captureVoiceRec.stop(); } catch {} _captureVoiceRec = null; }
    mic.classList.remove("qlmic-live");
  };

  mic.addEventListener("click", () => {
    if (_captureVoiceRec) { stop(); return; }
    let rec: CaptureSpeechRecognition;
    try { rec = new CAPTURE_SPEECH_REC(); } catch { mic.hidden = true; return; }
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const base = inp.value.trim();
    let finalText = "";
    let heard = false;
    rec.onresult = (e: CaptureSpeechEvent) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      const said = (finalText + interim).trim();
      if (said) heard = true;
      inp.value = (base ? base + " " : "") + said;
    };
    rec.onerror = (e: CaptureSpeechErrorEvent) => {
      if (e && (e.error === "not-allowed" || e.error === "service-not-allowed")) {
        mic.hidden = true;
      }
      heard = false;
      stop();
    };
    rec.onend = () => {
      mic.classList.remove("qlmic-live");
      _captureVoiceRec = null;
      if (heard && inp.value.trim()) deps.quickLog();
    };
    _captureVoiceRec = rec;
    mic.classList.add("qlmic-live");
    try { rec.start(); } catch { stop(); }
  });
}

const CAIRN_CAPTURE_VOICE = {
  micGlyph: CAPTURE_MIC_GLYPH,
  setup: setupCaptureVoice,
};

Object.assign(globalThis, {
  CairnCaptureVoice: CAIRN_CAPTURE_VOICE,
  MIC_GLYPH: CAPTURE_MIC_GLYPH,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnCaptureVoice: CAIRN_CAPTURE_VOICE,
    MIC_GLYPH: CAPTURE_MIC_GLYPH,
  });
}
