// Health Records controller: list loading, upload handoff, and deep-link scrolling.
// Rendering primitives stay in health-records-client.ts and health-docs-client.ts;
// per-row document actions live in health-doc-actions-controller.ts.

type HealthDocument = import("../contracts/client-api.js").ClientHealthDocument;

type HealthRecordsState = {
  tab?: string;
  meSeg?: string;
  healthSeg?: string;
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
  CairnHealthDocActionsController.wireDoc(el, healthDocActionsDeps(deps));
}

function pollHealthDoc(id: string | number, deps: HealthRecordsControllerDeps): void {
  CairnHealthDocActionsController.pollDoc(id, healthDocActionsDeps(deps));
}

async function loadHealthDocs(deps: HealthRecordsControllerDeps): Promise<HealthDocument[]> {
  const wrap = hrecElement("#hlist");
  if (!wrap) return [];
  let docs: HealthDocument[] = [];
  let fetched = false;
  try {
    docs = hrecRows<HealthDocument>(await deps.api("/health-docs"));
    fetched = true;
  } catch {
    docs = [];
  }
  if (fetched && Array.isArray(docs)) {
    try {
      localStorage.setItem("cairn:healthDocCount", String(docs.length));
    } catch {}
  }
  if (deps.state.tab !== "me" || deps.state.meSeg !== "health" || !wrap.isConnected) return docs || [];
  if (!docs || !docs.length) {
    wrap.innerHTML = CairnHealthRecords.recordsEmptyHtml();
    return [];
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
    deps.state.pendingHealthDocId = null;
    if (target) {
      target.classList.remove("hdoc-collapsed");
      try {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      } catch {
        target.scrollIntoView();
      }
    }
  }
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
