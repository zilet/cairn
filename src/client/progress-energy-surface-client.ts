// @ts-check
// DOM wiring for the reusable Progress Energy surface.

type ProgressEnergyRecord = Record<string, unknown>;

(() => {
  function progressEnergyIsRecord(value: unknown): value is ProgressEnergyRecord {
    return !!value && typeof value === "object";
  }

  function progressEnergyRecord(value: unknown): ProgressEnergyRecord {
    return progressEnergyIsRecord(value) ? value : {};
  }

  // Fill the Energy Balance hero + card from a derived-expenditure payload. Leaves
  // #checkinResult untouched because the check-in renders there independently.
  function paintEnergyBody(exp: unknown): void {
    const rendered = CairnProgressEnergy.energyBodyHtml(exp);

    const heroWrap = view.querySelector("#energyHero");
    if (heroWrap) {
      heroWrap.innerHTML = rendered.heroHtml;
      runCountUps(heroWrap);
    }

    const card = view.querySelector("#energyCard");
    if (!card) return;
    card.innerHTML = rendered.cardHtml;

    const btn = view.querySelector("#runCheckin");
    if (btn) btn.addEventListener("click", () => runNutritionCheckin(btn));
  }

  function runNutritionCheckin(btn: Element): void {
    const out = view.querySelector("#checkinResult");
    if (!out) return;
    const restore = btnBusy(btn, "Checking…");
    out.innerHTML = CairnProgressEnergy.nutritionCheckinLoadingHtml();
    runOp("nutrition_checkin", { window: 21 }, nutritionCheckinOpOpts(restore));
  }

  function nutritionCheckinOpOpts(restore: (() => void) | null): ClientAgentOpHandlers & {
    caption: string;
    guard: () => boolean;
    isFail: (result: unknown) => boolean;
    render: (result: unknown) => void;
    onFail: (error?: unknown) => void;
  } {
    const done = () => { try { restore && restore(); } catch {} };
    return {
      path: "/nutrition/checkin",
      anchor: "#checkinResult",
      caption: "nutrition_checkin",
      guard: () => {
        const gone = !view.querySelector("#checkinResult")?.isConnected;
        if (gone) done();
        return gone;
      },
      isFail: (result: unknown) => {
        const row = progressEnergyRecord(result);
        return !progressEnergyIsRecord(result) || row.ok === false || !!row.error;
      },
      render: (result: unknown) => {
        const row = progressEnergyRecord(result);
        done();
        const out = view.querySelector("#checkinResult");
        if (!out) return;
        if (!row.change) {
          out.innerHTML = CairnProgressEnergy.nutritionCheckinOkHtml(row);
          return;
        }
        renderCheckinProposal(out, row);
      },
      onFail: () => {
        done();
        const out = view.querySelector("#checkinResult");
        if (out) out.innerHTML = CairnProgressEnergy.nutritionCheckinFailHtml();
      },
    };
  }

  // Reconnector: after a reload mid-check-in, rebuild the loading line in
  // #checkinResult and return the handlers runOp would have used.
  function reconnectNutritionCheckin(): ClientAgentOpHandlers | null {
    const out = view.querySelector("#checkinResult");
    if (!out) return null;
    out.innerHTML = CairnProgressEnergy.nutritionCheckinLoadingHtml();
    const options = nutritionCheckinOpOpts(null);
    let stop = () => {};
    const capEl = out.querySelector(".job-cap");
    if (capEl) stop = thinkingCaption(capEl, options.caption);
    return {
      guard: options.guard,
      onDone: (result: unknown) => { stop(); if (options.isFail(result)) options.onFail(result); else options.render(result); },
      onError: () => { stop(); options.onFail(null); },
      onCanceled: () => { stop(); options.onFail(null); },
    };
  }

  function renderCheckinProposal(out: Element, result: unknown): void {
    out.innerHTML = CairnProgressEnergy.nutritionCheckinProposalHtml(result);
    runCountUps(out);
    const go = out.querySelector("#ckGoMeals");
    if (go) go.addEventListener("click", () => {
      state.planJump = "meals";
      activateTab("plan");
    });
    const dismiss = out.querySelector("#ckDismiss");
    if (dismiss) dismiss.addEventListener("click", () => {
      const card = out.querySelector(".eb-proposal");
      if (card) collapseEl(card, () => { out.innerHTML = ""; });
      else out.innerHTML = "";
    });
  }

  const CAIRN_PROGRESS_ENERGY_SURFACE = {
    paintEnergyBody,
    reconnectNutritionCheckin,
  };

  Object.assign(globalThis, {
    CairnProgressEnergySurface: CAIRN_PROGRESS_ENERGY_SURFACE,
    paintEnergyBody,
    reconnectNutritionCheckin,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnProgressEnergySurface: CAIRN_PROGRESS_ENERGY_SURFACE,
      paintEnergyBody,
      reconnectNutritionCheckin,
    });
  }
})();
