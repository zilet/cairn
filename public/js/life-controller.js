(() => {
// @ts-check
// Me -> Life controller: render, add, edit, delete, and reload timeline events.
(() => {
    function lifeRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function lifeRows(value) {
        return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
    }
    function lifeInputValue(id) {
        return $("#" + id)?.value ?? "";
    }
    function trimmedLifeInputValue(id) {
        const value = lifeInputValue(id).trim();
        return value || null;
    }
    function drawFields(kind) {
        const wrap = $("#lFields");
        if (!wrap)
            return;
        wrap.innerHTML = CairnLife.lifeFieldsHtml(kind);
    }
    function collectForm() {
        const kind = lifeInputValue("lKind");
        const title = trimmedLifeInputValue("lTitle");
        const detail = trimmedLifeInputValue("lDetail");
        const start_date = trimmedLifeInputValue("lStart");
        const end_date = trimmedLifeInputValue("lEnd");
        const meta = {};
        if (kind === "trip") {
            const loc = trimmedLifeInputValue("lLocation");
            if (loc)
                meta.location = loc;
        }
        else if (kind === "injury") {
            const area = trimmedLifeInputValue("lArea");
            if (area)
                meta.area = area;
            const sev = $("#lSeverity");
            if (sev)
                meta.severity = sev.value;
        }
        else {
            const imp = $("#lImpact");
            if (imp)
                meta.impact = imp.value;
        }
        return { kind, title, detail, start_date, end_date, meta };
    }
    async function submit(deps) {
        const status = $("#lStatus");
        const body = collectForm();
        const titleInput = $("#lTitle");
        if (!status)
            return;
        if (!body.title) {
            status.textContent = "Add a title first.";
            titleInput?.focus();
            return;
        }
        const btn = $("#lAdd");
        if (!btn)
            return;
        btn.disabled = true;
        try {
            const response = lifeRecord(await deps.api("/context-events", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }));
            if (response.error) {
                status.textContent = "Couldn't save that — try again.";
                return;
            }
            status.textContent = "";
            deps.toast("Added");
            // Reset the text + dates but keep the kind.
            drawFields(lifeInputValue("lKind"));
            load(deps);
        }
        catch {
            status.textContent = "Couldn't save that — check your connection.";
        }
        finally {
            btn.disabled = false;
        }
    }
    async function load(deps) {
        const wrap = $("#llist");
        if (!wrap)
            return;
        let events = [];
        // Fetch the timeline and the structured injury impacts together. Impacts are a
        // calm enhancement on active injuries — if the read fails, the cards still draw.
        let impacts = null;
        try {
            const [eventRows, impactRows] = await Promise.all([
                deps.api("/context-events"),
                deps.api("/injury-impacts").catch(() => null),
            ]);
            events = lifeRows(eventRows);
            impacts = impactRows;
        }
        catch {
            events = [];
        }
        if (deps.state.tab !== "me" || deps.state.meSeg !== "life" || !wrap.isConnected)
            return;
        if (!events.length) {
            wrap.innerHTML = `<div class="empty">Nothing on your timeline yet.</div>`;
            return;
        }
        const impactsById = {};
        for (const injury of lifeRows(lifeRecord(impacts).injuries)) {
            impactsById[String(injury.id)] = injury;
        }
        // Active/upcoming first (sorted by soonest start), then past/archived.
        const active = events.filter((event) => CairnLife.eventActive(event));
        const past = events.filter((event) => !CairnLife.eventActive(event));
        const byStart = (a, b) => (a.start_date || "9999") < (b.start_date || "9999") ? -1 : 1;
        active.sort(byStart);
        past.sort((a, b) => byStart(b, a)); // most recent past first
        deps.state._lifeById = Object.fromEntries(events.map((event) => [String(event.id), event]));
        wrap.innerHTML = [...active, ...past].map((event, index) => CairnLife.lifeEventHtml(event, index, impactsById)).join("");
        wrap.querySelectorAll("[data-ledit]").forEach((button) => button.addEventListener("click", () => startEdit(button.closest(".life-ev"), deps)));
        wrap.querySelectorAll("[data-ldel]").forEach((button) => button.addEventListener("click", () => startDelete(button, deps)));
    }
    async function render(deps) {
        deps.headerTitle.textContent = "Me";
        deps.state.meSeg = "life";
        deps.invalidatePoll();
        deps.view.innerHTML = deps.segBar("life", deps.segments) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Trips, injuries, and life events. The coach factors these into the workout you see — easing off around travel or an injury.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">Add to your timeline</h1>
    <div class="lifeadd">
      <div class="field" style="margin-bottom:9px"><label for="lKind">Kind</label>
        <select id="lKind" name="lKind" class="selflex">${CairnLife.lifeKindOptionsHtml()}</select>
      </div>
      <div id="lFields"></div>
      <button id="lAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
      <div id="lStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Timeline</h1>
    <div id="llist"></div>`;
        deps.wireSeg(deps.handlers);
        const kindSel = $("#lKind");
        if (!kindSel)
            return;
        kindSel.addEventListener("change", () => drawFields(kindSel.value));
        drawFields(kindSel.value);
        $("#lAdd")?.addEventListener("click", () => submit(deps));
        load(deps);
    }
    function startEdit(card, deps) {
        if (!card || card.querySelector(".life-edit"))
            return;
        const id = card.dataset.life;
        if (!id)
            return;
        const event = lifeRecord((deps.state._lifeById || {})[id]);
        if (!event.id)
            return;
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
        box.querySelector(".le-title")?.focus();
        const cancel = () => {
            card.innerHTML = prev;
            rewireCard(card, deps);
        };
        const save = async () => {
            const value = (selector) => {
                const el = box.querySelector(selector);
                return el && el.value.trim() ? el.value.trim() : null;
            };
            const title = value(".le-title");
            if (!title) {
                box.querySelector(".le-title")?.focus();
                return;
            }
            const newMeta = { ...meta };
            const metaEl = box.querySelector(".le-meta");
            if (metaEl) {
                const metaValue = metaEl.value.trim();
                if (event.kind === "trip")
                    newMeta.location = metaValue || undefined;
                else if (event.kind === "injury")
                    newMeta.area = metaValue || undefined;
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
            }
            catch {
                deps.toast("Couldn't save that — try again.");
                return;
            }
            deps.toast("Updated");
            load(deps);
        };
        box.querySelector(".le-save")?.addEventListener("click", save);
        box.querySelector(".le-cancel")?.addEventListener("click", cancel);
    }
    function rewireCard(card, deps) {
        const edit = card.querySelector("[data-ledit]");
        if (edit)
            edit.addEventListener("click", () => startEdit(card, deps));
        const del = card.querySelector("[data-ldel]");
        if (del)
            del.addEventListener("click", () => startDelete(del, deps));
    }
    // Two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js).
    function startDelete(button, deps) {
        const row = button.closest(".life-ev");
        if (!(row instanceof HTMLElement))
            return;
        const id = row.dataset.life;
        if (!id)
            return;
        deps.armDelete(button, () => {
            deps.api(`/context-events/${id}`, { method: "DELETE" })
                .then(() => { deps.toast("Removed"); load(deps); })
                .catch(() => deps.toast("Couldn't remove that — try again."));
        });
    }
    const CAIRN_LIFE_CONTROLLER = {
        collectForm,
        drawFields,
        load,
        render,
        rewireCard,
        startDelete,
        startEdit,
        submit,
    };
    Object.assign(globalThis, { CairnLifeController: CAIRN_LIFE_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnLifeController = CAIRN_LIFE_CONTROLLER;
    }
})();
})();
