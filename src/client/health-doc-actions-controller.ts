// Health document row actions: date edits, rescan, delete, and collapse toggles.
// The Records controller owns list loading; this helper owns per-row behavior.

type HealthDocActionsDocument = import("../contracts/client-api.js").ClientHealthDocument;

type HealthDocActionsPictureCache = {
  review?: Record<string, unknown> | null;
  docCount?: number;
  newestDocAt?: string | null;
};

type HealthDocActionsDeps = {
  state: {
    tab?: string;
    meSeg?: string;
    healthSeg?: string;
  };
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
  pollToken(): number;
  loadHealthMarkers(token: number): void;
  paintHealthPicture(): void;
  loadHealthDocs(): Promise<HealthDocActionsDocument[]>;
  wireHealthDoc(el: HTMLElement | null): void;
  getHealthPictureCache(): HealthDocActionsPictureCache | null;
  setHealthPictureCache(cache: HealthDocActionsPictureCache | null): HealthDocActionsPictureCache | null;
};

type HealthDocActionsWiredElement<T extends Element = HTMLElement> = T & { _wired?: boolean };

function hdocActionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function hdocActionNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hdocActionElement<T extends Element = Element>(selector: string): T | null {
  return $<T>(selector);
}

function hdocActionRow(id: string | number): HTMLElement | null {
  return hdocActionElement<HTMLElement>(`#hlist .hdoc[data-hdoc="${id}"]`);
}

function refreshPictureAfterHealthDocDelete(deps: HealthDocActionsDeps): void {
  const pictureCache = deps.getHealthPictureCache();
  const docCount = pictureCache?.docCount || 0;
  if (!pictureCache || docCount <= 0) return;
  pictureCache.docCount = docCount - 1;
  deps.setHealthPictureCache(pictureCache);
  deps.paintHealthPicture();
}

function openHealthDocDateEditor(row: HTMLElement, editBtn: HTMLElement): void {
  const editor = row.querySelector<HTMLElement>("[data-hdate-editor]");
  const flash = row.querySelector<HTMLElement>("[data-hdate-flash]");
  if (flash) flash.hidden = true;
  editBtn.hidden = true;
  if (editor) {
    editor.hidden = false;
    editor.querySelector<HTMLInputElement>("[data-hdate]")?.focus();
  }
}

function cancelHealthDocDateEditor(row: HTMLElement, editBtn: HTMLElement | null): void {
  const editor = row.querySelector<HTMLElement>("[data-hdate-editor]");
  const input = row.querySelector<HTMLInputElement>("[data-hdate]");
  if (input) input.value = input.defaultValue;
  if (editor) editor.hidden = true;
  if (editBtn) editBtn.hidden = false;
}

