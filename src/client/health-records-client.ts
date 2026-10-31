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
    <div id="hDedupe" class="hdedupe"></div>
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

  // An upload the server marked `folds_into_study` (a pasted imaging report whose
  // every derived record is an imaging study) is shown THROUGH that study: one scan,
  // one card. The server decides — it sees every derived row, the list does not —
  // and an upload whose study is not on this list keeps its own card (never lost).
  function foldedSources(docs: HealthRecordDocument[]): Set<string> {
    const shown = new Set<string>();
    const studies = new Set<string>();
    for (const doc of docs) {
      if (doc.source_doc_id != null && isImagingStudyDoc(doc)) shown.add(String(doc.source_doc_id));
      if (isImagingStudyDoc(doc)) studies.add(String(doc.id));
    }
    const folded = new Set<string>();
    for (const doc of docs) {
      const key = String(doc.id);
      if (doc.folds_into_study !== true || isImagingStudyDoc(doc)) continue;
      // a kept upload whose own study folded into another reads under THAT study
      const into = doc.folded_into_study != null ? String(doc.folded_into_study) : null;
      if (shown.has(key) || (into != null && studies.has(into))) folded.add(key);
    }
    return folded;
  }

  // Uploads kept when their study folded into another, by the study they now read under.
  function copiesByStudy(docs: HealthRecordDocument[], folded: Set<string>): Map<string, HealthRecordDocument[]> {
    const out = new Map<string, HealthRecordDocument[]>();
    for (const doc of docs) {
      if (!folded.has(String(doc.id)) || doc.folded_into_study == null) continue;
      const key = String(doc.folded_into_study);
      out.set(key, [...(out.get(key) ?? []), doc]);
    }
    return out;
  }

  // Every record on one timeline, newest first, in the server's order (the
  // effective result date): an imaging study sits beside the labs of its week,
  // never in a section after all of them.
  function recordsListHtml(docsInput: unknown): string {
    const docs = normalizeDocuments(docsInput);
    if (!docs.length) return recordsEmptyHtml();
    const byId = new Map(docs.map((doc) => [String(doc.id), doc]));
    const folded = foldedSources(docs);
    const copies = copiesByStudy(docs, folded);
    const visible = docs.filter((doc) => !folded.has(String(doc.id)));
    return visible
      .map((doc, index) => {
        const kept = copies.get(String(doc.id));
        if (!isImagingStudyDoc(doc) || doc.source_doc_id == null) {
          return CairnHealthDocs.healthDocHtml(doc, index, kept ? { copies: kept } : undefined);
        }
        const key = String(doc.source_doc_id);
        const source = byId.get(key) || null;
        return CairnHealthDocs.healthDocHtml(doc, index, {
          source,
          sourceHidden: !!source && folded.has(key),
          ...(kept ? { copies: kept } : {}),
        });
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
