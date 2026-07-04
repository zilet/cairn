(() => {
// @ts-check
// Body Metrics — a calm at-home measurements + indicators + trend view.
//
// Self-contained: renderBodyMetrics(mount) fetches /api/body-metrics and paints,
// top to bottom: a "Log a tape session" action card (always one tap from the top,
// open by default until the first session exists), the "Where you stand" hero —
// a fitting-sheet FIGURE: one continuous croquis silhouette whose outline widths
// are drawn from YOUR latest tape in true proportion to your height, a dashed
// sage trace of the optimal waistline for your height (waist ≤ half height)
// drawn inside the outline it's converging toward, and hairline callouts
// annotating each measured site with its value + the move since the last tape
// (falling back to the 6-month trend arrow). With two or more sessions the
// figure MORPHS on load from the previous session's proportions into today's —
// you watch the tape move (skipped under prefers-reduced-motion) — plus the
// deterministic heading + ONE focus lever; then "The numbers"
// (each indicator on its evidence-anchored zone bands with a "you are here" dot,
// a dashed "heading here at the current pace" marker and its plain-language read
// folded into the same row — words and position, never a score); then per-site
// sparkline trends. An in/cm unit toggle (default derived from the browser
// locale, persisted locally; storage stays inches server-side) and an optional
// "set your height" affordance (unlocks BMI/body-fat) round it out. Atelier-
// flavoured with existing classes + inline styles only, so it ships without a
// stylesheet change.
(() => {
    // Fills (band segments) vs text (band words): gold is a fill, too light for
    // text; sage needs its darker text token at small sizes (see docs/DESIGN.md).
    const BM_TONE_COLOR = {
        ok: "var(--sage, #6e7f5c)",
        watch: "var(--gold, #c9a86a)",
        warn: "var(--warn, #b3402e)",
        info: "var(--muted, #746c5c)",
    };
    const BM_TONE_TEXT = {
        ok: "var(--sage-text, #5f6e4f)",
        watch: "var(--gold-deep, #8a6d2e)",
        warn: "var(--warn, #b3402e)",
        info: "var(--muted, #746c5c)",
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
    // Croquis fallbacks (inches) for sites not yet taped — the figure always draws.
    const BM_FIG_DEFAULT = {
        male: { neck_in: 15, shoulder_in: 45, chest_in: 39, waist_in: 33, hip_in: 37.5, thigh_in: 21.5, upper_arm_in: 12.5, forearm_in: 11, calf_in: 14.5 },
        female: { neck_in: 12.5, shoulder_in: 39, chest_in: 35, waist_in: 28, hip_in: 38, thigh_in: 21.5, upper_arm_in: 10.5, forearm_in: 9.5, calf_in: 13.5 },
    };
    const BM_FIG_INK = "#211d17";
    const BM_FIG_MUTED = "#746c5c";
    const BM_FIG_ACCENT = "#b4552d";
    const BM_FIG_SAGE_DEEP = "#5a6a4a";
    const BM_FIG_LINE = "#c4b89d";
    const BM_SITE_KEYS = ["neck_in", "shoulder_in", "chest_in", "waist_in", "hip_in", "thigh_in", "upper_arm_in", "forearm_in", "calf_in"];
    const bmR = (n) => Math.round(n * 10) / 10;
    // Catmull-Rom → cubic Bézier through a CLOSED loop of points: the one smoothing
    // pass that turns the station half-widths into a confident continuous line.
    function bmLoopPath(pts) {
        const n = pts.length;
        let d = `M${bmR(pts[0][0])} ${bmR(pts[0][1])}`;
        for (let i = 0; i < n; i++) {
            const p0 = pts[(i - 1 + n) % n];
            const p1 = pts[i];
            const p2 = pts[(i + 1) % n];
            const p3 = pts[(i + 2) % n];
            d += ` C${bmR(p1[0] + (p2[0] - p0[0]) / 6)} ${bmR(p1[1] + (p2[1] - p0[1]) / 6)} ${bmR(p2[0] - (p3[0] - p1[0]) / 6)} ${bmR(p2[1] - (p3[1] - p1[1]) / 6)} ${bmR(p2[0])} ${bmR(p2[1])}`;
        }
        return `${d} Z`;
    }
    // Same smoothing, open-ended (the optimal-waistline ghost trace).
    function bmOpenPath(pts) {
        const n = pts.length;
        const at = (i) => pts[Math.min(n - 1, Math.max(0, i))];
        let d = `M${bmR(pts[0][0])} ${bmR(pts[0][1])}`;
        for (let i = 0; i < n - 1; i++) {
            const p0 = at(i - 1);
            const p1 = at(i);
            const p2 = at(i + 1);
            const p3 = at(i + 2);
            d += ` C${bmR(p1[0] + (p2[0] - p0[0]) / 6)} ${bmR(p1[1] + (p2[1] - p0[1]) / 6)} ${bmR(p2[0] - (p3[0] - p1[0]) / 6)} ${bmR(p2[1] - (p3[1] - p1[1]) / 6)} ${bmR(p2[0])} ${bmR(p2[1])}`;
        }
        return d;
    }
    // A tape session fills in only what was measured — so the figure reads each
    // site's LATEST KNOWN value across sessions, not just the newest row, and a
    // quick waist-only re-tape never blanks last month's chest. The API lists
    // measurements chronologically (for charting), so sort newest-first here rather
    // than lean on payload order.
    function mergeLatestSites(measurements, latest) {
        const rows = (measurements && measurements.length ? [...measurements] : latest ? [latest] : []).sort((a, b) => {
            if (a.date !== b.date)
                return a.date > b.date ? -1 : 1;
            return (b.id ?? 0) - (a.id ?? 0);
        });
        if (!rows.length)
            return null;
        const merged = { ...rows[0] };
        for (const k of BM_SITE_KEYS) {
            if (merged[k] != null)
                continue;
            for (const r of rows) {
                if (r[k] != null) {
                    merged[k] = r[k];
                    break;
                }
            }
        }
        return merged;
    }
    // The fitting sheet one session ago: drop the newest session and merge the
    // rest — the "then" frame the figure morphs from, and what the per-site deltas
    // read against. Null until a second session exists.
    function mergePreviousSites(measurements, latest) {
        const rows = (measurements && measurements.length ? [...measurements] : latest ? [latest] : []).sort((a, b) => {
            if (a.date !== b.date)
                return a.date > b.date ? -1 : 1;
            return (b.id ?? 0) - (a.id ?? 0);
        });
        if (rows.length < 2)
            return null;
        return mergeLatestSites(rows.slice(1), null);
    }
    function bmFmt(n) {
        return String(Math.round(n * 10) / 10);
    }
    function bodyFigureSvg(inp) {
        const female = String(inp.sex || "").toLowerCase() === "female";
        const D = BM_FIG_DEFAULT[female ? "female" : "male"];
        const hIn = Math.min(90, Math.max(48, inp.heightIn ?? (female ? 64 : 69)));
        const s = 210 / hIn; // px per inch — the drawn body height is constant
        // Latest tape in inches (payload values arrive in the display unit).
        const inVal = (k) => {
            const raw = inp.latest ? inp.latest[k] : null;
            if (raw == null || !Number.isFinite(raw))
                return null;
            return inp.unit === "cm" ? raw / 2.54 : raw;
        };
        const circ = (k) => inVal(k) ?? D[k];
        const measured = (k) => inVal(k) != null;
        const dispVal = (k) => bmFmt(inp.latest?.[k] ?? 0);
        // Circumference → frontal half-width. Torso cross-sections are elliptical
        // (wider than deep), limbs near-circular; clamps keep a typo'd tape humane.
        const torsoRx = (c) => Math.min(52, Math.max(8, (c / 5.4) * s));
        const shoulderRx = (c) => Math.min(56, Math.max(10, (c / 5.1) * s));
        const limbRx = (c) => Math.min(24, Math.max(3.5, (c / 6) * s));
        const neckRx = (c) => Math.min(16, Math.max(3.5, (c / 6.3) * s));
        const CX = 170;
        const chestR = torsoRx(circ("chest_in"));
        const waistR = torsoRx(circ("waist_in"));
        const hipR = torsoRx(circ("hip_in"));
        const shR = shoulderRx(circ("shoulder_in"));
        const neckR = neckRx(circ("neck_in"));
        const armR = limbRx(circ("upper_arm_in"));
        const foreR = limbRx(circ("forearm_in"));
        const thighR = limbRx(circ("thigh_in"));
        const calfR = limbRx(circ("calf_in"));
        const thighCx = Math.max(hipR * 0.52, thighR * 0.9) + 0.5;
        const kneeCx = hipR * 0.45 + 2;
        const kneeW = Math.max(3.5, (thighR + calfR) * 0.3);
        const ankleW = Math.max(2.5, calfR * 0.45);
        const neckW = Math.min(neckR * 0.82, 8.2); // visibly narrower than the head
        // The right-hand outline, head → neck → shoulder → chest → waist → hip →
        // outer leg → foot → back up the inner leg (dx offsets from the centerline);
        // the closed loop mirrors it through the head-top and crotch center points.
        // Human landmarks matter more than smoothness here: a defined chin and a
        // narrow under-jaw neck, a trapezius slope breaking at the acromion, an
        // armpit, and feet that read as feet.
        const side = [
            [3.6, 12.2], // crown
            [8.4, 15.5], // temple
            [9.6, 23], // head widest
            [8.5, 30.5], // cheek
            [5.4, 36.5], // jaw
            [3.1, 39.4], // chin corner
            [neckW, 42.5], // under-jaw neck
            [neckW * 1.04, 50], // neck base
            [neckW + 3.2, 53.2], // trapezius rise
            [shR * 0.86, 57.5], // trap → acromion
            [shR, 62], // shoulder point
            [chestR * 1.01, 69.5], // armpit
            [chestR, 76], // chest widest
            [(chestR + waistR) * 0.49, 90],
            [waistR, 106], // natural waist
            [(waistR + hipR) * 0.5, 119],
            [hipR, 131], // hip widest
            [hipR * 0.97, 138],
            [thighCx + thighR, 155], // outer thigh
            [kneeCx + kneeW, 186], // outer knee
            [kneeCx + calfR, 199], // calf
            [kneeCx + ankleW, 215], // ankle
            [kneeCx + ankleW + 6.5, 222], // toe
            [kneeCx - ankleW - 1.5, 224], // heel
            [kneeCx - calfR * 0.8, 199], // inner calf
            [kneeCx - kneeW * 0.85, 186], // inner knee
            [thighCx - thighR * 0.85, 157], // inner thigh
        ];
        const corePath = bmLoopPath([
            [CX, 11.5],
            ...side.map(([dx, y]) => [CX + dx, y]),
            [CX, 143],
            ...[...side].reverse().map(([dx, y]) => [CX - dx, y]),
        ]);
        // Arms hang FROM THE SHOULDER along a slightly abducted axis — tilted out
        // just enough that the forearm clears the waist and hip with a small gap, so
        // the waistline stays readable without the arms reading as bolted on.
        const ax0 = shR * 0.8; // shoulder pivot x
        const ax1 = Math.max(ax0 + (waistR + 1.5 + foreR * 0.85 - ax0) / 0.649, // clears the waist (y≈106)
        ax0 + (hipR + 1.5 + foreR * 0.6 - ax0) / 0.986, // clears the hip (y≈131)
        ax0 + 6); // wrist-line x
        const ax = (y) => ax0 + (ax1 - ax0) * ((y - 58) / 74);
        const armSide = [
            [shR * 0.55, 55], // tucked under the trap (covered by the torso)
            [ax(66) + armR * 1.05, 67], // deltoid
            [ax(80) + armR * 0.9, 80],
            [ax(97) + armR * 0.72, 97], // outer elbow
            [ax(110) + foreR * 0.95, 110], // forearm
            [ax(126) + foreR * 0.55, 126], // wrist
            [ax(138) + foreR * 0.5, 138], // palm
            [ax(146) + 1.5, 146], // fingertips
            [ax(140) - foreR * 0.5, 141],
            [ax(127) - foreR * 0.5, 128], // inner wrist
            [ax(110) - foreR * 0.85, 110], // inner forearm
            [ax(98) - armR * 0.7, 98], // inner elbow
            [ax(78) - armR * 0.8, 78], // inner upper arm
            [ax(66) - armR * 0.6, 64], // armpit
        ];
        const armPath = (sign) => bmLoopPath(armSide.map(([dx, y]) => [CX + sign * dx, y]));
        // Arms first, torso over them: the core path's fill hides the arm strokes at
        // the shoulder junction, so the silhouette reads as one figure.
        const body = `<path d="${armPath(-1)}" fill="url(#bmfig-base)"/><path d="${armPath(1)}" fill="url(#bmfig-base)"/><path d="${corePath}" fill="url(#bmfig-base)"/>`;
        // ONE glow: a soft radial field (bright center fading to nothing) over the
        // FOCUS region only, clipped inside the silhouette so the light never spills
        // past the body line — torso glows clip to the core, arm glows to the arms.
        // Winning regions get quiet chevrons instead of light; glowing several
        // regions at once turned the whole figure into a smudge and buried the one
        // story that matters. The glow breathes via the CSS .bm-pulse animation
        // (stilled under reduced motion).
        const washFor = (region, grad) => {
            const e = (cx, cy, rx, ry, clip) => `<g clip-path="url(#${clip})"><ellipse class="bm-pulse" cx="${bmR(cx)}" cy="${cy}" rx="${bmR(rx)}" ry="${ry}" fill="url(#${grad})"/></g>`;
            if (region === "waist")
                return e(CX, 106, waistR + 14, 26, "bmfig-clip-core");
            if (region === "chest")
                return e(CX, 72, chestR + 12, 24, "bmfig-clip-core");
            if (region === "arms")
                return e(CX - ax(98), 98, armR + 10, 50, "bmfig-clip-arms") + e(CX + ax(98), 98, armR + 10, 50, "bmfig-clip-arms");
            if (region === "legs")
                return e(CX - thighCx, 186, thighR + 12, 56, "bmfig-clip-core") + e(CX + thighCx, 186, thighR + 12, 56, "bmfig-clip-core");
            return "";
        };
        const glowStops = (hex, peak) => `<stop offset="0%" stop-color="${hex}" stop-opacity="${peak}"/><stop offset="65%" stop-color="${hex}" stop-opacity="${bmR(peak * 0.55 * 100) / 100}"/><stop offset="100%" stop-color="${hex}" stop-opacity="0"/>`;
        let glowDefs = "";
        let tintLayer = "";
        if (inp.focus) {
            glowDefs += `<radialGradient id="bmfig-glow-a">${glowStops(BM_FIG_ACCENT, 0.38)}</radialGradient>`;
            tintLayer += washFor(inp.focus, "bmfig-glow-a");
        }
        const winRegions = (inp.wins || []).filter((w) => w !== inp.focus);
        // One chevron per winning region's primary mass (chest / upper arms / thighs) —
        // marking every station turned the figure into noise.
        let marks = "";
        const chevron = (cx, y) => `<path d="M${bmR(cx - 4)} ${bmR(y + 5)} L${bmR(cx)} ${bmR(y)} L${bmR(cx + 4)} ${bmR(y + 5)}" fill="none" stroke="${BM_FIG_SAGE_DEEP}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
        for (const w of winRegions) {
            if (w === "chest")
                marks += chevron(CX, 68);
            if (w === "arms")
                marks += chevron(CX - ax(72), 72) + chevron(CX + ax(72), 72);
            if (w === "legs")
                marks += chevron(CX - thighCx, 150) + chevron(CX + thighCx, 150);
        }
        // The optimal-waistline ghost: a dashed sage indent traced INSIDE the outline
        // at the width the waist is heading toward, drawn only when the measured
        // waist sits above the band (a leaner-than-optimal waist needs no target
        // drawn over it). Same blend stations as the silhouette, so the two lines
        // read as one converging on the other.
        const waistIn = inVal("waist_in");
        const optWaistIn = inp.heightIn != null ? 0.5 * Math.min(90, Math.max(48, inp.heightIn)) : null;
        const showOpt = waistIn != null && optWaistIn != null && waistIn > optWaistIn + 0.2;
        const optR = optWaistIn != null ? torsoRx(optWaistIn) : 0;
        let optTrace = "";
        if (showOpt) {
            const tracePts = (sign) => [
                [CX + sign * (chestR + optR) * 0.48, 88],
                [CX + sign * optR, 106],
                [CX + sign * (optR + hipR) * 0.5, 118],
            ];
            const traceAttrs = `fill="none" stroke="${BM_FIG_SAGE_DEEP}" stroke-width="1.5" stroke-dasharray="4 3" stroke-linecap="round" opacity="0.95"`;
            optTrace = `<path d="${bmOpenPath(tracePts(1))}" ${traceAttrs}/><path d="${bmOpenPath(tracePts(-1))}" ${traceAttrs}/>`;
        }
        // Only moving sites get an arrow — a "steady →" glyph next to a leader line
        // reads as pointing at the figure.
        const arrow = (k) => {
            const d = inp.dirs ? inp.dirs[k] : null;
            return d === "down" ? "↓" : d === "up" ? "↑" : "";
        };
        const deltaFor = (k) => {
            const d = inp.deltas ? inp.deltas[k] : null;
            return d != null && Number.isFinite(d) ? d : null;
        };
        const cos = [];
        const add = (k, side, segY, edge, name) => {
            if (!measured(k))
                return;
            cos.push({ side, segY, x1: side === "R" ? CX + edge + 3 : CX - edge - 3, name, val: dispVal(k), dir: arrow(k), d: deltaFor(k), site: k, accent: k === "waist_in" && inp.focus === "waist" });
        };
        add("chest_in", "R", 71, chestR, "chest");
        add("waist_in", "R", 106, waistR, "waist");
        if (showOpt)
            cos.push({ side: "R", segY: 112, x1: CX + optR + 2, name: "optimal", val: bmFmt(inp.unit === "cm" ? optWaistIn * 2.54 : optWaistIn), dir: "", sage: true });
        add("hip_in", "R", 131, hipR, "hip");
        add("thigh_in", "R", 159, thighCx + thighR, "thigh");
        add("calf_in", "R", 205, kneeCx + calfR, "calf");
        add("neck_in", "L", 46, neckW + 1, "neck");
        add("shoulder_in", "L", 60, shR + 1.5, "shoulder");
        add("upper_arm_in", "L", 76, ax(76) + armR, "arm");
        add("forearm_in", "L", 114, ax(114) + foreR, "forearm");
        // A move since the last tape reads as "↓1.5" next to the value; without one,
        // the 6-month trend arrow stands in. Thresholds keep tape noise quiet.
        const moveThresh = inp.unit === "cm" ? 0.5 : 0.2;
        let callouts = "";
        for (const side of ["L", "R"]) {
            const rail = cos.filter((c) => c.side === side).sort((a, b) => a.segY - b.segY);
            let prevY = 6;
            for (const c of rail) {
                const y = Math.min(232, Math.max(prevY + 14, c.segY));
                prevY = y;
                const tx = side === "R" ? 254 : 86;
                const lineEnd = side === "R" ? tx - 4 : tx + 4;
                const color = c.accent ? BM_FIG_ACCENT : c.sage ? BM_FIG_SAGE_DEEP : BM_FIG_INK;
                const nameColor = c.accent ? BM_FIG_ACCENT : c.sage ? BM_FIG_SAGE_DEEP : BM_FIG_MUTED;
                const tail = c.d != null && Math.abs(c.d) >= moveThresh
                    ? `<tspan dx="3" font-size="8.5" fill="${BM_FIG_MUTED}">${c.d < 0 ? "↓" : "↑"}${escHtml(bmFmt(Math.abs(c.d)))}</tspan>`
                    : c.dir
                        ? `<tspan dx="2" font-size="9.5" fill="${BM_FIG_MUTED}">${escHtml(c.dir)}</tspan>`
                        : "";
                callouts += `<line x1="${c.x1}" y1="${c.segY}" x2="${lineEnd}" y2="${y - 3}" stroke="${BM_FIG_LINE}" stroke-width="1" stroke-dasharray="1.5 2.5"/>`;
                const label = `<text x="${tx}" y="${y}" text-anchor="${side === "R" ? "start" : "end"}" font-family="ui-sans-serif, system-ui, sans-serif"><tspan font-size="8.2" letter-spacing="0.08em" fill="${nameColor}"${c.sage ? ` font-style="italic"` : ""}>${escHtml(c.name.toUpperCase())}</tspan><tspan dx="4" font-size="11.5" font-weight="600" font-family="ui-serif, Georgia, serif" fill="${color}">${escHtml(c.val)}</tspan>${tail}</text>`;
                // Measured-site callouts tap through to that site's trend row; the
                // transparent rect gives the small SVG text a finger-sized hit area.
                callouts += c.site
                    ? `<g class="bm-co" data-site="${escAttr(c.site)}" role="button" tabindex="0" aria-label="See the ${escAttr(c.name)} trend" style="cursor:pointer"><rect x="${side === "R" ? tx - 2 : tx - 88}" y="${y - 11}" width="90" height="15" fill="transparent"/>${label}</g>`
                    : label;
            }
        }
        const measuredList = cos.filter((c) => !c.sage).map((c) => `${c.name} ${c.val}`).join(", ");
        const aria = measuredList
            ? `Your body drawn from the tape: ${measuredList} ${inp.unit}${showOpt ? `; the dashed line traces the optimal waist for your height, about ${bmFmt(inp.unit === "cm" ? optWaistIn * 2.54 : optWaistIn)} ${inp.unit}` : ""}.`
            : "A body figure — log a tape session and it redraws to your measurements.";
        return `<svg class="bm-figure" viewBox="0 0 340 240" width="100%" role="img" aria-label="${escAttr(aria)}" style="display:block;max-width:420px;margin:0 auto">
    <defs>
      <linearGradient id="bmfig-base" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e7ddcb"/><stop offset="100%" stop-color="#dbcfb8"/></linearGradient>
      <clipPath id="bmfig-clip-core"><path d="${corePath}"/></clipPath>
      <clipPath id="bmfig-clip-arms"><path d="${armPath(-1)}"/><path d="${armPath(1)}"/></clipPath>
      ${glowDefs}
    </defs>
    <g stroke="${BM_FIG_LINE}" stroke-width="1.1">${body}</g>
    ${tintLayer}${optTrace}${marks}${callouts}
  </svg>`;
    }
    // Map the deterministic focus lever + per-site trends onto body regions: a
    // central-fat lever points at the waist; a muscle site growing while the waist
    // holds reads as a win in that region (recomposition, not just gaining
    // everywhere).
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
    function figureModel(data, unit) {
        const { focus, wins } = data.comp ? deriveFigureRegions(data.comp, data.trends) : { focus: null, wins: [] };
        const dirs = {};
        for (const t of data.trends?.sites || [])
            dirs[t.key] = t.direction;
        const merged = mergeLatestSites(data.measurements, data.latest);
        const prev = mergePreviousSites(data.measurements, data.latest);
        const deltas = {};
        for (const k of BM_SITE_KEYS) {
            const a = prev ? prev[k] : null;
            const b = merged ? merged[k] : null;
            deltas[k] = a != null && b != null ? Math.round((b - a) * 10) / 10 : null;
        }
        return {
            merged,
            prev,
            deltas,
            base: { heightIn: data.profile?.height_in ?? null, sex: data.profile?.sex || "male", unit, focus, wins, dirs },
        };
    }
    function compSection(data, unit) {
        const comp = data.comp;
        if (!comp)
            return "";
        const m = figureModel(data, unit);
        const figure = bodyFigureSvg({ latest: m.merged, deltas: m.deltas, ...m.base });
        // Mention the dashed trace only when the figure actually draws it (waist
        // measured, height known, and the waist sits above the optimal band); a
        // waist already at or under half height earns the quiet sage read instead.
        const waistIn = m.merged?.waist_in != null ? (unit === "cm" ? m.merged.waist_in / 2.54 : m.merged.waist_in) : null;
        const optDrawn = waistIn != null && data.profile?.height_in != null && waistIn > 0.5 * data.profile.height_in + 0.2;
        const inBand = waistIn != null && data.profile?.height_in != null && !optDrawn;
        const legendBits = [`tape · ${unit === "cm" ? "centimeters" : "inches"}`];
        if (optDrawn)
            legendBits.push(`<span style="color:var(--sage-text,#5f6e4f)">┄ the optimal waist for your height</span>`);
        else if (inBand)
            legendBits.push(`<span style="color:var(--sage-text,#5f6e4f)">waist inside the optimal band for your height</span>`);
        const legend = data.latest
            ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.74rem;text-align:center;margin-top:6px">${legendBits.join(" · ")}</div>`
            : `<div class="sess-line" style="color:var(--muted,#746c5c);text-align:center;margin-top:6px">Log your first tape session above and the figure redraws to your measurements.</div>`;
        const heading = comp.heading
            ? `<div class="sess-line bm-heading" style="color:var(--ink-2,#57503f);margin-top:12px">${escHtml(comp.heading)}</div>`
            : "";
        const focus = comp.focus
            ? `<div class="bm-focus" style="border-left:3px solid var(--accent,#b4552d);background:var(--accent-wash,rgba(180,85,45,.1));border-radius:8px;padding:10px 12px;margin-top:10px">
        <div style="font-weight:600;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--accent,#b4552d);margin-bottom:3px">Where to point it</div>
        <div class="sess-line">${escHtml(comp.focus.line)}</div>
      </div>`
            : "";
        return `<div class="sess bm-comp reveal" style="padding:14px 12px;margin-bottom:12px">
      <div class="bm-sechead" style="font-weight:600;margin-bottom:8px">Where you stand</div>
      <div class="bm-figure-slot">${figure}</div>
      ${legend}${heading}${focus}
    </div>`;
    }
    // --- the numbers: zone bars with the reads folded in ----------------------------
    // Each indicator drawn on its plain-language bands: the optimal band reads
    // stronger, a solid dot marks today, a dashed hollow dot marks where the current
    // pace lands in ~12 weeks. Words and position, never a score.
    function zoneBarSvg(s) {
        const W = 300;
        const H = 26;
        const PAD = 8;
        const barY = 6;
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
        const optLabel = `<text x="${optMid}" y="${barY + barH + 11}" text-anchor="middle" font-size="9" fill="${BM_TONE_TEXT.ok}" font-weight="600">optimal</text>`;
        let proj = "";
        if (s.projected != null && s.value != null && Math.abs(s.projected - s.value) > span / 100) {
            const x1 = x(s.value);
            const x2 = x(s.projected);
            proj = `<line x1="${x1}" y1="${barY + barH / 2}" x2="${x2}" y2="${barY + barH / 2}" stroke="var(--ink,#211d17)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.55"/>
      <circle cx="${x2}" cy="${barY + barH / 2}" r="4" fill="var(--card,#fffdf8)" stroke="var(--ink,#211d17)" stroke-width="1.4" stroke-dasharray="2 2"/>`;
        }
        const cur = s.value != null ? `<circle cx="${x(s.value)}" cy="${barY + barH / 2}" r="4.5" fill="var(--ink,#211d17)"/>` : "";
        const aria = `${s.label}: ${s.value != null ? `${s.value}${s.unit || ""}` : "not measured"}${s.projected != null ? `, heading to about ${s.projected}${s.unit || ""} in ${s.horizon_weeks} weeks at the current pace` : ""}`;
        return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${escAttr(aria)}" style="display:block">${segs}${optLabel}${proj}${cur}</svg>`;
    }
    function zoneRow(s, ind, i) {
        const divider = i > 0 ? "border-top:1px solid var(--line,#e7dfd2);" : "";
        const est = s.estimate ? `<span style="color:var(--muted,#746c5c);font-size:.72rem"> · estimate</span>` : "";
        if (s.value == null) {
            const read = ind?.read || "";
            return `<div class="bm-zone-row" style="${divider}padding:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span style="font-weight:600;color:var(--muted,#746c5c)">${escHtml(s.label)}${est}</span>
        <span style="color:var(--muted,#746c5c)">—</span>
      </div>
      ${read ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.8rem;margin-top:2px">${escHtml(read)}</div>` : ""}
    </div>`;
        }
        const band = s.bands.find((b) => s.value >= b.from && s.value < b.to) || s.bands[s.bands.length - 1];
        const color = BM_TONE_TEXT[band?.tone || "info"];
        return `<div class="bm-zone-row" style="${divider}padding:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span style="font-weight:600">${escHtml(s.label)}${est}</span>
        <span style="display:inline-flex;align-items:baseline;gap:7px"><span style="font-family:var(--font-display, ui-serif, Georgia, serif);font-size:1.05rem;font-weight:620">${escHtml(String(s.value))}${escHtml(s.unit || "")}</span><span style="color:${color};font-size:.78rem;font-weight:600">${escHtml(band?.label || "")}</span></span>
      </div>
      ${zoneBarSvg(s)}
      ${s.read ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.8rem;margin-top:4px">${escHtml(s.read)}</div>` : ""}
    </div>`;
    }
    function numbersSection(data) {
        const comp = data.comp;
        if (!comp || !comp.scales.length)
            return "";
        const byKey = Object.fromEntries((data.indicators || []).map((i) => [i.key, i]));
        const rows = comp.scales.map((s, i) => zoneRow(s, byKey[s.key], i)).join("");
        const hasProjection = comp.scales.some((s) => s.value != null && s.projected != null);
        const legend = `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.74rem;margin-top:2px">● now${hasProjection ? ` · ◌ in ~12 weeks at your current pace` : ""}</div>`;
        return `<div class="sess bm-nums reveal" style="padding:12px;margin-bottom:12px">
      <div class="bm-sechead" style="font-weight:600;margin-bottom:2px">The numbers</div>
      ${rows}${legend}
    </div>`;
    }
    function heightForm(profile, unit) {
        const inches = profile.height_in;
        const known = inches != null;
        const intro = `<div style="font-weight:600;margin-bottom:6px">${known ? "Height" : "Set your height"}</div>
      <div class="sess-line" style="color:var(--muted,#746c5c);margin-bottom:8px">${known ? "Used for BMI, waist-to-height and the body-fat estimate." : "BMI, waist-to-height and body-fat need your height."}</div>`;
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
    // --- log a tape session: the top action card -------------------------------------
    // One tap from the top of the view (the monthly loop is glance → tape → log, so
    // entry never lives below the fold). Collapsed it reads as a single action row
    // with "last taped …"; open by default until the first session exists. The small
    // ⓘ affordance on each site label — tap (or focus the input) and the shared hint
    // line under the intro shows how to place the tape for that site.
    function logForm(data, unit) {
        const sites = data.sites || [];
        // Local calendar day (localISO from date-utils) — a UTC slice would prefill
        // tomorrow's date for an evening tape session west of Greenwich.
        const today = typeof localISO === "function" ? localISO() : new Date().toISOString().slice(0, 10);
        const max = unit === "cm" ? 254 : 100;
        const inputs = sites
            .map((s) => {
            const info = s.hint
                ? `<button type="button" class="bm-info" data-site="${escAttr(s.key)}" data-label="${escAttr(s.label)}" data-hint="${escAttr(s.hint)}" aria-expanded="false" aria-label="How to measure: ${escAttr(s.label)}" style="width:15px;height:15px;border-radius:50%;border:1px solid var(--muted,#746c5c);color:var(--muted,#746c5c);background:transparent;font-size:.6rem;line-height:1;font-style:italic;font-family:var(--font-display,Georgia,serif);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none">i</button>`
                : "";
            return `<label class="field" style="margin:0"><span style="display:inline-flex;align-items:center;gap:5px">${escHtml(s.label)}${info}</span><input class="form-input bm-site" data-site="${escAttr(s.key)}" type="number" inputmode="decimal" min="1" max="${max}" step="0.1" placeholder="${unit}" style="width:100%"></label>`;
        })
            .join("");
        const last = data.latest?.date && typeof relAge === "function"
            ? `<span style="color:var(--muted,#746c5c);font-size:.78rem;font-weight:400">last taped ${escHtml(relAge(data.latest.date))}</span>`
            : "";
        return `<details class="sess bm-log reveal"${data.latest ? "" : " open"} style="padding:0;overflow:hidden">
      <summary style="list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:13px 14px;cursor:pointer">
        <span style="display:inline-flex;align-items:center;gap:8px;font-weight:600;color:var(--accent,#b4552d)"><span aria-hidden="true" style="font-size:1.05rem;line-height:1">＋</span>Log a tape session</span>
        ${last}
      </summary>
      <div style="padding:0 14px 14px">
        <div class="sess-line" style="color:var(--muted,#746c5c);margin:0 0 8px">Tape, relaxed, same time of day. Fill in what you measured — the rest stays blank. Tap ⓘ on any site for where the tape goes.</div>
        <div id="bmSiteHint" class="sess-line" role="status" aria-live="polite" hidden style="margin:0 0 10px;padding:8px 10px;border-radius:8px;background:var(--sage-bg,#eef0e6);color:var(--ink,#211d17)"></div>
        <div class="bm-site-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(6.5rem,1fr));gap:8px">${inputs}</div>
        <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap">
          <label class="field" style="margin:0"><span>Date</span><input id="bmDate" class="form-input" type="date" value="${escAttr(today)}"></label>
          <label class="field" style="margin:0;flex:1;min-width:9rem"><span>Note</span><input id="bmNote" class="form-input" type="text" placeholder="optional" style="width:100%"></label>
          <button id="bmLogSave" class="chip" type="button">Log session</button>
        </div>
      </div>
    </details>`;
    }
    function goalMovement(weight, profile) {
        if (profile.goal_weight_lb == null || weight.latest == null)
            return "";
        const remaining = Math.round((weight.latest - profile.goal_weight_lb) * 10) / 10;
        if (Math.abs(remaining) < 0.5)
            return `<span class="bm-goal" style="color:var(--sage-text,#5f6e4f)"> · at your goal weight</span>`;
        const dir = remaining > 0 ? "to lose" : "to gain";
        return `<span class="bm-goal" style="color:var(--muted,#746c5c)"> · ${escHtml(String(Math.abs(remaining)))} lb ${dir} to goal</span>`;
    }
    function trendRow(t, extra = "") {
        const spark = t.points.length >= 2 ? `<span class="bm-trend-spark">${sparklineSvg(t.points)}</span>` : "";
        const latest = t.latest != null ? `${escHtml(String(t.latest))} ${escHtml(t.unit)}` : "—";
        const arrow = t.direction === "down" ? "↓" : t.direction === "up" ? "↑" : t.direction === "steady" ? "→" : "";
        return `<div class="sess-line bm-trend-row" data-trend="${escAttr(t.key)}" style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span class="bm-trend-label" style="min-width:6rem;font-weight:600">${escHtml(t.label)}</span>
      <span class="bm-trend-latest" style="min-width:5rem;color:var(--muted,#746c5c)">${latest} ${escHtml(arrow)}</span>
      ${spark}
      <span class="bm-trend-text" style="flex:1;color:var(--muted,#746c5c)">${escHtml(t.text)}${extra}</span>
    </div>`;
    }
    function unitToggle(unit) {
        const btn = (u) => `<button type="button" class="chip bm-unit-btn" data-unit="${u}" aria-pressed="${u === unit}" style="padding:2px 10px;font-size:.74rem${u === unit ? ";background:var(--ink,#211d17);color:var(--card,#fffdf8);border-color:var(--ink,#211d17)" : ""}">${u}</button>`;
        return `<div class="bm-unit" role="group" aria-label="Measurement units" style="display:flex;gap:4px">${btn("in")}${btn("cm")}</div>`;
    }
    function summaryHtml(data, unit) {
        const trendSites = data.trends.sites.filter((s) => s.n >= 1).map((s) => trendRow(s)).join("");
        const weightRow = data.trends.weight.n >= 1 ? trendRow(data.trends.weight, goalMovement(data.trends.weight, data.profile)) : "";
        const trends = trendSites || weightRow
            ? `<div class="sess bm-trends reveal" style="padding:12px;margin-bottom:12px">
        <div class="bm-sechead" style="font-weight:600;margin-bottom:4px">Trends</div>
        ${weightRow}${trendSites}
      </div>`
            : "";
        return `<div class="bm-root">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="bm-eyebrow" style="text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--muted,#746c5c)">Body</div>
        ${unitToggle(unit)}
      </div>
      ${data.needs_height ? heightForm(data.profile, unit) : ""}
      ${logForm(data, unit)}
      ${compSection(data, unit)}
      ${numbersSection(data)}
      ${trends}
      ${!data.needs_height ? heightForm(data.profile, unit) : ""}
    </div>`;
    }
    async function loadAndRender(mount) {
        const unit = bmUnitPref();
        // Query the unit explicitly (server treats any non-"cm" value, incl. absent, as
        // inches) so the path reads as the covered "/body-metrics", not a phantom :param.
        const data = (await api(`/body-metrics?unit=${unit === "cm" ? "cm" : "in"}`));
        mount.innerHTML = summaryHtml(data, unit);
        wire(mount, unit, data);
    }
    function wire(mount, unit, data) {
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
        // Figure callouts → that site's trend row (scroll + a brief sage flash).
        // Delegated from the mount because the morph re-renders the figure's DOM.
        const jumpToTrend = (site) => {
            const row = mount.querySelector(`.bm-trend-row[data-trend="${site}"]`);
            if (!row)
                return;
            const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
            row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
            row.style.transition = "background-color .5s ease";
            row.style.borderRadius = "8px";
            row.style.backgroundColor = "var(--sage-bg, #eef0e6)";
            setTimeout(() => {
                row.style.backgroundColor = "transparent";
            }, 1100);
        };
        const calloutOf = (e) => {
            const t = e.target;
            return t && typeof t.closest === "function" ? t.closest(".bm-co") : null;
        };
        mount.addEventListener("click", (e) => {
            const g = calloutOf(e);
            if (g)
                jumpToTrend(g.dataset.site || "");
        });
        mount.addEventListener("keydown", (e) => {
            const key = e.key;
            if (key !== "Enter" && key !== " ")
                return;
            const g = calloutOf(e);
            if (g) {
                e.preventDefault();
                jumpToTrend(g.dataset.site || "");
            }
        });
        // The then→now morph: with two or more tape sessions the figure first draws
        // at the PREVIOUS session's proportions and eases into today's over ~1.2s —
        // you watch the tape move, values counting along the way; arrows and deltas
        // land with the final frame. Skipped under prefers-reduced-motion.
        const slot = mount.querySelector(".bm-figure-slot");
        if (slot && data) {
            const m = figureModel(data, unit);
            const from = m.prev;
            const to = m.merged;
            const moving = from && to
                ? BM_SITE_KEYS.filter((k) => {
                    const a = from[k];
                    const b = to[k];
                    return a != null && b != null && Math.abs(b - a) >= 0.05;
                })
                : [];
            const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
            if (from && to && moving.length && !reduce && typeof requestAnimationFrame === "function") {
                const finalHtml = slot.innerHTML;
                const dur = 1200;
                let start = null;
                const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
                const frame = (ts) => {
                    if (!slot.isConnected)
                        return; // tab switched mid-morph
                    if (start == null)
                        start = ts;
                    const t = Math.min(1, (ts - start) / dur);
                    if (t >= 1) {
                        slot.innerHTML = finalHtml;
                        return;
                    }
                    const k = ease(t);
                    const interp = { ...to };
                    for (const key of moving)
                        interp[key] = from[key] + (to[key] - from[key]) * k;
                    slot.innerHTML = bodyFigureSvg({ ...m.base, latest: interp, dirs: {} });
                    requestAnimationFrame(frame);
                };
                requestAnimationFrame(frame);
            }
        }
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
        mount.innerHTML = `<div class="bm-loading sess-line" style="color:var(--muted,#746c5c);padding:12px">Reading your measurements…</div>`;
        loadAndRender(mount).catch(() => {
            mount.innerHTML = `<div class="bm-error sess-line" style="color:var(--muted,#746c5c);padding:12px">Couldn't load body metrics right now.</div>`;
        });
    }
    const CAIRN_BODY_METRICS = { renderBodyMetrics, deriveFigureRegions, bodyFigureSvg, mergeLatestSites, mergePreviousSites };
    Object.assign(globalThis, { CairnBodyMetrics: CAIRN_BODY_METRICS, renderBodyMetrics });
    if (typeof window !== "undefined") {
        window.CairnBodyMetrics = CAIRN_BODY_METRICS;
    }
})();
})();
