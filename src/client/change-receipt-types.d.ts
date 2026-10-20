// The change receipt (src/contracts/change-receipt.ts), as the client reads it: the contract
// type itself. A renderer still reads it defensively — a receipt without `what` or `key` draws nothing.
type ClientChangeReceipt = import("../contracts/change-receipt.js").ChangeReceipt;
declare const CairnChangeReceipt: {
  /** The receipt rows of one reply or one feed change; "" when there are none to draw. */
  listHtml(receipts: unknown, options?: { readonly?: boolean }): string;
  /** Wire Undo on `host` (delegated, idempotent per host). Returns the teardown. */
  mount(host: Element): () => void;
};
