(() => {
// @ts-check
// Me Family workflow controller: add/list/edit/delete wiring for the people the
// coach plans around. Pure card/swatch HTML stays in family-client.ts.
(() => {
    function isRecord(value) {
        return !!value && typeof value === "object";
    }
    function record(value) {
        return isRecord(value) ? value : {};
    }
    function rows(value) {
        return Array.isArray(value) ? value.filter(isRecord) : [];
    }
    function qs(deps, selector) {
        return deps.view.querySelector(selector);
    }
    function emptyFamilyForm(deps) {
        for (const selector of ["#fName", "#fRel", "#fBirth", "#fNotes", "#fAllergy", "#fDiet"]) {
            const el = qs(deps, selector);
            if (el)
                el.value = "";
        }
    }
    function addPayload(deps, color) {
        return {
            name: qs(deps, "#fName")?.value.trim() || "",
            relationship: qs(deps, "#fRel")?.value.trim() || null,
            birthdate: qs(deps, "#fBirth")?.value || null,
            color,
            notes: qs(deps, "#fNotes")?.value.trim() || null,
            allergies: qs(deps, "#fAllergy")?.value.trim() || null,
            dietary_restrictions: qs(deps, "#fDiet")?.value.trim() || null,
        };
    }
    async function load(deps) {
        const wrap = qs(deps, "#flist");
        if (!wrap)
            return;
        let people = [];
        try {
            people = rows(await deps.api("/family"));
        }
        catch {
            people = [];
        }
        if (deps.state.tab !== "me" || deps.state.meSeg !== "family" || !wrap.isConnected)
            return;
        if (!Array.isArray(people) || !people.length) {
            wrap.innerHTML = `<div class="empty">No one here yet. Add the people you plan your weeks around.</div>`;
            return;
        }
        deps.state._famById = Object.fromEntries(people.map((f) => [String(f.id), f]));
        wrap.innerHTML = people.map((f, i) => CairnFamily.familyCardHtml(f, i)).join("");
        wrap.querySelectorAll("[data-fedit]").forEach((b) => b.addEventListener("click", () => startEdit(b.closest(".fam-card"), deps)));
        wrap.querySelectorAll("[data-fdel]").forEach((b) => b.addEventListener("click", () => startDelete(b, deps)));
    }
    async function render(deps) {
        deps.headerTitle.textContent = "Me";
        deps.state.meSeg = "family";
        deps.invalidatePoll();
        deps.view.innerHTML = deps.segBar("family", deps.segments) + `
      <div class="sess"><div class="sess-line" style="color:var(--muted)">
        The people in your life, so the coach plans around them — never the hardest session on the chaos day. Recurring commitments like the school run or a kid's soccer night live on your <button class="linkbtn" id="famToLife">Life timeline</button> as events.
      </div></div>
      <h1 class="lbl" style="margin:20px 0 8px">Add someone</h1>
      <div class="lifeadd famadd">
        <div class="field" style="margin-bottom:9px"><label for="fName">Name</label>
          <input id="fName" name="fName" type="text" placeholder="e.g. Mara" class="form-input"></div>
        <div class="field" style="margin-bottom:9px"><label for="fRel">Relationship (optional)</label>
          <input id="fRel" name="fRel" type="text" placeholder="e.g. daughter / partner" class="form-input"></div>
        <div class="field" style="margin-bottom:9px"><label for="fBirth">Birthday (optional)</label>
          <input id="fBirth" name="fBirth" type="date" max="${deps.localISO()}" class="form-input"></div>
        <div class="field" style="margin-bottom:9px"><span class="field-label">Colour</span>${CairnFamily.familySwatches(CairnFamily.FAMILY_DEFAULT_COLOR)}</div>
        <div class="field" style="margin-bottom:9px"><label for="fNotes">Notes (optional)</label>
          <input id="fNotes" name="fNotes" type="text" placeholder="e.g. trains with me on weekends" class="form-input"></div>
        <div class="field" style="margin-bottom:9px"><label for="fAllergy">Allergies (optional)</label>
          <input id="fAllergy" name="fAllergy" type="text" placeholder="e.g. peanuts, shellfish" class="form-input"></div>
        <div class="field" style="margin-bottom:9px"><label for="fDiet">Dietary needs (optional)</label>
          <input id="fDiet" name="fDiet" type="text" placeholder="e.g. vegetarian, no pork" class="form-input"></div>
        <button id="fAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
        <div id="fStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
      </div>
      <h1 class="lbl" style="margin:24px 0 8px">Your people</h1>
      <div id="flist"></div>`;
        deps.wireSeg(deps.handlers);
        qs(deps, "#famToLife")?.addEventListener("click", () => deps.withViewTransition(() => deps.renderLife().then(deps.viewEnter)));
        let addColor = CairnFamily.FAMILY_DEFAULT_COLOR;
        deps.view.querySelectorAll(".famadd .fam-swatch").forEach((b) => b.addEventListener("click", () => {
            addColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
            deps.view.querySelectorAll(".famadd .fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
        }));
        qs(deps, "#fAdd")?.addEventListener("click", async () => {
            const status = qs(deps, "#fStatus");
            const nameInput = qs(deps, "#fName");
            if (!status || !nameInput)
                return;
            const body = addPayload(deps, addColor);
            if (!body.name) {
                status.textContent = "Add a name first.";
                nameInput.focus();
                return;
            }
            const btn = qs(deps, "#fAdd");
            if (!btn)
                return;
            btn.disabled = true;
            try {
                const result = record(await deps.api("/family", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
                if (result.error) {
                    status.textContent = "Couldn't save that — try again.";
                    return;
                }
                status.textContent = "";
                deps.toast("Added");
                emptyFamilyForm(deps);
                load(deps);
            }
            catch {
                status.textContent = "Couldn't save that — check your connection.";
            }
            finally {
                btn.disabled = false;
            }
        });
        load(deps);
    }
    function startEdit(card, deps) {
        if (!card || card.querySelector(".fam-edit"))
            return;
        const id = card.dataset.fam;
        if (!id)
            return;
        const member = record((deps.state._famById || {})[id]);
        if (!member.id)
            return;
        let editColor = CairnFamily.familyColor(member.color);
        const box = document.createElement("div");
        box.className = "fam-edit";
        box.innerHTML = `
      <input class="fe-name form-input" name="family_name" aria-label="Name" placeholder="Name" value="${deps.escapeAttr(member.name || "")}">
      <input class="fe-rel form-input" name="family_relationship" aria-label="Relationship" placeholder="Relationship" value="${deps.escapeAttr(member.relationship || "")}">
      <input class="fe-birth form-input" name="family_birthdate" aria-label="Birthday" type="date" max="${deps.localISO()}" value="${deps.escapeAttr(member.birthdate || "")}">
      ${CairnFamily.familySwatches(editColor)}
      <input class="fe-notes form-input" name="family_notes" aria-label="Notes" placeholder="Notes" value="${deps.escapeAttr(member.notes || "")}">
      <input class="fe-allergy form-input" name="family_allergies" aria-label="Allergies" placeholder="Allergies" value="${deps.escapeAttr(member.allergies || "")}">
      <input class="fe-diet form-input" name="family_dietary_needs" aria-label="Dietary needs" placeholder="Dietary needs" value="${deps.escapeAttr(member.dietary_restrictions || "")}">
      <div class="life-edit-ctl">
        <button class="iconbtn memok fe-save" title="save">✓</button>
        <button class="iconbtn fe-cancel" title="cancel">×</button>
      </div>`;
        const previous = card.innerHTML;
        card.innerHTML = "";
        card.appendChild(box);
        box.querySelector(".fe-name")?.focus();
        box.querySelectorAll(".fam-swatch").forEach((b) => b.addEventListener("click", () => {
            editColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
            box.querySelectorAll(".fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
        }));
        const cancel = () => { card.innerHTML = previous; rewireCard(card, deps); };
        const save = async () => {
            const value = (selector) => {
                const el = box.querySelector(selector);
                return el && el.value.trim() ? el.value.trim() : null;
            };
            const name = value(".fe-name");
            if (!name) {
                box.querySelector(".fe-name")?.focus();
                return;
            }
            try {
                await deps.api(`/family/${id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, relationship: value(".fe-rel"), birthdate: value(".fe-birth"), color: editColor, notes: value(".fe-notes"), allergies: value(".fe-allergy"), dietary_restrictions: value(".fe-diet") }),
                });
            }
            catch {
                deps.toast("Couldn't save that — try again.");
                return;
            }
            deps.toast("Updated");
            load(deps);
        };
        box.querySelector(".fe-save")?.addEventListener("click", save);
        box.querySelector(".fe-cancel")?.addEventListener("click", cancel);
    }
    function rewireCard(card, deps) {
        const edit = card.querySelector("[data-fedit]");
        if (edit)
            edit.addEventListener("click", () => startEdit(card, deps));
        const del = card.querySelector("[data-fdel]");
        if (del)
            del.addEventListener("click", () => startDelete(del, deps));
    }
    function startDelete(btn, deps) {
        const row = btn.closest(".fam-card");
        if (!(row instanceof HTMLElement))
            return;
        const id = row.dataset.fam;
        if (!id)
            return;
        deps.armDelete(btn, () => {
            deps.api(`/family/${id}`, { method: "DELETE" })
                .then(() => { deps.toast("Removed"); load(deps); })
                .catch(() => deps.toast("Couldn't remove that — try again."));
        });
    }
    const CAIRN_FAMILY_CONTROLLER = {
        render,
        load,
        startEdit,
        rewireCard,
        startDelete,
    };
    Object.assign(globalThis, { CairnFamilyController: CAIRN_FAMILY_CONTROLLER });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnFamilyController: CAIRN_FAMILY_CONTROLLER });
    }
})();
})();
