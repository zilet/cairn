// @ts-check
// Health Markers orchestration: SWR loading, grouped catalog wiring, and chart handoff.
type HealthMarkersControllerRecord = Record<string, unknown>;
type HealthMarkersControllerGroup = {
  key: string;
  label: string;
};
type HealthMarkersControllerRow = HealthMarkersControllerRecord & {
  name?: string;
  key?: string;
  group?: string;
  group_label?: string;
  latest?: { flag?: unknown; date?: unknown } | null;
  in_optimal?: unknown;
};
type HealthMarkersControllerResponse = {
  markers?: HealthMarkersControllerRow[];
  groups?: Array<Partial<HealthMarkersControllerGroup>>;
};

(() => {
  // Session-scoped catalog state: the out-of-range quick filter (narrow to markers
  // lab-flagged or outside their optimal band — the shared CairnHealthMarkers.
  // markerOutOfRange definition) and the free-text search over ~180 marker names.
  let showOutOfRange = false;
  let searchQuery = "";

  function normalizeQuery(value: unknown): string {
    return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function matchesSearch(marker: HealthMarkersControllerRow): boolean {
    const q = normalizeQuery(searchQuery);
    if (!q) return true;
    const name = normalizeQuery(marker.name || marker.key || "");
    const label = normalizeQuery(marker.group_label || "");
    return name.includes(q) || label.includes(q);
  }

  // Controls row (search + out-of-range pill) — rendered ONCE per data paint and
  // left untouched while results re-render, so the search field keeps focus as
  // you type. The input's value is set as a DOM property (not an attribute) to
  // sidestep escaping. `outCount` is over ALL markers, so the pill is stable.
  function controlsHtml(outCount: number): string {
    const toggle = outCount
      ? `<button id="hMkOutToggle" class="hmk-filter-toggle${showOutOfRange ? " on" : ""}" aria-pressed="${showOutOfRange ? "true" : "false"}">
          <span class="hdot hdot-warn"></span>Out of range · ${outCount}
        </button>`
      : "";
    return `<div class="hmk-controls reveal">
      <div class="hmk-search">
        <svg class="hmk-search-i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        <input id="hMkSearch" type="search" class="hmk-search-in" placeholder="Search markers…" aria-label="Search markers" autocomplete="off" spellcheck="false" enterkeyhint="search">
      </div>
      ${toggle}
    </div>`;
  }

  function controllerRecord(value: unknown): HealthMarkersControllerRecord {
    return value && typeof value === "object" ? (value as HealthMarkersControllerRecord) : {};
  }

  function controllerRows<T extends HealthMarkersControllerRecord = HealthMarkersControllerRecord>(value: unknown): T[] {
    return Array.isArray(value) ? (value.filter((row) => !!row && typeof row === "object") as T[]) : [];
  }

  function select<T extends Element = Element>(deps: ClientHealthMarkersControllerDeps, selector: string): T | null {
    return deps.root.querySelector<T>(selector) || deps.select<T>(selector);
  }

  function markerGroups(data: HealthMarkersControllerResponse, markers: HealthMarkersControllerRow[]): HealthMarkersControllerGroup[] {
    const groups = controllerRows<HealthMarkersControllerRecord>(data.groups)
      .map((group) => {
        const key = typeof group.key === "string" ? group.key : "";
        const label = typeof group.label === "string" && group.label ? group.label : key;
        return key ? { key, label } : null;
      })
      .filter((group): group is HealthMarkersControllerGroup => !!group);
    if (groups.length) return groups;

    const seen = new Set<string>();
    const derived: HealthMarkersControllerGroup[] = [];
    for (const marker of markers) {
      const key = typeof marker.group === "string" && marker.group ? marker.group : "other";
      if (seen.has(key)) continue;
      seen.add(key);
      derived.push({
        key,
        label: marker.group_label || (marker.group ? marker.group : "Markers"),
      });
    }
    return derived;
  }

  function groupMarkers(groups: HealthMarkersControllerGroup[], markers: HealthMarkersControllerRow[]): Map<string, HealthMarkersControllerRow[]> {
    const byGroup = new Map<string, HealthMarkersControllerRow[]>();
    groups.forEach((group) => byGroup.set(group.key, []));
    for (const marker of markers) {
      const markerGroup = typeof marker.group === "string" ? marker.group : "";
      const key = byGroup.has(markerGroup) ? markerGroup : groups[0]?.key;
      if (key && byGroup.has(key)) byGroup.get(key)?.push(marker);
    }
    return byGroup;
  }

  function markerSectionHtml(
    group: HealthMarkersControllerGroup,
    groupIndex: number,
    list: HealthMarkersControllerRow[],
    rowIndex: { value: number },
    deps: ClientHealthMarkersControllerDeps,
  ): string {
    const ordered = CairnHealthClient.orderMarkersForDisplay(group.key, list);
    if (!ordered.length) return "";

    let lastSubgroup = "";
    const rows = ordered.map((marker) => {
      const subgroup = CairnHealthClient.markerSubgroup(group.key, marker.name || marker.key || "");
      const subhead = subgroup && subgroup !== lastSubgroup
        ? `<div class="hmk-subhead">${deps.escapeHtml(subgroup)}</div>`
        : "";
      if (subgroup) lastSubgroup = subgroup;
      return subhead + CairnHealthMarkers.hmkRowHtml(marker, rowIndex.value++);
    }).join("");
    // A quiet count of this panel's out-of-range markers (among what's shown), so
    // you can spot which stories need attention while scrolling the full catalog.
    const off = ordered.filter((marker) => CairnHealthMarkers.markerOutOfRange(marker)).length;
    const badge = off ? `<span class="hmk-headcount">${off} off</span>` : "";
    const head = `<div class="hmk-grouphead lbl reveal" style="${deps.stagger(groupIndex)}">${deps.escapeHtml(group.label || group.key)}${badge}</div>`;
    const note = group.key === "lipids"
      ? CairnHealthClient.lipidGroupNoteHtml(ordered, { relAge: deps.relAge })
      : "";
    return `<section class="hmk-section">${head}${note}<div class="hmk-card">${rows}</div></section>`;
  }

  function wireMarkerCatalog(wrap: HTMLElement): void {
    wrap.querySelectorAll<HTMLElement>(".hmk-x .hmk-row").forEach((button) =>
      button.addEventListener("click", () => {
        const item = button.closest<HTMLElement>(".hmk");
        if (!item) return;
        const open = item.classList.toggle("open");
        button.setAttribute("aria-expanded", open ? "true" : "false");
      }));
    wrap.querySelectorAll<SVGElement>("svg.hchart").forEach((svg) => CairnHealthMarkers.wireMarkerChart(svg));
    wrap.querySelectorAll<HTMLElement>(".hmk-ask").forEach((button) =>
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        CairnHealthClient.askCoach(button.getAttribute("data-ask"));
      }));
  }

  function paintEmpty(wrap: HTMLElement, deps: ClientHealthMarkersControllerDeps): void {
    wrap.innerHTML = CairnHealthClient.markersEmptyHtml(CairnHealthClient.HEALTH_HERO_ART);
    select(deps, "#hMkToRecords")?.addEventListener("click", () => deps.switchHealthSeg("records", { openPicker: true }));
  }

  // Fill the results region (status + grouped sections) from the current filter
  // state. Only #hMkResults is touched, so the search field's focus survives.
  function renderResults(
    wrap: HTMLElement,
    markers: HealthMarkersControllerRow[],
    groups: HealthMarkersControllerGroup[],
    deps: ClientHealthMarkersControllerDeps,
  ): void {
    const results = wrap.querySelector<HTMLElement>("#hMkResults");
    if (!results) return;
    const outOfRange = markers.filter((marker) => CairnHealthMarkers.markerOutOfRange(marker));
    if (!outOfRange.length) showOutOfRange = false;
    const base = showOutOfRange ? outOfRange : markers;
    const visible = base.filter(matchesSearch);
    const q = normalizeQuery(searchQuery);

    if (!visible.length) {
      const why = q ? `No markers match “${deps.escapeHtml(searchQuery.trim())}”.` : "No markers out of range.";
      results.innerHTML = `<div class="hmk-empty">${why}${q ? ` <button id="hMkClear" class="linkbtn">Clear search</button>` : ""}</div>`;
      select(deps, "#hMkClear")?.addEventListener("click", () => {
        searchQuery = "";
        const input = wrap.querySelector<HTMLInputElement>("#hMkSearch");
        if (input) input.value = "";
        renderResults(wrap, markers, groups, deps);
        wrap.querySelector<HTMLInputElement>("#hMkSearch")?.focus();
      });
      return;
    }

    const byGroup = groupMarkers(groups, visible);
    const rowIndex = { value: 0 };
    const sections = groups.map((group, index) =>
      markerSectionHtml(group, index, byGroup.get(group.key) || [], rowIndex, deps)
    ).join("");
    const status = q
      ? `<div class="hmk-status">${visible.length} of ${markers.length} markers</div>`
      : "";
    results.innerHTML = `${status}<div class="hmk-groups">${sections}</div>`;
    wireMarkerCatalog(results);
  }

  function paintMarkers(wrap: HTMLElement, response: unknown, deps: ClientHealthMarkersControllerDeps, token: number): void {
    if (token !== deps.pollToken() || !wrap.isConnected) return;
    const data = controllerRecord(response) as HealthMarkersControllerResponse;
    const markers = controllerRows<HealthMarkersControllerRow>(data.markers);
    if (!markers.length) {
      paintEmpty(wrap, deps);
      return;
    }

    const outCount = markers.filter((marker) => CairnHealthMarkers.markerOutOfRange(marker)).length;
    const groups = markerGroups(data, markers);
    wrap.innerHTML = `${controlsHtml(outCount)}<div id="hMkResults"></div>`;

    const search = wrap.querySelector<HTMLInputElement>("#hMkSearch");
    if (search) {
      search.value = searchQuery;
      search.addEventListener("input", () => {
        searchQuery = search.value;
        renderResults(wrap, markers, groups, deps);
      });
    }
    wrap.querySelector<HTMLElement>("#hMkOutToggle")?.addEventListener("click", () => {
      showOutOfRange = !showOutOfRange;
      const button = wrap.querySelector<HTMLElement>("#hMkOutToggle");
      if (button) {
        button.classList.toggle("on", showOutOfRange);
        button.setAttribute("aria-pressed", showOutOfRange ? "true" : "false");
      }
      renderResults(wrap, markers, groups, deps);
    });

    renderResults(wrap, markers, groups, deps);
  }

  function load(deps: ClientHealthMarkersControllerDeps, token: number): void {
    const wrap = select<HTMLElement>(deps, "#hMarkers");
    if (!wrap || !wrap.isConnected) return;
    const paint = (response: unknown) => paintMarkers(wrap, response, deps, token);
    const peek = deps.peekCached("markers:priority");
    if (peek) {
      paint(peek.data);
      if (!peek.fresh) deps.markRefreshing(true);
    }
    void deps.cachedApi("/markers/priority", {
      key: "markers:priority",
      onUpgrade: (data, { changed }) => {
        if (peek && !peek.fresh) deps.markRefreshing(false);
        if (changed || !peek) paint(data);
      },
    }).catch(() => {
      if (peek && !peek.fresh) deps.markRefreshing(false);
      if (!peek) paint(null);
    });
  }

  const CAIRN_HEALTH_MARKERS_CONTROLLER = {
    load,
  };

  Object.assign(globalThis, { CairnHealthMarkersController: CAIRN_HEALTH_MARKERS_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnHealthMarkersController = CAIRN_HEALTH_MARKERS_CONTROLLER;
  }
})();
