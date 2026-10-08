// @ts-check
// The Session destination's first paint: its shell, the primer's early read, and its
// warm instant paint (the same idea as Today's
// cairn.today.plan.v2). Session's first content waits on the plan-session preparation
// and the strength line — round trips even when every cached read is warm — so a
// re-entry showed the previous screen for over half a second. The last real session
// paint is kept per DATE, with a stamp of the cached reads it was drawn from (the
// session, the day's composed session, the plan). It repaints at once only while those
// reads are untouched: every write drops or replaces one of them (a logged set, a skip,
// a swap, an outbox replay, a plan save), the stamp stops matching, and the screen
// waits for the truth instead. The real render always follows and settles on the live
// content. Per-tab (sessionStorage); every storage access is guarded.
//
// Known limit: a logged set is DOM surgery that INVALIDATES today:session:<date>
// (invalidateSetTruth), so after a set the stamp cannot match until a full render has
// re-read the session and saved again. A mid-workout re-entry right after a set
// therefore waits for the truth rather than repainting instantly — by design, since
// the snapshot must never show a pre-write surface.
//
// The paint is inert markup until the real render lands. A typed-draft marker
// (data-dirty) is stripped on save, so the next entry never reads the snapshot's
// prefill as the athlete's own draft and writes it over the real prefill.
{
  type Peek = (key: string) => { data: unknown } | null;
  type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

  const KEY = "cairn.session.surface.v1";

  function stamp(date: string, peek: Peek): string | null {
    const session = peek(`today:session:${date}`);
    if (!session) return null;
    let text = "";
    try {
      text = JSON.stringify([
        session.data ?? null,
        peek(`today:daily-session:${date}`)?.data ?? null,
        peek("plan")?.data ?? null,
      ]);
    } catch {
      return null;
    }
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return `${text.length}:${hash >>> 0}`;
  }

  function save(store: Store | null, date: string, html: string, peek: Peek): void {
    if (!store) return;
    const now = stamp(date, peek);
    try {
      if (!now) store.removeItem(KEY);
      else store.setItem(KEY, JSON.stringify({ date, stamp: now, html: html.replace(/\sdata-dirty="[^"]*"/g, "") }));
    } catch {
      /* quota or blocked storage: skip */
    }
  }

  /** The last session paint for `date`, only while the reads it was drawn from are unchanged. */
  function load(store: Store | null, date: string, peek: Peek): string | null {
    if (!store) return null;
    try {
      const raw = store.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { date?: unknown; stamp?: unknown; html?: unknown } | null;
      if (!parsed || parsed.date !== date || typeof parsed.html !== "string" || typeof parsed.stamp !== "string")
        return null;
      const now = stamp(date, peek);
      return now && now === parsed.stamp ? parsed.html : null;
    } catch {
      return null;
    }
  }

  function storage(): Store | null {
    try {
      return typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch {
      return null;
    }
  }

  // The session's other first-paint pieces, split out of today-screen.ts: the primer's
  // read (asked early, so it lands in the same frame as the list) and the shell.
  const PRIMER_WAIT_MS = 1200;

  /** The primer's read for a date and plan day, spelled exactly as the primer asks it. */
  function primerPath(date: string, dayNumber: number | null): string {
    const params: string[] = [];
    if (date) params.push(`date=${encodeURIComponent(String(date))}`);
    if (dayNumber != null && Number.isFinite(Number(dayNumber)))
      params.push(`day=${encodeURIComponent(String(dayNumber))}`);
    return `/session-primer?${params.join("&")}`;
  }

  function shellHtml(
    inner: string,
    meta: {
      fresh: boolean;
      kicker: string;
      dayName: string;
      dayFocus: string;
      why?: string;
      estimate?: number | null;
      exDone: number;
      exTotal: number;
      /** The plan day's own list when most of today's slots moved — one tap away. */
      original?: string[];
      /** Offer the plan day itself when the accepted session holds no lift for it. */
      startDay?: { dayNumber: number; label: string } | null;
    }
  ): string {
    const capped = Math.min(meta.exTotal, 12);
    const dots = meta.exTotal
      ? `<div class="sess-dots" aria-hidden="true">${Array.from({ length: capped }, (_v, i) => `<span class="sess-dot${i < meta.exDone ? " on" : ""}"></span>`).join("")}</div>`
      : "";
    const prog = meta.exTotal
      ? `<span class="sess-prog"><b>${meta.exDone}</b><span class="sess-prog-sep"> of </span>${meta.exTotal}</span>`
      : "";
    return `<div class="sess-dest${meta.fresh ? " sess-fresh" : ""}">
    <div class="sess-topbar" data-occludes="top">
      <button class="sess-close" id="sessClose" type="button" aria-label="Back to today">←</button>
      <div class="sess-topbar-mid">
        <div class="sess-kicker lbl">${escHtml(meta.kicker)}</div>
        <div class="sess-dayname" role="heading" aria-level="1" tabindex="-1">${escHtml(meta.dayName)}${meta.dayFocus ? `<span class="sess-focus"> · ${escHtml(meta.dayFocus)}</span>` : ""}</div>
        ${meta.why || meta.estimate ? `<div class="sess-topbar-why">${meta.why ? escHtml(meta.why) : ""}${meta.estimate ? `${meta.why ? " · " : ""}${Math.round(meta.estimate)} min` : ""}</div>` : ""}
        ${meta.original && meta.original.length ? `<details class="strength-line-orig sess-orig"><summary>The plan's list</summary><span>${escHtml(meta.original.join(" · "))}</span></details>` : ""}
        ${meta.startDay ? `<button type="button" class="ghostbtn sess-line-start daybtn" data-day="${escAttr(meta.startDay.dayNumber)}">${escHtml(meta.startDay.label)}</button>` : ""}
      </div>
      <div class="sess-topbar-side">${prog}</div>
    </div>
    ${dots}
    <div class="sess-body"><div id="sessionPrimerSlot" class="sess-primer-slot"></div>${inner}</div>
  </div>`;
  }

  // The date the Session surface on screen was last painted for (a real render or the
  // snapshot), so a repaint carries the primer card over only for that same date.
  let paintedDate: string | null = null;
  function markPainted(date: string): void {
    paintedDate = date;
  }
  /** The on-screen primer card for `date`'s surface, or "" when there is nothing to carry. */
  function primerCarry(root: ParentNode, date: string): string {
    if (!date || paintedDate !== date) return "";
    return root.querySelector(".sess-dest #sessionPrimerSlot")?.innerHTML || "";
  }
  /** After a real paint: record its date and put the carried card in the new, empty slot
   * until the primer's hydrate replaces it — so the list below never jumps. */
  function painted(root: ParentNode, date: string, carried: string): void {
    markPainted(date);
    if (!carried) return;
    const slot = root.querySelector(".sess-dest #sessionPrimerSlot");
    if (slot && !slot.innerHTML) slot.innerHTML = carried;
  }

  const CAIRN_SESSION_SNAPSHOT = {
    KEY,
    stamp,
    save,
    load,
    storage,
    PRIMER_WAIT_MS,
    primerPath,
    shellHtml,
    markPainted,
    primerCarry,
    painted,
  };
  Object.assign(globalThis, { CairnSessionSnapshot: CAIRN_SESSION_SNAPSHOT });
}
