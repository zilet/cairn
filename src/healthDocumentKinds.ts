export const HEALTH_DOCUMENT_KINDS = ["bloodwork", "dexa", "ecg", "other"] as const;

export type HealthDocumentKind = (typeof HEALTH_DOCUMENT_KINDS)[number];

const HEALTH_DOCUMENT_KIND_SET = new Set<string>(HEALTH_DOCUMENT_KINDS);

export const HEALTH_DOCUMENT_KIND_SCHEMA = HEALTH_DOCUMENT_KINDS.join("|");

export function isHealthDocumentKind(value: unknown): value is HealthDocumentKind {
  return typeof value === "string" && HEALTH_DOCUMENT_KIND_SET.has(value);
}

export function normalizeHealthDocumentKind(value: unknown): HealthDocumentKind {
  return isHealthDocumentKind(value) ? value : "other";
}
