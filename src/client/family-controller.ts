// @ts-check
// Me Family workflow controller: add/list/edit/delete wiring for the people the
// coach plans around. Pure card/swatch HTML stays in family-client.ts.

type FamilyControllerMember = import("../contracts/client-api.js").ClientFamilyMember;
type FamilyControllerRecord = Record<string, unknown>;
type FamilyControllerState = {
  tab?: string;
  meSeg?: string;
  _famById?: Record<string, unknown>;
  [key: string]: unknown;
};
type FamilyControllerDeps = {
  view: HTMLElement;
  state: FamilyControllerState;
  segments: readonly ClientSegment[];
  handlers: Record<string, () => unknown>;
  headerTitle: HTMLElement;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  armDelete(btn: Element, action: () => unknown): void;
  escapeAttr(value: unknown): string;
  invalidatePoll(): void;
  localISO(date?: Date): string;
  segBar(active: string, segments: readonly ClientSegment[]): string;
  toast(message: string): void;
  viewEnter(): void;
  wireSeg(handlers: Record<string, () => unknown>): void;
  withViewTransition(fn: () => unknown): unknown;
  renderLife(): Promise<void>;
};
type FamilyControllerApi = {
  render(deps: FamilyControllerDeps): Promise<void>;
  load(deps: FamilyControllerDeps): Promise<void>;
  startEdit(card: HTMLElement | null, deps: FamilyControllerDeps): void;
  rewireCard(card: HTMLElement, deps: FamilyControllerDeps): void;
  startDelete(btn: Element, deps: FamilyControllerDeps): void;
};

