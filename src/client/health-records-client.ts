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
      <button id="hUpload" class="logbtn hupload-btn" disabled>ADD &amp; ANALYZE</button>
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

  function recordsListHtml(docsInput: unknown): string {
    const docs = normalizeDocuments(docsInput);
    if (!docs.length) return recordsEmptyHtml();
    const ordinary = docs.filter((doc) => doc.kind !== "imaging");
    const imaging = docs.filter((doc) => doc.kind === "imaging");
    const grouped = new Map<string, HealthRecordDocument[]>();
    for (const doc of imaging) {
      const study = CairnImaging.imagingStudy(doc);
      // One study stays one card. Prefer study-level anatomy; when it is absent,
      // the helper labels a genuinely multi-region/system study explicitly rather
      // than misclassifying the whole card from findings[0].
      const { system, region, laterality } = CairnImaging.imagingStudyGrouping(study);
      const key = [system, region, laterality].filter(Boolean).join(" · ");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(doc);
    }
    const ordinaryHtml = ordinary.map((doc, index) => CairnHealthDocs.healthDocHtml(doc, index)).join("");
    const imagingHtml = [...grouped]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, group]) =>
          `<section class="imaging-record-group"><h3>${escHtml(key.split(" · ").map(CairnImaging.imagingLabel).join(" · "))}</h3>${group.map((doc, index) => CairnHealthDocs.healthDocHtml(doc, index)).join("")}</section>`
      )
      .join("");
    return `${ordinaryHtml}${imagingHtml}`;
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
