(() => {
// @ts-check
// Body Metrics — a calm at-home measurements + indicators + trend view.
//
// Self-contained: renderBodyMetrics(mount) fetches /api/body-metrics, paints the
// derived indicators (BMI, waist-to-height, waist-to-hip, Navy body-fat estimate)
// in plain language (no scores), a "where you stand" zone-bar view (each indicator
// drawn on its evidence-anchored bands with a "you are here" dot and a dashed
// "heading here at the current pace" marker + ONE deterministic focus lever), a
// compact "log a session" form with per-site ⓘ measuring hints, an in/cm unit
// toggle (default derived from the browser locale, persisted locally; storage
// stays inches server-side), an optional "set your height" affordance (unlocks
// BMI/body-fat), and per-site sparkline trends with words ("waist down 0.8 in
// over 6 weeks"). Atelier-flavoured with existing classes + inline styles only,
// so it ships without a stylesheet change.
(() => {
    const BM_TONE_COLOR = {
        ok: "var(--sage, #6e7f5c)",
        watch: "var(--gold, #c9a86a)",
        warn: "var(--warn, #b3402e)",
        info: "var(--muted, #8a8578)",
    };
    const BM_UNIT_KEY = "cairn-bm-unit";
    // The saved unit, else derived from the browser locale — only the US, Liberia
    // and Myanmar tape in inches; everyone else gets centimeters.
    function bmUnitPref() {
        try {
            const saved = localStorage.getItem(BM_UNIT_KEY);
            if (saved === "in" || saved === "cm")
                return saved;
        }
        catch {
            /* private mode */
        }
        const region = ((navigator.language || "").split("-")[1] || "").toUpperCase();
        return region && !["US", "LR", "MM"].includes(region) ? "cm" : "in";
    }
    function bmSetUnitPref(unit) {
        try {
            localStorage.setItem(BM_UNIT_KEY, unit);
        }
        catch {
            /* private mode */
        }
    }
    function bmNum(el) {
        if (!el)
            return null;
        const raw = el.value.trim();
        if (!raw)
            return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }
    // Height entry → total inches. In-mode: feet + inches; cm-mode: one cm field.
    function bmHeightInches(mount) {
        const cm = bmNum(mount.querySelector("#bmHeightCm"));
        if (cm != null)
            return Math.round((cm / 2.54) * 10) / 10;
        const ft = bmNum(mount.querySelector("#bmHeightFt"));
        const inch = bmNum(mount.querySelector("#bmHeightIn"));
        if (ft == null && inch == null)
            return null;
        return (ft ?? 0) * 12 + (inch ?? 0);
    }
    function indicatorCard(ind) {
        const color = BM_TONE_COLOR[ind.tone] || BM_TONE_COLOR.info;
        const known = ind.value != null;
        const big = known
            ? `${escHtml(String(ind.value))}${ind.unit ? escHtml(ind.unit) : ""}`
            : "—";
        const zone = ind.zone ? `<span class="bm-ind-zone" style="color:${color}">${escHtml(ind.zone)}</span>` : "";
        const est = ind.estimate ? `<span class="bm-ind-est" style="color:var(--muted,#8a8578);font-size:.72rem"> · estimate</span>` : "";
        return `<div class="sess bm-ind" style="border-left:3px solid ${color};padding:10px 12px">
      <div class="bm-ind-top" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span class="bm-ind-label" style="font-weight:600">${escHtml(ind.label)}${est}</span>
        <span class="bm-ind-val" style="font-size:1.15rem;font-weight:700;color:${color}">${big}</span>
      </div>
      <div class="bm-ind-read sess-line" style="color:var(--muted,#8a8578);margin-top:2px">${zone ? zone + " · " : ""}${escHtml(ind.read)}</div>
    </div>`;
    }
    // --- where you stand: zone bars ------------------------------------------------
    // Each indicator drawn on its plain-language bands: the optimal band reads
    // stronger, a solid dot marks today, a dashed hollow dot marks where the current
    // pace lands in ~12 weeks. Words and position, never a score.
    function zoneBarSvg(s) {
        const W = 300;
        const H = 40;
        const PAD = 8;
        const barY = 17;
        const barH = 8;
        const span = s.max - s.min || 1;
        const x = (v) => PAD + ((Math.min(s.max, Math.max(s.min, v)) - s.min) / span) * (W - PAD * 2);
        const segs = s.bands
            .map((b) => {
            const color = BM_TONE_COLOR[b.tone] || BM_TONE_COLOR.info;
            const isOpt = b.from >= s.optimal.from && b.to <= s.optimal.to;
            return `<rect x="${x(b.from)}" y="${barY}" width="${Math.max(1, x(b.to) - x(b.from))}" height="${barH}" rx="2" fill="${color}" opacity="${isOpt ? "0.55" : "0.22"}"/>`;
        })
            .join("");
        const optMid = x((s.optimal.from + s.optimal.to) / 2);
        const optLabel = `<text x="${optMid}" y="${barY + barH + 11}" text-anchor="middle" font-size="9" fill="${BM_TONE_COLOR.ok}" font-weight="600">optimal</text>`;
        let proj = "";
        if (s.projected != null && s.value != null && Math.abs(s.projected - s.value) > span / 100) {
            const x1 = x(s.value);
            const x2 = x(s.projected);
            proj = `<line x1="${x1}" y1="${barY + barH / 2}" x2="${x2}" y2="${barY + barH / 2}" stroke="var(--ink,#2f2b23)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.55"/>
      <circle cx="${x2}" cy="${barY + barH / 2}" r="4" fill="var(--card,#faf6ec)" stroke="var(--ink,#2f2b23)" stroke-width="1.4" stroke-dasharray="2 2"/>`;
        }
        const cur = s.value != null
            ? `<circle cx="${x(s.value)}" cy="${barY + barH / 2}" r="4.5" fill="var(--ink,#2f2b23)"/>
      <text x="${x(s.value)}" y="${barY - 6}" text-anchor="middle" font-size="10" fill="var(--ink,#2f2b23)" font-weight="700">${escHtml(String(s.value))}${escHtml(s.unit || "")}</text>`
            : "";
        const aria = `${s.label}: ${s.value != null ? `${s.value}${s.unit || ""}` : "not measured"}${s.projected != null ? `, heading to about ${s.projected}${s.unit || ""} in ${s.horizon_weeks} weeks at the current pace` : ""}`;
        return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${escAttr(aria)}" style="display:block">${segs}${optLabel}${proj}${cur}</svg>`;
    }
    function zoneRow(s) {
        if (s.value == null)
            return "";
        const band = s.bands.find((b) => s.value >= b.from && s.value < b.to) || s.bands[s.bands.length - 1];
        const color = BM_TONE_COLOR[band?.tone || "info"];
        const est = s.estimate ? `<span style="color:var(--muted,#8a8578);font-size:.72rem"> · estimate</span>` : "";
        return `<div class="bm-zone-row" style="padding:8px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span style="font-weight:600">${escHtml(s.label)}${est}</span>
        <span style="color:${color};font-size:.8rem;font-weight:600">${escHtml(band?.label || "")}</span>
      </div>
      ${zoneBarSvg(s)}
    </div>`;
    }
    // --- the body figure: one silhouette, glowing focus zones -----------------------
    // A calm front-facing figure. The lever region glows terracotta ("optimize here");
    // regions where a muscle site is growing while the waist holds glow sage with a
    // small upward mark ("winning here"). Illustration tones (like art.js), not theme
    // vars — SVG stop-color doesn't reliably resolve var(). No user data → no escaping.
    const BM_FIG_REG = {
        waist: [[60, 110, 26, 25]],
        chest: [[60, 80, 33, 19]],
        arms: [[31, 99, 15, 50], [89, 99, 15, 50]],
        legs: [[53, 190, 17, 52], [68, 190, 17, 52]],
    };
    const BM_FIG_BODY = `
  <circle cx="60" cy="24" r="12.5"/>
  <path d="M50 36 Q60 41 70 36 L74 45 Q83 49 82.5 60 L80 82 Q79 96 76.5 112 Q75 128 74 140 L46 140 Q45 128 43.5 112 Q41 96 40 82 L37.5 60 Q37 49 46 45 Z"/>
  <path d="M41 49 Q31 53 29.5 70 L26 132 Q25.5 141 31 141 Q36 141 35.5 132 L40 74 Q41 58 44 52 Z"/>
  <path d="M79 49 Q89 53 90.5 70 L94 132 Q94.5 141 89 141 Q84 141 84.5 132 L80 74 Q79 58 76 52 Z"/>
  <path d="M47 138 L58.5 138 Q60 176 59 212 Q59 234 52.5 234 Q46 234 46.5 212 Q46.5 176 47 142 Z"/>
  <path d="M61.5 138 L73 138 Q73.5 176 73.5 212 Q74 234 67.5 234 Q61 234 61 212 Q60 176 61.5 142 Z"/>`;
    function bodyFigureSvg(focus, wins) {
        const ACCENT = "#b4552d", SAGE = "#6e7f5c", SAGE_DEEP = "#5a6a4a";
        const grad = (id, c) => `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${c}" stop-opacity="0.9"/><stop offset="45%" stop-color="${c}" stop-opacity="0.42"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
        let grads = "", glows = "", marks = "";
        const region = (key, color, tag) => {
            (BM_FIG_REG[key] || []).forEach((g, i) => {
                const id = `bmfig-${tag}-${key}-${i}`;
                grads += grad(id, color);
                glows += `<ellipse cx="${g[0]}" cy="${g[1]}" rx="${g[2]}" ry="${g[3]}" fill="url(#${id})"/>`;
            });
        };
        if (focus)
            region(focus, ACCENT, "f");
        for (const k of wins)
            if (k !== focus)
                region(k, SAGE, "w");
        for (const k of wins)
            if (k !== focus)
                for (const g of BM_FIG_REG[k] || [])
                    marks += `<path d="M${g[0] - 4} ${g[1] + 2} L${g[0]} ${g[1] - 3} L${g[0] + 4} ${g[1] + 2}" fill="none" stroke="${SAGE_DEEP}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
        const aria = focus
            ? `Body figure highlighting the ${focus} as the focus area`
            : wins.length ? `Body figure highlighting ${wins.join(" and ")} as improving` : "Body figure";
        return `<svg class="bm-figure" viewBox="0 0 120 252" role="img" aria-label="${escAttr(aria)}" style="height:188px;width:auto;display:block">
    <defs><clipPath id="bmfig-clip">${BM_FIG_BODY}</clipPath>
      <linearGradient id="bmfig-base" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e7ddcb"/><stop offset="100%" stop-color="#dbcfb8"/></linearGradient>${grads}</defs>
    <g fill="url(#bmfig-base)">${BM_FIG_BODY}</g>
    <g clip-path="url(#bmfig-clip)">${glows}</g>
    <g fill="none" stroke="#c4b89d" stroke-width="1.4" stroke-linejoin="round">${BM_FIG_BODY}</g>
    ${marks}
  </svg>`;
    }
    // Map the deterministic focus lever + per-site trends onto body regions: a
    // central-fat lever glows the waist; a muscle site growing while the waist holds
    // glows that region sage (recomposition, not just gaining everywhere).
    function deriveFigureRegions(comp, trends) {
        const fk = comp.focus?.key;
        const focus = fk === "whtr" || fk === "whr" || fk === "bodyfat" ? "waist" : null;
        const sites = trends?.sites || [];
        const dir = (k) => sites.find((s) => s.key === k)?.direction || null;
        const wins = [];
        if (dir("waist_in") !== "up") {
            if (dir("upper_arm_in") === "up" || dir("forearm_in") === "up")
                wins.push("arms");
            if (dir("thigh_in") === "up" || dir("calf_in") === "up")
                wins.push("legs");
            if (dir("chest_in") === "up" || dir("shoulder_in") === "up")
                wins.push("chest");
        }
        return { focus, wins };
    }
    function compSection(comp, trends) {
        if (!comp)
            return "";
        const rows = comp.scales.map(zoneRow).filter(Boolean).join("");
        if (!rows)
            return "";
        const { focus: figFocus, wins } = deriveFigureRegions(comp, trends);
        const figure = `<div class="bm-figure-wrap" style="display:flex;justify-content:center;margin:4px 0 12px">${bodyFigureSvg(figFocus, wins)}</div>`;
        const hasProjection = comp.scales.some((s) => s.value != null && s.projected != null);
        const legend = `<div class="sess-line" style="color:var(--muted,#8a8578);font-size:.74rem;margin-top:2px">● now${hasProjection ? ` · ◌ in ~12 weeks at your current pace` : ""}</div>`;
        const heading = comp.heading
            ? `<div class="sess-line bm-heading" style="color:var(--muted,#8a8578);font-style:italic;margin-top:8px">${escHtml(comp.heading)}</div>`
            : "";
        const focus = comp.focus
            ? `<div class="bm-focus" style="border-left:3px solid var(--accent,#b4552d);background:color-mix(in srgb, var(--accent,#b4552d) 7%, transparent);border-radius:8px;padding:10px 12px;margin-top:10px">
        <div style="font-weight:600;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--accent,#b4552d);margin-bottom:3px">Where to point it</div>
        <div class="sess-line">${escHtml(comp.focus.line)}</div>
      </div>`
            : "";
        return `<div class="sess bm-comp reveal" style="padding:12px;margin-bottom:12px">
      <div class="bm-sechead" style="font-weight:600;margin-bottom:2px">Where you stand</div>
      ${figure}
      ${rows}${legend}${heading}${focus}
    </div>`;
    }
    function heightForm(profile, unit) {
        const inches = profile.height_in;
        const known = inches != null;
        const intro = `<div style="font-weight:600;margin-bottom:6px">${known ? "Height" : "Set your height"}</div>
      <div class="sess-line" style="color:var(--muted,#8a8578);margin-bottom:8px">${known ? "Used for BMI, waist-to-height and the body-fat estimate." : "BMI, waist-to-height and body-fat need your height."}</div>`;
        if (unit === "cm") {
            const cm = inches != null ? Math.round(inches * 2.54) : "";
            return `<div class="sess bm-height reveal" style="padding:12px">
      ${intro}
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="field" style="margin:0"><span>Centimeters</span><input id="bmHeightCm" class="form-input" type="number" inputmode="decimal" min="90" max="250" step="0.5" value="${escAttr(String(cm))}" style="width:7rem"></label>
        <button id="bmHeightSave" class="chip" type="button">Save height</button>
      </div>
    </div>`;
        }
        const ft = inches != null ? Math.floor(inches / 12) : "";
        const rem = inches != null ? Math.round((inches - Math.floor(inches / 12) * 12) * 10) / 10 : "";
        return `<div class="sess bm-height reveal" style="padding:12px">
      ${intro}
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="field" style="margin:0"><span>Feet</span><input id="bmHeightFt" class="form-input" type="number" inputmode="numeric" min="3" max="8" value="${escAttr(String(ft))}" style="width:5rem"></label>
        <label class="field" style="margin:0"><span>Inches</span><input id="bmHeightIn" class="form-input" type="number" inputmode="decimal" min="0" max="11.9" step="0.5" value="${escAttr(String(rem))}" style="width:5rem"></label>
        <button id="bmHeightSave" class="chip" type="button">Save height</button>
      </div>
    </div>`;
    }
    // The small ⓘ affordance on each site label — tap (or focus the input) and the
    // shared hint line under the intro shows how to place the tape for that site.
    function logForm(sites, unit) {
        // Local calendar day (localISO from date-utils) — a UTC slice would prefill
        // tomorrow's date for an evening tape session west of Greenwich.
        const today = typeof localISO === "function" ? localISO() : new Date().toISOString().slice(0, 10);
        const max = unit === "cm" ? 254 : 100;
        const inputs = sites
            .map((s) => {
            const info = s.hint
                ? `<button type="button" class="bm-info" data-site="${escAttr(s.key)}" data-label="${escAttr(s.label)}" data-hint="${escAttr(s.hint)}" aria-expanded="false" aria-label="How to measure: ${escAttr(s.label)}" style="width:15px;height:15px;border-radius:50%;border:1px solid var(--muted,#8a8578);color:var(--muted,#8a8578);background:transparent;font-size:.6rem;line-height:1;font-style:italic;font-family:var(--font-display,Georgia,serif);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none">i</button>`
                : "";
            return `<label class="field" style="margin:0"><span style="display:inline-flex;align-items:center;gap:5px">${escHtml(s.label)}${info}</span><input class="form-input bm-site" data-site="${escAttr(s.key)}" type="number" inputmode="decimal" min="1" max="${max}" step="0.1" placeholder="${unit}" style="width:100%"></label>`;
        })
            .join("");
        return `<details class="sess bm-log reveal" style="padding:12px">
      <summary style="font-weight:600;cursor:pointer">Log measurements</summary>
      <div class="sess-line" style="color:var(--muted,#8a8578);margin:6px 0 8px">Tape, relaxed, same time of day. Fill in what you measured — the rest stays blank. Tap ⓘ on any site for where the tape goes.</div>
      <div id="bmSiteHint" class="sess-line" role="status" aria-live="polite" hidden style="margin:0 0 10px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--sage,#6e7f5c) 10%, transparent);color:var(--ink,#2f2b23)"></div>
      <div class="bm-site-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(6.5rem,1fr));gap:8px">${inputs}</div>
      <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap">
        <label class="field" style="margin:0"><span>Date</span><input id="bmDate" class="form-input" type="date" value="${escAttr(today)}"></label>
        <label class="field" style="margin:0;flex:1;min-width:9rem"><span>Note</span><input id="bmNote" class="form-input" type="text" placeholder="optional" style="width:100%"></label>
        <button id="bmLogSave" class="chip" type="button">Log session</button>
      </div>
    </details>`;
    }
    function goalMovement(weight, profile) {
        if (profile.goal_weight_lb == null || weight.latest == null)
            return "";
        const remaining = Math.round((weight.latest - profile.goal_weight_lb) * 10) / 10;
        if (Math.abs(remaining) < 0.5)
            return `<span class="bm-goal" style="color:var(--sage,#6e7f5c)"> · at your goal weight</span>`;
        const dir = remaining > 0 ? "to lose" : "to gain";
        return `<span class="bm-goal" style="color:var(--muted,#8a8578)"> · ${escHtml(String(Math.abs(remaining)))} lb ${dir} to goal</span>`;
    }
    function trendRow(t, extra = "") {
        const spark = t.points.length >= 2 ? `<span class="bm-trend-spark">${sparklineSvg(t.points)}</span>` : "";
        const latest = t.latest != null ? `${escHtml(String(t.latest))} ${escHtml(t.unit)}` : "—";
        const arrow = t.direction === "down" ? "↓" : t.direction === "up" ? "↑" : t.direction === "steady" ? "→" : "";
        return `<div class="sess-line bm-trend-row" style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span class="bm-trend-label" style="min-width:6rem;font-weight:600">${escHtml(t.label)}</span>
      <span class="bm-trend-latest" style="min-width:5rem;color:var(--muted,#8a8578)">${latest} ${escHtml(arrow)}</span>
      ${spark}
      <span class="bm-trend-text" style="flex:1;color:var(--muted,#8a8578)">${escHtml(t.text)}${extra}</span>
    </div>`;
    }
    function unitToggle(unit) {
        const btn = (u) => `<button type="button" class="chip bm-unit-btn" data-unit="${u}" aria-pressed="${u === unit}" style="padding:2px 10px;font-size:.74rem${u === unit ? ";background:var(--ink,#2f2b23);color:var(--card,#faf6ec);border-color:var(--ink,#2f2b23)" : ""}">${u}</button>`;
        return `<div class="bm-unit" role="group" aria-label="Measurement units" style="display:flex;gap:4px">${btn("in")}${btn("cm")}</div>`;
    }
    function summaryHtml(data, unit) {
        const indicators = data.indicators.map(indicatorCard).join("");
        const trendSites = data.trends.sites.filter((s) => s.n >= 1).map((s) => trendRow(s)).join("");
        const weightRow = data.trends.weight.n >= 1 ? trendRow(data.trends.weight, goalMovement(data.trends.weight, data.profile)) : "";
        const empty = !data.latest
            ? `<div class="sess-line" style="color:var(--muted,#8a8578);padding:8px 0">No measurements yet — log a session below and your indicators + trends fill in.</div>`
            : "";
        const trends = trendSites || weightRow
            ? `<div class="bm-trends" style="margin-top:14px">
        <div class="bm-sechead" style="font-weight:600;margin-bottom:4px">Trends</div>
        ${weightRow}${trendSites}
      </div>`
            : "";
        return `<div class="bm-root">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="bm-eyebrow" style="text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--muted,#8a8578)">Body</div>
        ${unitToggle(unit)}
      </div>
      ${data.needs_height ? heightForm(data.profile, unit) : ""}
      ${compSection(data.comp, data.trends)}
      <div class="bm-indicators" style="display:grid;gap:8px;margin-bottom:12px">${indicators}</div>
      ${empty}
      ${!data.needs_height ? heightForm(data.profile, unit) : ""}
      ${logForm(data.sites, unit)}
      ${trends}
    </div>`;
    }
    async function loadAndRender(mount) {
        const unit = bmUnitPref();
        // Query the unit explicitly (server treats any non-"cm" value, incl. absent, as
        // inches) so the path reads as the covered "/body-metrics", not a phantom :param.
        const data = (await api(`/body-metrics?unit=${unit === "cm" ? "cm" : "in"}`));
        mount.innerHTML = summaryHtml(data, unit);
        wire(mount, unit);
    }
    function wire(mount, unit) {
        mount.querySelectorAll(".bm-unit-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const next = btn.dataset.unit === "cm" ? "cm" : "in";
                if (next === unit)
                    return;
                bmSetUnitPref(next);
                loadAndRender(mount).catch(() => toast("Could not switch units."));
            });
        });
        // ⓘ hints: tap toggles the shared hint line; focusing an input shows its site's
        // hint too (so guidance appears right when you're about to type).
        const hintBox = mount.querySelector("#bmSiteHint");
        let hintSite = null;
        const setExpanded = (site) => {
            mount.querySelectorAll(".bm-info").forEach((b) => {
                b.setAttribute("aria-expanded", String(b.dataset.site === site));
            });
        };
        const showHint = (site, label, hint) => {
            if (!hintBox)
                return;
            hintSite = site;
            hintBox.hidden = false;
            hintBox.textContent = `${label} — ${hint}`;
            setExpanded(site);
        };
        const clearHint = () => {
            if (!hintBox)
                return;
            hintSite = null;
            hintBox.hidden = true;
            hintBox.textContent = "";
            setExpanded(null);
        };
        mount.querySelectorAll(".bm-info").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const el = btn;
                const site = el.dataset.site || "";
                if (hintSite === site)
                    clearHint();
                else
                    showHint(site, el.dataset.label || "", el.dataset.hint || "");
            });
        });
        mount.querySelectorAll(".bm-site").forEach((input) => {
            input.addEventListener("focus", () => {
                const site = input.dataset.site || "";
                const btn = mount.querySelector(`.bm-info[data-site="${site}"]`);
                if (btn)
                    showHint(site, btn.dataset.label || "", btn.dataset.hint || "");
            });
        });
        const heightBtn = mount.querySelector("#bmHeightSave");
        if (heightBtn) {
            heightBtn.addEventListener("click", async () => {
                const inches = bmHeightInches(mount);
                if (inches == null) {
                    toast("Enter your height first.");
                    return;
                }
                try {
                    await api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height_in: inches }) });
                    toast("Height saved.");
                    await loadAndRender(mount);
                }
                catch {
                    toast("Could not save height.");
                }
            });
        }
        const logBtn = mount.querySelector("#bmLogSave");
        if (logBtn) {
            logBtn.addEventListener("click", async () => {
                const body = {};
                mount.querySelectorAll(".bm-site").forEach((el) => {
                    const site = el.dataset.site;
                    const value = bmNum(el);
                    if (site && value != null)
                        body[site] = value;
                });
                if (!Object.keys(body).length) {
                    toast("Fill in at least one measurement.");
                    return;
                }
                body.unit = unit; // values are typed in the display unit; the server stores inches
                const dateEl = mount.querySelector("#bmDate");
                const noteEl = mount.querySelector("#bmNote");
                if (dateEl?.value)
                    body.date = dateEl.value;
                if (noteEl?.value.trim())
                    body.note = noteEl.value.trim();
                try {
                    await api("/body-metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                    toast("Measurements logged.");
                    await loadAndRender(mount);
                }
                catch {
                    toast("Could not log measurements.");
                }
            });
        }
    }
    function renderBodyMetrics(mount) {
        if (!mount)
            return;
        mount.innerHTML = `<div class="bm-loading sess-line" style="color:var(--muted,#8a8578);padding:12px">Reading your measurements…</div>`;
        loadAndRender(mount).catch(() => {
            mount.innerHTML = `<div class="bm-error sess-line" style="color:var(--muted,#8a8578);padding:12px">Couldn't load body metrics right now.</div>`;
        });
    }
    const CAIRN_BODY_METRICS = { renderBodyMetrics, deriveFigureRegions, bodyFigureSvg };
    Object.assign(globalThis, { CairnBodyMetrics: CAIRN_BODY_METRICS, renderBodyMetrics });
    if (typeof window !== "undefined") {
        window.CairnBodyMetrics = CAIRN_BODY_METRICS;
    }
})();
})();
