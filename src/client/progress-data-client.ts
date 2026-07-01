// @ts-check
// Shared Progress data normalization helpers.

function progressDataIsRecord(value: unknown): value is ProgressRecord {
  return !!value && typeof value === "object";
}

function progressDataRecord(value: unknown): ProgressRecord {
  return progressDataIsRecord(value) ? value : {};
}

function progressDataRows<T extends ProgressRecord = ProgressRecord>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(progressDataIsRecord) as T[]) : [];
}

function progressDataString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function progressDataNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const CAIRN_PROGRESS_DATA = {
  isRecord: progressDataIsRecord,
  record: progressDataRecord,
  rows: progressDataRows,
  string: progressDataString,
  number: progressDataNumber,
};

Object.assign(globalThis, {
  CairnProgressData: CAIRN_PROGRESS_DATA,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressData: CAIRN_PROGRESS_DATA,
  });
}
