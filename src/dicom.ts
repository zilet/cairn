import crypto from "node:crypto";
import dicomParser, { type DataSet } from "dicom-parser";
import { PNG } from "pngjs";

export const DICOM_LIMITS = Object.freeze({
  archiveBytes: 256 * 1024 * 1024,
  entries: 4096,
  entryBytes: 64 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  compressionRatio: 250,
  instancesPerStudy: 4096,
  studyBytes: 512 * 1024 * 1024,
  frames: 512,
  dimension: 4096,
  pixelsPerFrame: 16_777_216,
});

const TS_IMPLICIT_LE = "1.2.840.10008.1.2";
const TS_EXPLICIT_LE = "1.2.840.10008.1.2.1";
const CLASSIC_IMAGE_SOPS = new Set([
  "1.2.840.10008.5.1.4.1.1.1", // CR
  "1.2.840.10008.5.1.4.1.1.1.1", // DX presentation
  "1.2.840.10008.5.1.4.1.1.1.1.1", // DX processing
  "1.2.840.10008.5.1.4.1.1.1.2", // mammography presentation
  "1.2.840.10008.5.1.4.1.1.1.2.1", // mammography processing
  "1.2.840.10008.5.1.4.1.1.1.3", // intra-oral presentation
  "1.2.840.10008.5.1.4.1.1.1.3.1", // intra-oral processing
  "1.2.840.10008.5.1.4.1.1.2", // CT
  "1.2.840.10008.5.1.4.1.1.3.1", // ultrasound multiframe
  "1.2.840.10008.5.1.4.1.1.4", // MR
  "1.2.840.10008.5.1.4.1.1.6.1", // ultrasound
  "1.2.840.10008.5.1.4.1.1.7", // secondary capture
  "1.2.840.10008.5.1.4.1.1.7.1", // multiframe single-bit SC
  "1.2.840.10008.5.1.4.1.1.7.2", // multiframe grayscale byte SC
  "1.2.840.10008.5.1.4.1.1.7.3", // multiframe grayscale word SC
  "1.2.840.10008.5.1.4.1.1.12.1", // XA
  "1.2.840.10008.5.1.4.1.1.12.2", // XRF
  "1.2.840.10008.5.1.4.1.1.20", // nuclear medicine
  "1.2.840.10008.5.1.4.1.1.128", // PET
]);
const SPECIAL_SOP_REASONS: Array<[RegExp, string]> = [
  [/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.66/, "segmentation_or_registration"],
  [/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.88/, "structured_report"],
  [/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.481/, "radiotherapy_object"],
  [/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.104/, "encapsulated_document"],
  [/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.11/, "presentation_state"],
  [/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.(?:2\.1|4\.[123]|6\.2|12\.[12]\.1|13\.[12])$/, "enhanced_multiframe"],
];

export class DicomImportError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "DicomImportError";
  }
}

export interface ParsedDicomInstance {
  dataSet: DataSet;
  bytes: Buffer;
  sha256: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopClassUid: string;
  sopInstanceUid: string;
  transferSyntaxUid: string;
  patientId: string | null;
  modality: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  seriesDescription: string | null;
  seriesNumber: number | null;
  instanceNumber: number | null;
  frames: number;
  rows: number | null;
  columns: number | null;
  samplesPerPixel: number | null;
  photometricInterpretation: string | null;
  bitsAllocated: number | null;
  bitsStored: number | null;
  highBit: number | null;
  pixelRepresentation: number | null;
  planarConfiguration: number | null;
  rescaleSlope: number | null;
  rescaleIntercept: number | null;
  windowCenter: number | null;
  windowWidth: number | null;
  pixelSpacing: string | null;
  imagePosition: string | null;
  imageOrientation: string | null;
  sliceLocation: number | null;
  frameOfReferenceUid: string | null;
  bodyPart: string | null;
  laterality: string | null;
  burnedInAnnotation: string | null;
  sourceDeidentificationClaim: string | null;
  previewSupportReason: string | null;
}

function clean(ds: DataSet, tag: string, max = 256): string | null {
  const value = ds.string(tag)?.replace(/\0/g, "").trim();
  return value ? value.slice(0, max) : null;
}

function integer(ds: DataSet, tag: string): number | null {
  const value = ds.uint16(tag) ?? ds.intString(tag);
  return Number.isInteger(value) ? Number(value) : null;
}

function decimal(ds: DataSet, tag: string): number | null {
  const value = ds.floatString(tag);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dicomDate(raw: string | null): string | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function safeVector(ds: DataSet, tag: string, count: number): string | null {
  const raw = clean(ds, tag, 256);
  if (!raw) return null;
  const values = raw.split("\\").map(Number);
  if (values.length !== count || values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e9)) return null;
  return values.join("\\");
}

