// @ts-check
// Pure Health Records tab renderers. Upload, polling, and delete behavior stay in
// 08-me-records.js; this module owns only stable HTML.

type HealthRecordDocument = Parameters<Window["CairnHealthDocs"]["healthDocHtml"]>[0];

(() => {
function recordsUploadHtml(filePrompt = CairnHealthClient.H_FILE_PROMPT): string {
  return `<div class="hupload" id="hUploadBox">
      <label class="hupload-file" id="hFileLabel">
        <input id="hFile" type="file" accept="image/*,application/pdf,.zip,.htm,.html,.xml,application/zip,text/html,application/xml" hidden>
        <span class="hupload-plus" aria-hidden="true">+</span>
        <span id="hFileName">${escHtml(filePrompt)}</span>
      </label>
      <textarea id="hText" class="hupload-text" rows="4" placeholder="Paste result text or HTML export"></textarea>
      <button id="hUpload" class="logbtn hupload-btn" disabled>ADD &amp; ANALYZE</button>
      <div id="hStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>`;
}

function recordsEmptyHtml(message = "No documents yet."): string {
  return `<div class="empty">${escHtml(message)}</div>`;
}

function recordsTabHtml(filePrompt?: string): string {
  return `${recordsUploadHtml(filePrompt)}
    <div id="hlist"></div>`;
}

function normalizeDocuments(docsInput: unknown): HealthRecordDocument[] {
  return Array.isArray(docsInput)
    ? docsInput.filter((doc): doc is HealthRecordDocument => !!doc && typeof doc === "object")
    : [];
}

function recordsListHtml(docsInput: unknown): string {
  const docs = normalizeDocuments(docsInput);
  return docs.length
    ? docs.map((doc, index) => CairnHealthDocs.healthDocHtml(doc, index)).join("")
    : recordsEmptyHtml();
}

const CAIRN_HEALTH_RECORDS = {
  recordsUploadHtml,
  recordsEmptyHtml,
  recordsTabHtml,
  normalizeDocuments,
  recordsListHtml,
};

Object.assign(globalThis, { CairnHealthRecords: CAIRN_HEALTH_RECORDS });

if (typeof window !== "undefined") {
  window.CairnHealthRecords = CAIRN_HEALTH_RECORDS;
}
})();
