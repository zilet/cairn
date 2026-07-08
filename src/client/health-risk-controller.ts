// @ts-check
// Cardiovascular Risk (AHA PREVENT 2023) orchestration: fetch + paint + the
// provisional-read "sharpen in Profile" affordance.

type HealthRiskRead = import("../contracts/client-api.js").ClientCardiovascularRisk;

(() => {
  function select<T extends Element = Element>(deps: ClientHealthRiskControllerDeps, selector: string): T | null {
    return deps.root.querySelector<T>(selector) || deps.select<T>(selector);
  }

  function render(data: HealthRiskRead | null | undefined, deps: ClientHealthRiskControllerDeps): void {
    const wrap = select<HTMLElement>(deps, "#hRisk");
    if (!wrap) return;
    wrap.innerHTML = CairnHealthRisk.renderCardiovascularRiskHtml(data);
    wrap.querySelector("[data-risk-sharpen]")?.addEventListener("click", () => {
      deps.state.meSeg = "profile";
      deps.activateTab("me");
    });
  }

  function load(deps: ClientHealthRiskControllerDeps, token: number): void {
    deps
      .api("/health/risk")
      .then((data) => {
        if (token === deps.pollToken()) render((data || null) as HealthRiskRead | null, deps);
      })
      .catch(() => {
        if (token !== deps.pollToken()) return;
        render(null, deps);
      });
  }

  const CAIRN_HEALTH_RISK_CONTROLLER = {
    load,
    render,
  };

  Object.assign(globalThis, { CairnHealthRiskController: CAIRN_HEALTH_RISK_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnHealthRiskController = CAIRN_HEALTH_RISK_CONTROLLER;
  }
})();
