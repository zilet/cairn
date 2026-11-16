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

  // Everything a DELIVERED set says back: the weight sanity check, the coach's line on
  // the card, and the toast. A queued set never reaches here, so it shows none of them.
  function delivered(card: HTMLElement | null, result: Record<string, unknown>, toast: (message: string) => void): void {
    const model = (globalThis as unknown as { CairnTodaySessionSetModel: SetNotesModel }).CairnTodaySessionSetModel;
    if (result.weight_check) model.showWeightCheck(card, result);
    if (result.reaction) showSetReaction(card, result);
    if (result.pr) {
      toast("🏆 New PR!");
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([60, 40, 120]);
    } else {
      toast("Set logged");
    }
  }

  Object.assign(globalThis, { CairnTodaySetNotes: { setReactionLine, showSetReaction, delivered } });
}
