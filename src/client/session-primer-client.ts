// @ts-check
// The pre-session primer surface — "a coach was already here". On the /app/session
// destination this renders a calm editorial card from GET /api/session-primer: a
// lead sentence (why today's session is what it is) plus three quiet sections —
// what changed, what to watch, and what's deliberately fresh — and a one-line
// approach. Once the session has logged sets it opens COLLAPSED to a one-line strip
// (tap to expand). Movements new this week get a small "new this week" chip that
// reveals its rationale on tap.
//
// Pure renderers + one guarded hydrate controller (mirrors the done-card highlights
// hydration / feedback-slot pattern). Reading-grammar primitives only (the frozen
// `.read-contrib` grammar from ui-reads.ts / DESIGN.md §04d); no new colors. Every
// server string is escaped. Degrades to a calm no-op when anything's missing.

type PrimerChange = { exercise?: unknown; kind?: unknown; text?: unknown };
type PrimerWatch = { text?: unknown; soft?: unknown };
type PrimerFresh = { exercise?: unknown; why?: unknown };
type SessionPrimerData = {
  why_today?: unknown;
  focus?: unknown;
  changed?: PrimerChange[] | null;
  watch?: PrimerWatch[] | null;
  fresh?: PrimerFresh[] | null;
  approach?: unknown;
} | null | undefined;

type PrimerRuntimeGlobals = typeof globalThis & {
  escHtml?: (value: unknown) => string;
  escAttr?: (value: unknown) => string;
};

type PrimerHydrateOpts = {
  root?: { querySelector(sel: string): Element | null; querySelectorAll(sel: string): ArrayLike<Element> } | null;
  date?: string | null;
  dayNumber?: number | null;
  hasLoggedSets?: boolean;
  api?: (path: string) => Promise<unknown>;
  // Re-checked after the async fetch, right before the DOM write — so a primer
  // resolving after the athlete left this session/date never lands on a new render.
  guard?: () => boolean;
};

