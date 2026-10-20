// @ts-check
// The Brief's quiet questions (GET /api/today-asks), split out of today-brief-client.ts to
// keep that module under its size ratchet. EAGER (today bundle), loaded before the Brief:
// it reaches this through the CairnTodayBriefAsks global.
{
  // ---------- the Brief's quiet questions (GET /api/today-asks) ----------
  // A question waits on the Brief — the trip-eve "Lifting on the trip?", an unanswered
  // race-adaptation return back once (src/domain/today/brief-asks.ts). PULL, NEVER PUSH:
  // painted only into today's Brief, under its own slot, never a toast or a badge; each
  // answered key is gone for this device at once and on the server for good. The words
  // and the answers are the server's; this only lays them out and posts the tap.
  type BriefAskRead = import("../contracts/brief-asks.js").BriefAsk;
  type BriefAskAnswerResult = import("../contracts/brief-asks.js").BriefAskAnswerResult;

  const BRIEF_ASKS_FRESH_MS = 60_000;
  let briefAsksCache: { date: string; at: number; asks: BriefAskRead[] } | null = null;
  let briefAsksLoading = "";
  const briefAsksAnswered = new Set<string>();

  function briefAskValid(ask: unknown): ask is BriefAskRead {
    const a = ask as BriefAskRead | null;
    return !!a && typeof a === "object" && typeof a.key === "string" && !!a.key && typeof a.question === "string" &&
      !!a.question.trim() && Array.isArray(a.answers) && a.answers.length > 0;
}

function todayBriefAskHtml(ask: BriefAskRead): string {
  const answers = ask.answers
    .filter((a) => a && typeof a.key === "string" && typeof a.label === "string")
    .map(
      (a, i) =>
        `<button class="btn${i === 0 ? " btn-solid" : ""}" type="button" data-brief-ask-answer="${escAttr(a.key)}">${escHtml(a.label)}</button>`
    )
    .join("");
  return `<section class="tpush-offer brief-ask" data-brief-ask="${escAttr(ask.key)}" aria-label="${escAttr(ask.question)}">
    <span class="lbl tpush-offer-k">A quick question</span>
    <p class="tpush-offer-q">${escHtml(ask.question)}</p>
    ${ask.detail ? `<p class="tpush-offer-until">${escHtml(ask.detail)}</p>` : ""}
    <div class="tpush-offer-btns">${answers}</div>
  </section>`;
}

/** The questions as cards; "" when none waits (the slot collapses). */
function todayBriefAsksHtml(asks: unknown): string {
  return (Array.isArray(asks) ? asks : [])
    .filter(briefAskValid)
    .filter((ask) => !briefAsksAnswered.has(ask.key))
    .slice(0, 2)
    .map(todayBriefAskHtml)
    .join("");
}

function todayBriefAsksSlotHtml(date: string): string {
  const cached = briefAsksCache && briefAsksCache.date === date ? todayBriefAsksHtml(briefAsksCache.asks) : "";
  return `<div class="brief-asks-slot" data-brief-asks="${escAttr(date)}" aria-live="off">${cached}</div>`;
}

function paintBriefAsks(): void {
  if (typeof document === "undefined" || !briefAsksCache) return;
  const cache = briefAsksCache;
  document.querySelectorAll<HTMLElement>("[data-brief-asks]").forEach((slot) => {
    if (slot.getAttribute("data-brief-asks") !== cache.date || slot.getAttribute("data-busy") === "1") return;
    const html = todayBriefAsksHtml(cache.asks);
    if (slot.innerHTML !== html) slot.innerHTML = html;
  });
}

/** Read today's questions (a minute's cache), then paint every slot showing that date. */
function loadBriefAsks(date: string, force = false): void {
  if (!date || typeof api !== "function") return;
  if (!force && briefAsksCache && briefAsksCache.date === date && Date.now() - briefAsksCache.at < BRIEF_ASKS_FRESH_MS) {
    paintBriefAsks();
    return;
  }
  if (briefAsksLoading === date) return;
  briefAsksLoading = date;
  Promise.resolve(api(`/today-asks?date=${encodeURIComponent(date)}` as "/today-asks"))
    .then((value) => {
      const asks = (value as { asks?: unknown } | null)?.asks;
      briefAsksCache = { date, at: Date.now(), asks: (Array.isArray(asks) ? asks : []).filter(briefAskValid) };
      paintBriefAsks();
    })
    .catch(() => {
      /* a question that cannot be read simply is not asked */
    })
    .finally(() => {
      if (briefAsksLoading === date) briefAsksLoading = "";
    });
}

function answerBriefAskTap(button: HTMLElement): void {
  const card = button.closest<HTMLElement>("[data-brief-ask]");
  const slot = card?.closest<HTMLElement>("[data-brief-asks]");
  const key = card?.getAttribute("data-brief-ask") || "";
  const answer = button.getAttribute("data-brief-ask-answer") || "";
  if (!card || !slot || !key || !answer || slot.getAttribute("data-busy") === "1" || typeof api !== "function") return;
  const date = slot.getAttribute("data-brief-asks") || "";
  const before = card.outerHTML;
  slot.setAttribute("data-busy", "1");
  card.setAttribute("aria-busy", "true");
  card.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.disabled = true; });
  const say = (message: unknown) => {
    if (typeof toast === "function" && typeof message === "string" && message.trim()) toast(message);
  };
  Promise.resolve(
    api("/today-asks/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, answer, date }),
    } as RequestInit & { headers: Record<string, string> })
  )
    .then((value) => {
      const result = (value ?? {}) as BriefAskAnswerResult;
      if (result.ok) {
        briefAsksAnswered.add(key);
        card.remove();
        say(result.message);
        if (typeof apiInvalidate === "function") apiInvalidate();
      } else {
        card.outerHTML = before;
        say(result.error || "That couldn't be answered just now.");
      }
    })
    .catch(() => {
      if (card.isConnected) card.outerHTML = before;
      say("That couldn't be answered just now.");
    })
    .finally(() => {
      slot.removeAttribute("data-busy");
    });
}

// One delegated listener for every Brief question, wherever the Brief is painted.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const button = target && typeof target.closest === "function" ? target.closest<HTMLElement>("[data-brief-ask-answer]") : null;
    if (button) answerBriefAskTap(button);
  });
}

function todayBriefAsksDate(read: { date?: unknown } | null | undefined): string {
  const own = String(read?.date ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(own)) return own;
  return typeof localISO === "function" ? localISO() : "";
}

  /** The slot for today's Brief ("" on a past day or a provisional read); fills from /today-asks right after. */
  function slotFor(read: { date?: unknown; _provisional?: unknown } | null | undefined, today: boolean): string {
    const date = today && !read?._provisional ? todayBriefAsksDate(read) : "";
    if (!date) return "";
    if (typeof setTimeout === "function") setTimeout(() => loadBriefAsks(date), 0);
    return todayBriefAsksSlotHtml(date);
  }

  const CAIRN_TODAY_BRIEF_ASKS = { html: todayBriefAsksHtml, slotHtml: todayBriefAsksSlotHtml, load: loadBriefAsks, slotFor };

  Object.assign(globalThis, { CairnTodayBriefAsks: CAIRN_TODAY_BRIEF_ASKS });
}
