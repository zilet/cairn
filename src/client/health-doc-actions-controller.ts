// Health document row action wiring. Date-edit and lifecycle workflows live in
// health-doc-date-actions-client.ts and health-doc-lifecycle-actions-client.ts.

type HealthDocActionsDeps = ClientHealthDocActionsControllerDeps;

type HealthDocActionsWiredElement<T extends Element = HTMLElement> = T & { _wired?: boolean };

function refreshPictureAfterHealthDocDelete(deps: HealthDocActionsDeps): void {
  CairnHealthDocLifecycleActions.refreshPictureAfterDelete(deps);
}

function hdocActionsPollDoc(id: string | number, deps: HealthDocActionsDeps): void {
  CairnHealthDocLifecycleActions.pollDoc(id, deps);
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
    del.addEventListener("click", () => CairnHealthDocLifecycleActions.startDelete(del, deps));
  }

  const editBtn = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hdate-edit]");
  if (editBtn && !editBtn._wired) {
    editBtn._wired = true;
    editBtn.addEventListener("click", () => CairnHealthDocDateActions.openEditor(el, editBtn));
  }
  const saveBtn = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hdate-save]");
  if (saveBtn && !saveBtn._wired) {
    saveBtn._wired = true;
    saveBtn.addEventListener("click", () => CairnHealthDocDateActions.saveDate(id, deps));
  }
  const cancelBtn = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hdate-cancel]");
  if (cancelBtn && !cancelBtn._wired) {
    cancelBtn._wired = true;
    cancelBtn.addEventListener("click", () => CairnHealthDocDateActions.cancelEditor(el, editBtn));
  }
  const rescan = el.querySelector<HealthDocActionsWiredElement<HTMLElement>>("[data-hrescan]");
  if (rescan && !rescan._wired) {
    rescan._wired = true;
    rescan.addEventListener("click", () => CairnHealthDocLifecycleActions.reanalyze(id, deps));
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
