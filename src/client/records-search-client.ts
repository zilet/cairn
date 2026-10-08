// @ts-check
// records-search, the view (docs/V2-PLAN.md wave 3). Pure renderers: the controls
// (one search field + the grouping segmented control), the grouped marker results
// (each row the marker-row component), and the "documents, notes and body readings"
// hits from the server search. Every caller string goes through escHtml/escAttr or a
// CairnUi primitive; actions are `data-records-*` attributes for a delegating host.
{
  type Model = ClientRecordsModel;
  type Section = ClientRecordsSection;
  type Other = ClientRecordsOtherItem;

  const SEARCH_ICON = `<svg class="hmk-search-i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

  /** The frame: controls once (so the field keeps focus), then the result regions. */
  function shellHtml(opts: { mode: ClientRecordsMode; searchable: boolean; placeholder?: string }): string {
    const search = opts.searchable
      ? `<div class="hmk-search records-search">${SEARCH_ICON}<input type="search" class="hmk-search-in" data-records-q placeholder="${escAttr(opts.placeholder || "Search…")}" aria-label="${escAttr(opts.placeholder || "Search records")}" autocomplete="off" spellcheck="false" enterkeyhint="search"></div>`
      : "";
    const seg = CairnUi.segmentedHtml({
      items: CairnRecordsSearchModel.MODES,
      active: opts.mode,
      label: "Group records",
      attr: "records-group",
      className: "records-seg",
      wrapClass: "records-segwrap",
    });
    return `<div class="records">
      <div class="records-controls reveal">${search}${seg}</div>
      <p class="records-status" role="status" aria-live="polite" data-records-status></p>
      <div class="records-results" data-records-results>${skeletonHtml()}</div>
      <div class="records-other" data-records-other></div>
    </div>`;
  }

  function skeletonHtml(): string {
    return `<div class="hmk-card records-skel" aria-hidden="true"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div>`;
  }

  function sectionLabel(s: Section): string {
    if (s.kind !== "date") return s.label;
    return s.label ? absDate(s.label) : "Undated";
  }

  // A panel says how many of its rows sit outside the lab's range; the two lead sections
  // say how many they hold. A count, never a grade.
  function badgeHtml(s: Section): string {
    if (s.kind === "flagged" || s.kind === "optimal") return `<span class="hmk-headcount">${s.markers.length}</span>`;
    return s.flagged ? `<span class="hmk-headcount">${s.flagged} outside lab range</span>` : "";
  }

  function rowsHtml(s: Section, rowIndex: { value: number }): string {
    let lastSub = "";
    return s.markers
      .map((m) => {
        const sub =
          s.kind === "panel" && s.group ? CairnHealthClient.markerSubgroup(s.group, m.name || m.key || "") : null;
        const head = sub && sub !== lastSub ? `<div class="hmk-subhead">${escHtml(sub)}</div>` : "";
        if (sub) lastSub = sub;
        return head + CairnMarkerRow.rowHtml(m, rowIndex.value++);
      })
      .join("");
  }

  function sectionHtml(s: Section, index: number, rowIndex: { value: number }): string {
    const head = `<div class="hmk-grouphead lbl reveal" data-occludes="top" role="heading" aria-level="3" style="--i:${Math.min(index, 12)}">${escHtml(sectionLabel(s))}${badgeHtml(s)}</div>`;
    const note =
      s.kind === "panel" && s.group === "lipids" ? CairnHealthClient.lipidGroupNoteHtml(s.markers, { relAge }) : "";
    return `<section class="hmk-section records-section" data-records-section="${escAttr(s.key)}" data-kind="${escAttr(s.kind)}">${head}${note}<div class="hmk-card">${rowsHtml(s, rowIndex)}</div></section>`;
  }

  /** The grouped results, or the calm empty state that says what would fill them. */
  function resultsHtml(model: Model, opts: { q?: string; canAdd?: boolean } = {}): string {
    const q = String(opts.q || "").trim();
    if (!model.total) {
      return CairnUi.emptyStateHtml({
        className: "records-empty empty-state reveal",
        title: "No lab readings here yet.",
        body: "Add a lab report or scan and its markers land here, grouped by panel.",
        action: opts.canAdd
          ? { label: "Add labs or scan", className: "linkbtn", attrs: { "data-records-add": true } }
          : null,
      });
    }
    if (!model.shown) {
      return CairnUi.emptyStateHtml({
        className: "records-empty empty-state reveal",
        title: `No markers match “${q}”.`,
        action: { label: "Clear search", className: "linkbtn", attrs: { "data-records-clear": true } },
      });
    }
    const rowIndex = { value: 0 };
    return `<div class="hmk-groups records-groups">${model.sections.map((s, i) => sectionHtml(s, i, rowIndex)).join("")}</div>`;
  }

  const KIND_WORD: Record<Other["kind"], string> = { document: "Document", note: "Visit note", body: "Body reading" };

  function hitHtml(item: Other, index: number): string {
    const meta = [item.date ? absDate(item.date) : "", item.detail].filter(Boolean).join(" · ");
    return `<li class="records-hit-li reveal" style="--i:${Math.min(index, 12)}"><button type="button" class="records-hit" data-records-open="${escAttr(item.kind)}" data-id="${escAttr(item.id)}">
      <span class="records-hit-kind">${escHtml(KIND_WORD[item.kind])}</span>
      <span class="records-hit-title">${escHtml(item.title)}</span>
      ${meta ? `<span class="records-hit-meta">${escHtml(meta)}</span>` : ""}
    </button></li>`;
  }

  /** Documents, visit notes and body readings the server search found. */
  function otherHtml(state: ClientRecordsOtherState): string {
    if (state.status === "loading") {
      return CairnUi.loadingStateHtml({
        label: "Searching documents, notes and body readings…",
        className: "loadstate records-other-load",
      });
    }
    if (state.status === "error") {
      return `<p class="records-other-note" role="status" aria-live="polite">Documents and notes couldn't be searched just now. Markers above are still current.</p>`;
    }
    if (state.status !== "done" || !state.items.length) return "";
    return `<section class="hmk-section records-other-sec" aria-label="Documents, notes and body readings">
      <div class="hmk-grouphead lbl" data-occludes="top" role="heading" aria-level="3">Documents, notes and body readings</div>
      <ul class="records-hits">${state.items.map(hitHtml).join("")}</ul>
    </section>`;
  }

  function errorHtml(): string {
    return CairnUi.emptyStateHtml({
      className: "records-empty empty-state reveal",
      title: "Your markers couldn't be read just now.",
      action: { label: "Try again", className: "linkbtn", attrs: { "data-records-retry": true } },
    });
  }

  function statusText(model: Model, q: string): string {
    return q.trim() && model.total ? `${model.shown} of ${model.total} markers` : "";
  }

  const CAIRN_RECORDS_SEARCH = { shellHtml, skeletonHtml, resultsHtml, sectionHtml, otherHtml, errorHtml, statusText };

  Object.assign(globalThis, { CairnRecordsSearch: CAIRN_RECORDS_SEARCH });
}
