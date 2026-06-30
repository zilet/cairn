// @ts-check
// Pure Health connected-brain directive rendering helpers for the vanilla PWA.

type HealthDirectivesRow = {
  id?: unknown;
  marker?: unknown;
  domain?: unknown;
  citation?: unknown;
  status?: unknown;
  uncertain?: unknown;
  directive?: unknown;
  rationale?: unknown;
};

type HealthDirectivesEvidenceSummary = {
  research_enabled?: unknown;
  by_marker?: Array<{ marker?: unknown; count?: unknown }>;
};

(() => {
function activeDirectives(rows: unknown): HealthDirectivesRow[] {
  return (Array.isArray(rows) ? rows : [])
    .filter((row): row is HealthDirectivesRow => !!row && typeof row === "object")
    .filter((row) => !row.status || row.status === "active");
}

function evidenceCountMap(summary: HealthDirectivesEvidenceSummary | null | undefined): Map<string, number> {
  return CairnHealthClient.evidenceCountMap(summary);
}

function directiveResearchNudgeHtml(active: HealthDirectivesRow[], evMap: Map<string, number>, evSummary: HealthDirectivesEvidenceSummary | null | undefined): string {
  const researchOff = !!(evSummary && evSummary.research_enabled === false);
  const unsourced = active.some((directive) => {
    const count = directive.marker ? evMap.get(String(directive.marker).toLowerCase()) ?? 0 : 0;
    return !!directive.marker && !directive.citation && count <= 0;
  });
  return researchOff && unsourced
    ? `<div class="hb-research-nudge">
        <span class="hb-rn-text">Cairn can research these and cite real sources behind each one.</span>
        <button class="hb-rn-link" id="hbResearchNudge" type="button">turn on research in Settings</button>
      </div>`
    : "";
}

function directivesEmptyHtml(): string {
  return `<div class="hb-section hb-dir-section">
      <div class="hb-sechead"><span class="lbl">Across your life</span><button class="hb-derive" id="hbDerive" title="Refresh from your latest labs">refresh from labs</button></div>
      <div class="empty">Nothing to carry across domains right now. When a lab finding has a clear lever, it'll show up here as something to review.</div>
    </div>`;
}

function directivesSectionHtml(rows: unknown, evSummary: HealthDirectivesEvidenceSummary | null | undefined): string {
  const active = activeDirectives(rows);
  const evMap = evidenceCountMap(evSummary);
  if (!active.length) return directivesEmptyHtml();
  let directiveIndex = 0;
  const groups = CairnHealthClient.DIRECTIVE_DOMAINS.map(([key, label, glyph]) => {
    const groupRows = active.filter((directive) => (directive.domain || "watch") === key);
    if (!groupRows.length) return "";
    return `<div class="hb-dgroup">
      <div class="hb-dgrouphead"><span class="hb-dglyph" aria-hidden="true">${glyph}</span><span class="hb-dgname">${label}</span></div>
      <div class="hb-dlist">${groupRows.map((directive) => CairnHealthClient.directiveHtml(directive, directiveIndex++, evMap)).join("")}</div>
    </div>`;
  }).filter(Boolean).join("");
  return `<div class="hb-section hb-dir-section">
    <div class="hb-sechead"><span class="lbl">Across your life</span><button class="hb-derive" id="hbDerive" title="Refresh from your latest labs">refresh from labs</button></div>
    ${groups}
    ${directiveResearchNudgeHtml(active, evMap, evSummary)}
  </div>`;
}

const CAIRN_HEALTH_DIRECTIVES = {
  activeDirectives,
  evidenceCountMap,
  directiveResearchNudgeHtml,
  directivesEmptyHtml,
  directivesSectionHtml,
};

Object.assign(globalThis, { CairnHealthDirectives: CAIRN_HEALTH_DIRECTIVES });

if (typeof window !== "undefined") {
  window.CairnHealthDirectives = CAIRN_HEALTH_DIRECTIVES;
}
})();
