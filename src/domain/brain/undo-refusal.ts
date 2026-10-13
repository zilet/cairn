// An Undo refusal the athlete reads. The PWA toasts an Undo's `error` as it stands, so
// anything thrown during an Undo is either one of these — said in the athlete's words —
// or an engineering fault, which revertDecision logs and answers in plain words instead.
// A leaf module (no imports) so every module with an ownership-guarded revert can use it.
export class UndoRefusal extends Error {}

export const UNDO_UNAVAILABLE = "This change can no longer be undone.";
export const UNDO_NOT_NOW = "This change couldn't be undone just now, so nothing was changed.";
