// @ts-check
// Me -> Health inner segmented-tab controller: route-safe Health subtab wiring
// and dispatch to the existing tab painters.
(() => {
const HEALTH_SEG: readonly (readonly [ClientHealthSection, string])[] = [["read", "Read"], ["markers", "Markers"], ["records", "Records"], ["share", "Share"], ["learned", "Learned"]];

function normalizeHealthSeg(seg: unknown): ClientHealthSection {
  if (seg === "analysis" || seg === "brain" || seg === "standing") return "read";
  return typeof seg === "string" && HEALTH_SEG.some(([k]) => k === seg) ? (seg as ClientHealthSection) : "read";
}

async function renderHealth(deps: ClientMeHealthTabsControllerDeps): Promise<void> {
  deps.headerTitle.textContent = "Health";
  deps.state.meSeg = "health";
  deps.state.healthSeg = normalizeHealthSeg(deps.state.healthSeg);
  // New user with nothing uploaded yet -> open on Records (where you add a document),
  // not the Read view that can only say "this will sharpen". Respect any explicit
  // tab choice made this session, and only override on a confident zero doc count.
  if (!deps.state.healthSegPicked && deps.state.healthSeg === "read" && deps.healthDocsKnownEmpty()) {
    deps.state.healthSeg = "records";
  }
  deps.invalidatePoll();
  const idx = Math.max(0, HEALTH_SEG.findIndex(([k]) => k === deps.state.healthSeg));
  deps.root.innerHTML = deps.segBar("health", deps.segments)
    + `<div class="segwrap hsegwrap"><div class="seg seg-sliding hseg" style="--segn:${HEALTH_SEG.length};--segi:${idx}">`
    +   `<span class="seg-thumb"></span>`
    +   HEALTH_SEG.map(([k, l]) => `<button class="segbtn${k === deps.state.healthSeg ? " active" : ""}" data-hseg="${k}">${l}</button>`).join("")
    + `</div></div>`
    + `<div id="hContent"></div>`;
  deps.wireSeg(deps.handlers);
  const hseg = deps.root.querySelector<HTMLElement>(".hseg");
  if (!hseg) return;
  hseg.querySelectorAll<HTMLButtonElement>(".segbtn").forEach((b) => b.addEventListener("click", () => {
    const next = normalizeHealthSeg(b.dataset.hseg);
    if (next === deps.state.healthSeg) return;
    setHealthSegActive(next, deps);
    deps.syncRouteFromState?.();
    deps.withViewTransition(() => paintHealthTab(deps));
  }));
  paintHealthTab(deps);
}

function setHealthSegActive(seg: ClientHealthSection, deps: ClientMeHealthTabsControllerDeps): void {
  deps.state.healthSeg = seg;
  deps.state.healthSegPicked = true;
  const hseg = deps.root.querySelector<HTMLElement>(".hseg");
  if (!hseg) return;
  const btns = [...hseg.querySelectorAll<HTMLButtonElement>(".segbtn")];
  const target = btns.find((b) => b.dataset.hseg === seg);
  if (!target) return;
  hseg.style.setProperty("--segi", String(btns.indexOf(target)));
  btns.forEach((x) => x.classList.toggle("active", x === target));
  deps.fitSeg(hseg);
}

function switchHealthSeg(seg: ClientHealthSection, deps: ClientMeHealthTabsControllerDeps, opts: { openPicker?: boolean } = {}): void {
  if (deps.state.tab !== "me" || deps.state.meSeg !== "health") return;
  setHealthSegActive(seg, deps);
  deps.syncRouteFromState?.();
  if (opts.openPicker) {
    paintHealthTab(deps);
    const f = deps.root.querySelector<HTMLInputElement>("#hFile") || deps.select<HTMLInputElement>("#hFile");
    if (f) f.click();
  } else {
    deps.withViewTransition(() => paintHealthTab(deps));
  }
}

function paintHealthTab(deps: ClientMeHealthTabsControllerDeps): void {
  deps.invalidatePoll();
  if (deps.state.healthSeg === "records") {
    deps.paintRecords();
    return;
  }
  if (deps.state.healthSeg === "share") {
    deps.paintShare();
    return;
  }
  if (deps.state.healthSeg === "learned") {
    deps.paintLearned();
    return;
  }
  if (deps.state.healthSeg === "markers") {
    deps.paintMarkers();
    return;
  }
  deps.paintRead();
}

const CAIRN_ME_HEALTH_TABS_CONTROLLER = {
  HEALTH_SEG,
  normalizeHealthSeg,
  paintHealthTab,
  renderHealth,
  setHealthSegActive,
  switchHealthSeg,
};

Object.assign(globalThis, { CairnMeHealthTabsController: CAIRN_ME_HEALTH_TABS_CONTROLLER });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnMeHealthTabsController: CAIRN_ME_HEALTH_TABS_CONTROLLER });
}
})();
