// @ts-check
// Pure Health Records tab renderers. Upload, polling, and delete behavior stay in
// 08-me-records.js; this module owns only stable HTML.

type HealthRecordDocument = import("../contracts/client-api.js").ClientHealthDocument;

(() => {
  function recordsUploadHtml(filePrompt = CairnHealthClient.H_FILE_PROMPT): string {
    return `<div class="hupload" id="hUploadBox">
      <div class="upload-mode" role="group" aria-label="Record type"><button type="button" class="upload-mode-btn is-active" data-upload-mode="record" aria-pressed="true">Record</button><button type="button" class="upload-mode-btn" data-upload-mode="imaging" aria-pressed="false">Imaging study</button></div>
      <label class="hupload-file" id="hFileLabel">
        <input id="hFile" type="file" accept="image/*,application/pdf,.zip,.htm,.html,.xml,application/zip,text/html,application/xml" hidden>
        <span class="hupload-plus" aria-hidden="true">+</span>
        <span id="hFileName">${escHtml(filePrompt)}</span>
      </label>
      <textarea id="hText" class="hupload-text" rows="4" placeholder="Paste result text or HTML export"></textarea>
      <button id="hUpload" class="logbtn hupload-btn" disabled>Add and read it</button>
      <div id="hStatus" role="status" aria-live="polite" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
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

  function isImagingStudyDoc(doc: HealthRecordDocument): boolean {
    return doc.kind === "imaging" && typeof CairnImaging !== "undefined" && !!CairnImaging.imagingStudy(doc);
  }

  function sourceHasOwnContent(doc: HealthRecordDocument): boolean {
    const parsed = CairnHealthDocs.parsedDoc ? CairnHealthDocs.parsedDoc(doc) : null;
    if (!parsed) return false;
    const markers = Array.isArray(parsed.markers) ? parsed.markers : [];
    const facts = Array.isArray(parsed.clinical_facts) ? parsed.clinical_facts : [];
    return markers.length > 0 || facts.length > 0;
  }

  // An upload whose every derived record is an imaging study (a pasted CT
  // report) is shown THROUGH that study: one scan, one card. An upload that
  // also split out lab panels, or carries markers of its own, keeps its card.
  function foldedSources(docs: HealthRecordDocument[]): Set<string> {
    const children = new Map<string, HealthRecordDocument[]>();
    for (const doc of docs) {
      if (doc.source_doc_id == null) continue;
      const key = String(doc.source_doc_id);
      if (!children.has(key)) children.set(key, []);
      children.get(key)!.push(doc);
    }
    const folded = new Set<string>();
    for (const doc of docs) {
      const key = String(doc.id);
      const derived = children.get(key);
      if (!derived?.length || isImagingStudyDoc(doc) || sourceHasOwnContent(doc)) continue;
      if (derived.every(isImagingStudyDoc)) folded.add(key);
    }
    return folded;
  }

  // Every record on one timeline, newest first, in the server's order (the
  // effective result date): an imaging study sits beside the labs of its week,
  // never in a section after all of them.
  function recordsListHtml(docsInput: unknown): string {
    const docs = normalizeDocuments(docsInput);
    if (!docs.length) return recordsEmptyHtml();
    const byId = new Map(docs.map((doc) => [String(doc.id), doc]));
    const folded = foldedSources(docs);
    const visible = docs.filter((doc) => !folded.has(String(doc.id)));
    return visible
      .map((doc, index) => {
        if (!isImagingStudyDoc(doc) || doc.source_doc_id == null) return CairnHealthDocs.healthDocHtml(doc, index);
        const key = String(doc.source_doc_id);
        const source = byId.get(key) || null;
        return CairnHealthDocs.healthDocHtml(doc, index, { source, sourceHidden: !!source && folded.has(key) });
      })
      .join("");
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