(() => {
  const FAMILY_CACHE_KEY = "me:family";
  const activeEditMutations = new Map<string, Promise<unknown>>();
  const activeDeletes = new Set<string>();

  function isRecord(value: unknown): value is FamilyControllerRecord {
    return !!value && typeof value === "object";
  }

  function record(value: unknown): FamilyControllerRecord {
    return isRecord(value) ? value : {};
  }

  function rows<T extends FamilyControllerRecord = FamilyControllerRecord>(value: unknown): T[] {
    return Array.isArray(value) ? value.filter(isRecord) as T[] : [];
  }

  function qs<T extends Element = HTMLElement>(deps: FamilyControllerDeps, selector: string): T | null {
    return deps.view.querySelector<T>(selector);
  }

  function emptyFamilyForm(deps: FamilyControllerDeps): void {
    for (const selector of ["#fName", "#fRel", "#fBirth", "#fNotes", "#fAllergy", "#fDiet"]) {
      const el = qs<HTMLInputElement>(deps, selector);
      if (el) el.value = "";
    }
  }

  function addPayload(deps: FamilyControllerDeps, color: string) {
    return {
      name: qs<HTMLInputElement>(deps, "#fName")?.value.trim() || "",
      relationship: qs<HTMLInputElement>(deps, "#fRel")?.value.trim() || null,
      birthdate: qs<HTMLInputElement>(deps, "#fBirth")?.value || null,
      color,
      notes: qs<HTMLInputElement>(deps, "#fNotes")?.value.trim() || null,
      allergies: qs<HTMLInputElement>(deps, "#fAllergy")?.value.trim() || null,
      dietary_restrictions: qs<HTMLInputElement>(deps, "#fDiet")?.value.trim() || null,
    };
  }

  function renderFamilyList(deps: FamilyControllerDeps, people: FamilyControllerMember[]): void {
    const wrap = qs<HTMLElement>(deps, "#flist");
    if (!wrap) return;
    if (deps.state.tab !== "me" || deps.state.meSeg !== "family" || !wrap.isConnected) return;
    if (!Array.isArray(people) || !people.length) {
      wrap.innerHTML = CairnUi.emptyStateHtml({
        title: "No one here yet",
        body: "Add the people you plan your weeks around.",
      });
      return;
    }
    deps.state._famById = Object.fromEntries(people.map((f) => [String(f.id), f]));
    wrap.innerHTML = people.map((f, i) => CairnFamily.familyCardHtml(f, i)).join("");
    wrap.querySelectorAll<HTMLElement>("[data-fedit]").forEach((b) => b.addEventListener("click", () => startEdit(b.closest<HTMLElement>(".fam-card"), deps)));
    wrap.querySelectorAll<HTMLElement>("[data-fdel]").forEach((b) => b.addEventListener("click", () => startDelete(b, deps)));
  }

  function cachedFamilyRows(): FamilyControllerMember[] {
    return rows<FamilyControllerMember>(peekCached<FamilyControllerMember[]>(FAMILY_CACHE_KEY)?.data);
  }

  function repaintCachedFamily(deps: FamilyControllerDeps): void {
    renderFamilyList(deps, cachedFamilyRows());
  }

  async function load(deps: FamilyControllerDeps): Promise<void> {
    const wrap = qs<HTMLElement>(deps, "#flist");
    if (!wrap) return;
    const peek = peekCached<FamilyControllerMember[]>(FAMILY_CACHE_KEY);
    if (peek) renderFamilyList(deps, rows<FamilyControllerMember>(peek.data));
    try {
      await cachedApi("/family", {
        key: FAMILY_CACHE_KEY,
        onUpgrade: (people, { changed }) => {
          if (changed || !peek) renderFamilyList(deps, rows<FamilyControllerMember>(people));
        },
      });
    } catch {
      if (!peek) renderFamilyList(deps, []);
    }
  }

  async function render(deps: FamilyControllerDeps): Promise<void> {
    deps.headerTitle.textContent = "Family";
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

    qs<HTMLElement>(deps, "#famToLife")?.addEventListener("click", () => deps.withViewTransition(() => deps.renderLife().then(deps.viewEnter)));

    let addColor = CairnFamily.FAMILY_DEFAULT_COLOR;
    deps.view.querySelectorAll<HTMLElement>(".famadd .fam-swatch").forEach((b) => b.addEventListener("click", () => {
      addColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
      deps.view.querySelectorAll(".famadd .fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
    }));

    qs<HTMLButtonElement>(deps, "#fAdd")?.addEventListener("click", async () => {
      const status = qs<HTMLElement>(deps, "#fStatus");
      const nameInput = qs<HTMLInputElement>(deps, "#fName");
      if (!status || !nameInput) return;
      const body = addPayload(deps, addColor);
      if (!body.name) { status.textContent = "Add a name first."; nameInput.focus(); return; }
      const btn = qs<HTMLButtonElement>(deps, "#fAdd");
      if (!btn) return;
      btn.disabled = true;
      try {
        const tempId = -Date.now();
        const result = record(await optimisticMutation<FamilyControllerMember[]>({
          key: FAMILY_CACHE_KEY,
          apply: (current) => [{ id: tempId, ...body }, ...rows<FamilyControllerMember>(current)],
          rollback: cachedFamilyRows(),
          request: () => deps.api("/family", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
          commit: (current, response) => {
            const row = record(response) as FamilyControllerMember;
            return row.id ? current.map((member) => member.id === tempId ? row : member) : current;
          },
          onChange: () => repaintCachedFamily(deps),
        }));
        if (result.error) { status.textContent = "Couldn't save that — try again."; return; }
        status.textContent = "";
        deps.toast("Added");
        emptyFamilyForm(deps);
      } catch { status.textContent = "Couldn't save that — check your connection."; }
      finally { btn.disabled = false; }
    });

    load(deps);
  }

  function startEdit(card: HTMLElement | null, deps: FamilyControllerDeps): void {
    if (!card || card.querySelector(".fam-edit")) return;
    const id = card.dataset.fam;
    if (!id) return;
    const member = record((deps.state._famById || {})[id]) as FamilyControllerMember;
    if (!member.id) return;
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
    box.querySelector<HTMLInputElement>(".fe-name")?.focus();
    box.querySelectorAll<HTMLElement>(".fam-swatch").forEach((b) => b.addEventListener("click", () => {
      editColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
      box.querySelectorAll(".fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
    }));

    const cancel = () => { card.innerHTML = previous; rewireCard(card, deps); };
    const save = async () => {
      const value = (selector: string) => {
        const el = box.querySelector<HTMLInputElement>(selector);
        return el && el.value.trim() ? el.value.trim() : null;
      };
      const name = value(".fe-name");
      if (!name) { box.querySelector<HTMLInputElement>(".fe-name")?.focus(); return; }
      const body = { name, relationship: value(".fe-rel"), birthdate: value(".fe-birth"), color: editColor, notes: value(".fe-notes"), allergies: value(".fe-allergy"), dietary_restrictions: value(".fe-diet") };
      let mutation: Promise<unknown> | null = null;
      try {
        mutation = optimisticMutation<FamilyControllerMember[]>({
          key: FAMILY_CACHE_KEY,
          apply: (current) => rows<FamilyControllerMember>(current).map((member) => String(member.id) === id ? { ...member, ...body } : member),
          rollback: cachedFamilyRows(),
          request: () => deps.api(`/family/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          commit: (current, response) => {
            const row = record(response) as FamilyControllerMember;
            return row.id ? current.map((member) => String(member.id) === id ? row : member) : current;
          },
          onChange: () => repaintCachedFamily(deps),
        });
        activeEditMutations.set(id, mutation);
        await mutation;
      } catch { deps.toast("Couldn't save that — try again."); return; }
      finally {
        if (mutation && activeEditMutations.get(id) === mutation) activeEditMutations.delete(id);
      }
      deps.toast("Updated");
    };
    box.querySelector<HTMLButtonElement>(".fe-save")?.addEventListener("click", save);
    box.querySelector<HTMLButtonElement>(".fe-cancel")?.addEventListener("click", cancel);
  }

  function rewireCard(card: HTMLElement, deps: FamilyControllerDeps): void {
    const edit = card.querySelector("[data-fedit]");
    if (edit) edit.addEventListener("click", () => startEdit(card, deps));
    const del = card.querySelector("[data-fdel]");
    if (del) del.addEventListener("click", () => startDelete(del, deps));
  }

  function startDelete(btn: Element, deps: FamilyControllerDeps): void {
    const row = btn.closest(".fam-card");
    if (!(row instanceof HTMLElement)) return;
    const id = row.dataset.fam;
    if (!id) return;
    deps.armDelete(btn, async () => {
      if (activeDeletes.has(id)) return;
      activeDeletes.add(id);
      try {
        try { await activeEditMutations.get(id); } catch {}
        await optimisticMutation<FamilyControllerMember[]>({
          key: FAMILY_CACHE_KEY,
          apply: (current) => rows<FamilyControllerMember>(current).filter((member) => String(member.id) !== id),
          rollback: cachedFamilyRows(),
          request: () => deps.api(`/family/${id}`, { method: "DELETE" }),
          onChange: () => repaintCachedFamily(deps),
        });
        deps.toast("Removed");
      } catch {
        deps.toast("Couldn't remove that — try again.");
      } finally {
        activeDeletes.delete(id);
      }
    });
  }

  const CAIRN_FAMILY_CONTROLLER: FamilyControllerApi = {
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
