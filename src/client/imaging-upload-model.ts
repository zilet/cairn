// Pure state helpers for the imaging upload controller. Files remain in the
// controller closure; session persistence contains only opaque numeric job IDs.

type ImagingUploadRole = "report" | "image" | "mychart" | "dicom";
type ImagingUploadFileLike = { name?: unknown; type?: unknown; size?: unknown };
type ImagingUploadRoute = {
  role: ImagingUploadRole;
  mime: string;
  maxBytes: number;
  accepted: boolean;
  maxLabel: string;
};
type ImagingUploadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ImagingDicomBatchItem = {
  file: File;
  mime: string;
  jobId?: number;
  state?: "queued" | "importing" | "failed" | "status_unknown";
};
type ImagingDicomBatchJob = {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  result?: { study_ids?: number[] };
};

const DICOM_IMPORT_MAX_BYTES = CairnHealthClient.MAX_DICOM_BYTES;
const DICOM_IMPORT_SESSION_KEY = "cairn.dicom-import-jobs.v1";
const DICOM_IMPORT_SESSION_LIMIT = 20;

function imagingUploadRoute(file: ImagingUploadFileLike): ImagingUploadRoute {
  const name = String(file?.name || "")
    .trim()
    .toLowerCase();
  const type = String(file?.type || "")
    .trim()
    .toLowerCase();
  const zip = name.endsWith(".zip") || ["application/zip", "application/x-zip-compressed"].includes(type);
  const dicom = name.endsWith(".dcm") || type === "application/dicom";
  if (zip || dicom) {
    return {
      role: "dicom",
      mime: zip ? "application/zip" : "application/dicom",
      maxBytes: DICOM_IMPORT_MAX_BYTES,
      accepted: Number(file?.size || 0) <= DICOM_IMPORT_MAX_BYTES,
      maxLabel: "256 MiB",
    };
  }
  const mime =
    type ||
    (name.endsWith(".pdf")
      ? "application/pdf"
      : name.endsWith(".png")
        ? "image/png"
        : /\.jpe?g$/.test(name)
          ? "image/jpeg"
          : "application/octet-stream");
  const acceptedMime = /^(image\/(jpeg|png)|application\/pdf)$/i.test(mime);
  return {
    role: name.endsWith(".pdf") || mime === "application/pdf" ? "report" : "image",
    mime,
    maxBytes: CairnHealthClient.MAX_DOC_BYTES,
    accepted: acceptedMime && Number(file?.size || 0) <= CairnHealthClient.MAX_DOC_BYTES,
    maxLabel: "15 MiB",
  };
}

function uniqueDicomStudyIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function imagingUploadStorage(storage?: ImagingUploadStorage): ImagingUploadStorage | null {
  if (storage) return storage;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readActiveDicomJobIds(storage?: ImagingUploadStorage): number[] {
  const target = imagingUploadStorage(storage);
  if (!target) return [];
  try {
    const parsed = JSON.parse(target.getItem(DICOM_IMPORT_SESSION_KEY) || "[]");
    return uniqueDicomStudyIds(parsed).slice(0, DICOM_IMPORT_SESSION_LIMIT);
  } catch {
    return [];
  }
}

function writeActiveDicomJobIds(ids: unknown, storage?: ImagingUploadStorage): number[] {
  const safe = uniqueDicomStudyIds(ids).slice(-DICOM_IMPORT_SESSION_LIMIT);
  const target = imagingUploadStorage(storage);
  if (!target) return safe;
  try {
    if (safe.length) target.setItem(DICOM_IMPORT_SESSION_KEY, JSON.stringify(safe));
    else target.removeItem(DICOM_IMPORT_SESSION_KEY);
  } catch {}
  return safe;
}

function rememberActiveDicomJob(id: number, storage?: ImagingUploadStorage): number[] {
  return writeActiveDicomJobIds([...readActiveDicomJobIds(storage), id], storage);
}

function forgetActiveDicomJob(id: number, storage?: ImagingUploadStorage): number[] {
  return writeActiveDicomJobIds(
    readActiveDicomJobIds(storage).filter((value) => value !== id),
    storage
  );
}

function dicomStudyChoiceLabel(doc: unknown): string {
  const row = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const parsed = row.parsed && typeof row.parsed === "object" ? (row.parsed as Record<string, unknown>) : {};
  const study =
    parsed.imaging_study && typeof parsed.imaging_study === "object"
      ? (parsed.imaging_study as Record<string, unknown>)
      : {};
  const metadata = study.study && typeof study.study === "object" ? (study.study as Record<string, unknown>) : {};
  const anatomy = study.anatomy && typeof study.anatomy === "object" ? (study.anatomy as Record<string, unknown>) : {};
  const values = [
    metadata.study_date || row.doc_date,
    metadata.modality || metadata.raw_modality,
    anatomy.body_region || anatomy.verbatim_site,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => value.replace(/[._]+/g, " "));
  return values.join(" · ") || "Imaging study";
}

function imagingAssociationTarget(
  studyIds: unknown,
  hasOrdinaryFiles: boolean,
  selectedStudyId: unknown
): {
  state: "none" | "ready" | "choose";
  studyId: number | null;
} {
  const ids = uniqueDicomStudyIds(studyIds);
  if (!hasOrdinaryFiles || !ids.length) return { state: "none", studyId: null };
  if (ids.length === 1) return { state: "ready", studyId: ids[0] };
  const selected = Number(selectedStudyId);
  return ids.includes(selected) ? { state: "ready", studyId: selected } : { state: "choose", studyId: null };
}

function imagingAnalysisTargets(studyIds: unknown, hasOrdinaryFiles: boolean, associatedStudyId: unknown): number[] {
  const ids = uniqueDicomStudyIds(studyIds);
  if (!hasOrdinaryFiles) return ids;
  const associated = Number(associatedStudyId);
  return ids.includes(associated) ? [associated] : [];
}

async function processDicomImportBatch(
  items: ImagingDicomBatchItem[],
  deps: {
    start(item: ImagingDicomBatchItem): Promise<ImagingDicomBatchJob>;
    wait(id: number): Promise<ImagingDicomBatchJob>;
    remember(id: number): void;
    forget(id: number): void;
    onState(item: ImagingDicomBatchItem): void;
    onDone(item: ImagingDicomBatchItem): void;
  }
): Promise<{ ok: boolean; reason: "done" | "failed" | "status_unknown" | "start_failed"; studyIds: number[] }> {
  const studyIds: number[] = [];
  for (const item of items) {
    try {
      if (!item.jobId) {
        item.state = "importing";
        deps.onState(item);
        const created = await deps.start(item);
        if (!Number.isInteger(created.id) || created.id <= 0) throw new Error("missing job id");
        item.jobId = created.id;
        deps.remember(created.id);
        deps.onState(item);
      }
      const job = await deps.wait(item.jobId);
      deps.forget(item.jobId);
      item.jobId = undefined;
      if (job.status === "failed") {
        item.state = "failed";
        deps.onState(item);
        return { ok: false, reason: "failed", studyIds: uniqueDicomStudyIds(studyIds) };
      }
      studyIds.push(...uniqueDicomStudyIds(job.result?.study_ids));
      deps.onDone(item);
    } catch {
      const active = !!item.jobId;
      item.state = active ? "status_unknown" : "failed";
      deps.onState(item);
      return {
        ok: false,
        reason: active ? "status_unknown" : "start_failed",
        studyIds: uniqueDicomStudyIds(studyIds),
      };
    }
  }
  return { ok: true, reason: "done", studyIds: uniqueDicomStudyIds(studyIds) };
}

const CAIRN_IMAGING_UPLOAD_MODEL = {
  DICOM_IMPORT_MAX_BYTES,
  DICOM_IMPORT_SESSION_KEY,
  imagingUploadRoute,
  uniqueDicomStudyIds,
  readActiveDicomJobIds,
  writeActiveDicomJobIds,
  rememberActiveDicomJob,
  forgetActiveDicomJob,
  dicomStudyChoiceLabel,
  imagingAssociationTarget,
  imagingAnalysisTargets,
  processDicomImportBatch,
};

Object.assign(globalThis, { CairnImagingUploadModel: CAIRN_IMAGING_UPLOAD_MODEL });
if (typeof window !== "undefined") window.CairnImagingUploadModel = CAIRN_IMAGING_UPLOAD_MODEL;
