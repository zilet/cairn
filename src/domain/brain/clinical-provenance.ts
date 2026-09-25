// The server-owned clinical mark the chat detector (or its lineage onto a follow-up
// draft) put on a proposal; null for anything else. Shared by the autonomy routing and
// the thaw's re-reads.
export function serverClinicalProvenance(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provenance = value as Record<string, unknown>;
  return provenance.server_owned === true &&
    (provenance.source === "chat_clinical_detection" || provenance.source === "chat_clinical_lineage")
    ? provenance
    : null;
}
