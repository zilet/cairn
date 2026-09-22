// @ts-check
// Me -> Life controller: route rendering and the stable public controller API.

(() => {
  function lifeFormApi(): LifeFormHelpersApi {
    return (globalThis as unknown as { CairnLifeFormHelpers: LifeFormHelpersApi }).CairnLifeFormHelpers;
  }

  function lifeTimelineApi(): LifeTimelineActionsApi {
    return (globalThis as unknown as { CairnLifeTimelineActions: LifeTimelineActionsApi }).CairnLifeTimelineActions;
  }

  async function render(deps: ClientLifeControllerDeps): Promise<void> {
    deps.headerTitle.textContent = "Life";
    deps.state.meSeg = "life";
    deps.invalidatePoll();
    deps.view.innerHTML = deps.segBar("life", deps.segments) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Trips, injuries, and life events. The coach factors these into the workout you see — easing off around travel or an injury.
    </div></div>
    <div id="lConsider"></div>
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

    const kindSel = $<HTMLSelectElement>("#lKind");
    if (!kindSel) return;
    kindSel.addEventListener("change", () => lifeFormApi().drawFields(kindSel.value));
    lifeFormApi().drawFields(kindSel.value);

    $<HTMLButtonElement>("#lAdd")?.addEventListener("click", () => lifeFormApi().submit(deps));

    lifeTimelineApi().load(deps);
    loadConsiderations(deps);
  }

  // Stated movement considerations (read-only; chat is the setter). Best-effort: a
  // failed read leaves the slot empty rather than blocking the timeline.
  async function loadConsiderations(deps: ClientLifeControllerDeps): Promise<void> {
    let read: unknown = null;
    try {
      read = await deps.api("/profile/movement-considerations");
    } catch {
      return;
    }
    const slot = $("#lConsider");
    if (!slot || !slot.isConnected || deps.state.meSeg !== "life") return;
    slot.innerHTML = CairnLife.movementConsiderationsHtml(read);
    slot.querySelector("[data-lconsider-chat]")?.addEventListener("click", () => {
      const g = globalThis as unknown as {
        CairnHealthClient?: { askCoach?: (q: unknown) => void };
        state?: { chatPrefill?: string | null };
        activateTab?: (name: string) => unknown;
      };
      const question = "About how I move:";
      if (g.CairnHealthClient?.askCoach) return g.CairnHealthClient.askCoach(question);
      if (g.state) g.state.chatPrefill = question;
      if (typeof g.activateTab === "function") g.activateTab("chat");
    });
  }

  const CAIRN_LIFE_CONTROLLER = {
    collectForm: () => lifeFormApi().collectForm(),
    drawFields: (kind: unknown) => lifeFormApi().drawFields(kind),
    load: (deps: ClientLifeControllerDeps) => lifeTimelineApi().load(deps),
    render,
    rewireCard: (card: HTMLElement, deps: ClientLifeControllerDeps) => lifeTimelineApi().rewireCard(card, deps),
    startDelete: (button: Element, deps: ClientLifeControllerDeps) => lifeTimelineApi().startDelete(button, deps),
    startEdit: (card: HTMLElement | null, deps: ClientLifeControllerDeps) => lifeTimelineApi().startEdit(card, deps),
    submit: (deps: ClientLifeControllerDeps) => lifeFormApi().submit(deps),
  };

  Object.assign(globalThis, { CairnLifeController: CAIRN_LIFE_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnLifeController = CAIRN_LIFE_CONTROLLER;
  }
})();
