// Why did an agent's parsed reply fail the op's contract?
//
// `acceptParsed` predicates answer yes/no, which left every `invalid_contract` row in
// agent_runs unexplained. A predicate that knows WHICH check failed calls
// `noteContractRejection(code)`; the rotation (`runAgentWithFallback`) reads it back
// with `takeContractRejection()` and records it. The code is a short machine slug —
// never model prose, never health data. Synchronous and process-local: reset before a
// predicate runs, read straight after, with no await in between.
let pending: string | null = null;

/** Normalise to a short slug of [a-z0-9_:.-]; anything else becomes "_". */
export function contractReasonCode(code: string): string {
  return (
    String(code ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_:.-]/g, "_")
      .slice(0, 60) || "unknown"
  );
}

export function resetContractRejection(): void {
  pending = null;
}

/** Records the FIRST failing check; later notes in the same predicate run are ignored. */
export function noteContractRejection(code: string): void {
  if (pending == null) pending = contractReasonCode(code);
}

export function takeContractRejection(): string | null {
  const code = pending;
  pending = null;
  return code;
}
