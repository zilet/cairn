(() => {
// @ts-check
// Health Read supplement card rendering and input/delete wiring.
{
    (() => {
        function supplementRows(value) {
            return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
        }
        function select(deps, selector) {
            return deps.root.querySelector(selector) || deps.select(selector);
        }
        function load(deps, token) {
            const wrap = select(deps, "#hbSupplements");
            if (!wrap || !wrap.isConnected)
                return;
            const peek = deps.peekCached("supplements");
            if (peek)
                render(peek.data, deps, token);
            deps.cachedApi("/supplements", {
                key: "supplements",
                onUpgrade: (data, { changed }) => {
                    if (changed || !peek)
                        render(data, deps, token);
                },
            }).catch(() => {
                if (!peek)
                    render([], deps, token);
            });
        }
        function render(list, deps, token) {
            const wrap = select(deps, "#hbSupplements");
            if (!wrap || !wrap.isConnected || (token != null && token !== deps.pollToken()))
                return;
            const items = supplementRows(list);
            const chips = items.map((supplement) => {
                const bits = [supplement.dose, supplement.frequency].filter(Boolean).map(deps.escapeHtml).join(" · ");
                return `<div class="supp-chip" title="${deps.escapeAttr(supplement.note || supplement.name)}">
        <span class="supp-name">${deps.escapeHtml(supplement.name)}</span>${bits ? `<span class="supp-meta">${bits}</span>` : ""}
        <button class="supp-x" data-suppx="${supplement.id}" aria-label="Remove ${deps.escapeAttr(supplement.name)}">×</button>
      </div>`;
            }).join("");
            wrap.innerHTML = `<div class="hb-section supp-card reveal" style="${deps.stagger(3)}">
      <span class="lbl">What you're taking</span>
      <p class="supp-sub">Say it once in plain words — I'll approximate the rest and fold it into your picture.</p>
      ${items.length ? `<div class="supp-chips">${chips}</div>` : `<p class="supp-empty">Nothing yet. Tell me below, or just mention it in chat.</p>`}
      <div class="supp-input">
        <input id="suppText" type="text" placeholder="e.g. creatine daily, omega-3…" autocomplete="off" />
        <button id="suppAdd" class="ghostbtn">Add</button>
      </div>
    </div>`;
            const input = select(deps, "#suppText");
            const submit = () => { void understandFromInput(deps); };
            select(deps, "#suppAdd")?.addEventListener("click", submit);
            input?.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    submit();
                }
            });
            wrap.querySelectorAll("[data-suppx]").forEach((button) => button.addEventListener("click", () => { void remove(Number(button.dataset.suppx), deps); }));
        }
        async function understandFromInput(deps) {
            const input = select(deps, "#suppText");
            const text = (input?.value || "").trim();
            if (!text)
                return;
            const btn = select(deps, "#suppAdd");
            if (btn) {
                btn.disabled = true;
                btn.textContent = "Reading…";
            }
            try {
                await deps.api("/supplements/understand", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text }),
                });
                deps.swrInvalidate("supplements");
                load(deps, deps.pollToken());
            }
            catch {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "Add";
                }
            }
        }
        async function remove(id, deps) {
            try {
                await deps.api(`/supplements/${id}`, { method: "DELETE" });
                deps.swrInvalidate("supplements");
                load(deps, deps.pollToken());
            }
            catch { }
        }
        const CAIRN_HEALTH_READ_SUPPLEMENTS = {
            load,
            remove,
            render,
            understandFromInput,
        };
        Object.assign(globalThis, { CairnHealthReadSupplements: CAIRN_HEALTH_READ_SUPPLEMENTS });
        if (typeof window !== "undefined") {
            window.CairnHealthReadSupplements = CAIRN_HEALTH_READ_SUPPLEMENTS;
        }
    })();
}
})();
