(() => {
(() => {
    function synthesisRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function synthesisRows(value) {
        return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
    }
    function select(deps, selector) {
        return deps.root.querySelector(selector) || deps.select(selector);
    }
    function render(data, deps, token) {
        const wrap = select(deps, "#hSynthesis");
        if (!wrap || !wrap.isConnected || (token != null && token !== deps.pollToken()))
            return;
        const payload = synthesisRecord(data);
        const s = payload.synthesis && typeof payload.synthesis === "object" ? payload.synthesis : null;
        const focus = synthesisRecord(payload.focus);
        const hasFocus = Array.isArray(focus.priorities) && focus.priorities.length;
        if (!s && !hasFocus) {
            wrap.innerHTML = "";
            return;
        }
        const stale = payload.stale ?? (s && s.stale) ?? false;
        const prios = s && Array.isArray(s.priorities)
            ? synthesisRows(s.priorities).filter((p) => p.label || p.the_move)
            : [];
        let body;
        if (s && s.headline) {
            body = `
      <h3 class="hsyn-headline">${deps.escapeHtml(s.headline)}</h3>
      ${s.story ? `<p class="hsyn-story">${deps.escapeHtml(s.story)}</p>` : ""}
      ${prios.length ? `<div class="hsyn-prios">${prios.map((p) => `
        <div class="hsyn-prio">
          <span class="hsyn-plabel">${deps.escapeHtml(p.label || "")}</span>
          ${p.the_move ? `<span class="hsyn-pmove">${deps.escapeHtml(p.the_move)}</span>` : ""}
          ${p.recheck ? `<span class="hsyn-precheck lbl">${deps.escapeHtml(p.recheck)}</span>` : ""}
        </div>`).join("")}</div>` : ""}
      ${s.one_change ? `<div class="hsyn-onechange"><span class="lbl">If you change one thing</span><span>${deps.escapeHtml(s.one_change)}</span></div>` : ""}
      <div class="hsyn-foot"><span class="lbl">${s.generated_at ? `read ${deps.escapeHtml(deps.relTime(s.generated_at))}` : ""}</span>${stale
                ? `<button id="hsynRefresh" class="hpic-refresh hpic-refresh-stale" type="button" title="New results since this read"><span class="hdot hdot-warn"></span>New results — refresh</button>`
                : `<button class="linkbtn" id="hsynRefresh" type="button">refresh</button>`}</div>`;
        }
        else {
            body = `
      <p class="hsyn-invite">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn hsyn-gen" id="hsynGen" type="button">Read my whole picture</button>`;
        }
        wrap.innerHTML = `<div class="hsyn reveal"><div class="hsyn-kicker lbl">Your health — one picture</div>${body}</div>`;
        select(deps, "#hsynRefresh")?.addEventListener("click", () => trigger(deps));
        select(deps, "#hsynGen")?.addEventListener("click", () => trigger(deps));
    }
    function load(deps, token) {
        const wrap = select(deps, "#hSynthesis");
        if (!wrap || !wrap.isConnected)
            return;
        deps.api("/health/synthesis")
            .then((data) => render(data || {}, deps, token))
            .catch(() => { });
    }
    function trigger(deps) {
        const wrap = select(deps, "#hSynthesis");
        if (!wrap)
            return;
        const card = wrap.querySelector(".hsyn");
        if (card && !card.querySelector(".job-cap")) {
            const cap = document.createElement("div");
            cap.className = "job-cap lbl hsyn-cap";
            card.appendChild(cap);
        }
        void deps.runOp("health_synthesis", {}, {
            path: "/health/synthesis",
            anchor: "#hSynthesis .hsyn",
            caption: ["reading your labs", "connecting it to your training & recovery", "finding what matters most", "writing your picture"],
            guard: () => !select(deps, "#hSynthesis")?.isConnected,
            render: (result) => {
                const payload = synthesisRecord(result);
                if (payload.synthesis)
                    render(payload, deps, deps.pollToken());
                else
                    load(deps, deps.pollToken());
                deps.swrInvalidate("plan:coach");
            },
            onFail: () => {
                deps.toast("Couldn't read the picture right now — try again in a bit.");
                load(deps, deps.pollToken());
            },
        });
    }
    const CAIRN_HEALTH_READ_SYNTHESIS = {
        load,
        render,
        trigger,
    };
    Object.assign(globalThis, { CairnHealthReadSynthesis: CAIRN_HEALTH_READ_SYNTHESIS });
    if (typeof window !== "undefined") {
        window.CairnHealthReadSynthesis = CAIRN_HEALTH_READ_SYNTHESIS;
    }
})();
})();
