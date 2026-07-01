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
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function hdupElement<T extends Element = Element>(selector: string): T | null {
  return $<T>(selector);
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

function insertUploadedHealthDoc(doc: HealthDocUploadDocument, deps: HealthDocUploadDeps): void {
  const wrap = hdupElement<HTMLElement>("#hlist");
  if (!wrap) return;
  wrap.querySelector(".empty")?.remove();
  wrap.insertAdjacentHTML("afterbegin", CairnHealthDocs.healthDocHtml(doc));
  deps.wireDoc(wrap.querySelector<HTMLElement>(`.hdoc[data-hdoc="${doc.id}"]`));
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

  const setUploadReady = () => {
    const hasText = textInput.value.trim().length > 0;
    uploadBtn.disabled = !pendingFile && !hasText;
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

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    setPendingFile(file || null);
  });

  textInput.addEventListener("input", setUploadReady);

  uploadBox.addEventListener("dragover", (event) => {
    event.preventDefault();
    fileLabel.classList.add("dragover");
  });
  uploadBox.addEventListener("dragleave", () => fileLabel.classList.remove("dragover"));
  uploadBox.addEventListener("drop", (event) => {
    event.preventDefault();
    fileLabel.classList.remove("dragover");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) setPendingFile(file);
  });
  uploadBox.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    const image = files.find((file) => (file.type || "").startsWith("image/"));
    if (image) {
      event.preventDefault();
      setPendingFile(image);
      return;
    }
    if (event.target !== textInput) {
      const text = event.clipboardData && event.clipboardData.getData("text/plain");
      if (text) {
        event.preventDefault();
        textInput.value = text;
        setUploadReady();
      }
    }
  });

  uploadBtn.addEventListener("click", async () => {
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
        status.textContent = "Couldn't read that file. Try a different one.";
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
      status.textContent = "Couldn't upload that — check your connection.";
      uploadBtn.disabled = false;
      return;
    }

    const doc = hdupRecord(row) as HealthDocUploadDocument;
    if (!doc.id || doc.error) {
      status.textContent = "Couldn't upload that — try again.";
      uploadBtn.disabled = false;
      return;
    }

    status.textContent = "";
    deps.toast("Uploaded");
    clearPicker();
    insertUploadedHealthDoc(doc, deps);
    if (doc.id && deps.enrichmentActive(doc.enrichment_status)) deps.pollDoc(doc.id);
    refreshPictureAfterHealthDocUpload(doc, deps);
  });
}

const CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER = {
  wireUpload: wireHealthDocUpload,
  refreshPictureAfterUpload: refreshPictureAfterHealthDocUpload,
};

Object.assign(globalThis, { CairnHealthDocUploadController: CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnHealthDocUploadController = CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER;
}
