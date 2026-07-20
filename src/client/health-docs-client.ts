// @ts-check
// Health document card rendering shared by Health and Records surfaces.

type HealthDocMarker = {
  name?: unknown;
  value?: unknown;
  unit?: unknown;
  flag?: unknown;
};

type HealthDocParsed = {
  markers?: HealthDocMarker[];
  clinical_facts?: unknown[];
  type?: unknown;
};

type HealthDocRow = {
  id?: unknown;
  kind?: unknown;
  parsed_json?: unknown;
  enrichment_status?: unknown;
  source_doc_id?: unknown;
  summary?: unknown;
  has_file?: unknown;
  doc_date?: unknown;
  original_name?: unknown;
};

const HEALTH_DOC_KINDS: Array<readonly [string, string]> = [
  ["bloodwork", "Bloodwork"],
  ["dexa", "DEXA"],
  ["ecg", "ECG"],
  ["vitals", "Vitals"],
  ["metabolic_test", "Metabolic Test"],
  ["visit_note", "Visit Note"],
  ["after_visit_summary", "After Visit Summary"],
  ["clinical_summary", "Clinical Summary"],
  ["imaging", "Imaging"],
  ["vision", "Vision"],
  ["procedure_note", "Procedure Note"],
  ["medication_list", "Medication List"],
  ["immunization_record", "Immunization Record"],
  ["other", "Other"],
];

function healthKindLabel(kind: unknown): string {
  const match = HEALTH_DOC_KINDS.find((entry) => entry[0] === kind);
  return match ? match[1] : String(kind || "Doc");
}

function parsedDoc(doc: HealthDocRow | null | undefined): HealthDocParsed | null {
  let parsed = doc?.parsed_json;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  return parsed && typeof parsed === "object" ? (parsed as HealthDocParsed) : null;
}

function markerFlagClass(flag: unknown): string {
  const value = String(flag || "").toLowerCase();
  if (value === "low" || value === "high" || value === "abnormal" || value === "critical") return "hm-flag warn";
  if (value) return "hm-flag ok";
  return "";
}

function markersTable(parsed: HealthDocParsed | null | undefined): string {
  const markers = parsed && Array.isArray(parsed.markers) ? parsed.markers : [];
  if (!markers.length) return "";
  const rows = markers
    .map((marker) => {
      const flag = marker.flag ? `<span class="${markerFlagClass(marker.flag)}">${escHtml(marker.flag)}</span>` : "";
      const value = [marker.value, marker.unit].filter((item) => item != null && item !== "").join(" ");
      return `<tr>
      <td class="hm-name">${escHtml(marker.name || "")}</td>
      <td class="hm-val">${escHtml(value)}</td>
      <td class="hm-fl">${flag}</td>
    </tr>`;
    })
    .join("");
  return `<table class="hmarkers"><tbody>${rows}</tbody></table>`;
}

function docCollapsible(doc: HealthDocRow | null | undefined): boolean {
  const parsed = parsedDoc(doc);
  const markers = parsed && Array.isArray(parsed.markers) ? parsed.markers : [];
  return doc?.enrichment_status === "done" && (markers.length > 0 || !!doc.summary);
}

