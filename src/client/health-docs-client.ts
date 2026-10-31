// @ts-check
// Health document card rendering shared by Health and Records surfaces.

type HealthDocMarker = {
  name?: unknown;
  value?: unknown;
  unit?: unknown;
  flag?: unknown;
};

type HealthDocIngestState = {
  mode?: unknown;
  reason?: unknown;
  detail?: unknown;
  at?: unknown;
};

type HealthDocParsed = {
  markers?: HealthDocMarker[];
  clinical_facts?: unknown[];
  type?: unknown;
  ingest?: HealthDocIngestState;
};

type HealthDocRow = {
  id?: unknown;
  kind?: unknown;
  parsed?: unknown;
  parsed_json?: unknown;
  enrichment_status?: unknown;
  source_doc_id?: unknown;
  summary?: unknown;
  has_file?: unknown;
  doc_date?: unknown;
  original_name?: unknown;
  created_at?: unknown;
  enrich_since?: unknown;
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

// API rows carry `parsed` (publicHealthDoc strips parsed_json); a raw row carries
// parsed_json. Read whichever is there.
function parsedDoc(doc: HealthDocRow | null | undefined): HealthDocParsed | null {
  let parsed = doc?.parsed != null ? doc.parsed : doc?.parsed_json;
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

// This import completed on its deterministic read alone — the labs, vitals and
// facts came straight out of the export, and the written summary never happened.
// Saying "analyzed" over that would be the card claiming a read it didn't get.
function deterministicIngest(parsed: HealthDocParsed | null | undefined): HealthDocIngestState | null {
  const ingest = parsed && parsed.ingest && typeof parsed.ingest === "object" ? parsed.ingest : null;
  return ingest && ingest.mode === "deterministic" ? ingest : null;
}

function docCollapsible(doc: HealthDocRow | null | undefined): boolean {
  const parsed = parsedDoc(doc);
  const markers = parsed && Array.isArray(parsed.markers) ? parsed.markers : [];
  return doc?.enrichment_status === "done" && (markers.length > 0 || !!doc.summary);
}

// A read in progress says how long it has been going once it has been a while —
// calm, in minutes, never a progress number. The clock is the server's own
// `enrich_since` (when this read was asked for), else the upload's created_at;
// a stamp more than half a day old is not this read's, so it says nothing.
const ANALYZING_ELAPSED_AFTER_MS = 60_000;
const ANALYZING_ELAPSED_MAX_MS = 12 * 60 * 60_000;
const ANALYZING_LEAD = "Reading the document and splitting it by date...";

function analyzingSinceMs(doc: { enrich_since?: unknown; created_at?: unknown } | null | undefined): number | null {
  const raw = String(doc?.enrich_since || doc?.created_at || "").trim();
  if (!raw) return null;
  // SQLite's datetime('now') is UTC without a zone mark.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function analyzingText(lead: string, sinceMs: number | null, now: number = Date.now()): string {
  if (sinceMs == null) return lead;
  const elapsed = now - sinceMs;
  if (elapsed < ANALYZING_ELAPSED_AFTER_MS || elapsed > ANALYZING_ELAPSED_MAX_MS) return lead;
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  const hours = Math.round(minutes / 60);
  const span = minutes < 60 ? `${minutes} min` : `about ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Still reading — ${span} so far. The coach is busy; it'll finish on its own.`;
}

function analyzingLineHtml(
  doc: { enrich_since?: unknown; created_at?: unknown } | null | undefined,
  lead: string = ANALYZING_LEAD,
  now: number = Date.now()
): string {
  const since = analyzingSinceMs(doc);
  return `<div class="sess-line hdoc-analyzing"${since != null ? ` data-enr-since="${escAttr(since)}"` : ""} data-enr-lead="${escAttr(lead)}">${escHtml(analyzingText(lead, since, now))}</div>`;
}

// One quiet clock for every visible "still reading" line; it stops itself once
// none is left on the page.
let analyzingClock: ReturnType<typeof setInterval> | null = null;

function tickAnalyzingLines(now: number = Date.now()): number {
  if (typeof document === "undefined") return 0;
  const lines = Array.from(document.querySelectorAll<HTMLElement>("[data-enr-since]"));
  for (const line of lines) {
    const since = Number(line.dataset.enrSince);
    line.textContent = analyzingText(
      line.dataset.enrLead || ANALYZING_LEAD,
      Number.isFinite(since) ? since : null,
      now
    );
  }
  return lines.length;
}

function startAnalyzingClock(): void {
  if (analyzingClock != null || typeof document === "undefined") return;
  analyzingClock = setInterval(() => {
    if (tickAnalyzingLines() === 0 && analyzingClock != null) {
      clearInterval(analyzingClock);
      analyzingClock = null;
    }
  }, 30_000);
}

// The record an identical upload already matched: open it, bring it into view,
// and mark it for a moment. A pasted report folded into its study's card is
// found through that card (data-hsource). Returns whether it was on screen.
function highlightHealthDoc(id: unknown): boolean {
  if (typeof document === "undefined") return false;
  const key = String(id);
  const target = Array.from(document.querySelectorAll<HTMLElement>("#hlist .hdoc")).find(
    (el) => el.dataset.hdoc === key || el.dataset.hsource === key
  );
  if (!target) return false;
  target.classList.remove("hdoc-collapsed");
  target.querySelector("[data-imaging-toggle]")?.setAttribute("aria-expanded", "true");
  target.classList.add("hdoc-flash");
  setTimeout(() => target.classList.remove("hdoc-flash"), 2400);
  try {
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch {
    target.scrollIntoView?.();
  }
  return true;
}

// The upload box's status line once an upload answered. An upload the server
// matched to a record already on file wrote nothing: say so calmly and show that
// record (true — the caller stops there). Otherwise the line clears (false).
function settleUploadStatus(
  doc: { duplicate_of?: unknown; reanalyzing?: unknown },
  status: Element,
  pollDoc: (id: string | number) => void
): boolean {
  if (doc.duplicate_of == null) {
    status.textContent = "";
    return false;
  }
  status.textContent = doc.reanalyzing
    ? "That report is already on file. Its earlier read didn’t finish, so it’s being read again."
    : "That report is already on file.";
  highlightHealthDoc(doc.duplicate_of);
  if (doc.reanalyzing) pollDoc(Number(doc.duplicate_of));
  return true;
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
  const readFromData = status === "done" ? deterministicIngest(parsed) : null;
  if (status === "done") {
    analysisBadge = readFromData
      ? `<span class="enr enr-done" title="read straight from the export">read from data</span>`
      : `<span class="enr enr-done" title="analyzed">✦ analyzed</span>`;
  }

  let detail = "";
  if (status === "done") {
    if (doc.summary) detail += `<div class="sess-line" style="margin-top:7px">${escHtml(doc.summary)}</div>`;
    detail += markersTable(parsed);
    if (parsed && parsed.type && !doc.summary)
      detail += `<div class="sess-line" style="color:var(--muted)">${escHtml(parsed.type)}</div>`;
    if (readFromData) {
      const why = String(readFromData.detail || "").trim();
      detail += `<div class="sess-line" style="color:var(--muted);margin-top:7px">Labs, vitals and facts were read straight from the export. The written summary is waiting for a coach${why ? ` — ${escHtml(why)}` : ""}. Re-analyze once one is available.</div>`;
    }
  } else if (enrichmentActive(status)) {
    detail = analyzingLineHtml(doc);
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
    ? `${markers.length} marker${markers.length === 1 ? "" : "s"}${flagged ? ` · ${flagged} flagged` : " · all in range"}${readFromData ? " · read from data" : ""}`
    : facts.length
      ? `${facts.length} fact${facts.length === 1 ? "" : "s"}${readFromData ? " · labs and vitals filed by date" : ""}`
      : readFromData
        ? "Read from data"
        : "Analyzed";

  const head = `<div class="sess-head${collapsible ? " hdoc-head" : ""}"${collapsible ? ` data-hdoc-toggle role="button" tabindex="0" aria-label="Toggle record detail"` : ""}>
      <span class="sess-date">${escHtml(healthKindLabel(doc.kind))}${doc.doc_date ? ` · <span title="${escAttr(absDate(String(doc.doc_date)))}">${escHtml(relAge(String(doc.doc_date)))}</span>` : ""}${derived ? `<span class="hdoc-tag">from import</span>` : ""}</span>
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
          <span class="hdoc-date-val">${doc.doc_date ? escHtml(absDate(String(doc.doc_date))) : "Set date"}</span>
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
        ${fileId ? `<a class="hdoc-link" href="${escAttr(`/api/health-docs/${fileId}/file`)}" target="_blank" rel="noopener" data-resource-link>view file</a>` : ""}
        <button class="iconbtn hdoc-del" data-hdel="${docIdAttr}" title="delete">×</button>
      </div>
    </div>`;
}

function healthDocHtml(doc: HealthDocRow, index?: number, opts?: ClientImagingCardOptions): string {
  if (
    doc.kind === "imaging" &&
    CairnImaging.imagingStudy(doc as import("../contracts/client-api.js").ClientHealthDocument)
  ) {
    return CairnImaging.imagingCard(doc as import("../contracts/client-api.js").ClientHealthDocument, index, opts);
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
  analyzingText,
  analyzingLineHtml,
  tickAnalyzingLines,
  startAnalyzingClock,
  highlightHealthDoc,
  settleUploadStatus,
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
