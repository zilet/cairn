// DOM/controller half of the non-diagnostic DICOM viewer. Pixel buffers stay in
// this closure only and are released whenever the detail overlay is closed.

type DicomApi = (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;
type DicomManifest = import("../contracts/client-api.js").ClientDicomManifest;
type DicomSeries = DicomManifest["series"][number];
type DicomInstance = DicomSeries["instances"][number];
type DicomFrameInfo = {
  rows: number;
  columns: number;
  windowCenter: number;
  windowWidth: number;
  inverted: boolean;
};

function dicomViewerHtml(): string {
  return `<div class="dicom-viewer"><h2 class="detail-title">Image viewer</h2><p class="dicom-disclaimer">Personal reference only — not for diagnosis or treatment. Your radiology report and clinician remain authoritative.</p><div class="dicom-controls"><label>Series <select data-dicom-series></select></label><label>Image <input data-dicom-instance type="range" min="0" value="0"></label><label data-dicom-frame-wrap>Frame <input data-dicom-frame type="range" min="0" value="0"></label></div><p class="dicom-counter" data-dicom-counter></p><p class="dicom-meta" data-dicom-meta></p><div class="dicom-canvas-wrap"><canvas data-dicom-canvas></canvas><p data-dicom-state role="status">Loading study…</p></div><div class="dicom-controls"><button type="button" data-dicom-prev>Previous</button><button type="button" data-dicom-next>Next</button><label>Window <input data-dicom-width type="range" min="1"></label><label>Level <input data-dicom-center type="range"></label><button type="button" data-dicom-reset>Reset</button><button type="button" data-dicom-download>Download original</button></div><p class="dicom-warning">Cairn has not de-identified the source. Any burned-in annotations or source de-identification claims are informational only.</p></div>`;
}

function dicomAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

function openDicomViewer(studyId: number, origin: Element, api: DicomApi, toast: (message: string) => void): void {
  openDetailFrom(origin, () => {
    const detail = mountDetail(dicomViewerHtml());
    const state = detail.querySelector<HTMLElement>("[data-dicom-state]")!;
    const select = detail.querySelector<HTMLSelectElement>("[data-dicom-series]")!;
    const instance = detail.querySelector<HTMLInputElement>("[data-dicom-instance]")!;
    const frame = detail.querySelector<HTMLInputElement>("[data-dicom-frame]")!;
    const frameWrap = detail.querySelector<HTMLElement>("[data-dicom-frame-wrap]")!;
    const canvas = detail.querySelector<HTMLCanvasElement>("[data-dicom-canvas]")!;
    const meta = detail.querySelector<HTMLElement>("[data-dicom-meta]")!;
    const counter = detail.querySelector<HTMLElement>("[data-dicom-counter]")!;
    const centerInput = detail.querySelector<HTMLInputElement>("[data-dicom-center]")!;
    const widthInput = detail.querySelector<HTMLInputElement>("[data-dicom-width]")!;
    const previous = detail.querySelector<HTMLButtonElement>("[data-dicom-prev]")!;
    const next = detail.querySelector<HTMLButtonElement>("[data-dicom-next]")!;
    const download = detail.querySelector<HTMLButtonElement>("[data-dicom-download]")!;

    let series: DicomSeries[] = [];
    let pixels: Float32Array | null = null;
    let frameInfo: DicomFrameInfo | null = null;
    let frameSelection = "";
    let selectedSeries = 0;
    let selectedInstance = 0;
    let selectedFrame = 0;
    let center = 0;
    let width = 1;
    let renderToken = 0;
    let cleaned = false;
    let frameAbort: AbortController | null = null;
    let manifestAbort: AbortController | null = new AbortController();
    let downloadAbort: AbortController | null = null;
    let observer: MutationObserver | null = null;

    const current = (): DicomInstance | undefined => series[selectedSeries]?.instances?.[selectedInstance];
    const selectionKey = (): string => `${selectedSeries}:${selectedInstance}:${selectedFrame}:${current()?.id || 0}`;
    const active = (token: number, snapshot: string): boolean =>
      !cleaned &&
      CairnDicomViewerModel.dicomResponseIsCurrent(renderToken, token, snapshot, selectionKey(), detail.isConnected);
    const clearFrame = () => {
      pixels = null;
      frameInfo = null;
      frameSelection = "";
      meta.textContent = "";
      const context = canvas.getContext("2d");
      context?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
    };
    const redraw = () => {
      if (!pixels || !frameInfo || frameSelection !== selectionKey()) return;
      const rgba = CairnDicomViewerModel.dicomWindowPixels(pixels, frameInfo, center, width);
      const image = new ImageData(frameInfo.columns, frameInfo.rows);
      image.data.set(rgba);
      canvas.getContext("2d")?.putImageData(image, 0, 0);
    };
    const renderCounter = () => {
      const items = series[selectedSeries]?.instances || [];
      const frames = Math.max(1, Number(current()?.number_of_frames || 1));
      counter.textContent = `Series ${Math.min(selectedSeries + 1, series.length)} of ${series.length} · Image ${Math.min(selectedInstance + 1, items.length)} of ${items.length} · Frame ${Math.min(selectedFrame + 1, frames)} of ${frames}`;
    };

    const loadFrame = async () => {
      const item = current();
      const token = ++renderToken;
      const snapshot = selectionKey();
      frameAbort?.abort();
      frameAbort = new AbortController();
      clearFrame();
      renderCounter();
      if (!item) {
        if (active(token, snapshot)) state.textContent = "No image is selected.";
        return;
      }
      if (!item.previewable) {
        if (active(token, snapshot)) {
          state.textContent = CairnDicomViewerModel.dicomPreviewReason(item.preview_support_reason);
          meta.textContent = "Preview unavailable. The original remains available to download.";
        }
        return;
      }
      state.textContent = "Loading image…";
      try {
        const result = await apiBinary(`/health-docs/${studyId}/dicom/instances/${item.id}/frames/${selectedFrame}`, {
          signal: frameAbort.signal,
        });
        if (!active(token, snapshot)) return;
        const rows = Number(result.headers.get("X-Cairn-Rows"));
        const columns = Number(result.headers.get("X-Cairn-Columns"));
        const windowCenter = Number(result.headers.get("X-Cairn-Window-Center"));
        const windowWidth = Number(result.headers.get("X-Cairn-Window-Width"));
        if (
          !Number.isInteger(rows) ||
          rows <= 0 ||
          !Number.isInteger(columns) ||
          columns <= 0 ||
          !Number.isFinite(windowCenter) ||
          !Number.isFinite(windowWidth) ||
          windowWidth <= 0 ||
          result.body.byteLength !== rows * columns * Float32Array.BYTES_PER_ELEMENT
        ) {
          throw new Error("invalid frame response");
        }
        const info: DicomFrameInfo = {
          rows,
          columns,
          windowCenter,
          windowWidth,
          inverted: result.headers.get("X-Cairn-Inverted") === "1",
        };
        if (!active(token, snapshot)) return;
        pixels = new Float32Array(result.body);
        frameInfo = info;
        frameSelection = snapshot;
        center = info.windowCenter;
        width = info.windowWidth;
        centerInput.value = String(center);
        centerInput.min = String(center - width);
        centerInput.max = String(center + width);
        widthInput.value = String(width);
        widthInput.max = String(Math.max(width * 3, 1));
        canvas.width = columns;
        canvas.height = rows;
        redraw();
        state.textContent = "";
        const raw = item as Record<string, unknown>;
        const orientation = CairnDicomViewerModel.dicomOrientationCosines(raw.image_orientation)
          ? "Orientation available"
          : "Orientation unavailable";
        meta.textContent = `${columns} × ${rows} · ${String(raw.photometric_interpretation || "photometric unavailable")} · ${String(raw.pixel_spacing || "spacing unavailable")} · ${String(raw.laterality || "laterality unavailable")} · ${orientation}.`;
      } catch (error) {
        if (!active(token, snapshot) || dicomAbortError(error)) return;
        clearFrame();
        state.textContent = "Couldn’t load this image. Check your connection or access, then try another image.";
      }
    };

    const sync = () => {
      const items = series[selectedSeries]?.instances || [];
      selectedInstance = Math.max(0, Math.min(selectedInstance, Math.max(0, items.length - 1)));
      instance.max = String(Math.max(0, items.length - 1));
      instance.value = String(selectedInstance);
      const frames = Math.max(1, Number(current()?.number_of_frames || 1));
      selectedFrame = Math.max(0, Math.min(selectedFrame, frames - 1));
      frame.max = String(frames - 1);
      frame.value = String(selectedFrame);
      frameWrap.hidden = frames <= 1;
      previous.disabled = selectedInstance <= 0;
      next.disabled = selectedInstance >= items.length - 1;
      void loadFrame();
    };

    select.addEventListener("change", () => {
      selectedSeries = Number(select.value);
      selectedInstance = 0;
      selectedFrame = 0;
      sync();
    });
    instance.addEventListener("input", () => {
      selectedInstance = Number(instance.value);
      selectedFrame = 0;
      sync();
    });
    frame.addEventListener("input", () => {
      selectedFrame = Number(frame.value);
      void loadFrame();
    });
    previous.addEventListener("click", () => {
      selectedInstance = Math.max(0, selectedInstance - 1);
      selectedFrame = 0;
      sync();
    });
    next.addEventListener("click", () => {
      selectedInstance = Math.min((series[selectedSeries]?.instances?.length || 1) - 1, selectedInstance + 1);
      selectedFrame = 0;
      sync();
    });
    const adjust = () => {
      if (!frameInfo || frameSelection !== selectionKey()) return;
      center = Number(centerInput.value);
      width = Math.max(1, Number(widthInput.value));
      redraw();
    };
    centerInput.addEventListener("input", adjust);
    widthInput.addEventListener("input", adjust);
    detail.querySelector("[data-dicom-reset]")?.addEventListener("click", () => {
      if (!frameInfo || frameSelection !== selectionKey()) return;
      center = frameInfo.windowCenter;
      width = frameInfo.windowWidth;
      centerInput.value = String(center);
      widthInput.value = String(width);
      redraw();
    });
    download.addEventListener("click", async () => {
      const item = current();
      if (!item) return;
      downloadAbort?.abort();
      downloadAbort = new AbortController();
      const token = renderToken;
      const snapshot = selectionKey();
      try {
        const file = await apiBinary(`/health-docs/${studyId}/dicom/instances/${item.id}/file`, {
          signal: downloadAbort.signal,
        });
        if (!active(token, snapshot)) return;
        const url = URL.createObjectURL(new Blob([file.body], { type: "application/dicom" }));
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = "dicom-instance.dcm";
          document.body.appendChild(link);
          try {
            link.click();
          } finally {
            link.remove();
          }
        } finally {
          if (typeof setTimeout === "function") setTimeout(() => URL.revokeObjectURL(url), 0);
          else URL.revokeObjectURL(url);
        }
      } catch (error) {
        if (active(token, snapshot) && !dicomAbortError(error)) toast("Couldn’t download the original");
      }
    });

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      renderToken++;
      frameAbort?.abort();
      manifestAbort?.abort();
      downloadAbort?.abort();
      frameAbort = manifestAbort = downloadAbort = null;
      clearFrame();
      series = [];
      observer?.disconnect();
      observer = null;
    };
    observer = new MutationObserver(() => {
      if (!detail.isConnected) cleanup();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const manifestSignal = manifestAbort.signal;
    void api(`/health-docs/${studyId}/dicom/manifest`, { signal: manifestSignal })
      .then((manifest) => {
        if (cleaned || !detail.isConnected || manifestSignal.aborted) return;
        const parsed = CairnDicomViewerModel.dicomManifestFallback(manifest);
        series = parsed.series as DicomSeries[];
        if (!series.length) {
          state.textContent = parsed.reason || "No images available.";
          counter.textContent = "";
          return;
        }
        select.innerHTML = series
          .map(
            (item, index) =>
              `<option value="${index}">${escHtml([item.modality, item.description, `${item.instances?.length || 0} images`].filter(Boolean).join(" · "))}</option>`
          )
          .join("");
        sync();
      })
      .catch((error) => {
        if (!cleaned && detail.isConnected && !manifestSignal.aborted && !dicomAbortError(error)) {
          state.textContent = "Couldn’t load this study.";
        }
      });
  });
}

Object.assign(globalThis, { CairnDicomViewer: { openDicomViewer, dicomViewerHtml } });
if (typeof window !== "undefined") window.CairnDicomViewer = { openDicomViewer, dicomViewerHtml };
