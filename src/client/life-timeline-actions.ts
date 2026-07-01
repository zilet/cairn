// @ts-check
// Me -> Life timeline helpers: list loading, edit controls, and deletion.

type LifeTimelineActionsApi = {
  load(deps: ClientLifeControllerDeps): Promise<void>;
  rewireCard(card: HTMLElement, deps: ClientLifeControllerDeps): void;
  startDelete(button: Element, deps: ClientLifeControllerDeps): void;
  startEdit(card: HTMLElement | null, deps: ClientLifeControllerDeps): void;
};

function lifeFormHelpers(): LifeFormHelpersApi {
  return (globalThis as unknown as { CairnLifeFormHelpers: LifeFormHelpersApi }).CairnLifeFormHelpers;
}

async function loadLifeTimeline(deps: ClientLifeControllerDeps): Promise<void> {
  const wrap = $("#llist");
  if (!wrap) return;
  let events: LifeControllerContextEvent[] = [];
  // Fetch the timeline and the structured injury impacts together. Impacts are a
  // calm enhancement on active injuries — if the read fails, the cards still draw.
  let impacts: unknown = null;
  const helpers = lifeFormHelpers();
  try {
    const [eventRows, impactRows] = await Promise.all([
      deps.api("/context-events"),
      deps.api("/injury-impacts").catch(() => null),
    ]);
    events = helpers.rows<LifeControllerContextEvent>(eventRows);
    impacts = impactRows;
  } catch {
    events = [];
  }
  if (deps.state.tab !== "me" || deps.state.meSeg !== "life" || !wrap.isConnected) return;
  if (!events.length) {
    wrap.innerHTML = `<div class="empty">Nothing on your timeline yet.</div>`;
    return;
  }
  const impactsById: Record<string, LifeControllerRecord> = {};
  for (const injury of helpers.rows(helpers.record(impacts).injuries)) {
    impactsById[String(injury.id)] = injury;
  }
  // Active/upcoming first (sorted by soonest start), then past/archived.
  const active = events.filter((event) => CairnLife.eventActive(event));
  const past = events.filter((event) => !CairnLife.eventActive(event));
  const byStart = (a: LifeControllerContextEvent, b: LifeControllerContextEvent) =>
    (a.start_date || "9999") < (b.start_date || "9999") ? -1 : 1;
  active.sort(byStart);
  past.sort((a, b) => byStart(b, a)); // most recent past first
  deps.state._lifeById = Object.fromEntries(events.map((event) => [String(event.id), event]));
  wrap.innerHTML = [...active, ...past].map((event, index) => CairnLife.lifeEventHtml(event, index, impactsById)).join("");

  wrap.querySelectorAll<HTMLElement>("[data-ledit]").forEach((button) =>
    button.addEventListener("click", () => startLifeEdit(button.closest<HTMLElement>(".life-ev"), deps))
  );
  wrap.querySelectorAll<HTMLElement>("[data-ldel]").forEach((button) =>
    button.addEventListener("click", () => startLifeDelete(button, deps))
  );
}

function startLifeEdit(card: HTMLElement | null, deps: ClientLifeControllerDeps): void {
  if (!card || card.querySelector(".life-edit")) return;
  const id = card.dataset.life;
  if (!id) return;
  const event = lifeFormHelpers().record((deps.state._lifeById || {})[id]) as LifeControllerContextEvent;
  if (!event.id) return;
  const meta = CairnLife.parsedMeta(event);
  const metaField = event.kind === "trip"
    ? `<input class="le-meta form-input" name="life_location" aria-label="Location" placeholder="Location" value="${deps.escapeAttr(meta.location || "")}">`
    : event.kind === "injury"
      ? `<input class="le-meta form-input" name="life_area" aria-label="Area" placeholder="Area" value="${deps.escapeAttr(meta.area || "")}">`
      : "";
  const box = document.createElement("div");
  box.className = "life-edit";
  box.innerHTML = `
    <input class="le-title form-input" name="life_title" aria-label="Title" placeholder="Title" value="${deps.escapeAttr(event.title || "")}">
    ${metaField}
    <div class="ob-grid" style="margin-top:6px">
      <input class="le-start form-input" name="life_start" aria-label="Start" type="date" value="${deps.escapeAttr(event.start_date || "")}">
      <input class="le-end form-input" name="life_end" aria-label="End" type="date" value="${deps.escapeAttr(event.end_date || "")}">
    </div>
    <input class="le-detail form-input" name="life_detail" aria-label="Detail" placeholder="Detail" value="${deps.escapeAttr(event.detail || "")}">
    <div class="life-edit-ctl">
      <button class="iconbtn memok le-save" title="save">✓</button>
      <button class="iconbtn le-cancel" title="cancel">×</button>
    </div>`;
  const prev = card.innerHTML;
  card.innerHTML = "";
  card.appendChild(box);
  box.querySelector<HTMLInputElement>(".le-title")?.focus();

  const cancel = () => {
    card.innerHTML = prev;
    rewireLifeCard(card, deps);
  };
  const save = async () => {
    const value = (selector: string) => {
      const el = box.querySelector<HTMLInputElement>(selector);
      return el && el.value.trim() ? el.value.trim() : null;
    };
    const title = value(".le-title");
    if (!title) { box.querySelector<HTMLInputElement>(".le-title")?.focus(); return; }
    const newMeta: LifeControllerRecord = { ...meta };
    const metaEl = box.querySelector<HTMLInputElement>(".le-meta");
    if (metaEl) {
      const metaValue = metaEl.value.trim();
      if (event.kind === "trip") newMeta.location = metaValue || undefined;
      else if (event.kind === "injury") newMeta.area = metaValue || undefined;
    }
    try {
      await deps.api(`/context-events/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: event.kind,
          title,
          detail: value(".le-detail"),
          start_date: value(".le-start"),
          end_date: value(".le-end"),
          meta: newMeta,
        }),
      });
    } catch {
      deps.toast("Couldn't save that — try again.");
      return;
    }
    deps.toast("Updated");
    loadLifeTimeline(deps);
  };
  box.querySelector<HTMLButtonElement>(".le-save")?.addEventListener("click", save);
  box.querySelector<HTMLButtonElement>(".le-cancel")?.addEventListener("click", cancel);
}

function rewireLifeCard(card: HTMLElement, deps: ClientLifeControllerDeps): void {
  const edit = card.querySelector("[data-ledit]");
  if (edit) edit.addEventListener("click", () => startLifeEdit(card, deps));
  const del = card.querySelector("[data-ldel]");
  if (del) del.addEventListener("click", () => startLifeDelete(del, deps));
}

// Two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js).
function startLifeDelete(button: Element, deps: ClientLifeControllerDeps): void {
  const row = button.closest(".life-ev");
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.life;
  if (!id) return;
  deps.armDelete(button, () => {
    deps.api(`/context-events/${id}`, { method: "DELETE" })
      .then(() => { deps.toast("Removed"); loadLifeTimeline(deps); })
      .catch(() => deps.toast("Couldn't remove that — try again."));
  });
}

const CAIRN_LIFE_TIMELINE_ACTIONS: LifeTimelineActionsApi = {
  load: loadLifeTimeline,
  rewireCard: rewireLifeCard,
  startDelete: startLifeDelete,
  startEdit: startLifeEdit,
};

Object.assign(globalThis, { CairnLifeTimelineActions: CAIRN_LIFE_TIMELINE_ACTIONS });

if (typeof window !== "undefined") {
  window.CairnLifeTimelineActions = CAIRN_LIFE_TIMELINE_ACTIONS;
}