function healthDocInner(doc: HealthDocRow): string {
  const parsed = parsedDoc(doc);
  const status = doc.enrichment_status;
  const derived = !!doc.source_doc_id;
  const docIdAttr = escAttr(doc.id || "");
  let analysisBadge = "";
  if (enrichmentActive(status)) analysisBadge = `<span class="enr enr-pending">analyzing...</span>`;
  else if (status === "failed") analysisBadge = `<span class="enr" style="color:var(--warn)">analysis failed</span>`;
  else if (status === "skipped") analysisBadge = `<span class="enr enr-done">not analyzed</span>`;
  else if (status === "done") analysisBadge = `<span class="enr enr-done" title="analyzed">✦ analyzed</span>`;

  let detail = "";
  if (status === "done") {
    if (doc.summary) detail += `<div class="sess-line" style="margin-top:7px">${escHtml(doc.summary)}</div>`;
    detail += markersTable(parsed);
    if (parsed && parsed.type && !doc.summary) detail += `<div class="sess-line" style="color:var(--muted)">${escHtml(parsed.type)}</div>`;
  } else if (enrichmentActive(status)) {
    detail = `<div class="sess-line" style="color:var(--muted)">Reading the document and splitting it by date...</div>`;
  } else if (status === "failed") {
    detail = `<div class="sess-line" style="color:var(--muted)">Couldn't extract markers automatically. The original file is still saved — try Re-analyze.</div>`;
  }

  const fileId = doc.has_file ? doc.id : doc.source_doc_id || null;
  const busy = enrichmentActive(status);
  const collapsible = docCollapsible(doc);
  const markers = parsed && Array.isArray(parsed.markers) ? parsed.markers : [];
  const facts = parsed && Array.isArray(parsed.clinical_facts) ? parsed.clinical_facts : [];
  const flagged = markers.filter((marker) => {
    const flag = String(marker.flag || "").toLowerCase();
    return flag && flag !== "normal" && flag !== "optimal" && flag !== "in range" && flag !== "in-range";
  }).length;
  const teaser = markers.length
    ? `${markers.length} marker${markers.length === 1 ? "" : "s"}${flagged ? ` · ${flagged} flagged` : " · all in range"}`
    : facts.length
      ? `${facts.length} fact${facts.length === 1 ? "" : "s"}`
    : "Analyzed";

  const head = `<div class="sess-head${collapsible ? " hdoc-head" : ""}"${collapsible ? ` data-hdoc-toggle role="button" tabindex="0" aria-label="Toggle record detail"` : ""}>
      <span class="sess-date">${escHtml(healthKindLabel(doc.kind))}${doc.doc_date ? ` · ${escHtml(doc.doc_date)}` : ""}${derived ? `<span class="hdoc-tag">from import</span>` : ""}</span>
      <span class="hdoc-headright">
        <span class="hdoc-badge">${analysisBadge}</span>
        ${collapsible ? `<span class="hdoc-chev" aria-hidden="true">▾</span>` : ""}
      </span>
    </div>`;

  const teaserHtml = collapsible
    ? `<button class="hdoc-teaser" type="button" data-hdoc-toggle><span class="hdoc-teaser-txt">${escHtml(teaser)}</span><span class="hdoc-teaser-more">view</span></button>`
    : "";

  return `${head}
    ${teaserHtml}
    <div class="hdoc-detail">
      ${doc.original_name && !derived ? `<div class="sess-line" style="color:var(--muted);font-size:.78rem">${escHtml(doc.original_name)}</div>` : ""}
      ${detail}
    </div>
    <div class="hdoc-foot">
      <div class="hdoc-date-wrap">
        <button class="hdoc-datebtn" data-hdate-edit="${docIdAttr}" title="Change the result date">
          <span class="hdoc-date-ico" aria-hidden="true">✎</span>
          <span class="hdoc-date-val">${doc.doc_date ? escHtml(doc.doc_date) : "Set date"}</span>
        </button>
        <span class="hdoc-date-edit" data-hdate-editor="${docIdAttr}" hidden>
          <input id="hdate-${docIdAttr}" name="health_doc_date_${docIdAttr}" class="hdoc-date" data-hdate="${docIdAttr}" type="date" value="${escAttr(doc.doc_date || "")}" max="${localISO()}" aria-label="Result date">
          <button class="hdoc-date-save" data-hdate-save="${docIdAttr}">Save</button>
          <button class="hdoc-date-cancel" data-hdate-cancel="${docIdAttr}">Cancel</button>
        </span>
        <span class="hdoc-date-flash" data-hdate-flash="${docIdAttr}" hidden>✓ updated</span>
      </div>
      <div class="hdoc-actions">
        ${doc.has_file ? `<button class="hdoc-link hdoc-rescan" data-hrescan="${docIdAttr}"${busy ? " disabled" : ""} title="Re-run the scan over the original file">↻ re-analyze</button>` : ""}
        ${fileId ? `<a class="hdoc-link" href="${withToken(`/api/health-docs/${fileId}/file`)}" target="_blank" rel="noopener">view file</a>` : ""}
        <button class="iconbtn hdoc-del" data-hdel="${docIdAttr}" title="delete">×</button>
      </div>
    </div>`;
}

function healthDocHtml(doc: HealthDocRow, index?: number): string {
  if (doc.kind === "imaging" && CairnImaging.imagingStudy(doc as import("../contracts/client-api.js").ClientHealthDocument)) {
    return CairnImaging.imagingCard(doc as import("../contracts/client-api.js").ClientHealthDocument, index);
  }
  const reveal = typeof index === "number";
  const collapsed = docCollapsible(doc) && reveal && Number(index) > 0;
  return `<div class="sess hdoc${reveal ? " reveal" : ""}${collapsed ? " hdoc-collapsed" : ""}" data-hdoc="${escAttr(doc.id || "")}"${reveal ? ` style="${stagger(index)}"` : ""}>${healthDocInner(doc)}</div>`;
}

const CAIRN_HEALTH_DOCS = {
  healthKindLabel,
  parsedDoc,
  markerFlagClass,
  markersTable,
  docCollapsible,
  healthDocInner,
  healthDocHtml,
};

Object.assign(globalThis, {
  CairnHealthDocs: CAIRN_HEALTH_DOCS,
  healthKindLabel,
  parsedDoc,
  markerFlagClass,
  markersTable,
  docCollapsible,
  healthDocInner,
  healthDocHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnHealthDocs: CAIRN_HEALTH_DOCS,
    healthKindLabel,
    parsedDoc,
    markerFlagClass,
    markersTable,
    docCollapsible,
    healthDocInner,
    healthDocHtml,
  });
}
