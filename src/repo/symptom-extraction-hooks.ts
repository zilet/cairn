// The repo layer stores the athlete's words; the enrichment engine derives structure
// from them. The repo must not import the engine (src/enrich.ts pulls the whole
// repo barrel, so a direct import is a cycle), so the engine registers itself here
// at startup — the same shape reconciliation-hooks.ts uses.
//
// Unregistered is a valid state: a migration CLI, a test that only exercises storage,
// or an install with enrichment off all keep the verbatim write and simply never
// queue an extraction. Capturing the words is never load-bearing on the agent.

type SymptomExtractionHook = (reportId: number) => void;

let symptomExtractionHook: SymptomExtractionHook | null = null;

export function registerSymptomExtractionHook(hook: SymptomExtractionHook): void {
  symptomExtractionHook = hook;
}

export function requestSymptomExtraction(reportId: number): void {
  if (!symptomExtractionHook) return;
  try {
    symptomExtractionHook(reportId);
  } catch {
    /* the words are already stored; a queue failure must never fail the write */
  }
}
