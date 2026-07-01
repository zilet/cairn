// @ts-check
// Chat composer wiring: attachment preview state, send behavior, drafts, paste,
// and mobile keyboard focus recovery.

let chatComposerPasteHandler: ((event: ClipboardEvent) => void) | null = null;

function chatComposerRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function chatComposerString(value: unknown): string {
  return value == null ? "" : String(value);
}

function chatComposerIsSoftKeyboard(): boolean {
  return !matchMedia("(hover:hover)").matches;
}

function chatComposerKeyboardGeometryOpen(): boolean {
  return document.body.classList.contains("kb-geometry-open");
}

function clearChatComposerPasteHandler(): void {
  if (!chatComposerPasteHandler) return;
  document.removeEventListener("paste", chatComposerPasteHandler);
  chatComposerPasteHandler = null;
}

function wireChatComposer(deps: ChatComposerControllerDeps): ChatComposerControllerHandle {
  let attached: ChatScreenImagePayload | null = null;

  const isChatActive = () => deps.state.tab === "chat";
  const resetChatFocusAfterNativePicker = () => CairnChatAttachment.resetFocusAfterNativePicker({
    input: deps.input,
    fileInput: deps.fileInput,
    isSoftKeyboard: chatComposerIsSoftKeyboard,
  });
  const settleChatAfterNativePicker = () => CairnChatAttachment.settleAfterNativePicker({
    isActive: isChatActive,
    measure: deps.measure,
    graceMs: 1200,
  });
  const clearAttachment = () => {
    attached = null;
    deps.fileInput.value = "";
    deps.preview.hidden = true;
    deps.attachBtn.classList.remove("has-img");
    settleChatAfterNativePicker();
  };
  const attachFile = async (f: File | null | undefined) => {
    if (!f) return;
    try {
      attached = await CairnChatAttachment.compressImage(f);
      const img = CairnChatAttachment.previewImage(deps.preview.querySelector("img"));
      if (img) img.src = attached.dataUrl;
      deps.preview.hidden = false;
      deps.attachBtn.classList.add("has-img");
    } catch (e) {
      const tooLarge = e instanceof Error && e.message === "image-too-large";
      deps.toast(tooLarge ? "That photo is too large — try a closer crop." : "Couldn't read that image — try another.");
      clearAttachment();
    } finally {
      settleChatAfterNativePicker();
    }
  };

  // One "+" control. On iOS a file input with no `capture` opens the native
  // sheet (Take Photo / Photo Library / Choose File); desktop opens the file
  // dialog. Attaching is occasional, so this keeps the bar to input + send.
  deps.attachBtn.addEventListener("click", () => {
    resetChatFocusAfterNativePicker();
    settleChatAfterNativePicker();
    deps.fileInput.click();
  });
  deps.preview.querySelector("#chatPreviewX")?.addEventListener("click", clearAttachment);
  deps.fileInput.addEventListener("change", () => {
    resetChatFocusAfterNativePicker();
    const f = deps.fileInput.files && deps.fileInput.files[0];
    if (f) void attachFile(f);
    else settleChatAfterNativePicker();
  });

  // Paste-an-image support (desktop screenshots, iOS "Copy Photo"). One live
  // handler at a time: re-renders swap it out, and it bails when chat isn't
  // the active tab so it never touches a stale DOM.
  clearChatComposerPasteHandler();
  chatComposerPasteHandler = (e: ClipboardEvent) => {
    if (deps.state.tab !== "chat" || !deps.input.isConnected) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); void attachFile(f); }
        return;
      }
    }
  };
  document.addEventListener("paste", chatComposerPasteHandler);

  // Send = enqueue a durable turn and return immediately; the input never blocks,
  // so a follow-up typed while the coach is thinking simply queues (its own turn,
  // drained serially server-side). The monitor streams real progress + finalizes.
  const send = async () => {
    const text = deps.input.value.trim();
    const img = attached;
    if (!text && !img) return;
    deps.input.value = "";
    deps.autosizeInput(deps.input); // collapse the composer back to one line
    deps.saveDraft("");
    clearAttachment();
    // Optimistic user bubble lands instantly (the server persists it too; a full
    // re-render later draws from server truth, so no duplicate).
    const userMsg: ChatScreenMessage = { role: "user", content: text || "(photo)", meta: img ? { image: img.dataUrl } : null };
    const userBubble = deps.appendMsg(userMsg);
    deps.rememberFuelContext(userMsg);
    void deps.loadFuel(deps.token);
    try {
      const body: Record<string, unknown> = { message: text };
      if (img) { body.image_base64 = img.base64; body.image_mime = img.mime; }
      const r = chatComposerRecord(await deps.api("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (r.turn) { deps.spawnPendingBubble(r.turn); deps.ensureMonitor(); }
      else deps.appendMsg({ role: "assistant", content: chatComposerString(r.error) || "(no reply)" });
    } catch {
      // Couldn't even enqueue (offline): roll the optimistic bubble back and put
      // the text back in the composer so nothing is lost -- the offline banner says why.
      userBubble?.remove();
      if (!deps.input.value) {
        deps.input.value = text;
        deps.saveDraft(text);
        deps.autosizeInput(deps.input);
      }
      deps.toast("Couldn't send — check your connection");
    } finally {
      if (matchMedia("(hover:hover)").matches) deps.input.focus();
    }
  };

  // Tapping send must NOT blur the textarea (that just dismisses the keyboard,
  // and as the layout reflows the button slides out from under your finger so
  // the first tap never sends). preventDefault on pointerdown keeps the input
  // focused -- but on iOS WebKit that ALSO suppresses the synthesized click, so
  // we send on pointerup instead (fires on both touch and mouse). The click
  // handler stays for keyboard activation (Enter/Space on the focused button);
  // send()'s empty-input guard makes any second call a no-op, so pointer
  // devices never double-send. (The "+" is left alone -- it opens a file picker.)
  deps.sendBtn.addEventListener("pointerdown", (e) => e.preventDefault());
  deps.sendBtn.addEventListener("pointerup", () => { void send(); });
  deps.sendBtn.addEventListener("click", () => { void send(); });
  // Desktop: Enter sends, Shift+Enter drops a newline. Touch keyboards keep
  // Enter as a newline (so multi-line capture -- pasting findings, describing a
  // meal -- just works) and send via the arrow button.
  deps.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && matchMedia("(hover:hover)").matches) {
      e.preventDefault();
      void send();
    }
  });
  // Re-pin the column across the whole keyboard slide, and recover stale iOS
  // textarea focus from the next real tap after a native image picker closes.
  CairnChatComposerFocus.wireFocus({
    input: deps.input,
    isActive: isChatActive,
    isSoftKeyboard: chatComposerIsSoftKeyboard,
    isKeyboardGeometryOpen: chatComposerKeyboardGeometryOpen,
    measure: deps.measure,
  });
  // Persist the unsent draft on every keystroke so it survives a tab switch /
  // reload -- restored below unless a deep-link prefill takes precedence. Re-grow
  // the composer to fit what's typed/pasted.
  deps.input.addEventListener("input", () => {
    deps.saveDraft(deps.input.value);
    deps.autosizeInput(deps.input);
  });
  // Deep links (e.g. the compass nudge) arrive with the question pre-written --
  // leave it editable rather than auto-sending. Otherwise restore the saved draft.
  if (deps.state.chatPrefill) {
    deps.input.value = deps.state.chatPrefill;
    deps.state.chatPrefill = null;
    deps.saveDraft(deps.input.value);
  } else {
    const draft = deps.loadDraft();
    if (draft) deps.input.value = draft;
  }
  deps.autosizeInput(deps.input); // fit a restored multi-line draft
  // desktop only -- on mobile, auto-focus pops the keyboard over half the view
  if (matchMedia("(hover:hover)").matches) deps.input.focus();

  return { send, clearAttachment };
}

const CAIRN_CHAT_COMPOSER_CONTROLLER = {
  wire: wireChatComposer,
  clearPasteHandler: clearChatComposerPasteHandler,
};

Object.assign(globalThis, { CairnChatComposerController: CAIRN_CHAT_COMPOSER_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnChatComposerController = CAIRN_CHAT_COMPOSER_CONTROLLER;
}
