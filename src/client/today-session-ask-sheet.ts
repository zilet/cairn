// @ts-check
// "Ask for a session" as a sheet (CairnUiSheet, the one overlay primitive): the
// athlete types the ask, then watches it draft and reads the result in the same
// place, instead of a composer painted far below the Brief.
//
// The sheet does not re-implement the flow. It borrows the Today suggestion slot
// (`#sugSlot`) for as long as it is open: the node moves into the sheet, so the
// composer, the loading card and its caption, the drafted card and "Use this
// session" all run exactly as they do inline (the controller finds the slot by id).
// Closing the sheet puts the slot back where it was; a draft still in flight
// keeps going and lands inline. The sheet closes itself when the slot empties
// (Cancel, Dismiss, or the accepted session opening).

(() => {
  let open: { close(options?: { instant?: boolean }): void } | null = null;

  function sheetHtml(): string {
    return `<div class="sug-sheet-head">
        <h2 class="sug-sheet-title" id="sugSheetTitle">Ask for a session</h2>
        <button type="button" class="xbtn sug-sheet-x" data-ui-sheet-close aria-label="Close">✕</button>
      </div>
      <p class="sug-sheet-lead">Say what you want today. It drafts a session you can use or leave.</p>
      <div class="sug-sheet-body"></div>`;
  }

  // Opens the sheet and asks `reveal` to paint the composer into the borrowed slot.
  // Returns false when the sheet can't open (no primitive, no slot, a draft already
  // in the slot), so the caller keeps the inline composer.
  function openAskSheet(reveal: () => void): boolean {
    const sheets = (globalThis as { CairnUiSheet?: { open(options: Record<string, unknown>): { sheet: HTMLElement; close(options?: { instant?: boolean }): void } } }).CairnUiSheet;
    const slot = document.getElementById("sugSlot");
    if (!sheets || !slot || open) return false;
    // A draft already under way inline stays where the athlete can see it.
    if (slot.querySelector(".sug-loading")) return false;

    const home = document.createComment("sugSlot home");
    slot.before(home);
    let observer: MutationObserver | null = null;
    const handle = sheets.open({
      html: sheetHtml(),
      labelledBy: "sugSheetTitle",
      sheetClass: "ui-sheet sug-sheet",
      sheetTag: "section",
      // The composer is painted into the borrowed slot right after open; it is also
      // focused synchronously below so the keyboard comes up with the tap.
      initialFocus: ".sug-prompt",
      onClose: () => {
        observer?.disconnect();
        open = null;
        if (home.parentNode) home.replaceWith(slot);
        // Whatever the sheet was showing besides a live draft goes with it.
        if (!slot.querySelector(".sug-loading")) slot.innerHTML = "";
      },
    });
    open = handle;
    handle.sheet.querySelector(".sug-sheet-body")?.appendChild(slot);
    reveal();
    // Nothing painted (a draft still settling): never leave an empty sheet up.
    if (!slot.childElementCount) {
      handle.close({ instant: true });
      return false;
    }
    // Still inside the athlete's tap, so iOS raises the keyboard with it.
    slot.querySelector<HTMLElement>(".sug-prompt")?.focus();
    if (typeof MutationObserver === "function") {
      observer = new MutationObserver(() => {
        if (!slot.childElementCount) handle.close();
      });
      observer.observe(slot, { childList: true });
    }
    return true;
  }

  function wireIdeateButton(root: ParentNode | null | undefined, openIdeate: () => void): void {
    const btn = root?.querySelector?.<HTMLElement>("#ideateExBtn");
    if (!btn || btn.dataset.ideateWired === "1") return;
    btn.dataset.ideateWired = "1";
    btn.addEventListener("click", openIdeate);
  }

  function wireAddedRemovals(
    root: ParentNode | null | undefined,
    onRemove: (exercise: string, card: HTMLElement | null) => Promise<void> | void
  ): void {
    if (!root || typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll<HTMLElement>("[data-remove-added]").forEach((btn) => {
      if (btn.dataset.wiredRemoveAdded === "1") return;
      btn.dataset.wiredRemoveAdded = "1";
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (btn.dataset.busy === "1") return;
        const exercise = decodeURIComponent(btn.dataset.removeAdded || "");
        if (!exercise) return;
        btn.dataset.busy = "1";
        void Promise.resolve(onRemove(exercise, btn.closest<HTMLElement>(".ex"))).finally(() => {
          btn.dataset.busy = "";
        });
      });
    });
  }

  const CAIRN_TODAY_SESSION_ASK_SHEET = { open: openAskSheet, wireIdeateButton, wireAddedRemovals };

  Object.assign(globalThis, { CairnTodaySessionAskSheet: CAIRN_TODAY_SESSION_ASK_SHEET });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodaySessionAskSheet: CAIRN_TODAY_SESSION_ASK_SHEET });
  }
})();
