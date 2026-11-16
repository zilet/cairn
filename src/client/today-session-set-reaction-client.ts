// @ts-check
// The coach's one line about the set just logged (POST /sets `reaction`, built by
// src/repo/set-reaction.ts), and the one door for what a delivered set says back.

{
  type SetNotesModel = {
    showWeightCheck(card: HTMLElement | null, result: Record<string, unknown>): void;
  };

  // Server prose, so it is painted as text, never markup.
  function setReactionLine(result: Record<string, unknown>): string | null {
    const reaction = result.reaction;
    const line = reaction && typeof reaction === "object" ? (reaction as { line?: unknown }).line : null;
    const text = typeof line === "string" ? line.trim() : "";
    return text ? text.slice(0, 240) : null;
  }

  // A line about the sets on a card no longer describes them once one is deleted.
  function dropWhenASetLeaves(logged: Element, line: HTMLElement): void {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver((records) => {
      if (!line.isConnected) return observer.disconnect();
      if (!records.some((record) => record.removedNodes.length > 0)) return;
      line.remove();
      observer.disconnect();
    });
    observer.observe(logged, { childList: true });
  }

  // One line, in place, right under the card's logged sets: a newer reaction replaces
  // the last one, and a set without one leaves the card as it was. Retries like the
  // weight check, because the first set of a session repaints the card.
  function showSetReaction(card: HTMLElement | null, result: Record<string, unknown>): void {
    const text = setReactionLine(result);
    if (!text) return;
    const code = result.reaction && typeof result.reaction === "object"
      ? String((result.reaction as { code?: unknown }).code || "")
      : "";
    const paint = (): boolean => {
      let host: HTMLElement | null = card?.isConnected ? card : null;
      if (!host) {
        const id = result.id == null ? "" : String(result.id);
        const found = /^\d+$/.test(id) && typeof document !== "undefined" ? document.querySelector(`[data-set="${id}"]`)?.closest(".ex") : null;
        host = found instanceof HTMLElement ? found : null;
      }
      if (!host) return false;
      host.querySelector("[data-set-reaction]")?.remove();
      const line = document.createElement("div");
      line.className = "ex-reaction";
      line.dataset.setReaction = /^[a-z_]+$/.test(code) ? code : "1";
      line.setAttribute?.("role", "status");
      line.textContent = text;
      const logged = host.querySelector("[data-logged]");
      if (logged?.parentElement) logged.parentElement.insertBefore(line, logged.nextSibling);
      else host.appendChild(line);
      if (logged) dropWhenASetLeaves(logged, line);
      return true;
    };
    if (paint() || typeof setTimeout !== "function") return;
    let tries = 0;
    const again = () => {
      if (paint() || ++tries >= 20) return;
      setTimeout(again, 50);
    };
    setTimeout(again, 50);
  }

  // The line a repaint puts back: the session read hangs `reaction` on each lift's last
  // set (the same {code, line} POST /sets answered). Same node the live painter makes.
  function reactionHtml(loggedSets: unknown[]): string {
    const last = loggedSets[loggedSets.length - 1];
    const text = last && typeof last === "object" ? setReactionLine(last as Record<string, unknown>) : null;
    if (!text) return "";
    const code = String(((last as { reaction?: { code?: unknown } }).reaction || {}).code || "");
    return `<div class="ex-reaction" data-set-reaction="${escAttr(/^[a-z_]+$/.test(code) ? code : "1")}" role="status">${escHtml(text)}</div>`;
  }

  // Deleting a set takes the line about those sets down with it, however it was painted.
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target.closest("[data-del]") : null;
        target?.closest(".ex")?.querySelector("[data-set-reaction]")?.remove();
      },
      true
    );
  }

  // Everything a DELIVERED set says back: the weight sanity check, the coach's line on
  // the card, and the toast. A queued set never reaches here, so it shows none of them.
  function delivered(card: HTMLElement | null, result: Record<string, unknown>, toast: (message: string) => void): void {
    const model = (globalThis as unknown as { CairnTodaySessionSetModel: SetNotesModel }).CairnTodaySessionSetModel;
    if (result.weight_check) model.showWeightCheck(card, result);
    const line = setReactionLine(result);
    if (line) showSetReaction(card, result);
    // With a line on the card, the line IS the feedback: no toast, a record still buzzes.
    if (!line) toast(result.pr ? "🏆 New PR!" : "Set logged");
    if (result.pr && typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([60, 40, 120]);
  }

  Object.assign(globalThis, { CairnTodaySetNotes: { setReactionLine, showSetReaction, reactionHtml, delivered } });
}
