// Types for the welcome's first week outside the welcome (first-week-client.ts, EAGER).

type FirstWeekStatus = import("../contracts/client-api.js").ClientFirstWeekStatus;

type FirstWeekApi = {
  /** The card's slot for a surface's markup (Today, Train): filled from what is known now. */
  slotHtml(): string;
  /** A welcome week is being composed right now (as far as this page knows). */
  building(): boolean;
  /** Start (or resume) following the welcome's week: the person left the welcome mid-week. */
  track(): void;
  /** The welcome itself showed the week landing: the one-shot notice is said. */
  seen(): void;
  /** The week landed: drop the caches it makes stale and repaint Today/Train if showing. */
  landed(): void;
  /** Re-read the status now (tests, and a surface that knows something moved). */
  refresh(): Promise<void>;
};
