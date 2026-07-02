// @ts-check
// Chat composer focus recovery for mobile native pickers and soft keyboards.
// Kept out of chat-screen so the iOS/Android tap sequence is explicit and testable.

type ChatComposerFocusInput = HTMLTextAreaElement | HTMLInputElement;

type ChatComposerFocusWireOptions = {
  input: ChatComposerFocusInput;
  isActive: () => boolean;
  isSoftKeyboard: () => boolean;
  isKeyboardGeometryOpen: () => boolean;
  measure: () => void;
  requestFrame?: typeof requestAnimationFrame;
  setTimer?: typeof setTimeout;
};

type ChatComposerFocusRecoverOptions = {
  input: ChatComposerFocusInput;
  isActive: () => boolean;
  isSoftKeyboard: () => boolean;
  measure: () => void;
  requestFrame?: typeof requestAnimationFrame;
  setTimer?: typeof setTimeout;
};

type ChatComposerFocusReleaseOptions = {
  input: ChatComposerFocusInput;
  isSoftKeyboard: () => boolean;
  isKeyboardGeometryOpen: () => boolean;
  measure: () => void;
};

type ChatComposerFocusSettleOptions = {
  isActive: () => boolean;
  measure: () => void;
  requestFrame?: typeof requestAnimationFrame;
  setTimer?: typeof setTimeout;
};

type ChatComposerFocusHandle = {
  releaseStaleInputFocus: () => void;
  recoverInputFocusFromTap: () => void;
  settleViewport: () => void;
};

function chatComposerSettleViewport(options: ChatComposerFocusSettleOptions): void {
  const raf = options.requestFrame || requestAnimationFrame;
  const timer = options.setTimer || setTimeout;
  options.measure();
  raf(() => raf(options.measure));
  for (const delay of [80, 160, 260, 380, 520]) {
    timer(() => { if (options.isActive()) options.measure(); }, delay);
  }
}

function chatComposerFocusInput(input: ChatComposerFocusInput): void {
  try { input.focus({ preventScroll: true }); }
  catch { input.focus(); }
}

function chatComposerReleaseStaleInputFocus(options: ChatComposerFocusReleaseOptions): void {
  // Never blur on pointerdown. The old blur-then-refocus-within-one-tap (blur here,
  // refocus on pointerup) flickered the keyboard; worse, a stale "geometry closed"
  // read blurred a composer whose keyboard was actually up. Recovery is refocus-only
  // (recoverInputFocusFromTap on pointerup/click); this just re-measures the column.
  options.measure();
}

function chatComposerRecoverInputFocusFromTap(options: ChatComposerFocusRecoverOptions): void {
  if (!options.isSoftKeyboard() || !options.isActive() || !options.input.isConnected) return;
  chatComposerFocusInput(options.input);
  chatComposerSettleViewport({
    isActive: options.isActive,
    measure: options.measure,
    requestFrame: options.requestFrame,
    setTimer: options.setTimer,
  });
}

function chatComposerWireFocus(options: ChatComposerFocusWireOptions): ChatComposerFocusHandle {
  const settleViewport = () => chatComposerSettleViewport(options);
  const releaseStaleInputFocus = () => chatComposerReleaseStaleInputFocus(options);
  const recoverInputFocusFromTap = () => chatComposerRecoverInputFocusFromTap(options);

  options.input.addEventListener("pointerdown", releaseStaleInputFocus);
  options.input.addEventListener("pointerup", recoverInputFocusFromTap, { passive: true });
  options.input.addEventListener("click", recoverInputFocusFromTap);
  for (const ev of ["focus", "blur"] as const) options.input.addEventListener(ev, settleViewport);

  return { releaseStaleInputFocus, recoverInputFocusFromTap, settleViewport };
}

const CAIRN_CHAT_COMPOSER_FOCUS = {
  focusInput: chatComposerFocusInput,
  releaseStaleInputFocus: chatComposerReleaseStaleInputFocus,
  recoverInputFocusFromTap: chatComposerRecoverInputFocusFromTap,
  settleViewport: chatComposerSettleViewport,
  wireFocus: chatComposerWireFocus,
};

Object.assign(globalThis, { CairnChatComposerFocus: CAIRN_CHAT_COMPOSER_FOCUS });

if (typeof window !== "undefined") {
  window.CairnChatComposerFocus = CAIRN_CHAT_COMPOSER_FOCUS;
}
