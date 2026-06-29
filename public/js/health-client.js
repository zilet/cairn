// @ts-check
// Pure Health/Records rendering helpers for the vanilla PWA.

/** @typedef {{ source_title?: unknown, source_url?: unknown, claim?: unknown, body?: unknown, confidence?: unknown }} HealthEvidenceRow */
/** @typedef {{ marker?: unknown, count?: unknown }} HealthEvidenceCountRow */
/** @typedef {{ by_marker?: HealthEvidenceCountRow[] }} HealthEvidenceSummary */
/** @typedef {{ name?: unknown, key?: unknown, latest?: { date?: unknown } }} HealthMarkerRow */

/** @param {unknown} value */
function evidenceSafeUrl(value) {
  const url = String(value ?? "").trim();
  return /^https?:\/\//i.test(url) ? url.replace(/"/g, "&quot;") : null;
}

/** @param {unknown} text */
function truncateEvidenceBody(text) {
  const body = String(text || "").trim();
  return body.length > 240 ? body.slice(0, 237).trimEnd() + "…" : body;
}

/** @param {unknown} evidence */
function evidenceListHtml(evidence) {
  const rows = (Array.isArray(evidence) ? evidence : [])
    .filter((e) => e && (e.source_title || e.source_url || e.claim || e.body))
    .slice(0, 6);
  if (!rows.length) {
    return `<div class="hb-ev-empty">No researched source on file yet — the citation above is the basis for now.</div>`;
  }
  return rows.map((row) => {
    const e = /** @type {HealthEvidenceRow} */ (row);
    const url = evidenceSafeUrl(e.source_url);
    const title = String(e.source_title || e.claim || "Source").trim();
    const titleHtml = url
      ? `<a class="hb-ev-link" href="${url}" target="_blank" rel="noopener noreferrer">${escHtml(title)}</a>`
      : `<span class="hb-ev-title">${escHtml(title)}</span>`;
    const claim = e.claim && e.claim !== title ? `<div class="hb-ev-claim">${escHtml(String(e.claim))}</div>` : "";
    const bodyText = truncateEvidenceBody(e.body);
    const body = bodyText ? `<div class="hb-ev-body">${escHtml(bodyText)}</div>` : "";
    const conf = e.confidence ? `<span class="hb-ev-conf">${escHtml(String(e.confidence))} confidence</span>` : "";
    return `<div class="hb-ev-row">${titleHtml}${claim}${body}${conf ? `<div class="hb-ev-meta">${conf}</div>` : ""}</div>`;
  }).join("");
}

/** @param {HealthEvidenceSummary | null | undefined} summary */
function evidenceCountMap(summary) {
  const map = new Map();
  const rows = summary && Array.isArray(summary.by_marker) ? summary.by_marker : [];
  for (const row of rows) {
    if (!row || !row.marker) continue;
    map.set(String(row.marker).toLowerCase(), Number(row.count) || 0);
  }
  return map;
}

/** @param {string} heroArt */
function healthMarkersEmptyHtml(heroArt = "") {
  return `<div class="empty-state reveal" style="${stagger(0)}">
    <div class="artile artile-lg" style="margin:0 auto 14px">${heroArt}</div>
    <div class="empty-state-line">No markers yet</div>
    <div class="hpic-hero-sub">Add a lab report or DEXA scan and Cairn pulls out the markers — then tracks each one's trend here.</div>
    <button id="hMkToRecords" class="logbtn hpic-cta-btn">ADD A DOCUMENT</button>
  </div>`;
}

// The Read tab is priority-led. The detailed Markers catalog is clinical-scan-led:
// panels keep a familiar lab-review order first, then fall back to server order
// for markers Cairn does not recognize yet.
/** @param {unknown} name */
function isDirectLdlMarker(name) {
  const n = String(name || "").toLowerCase();
  return /\bldl\b/.test(n) && /\bdirect\b/.test(n);
}

/** @param {unknown} name */
function isStandardLdlMarker(name) {
  const n = String(name || "").toLowerCase();
  if (!/\bldl\b/.test(n)) return false;
  if (isDirectLdlMarker(n)) return false;
  if (/\bnon[-\s]?hdl\b/.test(n)) return false;
  if (/\b(particle|small|medium|peak|pattern|large)\b/.test(n)) return false;
  return /\bcholesterol\b|\bc\b/.test(n);
}

/** @type {Record<string, Array<[number, RegExp]>>} */
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

/** @param {unknown} groupKey @param {unknown} name */
function markerRank(groupKey, name) {
  const n = String(name || "");
  const rules = HEALTH_MARKER_ORDER[String(groupKey || "")] || [];
  for (const [rank, re] of rules) if (re.test(n)) return rank;
  return 900;
}

/** @param {unknown} name */
function lipidRank(name) {
  return markerRank("lipids", name);
}

/** @param {unknown} name */
function lipidSubgroup(name) {
  const rank = lipidRank(name);
  if (rank < 70) return "Standard lipid panel";
  if (rank < 100) return "Atherogenic particle risk";
  if (rank < 900) return "Advanced lipoprotein detail";
  return null;
}

/** @param {unknown} groupKey @param {unknown} name */
function markerSubgroup(groupKey, name) {
  return groupKey === "lipids" ? lipidSubgroup(name) : "";
}

/**
 * @template {HealthMarkerRow} T
 * @param {unknown} groupKey
 * @param {T[] | null | undefined} list
 * @returns {T[]}
 */
function orderMarkersForDisplay(groupKey, list) {
  const rows = Array.isArray(list) ? list : [];
  return rows
    .map((m, index) => ({ m, index }))
    .sort((a, b) => {
      const ar = markerRank(groupKey, a.m?.name || a.m?.key || "");
      const br = markerRank(groupKey, b.m?.name || b.m?.key || "");
      if (ar !== br) return ar - br;
      return a.index - b.index;
    })
    .map((x) => x.m);
}

/**
 * @param {HealthMarkerRow[] | null | undefined} list
 * @param {{ relAge?: (date: string) => string }} [options]
 */
function lipidGroupNoteHtml(list, options = {}) {
  const rows = Array.isArray(list) ? list : [];
  const standard = rows.find((m) => isStandardLdlMarker(m?.name || m?.key || ""));
  const direct = rows.find((m) => isDirectLdlMarker(m?.name || m?.key || ""));
  if (!standard || !direct) return "";
  /** @type {(date: string) => string} */
  const rel = typeof options.relAge === "function" ? options.relAge : (date) => date;
  const sDate = standard.latest?.date ? ` · ${rel(String(standard.latest.date))}` : "";
  const dDate = direct.latest?.date ? ` · ${rel(String(direct.latest.date))}` : "";
  return `<div class="hmk-groupnote">LDL-C is separated by assay: ${escHtml(standard.name || "standard LDL-C")}${escHtml(sDate)} and ${escHtml(direct.name || "direct LDL-C")}${escHtml(dDate)} are not merged.</div>`;
}

if (typeof window !== "undefined") {
  window.CairnHealthClient = {
    evidenceSafeUrl,
    truncateEvidenceBody,
    evidenceListHtml,
    evidenceCountMap,
    markersEmptyHtml: healthMarkersEmptyHtml,
    isDirectLdlMarker,
    isStandardLdlMarker,
    markerRank,
    lipidRank,
    lipidSubgroup,
    markerSubgroup,
    orderMarkersForDisplay,
    lipidGroupNoteHtml,
  };
}
