// @ts-check
// Pure Health evidence and directive rendering helpers for the vanilla PWA.

type HealthEvidenceRow = {
  source_title?: unknown;
  source_url?: unknown;
  claim?: unknown;
  body?: unknown;
  confidence?: unknown;
};

type HealthEvidenceCountRow = { marker?: unknown; count?: unknown };
type HealthEvidenceSummary = { by_marker?: HealthEvidenceCountRow[] };

type HealthDirectiveRow = {
  id?: unknown;
  marker?: unknown;
  uncertain?: unknown;
  citation?: unknown;
  directive?: unknown;
  rationale?: unknown;
};

(() => {
const DIRECTIVE_DOMAINS: Array<readonly [string, string, string]> = [
  ["nutrition", "Nutrition", "❧"],
  ["training", "Training", "◇"],
  ["watch", "Watch", "◉"],
];

function evidenceSafeUrl(value: unknown): string | null {
  const url = String(value ?? "").trim();
  return /^https?:\/\//i.test(url) ? url.replace(/"/g, "&quot;") : null;
}

function truncateEvidenceBody(text: unknown): string {
  const body = String(text || "").trim();
  return body.length > 240 ? `${body.slice(0, 237).trimEnd()}…` : body;
}

function evidenceRow(value: unknown): HealthEvidenceRow {
  return value && typeof value === "object" ? (value as HealthEvidenceRow) : {};
}

function evidenceListHtml(evidence: unknown): string {
  const rows = (Array.isArray(evidence) ? evidence : [])
    .map(evidenceRow)
    .filter((row) => row.source_title || row.source_url || row.claim || row.body)
    .slice(0, 6);
  if (!rows.length) {
    return `<div class="hb-ev-empty">No researched source on file yet — the citation above is the basis for now.</div>`;
  }
  return rows
    .map((row) => {
      const url = evidenceSafeUrl(row.source_url);
      const title = String(row.source_title || row.claim || "Source").trim();
      const titleHtml = url
        ? `<a class="hb-ev-link" href="${url}" target="_blank" rel="noopener noreferrer">${escHtml(title)}</a>`
        : `<span class="hb-ev-title">${escHtml(title)}</span>`;
      const claim = row.claim && row.claim !== title ? `<div class="hb-ev-claim">${escHtml(String(row.claim))}</div>` : "";
      const bodyText = truncateEvidenceBody(row.body);
      const body = bodyText ? `<div class="hb-ev-body">${escHtml(bodyText)}</div>` : "";
      const conf = row.confidence ? `<span class="hb-ev-conf">${escHtml(String(row.confidence))} confidence</span>` : "";
      return `<div class="hb-ev-row">${titleHtml}${claim}${body}${conf ? `<div class="hb-ev-meta">${conf}</div>` : ""}</div>`;
    })
    .join("");
}

function evidenceCountMap(summary: HealthEvidenceSummary | null | undefined): Map<string, number> {
  const map = new Map<string, number>();
  const rows = summary && Array.isArray(summary.by_marker) ? summary.by_marker : [];
  for (const row of rows) {
    if (!row || !row.marker) continue;
    map.set(String(row.marker).toLowerCase(), Number(row.count) || 0);
  }
  return map;
}

function directiveHtml(d: HealthDirectiveRow, i = 0, evMap: Map<string, number> | null = null): string {
  const soft = d.uncertain && !d.citation;
  const marker = d.marker ? `<span class="hb-dmarker">${escHtml(d.marker)}</span>` : "";
  const lead = soft ? `<span class="hb-dsoft">Worth looking into · </span>` : "";
  const cite = d.citation ? `<div class="hb-dcite">${escHtml(d.citation)}</div>` : "";
  const evCount = d.marker && evMap ? (evMap.get(String(d.marker).toLowerCase()) || 0) : 0;
  const evidence = d.marker && (d.citation || evCount > 0)
    ? `<button class="hb-devidence" type="button" data-evidence="${escAttr(String(d.marker))}" aria-expanded="false">see the evidence${evCount > 0 ? ` <span class="hb-evcount">(${evCount})</span>` : ""}</button>
       <div class="hb-evbox" hidden></div>`
    : "";
  return `<div class="hb-directive reveal${soft ? " hb-directive-soft" : ""}" style="${stagger(i + 1)}" data-dir="${escAttr(d.id)}">
    <div class="hb-dmain">
      ${marker}
      <p class="hb-dtext">${lead}${escHtml(d.directive || "")}</p>
      ${d.rationale ? `<p class="hb-drat">${escHtml(d.rationale)}</p>` : ""}
      ${cite}
      ${evidence}
    </div>
    <div class="hb-dctl">
      <button class="hb-dbtn hb-ddone" data-ddone="${escAttr(d.id)}" title="Mark handled; the coach will stop carrying this unless new results change">Done</button>
      <button class="hb-dbtn hb-ddismiss" data-ddismiss="${escAttr(d.id)}" title="Dismiss; the coach will avoid repeating this unless the marker materially changes">Dismiss</button>
    </div>
  </div>`;
}

const CAIRN_HEALTH_EVIDENCE = {
  DIRECTIVE_DOMAINS,
  evidenceSafeUrl,
  truncateEvidenceBody,
  evidenceListHtml,
  evidenceCountMap,
  directiveHtml,
};

Object.assign(globalThis, { CairnHealthEvidence: CAIRN_HEALTH_EVIDENCE });

if (typeof window !== "undefined") {
  window.CairnHealthEvidence = CAIRN_HEALTH_EVIDENCE;
}
})();
