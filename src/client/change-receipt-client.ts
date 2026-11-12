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
    // The way forward (a session receipt's "Start Upper"): the server re-reads it on every
    // read and drops it once the session no longer owns the day, so draw exactly what came.
    const date = clean(r.open?.date);
    const openLabel = clean(r.open?.label);
    const go =
      !readonly && status !== "undone" && r.open?.kind === "session" && date && openLabel
        ? `<button class="btn btn-solid rcpt-open" type="button" data-rcpt-open="${escAttr(date)}">${escHtml(openLabel)}</button>`
        : "";
    return `<li class="rcpt is-${status}" data-rcpt="${escAttr(key)}"><span class="rcpt-what">${escHtml(what)}</span>${
      until ? `<span class="rcpt-until"> · ${escHtml(until)}</span>` : ""
    }${state}${go}${act}</li>`;
  }

  function listHtml(receipts: unknown, options: { readonly?: boolean } = {}): string {
    const rows = (Array.isArray(receipts) ? receipts : []).map((r) => rowHtml(r, !!options.readonly)).join("");
    return rows ? `<ul class="rcpt-list" aria-label="Changes">${rows}</ul>` : "";
  }

  // Opens the receipt's session through the app's one entry (the assertion/reuse path: an
  // ordinary open, never replace), so it lands on the session the receipt describes.
  function open(button: HTMLElement): void {
    const date = button.dataset.rcptOpen;
    if (!date || typeof openSession !== "function") return;
    void openSession(date, { source: "adaptive_plan", trigger: button, provenance: { entry: "chat_receipt" } });
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
        row?.querySelector(".rcpt-open")?.remove();
        button.outerHTML = `<span class="rcpt-state">${done}</span>`;
      },
    });
  }

  Object.assign(globalThis, {
    CairnChangeReceipt: {
      listHtml,
      mount: (host: Element): (() => void) =>
        CairnUiActions.mount(host, "rcpt", ({ delegate }) => delegate("click", { "rcpt-undo": undo, "rcpt-open": open })),
    },
  });
}
