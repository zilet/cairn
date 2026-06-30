// @ts-check
// Pure Health/Records rendering helpers for the vanilla PWA.
(() => {
    const MAX_DOC_BYTES = 15 * 1024 * 1024;
    const MAX_DOC_TEXT = 400000;
    const H_FILE_PROMPT = "Drop a lab PDF, MyChart export (.zip), HTML, XML, a photo, or text…";
    // Static studio plate for the no-docs hero (trusted SVG, no caller text — same
    // rules as art.js: cream circle, ink line, one terracotta accent).
    const HEALTH_HERO_ART = `<svg viewBox="0 0 96 96" aria-hidden="true">
  <circle cx="48" cy="48" r="44" fill="#efe8db"/>
  <ellipse cx="48" cy="78" rx="24" ry="5" fill="rgba(72,58,35,.10)"/>
  <polyline points="18,54 32,54 38,40 47,66 54,44 59,54 70,54" fill="none" stroke="#211d17" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="74" cy="54" r="4" fill="#b4552d"/>
</svg>`;
    const DIRECTIVE_DOMAINS = [
        ["nutrition", "Nutrition", "❧"],
        ["training", "Training", "◇"],
        ["watch", "Watch", "◉"],
    ];
    // Browsers leave file.type empty for many .zip/.xml picks — infer from the name
    // so the server's MIME allowlist accepts it. Unknown → octet-stream (rejected).
    function guessUploadMime(file) {
        const explicitType = String(file?.type || "").toLowerCase();
        if (explicitType)
            return explicitType;
        const name = String(file?.name || "").toLowerCase();
        if (name.endsWith(".zip"))
            return "application/zip";
        if (name.endsWith(".html") || name.endsWith(".htm"))
            return "text/html";
        if (name.endsWith(".xml"))
            return "application/xml";
        if (name.endsWith(".pdf"))
            return "application/pdf";
        if (name.endsWith(".txt"))
            return "text/plain";
        return "application/octet-stream";
    }
    function evidenceSafeUrl(value) {
        const url = String(value ?? "").trim();
        return /^https?:\/\//i.test(url) ? url.replace(/"/g, "&quot;") : null;
    }
    function truncateEvidenceBody(text) {
        const body = String(text || "").trim();
        return body.length > 240 ? `${body.slice(0, 237).trimEnd()}…` : body;
    }
    function evidenceRow(value) {
        return value && typeof value === "object" ? value : {};
    }
    function evidenceListHtml(evidence) {
        const rows = (Array.isArray(evidence) ? evidence : [])
            .map(evidenceRow)
            .filter((row) => row.source_title || row.source_url || row.claim || row.body)
            .slice(0, 6);
        if (!rows.length) {
            return `<div class="hb-ev-empty">No researched source on file yet — the citation above is the basis for now.</div>`;
        }
        return rows
            .map((row) => {
            const url = evidenceSafeUrl(row.source_url);
            const title = String(row.source_title || row.claim || "Source").trim();
            const titleHtml = url
                ? `<a class="hb-ev-link" href="${url}" target="_blank" rel="noopener noreferrer">${escHtml(title)}</a>`
                : `<span class="hb-ev-title">${escHtml(title)}</span>`;
            const claim = row.claim && row.claim !== title ? `<div class="hb-ev-claim">${escHtml(String(row.claim))}</div>` : "";
            const bodyText = truncateEvidenceBody(row.body);
            const body = bodyText ? `<div class="hb-ev-body">${escHtml(bodyText)}</div>` : "";
            const conf = row.confidence ? `<span class="hb-ev-conf">${escHtml(String(row.confidence))} confidence</span>` : "";
            return `<div class="hb-ev-row">${titleHtml}${claim}${body}${conf ? `<div class="hb-ev-meta">${conf}</div>` : ""}</div>`;
        })
            .join("");
    }
    function evidenceCountMap(summary) {
        const map = new Map();
        const rows = summary && Array.isArray(summary.by_marker) ? summary.by_marker : [];
        for (const row of rows) {
            if (!row || !row.marker)
                continue;
            map.set(String(row.marker).toLowerCase(), Number(row.count) || 0);
        }
        return map;
    }
    function directiveHtml(d, i = 0, evMap = null) {
        const soft = d.uncertain && !d.citation;
        const marker = d.marker ? `<span class="hb-dmarker">${escHtml(d.marker)}</span>` : "";
        const lead = soft ? `<span class="hb-dsoft">Worth looking into · </span>` : "";
        const cite = d.citation ? `<div class="hb-dcite">${escHtml(d.citation)}</div>` : "";
        const evCount = d.marker && evMap ? (evMap.get(String(d.marker).toLowerCase()) || 0) : 0;
        const evidence = d.marker && (d.citation || evCount > 0)
            ? `<button class="hb-devidence" type="button" data-evidence="${escAttr(String(d.marker))}" aria-expanded="false">see the evidence${evCount > 0 ? ` <span class="hb-evcount">(${evCount})</span>` : ""}</button>
       <div class="hb-evbox" hidden></div>`
            : "";
        return `<div class="hb-directive reveal${soft ? " hb-directive-soft" : ""}" style="${stagger(i + 1)}" data-dir="${escAttr(d.id)}">
    <div class="hb-dmain">
      ${marker}
      <p class="hb-dtext">${lead}${escHtml(d.directive || "")}</p>
      ${d.rationale ? `<p class="hb-drat">${escHtml(d.rationale)}</p>` : ""}
      ${cite}
      ${evidence}
    </div>
    <div class="hb-dctl">
      <button class="hb-dbtn hb-ddone" data-ddone="${escAttr(d.id)}" title="Mark handled; the coach will stop carrying this unless new results change">Done</button>
      <button class="hb-dbtn hb-ddismiss" data-ddismiss="${escAttr(d.id)}" title="Dismiss; the coach will avoid repeating this unless the marker materially changes">Dismiss</button>
    </div>
  </div>`;
    }
    function healthMarkersEmptyHtml(heroArt = "") {
        return CairnUi.emptyStateHtml({
            artHtml: heroArt,
            title: "No markers yet",
            body: "Add a lab report or DEXA scan and Cairn pulls out the markers — then tracks each one's trend here.",
            style: stagger(0),
            action: { id: "hMkToRecords", className: "logbtn hpic-cta-btn", label: "ADD A DOCUMENT" },
        });
    }
    function formatMarkerNumber(value) {
        const n = Number(value);
        if (!Number.isFinite(n))
            return String(value ?? "");
        const abs = Math.abs(n);
        const rounded = abs >= 100 ? Math.round(n) : abs >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
        return String(rounded);
    }
    function sparkDateLabel(value) {
        if (!value)
            return "";
        const source = String(value);
        const parsed = new Date(source.length === 10 ? `${source}T00:00:00` : source);
        if (Number.isNaN(parsed.getTime()))
            return source;
        return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
    }
    function markerSpanWord(days) {
        const value = Number(days);
        if (!Number.isFinite(value) || value <= 0)
            return "";
        if (value < 21)
            return `~${Math.round(value)} days`;
        if (value < 75)
            return `~${Math.round(value / 7)} wk`;
        return `~${Math.max(1, Math.round(value / 30))} mo`;
    }
    function markerTrendWord(marker) {
        const trend = marker?.trend || {};
        const dir = trend.dir;
        if (!dir || dir === "stable") {
            const points = (Array.isArray(marker?.points) ? marker.points : []).filter((point) => point && Number.isFinite(Number(point.value)));
            if (dir === "stable" || points.length >= 2)
                return "holding steady";
            return "";
        }
        const span = markerSpanWord(trend.span_days);
        return `${dir}${span ? ` over ${span}` : ""}`;
    }
    // The Read tab is priority-led. The detailed Markers catalog is clinical-scan-led:
    // panels keep a familiar lab-review order first, then fall back to server order
    // for markers Cairn does not recognize yet.
    function isDirectLdlMarker(name) {
        const normalized = String(name || "").toLowerCase();
        return /\bldl\b/.test(normalized) && /\bdirect\b/.test(normalized);
    }
    function isStandardLdlMarker(name) {
        const normalized = String(name || "").toLowerCase();
        if (!/\bldl\b/.test(normalized))
            return false;
        if (isDirectLdlMarker(normalized))
            return false;
        if (/\bnon[-\s]?hdl\b/.test(normalized))
            return false;
        if (/\b(particle|small|medium|peak|pattern|large)\b/.test(normalized))
            return false;
        return /\bcholesterol\b|\bc\b/.test(normalized);
    }
    const HEALTH_MARKER_ORDER = {
        lipids: [
            [10, /^total cholesterol$/i],
            [20, /^(?!.*\bdirect\b)ldl\s*-?\s*(?:c|chol?esterol)\b/i],
            [22, /\bldl\b.*\bdirect\b|\bdirect\b.*\bldl\b/i],
            [30, /^hdl\s*-?\s*(?:c|cholesterol)$/i],
            [40, /^non[-\s]?hdl/i],
            [50, /^triglycerides?$/i],
            [60, /total cholesterol.*hdl.*ratio|cholesterol.*hdl.*ratio/i],
            [70, /apolipoprotein b|\bapo\s?b\b/i],
            [80, /lipoprotein\s*\(?a\)?|\blp\s*\(?a\)?/i],
            [100, /ldl particle|ldl[-\s]?p\b/i],
            [110, /ldl small/i],
            [120, /ldl medium/i],
            [130, /ldl peak/i],
            [140, /hdl large/i],
            [150, /ldl pattern/i],
        ],
        metabolic: [
            [10, /^(?!.*\burine\b)(?!.*estimated average).*\bglucose\b/i],
            [20, /hemoglobin\s*a1c|\bhb\s?a1c\b|\ba1c\b/i],
            [30, /estimated average glucose|\beag\b/i],
            [40, /\binsulin\b/i],
            [50, /\bhoma\b/i],
            [60, /c[-\s]?peptide/i],
            [70, /fructosamine/i],
            [90, /\burine\b.*\bglucose\b|\bglucose\b.*\burine\b/i],
        ],
        inflammation: [
            [10, /high[-\s]?sensitivity.*c[-\s]?reactive|hs[-\s]?crp/i],
            [20, /\bc[-\s]?reactive protein\b|\bcrp\b/i],
            [30, /erythrocyte sedimentation|sedimentation rate|\besr\b|\bsed rate\b/i],
            [40, /fibrinogen/i],
            [50, /homocysteine/i],
            [60, /rheumatoid factor/i],
        ],
        iron: [
            [10, /\brbc\b|red blood cell/i],
            [20, /hemoglobin|\bhgb\b/i],
            [30, /hematocrit|\bhct\b/i],
            [40, /\bmcv\b|mean corpuscular volume/i],
            [50, /\bmch\b|mean corpuscular hemoglobin/i],
            [60, /\bmchc\b/i],
            [70, /\brdw\b|red cell distribution/i],
            [90, /ferritin/i],
            [100, /transferrin saturation|% saturation|iron saturation/i],
            [110, /serum iron|^iron\b/i],
            [120, /\btibc\b|total iron binding/i],
            [130, /transferrin/i],
        ],
        blood: [
            [10, /\bwbc\b|white blood cell|leukocyte/i],
            [20, /neutrophil/i],
            [30, /lymphocyte/i],
            [40, /monocyte/i],
            [50, /eosinophil/i],
            [60, /basophil/i],
            [70, /platelet|\bplt\b/i],
            [80, /mpv|mean platelet/i],
        ],
        liver: [
            [10, /^albumin\b(?!.*urine)/i],
            [20, /total protein/i],
            [30, /bilirubin.*total|total bilirubin/i],
            [40, /bilirubin.*direct|direct bilirubin/i],
            [50, /alkaline phosphatase|\balp\b/i],
            [60, /\bast\b|aspartate aminotransferase/i],
            [70, /\balt\b|alanine aminotransferase/i],
            [80, /\bggt\b|gamma[-\s]?glutamyl/i],
        ],
        electrolytes: [
            [10, /sodium|\bna\b/i],
            [20, /potassium|\bk\b/i],
            [30, /chloride|\bcl\b/i],
            [40, /carbon dioxide|bicarbonate|\bco2\b|\btco2\b/i],
            [50, /anion gap/i],
        ],
        kidney: [
            [10, /\bbun\b|blood urea nitrogen|urea nitrogen/i],
            [20, /creatinine(?!.*urine)/i],
            [30, /\begfr\b|glomerular filtration/i],
            [40, /cystatin c/i],
            [50, /uric acid|urate/i],
            [70, /microalbumin|albumin.*urine|urine.*albumin/i],
            [80, /albumin.?creatinine|acr\b/i],
        ],
        thyroid: [
            [10, /\btsh\b|thyroid stimulating/i],
            [20, /free t4|\bft4\b|thyroxine.*free/i],
            [30, /total t4|thyroxine/i],
            [40, /free t3|\bft3\b|triiodothyronine.*free/i],
            [50, /total t3|triiodothyronine/i],
            [60, /tpo|thyroid peroxidase/i],
            [70, /thyroglobulin.*antibody|tgab/i],
        ],
        hormones: [
            [10, /total testosterone|testosterone,\s*total/i],
            [20, /free testosterone|testosterone,\s*free/i],
            [30, /\bshbg\b|sex hormone binding/i],
            [40, /estradiol|estrogen/i],
            [50, /luteinizing hormone|\blh\b/i],
            [60, /follicle stimulating hormone|\bfsh\b/i],
            [70, /prolactin/i],
            [80, /cortisol/i],
            [90, /\bdhea\b/i],
            [100, /\bigf\b|insulin-like growth/i],
        ],
        vitamins: [
            [10, /25[-\s]?oh vitamin d|vitamin d|25[-\s]?hydroxy/i],
            [20, /vitamin b12|cobalamin|\bb12\b/i],
            [30, /folate|folic acid/i],
            [40, /sodium/i],
            [50, /potassium/i],
            [60, /calcium/i],
            [70, /magnesium/i],
            [80, /zinc/i],
            [90, /omega/i],
        ],
        vitals: [
            [10, /systolic/i],
            [20, /diastolic/i],
            [30, /resting heart rate|resting hr|\brhr\b/i],
            [40, /\bhrv\b|heart rate variability/i],
        ],
        body: [
            [10, /body fat|fat percentage|fat %/i],
            [20, /fat mass/i],
            [30, /lean mass|lean tissue/i],
            [40, /visceral/i],
            [50, /android.*gynoid|gynoid.*android/i],
            [60, /bone mineral density|\bbmd\b/i],
            [70, /t[-\s]?score/i],
            [80, /z[-\s]?score/i],
            [90, /\bbmi\b|body mass index/i],
            [100, /\brmr\b|resting metabolic/i],
        ],
    };
    function markerRank(groupKey, name) {
        const markerName = String(name || "");
        const rules = HEALTH_MARKER_ORDER[String(groupKey || "")] || [];
        for (const [rank, rule] of rules) {
            if (rule.test(markerName))
                return rank;
        }
        return 900;
    }
    function lipidRank(name) {
        return markerRank("lipids", name);
    }
    function lipidSubgroup(name) {
        const rank = lipidRank(name);
        if (rank < 70)
            return "Standard lipid panel";
        if (rank < 100)
            return "Atherogenic particle risk";
        if (rank < 900)
            return "Advanced lipoprotein detail";
        return null;
    }
    function markerSubgroup(groupKey, name) {
        return groupKey === "lipids" ? lipidSubgroup(name) : "";
    }
    function orderMarkersForDisplay(groupKey, list) {
        const rows = Array.isArray(list) ? list : [];
        return rows
            .map((marker, index) => ({ marker, index }))
            .sort((a, b) => {
            const ar = markerRank(groupKey, a.marker?.name || a.marker?.key || "");
            const br = markerRank(groupKey, b.marker?.name || b.marker?.key || "");
            if (ar !== br)
                return ar - br;
            return a.index - b.index;
        })
            .map((entry) => entry.marker);
    }
    function lipidGroupNoteHtml(list, options = {}) {
        const rows = Array.isArray(list) ? list : [];
        const standard = rows.find((marker) => isStandardLdlMarker(marker?.name || marker?.key || ""));
        const direct = rows.find((marker) => isDirectLdlMarker(marker?.name || marker?.key || ""));
        if (!standard || !direct)
            return "";
        const rel = typeof options.relAge === "function" ? options.relAge : (date) => date;
        const standardDate = standard.latest?.date ? ` · ${rel(String(standard.latest.date))}` : "";
        const directDate = direct.latest?.date ? ` · ${rel(String(direct.latest.date))}` : "";
        return `<div class="hmk-groupnote">LDL-C is separated by assay: ${escHtml(standard.name || "standard LDL-C")}${escHtml(standardDate)} and ${escHtml(direct.name || "direct LDL-C")}${escHtml(directDate)} are not merged.</div>`;
    }
    const CAIRN_HEALTH_CLIENT = {
        MAX_DOC_BYTES,
        MAX_DOC_TEXT,
        H_FILE_PROMPT,
        HEALTH_HERO_ART,
        DIRECTIVE_DOMAINS,
        guessUploadMime,
        evidenceSafeUrl,
        truncateEvidenceBody,
        evidenceListHtml,
        evidenceCountMap,
        directiveHtml,
        markersEmptyHtml: healthMarkersEmptyHtml,
        formatMarkerNumber,
        sparkDateLabel,
        markerSpanWord,
        markerTrendWord,
        isDirectLdlMarker,
        isStandardLdlMarker,
        markerRank,
        lipidRank,
        lipidSubgroup,
        markerSubgroup,
        orderMarkersForDisplay,
        lipidGroupNoteHtml,
    };
    Object.assign(globalThis, { CairnHealthClient: CAIRN_HEALTH_CLIENT });
    if (typeof window !== "undefined") {
        window.CairnHealthClient = CAIRN_HEALTH_CLIENT;
    }
})();
