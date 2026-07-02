// Health document lifecycle actions: re-analysis polling, deletion, and cache refresh.
// The row wiring facade lives in health-doc-actions-controller.ts.

type HealthDocLifecycleDocument = import("../contracts/client-api.js").ClientHealthDocument;
type HealthDocLifecyclePictureCache = {
  review?: Record<string, unknown> | null;
  docCount?: number;
  newestDocAt?: string | null;
};

function hdocLifecycleRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function hdocLifecycleNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hdocLifecycleElement<T extends Element = Element>(selector: string): T | null {
  return $<T>(selector);
}

function hdocLifecycleRow(id: string | number): HTMLElement | null {
  return hdocLifecycleElement<HTMLElement>(`#hlist .hdoc[data-hdoc="${id}"]`);
}

function refreshPictureAfterLifecycleHealthDocDelete(deps: ClientHealthDocActionsControllerDeps): void {
  const pictureCache = deps.getHealthPictureCache() as HealthDocLifecyclePictureCache | null;
  const docCount = pictureCache?.docCount || 0;
  if (!pictureCache || docCount <= 0) return;
  pictureCache.docCount = docCount - 1;
  deps.setHealthPictureCache(pictureCache);
  deps.paintHealthPicture();
}

function pollLifecycleHealthDoc(id: string | number, deps: ClientHealthDocActionsControllerDeps): void {
  const numericId = hdocLifecycleNumber(id);
  if (numericId == null || numericId <= 0) return;
  const tab = deps.state.tab;
  const token = deps.pollToken();
  deps.pollEnrichment("/health-docs", numericId, {
    tab,
    token,
    tries: 100,
    interval: 4000,
    onUpdate: (row) => {
      const doc = hdocLifecycleRecord(row) as HealthDocLifecycleDocument;
      if (deps.state.standSeg !== "records") return;
      const el = hdocLifecycleRow(doc.id);
      if (el) {
        el.innerHTML = CairnHealthDocs.healthDocInner(doc);
        deps.wireHealthDoc(el);
      }
      if (doc.enrichment_status === "done") {
        deps.loadHealthDocs();
        deps.loadHealthMarkers(deps.pollToken());
        deps.paintHealthPicture();
      }
    },
  });
}

async function reanalyzeHealthDoc(id: string | number, deps: ClientHealthDocActionsControllerDeps): Promise<void> {
  const row = hdocLifecycleRow(id);
  let updated: unknown = null;
  try {
    updated = await deps.api(`/health-docs/${id}/reanalyze`, { method: "POST" });
  } catch {
    deps.toast("Couldn't start re-analysis");
    return;
  }
  const doc = hdocLifecycleRecord(updated) as HealthDocLifecycleDocument;
  if (!doc.id || doc.error) {
    deps.toast(String(doc.error || "Couldn't re-analyze"));
    return;
  }
  deps.toast("Re-analyzing…");
  if (row) {
    row.innerHTML = CairnHealthDocs.healthDocInner(doc);
    deps.wireHealthDoc(row);
  }
  pollLifecycleHealthDoc(id, deps);
}

function startHealthDocDelete(btn: Element, deps: ClientHealthDocActionsControllerDeps): void {
  const row = btn.closest(".hdoc");
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.hdoc;
  if (!id) return;
  deps.armDelete(btn, () => {
    deps.api(`/health-docs/${id}`, { method: "DELETE" })
      .then(() => {
        deps.toast("Removed");
        row.remove();
        const list = hdocLifecycleElement("#hlist");
        if (list && !list.children.length) list.innerHTML = CairnHealthRecords.recordsEmptyHtml();
        refreshPictureAfterLifecycleHealthDocDelete(deps);
        deps.loadHealthMarkers(deps.pollToken());
      })
      .catch(() => deps.toast("Couldn't remove that — try again."));
  });
}

const CAIRN_HEALTH_DOC_LIFECYCLE_ACTIONS = {
  pollDoc: pollLifecycleHealthDoc,
  reanalyze: reanalyzeHealthDoc,
  refreshPictureAfterDelete: refreshPictureAfterLifecycleHealthDocDelete,
  startDelete: startHealthDocDelete,
};

Object.assign(globalThis, { CairnHealthDocLifecycleActions: CAIRN_HEALTH_DOC_LIFECYCLE_ACTIONS });

if (typeof window !== "undefined") {
  window.CairnHealthDocLifecycleActions = CAIRN_HEALTH_DOC_LIFECYCLE_ACTIONS;
}
