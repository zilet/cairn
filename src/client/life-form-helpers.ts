// @ts-check
// Me -> Life form helpers: safe reads, dynamic fields, and add workflow.

type LifeControllerRecord = Record<string, unknown>;
type LifeControllerForm = ClientLifeControllerForm;

type LifeFormHelpersApi = {
  record(value: unknown): LifeControllerRecord;
  rows<T extends LifeControllerRecord = LifeControllerRecord>(value: unknown): T[];
  inputValue(id: string): string;
  trimmedInputValue(id: string): string | null;
  drawFields(kind: unknown): void;
  collectForm(): LifeControllerForm;
  submit(deps: ClientLifeControllerDeps): Promise<void>;
};

function lifeFormTimelineActions(): Pick<LifeTimelineActionsApi, "load" | "repaintCached" | "cachedEvents"> {
  return (globalThis as unknown as { CairnLifeTimelineActions: LifeTimelineActionsApi }).CairnLifeTimelineActions;
}

function lifeIsRecord(value: unknown): value is LifeControllerRecord {
  return !!value && typeof value === "object";
}

function lifeRecord(value: unknown): LifeControllerRecord {
  return lifeIsRecord(value) ? value : {};
}

function lifeRows<T extends LifeControllerRecord = LifeControllerRecord>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter(lifeIsRecord) as T[] : [];
}

function lifeInputValue(id: string): string {
  return $<HTMLInputElement>("#" + id)?.value ?? "";
}

function trimmedLifeInputValue(id: string): string | null {
  const value = lifeInputValue(id).trim();
  return value || null;
}

function drawLifeFields(kind: unknown): void {
  const wrap = $("#lFields");
  if (!wrap) return;
  wrap.innerHTML = CairnLife.lifeFieldsHtml(kind);
}

function collectLifeForm(): LifeControllerForm {
  const kind = lifeInputValue("lKind");
  const title = trimmedLifeInputValue("lTitle");
  const detail = trimmedLifeInputValue("lDetail");
  const start_date = trimmedLifeInputValue("lStart");
  const end_date = trimmedLifeInputValue("lEnd");
  const meta: LifeControllerRecord = {};
  if (kind === "trip") {
    const loc = trimmedLifeInputValue("lLocation");
    if (loc) meta.location = loc;
  } else if (kind === "injury") {
    const area = trimmedLifeInputValue("lArea");
    if (area) meta.area = area;
    const sev = $<HTMLSelectElement>("#lSeverity");
    if (sev) meta.severity = sev.value;
  } else {
    const imp = $<HTMLSelectElement>("#lImpact");
    if (imp) meta.impact = imp.value;
  }
  return { kind, title, detail, start_date, end_date, meta };
}

async function submitLifeForm(deps: ClientLifeControllerDeps): Promise<void> {
  const status = $("#lStatus");
  const body = collectLifeForm();
  const titleInput = $<HTMLInputElement>("#lTitle");
  if (!status) return;
  if (!body.title) { status.textContent = "Add a title first."; titleInput?.focus(); return; }
  const btn = $<HTMLButtonElement>("#lAdd");
  if (!btn) return;
  btn.disabled = true;
  const actions = lifeFormTimelineActions();
  try {
    const tempId = -Date.now();
    const response = lifeRecord(await optimisticMutation<LifeControllerContextEvent[]>({
      key: "me:life",
      apply: (current) => [
        {
          id: tempId,
          kind: body.kind,
          title: body.title,
          detail: body.detail,
          start_date: body.start_date,
          end_date: body.end_date,
          meta_json: JSON.stringify(body.meta || {}),
          created_at: new Date().toISOString(),
        } as LifeControllerContextEvent,
        ...lifeRows<LifeControllerContextEvent>(current),
      ],
      rollback: actions.cachedEvents(),
      request: () => deps.api("/context-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      commit: (current, result) => {
        const row = lifeRecord(result) as LifeControllerContextEvent;
        return row.id ? current.map((item) => item.id === tempId ? row : item) : current;
      },
      onChange: () => actions.repaintCached(deps),
    }));
    if (response.error) { status.textContent = "Couldn't save that — try again."; return; }
    status.textContent = "";
    deps.toast("Added");
    // Reset the text + dates but keep the kind.
    drawLifeFields(lifeInputValue("lKind"));
  } catch {
    status.textContent = "Couldn't save that — check your connection.";
  } finally {
    btn.disabled = false;
  }
}

const CAIRN_LIFE_FORM_HELPERS: LifeFormHelpersApi = {
  collectForm: collectLifeForm,
  drawFields: drawLifeFields,
  inputValue: lifeInputValue,
  record: lifeRecord,
  rows: lifeRows,
  submit: submitLifeForm,
  trimmedInputValue: trimmedLifeInputValue,
};

Object.assign(globalThis, { CairnLifeFormHelpers: CAIRN_LIFE_FORM_HELPERS });

if (typeof window !== "undefined") {
  window.CairnLifeFormHelpers = CAIRN_LIFE_FORM_HELPERS;
}
