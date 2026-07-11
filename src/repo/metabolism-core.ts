export interface MeasuredRmrReading {
  kcal: number;
  date: string | null;
  source: string;
  document_id?: number | null;
}

function plausibleRmr(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed < 700 || parsed > 5_000) return null;
  return Math.round(parsed);
}

function markerRmr(parsed: any): number | null {
  const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
  for (const marker of markers) {
    const name = String(marker?.name ?? marker?.marker ?? "");
    if (!/\b(?:measured\s+)?(?:resting\s+metabolic\s+rate|rmr)\b/i.test(name)) continue;
    if (/predicted|estimate/i.test(name)) continue;
    const value = plausibleRmr(marker?.value);
    if (value != null) return value;
  }
  return null;
}

export function extractMeasuredRmr(row: any): MeasuredRmrReading | null {
  let parsed = row?.parsed_json ?? row?.parsed ?? null;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const markerValue = markerRmr(parsed);
  const text = `${row?.summary ?? ""} ${parsed?.summary ?? ""}`;
  const match = /(?:measured\s+)?(?:resting\s+metabolic\s+rate|rmr)[^\d]{0,80}([\d,]{3,5})\s*(?:kcal|calories)/i.exec(
    text
  );
  const kcal = markerValue ?? plausibleRmr(match?.[1]);
  if (kcal == null) return null;
  return {
    kcal,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(row?.doc_date ?? "")) ? String(row.doc_date) : null,
    source: String(row?.kind || "metabolic_test").slice(0, 80),
    document_id: Number.isFinite(Number(row?.id)) ? Number(row.id) : null,
  };
}
