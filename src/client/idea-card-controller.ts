// @ts-check
// Idea cards, the controller (docs/V2-PLAN.md wave 2, "idea-card"). `mount(host, deps)`
// paints GET /api/fuel/ideas for the day — from the SWR cache when warm, the shimmer
// only on a cold start — and never waits on an agent (the read is deterministic).
// "Start from this" hands the idea's prefill to `deps.onStart` (the host fills the
// composer; nothing is logged). "Another idea" asks the server for ideas excluding
// every staple this mount has shown and swaps in the first new one, in place; when
// there is none it says so in one line and leaves the card as it was. `refresh()`
// re-reads after a log (what was eaten drops out, the room left moves).
{
  type Idea = import("../contracts/fuel.js").ClientFuelIdea;
  type Ideas = import("../contracts/fuel.js").ClientFuelIdeas;
  type Deps = ClientIdeaCardDeps;

  const key = (date: string): string => `fuel:ideas:${date}`;

  function path(date: string, hour: number, exclude: readonly string[] = []): string {
    const params = [`date=${encodeURIComponent(date)}`];
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) params.push(`hour=${hour}`);
    if (exclude.length) params.push(`exclude=${encodeURIComponent(exclude.slice(0, 50).join(","))}`);
    return `/fuel/ideas?${params.join("&")}`;
  }

  function isIdeas(value: unknown): value is Ideas {
    return (
      !!value && typeof value === "object" && (value as Ideas).kind === "ideas" && Array.isArray((value as Ideas).ideas)
    );
  }

  function fromHtml(html: string): HTMLElement | null {
    const box = document.createElement("ul");
    box.innerHTML = html;
    return box.firstElementChild as HTMLElement | null;
  }

  function mountIdeaCards(host: Element, deps: Deps): ClientFuelRefreshHandle {
    let generation = 0;
    let shown: Idea[] = [];
    let painted = "";
    let refreshing = false;
    // Every key this mount has put on screen: "Another idea" never offers one twice.
    const seen = new Set<string>();

    const live = (gen: number): boolean => gen === generation && host.isConnected;
    const setRefreshing = (on: boolean): void => {
      if (refreshing === on) return;
      refreshing = on;
      deps.markRefreshing?.(on);
    };

    function paint(data: Ideas, opts: { reveal?: boolean }): void {
      const sig = JSON.stringify([data.ideas, data.words]);
      if (sig === painted) return;
      painted = sig;
      shown = deps.limit && deps.limit > 0 ? data.ideas.slice(0, deps.limit) : data.ideas.slice();
      for (const idea of shown) seen.add(idea.key);
      host.innerHTML = CairnIdeaCard.ideasHtml(data, { ...opts, limit: deps.limit });
    }

    function load(): Promise<void> {
      const gen = ++generation;
      const warm = deps.peekCached<Ideas>(key(deps.date));
      if (warm && isIdeas(warm.data)) {
        paint(warm.data, { reveal: !painted });
        setRefreshing(!warm.fresh);
      } else if (!painted) {
        host.innerHTML = deps.skeleton ? deps.skeleton() : "";
      }
      return deps
        .cachedApi(path(deps.date, deps.hour()), { key: key(deps.date) })
        .then((data) => {
          if (gen === generation) setRefreshing(false);
          if (live(gen) && isIdeas(data)) paint(data, { reveal: !painted });
        })
        .catch(() => {
          if (gen === generation) setRefreshing(false);
          if (live(gen) && !painted) host.innerHTML = CairnIdeaCard.errorHtml(deps.limit);
        });
    }

    function refresh(): Promise<void> {
      deps.swrInvalidate(key(deps.date));
      seen.clear();
      for (const idea of shown) seen.add(idea.key);
      return load();
    }

    function cardFor(el: HTMLElement): { card: HTMLElement; idea: Idea } | null {
      const card = el.closest<HTMLElement>("[data-idea-card]");
      const id = card?.getAttribute("data-idea-card");
      const idea = shown.find((row) => row.key === id);
      return card && idea ? { card, idea } : null;
    }

    function start(el: HTMLElement): void {
      const hit = cardFor(el);
      if (hit) deps.onStart(hit.idea.prefill, hit.idea);
    }

    async function another(btn: HTMLElement): Promise<void> {
      const hit = cardFor(btn);
      if (!hit || btn.getAttribute("aria-busy") === "true") return;
      const { card, idea } = hit;
      const status = card.querySelector(".idea-card-status");
      const gen = generation;
      btn.setAttribute("aria-busy", "true");
      let next: Idea | null = null;
      let failed = false;
      try {
        const data = await deps.api(path(deps.date, deps.hour(), [...seen]));
        const onScreen = new Set(shown.map((row) => row.key));
        next = isIdeas(data) ? (data.ideas.find((row) => !seen.has(row.key) && !onScreen.has(row.key)) ?? null) : null;
      } catch {
        failed = true;
      }
      btn.removeAttribute("aria-busy");
      if (gen !== generation || !card.isConnected) return;
      if (!next) {
        if (status) {
          status.textContent = failed ? "Couldn't find another just now." : "No other staple to offer here yet.";
        }
        if (!failed) btn.setAttribute("disabled", "");
        return;
      }
      seen.add(next.key);
      shown = shown.map((row) => (row.key === idea.key ? (next as Idea) : row));
      painted = "";
      const fresh = fromHtml(CairnIdeaCard.ideaCardHtml(next, { enter: !deps.reducedMotion() }));
      if (fresh) card.replaceWith(fresh);
      // Focus stays where the tap was: on the new card's own "Another idea".
      fresh?.querySelector<HTMLElement>("[data-idea-card-another]")?.focus();
    }

    const teardown = CairnUiActions.mount(host, "idea-card", ({ delegate }) => {
      delegate("click", {
        "idea-card-start": (el) => start(el),
        "idea-card-another": (el) => another(el),
        "idea-cards-retry": () => void load(),
      });
      void load();
      return () => {
        generation++;
        setRefreshing(false);
      };
    });
    return Object.assign(teardown, { refresh });
  }

  const CAIRN_IDEA_CARD_CONTROLLER = {
    key,
    path,
    mount: mountIdeaCards,
  };

  Object.assign(globalThis, { CairnIdeaCardController: CAIRN_IDEA_CARD_CONTROLLER });
}
