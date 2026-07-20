// Health document upload controller: file/text intake, upload, row insertion,
// and the Health Picture cache update caused by a new document.

type HealthDocUploadDocument = import("../contracts/client-api.js").ClientHealthDocument;

type HealthDocUploadPictureCache = {
  review?: Record<string, unknown> | null;
  docCount?: number;
  newestDocAt?: string | null;
};

type HealthDocUploadBody = {
  original_name: string;
  mime?: string;
  data_base64?: string;
  text?: string;
};

type ImagingQueueItem = {
  file: File;
  role: "report" | "image" | "mychart" | "dicom";
  mime: string;
  jobId?: number;
  state?: "queued" | "importing" | "failed" | "status_unknown";
};

type DicomImportJob = import("../contracts/client-api.js").ClientDicomImportJob;

type HealthDocUploadDeps = {
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  toast(message: string): void;
  enrichmentActive(status: unknown): boolean;
  pollDoc(id: string | number): void;
  wireDoc(el: HTMLElement | null): void;
  getHealthPictureCache(): HealthDocUploadPictureCache | null;
  setHealthPictureCache(cache: HealthDocUploadPictureCache | null): HealthDocUploadPictureCache | null;
  paintHealthPicture(): void;
};

function hdupRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function hdupElement<T extends Element = Element>(selector: string): T | null {
  return $<T>(selector);
}

function hdupQueryAll<T extends Element = Element>(root: unknown, selector: string): T[] {
  const query = root && typeof root === "object" ? (root as { querySelectorAll?: unknown }).querySelectorAll : null;
  return typeof query === "function"
    ? Array.from((query as (selector: string) => NodeListOf<T>).call(root, selector))
    : [];
}

