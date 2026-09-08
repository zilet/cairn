// Frozen snapshot of src/repo/metabolism-core.ts#extractMeasuredRmr as of 2026-09-08 (commit 456211f0); migrations must not track live code.
//
// WHY A COPY AND NOT AN IMPORT. A migration is a statement about what the ladder did
// on the day it shipped. Importing the live module means a fresh install replays that
// migration against TODAY's semantics — a silently different repair from the one every
// existing database received. The live module stays free to evolve; this snapshot does
// not. Do not "fix" a bug here: fix it in the live module and, if old rows need it,
// append a NEW migration.
//
// DO NOT REFORMAT. This file is a verbatim copy; a formatter reflowing it would
// break the one property that makes it auditable — that every line still matches
// the live source it was taken from.

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
