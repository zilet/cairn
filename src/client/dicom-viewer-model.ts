// Pure DICOM grayscale display helpers. This is a personal-reference viewer,
// deliberately limited to server-decoded Float32 frames.

type DicomFrameMeta = { rows: number; columns: number; windowCenter: number; windowWidth: number; inverted: boolean };

function dicomWindowPixels(
  pixels: Float32Array,
  meta: DicomFrameMeta,
  center = meta.windowCenter,
  width = meta.windowWidth
): Uint8ClampedArray {
  const safeWidth = Math.max(1, Number(width) || 1);
  const low = Number(center) - safeWidth / 2;
  const out = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    let gray = Math.round(((pixels[i] - low) / safeWidth) * 255);
    gray = Math.max(0, Math.min(255, gray));
    if (meta.inverted) gray = 255 - gray;
    const at = i * 4;
    out[at] = out[at + 1] = out[at + 2] = gray;
    out[at + 3] = 255;
  }
  return out;
}

function dicomManifestFallback(value: unknown): { series: any[]; reason: string | null } {
  const raw = value && typeof value === "object" ? (value as { series?: unknown }) : {};
  const series = Array.isArray(raw.series) ? raw.series.filter((s) => s && typeof s === "object") : [];
  return { series, reason: series.length ? null : "No displayable DICOM images were indexed for this study." };
}

function dicomOrientationCosines(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  const values = value.trim().split("\\").map(Number);
  if (values.length !== 6 || values.some((item) => !Number.isFinite(item) || Math.abs(item) > 1)) return null;
  return values;
}

function dicomPreviewReason(value: unknown): string {
  const reason = String(value || "")
    .trim()
    .toLowerCase();
  const labels: Record<string, string> = {
    pixel_data_missing: "This item does not contain viewable image pixels.",
    encapsulated_pixel_data: "This compressed image format is not available in the browser viewer.",
    color_or_unsupported_photometric: "This color or specialized image format is not available in the browser viewer.",
    unsupported_bits_allocated: "This pixel depth is not available in the browser viewer.",
    dimensions_out_of_bounds: "This image is too large for the browser viewer.",
    pixel_count_out_of_bounds: "This image is too large for the browser viewer.",
    frame_count_out_of_bounds: "This item has too many frames for the browser viewer.",
    segmentation_or_registration: "This specialized imaging object is preserved but not displayed here.",
    structured_report: "This DICOM report is preserved but does not contain a displayable image here.",
    radiotherapy_object: "This radiotherapy object is preserved but not displayed here.",
    unsupported_sop_class: "This specialized DICOM object is preserved but not displayed here.",
    deflated_transfer_syntax: "This compressed image format is not available in the browser viewer.",
    big_endian_transfer_syntax: "This image encoding is not available in the browser viewer.",
    compressed_or_unsupported_transfer_syntax: "This compressed image format is not available in the browser viewer.",
    invalid_pixel_encoding: "This image encoding is not available in the browser viewer.",
  };
  return labels[reason] || "This image format is preserved but not available in the browser viewer.";
}

function dicomResponseIsCurrent(
  activeToken: number,
  responseToken: number,
  responseSelection: string,
  currentSelection: string,
  connected: boolean
): boolean {
  return connected && activeToken === responseToken && responseSelection === currentSelection;
}

const CAIRN_DICOM_VIEWER_MODEL = {
  dicomWindowPixels,
  dicomManifestFallback,
  dicomOrientationCosines,
  dicomPreviewReason,
  dicomResponseIsCurrent,
};

Object.assign(globalThis, { CairnDicomViewerModel: CAIRN_DICOM_VIEWER_MODEL });
if (typeof window !== "undefined") window.CairnDicomViewerModel = CAIRN_DICOM_VIEWER_MODEL;
