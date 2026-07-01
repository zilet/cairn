// @ts-check
// Health Markers orchestration: SWR loading, grouped catalog wiring, and chart handoff.
{
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
};
type HealthMarkersControllerResponse = {
  markers?: HealthMarkersControllerRow[];
  groups?: Array<Partial<HealthMarkersControllerGroup>>;
};

(() => {
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
    const head = `<div class="hmk-grouphead lbl reveal" style="${deps.stagger(groupIndex)}">${deps.escapeHtml(group.label || group.key)}</div>`;
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
  }

  function paintEmpty(wrap: HTMLElement, deps: ClientHealthMarkersControllerDeps): void {
    wrap.innerHTML = CairnHealthClient.markersEmptyHtml(CairnHealthClient.HEALTH_HERO_ART);
    select(deps, "#hMkToRecords")?.addEventListener("click", () => deps.switchHealthSeg("records", { openPicker: true }));
  }

  function paintMarkers(wrap: HTMLElement, response: unknown, deps: ClientHealthMarkersControllerDeps, token: number): void {
    if (token !== deps.pollToken() || !wrap.isConnected) return;
    const data = controllerRecord(response) as HealthMarkersControllerResponse;
    const markers = controllerRows<HealthMarkersControllerRow>(data.markers);
    if (!markers.length) {
      paintEmpty(wrap, deps);
      return;
    }

    const groups = markerGroups(data, markers);
    const byGroup = groupMarkers(groups, markers);
    const rowIndex = { value: 0 };
    const sections = groups.map((group, index) =>
      markerSectionHtml(group, index, byGroup.get(group.key) || [], rowIndex, deps)
    ).join("");

    wrap.innerHTML = `<div class="hmk-groups">${sections}</div>`;
    wireMarkerCatalog(wrap);
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
}