(() => {
  // escHtml/escAttr live in an earlier bundle file (shared scope); reach for them
  // lazily so the module is inert (never throws) under the vm test harness or a
  // partial boot. A missing escaper → render nothing rather than unescaped HTML.
  function esc(): { html: (v: unknown) => string; attr: (v: unknown) => string } | null {
    const g = globalThis as PrimerRuntimeGlobals;
    if (typeof g.escHtml !== "function" || typeof g.escAttr !== "function") return null;
    return { html: g.escHtml, attr: g.escAttr };
  }

  function str(value: unknown): string {
    return value == null ? "" : String(value).trim();
  }

  // One reading-grammar contributor row: a state pip + optional label + a state
  // line. Mirrors ui-reads.ts `.read-contrib` (sage `ok`, terracotta `watch`,
  // neutral-outline `quiet`) so the primer speaks the same visual language.
  function contribRow(label: string, state: string, tone: "ok" | "watch" | "quiet", e: NonNullable<ReturnType<typeof esc>>): string {
    if (!label.trim() && !state.trim()) return "";
    const t = tone === "ok" || tone === "watch" ? tone : "quiet";
    const labelHtml = label.trim() ? `<span class="read-contrib-label">${e.html(label)}</span>` : "";
    const stateHtml = state.trim() ? `<span class="read-contrib-state">${e.html(state)}</span>` : "";
    return `<div class="read-contrib"><span class="read-contrib-pip ${t}" aria-hidden="true"></span>${labelHtml}${stateHtml}</div>`;
  }

  function sectionHtml(title: string, rows: string[], e: NonNullable<ReturnType<typeof esc>>): string {
    const inner = rows.filter(Boolean).join("");
    if (!inner) return "";
    return `<div class="sess-primer-sec"><span class="lbl sess-primer-sec-t">${e.html(title)}</span><div class="read-contribs">${inner}</div></div>`;
  }

  // The primer card. `collapsed` opens it as a one-line strip (once the session has
  // logged sets); the head button toggles the body. Returns "" when there's no
  // renderable primer (null payload, no escaper, or genuinely empty).
  function sessionPrimerCardHtml(primer: SessionPrimerData, opts: { collapsed?: boolean } = {}): string {
    const e = esc();
    if (!e || !primer || typeof primer !== "object") return "";
    const why = str(primer.why_today);
    const changed = Array.isArray(primer.changed) ? primer.changed : [];
    const watch = Array.isArray(primer.watch) ? primer.watch : [];
    const fresh = Array.isArray(primer.fresh) ? primer.fresh : [];
    const approach = str(primer.approach);
    if (!why && !changed.length && !watch.length && !fresh.length && !approach) return "";

    const sections = [
      sectionHtml(
        "What changed",
        changed.map((c) => contribRow(str(c?.exercise), str(c?.text), c?.kind === "target" ? "ok" : "quiet", e)),
        e
      ),
      sectionHtml(
        "Keep an eye on",
        watch.map((w) => contribRow("", str(w?.text), w?.soft ? "quiet" : "watch", e)),
        e
      ),
      sectionHtml(
        "Fresh today",
        fresh.map((f) => contribRow(str(f?.exercise), str(f?.why), "quiet", e)),
        e
      ),
    ].join("");

    const collapsed = !!opts.collapsed;
    const kicker = `<span class="lbl sess-primer-kicker">Before you start</span>`;
    const whyHtml = why ? `<span class="sess-primer-why">${e.html(why)}</span>` : "";
    const approachHtml = approach ? `<div class="sess-primer-approach">${e.html(approach)}</div>` : "";
    return `<div class="sess-primer reveal${collapsed ? " collapsed" : ""}" id="sessPrimer" data-primer>
      <button class="sess-primer-head" type="button" data-primer-toggle aria-expanded="${collapsed ? "false" : "true"}">
        <span class="sess-primer-head-text">${kicker}${whyHtml}</span>
        <span class="sess-primer-chev" aria-hidden="true">▾</span>
      </button>
      <div class="sess-primer-body">${sections}${approachHtml}</div>
    </div>`;
  }

  // The small "new this week" chip for a rotated/new movement row. Carries its
  // one-line rationale in a native title AND data attr (revealed inline on tap).
  function sessionFreshChipHtml(why: unknown): string {
    const e = esc();
    if (!e) return "";
    const reason = str(why);
    const titleAttr = reason ? ` title="${e.attr(reason)}"` : "";
    return `<button type="button" class="sess-fresh-chip" data-fresh-why="${e.attr(reason)}"${titleAttr}>new this week</button>`;
  }

  // Toggle the collapsed strip ⇄ full card. Idempotent (guards on a wired flag).
  function wirePrimerToggle(slot: Element): void {
    const card = slot.querySelector("[data-primer]");
    const head = slot.querySelector("[data-primer-toggle]");
    if (!card || !head || (head as HTMLElement).dataset.wired) return;
    (head as HTMLElement).dataset.wired = "1";
    head.addEventListener("click", () => {
      const nowCollapsed = card.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
    });
  }

  // Attach a "new this week" chip to each fresh movement's plan-exercise card, and
  // wire a tap to reveal its rationale inline. Matches on the card's `data-card`
  // (the exercise name); a movement not on screen is skipped. Idempotent.
  function applyFreshChips(root: PrimerHydrateOpts["root"], fresh: PrimerFresh[]): void {
    if (!root || !Array.isArray(fresh) || !fresh.length) return;
    const byName = new Map<string, string>();
    for (const f of fresh) {
      const name = str(f?.exercise).toLowerCase();
      if (name) byName.set(name, str(f?.why));
    }
    if (!byName.size) return;
    const cards = Array.from(root.querySelectorAll(".ex[data-card]"));
    for (const card of cards) {
      const name = str(card.getAttribute("data-card")).toLowerCase();
      const why = byName.get(name);
      if (why == null) continue;
      const top = card.querySelector(".ex-top");
      if (!top || top.querySelector(".sess-fresh-chip")) continue;
      const chipHtml = sessionFreshChipHtml(why);
      if (!chipHtml) continue;
      top.insertAdjacentHTML("beforeend", chipHtml);
      const chip = top.querySelector(".sess-fresh-chip");
      chip?.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const existing = card.querySelector(".sess-fresh-why");
        if (existing) {
          existing.remove();
          return;
        }
        const e = esc();
        if (!e || !why) return;
        card.insertAdjacentHTML("beforeend", `<div class="sess-fresh-why ex-note">${e.html(why)}</div>`);
      });
    }
  }

  // Fetch the primer for the open session and render it into #sessionPrimerSlot,
  // then decorate any fresh movement rows. Guarded + null-safe end to end: no slot /
  // no api / a null or {ok:false} payload → the slot is cleared and nothing else
  // happens (the session surface is never blocked on this).
  async function hydrateSessionPrimer(opts: PrimerHydrateOpts): Promise<void> {
    const root = opts?.root;
    const api = opts?.api;
    if (!root || typeof api !== "function") return;
    const slot = root.querySelector("#sessionPrimerSlot");
    if (!slot) return;
    let primer: SessionPrimerData = null;
    try {
      const params: string[] = [];
      if (opts.date) params.push(`date=${encodeURIComponent(String(opts.date))}`);
      if (opts.dayNumber != null && Number.isFinite(Number(opts.dayNumber))) params.push(`day=${encodeURIComponent(String(opts.dayNumber))}`);
      // The literal "?" keeps this a query, not a path param, for both the router
      // and the client-API coverage contract (a bare trailing "?" is harmless).
      primer = (await api(`/session-primer?${params.join("&")}`)) as SessionPrimerData;
    } catch {
      primer = null;
    }
    // The fetch may outlast the athlete leaving this session/date — bail before any
    // DOM write if the surface has moved on (never paint a stale primer).
    if (typeof opts.guard === "function" && !opts.guard()) return;
    if (!primer || typeof primer !== "object" || (primer as { ok?: unknown }).ok === false) {
      slot.innerHTML = "";
      return;
    }
    const html = sessionPrimerCardHtml(primer, { collapsed: !!opts.hasLoggedSets });
    slot.innerHTML = html;
    if (!html) return;
    wirePrimerToggle(slot);
    applyFreshChips(root, Array.isArray(primer.fresh) ? primer.fresh : []);
  }

  const CAIRN_SESSION_PRIMER = {
    cardHtml: sessionPrimerCardHtml,
    freshChipHtml: sessionFreshChipHtml,
    hydrate: hydrateSessionPrimer,
  };

  Object.assign(globalThis, { CairnSessionPrimer: CAIRN_SESSION_PRIMER });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnSessionPrimer: CAIRN_SESSION_PRIMER });
  }
})();
