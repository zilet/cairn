// @ts-check
// Pure Health evidence and directive rendering helpers for the vanilla PWA.

type HealthEvidenceRow = {
  source_title?: unknown;
  source_url?: unknown;
  claim?: unknown;
  body?: unknown;
  confidence?: unknown;
  effective_confidence?: unknown;
  source_scope?: unknown;
  source_version?: unknown;
  reviewed_at?: unknown;
  expires_at?: unknown;
  freshness?: unknown;
  provenance?: unknown;
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
  trigger_date?: unknown;
  resurfaced_from_id?: unknown;
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
        const claim =
          row.claim && row.claim !== title ? `<div class="hb-ev-claim">${escHtml(String(row.claim))}</div>` : "";
        const bodyText = truncateEvidenceBody(row.body);
        const body = bodyText ? `<div class="hb-ev-body">${escHtml(bodyText)}</div>` : "";
        const provenance =
          row.provenance && typeof row.provenance === "object" ? (row.provenance as Record<string, unknown>) : {};
        const effective = row.effective_confidence || row.confidence;
        const confidence = effective ? `<span class="hb-ev-conf">${escHtml(String(effective))} confidence</span>` : "";
        const scope = row.source_scope || provenance.source_scope;
        const version = row.source_version || provenance.source_version;
        const reviewed = row.reviewed_at || provenance.reviewed_at;
        const expires = row.expires_at || provenance.expires_at;
        const freshness = row.freshness || provenance.freshness;
        const verification = provenance.verification_status;
        const details = [
          scope ? `${String(scope).replace(/_/g, " ")} source` : "",
          version ? `version ${String(version)}` : "",
          reviewed ? `reviewed ${String(reviewed)}` : "",
          expires ? `review by ${String(expires)}` : "",
          freshness ? String(freshness).replace(/_/g, " ") : "",
          verification ? String(verification).replace(/_/g, " ") : "",
        ].filter(Boolean);
        const governance = details.length
          ? `<span class="hb-ev-governance">${details.map((part) => escHtml(part)).join(" · ")}</span>`
          : "";
        return `<div class="hb-ev-row">${titleHtml}${claim}${body}${confidence || governance ? `<div class="hb-ev-meta">${confidence}${governance}</div>` : ""}</div>`;
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
    const triggerDate = typeof d.trigger_date === "string" ? d.trigger_date.trim() : "";
    // relAge/absDate live in a sibling <script>; guard the cross-module reference (function
    // hoisting doesn't cross script boundaries) and fall back to no date line if absent.
    const when =
      triggerDate && typeof relAge === "function" && typeof absDate === "function"
        ? `<p class="hb-dwhen" title="${escAttr(absDate(triggerDate))}">measured ${escHtml(relAge(triggerDate))}</p>`
        : "";
    // Status-neutral: resurfaced_from_id follows a Done'd OR a Dismissed directive that
    // materially worsened — so this must not assume the athlete "marked this done".
    const resurfaced = d.resurfaced_from_id
      ? `<p class="hb-dresurfaced">You've handled this before — newer results bring it back.</p>`
      : "";
    const evCount = d.marker && evMap ? evMap.get(String(d.marker).toLowerCase()) || 0 : 0;
    const evidence =
      d.marker && (d.citation || evCount > 0)
        ? `<button class="linkbtn-quiet hb-devidence" type="button" data-evidence="${escAttr(String(d.marker))}" aria-expanded="false">see the evidence${evCount > 0 ? ` <span class="hb-evcount">(${evCount})</span>` : ""}</button>
       <div class="hb-evbox" hidden></div>`
        : "";
    return `<div class="hb-directive reveal${soft ? " hb-directive-soft" : ""}" style="${stagger(i + 1)}" data-dir="${escAttr(d.id)}">
    <div class="hb-dmain">
      ${marker}
      ${resurfaced}
      <p class="hb-dtext">${lead}${escHtml(d.directive || "")}</p>
      ${d.rationale ? `<p class="hb-drat">${escHtml(d.rationale)}</p>` : ""}
      ${when}
      ${cite}
      ${evidence}
    </div>
    <div class="hb-dctl">
      <button class="hb-dbtn hb-ddone" data-ddone="${escAttr(d.id)}" title="Got it — this comes back only if new results change the picture">Done</button>
      <button class="hb-dbtn hb-ddismiss" data-ddismiss="${escAttr(d.id)}" title="Not useful — stay quiet unless it gets materially worse">Dismiss</button>
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
