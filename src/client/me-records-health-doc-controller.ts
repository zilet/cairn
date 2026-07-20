// Health Records controller: list loading, upload handoff, and deep-link scrolling.
// Rendering primitives stay in health-records-client.ts and health-docs-client.ts;
// per-row document actions live in health-doc-actions-controller.ts.

type HealthDocument = import("../contracts/client-api.js").ClientHealthDocument;

type HealthRecordsState = {
  tab?: string;
  standSeg?: string | null;
  pendingHealthDocId?: string | number | null;
};

type HealthRecordsPictureCache = {
  review?: Record<string, unknown> | null;
  docCount?: number;
  newestDocAt?: string | null;
};

type HealthRecordsControllerDeps = {
  state: HealthRecordsState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  toast(message: string): void;
  armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
  pollEnrichment(
    path: string,
    id: number,
    options?: {
      tab?: string;
      token?: unknown;
      tries?: number;
      interval?: number;
      onUpdate?: (row: Record<string, unknown>) => void;
    },
  ): unknown;
  enrichmentActive(status: unknown): boolean;
  pollToken(): number;
  loadHealthMarkers(token: number): void;
  paintHealthPicture(): void;
  getHealthPictureCache(): HealthRecordsPictureCache | null;
  setHealthPictureCache(cache: HealthRecordsPictureCache | null): HealthRecordsPictureCache | null;
};

function hrecRows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") as T[] : [];
}

function hrecElement<T extends Element = Element>(selector: string): T | null {
  return $<T>(selector);
}

function healthDocUploadDeps(deps: HealthRecordsControllerDeps): ClientHealthDocUploadControllerDeps {
  return {
    api: deps.api,
    toast: deps.toast,
    enrichmentActive: deps.enrichmentActive,
    pollDoc: (id) => pollHealthDoc(id, deps),
    wireDoc: (el) => wireHealthDoc(el, deps),
    getHealthPictureCache: deps.getHealthPictureCache,
    setHealthPictureCache: deps.setHealthPictureCache,
    paintHealthPicture: deps.paintHealthPicture,
  };
}

function healthDocActionsDeps(deps: HealthRecordsControllerDeps): ClientHealthDocActionsControllerDeps {
  return {
    state: deps.state,
    api: deps.api,
    toast: deps.toast,
    armDelete: deps.armDelete,
    pollEnrichment: deps.pollEnrichment,
    pollToken: deps.pollToken,
    loadHealthMarkers: deps.loadHealthMarkers,
    paintHealthPicture: deps.paintHealthPicture,
    loadHealthDocs: () => loadHealthDocs(deps),
    wireHealthDoc: (el) => wireHealthDoc(el, deps),
    getHealthPictureCache: deps.getHealthPictureCache,
    setHealthPictureCache: deps.setHealthPictureCache,
  };
}

function wireHealthUpload(deps: HealthRecordsControllerDeps): void {
  CairnHealthDocUploadController.wireUpload(healthDocUploadDeps(deps));
}

function wireHealthDoc(el: HTMLElement | null, deps: HealthRecordsControllerDeps): void {
  if (el?.classList.contains("imaging-card")) {
    const id = Number(el.dataset.hdoc);
    void deps.api(`/health-docs/${id}`).then((doc) => {
      if (!doc || typeof doc !== "object") return;
      CairnImaging.wireImaging(doc as HealthDocument, el, { api: deps.api, toast: deps.toast, refresh: () => { swrInvalidate(RECORDS_CACHE_KEY); void loadHealthDocs(deps); deps.paintHealthPicture(); } });
    });
  }
  CairnHealthDocActionsController.wireDoc(el, healthDocActionsDeps(deps));
}

function pollHealthDoc(id: string | number, deps: HealthRecordsControllerDeps): void {
  CairnHealthDocActionsController.pollDoc(id, healthDocActionsDeps(deps));
}

// Health records are personal data — cache them MEMORY-ONLY (the `health:` prefix
// keeps them out of localStorage) so the list paints instantly WITHIN a session
// (no cold-gate behind a skeleton) but never lands on disk.
const RECORDS_CACHE_KEY = "health:records";

function renderHealthDocs(deps: HealthRecordsControllerDeps, docs: HealthDocument[]): void {
  const wrap = hrecElement("#hlist");
  if (!wrap) return;
  // Records is hosted by the Stand tab; bail if the athlete navigated away.
  if (deps.state.tab !== "stand" || deps.state.standSeg !== "records" || !wrap.isConnected) return;
  if (!docs.length) {
    wrap.innerHTML = CairnHealthRecords.recordsEmptyHtml();
    return;
  }
  wrap.innerHTML = CairnHealthRecords.recordsListHtml(docs);
  wrap.querySelectorAll<HTMLElement>(".hdoc").forEach((el) => {
    wireHealthDoc(el, deps);
    if (el.dataset.hdoc && el.querySelector(".enr-pending")) pollHealthDoc(Number(el.dataset.hdoc), deps);
  });
  if (deps.state.pendingHealthDocId) {
    const wanted = String(deps.state.pendingHealthDocId);
    const target = [...wrap.querySelectorAll<HTMLElement>(".hdoc[data-hdoc]")]
      .find((el) => el.dataset.hdoc === wanted);
    // Only consume the deep-link once the target actually renders — so a warm cached
    // paint that predates a just-uploaded doc keeps it for the revalidated paint.
    if (target) {
      deps.state.pendingHealthDocId = null;
      target.classList.remove("hdoc-collapsed");
      try {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      } catch {
        target.scrollIntoView();
      }
    }
  }
}

async function loadHealthDocs(deps: HealthRecordsControllerDeps): Promise<HealthDocument[]> {
  const wrap = hrecElement("#hlist");
  if (!wrap) return [];
  const peek = peekCached<HealthDocument[]>(RECORDS_CACHE_KEY);
  if (peek) renderHealthDocs(deps, hrecRows<HealthDocument>(peek.data));

  let docs: HealthDocument[] = [];
  let fetched = false;
  try {
    docs = hrecRows<HealthDocument>(await deps.api("/health-docs"));
    fetched = true;
  } catch {
    docs = [];
  }
  if (!fetched) return peek ? hrecRows<HealthDocument>(peek.data) : [];
  swrSet(RECORDS_CACHE_KEY, docs);
  try {
    localStorage.setItem("cairn:healthDocCount", String(docs.length));
  } catch {}
  // Re-paint only when the payload changed, so a no-op revalidate never disturbs an
  // in-flight enrichment poll or the user's scroll.
  if (!peek || JSON.stringify(peek.data) !== JSON.stringify(docs)) renderHealthDocs(deps, docs);
  return docs;
}

function renderHealthRecords(deps: HealthRecordsControllerDeps): Promise<HealthDocument[]> {
  const content = hrecElement("#hContent");
  if (!content) return Promise.resolve([]);
  content.innerHTML = CairnHealthRecords.recordsTabHtml();
  wireHealthUpload(deps);
  return loadHealthDocs(deps);
}

const CAIRN_HEALTH_RECORDS_CONTROLLER = {
  render: renderHealthRecords,
  loadDocs: loadHealthDocs,
  wireDoc: wireHealthDoc,
  wireUpload: wireHealthUpload,
};

Object.assign(globalThis, { CairnHealthRecordsController: CAIRN_HEALTH_RECORDS_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnHealthRecordsController = CAIRN_HEALTH_RECORDS_CONTROLLER;
}
