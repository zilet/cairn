// @ts-check
// The change receipt: under a coach reply and on a Changes feed row, one line per change the
// server made. Applied: what · how long · Undo. Scheduled: its landing day in the feed's own
// words ("Lands Thursday") and, where the server attached one, a Hold. Undone / not landed:
// the server's words for it ("Put back", "Ended", "Didn't land"). The server wrote every word,
// so it prints verbatim (escHtml). Undo is the brain-decision revert, the one decision-undo
// path; a plan-adaptation undo has no client route, so it draws no button. Absent or
// malformed receipts draw nothing. LAZY (ask bundle).
{
  const clean = (v: unknown): string => String(v ?? "").trim();
  const STATES: Record<string, string> = { scheduled: "Lands soon", undone: "Put back", not_landed: "Didn't land" };

  function rowHtml(r: ClientChangeReceipt, readonly: boolean): string {
    const what = clean(r?.what);
    const key = clean(r?.key);
    if (!what || !key) return "";
    const status = STATES[r.status] ? r.status : "applied";
    const id = Number(r.undo?.id);
    const until = clean(r.until_words);
    const words = status === "applied" ? "" : clean(r.status_words) || STATES[status];
    const state = words ? `<span class="rcpt-state">${escHtml(words)}</span>` : "";
    // A scheduled change is HELD before it lands; an applied one is put back.
    const label = status === "scheduled" ? "Hold" : "Undo";
    const act =
      !readonly && id > 0 && r.undo?.kind === "brain_decision" && (!words || label === "Hold")
        ? `<button class="linkbtn-quiet rcpt-undo" type="button" data-rcpt-undo="${id}" aria-label="${escAttr(`${label}: ${what}`)}">${label}</button>`
        : "";
    return `<li class="rcpt is-${status}" data-rcpt="${escAttr(key)}"><span class="rcpt-what">${escHtml(what)}</span>${
      until ? `<span class="rcpt-until"> · ${escHtml(until)}</span>` : ""
    }${state}${act}</li>`;
  }

  function listHtml(receipts: unknown, options: { readonly?: boolean } = {}): string {
    const rows = (Array.isArray(receipts) ? receipts : []).map((r) => rowHtml(r, !!options.readonly)).join("");
    return rows ? `<ul class="rcpt-list" aria-label="Changes">${rows}</ul>` : "";
  }

  function undo(button: HTMLElement): void {
    const row = button.closest("[data-rcpt]");
    const hold = button.textContent === "Hold";
    const no = `That can no longer be ${hold ? "held" : "undone"}.`;
    const done = hold ? "Held before it landed" : "Put back";
    void CairnDecisionUndoController.revert(button, button.dataset.rcptUndo, { api, toast }, {
      reason: "chat undo",
      success: hold ? "Held — it won't land" : done,
      stale: no,
      failed: no,
      after: () => {
        if (row) row.className = "rcpt is-undone";
        row?.querySelector(".rcpt-state")?.remove();
        button.outerHTML = `<span class="rcpt-state">${done}</span>`;
      },
    });
  }

  Object.assign(globalThis, {
    CairnChangeReceipt: {
      listHtml,
      mount: (host: Element): (() => void) =>
        CairnUiActions.mount(host, "rcpt", ({ delegate }) => delegate("click", { "rcpt-undo": undo })),
    },
  });
}