async function saveHealthDocDate(id: string | number, deps: HealthDocActionsDeps): Promise<void> {
  const row = hdocActionRow(id);
  if (!row) return;
  const input = row.querySelector<HTMLInputElement>("[data-hdate]");
  const save = row.querySelector<HTMLButtonElement>("[data-hdate-save]");
  if (!input) return;
  if (save) {
    save.disabled = true;
    save.textContent = "Saving…";
  }
  let updated: unknown = null;
  try {
    updated = await deps.api(`/health-docs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_date: input.value || null }),
    });
  } catch {
    if (save) {
      save.disabled = false;
      save.textContent = "Save";
    }
    deps.toast("Couldn't update date");
    return;
  }
  const doc = hdocActionRecord(updated) as HealthDocActionsDocument;
  if (doc.id && !doc.error) {
    row.innerHTML = CairnHealthDocs.healthDocInner(doc);
    deps.wireHealthDoc(row);
    const flash = row.querySelector<HTMLElement>("[data-hdate-flash]");
    if (flash) {
      flash.hidden = false;
      setTimeout(() => {
        if (flash.isConnected) flash.hidden = true;
      }, 2200);
    }
    deps.loadHealthMarkers(deps.pollToken());
    deps.paintHealthPicture();
    return;
  }

  if (save) {
    save.disabled = false;
    save.textContent = "Save";
  }
  deps.toast(String(doc.error || "Couldn't update date"));
}

async function reanalyzeHealthDoc(id: string | number, deps: HealthDocActionsDeps): Promise<void> {
  const row = hdocActionRow(id);
  let updated: unknown = null;
  try {
    updated = await deps.api(`/health-docs/${id}/reanalyze`, { method: "POST" });
  } catch {
    deps.toast("Couldn't start re-analysis");
    return;
  }
  const doc = hdocActionRecord(updated) as HealthDocActionsDocument;
  if (!doc.id || doc.error) {
    deps.toast(String(doc.error || "Couldn't re-analyze"));
    return;
  }
  deps.toast("Re-analyzing…");
  if (row) {
    row.innerHTML = CairnHealthDocs.healthDocInner(doc);
    deps.wireHealthDoc(row);
  }
  hdocActionsPollDoc(id, deps);
}

function hdocActionsPollDoc(id: string | number, deps: HealthDocActionsDeps): void {
  const numericId = hdocActionNumber(id);
  if (numericId == null || numericId <= 0) return;
  const tab = deps.state.tab;
  const token = deps.pollToken();
  deps.pollEnrichment("/health-docs", numericId, {
    tab,
    token,
    tries: 100,
    interval: 4000,
    onUpdate: (row) => {
      const doc = hdocActionRecord(row) as HealthDocActionsDocument;
      if (deps.state.meSeg !== "health" || deps.state.healthSeg !== "records") return;
      const el = hdocActionRow(doc.id);
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

function startHealthDelete(btn: Element, deps: HealthDocActionsDeps): void {
  const row = btn.closest(".hdoc");
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.hdoc;
  if (!id) return;
  deps.armDelete(btn, () => {
    deps.api(`/health-docs/${id}`, { method: "DELETE" })
      .then(() => {
        deps.toast("Removed");
        row.remove();
        const list = hdocActionElement("#hlist");
        if (list && !list.children.length) list.innerHTML = CairnHealthRecords.recordsEmptyHtml();
        refreshPictureAfterHealthDocDelete(deps);
        deps.loadHealthMarkers(deps.pollToken());
      })
      .catch(() => deps.toast("Couldn't remove that — try again."));
  });
}

function toggleHealthDoc(row: HTMLElement): void {
  row.classList.toggle("hdoc-collapsed");
}

function wireHealthDocActions(el: HTMLElement | null, deps: HealthDocActionsDeps): void {
  if (!el) return;
  const id = el.dataset.hdoc;
  if (!id) return;
  const del = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hdel]");
  if (del && !del._wired) {
    del._wired = true;
    del.addEventListener("click", () => startHealthDelete(del, deps));
  }

  const editBtn = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hdate-edit]");
  if (editBtn && !editBtn._wired) {
    editBtn._wired = true;
    editBtn.addEventListener("click", () => openHealthDocDateEditor(el, editBtn));
  }
  const saveBtn = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hdate-save]");
  if (saveBtn && !saveBtn._wired) {
    saveBtn._wired = true;
    saveBtn.addEventListener("click", () => saveHealthDocDate(id, deps));
  }
  const cancelBtn = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hdate-cancel]");
  if (cancelBtn && !cancelBtn._wired) {
    cancelBtn._wired = true;
    cancelBtn.addEventListener("click", () => cancelHealthDocDateEditor(el, editBtn));
  }
  const rescan = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hrescan]");
  if (rescan && !rescan._wired) {
    rescan._wired = true;
    rescan.addEventListener("click", () => reanalyzeHealthDoc(id, deps));
  }

  el.querySelectorAll<HealthDocActionsWiredElement<HTMLElement>>("[data-hdoc-toggle]").forEach((toggleEl) => {
    if (toggleEl._wired) return;
    toggleEl._wired = true;
    const toggle = () => toggleHealthDoc(el);
    toggleEl.addEventListener("click", toggle);
    if (toggleEl.getAttribute("role") === "button") {
      toggleEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    }
  });
}

const CAIRN_HEALTH_DOC_ACTIONS_CONTROLLER = {
  pollDoc: hdocActionsPollDoc,
  refreshPictureAfterDelete: refreshPictureAfterHealthDocDelete,
  wireDoc: wireHealthDocActions,
};

Object.assign(globalThis, { CairnHealthDocActionsController: CAIRN_HEALTH_DOC_ACTIONS_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnHealthDocActionsController = CAIRN_HEALTH_DOC_ACTIONS_CONTROLLER;
}
