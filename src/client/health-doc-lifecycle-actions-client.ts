// Health document lifecycle actions: re-analysis polling, deletion, and cache refresh.
// The row wiring facade lives in health-doc-actions-controller.ts.

type HealthDocLifecycleDocument = import("../contracts/client-api.js").ClientHealthDocument;
type HealthDocLifecyclePictureCache = {
  review?: Record<string, unknown> | null;
  docCount?: number;
  newestDocAt?: string | null;
};

function hdocLifecycleRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
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

// The card that stands for a hidden source upload (an imaging study read out of
// a pasted report) — the source has no row of its own to find by id.
function hdocLifecycleHostRow(sourceId: string | number): HTMLElement | null {
  return hdocLifecycleElement<HTMLElement>(`#hlist .hdoc[data-hsource="${sourceId}"]`);
}

// A re-rendered study card keeps standing for the hidden source it stood for.
function hdocCarriedSource(row: HTMLElement | null): ClientImagingCardOptions {
  const sourceId = Number(row?.dataset.hsource);
  return Number.isFinite(sourceId) && sourceId > 0
    ? { source: { id: sourceId, has_file: true }, sourceHidden: true }
    : {};
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
        if (doc.kind === "imaging" && CairnImaging.imagingStudy(doc)) {
          el.outerHTML = CairnImaging.imagingCard(doc, undefined, hdocCarriedSource(el));
          deps.wireHealthDoc(hdocLifecycleRow(doc.id));
        } else {
          el.innerHTML = CairnHealthDocs.healthDocInner(doc);
          deps.wireHealthDoc(el);
        }
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
  const host = row ? null : hdocLifecycleHostRow(id);
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
    if (doc.kind === "imaging" && CairnImaging.imagingStudy(doc)) {
      row.outerHTML = CairnImaging.imagingCard(doc, undefined, hdocCarriedSource(row));
      deps.wireHealthDoc(hdocLifecycleRow(doc.id));
    } else {
      row.innerHTML = CairnHealthDocs.healthDocInner(doc);
      deps.wireHealthDoc(row);
    }
  } else if (host) {
    // The source re-reads behind its study's card: repaint so the card says so
    // (and watches the source) instead of looking untouched for minutes.
    swrInvalidate("health:records");
    void deps.loadHealthDocs();
    return;
  }
  pollLifecycleHealthDoc(id, deps);
}

function startHealthDocDelete(btn: Element, deps: ClientHealthDocActionsControllerDeps): void {
  const row = btn.closest(".hdoc");
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.hdoc;
  if (!id) return;
  deps.armDelete(btn, () => {
    // A study card standing for a hidden source upload: when it is that source's
    // last card, delete the SOURCE — the study goes with it — so no orphan paste
    // surfaces as a card of its own on the next paint.
    const sourceId = row.dataset.hsource;
    const cards = hdocLifecycleElement("#hlist")?.querySelectorAll(`.hdoc[data-hsource="${sourceId}"]`).length ?? 0;
    const lastOfSource = !!sourceId && cards <= 1;
    const target = lastOfSource ? sourceId : id;
    deps
      .api(`/health-docs/${target}`, { method: "DELETE" })
      .then(() => {
        deps.toast("Removed");
        row.remove();
        swrInvalidate("health:records"); // keep the cached-first Records paint honest
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