function previewReason(
  meta: Omit<ParsedDicomInstance, "previewSupportReason" | "bytes" | "dataSet" | "sha256">,
  ds: DataSet
): string | null {
  const special = SPECIAL_SOP_REASONS.find(([pattern]) => pattern.test(meta.sopClassUid));
  if (special) return special[1];
  if (!CLASSIC_IMAGE_SOPS.has(meta.sopClassUid)) return "unsupported_sop_class";
  if (meta.transferSyntaxUid === "1.2.840.10008.1.2.1.99") return "deflated_transfer_syntax";
  if (meta.transferSyntaxUid === "1.2.840.10008.1.2.2") return "big_endian_transfer_syntax";
  if (meta.transferSyntaxUid !== TS_IMPLICIT_LE && meta.transferSyntaxUid !== TS_EXPLICIT_LE)
    return "compressed_or_unsupported_transfer_syntax";
  if (!ds.elements.x7fe00010) return "pixel_data_missing";
  if (ds.elements.x7fe00010.encapsulatedPixelData) return "encapsulated_pixel_data";
  if (meta.samplesPerPixel !== 1 || !/^MONOCHROME[12]$/.test(meta.photometricInterpretation ?? ""))
    return "color_or_unsupported_photometric";
  if (meta.bitsAllocated !== 8 && meta.bitsAllocated !== 16) return "unsupported_bits_allocated";
  if (
    meta.bitsStored == null ||
    meta.bitsStored < 1 ||
    meta.bitsStored > meta.bitsAllocated ||
    meta.highBit !== meta.bitsStored - 1 ||
    (meta.pixelRepresentation !== 0 && meta.pixelRepresentation !== 1)
  )
    return "invalid_pixel_encoding";
  if (!meta.rows || !meta.columns || meta.rows > DICOM_LIMITS.dimension || meta.columns > DICOM_LIMITS.dimension)
    return "dimensions_out_of_bounds";
  if (meta.rows * meta.columns > DICOM_LIMITS.pixelsPerFrame) return "pixel_count_out_of_bounds";
  if (meta.frames < 1 || meta.frames > DICOM_LIMITS.frames) return "frame_count_out_of_bounds";
  return null;
}

export function hasPart10Preamble(bytes: Uint8Array): boolean {
  return bytes.length >= 132 && Buffer.from(bytes.buffer, bytes.byteOffset + 128, 4).toString("ascii") === "DICM";
}

export function isValidDicomUid(value: unknown): value is string {
  const uid = String(value ?? "");
  if (!uid || uid.length > 64 || !/^\d+(?:\.\d+)*$/.test(uid)) return false;
  return uid.split(".").every((component) => component === "0" || !component.startsWith("0"));
}

