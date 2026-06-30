// @ts-check
// Today Garmin strength-session reconciliation wiring.

type ClientGarminReconcileResponse = import("../contracts/client-api.js").ClientGarminReconcileResponse;
type TodayGarminReconcileApi = (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;

type TodayGarminReconcileOptions = {
  root: ParentNode | null | undefined;
  date: string;
  isCurrentToday: () => boolean;
  api: TodayGarminReconcileApi;
  escapeHtml: (value: unknown) => string;
  toast: (message: string) => void;
  invalidate: (key: string) => void;
  refreshToday: (options: { soft: boolean }) => unknown;
};

(() => {
  function reconcilePromptHtml(count: number, escapeHtml: (value: unknown) => string): string {
    const noun = count === 1 ? "a lift" : `${count} lifts`;
    return `<div class="garmin-reconcile chip-in">
      <div class="garmin-reconcile-text">
        <span class="garmin-reconcile-glyph" aria-hidden="true">✦</span>
        <span>Garmin logged ${escapeHtml(noun)} that ${count === 1 ? "isn't" : "aren't"} in Cairn yet</span>
      </div>
      <button class="garmin-reconcile-btn" id="garminReconcileGo" type="button">Reconcile</button>
    </div>`;
  }

  function reconciledToast(count: unknown): string {
    return count === 1 ? "Reconciled the Garmin lift" : `Reconciled ${count || 0} Garmin lifts`;
  }

  async function load(options: TodayGarminReconcileOptions): Promise<void> {
    const slot = options.root?.querySelector("#garminReconcileSlot");
    if (!slot) return;
    let rows: unknown = [];
    try { rows = await options.api("/garmin/unreconciled"); } catch { rows = []; }
    if (!options.isCurrentToday() || !slot.isConnected) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) { slot.innerHTML = ""; return; }
    slot.innerHTML = reconcilePromptHtml(list.length, options.escapeHtml);
    const btn = slot.querySelector<HTMLButtonElement>("#garminReconcileGo");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Reconciling…";
      let result: unknown;
      try {
        result = await options.api("/garmin/reconcile", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
        });
      } catch {
        btn.disabled = false; btn.textContent = "Reconcile";
        options.toast("Couldn't reconcile — check your connection");
        return;
      }
      const response = result && typeof result === "object" ? result as Partial<ClientGarminReconcileResponse> & { error?: unknown } : null;
      if (!response || response.error) {
        btn.disabled = false; btn.textContent = "Reconcile";
        options.toast("Couldn't reconcile right now");
        return;
      }
      options.toast(reconciledToast(response.reconciled));
      options.invalidate("today:session:" + options.date);
      options.refreshToday({ soft: true });
    });
  }

  const CAIRN_TODAY_GARMIN_RECONCILIATION = {
    load,
  };

  Object.assign(globalThis, { CairnTodayGarminReconciliation: CAIRN_TODAY_GARMIN_RECONCILIATION });

  if (typeof window !== "undefined") {
    window.CairnTodayGarminReconciliation = CAIRN_TODAY_GARMIN_RECONCILIATION;
  }
})();
