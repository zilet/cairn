(() => {
(() => {
    function select(deps, selector) {
        return deps.root.querySelector(selector) || deps.select(selector);
    }
    function documentSelect(deps, selector) {
        return deps.document.querySelector(selector) || deps.select(selector);
    }
    function healthStandingRef(deps, refAge) {
        const value = Number(refAge || deps.state.healthStandingRef || 20);
        return Number.isFinite(value) ? value : 20;
    }
    function inputValue(deps, selector) {
        return documentSelect(deps, selector)?.value ?? "";
    }
    function render(data, deps) {
        const wrap = select(deps, "#hStanding");
        if (!wrap)
            return;
        wrap.innerHTML = CairnHealthStanding.renderHealthStandingHtml(data, { referenceAge: deps.state.healthStandingRef });
        // If the whole-athlete conductor already leads the Standing page, do not render
        // a second "one lever" surface from the narrower health read.
        if (select(deps, "#cfocusStandingSlot .cfocus"))
            wrap.querySelector(".hstand-lever")?.remove();
        wrap.querySelectorAll("[data-refage]").forEach((button) => button.addEventListener("click", () => {
            deps.state.healthStandingRef = Number(button.dataset.refage || 20);
            load(deps, deps.pollToken(), deps.state.healthStandingRef);
        }));
        wrap.querySelector("[data-lever-go]")?.addEventListener("click", () => {
            deps.state.meSeg = "health";
            deps.state.healthSeg = "markers";
            deps.state.healthSegPicked = true;
            deps.activateTab("me");
        });
        select(deps, "#bpLogOpen")?.addEventListener("click", () => openBpSheet(deps));
        void deps.loadDexaTargeting?.("hDexaSlot");
    }
    function openBpSheet(deps) {
        if (deps.document.getElementById("bpSheetOv"))
            return;
        const ov = deps.document.createElement("div");
        ov.id = "bpSheetOv";
        ov.className = "bpsheet-ov";
        ov.innerHTML = `<div class="bpsheet" role="dialog" aria-modal="true" aria-label="Log blood pressure">
      <div class="bpsheet-hd"><h3>Log a reading</h3><button class="bpsheet-x" type="button" aria-label="Close">✕</button></div>
      <form id="bpSheetForm" class="bpsheet-form">
        <div class="bpsheet-row">
          <label>Systolic<input id="bpSys" class="form-input" type="number" inputmode="numeric" min="60" max="260" placeholder="120" required></label>
          <label>Diastolic<input id="bpDia" class="form-input" type="number" inputmode="numeric" min="35" max="160" placeholder="80" required></label>
          <label>Pulse<input id="bpPulse" class="form-input" type="number" inputmode="numeric" min="25" max="240" placeholder="60"></label>
        </div>
        <label class="bpsheet-when">When<input id="bpAt" class="form-input" type="datetime-local" value="${deps.escapeAttr(CairnHealthStanding.localDateTimeInputValue())}"></label>
        <div class="bpsheet-row">
          <label>Position<input id="bpPosition" class="form-input" type="text" maxlength="40" placeholder="Seated"></label>
          <label>Note<input id="bpNote" class="form-input" type="text" maxlength="240" placeholder="Optional"></label>
        </div>
        <div class="bpsheet-ft"><button class="ghostbtn" type="button" data-close>Cancel</button><button class="logbtn" type="submit">Save</button></div>
      </form>
    </div>`;
        deps.document.body.appendChild(ov);
        const onKey = (event) => {
            if (event.key === "Escape")
                teardown();
        };
        function teardown() {
            deps.document.removeEventListener("keydown", onKey);
            ov.remove();
        }
        deps.document.addEventListener("keydown", onKey);
        ov.querySelector(".bpsheet-x")?.addEventListener("click", teardown);
        ov.querySelector("[data-close]")?.addEventListener("click", teardown);
        ov.addEventListener("click", (event) => {
            if (event.target === ov)
                teardown();
        });
        documentSelect(deps, "#bpSheetForm")?.addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
            const submit = form?.querySelector("button[type='submit']") || null;
            if (submit)
                submit.disabled = true;
            const payload = {
                systolic: inputValue(deps, "#bpSys"),
                diastolic: inputValue(deps, "#bpDia"),
                pulse: inputValue(deps, "#bpPulse"),
                measured_at: inputValue(deps, "#bpAt"),
                position: inputValue(deps, "#bpPosition"),
                note: inputValue(deps, "#bpNote"),
                source: "manual",
            };
            try {
                const res = await deps.api("/blood-pressure", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (!res || res.error) {
                    deps.toast(res?.error || "Couldn't log BP");
                    if (submit)
                        submit.disabled = false;
                    return;
                }
                deps.toast("BP logged");
                deps.swrInvalidate("markers:");
                teardown();
                load(deps, deps.pollToken(), deps.state.healthStandingRef || 20);
            }
            catch {
                deps.toast("Couldn't log BP");
                if (submit)
                    submit.disabled = false;
            }
        });
        setTimeout(() => documentSelect(deps, "#bpSys")?.focus(), 30);
    }
    function load(deps, token, refAge) {
        const ref = healthStandingRef(deps, refAge);
        deps.state.healthStandingRef = ref;
        deps.api(`/health/standing?reference_age=${encodeURIComponent(String(ref))}`)
            .then((data) => {
            if (token === deps.pollToken())
                render((data || null), deps);
        })
            .catch(() => {
            if (token !== deps.pollToken())
                return;
            const wrap = select(deps, "#hStanding");
            if (wrap)
                wrap.innerHTML = `<div class="hstand hstand-panel"><div class="empty">Couldn't load health standing right now.</div></div>`;
        });
    }
    function paintReview(deps) {
        const content = select(deps, "#hContent");
        if (!content)
            return;
        content.innerHTML = `<div id="hStanding"><div class="hstand hstand-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div></div>
    <button type="button" class="hread-jump" id="hStandingToRead">
      <span class="hread-jump-main">
        <span class="lbl">Your whole picture</span>
        <span class="hread-jump-title">The full health read</span>
        <span class="hread-jump-sub">Synthesis, the connected-brain list, recovery, markers and supplements — read as one story.</span>
      </span>
      <span class="hread-jump-arrow" aria-hidden="true">→</span>
    </button>`;
        load(deps, deps.pollToken(), deps.state.healthStandingRef || 20);
        select(deps, "#hStandingToRead")?.addEventListener("click", () => openRead(deps));
    }
    function openRead(deps, opts = {}) {
        deps.state.meSeg = "health";
        deps.state.healthSeg = "read";
        deps.state.healthSegPicked = true;
        if (opts.scroll)
            deps.state.pendingHealthScroll = opts.scroll;
        deps.activateTab("me");
    }
    const CAIRN_HEALTH_STANDING_CONTROLLER = {
        load,
        openBpSheet,
        openRead,
        paintReview,
        render,
    };
    Object.assign(globalThis, { CairnHealthStandingController: CAIRN_HEALTH_STANDING_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnHealthStandingController = CAIRN_HEALTH_STANDING_CONTROLLER;
    }
})();
})();