function hdupFileDataUrl(file: File): Promise<string | ArrayBuffer | null> {
  return new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function refreshPictureAfterHealthDocUpload(doc: HealthDocUploadDocument, deps: HealthDocUploadDeps): void {
  const pictureCache = deps.getHealthPictureCache();
  const stamp = doc.created_at || new Date().toISOString();
  if (pictureCache) {
    pictureCache.docCount = (pictureCache.docCount || 0) + 1;
    if (!pictureCache.newestDocAt || stamp > pictureCache.newestDocAt) pictureCache.newestDocAt = stamp;
    deps.setHealthPictureCache(pictureCache);
  } else {
    deps.setHealthPictureCache({ review: null, docCount: 1, newestDocAt: stamp });
  }
  deps.paintHealthPicture();
}

function insertUploadedHealthDoc(doc: HealthDocUploadDocument, deps: HealthDocUploadDeps): boolean {
  const wrap = hdupElement<HTMLElement>("#hlist");
  if (!wrap || wrap.querySelector(`.hdoc[data-hdoc="${doc.id}"]`)) return false;
  wrap.querySelector(".empty")?.remove();
  wrap.insertAdjacentHTML("afterbegin", CairnHealthDocs.healthDocHtml(doc));
  deps.wireDoc(wrap.querySelector<HTMLElement>(`.hdoc[data-hdoc="${doc.id}"]`));
  return true;
}

function hdupWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hdupJobProgress(job: DicomImportJob): string {
  const progress = job.progress || {};
  const warnings = (Array.isArray(job.warnings) ? job.warnings : [])
    .slice(0, 3)
    .map((warning) =>
      String(warning || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160)
    )
    .filter(Boolean);
  return `DICOM indexing: ${Number(progress.entries_seen || 0)} entries, ${Number(progress.instances_indexed || 0)} images, ${Number(progress.studies_created || 0)} studies.${warnings.length ? ` ${warnings.join(" ")}` : ""}`;
}

async function hdupWaitForDicomJob(id: number, deps: HealthDocUploadDeps, status: Element): Promise<DicomImportJob> {
  while (status.isConnected) {
    const update = hdupRecord(await deps.api(`/health-docs/imaging/dicom-imports/${id}`)) as unknown as DicomImportJob;
    status.textContent = hdupJobProgress(update);
    if (update.status === "done" || update.status === "failed") return update;
    await hdupWait(1200);
  }
  throw new Error("upload surface detached");
}

async function hdupRefreshStudy(id: number, deps: HealthDocUploadDeps): Promise<HealthDocUploadDocument | null> {
  try {
    const doc = hdupRecord(await deps.api(`/health-docs/${id}`)) as HealthDocUploadDocument;
    if (!doc.id || doc.kind !== "imaging") return null;
    if (insertUploadedHealthDoc(doc, deps)) refreshPictureAfterHealthDocUpload(doc, deps);
    deps.pollDoc(doc.id);
    return doc;
  } catch {
    return null;
  }
}

async function hdupReconnectDicomJobs(deps: HealthDocUploadDeps, status: Element): Promise<void> {
  if (typeof CairnImagingUploadModel === "undefined") return;
  const activeIds = CairnImagingUploadModel.readActiveDicomJobIds();
  if (!activeIds.length) return;
  status.textContent = `Reconnecting to ${activeIds.length} DICOM import${activeIds.length === 1 ? "" : "s"}…`;
  const studyIds: number[] = [];
  let failed = 0;
  try {
    for (const id of activeIds) {
      const job = await hdupWaitForDicomJob(id, deps, status);
      CairnImagingUploadModel.forgetActiveDicomJob(id);
      if (job.status === "failed") {
        failed++;
        continue;
      }
      studyIds.push(...CairnImagingUploadModel.uniqueDicomStudyIds(job.result?.study_ids));
    }
  } catch {
    for (const studyId of CairnImagingUploadModel.uniqueDicomStudyIds(studyIds)) {
      await hdupRefreshStudy(studyId, deps);
    }
    if (studyIds.length) swrInvalidate("health:records");
    status.textContent =
      "Couldn’t check DICOM import status. The job continues server-side; reopen Records to retry status later.";
    return;
  }
  const uniqueIds = CairnImagingUploadModel.uniqueDicomStudyIds(studyIds);
  for (const id of uniqueIds) await hdupRefreshStudy(id, deps);
  // Recovered jobs have no recoverable File queue. Once all persisted imports
  // have settled, starting each returned study once is the only safe finish.
  try {
    for (const id of uniqueIds) {
      await deps.api(`/health-docs/${id}/imaging-analyze`, { method: "POST" });
      deps.pollDoc(id);
    }
  } catch {
    status.textContent =
      "The DICOM files are saved, but analysis didn’t start. Open the study and retry analysis later.";
    return;
  }
  if (uniqueIds.length) {
    status.textContent = `Recovered ${uniqueIds.length} DICOM stud${uniqueIds.length === 1 ? "y" : "ies"}; analysis started.`;
    deps.toast("DICOM import reconnected");
    swrInvalidate("health:records");
  } else if (failed) {
    status.textContent = "A previous DICOM import couldn’t finish. Choose the source file again to retry.";
  }
}

function resetHealthDocPicker(fileInput: HTMLInputElement, textInput: HTMLTextAreaElement, fileName: Element): void {
  fileInput.value = "";
  textInput.value = "";
  fileName.textContent = CairnHealthClient.H_FILE_PROMPT;
}

function wireHealthDocUpload(deps: HealthDocUploadDeps): void {
  const fileInput = hdupElement<HTMLInputElement>("#hFile");
  const fileName = hdupElement("#hFileName");
  const uploadBox = hdupElement<HTMLElement>("#hUploadBox");
  const textInput = hdupElement<HTMLTextAreaElement>("#hText");
  const uploadBtn = hdupElement<HTMLButtonElement>("#hUpload");
  const status = hdupElement("#hStatus");
  const fileLabel = hdupElement("#hFileLabel");
  if (!fileInput || !fileName || !uploadBox || !textInput || !uploadBtn || !status || !fileLabel) return;

  let pendingFile: File | null = null;
  let imagingMode = false;
  const imagingFiles: ImagingQueueItem[] = [];
  let imagingDraft: HealthDocUploadDocument | null = null;
  let importedStudyIds: number[] = [];
  let associationDocs: HealthDocUploadDocument[] = [];
  let associatedStudyId: number | null = null;
  let pendingAnalysisIds: number[] = [];
  const defaultUploadLabel = uploadBtn.textContent || "ADD & ANALYZE";

  const hasOrdinaryFiles = () => imagingFiles.some((item) => item.role !== "dicom");
  const hasActiveImport = () =>
    imagingFiles.some((item) => item.role === "dicom" && !!item.jobId && item.state === "importing");
  const associationDocsReady = () =>
    importedStudyIds.every((id) => associationDocs.some((doc) => Number(doc.id) === id));
  const associationTarget = () => {
    const target = CairnImagingUploadModel.imagingAssociationTarget(
      importedStudyIds,
      hasOrdinaryFiles(),
      associatedStudyId
    );
    return target.state === "ready" && importedStudyIds.length > 1 && !associationDocsReady()
      ? { state: "choose" as const, studyId: null }
      : target;
  };

  const setUploadReady = () => {
    const hasText = textInput.value.trim().length > 0;
    if (!imagingMode) {
      uploadBtn.textContent = defaultUploadLabel;
      uploadBtn.disabled = !pendingFile && !hasText;
      return;
    }
    const association = associationTarget();
    const choicesMissing = association.state === "choose" && !associationDocsReady();
    uploadBtn.textContent = choicesMissing
      ? "RETRY STUDY LIST"
      : association.state === "choose"
        ? "CHOOSE A STUDY"
        : defaultUploadLabel;
    uploadBtn.disabled = imagingMode
      ? hasActiveImport() ||
        (association.state === "choose" && !choicesMissing) ||
        (!imagingFiles.length && !imagingDraft && !pendingAnalysisIds.length)
      : !pendingFile && !hasText;
  };

  const renderImagingQueue = () => {
    let queue = uploadBox.querySelector<HTMLElement>("#hImagingQueue");
    if (!imagingMode) {
      queue?.remove();
      return;
    }
    if (!queue) {
      queue = document.createElement("div");
      queue.id = "hImagingQueue";
      uploadBox.insertBefore(queue, textInput);
    }
    const rows = imagingFiles
      .map((item, index) => {
        const stateLabel =
          item.role === "dicom"
            ? item.state === "importing"
              ? "Import running"
              : item.state === "failed"
                ? "Import failed — retry"
                : item.state === "status_unknown"
                  ? "Status unavailable — retry check"
                  : "DICOM import"
            : "";
        const role =
          item.role === "dicom"
            ? `<small>${escHtml(stateLabel)}</small>`
            : `<select data-imaging-role="${index}" aria-label="Role for ${escAttr(item.file.name)}"><option value="report"${item.role === "report" ? " selected" : ""}>Report</option><option value="image"${item.role === "image" ? " selected" : ""}>Image</option><option value="mychart"${item.role === "mychart" ? " selected" : ""}>MyChart</option></select>`;
        return `<div class="imaging-queue-row"><span>${escHtml(item.file.name)}</span>${role}<button type="button" class="hdoc-link" data-imaging-remove="${index}" aria-label="Remove ${escAttr(item.file.name)}"${item.jobId ? " disabled" : ""}>Remove</button></div>`;
      })
      .join("");
    const association = associationTarget();
    const choices =
      association.state === "choose" && associationDocsReady()
        ? `<div class="imaging-association" role="group" aria-labelledby="imagingAssociationLabel"><p id="imagingAssociationLabel">These DICOM files contain more than one study. Choose where the report or images belong.</p><select data-imaging-association aria-label="Study for the report or images"><option value="">Choose a study…</option>${associationDocs.map((doc) => `<option value="${Number(doc.id)}"${associatedStudyId === Number(doc.id) ? " selected" : ""}>${escHtml(CairnImagingUploadModel.dicomStudyChoiceLabel(doc))}</option>`).join("")}</select></div>`
        : association.state === "choose"
          ? `<div class="imaging-association" role="status"><p>Study details couldn’t be loaded yet. Retry the study list before attaching the report or images.</p></div>`
          : "";
    queue.innerHTML = `<p class="imaging-note">Add reports, images, DICOM files, or a DICOM ZIP. DICOM originals upload directly and may be up to 256 MiB; report and image attachments stay limited to 15 MiB.</p>${rows}${choices}`;
    hdupQueryAll<HTMLSelectElement>(queue, "[data-imaging-role]").forEach((select) =>
      select.addEventListener("change", () => {
        const item = imagingFiles[Number(select.dataset.imagingRole)];
        if (item && item.role !== "dicom") item.role = select.value as "report" | "image" | "mychart";
      })
    );
    queue.querySelector<HTMLSelectElement>("[data-imaging-association]")?.addEventListener("change", (event) => {
      const selected = Number((event.currentTarget as HTMLSelectElement).value);
      associatedStudyId = importedStudyIds.includes(selected) ? selected : null;
      renderImagingQueue();
      setUploadReady();
    });
    hdupQueryAll<HTMLButtonElement>(queue, "[data-imaging-remove]").forEach((button) =>
      button.addEventListener("click", () => {
        const index = Number(button.dataset.imagingRemove);
        if (imagingFiles[index]?.jobId) return;
        imagingFiles.splice(index, 1);
        if (!hasOrdinaryFiles()) associatedStudyId = null;
        renderImagingQueue();
        setUploadReady();
      })
    );
  };

  const queueImagingFiles = (files: File[]) => {
    for (const file of files) {
      const route = CairnImagingUploadModel.imagingUploadRoute(file);
      if (!route.accepted) {
        if (file.size > route.maxBytes) deps.toast(`${file.name} is too large (max ${route.maxLabel})`);
        else deps.toast(`${file.name} isn’t a PDF, JPEG, PNG, DICOM, or ZIP`);
        continue;
      }
      imagingFiles.push({ file, role: route.role, mime: route.mime, state: "queued" });
    }
    associationDocs = [];
    associatedStudyId = null;
    renderImagingQueue();
    setUploadReady();
  };

  const clearPicker = () => {
    resetHealthDocPicker(fileInput, textInput, fileName);
    pendingFile = null;
  };

  const setPendingFile = (file: File | null) => {
    if (!file) {
      pendingFile = null;
      fileName.textContent = CairnHealthClient.H_FILE_PROMPT;
      setUploadReady();
      return;
    }
    if (file.size > CairnHealthClient.MAX_DOC_BYTES) {
      deps.toast("File too large (max 15MB)");
      fileInput.value = "";
      pendingFile = null;
      fileName.textContent = CairnHealthClient.H_FILE_PROMPT;
      setUploadReady();
      return;
    }
    pendingFile = file;
    fileName.textContent = file.name || "Pasted image";
    setUploadReady();
  };

  const uploadOrdinaryImagingFiles = async (studyId: number): Promise<boolean> => {
    while (hasOrdinaryFiles()) {
      const item = imagingFiles.find((row) => row.role !== "dicom")!;
      status.textContent = `Uploading ${item.file.name}…`;
      try {
        const dataUrl = await hdupFileDataUrl(item.file);
        await deps.api(`/health-docs/${studyId}/imaging-files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            original_name: item.file.name,
            mime: item.mime,
            data_base64: String(dataUrl).split(",")[1] || "",
            source_kind: item.role,
          }),
        });
        imagingFiles.splice(imagingFiles.indexOf(item), 1);
        renderImagingQueue();
      } catch {
        status.textContent = `Couldn’t upload ${item.file.name}. It remains queued; retry when ready.`;
        return false;
      }
    }
    return true;
  };

  const analyzePendingStudies = async (): Promise<boolean> => {
    while (pendingAnalysisIds.length) {
      const id = pendingAnalysisIds[0];
      status.textContent = "Starting imaging analysis…";
      try {
        await deps.api(`/health-docs/${id}/imaging-analyze`, { method: "POST" });
        pendingAnalysisIds.shift();
        deps.pollDoc(id);
      } catch {
        status.textContent = "Files are saved. Analysis didn’t start; use Add & analyze to retry.";
        return false;
      }
    }
    return true;
  };

  const runDicomImports = async (): Promise<boolean> => {
    const batch = await CairnImagingUploadModel.processDicomImportBatch(
      imagingFiles.filter((item) => item.role === "dicom"),
      {
        start: async (item) => {
          status.textContent = `Uploading ${item.file.name} for DICOM import…`;
          return hdupRecord(
            await deps.api("/health-docs/imaging/dicom-imports", {
              method: "POST",
              headers: { "Content-Type": item.mime },
              body: item.file,
            })
          ) as unknown as DicomImportJob;
        },
        wait: (id) => hdupWaitForDicomJob(id, deps, status),
        remember: (id) => {
          CairnImagingUploadModel.rememberActiveDicomJob(id);
        },
        forget: (id) => {
          CairnImagingUploadModel.forgetActiveDicomJob(id);
        },
        onState: () => renderImagingQueue(),
        onDone: (item) => {
          imagingFiles.splice(imagingFiles.indexOf(item as ImagingQueueItem), 1);
          renderImagingQueue();
        },
      }
    );
    importedStudyIds = CairnImagingUploadModel.uniqueDicomStudyIds([...importedStudyIds, ...batch.studyIds]);
    if (batch.ok) return true;
    status.textContent =
      batch.reason === "failed"
        ? "DICOM import couldn’t finish. The source file remains queued; use Add & analyze to retry."
        : batch.reason === "status_unknown"
          ? "Couldn’t check DICOM import status. The job continues server-side; use Add & analyze to retry status later."
          : "Couldn’t start the DICOM import. The source file remains queued; retry when ready.";
    return false;
  };

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    if (imagingMode) {
      fileInput.value = "";
      queueImagingFiles(files);
      return;
    }
    setPendingFile(files[0] || null);
  });

  hdupQueryAll<HTMLButtonElement>(uploadBox, "[data-upload-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      imagingMode = button.dataset.uploadMode === "imaging";
      hdupQueryAll(uploadBox, "[data-upload-mode]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      fileInput.multiple = imagingMode;
      fileInput.accept = imagingMode
        ? "image/jpeg,image/png,application/pdf,application/dicom,application/zip,.jpg,.jpeg,.png,.pdf,.dcm,.zip"
        : "image/*,application/pdf,.zip,.htm,.html,.xml,application/zip,text/html,application/xml";
      textInput.hidden = imagingMode;
      fileName.textContent = imagingMode ? "Choose imaging files" : CairnHealthClient.H_FILE_PROMPT;
      renderImagingQueue();
      setUploadReady();
    })
  );

  textInput.addEventListener("input", setUploadReady);
  uploadBox.addEventListener("dragover", (event) => {
    event.preventDefault();
    fileLabel.classList.add("dragover");
  });
  uploadBox.addEventListener("dragleave", () => fileLabel.classList.remove("dragover"));
  uploadBox.addEventListener("drop", (event) => {
    event.preventDefault();
    fileLabel.classList.remove("dragover");
    const files = Array.from(event.dataTransfer?.files || []);
    if (imagingMode) queueImagingFiles(files);
    else if (files[0]) setPendingFile(files[0]);
  });
  uploadBox.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (imagingMode && files.length) {
      event.preventDefault();
      queueImagingFiles(files);
      return;
    }
    const image = files.find((file) => (file.type || "").startsWith("image/"));
    if (image) {
      event.preventDefault();
      setPendingFile(image);
      return;
    }
    if (event.target !== textInput) {
      const text = event.clipboardData?.getData("text/plain");
      if (text) {
        event.preventDefault();
        textInput.value = text;
        setUploadReady();
      }
    }
  });

  uploadBtn.addEventListener("click", async () => {
    if (imagingMode) {
      if (!imagingFiles.length && !imagingDraft && !pendingAnalysisIds.length) return;
      uploadBtn.disabled = true;

      if (pendingAnalysisIds.length) {
        const analyzed = await analyzePendingStudies();
        if (analyzed) {
          status.textContent = "Analysis started.";
          deps.toast("Imaging study uploaded");
          imagingDraft = null;
          importedStudyIds = [];
          associationDocs = [];
          associatedStudyId = null;
        }
        swrInvalidate("health:records");
        setUploadReady();
        return;
      }

      const hasDicomFlow = importedStudyIds.length > 0 || imagingFiles.some((item) => item.role === "dicom");
      if (hasDicomFlow) {
        if (!(await runDicomImports())) {
          setUploadReady();
          return;
        }
        for (const id of importedStudyIds) {
          const doc = await hdupRefreshStudy(id, deps);
          if (doc && !associationDocs.some((row) => row.id === doc.id)) associationDocs.push(doc);
        }
        swrInvalidate("health:records");
        const ordinary = hasOrdinaryFiles();
        const association = associationTarget();
        if (association.state === "choose") {
          status.textContent = associationDocsReady()
            ? "Choose which study receives the report or images. The other DICOM studies stay separate."
            : "Couldn’t load every study label. The studies are saved; retry the study list before attaching anything.";
          renderImagingQueue();
          setUploadReady();
          return;
        }
        associatedStudyId = association.studyId;
        if (ordinary && associatedStudyId && !(await uploadOrdinaryImagingFiles(associatedStudyId))) {
          setUploadReady();
          return;
        }
        pendingAnalysisIds = CairnImagingUploadModel.imagingAnalysisTargets(
          importedStudyIds,
          ordinary,
          associatedStudyId
        );
      } else {
        if (!imagingDraft) {
          const ordinary = imagingFiles.find((item) => item.role !== "dicom");
          if (!ordinary) {
            setUploadReady();
            return;
          }
          status.textContent = "Creating imaging study…";
          try {
            imagingDraft = hdupRecord(
              await deps.api("/health-docs/imaging", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ original_name: ordinary.file.name || "Imaging study" }),
              })
            ) as HealthDocUploadDocument;
          } catch {
            status.textContent = "Couldn’t create the imaging study.";
            setUploadReady();
            return;
          }
          if (!imagingDraft.id) {
            status.textContent = "Couldn’t create the imaging study.";
            imagingDraft = null;
            setUploadReady();
            return;
          }
          if (insertUploadedHealthDoc(imagingDraft, deps)) refreshPictureAfterHealthDocUpload(imagingDraft, deps);
          swrInvalidate("health:records");
        }
        if (!(await uploadOrdinaryImagingFiles(imagingDraft.id))) {
          setUploadReady();
          return;
        }
        pendingAnalysisIds = [imagingDraft.id];
      }

      const analyzed = await analyzePendingStudies();
      if (analyzed) {
        status.textContent = "Analysis started.";
        deps.toast("Imaging study uploaded");
        imagingDraft = null;
        importedStudyIds = [];
        associationDocs = [];
        associatedStudyId = null;
      }
      swrInvalidate("health:records");
      renderImagingQueue();
      setUploadReady();
      return;
    }

    const file = pendingFile;
    const pastedText = textInput.value.trim();
    if (!file && !pastedText) {
      deps.toast("Add a file or text first");
      return;
    }
    if (file && file.size > CairnHealthClient.MAX_DOC_BYTES) {
      deps.toast("File too large (max 15MB)");
      return;
    }
    if (!file && pastedText.length > CairnHealthClient.MAX_DOC_TEXT) {
      deps.toast("Text is too long");
      return;
    }

    uploadBtn.disabled = true;
    status.textContent = "Uploading…";
    const body: HealthDocUploadBody = { original_name: "" };
    if (file) {
      let dataUrl: string | ArrayBuffer | null;
      try {
        dataUrl = await hdupFileDataUrl(file);
      } catch {
        status.textContent = "Couldn’t read that file. Try a different one.";
        uploadBtn.disabled = false;
        return;
      }
      body.original_name = file.name || "Pasted image";
      body.mime = CairnHealthClient.guessUploadMime(file);
      body.data_base64 = String(dataUrl).split(",")[1] || "";
    } else {
      body.original_name = "Pasted results";
      body.text = pastedText;
    }

    let row: unknown = null;
    try {
      row = await deps.api("/health-docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      status.textContent = "Couldn’t upload that — check your connection.";
      uploadBtn.disabled = false;
      return;
    }
    const doc = hdupRecord(row) as HealthDocUploadDocument;
    if (!doc.id || doc.error) {
      status.textContent = "Couldn’t upload that — try again.";
      uploadBtn.disabled = false;
      return;
    }
    status.textContent = "";
    deps.toast("Uploaded");
    clearPicker();
    insertUploadedHealthDoc(doc, deps);
    if (deps.enrichmentActive(doc.enrichment_status)) deps.pollDoc(doc.id);
    refreshPictureAfterHealthDocUpload(doc, deps);
  });

  void hdupReconnectDicomJobs(deps, status);
}

const CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER = {
  wireUpload: wireHealthDocUpload,
  refreshPictureAfterUpload: refreshPictureAfterHealthDocUpload,
};

Object.assign(globalThis, { CairnHealthDocUploadController: CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnHealthDocUploadController = CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER;
}
