// @ts-check
// The You home (/app/you, and /app/you/stone?id=<key>): the whole cairn, then Health,
// About you and Settings.
//
// - The landing leads with the full six-stone cairn-stack (cairn-stack-*.ts) off its
//   own GET /api/today/stones read, then three quiet groups of rows into the
//   surfaces that live under You.
// - A stone opens its detail (stone-detail-*.ts): its read, then the places that
//   part of the picture already lives. The decade view is reached from Heart's.
//
// This file is in an EAGER bundle (02), so You paints as fast as Today and never
// waits on the lazy me-health bundle: Health and About you load it on the tap that
// needs it (render-dispatch awaits ensureBundle for the stand and me views), and
// nothing here touches that bundle's globals.

type YouLandingView = "stand" | "me" | "settings";
type YouLandingRow = {
  view: YouLandingView;
  section: string | null;
  title: string;
  sub: string;
};
type YouLandingGroup = { key: string; title: string; rows: readonly YouLandingRow[] };

{
  type RouteSection = import("../contracts/client.js").ClientRoute["section"];

  const YOU_LANDING_GROUPS: readonly YouLandingGroup[] = [
    {
      key: "health",
      title: "Health",
      rows: [
        {
          view: "stand",
          section: null,
          title: "Health: where you stand",
          sub: "Your markers, what they connect to, and what to do next",
        },
        { view: "stand", section: "markers", title: "Markers", sub: "Every result, searchable, out of range first" },
        { view: "stand", section: "records", title: "Records", sub: "Add labs or scans, and everything already uploaded" },
        { view: "stand", section: "share", title: "Doctor packet", sub: "Your labs in clinical order, ready for a visit" },
        { view: "stand", section: "checkup", title: "Checkup", sub: "What is worth re-checking, and when" },
      ],
    },
    {
      key: "about",
      title: "About you",
      rows: [
        { view: "me", section: "profile", title: "Profile", sub: "About you, goals, discipline & bodyweight" },
        { view: "me", section: "life", title: "Life", sub: "Trips, injuries & events on your timeline" },
        { view: "me", section: "family", title: "Family", sub: "The people your coach plans around" },
        { view: "me", section: "memory", title: "Memory", sub: "What Cairn remembers about you" },
      ],
    },
    {
      key: "settings",
      title: "Settings",
      rows: [
        { view: "settings", section: "sources", title: "Sources", sub: "Garmin and Apple Health" },
        { view: "settings", section: "automation", title: "Automation", sub: "How much the team does on its own" },
        { view: "settings", section: "data", title: "Data", sub: "Export, backup and this app" },
        { view: "settings", section: "agents", title: "Agents", sub: "The coaching agents and their order" },
        { view: "settings", section: "devices", title: "Devices", sub: "Pair your phone, passkeys" },
        { view: "settings", section: "system", title: "System", sub: "Updates and diagnostics" },
      ],
    },
  ];

  function youLandingHtml(groups: readonly YouLandingGroup[] = YOU_LANDING_GROUPS): string {
    return groups
      .map(
        (group, groupIndex) =>
          `<section class="you-group reveal" style="--i:${groupIndex + 1}" aria-labelledby="youGroup-${escAttr(group.key)}">
        <h2 class="lbl you-group-h" id="youGroup-${escAttr(group.key)}">${escHtml(group.title)}</h2>
        <div class="set-you you-list">${group.rows
          .map(
            (row) =>
              `<button class="set-you-card you-row" type="button" data-you-view="${escAttr(row.view)}" data-you-section="${escAttr(row.section || "")}">
            <span class="you-row-text"><span class="set-you-t">${escHtml(row.title)}</span><span class="set-you-s">${escHtml(row.sub)}</span></span>
            <span class="set-you-arw chev" aria-hidden="true">›</span>
          </button>`
          )
          .join("")}</div>
      </section>`
      )
      .join("");
  }

  function openYouRow(viewName: string, section: string): void {
    if (viewName === "stand") {
      state.standSeg = (section || null) as ClientStandSection | null;
      state.standDomain = null;
      activateTab("stand");
    } else if (viewName === "me") {
      state.meSeg = (section || "profile") as ClientMeSection;
      activateTab("me");
    } else if (viewName === "settings") {
      if (section) state.setSeg = section as ClientSettingsSection;
      activateTab("settings");
    }
  }

  // ---- stones -------------------------------------------------------------------
  // The stones read is today's, whatever day Today is showing: You is the whole
  // picture as it stands now.
  function youHrefFor(target: ClientYouTarget): string | null {
    const routes = typeof routeApi === "function" ? routeApi() : null;
    return routes
      ? routes.routeToUrl({ tab: target.tab, section: target.section as RouteSection, id: target.id || null })
      : null;
  }

  function readDeps(): ClientYouReadDeps {
    return {
      date: localISO(),
      peek: (key) => peekCached<ClientStonesRead>(key),
      load: (path, options) => cachedApi(path as `/today/stones?date=${string}`, options),
      reducedMotion: () => reducedMotion(),
      hrefFor: youHrefFor,
    };
  }

  function openStone(key: string): void {
    state.youSeg = "stone";
    state.youStone = key;
    activateTab("you");
  }

  function backToLanding(): void {
    state.youSeg = null;
    state.youStone = null;
    activateTab("you");
  }

  // A stone's home is a view the router already knows: route it exactly as a deep
  // link would (so plan/food lands on Fuel, stand/domain on the domain drill-in),
  // then open it. Leaving the detail forgets it, so the You tab reopens the landing.
  function openStoneHome(target: ClientYouTarget): void {
    state.youSeg = null;
    state.youStone = null;
    const tab = applyRouteState({
      tab: target.tab,
      section: target.section as RouteSection,
      healthSection: null,
      date: null,
      id: target.id || null,
      session: null,
      jump: null,
    });
    activateTab(tab);
  }

  let teardown: (() => void) | null = null;

  function renderStoneDetail(stone: string): void {
    // One page header, as on every You sub-page: the stone's name is the title and
    // "‹ You" steps back under it (the home's "You" over a "‹ You" read twice). The
    // title is the detail model's name, so the header and the hero never disagree.
    view.innerHTML = `<div class="you-stone" id="stoneDetailSlot"></div>`;
    const host = view.querySelector("#stoneDetailSlot");
    if (!host) return;
    teardown = CairnStoneDetailController.mount(host, {
      ...readDeps(),
      stone,
      navigate: openStoneHome,
      back: backToLanding,
      setTitle: (name) => {
        headerTitle.textContent = name;
      },
    });
  }

  function renderLanding(): void {
    view.innerHTML = `<div class="you-landing">
      <div class="you-lede reveal"><p class="voice voice-sm you-voice">Six parts of you, read together.</p>
        <button class="you-search" type="button" data-you-view="stand" data-you-section="markers"><span class="you-search-glyph" aria-hidden="true"></span>Search markers, records, notes…</button></div>
      <div class="you-cairn" id="cairnStackSlot"></div>
      ${youLandingHtml()}
    </div>`;
    view
      .querySelectorAll<HTMLElement>("[data-you-view]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          openYouRow(button.dataset.youView || "", button.dataset.youSection || "")
        )
      );
    const slot = view.querySelector("#cairnStackSlot");
    if (slot) teardown = CairnStackController.mount(slot, { ...readDeps(), openStone });
  }

  function renderYou(): void {
    headerTitle.textContent = "You";
    teardown?.();
    teardown = null;
    const stone = state.youSeg === "stone" ? state.youStone : null;
    if (stone && CairnStoneDetailModel.isStone(stone)) {
      renderStoneDetail(stone);
      return;
    }
    // An unknown stone (a stale or hand-typed ?id=) is the landing, and the URL
    // says so without a new history entry.
    if (state.youSeg || state.youStone) {
      state.youSeg = null;
      state.youStone = null;
      if (typeof syncRouteFromState === "function") syncRouteFromState("replace");
    }
    renderLanding();
  }

  // Any tab-bar tap forgets the open stone, so the You tab (or a later '‹ You') opens
  // the landing. The capture listener runs before the shell's own tab handler.
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target as Element | null;
        if (target && typeof target.closest === "function" && target.closest(".tab[data-tab]")) {
          state.youSeg = null;
          state.youStone = null;
        }
      },
      true
    );
  }

  Object.assign(globalThis, { renderYou, CairnYouLanding: { html: youLandingHtml, groups: YOU_LANDING_GROUPS } });
}
