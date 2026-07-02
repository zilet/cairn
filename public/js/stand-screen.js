(() => {
// @ts-check
// Stand — the card-based "where you stand" brain. You consume the overview at a
// glance (the one lever + a grid of domain tiles, each a traffic-light read), tap a
// tile to dig into that domain, tap a marker to expand it, tap back. No long scroll:
// every view is ONE focused screen you move through. Self-contained (like
// body-metrics-client), reusing the shipped marker rows + status + body figure.
(() => {
    const RANK = { warn: 3, watch: 2, ok: 1, mute: 0 };
    const DOMAINS = [
        { key: "heart", label: "Heart & Circulation", groups: ["lipids", "cardiac", "inflammation", "vitals"] },
        { key: "metabolic", label: "Metabolic & Fitness", groups: ["metabolic", "fitness"] },
        { key: "blood", label: "Blood & Iron", groups: ["iron", "blood"] },
        { key: "organs", label: "Organs", groups: ["kidney", "liver", "electrolytes"] },
        { key: "endocrine", label: "Hormones & Thyroid", groups: ["hormones", "thyroid"] },
        { key: "vitamins", label: "Vitamins & Minerals", groups: ["vitamins"] },
        { key: "screening", label: "Screening & Other", groups: ["autoimmune", "screening", "metals", "urinalysis", "other"] },
    ];
    const HM = () => globalThis.CairnHealthMarkers;
    const BM = () => globalThis.CairnBodyMetrics;
    let DATA = null;
    function status(m) {
        const s = HM()?.markerStatus?.(m);
        return s || "mute";
    }
    function worstOf(markers) {
        let s = "mute";
        for (const m of markers)
            if (RANK[status(m)] > RANK[s])
                s = status(m);
        return s;
    }
    // The marker that should headline a group tile: the worst-status one (most
    // actionable first), falling back to the first marker so a calm group still reads.
    function leadMarker(markers) {
        if (!markers.length)
            return null;
        return [...markers].sort((a, b) => RANK[status(b)] - RANK[status(a)])[0];
    }
    function markersOfGroup(key) {
        return (DATA?.markers || []).filter((m) => String(m.group) === key);
    }
    function markersOfDomain(d) {
        return (DATA?.markers || []).filter((m) => d.groups.includes(String(m.group)));
    }
    function offCount(markers) {
        return markers.filter((m) => { const s = status(m); return s === "warn" || s === "watch"; }).length;
    }
    function valWord(m) {
        const v = m?.latest?.value;
        if (v == null || v === "")
            return "";
        const num = HM()?.formatMarkerNumber?.(v);
        return `${num ?? v}${m.unit ? ` ${String(m.unit)}` : ""}`;
    }
    // ---- overview ------------------------------------------------------------------
    function focusHeroHtml() {
        const f = DATA?.focus;
        const headline = f && typeof f.headline === "string" ? f.headline.trim() : "";
        const lead = f && f.lead && typeof f.lead === "object" ? f.lead : null;
        const line = lead && typeof lead.line === "string" ? lead.line.trim()
            : lead && typeof lead.why === "string" ? lead.why.trim() : "";
        if (!headline && !line)
            return "";
        return `<div class="stand-focus reveal">
      <span class="stand-focus-k">Where to focus</span>
      ${headline ? `<h2 class="stand-focus-h">${escHtml(headline)}</h2>` : ""}
      ${line ? `<p class="stand-focus-p">${escHtml(line)}</p>` : ""}
    </div>`;
    }
    function bodyComp() {
        const body = DATA?.body;
        return body && body.comp && typeof body.comp === "object" ? body.comp : null;
    }
    function bodyStatus() {
        const comp = bodyComp();
        if (!comp)
            return markersOfGroup("body").length ? worstOf(markersOfGroup("body")) : "mute";
        const scales = Array.isArray(comp.scales) ? comp.scales : [];
        const focus = comp.focus && typeof comp.focus === "object";
        return focus ? "watch" : scales.length ? "ok" : "mute";
    }
    function bodyTile() {
        const comp = bodyComp();
        if (!comp && !markersOfGroup("body").length)
            return "";
        const scales = comp && Array.isArray(comp.scales) ? comp.scales : [];
        const whtr = scales.find((s) => s.key === "whtr") || scales[0];
        const st = bodyStatus();
        const read = whtr && whtr.value != null
            ? `waist <b>${escHtml(String(whtr.value))}</b> of height`
            : "log a tape session";
        return `<button class="stand-tile reveal" data-body>
      <span class="stand-tile-top"><span class="hdot hdot-${st}"></span><span class="stand-tile-name">Body</span></span>
      <span class="stand-tile-read ${st}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
    }
    function domainTileHtml(d, st) {
        const markers = markersOfDomain(d);
        const lead = leadMarker(markers);
        const off = offCount(markers);
        // An off domain leads with the marker that needs attention; a calm domain just
        // says how many reads sit inside it (a number to tap into, never "all good" prose).
        const read = off && lead
            ? `${escHtml(String(lead.name || lead.key || ""))} <b>${escHtml(valWord(lead))}</b>${off > 1 ? ` · ${off} to watch` : ""}`
            : `${markers.length} reading${markers.length === 1 ? "" : "s"}`;
        return `<button class="stand-tile reveal" data-domain="${escAttr(d.key)}">
      <span class="stand-tile-top"><span class="hdot hdot-${st}"></span><span class="stand-tile-name">${escHtml(d.label)}</span></span>
      <span class="stand-tile-read ${off ? st : ""}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
    }
    function overviewHtml() {
        const tiles = [];
        const b = bodyTile();
        if (b)
            tiles.push({ st: bodyStatus(), html: b });
        for (const d of DOMAINS) {
            const markers = markersOfDomain(d);
            if (!markers.length)
                continue;
            const st = worstOf(markers);
            tiles.push({ st, html: domainTileHtml(d, st) });
        }
        tiles.sort((a, b2) => RANK[b2.st] - RANK[a.st]);
        return `<div class="stand-root">
      ${focusHeroHtml()}
      <div class="stand-grid">${tiles.map((t) => t.html).join("")}</div>
    </div>`;
    }
    // ---- domain detail — markers, led by their clinical sub-group ------------------
    function domainDetailHtml(key) {
        const d = DOMAINS.find((x) => x.key === key);
        if (!d)
            return groupBlocksHtml("Markers", "");
        // Group the domain's markers by clinical group, worst group first, each under a
        // small sub-header — so the fine taxonomy survives one tap down.
        const present = (DATA?.groups || []).filter((g) => d.groups.includes(g.key) && markersOfGroup(g.key).length);
        present.sort((a, b) => RANK[worstOf(markersOfGroup(b.key))] - RANK[worstOf(markersOfGroup(a.key))]);
        const blocks = present.map((g) => {
            const rows = markersOfGroup(g.key).map((m) => HM()?.hmkRowHtml?.(m)).filter(Boolean).join("");
            return `<div class="stand-subhead">${escHtml(g.label)}</div><div class="hmk-list">${rows}</div>`;
        }).join("");
        return groupBlocksHtml(d.label, blocks);
    }
    function groupBlocksHtml(title, inner) {
        return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">${escHtml(title)}</h2>
      ${inner || `<p class="stand-empty">No readings here yet.</p>`}
    </div>`;
    }
    function bodyDetailHtml() {
        const body = DATA?.body;
        const comp = body && body.comp && typeof body.comp === "object" ? body.comp : null;
        const scales = comp && Array.isArray(comp.scales) ? comp.scales : [];
        const focus = comp && comp.focus && typeof comp.focus === "object" ? comp.focus : null;
        // reuse the shipped body figure: waist glows when the lever is central-fat.
        const fk = focus && typeof focus.key === "string" ? focus.key : null;
        const figFocus = fk === "whtr" || fk === "whr" || fk === "bodyfat" ? "waist" : null;
        const fig = BM()?.bodyFigureSvg?.(figFocus, []) || "";
        const focusLine = focus && typeof focus.line === "string" ? focus.line : "";
        const cards = scales.filter((s) => s.value != null).map((s) => {
            const off = focus ? "" : "";
            return `<div class="stand-mcard ${off}"><span class="stand-mcard-l">${escHtml(String(s.label || ""))}</span><span class="stand-mcard-v">${escHtml(String(s.value))}${s.unit ? escHtml(String(s.unit)) : ""}</span></div>`;
        }).join("");
        // Fold the DEXA / body-composition markers (the "body" clinical group) in here too.
        const dexa = markersOfGroup("body").map((m) => HM()?.hmkRowHtml?.(m)).filter(Boolean).join("");
        return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">Body</h2>
      <div class="stand-figrow">${fig}<div class="stand-figtxt">${focusLine ? `<p>${escHtml(focusLine)}</p>` : "<p>Holding steady — log a tape session to refresh the read.</p>"}</div></div>
      ${cards ? `<div class="stand-mcards">${cards}</div>` : ""}
      ${dexa ? `<div class="stand-subhead">From your DEXA</div><div class="hmk-list">${dexa}</div>` : ""}
    </div>`;
    }
    // ---- render + wire -------------------------------------------------------------
    function paint(html) {
        view.innerHTML = html;
        if (typeof globalThis.viewEnter === "function") {
            globalThis.viewEnter();
        }
    }
    function showOverview() { paint(overviewHtml()); wireOverview(); }
    function showDomain(key) { paint(domainDetailHtml(key)); wireDetail(); }
    function showBody() { paint(bodyDetailHtml()); wireDetail(); }
    function wireOverview() {
        view.querySelectorAll("[data-domain]").forEach((b) => b.addEventListener("click", () => showDomain(b.dataset.domain || "")));
        view.querySelector("[data-body]")?.addEventListener("click", () => showBody());
    }
    function wireDetail() {
        view.querySelector("[data-back]")?.addEventListener("click", () => showOverview());
        // marker row expand + chart + ask (mirrors the Markers catalog wiring)
        view.querySelectorAll(".hmk-x .hmk-row").forEach((button) => button.addEventListener("click", () => {
            const item = button.closest(".hmk");
            if (!item)
                return;
            const open = item.classList.toggle("open");
            button.setAttribute("aria-expanded", open ? "true" : "false");
        }));
        view.querySelectorAll("svg.hchart").forEach((svg) => HM()?.wireMarkerChart?.(svg));
        view.querySelectorAll(".hmk-ask").forEach((button) => button.addEventListener("click", (event) => {
            event.stopPropagation();
            const g = globalThis;
            g.CairnHealthClient?.askCoach?.(button.getAttribute("data-ask"));
        }));
    }
    async function renderStand() {
        headerTitle.textContent = "Stand";
        paint(`<div class="stand-loading loadstate"><span class="loadstate-label">Reading where you stand…</span></div>`);
        try {
            const [priority, focus, body] = await Promise.all([
                api("/markers/priority"),
                api("/coaching-focus").catch(() => null),
                api("/body-metrics?unit=in").catch(() => null),
            ]);
            DATA = {
                markers: Array.isArray(priority?.markers) ? priority.markers : [],
                groups: Array.isArray(priority?.groups) ? priority.groups : [],
                focus,
                body,
            };
            showOverview();
        }
        catch {
            paint(`<div class="stand-error loadstate"><span class="loadstate-label">Couldn't read your standing right now.</span></div>`);
        }
    }
    const CAIRN_STAND = { renderStand };
    Object.assign(globalThis, { CairnStand: CAIRN_STAND, renderStand });
    if (typeof window !== "undefined") {
        window.CairnStand = CAIRN_STAND;
    }
})();
})();
