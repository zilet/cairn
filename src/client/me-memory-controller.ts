// @ts-check
// Me -> Memory controller: render, add, edit, delete, and reload remembered facts.

type MeMemoryRow = import("../contracts/client-api.js").ClientMemory;

type MeMemoryState = {
  tab?: string;
  meSeg?: string | null;
};

type MeMemoryControllerDeps = {
  view: HTMLElement;
  state: MeMemoryState;
  segments: readonly ClientSegment[];
  handlers: Record<string, () => unknown>;
  headerTitle: HTMLElement;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
  escapeAttr(value: unknown): string;
  invalidatePoll(): void;
  segBar(active: string, items: readonly ClientSegment[]): string;
  toast(message: string): void;
  wireSeg(handlers: Record<string, () => unknown>): void;
};

(() => {
  const ME_MEMORY_CACHE_KEY = "me:memory";

  function memoryRows(value: unknown): MeMemoryRow[] {
    return Array.isArray(value)
      ? value.filter((row) => !!row && typeof row === "object") as MeMemoryRow[]
      : value && typeof value === "object"
        ? [value as MeMemoryRow]
        : [];
  }

  function renderMemoryList(deps: MeMemoryControllerDeps, items: MeMemoryRow[]): void {
    const wrap = deps.view.querySelector<HTMLElement>("#memlist");
    if (!wrap || deps.state.tab !== "me" || deps.state.meSeg !== "memory" || !wrap.isConnected) return;
    if (!items.length) {
      wrap.innerHTML = `<div class="empty">Nothing remembered yet. As you chat and log, the coach keeps the facts and preferences that matter - they'll gather here.</div>`;
      return;
    }
    wrap.innerHTML = items.map((item, index) => CairnMemory.memoryRowHtml(item, index)).join("");

    wrap.querySelectorAll<HTMLElement>("[data-memedit]").forEach((button) =>
      button.addEventListener("click", () => startEdit(button.closest<HTMLElement>(".memrow"), deps))
    );
    wrap.querySelectorAll<HTMLElement>("[data-memdel]").forEach((button) =>
      button.addEventListener("click", () => startDelete(button, deps))
    );
  }

  function cachedMemoryRows(): MeMemoryRow[] {
    return memoryRows(peekCached<MeMemoryRow[]>(ME_MEMORY_CACHE_KEY)?.data);
  }

  function repaintCachedMemory(deps: MeMemoryControllerDeps): void {
    renderMemoryList(deps, cachedMemoryRows());
  }

  async function render(deps: MeMemoryControllerDeps): Promise<void> {
    deps.headerTitle.textContent = "Memory";
    deps.state.meSeg = "memory";
    deps.invalidatePoll();
    deps.view.innerHTML = deps.segBar("memory", deps.segments) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Facts and preferences the coach carries between sessions. Edit or remove anything that's stale.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">What the coach remembers</h1>
    <div class="memadd">
      <select id="memKind">${CairnMemory.memoryKindOptionsHtml()}</select>
      <input id="memInput" type="text" placeholder="Add something to remember...">
      <button id="memAdd" class="logbtn">+</button>
    </div>
    <div id="memlist" style="margin-top:12px"></div>`;
    deps.wireSeg(deps.handlers);

    const addBtn = deps.view.querySelector<HTMLButtonElement>("#memAdd");
    const input = deps.view.querySelector<HTMLInputElement>("#memInput");
    const kindSelect = deps.view.querySelector<HTMLSelectElement>("#memKind");
    if (!addBtn || !input || !kindSelect) return;
    const add = async () => {
      const content = input.value.trim();
      if (!content) { input.focus(); return; }
      const kind = kindSelect.value;
      input.value = "";
      try {
        const tempId = -Date.now();
        await optimisticMutation<MeMemoryRow[]>({
          key: ME_MEMORY_CACHE_KEY,
          apply: (current) => [
            { id: tempId, content, kind: kind as MeMemoryRow["kind"], source: "user", created_at: new Date().toISOString() },
            ...memoryRows(current),
          ],
          rollback: cachedMemoryRows(),
          request: () => deps.api("/memory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, kind }),
          }),
          commit: (current, result) => {
            const row = memoryRows(result)[0];
            return row ? current.map((item) => item.id === tempId ? row : item) : current;
          },
          onChange: () => repaintCachedMemory(deps),
        });
      } catch {
        deps.toast("Couldn't save that - try again.");
        return;
      }
      deps.toast("Remembered");
    };
    addBtn.addEventListener("click", add);
    input.addEventListener("keydown", (event: KeyboardEvent) => { if (event.key === "Enter") add(); });
    load(deps);
  }

  async function load(deps: MeMemoryControllerDeps): Promise<void> {
    const wrap = deps.view.querySelector<HTMLElement>("#memlist");
    if (!wrap) return;
    const peek = peekCached<MeMemoryRow[]>(ME_MEMORY_CACHE_KEY);
    if (peek) renderMemoryList(deps, memoryRows(peek.data));
    try {
      await cachedApi("/memory", {
        key: ME_MEMORY_CACHE_KEY,
        onUpgrade: (items, { changed }) => {
          if (changed || !peek) renderMemoryList(deps, memoryRows(items));
        },
      });
    } catch {
      if (!peek) renderMemoryList(deps, []);
    }
  }

  function startEdit(row: HTMLElement | null, deps: MeMemoryControllerDeps): void {
    if (!row || row.querySelector(".memedit-box")) return;
    const id = row.dataset.mem;
    const contentEl = row.querySelector<HTMLElement>("[data-memcontent]");
    if (!id || !contentEl) return;
    const current = contentEl.textContent || "";
    contentEl.hidden = true;
    const box = document.createElement("div");
    box.className = "memedit-box";
    box.innerHTML = `<input class="memedit-in" type="text" value="${deps.escapeAttr(current)}">
    <button class="iconbtn memok" title="save">✓</button>
    <button class="iconbtn" data-memcancel title="cancel">×</button>`;
    contentEl.after(box);
    const input = box.querySelector<HTMLInputElement>(".memedit-in");
    if (!input) return;
    input.focus();
    input.setSelectionRange(current.length, current.length);
    const cancel = () => { box.remove(); contentEl.hidden = false; };
    const save = async () => {
      const content = input.value.trim();
      if (!content) { input.focus(); return; }
      try {
        await optimisticMutation<MeMemoryRow[]>({
          key: ME_MEMORY_CACHE_KEY,
          apply: (current) => memoryRows(current).map((item) => String(item.id) === id ? { ...item, content } : item),
          rollback: cachedMemoryRows(),
          request: () => deps.api(`/memory/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          }),
          commit: (current, result) => {
            const row = memoryRows(result)[0];
            return row ? current.map((item) => String(item.id) === id ? row : item) : current;
          },
          onChange: () => repaintCachedMemory(deps),
        });
      } catch {
        deps.toast("Couldn't save that - try again.");
        return;
      }
      deps.toast("Updated");
    };
    box.querySelector<HTMLButtonElement>(".memok")?.addEventListener("click", save);
    box.querySelector<HTMLButtonElement>("[data-memcancel]")?.addEventListener("click", cancel);
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") save();
      else if (event.key === "Escape") cancel();
    });
  }

  function startDelete(button: Element, deps: MeMemoryControllerDeps): void {
    const row = button.closest<HTMLElement>(".memrow");
    const id = row?.dataset.mem;
    if (!id) return;
    deps.armDelete(button, () => {
      optimisticMutation<MeMemoryRow[]>({
        key: ME_MEMORY_CACHE_KEY,
        apply: (current) => memoryRows(current).filter((item) => String(item.id) !== id),
        rollback: cachedMemoryRows(),
        request: () => deps.api(`/memory/${id}`, { method: "DELETE" }),
        onChange: () => repaintCachedMemory(deps),
      })
        .then(() => { deps.toast("Removed"); })
        .catch(() => deps.toast("Couldn't remove that - try again."));
    });
  }

  const CAIRN_ME_MEMORY_CONTROLLER = {
    load,
    render,
    startDelete,
    startEdit,
  };

  Object.assign(globalThis, { CairnMeMemoryController: CAIRN_ME_MEMORY_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnMeMemoryController = CAIRN_ME_MEMORY_CONTROLLER;
  }
})();