export function parseDicomPart10(input: Uint8Array): ParsedDicomInstance {
  if (!hasPart10Preamble(input)) throw new DicomImportError("invalid_part10");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let ds: DataSet;
  try {
    ds = dicomParser.parseDicom(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new DicomImportError("invalid_dicom");
  }
  const transferSyntaxUid = clean(ds, "x00020010", 128);
  const studyInstanceUid = clean(ds, "x0020000d", 128);
  const seriesInstanceUid = clean(ds, "x0020000e", 128);
  const sopClassUid = clean(ds, "x00080016", 128) ?? clean(ds, "x00020002", 128);
  const sopInstanceUid = clean(ds, "x00080018", 128) ?? clean(ds, "x00020003", 128);
  if (!transferSyntaxUid || !studyInstanceUid || !seriesInstanceUid || !sopClassUid || !sopInstanceUid)
    throw new DicomImportError("missing_required_identity");
  if (![transferSyntaxUid, studyInstanceUid, seriesInstanceUid, sopClassUid, sopInstanceUid].every(isValidDicomUid))
    throw new DicomImportError("invalid_uid");
  const rawStudyDate = clean(ds, "x00080020", 16);
  const studyDate = dicomDate(rawStudyDate);
  if (rawStudyDate && !studyDate) throw new DicomImportError("invalid_study_date");
  const base = {
    studyInstanceUid,
    seriesInstanceUid,
    sopClassUid,
    sopInstanceUid,
    transferSyntaxUid,
    patientId: clean(ds, "x00100020", 128),
    modality: clean(ds, "x00080060", 40),
    studyDate,
    studyDescription: clean(ds, "x00081030", 240),
    seriesDescription: clean(ds, "x0008103e", 240),
    seriesNumber: ds.intString("x00200011") ?? null,
    instanceNumber: ds.intString("x00200013") ?? null,
    frames: Math.max(1, ds.intString("x00280008") ?? 1),
    rows: integer(ds, "x00280010"),
    columns: integer(ds, "x00280011"),
    samplesPerPixel: integer(ds, "x00280002"),
    photometricInterpretation: clean(ds, "x00280004", 40)?.toUpperCase() ?? null,
    bitsAllocated: integer(ds, "x00280100"),
    bitsStored: integer(ds, "x00280101"),
    highBit: integer(ds, "x00280102"),
    pixelRepresentation: integer(ds, "x00280103"),
    planarConfiguration: integer(ds, "x00280006"),
    rescaleSlope: decimal(ds, "x00281053"),
    rescaleIntercept: decimal(ds, "x00281052"),
    windowCenter: decimal(ds, "x00281050"),
    windowWidth: decimal(ds, "x00281051"),
    pixelSpacing: safeVector(ds, "x00280030", 2),
    imagePosition: safeVector(ds, "x00200032", 3),
    imageOrientation: safeVector(ds, "x00200037", 6),
    sliceLocation: decimal(ds, "x00201041"),
    frameOfReferenceUid: clean(ds, "x00200052", 128),
    bodyPart: clean(ds, "x00180015", 80),
    laterality: clean(ds, "x00200062", 16) ?? clean(ds, "x00200060", 16),
    burnedInAnnotation: clean(ds, "x00280301", 16),
    sourceDeidentificationClaim: clean(ds, "x00120062", 16),
  };
  if (base.frameOfReferenceUid && !isValidDicomUid(base.frameOfReferenceUid)) throw new DicomImportError("invalid_uid");
  return {
    ...base,
    dataSet: ds,
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    previewSupportReason: previewReason(base, ds),
  };
}

export interface DecodedDicomFrame {
  pixels: Float32Array;
  rows: number;
  columns: number;
  windowCenter: number;
  windowWidth: number;
  inverted: boolean;
  rescaleSlope: number;
  rescaleIntercept: number;
}

export function decodeDicomFrame(instance: ParsedDicomInstance, frameIndex: number): DecodedDicomFrame {
  if (instance.previewSupportReason) throw new DicomImportError(instance.previewSupportReason);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= instance.frames)
    throw new DicomImportError("frame_out_of_bounds");
  const rows = instance.rows!;
  const columns = instance.columns!;
  const samples = rows * columns;
  const bytesPerPixel = instance.bitsAllocated! / 8;
  const element = instance.dataSet.elements.x7fe00010;
  const start = element.dataOffset + frameIndex * samples * bytesPerPixel;
  const end = start + samples * bytesPerPixel;
  if (start < 0 || end > instance.bytes.length || end > element.dataOffset + element.length)
    throw new DicomImportError("truncated_pixel_data");
  const bitsStored = instance.bitsStored!;
  const highBit = instance.highBit!;
  const lowBit = Math.max(0, highBit - bitsStored + 1);
  const mask = bitsStored === 16 ? 0xffff : (1 << bitsStored) - 1;
  const sign = 1 << (bitsStored - 1);
  const signRange = 2 ** bitsStored;
  const slope = instance.rescaleSlope ?? 1;
  const intercept = instance.rescaleIntercept ?? 0;
  const out = new Float32Array(samples);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    const offset = start + i * bytesPerPixel;
    let value = bytesPerPixel === 1 ? instance.bytes[offset] : instance.bytes.readUInt16LE(offset);
    value = (value >>> lowBit) & mask;
    if (instance.pixelRepresentation === 1 && (value & sign) !== 0) value -= signRange;
    const scaled = value * slope + intercept;
    out[i] = scaled;
    min = Math.min(min, scaled);
    max = Math.max(max, scaled);
  }
  const suppliedWidth = instance.windowWidth;
  const width = suppliedWidth && suppliedWidth > 0 ? suppliedWidth : Math.max(1, max - min);
  const center = instance.windowCenter ?? (min + max) / 2;
  return {
    pixels: out,
    rows,
    columns,
    windowCenter: center,
    windowWidth: width,
    inverted: instance.photometricInterpretation === "MONOCHROME1",
    rescaleSlope: slope,
    rescaleIntercept: intercept,
  };
}

export function dicomFramePng(frame: DecodedDicomFrame, maxEdge = 1024): Buffer {
  const scale = Math.min(1, maxEdge / Math.max(frame.columns, frame.rows));
  const width = Math.max(1, Math.round(frame.columns * scale));
  const height = Math.max(1, Math.round(frame.rows * scale));
  const png = new PNG({ width, height });
  const low = frame.windowCenter - frame.windowWidth / 2;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(frame.rows - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.columns - 1, Math.floor(x / scale));
      const raw = frame.pixels[sy * frame.columns + sx];
      let gray = Math.max(0, Math.min(255, Math.round(((raw - low) / frame.windowWidth) * 255)));
      if (frame.inverted) gray = 255 - gray;
      const offset = (y * width + x) * 4;
      png.data[offset] = gray;
      png.data[offset + 1] = gray;
      png.data[offset + 2] = gray;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png, { colorType: 6 });
}
