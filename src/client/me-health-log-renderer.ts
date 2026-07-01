// @ts-check
// Me health log list rendering: food notes, activity rows, and note-card click wiring.

type ClientMeHealthLogRecord = Record<string, unknown>;
type ClientMeHealthLogState = Pick<ClientAppState, "_notesById">;
type ClientMeHealthLogNoteCard = HTMLElement & { _wired?: boolean };
type ClientMeHealthLogActivity = import("../contracts/client.js").ClientActivity & ClientMeHealthLogRecord;

type ClientMeHealthLogRendererDeps = {
  state: ClientMeHealthLogState;
  select<T extends Element = Element>(selector: string): T | null;
  noteEntryHtml(note: ClientMeHealthLogRecord, index?: number): string;
  activityEntryHtml(activity: ClientMeHealthLogActivity): string;
  openFoodDetail(note: unknown, fromTile?: Element | null): unknown;
};

type ClientMeHealthLogRendererApi = {
  healthLogRows<T extends ClientMeHealthLogRecord = ClientMeHealthLogRecord>(value: unknown): T[];
  wireNoteCard(el: Element, deps: ClientMeHealthLogRendererDeps): void;
  renderNotes(notes: unknown, deps: ClientMeHealthLogRendererDeps): void;
  renderActs(acts: unknown, deps: ClientMeHealthLogRendererDeps): void;
};

(() => {
function healthLogRows<T extends ClientMeHealthLogRecord = ClientMeHealthLogRecord>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((row) => !!row && typeof row === "object") as T[]) : [];
}

function wireNoteCard(el: Element, deps: ClientMeHealthLogRendererDeps): void {
  const card = el as ClientMeHealthLogNoteCard;
  if (!card || card._wired) return; card._wired = true;
  card.addEventListener("click", (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button, a, input")) return;
    const note = (deps.state._notesById || {})[card.dataset.noteid || ""];
    if (note) deps.openFoodDetail(note, card.querySelector(".artile"));
  });
}

function renderNotes(notes: unknown, deps: ClientMeHealthLogRendererDeps): void {
  const wrap = deps.select<HTMLElement>("#notelist");
  if (!wrap) return;
  const rows = healthLogRows(notes);
  if (!rows.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Snap a plate or jot a meal in Chat and it shows up here.</div>`; return; }
  deps.state._notesById = Object.fromEntries(rows.map((note) => [String(note.id), note]));
  wrap.innerHTML = rows.map((note, index) => deps.noteEntryHtml(note, index)).join("");
  wrap.querySelectorAll(".fnent").forEach((el) => wireNoteCard(el, deps));
}

function renderActs(acts: unknown, deps: ClientMeHealthLogRendererDeps): void {
  const wrap = deps.select<HTMLElement>("#actlist");
  if (!wrap) return;
  const rows = healthLogRows<ClientMeHealthLogActivity>(acts);
  if (!rows.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Log a ride, run, or walk on Today and it lands here.</div>`; return; }
  wrap.innerHTML = rows.map((activity) => deps.activityEntryHtml(activity)).join("");
}

const CAIRN_ME_HEALTH_LOG_RENDERER: ClientMeHealthLogRendererApi = {
  healthLogRows,
  wireNoteCard,
  renderNotes,
  renderActs,
};

Object.assign(globalThis, { CairnMeHealthLogRenderer: CAIRN_ME_HEALTH_LOG_RENDERER });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnMeHealthLogRenderer: CAIRN_ME_HEALTH_LOG_RENDERER });
}
})();
