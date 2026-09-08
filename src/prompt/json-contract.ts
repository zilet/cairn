// The non-streaming JSON output contract — the ONE canonical "return only JSON"
// preamble every prompt builder leads its schema with.
//
// It lives in its own LEAF module rather than in `./shared.js` because
// `src/symptomCapture.ts` needs it: shared.ts imports half of `src/repo`, so importing
// it from a module the repo cluster imports back dragged both into the server's
// largest strongly-connected component. This file imports NOTHING — keep it that way.
// `./shared.js` re-exports it, so every existing importer is unchanged.

// The non-streaming counterpart to renderStreamingContract: ONE canonical "return
// only JSON" preamble. ~25 hand-written variants had drifted into two wordings ("no
// fences" vs the stricter "ONE bare JSON object only — no markdown fences"), so the
// bar an op set depended on which builder its author copied. The strictest wording
// wins here. Op-specific clauses are options rather than a reason to hand-write the
// preamble again: `note` extends the contract sentence, `lead` introduces the schema
// (an alternative "nothing to say" answer), `after` follows it.
export function renderJsonContract(
  schema: string,
  opts: { note?: string; lead?: string; after?: string } = {}
): string {
  const note = opts.note ? ` ${opts.note.trim()}` : "";
  const lead = opts.lead ? `\n${opts.lead.trim()}` : "";
  const after = opts.after ? `\n${opts.after.trim()}` : "";
  return `OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences.${note}${lead}
${schema}${after}`;
}
