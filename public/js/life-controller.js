(() => {
// @ts-check
// Me -> Life controller: route rendering and the stable public controller API.
(() => {
    function lifeFormApi() {
        return globalThis.CairnLifeFormHelpers;
    }
    function lifeTimelineApi() {
        return globalThis.CairnLifeTimelineActions;
    }
    async function render(deps) {
        deps.headerTitle.textContent = "Life";
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
        kindSel.addEventListener("change", () => lifeFormApi().drawFields(kindSel.value));
        lifeFormApi().drawFields(kindSel.value);
        $("#lAdd")?.addEventListener("click", () => lifeFormApi().submit(deps));
        lifeTimelineApi().load(deps);
    }
    const CAIRN_LIFE_CONTROLLER = {
        collectForm: () => lifeFormApi().collectForm(),
        drawFields: (kind) => lifeFormApi().drawFields(kind),
        load: (deps) => lifeTimelineApi().load(deps),
        render,
        rewireCard: (card, deps) => lifeTimelineApi().rewireCard(card, deps),
        startDelete: (button, deps) => lifeTimelineApi().startDelete(button, deps),
        startEdit: (card, deps) => lifeTimelineApi().startEdit(card, deps),
        submit: (deps) => lifeFormApi().submit(deps),
    };
    Object.assign(globalThis, { CairnLifeController: CAIRN_LIFE_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnLifeController = CAIRN_LIFE_CONTROLLER;
    }
})();
})();
