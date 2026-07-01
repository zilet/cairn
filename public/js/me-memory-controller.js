(() => {
// @ts-check
// Me -> Memory controller: render, add, edit, delete, and reload remembered facts.
(() => {
    function memoryRows(value) {
        return Array.isArray(value)
            ? value.filter((row) => !!row && typeof row === "object")
            : value && typeof value === "object"
                ? [value]
                : [];
    }
    async function render(deps) {
        deps.headerTitle.textContent = "Me";
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
        const addBtn = deps.view.querySelector("#memAdd");
        const input = deps.view.querySelector("#memInput");
        const kindSelect = deps.view.querySelector("#memKind");
        if (!addBtn || !input || !kindSelect)
            return;
        const add = async () => {
            const content = input.value.trim();
            if (!content) {
                input.focus();
                return;
            }
            const kind = kindSelect.value;
            input.value = "";
            try {
                await deps.api("/memory", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content, kind }),
                });
            }
            catch {
                deps.toast("Couldn't save that - try again.");
                return;
            }
            deps.toast("Remembered");
            load(deps);
        };
        addBtn.addEventListener("click", add);
        input.addEventListener("keydown", (event) => { if (event.key === "Enter")
            add(); });
        load(deps);
    }
    async function load(deps) {
        const wrap = deps.view.querySelector("#memlist");
        if (!wrap)
            return;
        let items = [];
        try {
            items = memoryRows(await deps.api("/memory"));
        }
        catch {
            items = [];
        }
        if (deps.state.tab !== "me" || deps.state.meSeg !== "memory" || !wrap.isConnected)
            return;
        if (!items.length) {
            wrap.innerHTML = `<div class="empty">Nothing remembered yet. As you chat and log, the coach keeps the facts and preferences that matter - they'll gather here.</div>`;
            return;
        }
        wrap.innerHTML = items.map((item, index) => CairnMemory.memoryRowHtml(item, index)).join("");
        wrap.querySelectorAll("[data-memedit]").forEach((button) => button.addEventListener("click", () => startEdit(button.closest(".memrow"), deps)));
        wrap.querySelectorAll("[data-memdel]").forEach((button) => button.addEventListener("click", () => startDelete(button, deps)));
    }
    function startEdit(row, deps) {
        if (!row || row.querySelector(".memedit-box"))
            return;
        const id = row.dataset.mem;
        const contentEl = row.querySelector("[data-memcontent]");
        if (!id || !contentEl)
            return;
        const current = contentEl.textContent || "";
        contentEl.hidden = true;
        const box = document.createElement("div");
        box.className = "memedit-box";
        box.innerHTML = `<input class="memedit-in" type="text" value="${deps.escapeAttr(current)}">
    <button class="iconbtn memok" title="save">✓</button>
    <button class="iconbtn" data-memcancel title="cancel">×</button>`;
        contentEl.after(box);
        const input = box.querySelector(".memedit-in");
        if (!input)
            return;
        input.focus();
        input.setSelectionRange(current.length, current.length);
        const cancel = () => { box.remove(); contentEl.hidden = false; };
        const save = async () => {
            const content = input.value.trim();
            if (!content) {
                input.focus();
                return;
            }
            try {
                await deps.api(`/memory/${id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content }),
                });
            }
            catch {
                deps.toast("Couldn't save that - try again.");
                return;
            }
            deps.toast("Updated");
            load(deps);
        };
        box.querySelector(".memok")?.addEventListener("click", save);
        box.querySelector("[data-memcancel]")?.addEventListener("click", cancel);
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter")
                save();
            else if (event.key === "Escape")
                cancel();
        });
    }
    function startDelete(button, deps) {
        const row = button.closest(".memrow");
        const id = row?.dataset.mem;
        if (!id)
            return;
        deps.armDelete(button, () => {
            deps.api(`/memory/${id}`, { method: "DELETE" })
                .then(() => { deps.toast("Removed"); load(deps); })
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
})();
