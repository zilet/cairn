(() => {
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
    // Deep-link into Chat with a question pre-filled. The composer restores
    // state.chatPrefill on init (see chat-composer-controller), so this hands the
    // coach a specific, ready-to-send question about a marker/finding — the "ask
    // more about it" affordance. Referenced via globalThis so it's a safe no-op in
    // any context (tests, an unmounted shell) where the app globals aren't present.
    function askCoach(question) {
        const q = String(question ?? "").replace(/\s+/g, " ").trim();
        if (!q)
            return;
        const g = globalThis;
        if (g.state)
            g.state.chatPrefill = q.slice(0, 600);
        if (typeof g.activateTab === "function")
            g.activateTab("chat");
    }
    const CAIRN_HEALTH_CLIENT = {
        MAX_DOC_BYTES,
        MAX_DOC_TEXT,
        H_FILE_PROMPT,
        HEALTH_HERO_ART,
        askCoach,
        DIRECTIVE_DOMAINS: CairnHealthEvidence.DIRECTIVE_DOMAINS,
        guessUploadMime,
        evidenceSafeUrl: CairnHealthEvidence.evidenceSafeUrl,
        truncateEvidenceBody: CairnHealthEvidence.truncateEvidenceBody,
        evidenceListHtml: CairnHealthEvidence.evidenceListHtml,
        evidenceCountMap: CairnHealthEvidence.evidenceCountMap,
        directiveHtml: CairnHealthEvidence.directiveHtml,
        markersEmptyHtml: healthMarkersEmptyHtml,
        formatMarkerNumber,
        sparkDateLabel,
        markerSpanWord,
        markerTrendWord,
        isDirectLdlMarker: CairnHealthMarkerOrder.isDirectLdlMarker,
        isStandardLdlMarker: CairnHealthMarkerOrder.isStandardLdlMarker,
        markerRank: CairnHealthMarkerOrder.markerRank,
        lipidRank: CairnHealthMarkerOrder.lipidRank,
        lipidSubgroup: CairnHealthMarkerOrder.lipidSubgroup,
        markerSubgroup: CairnHealthMarkerOrder.markerSubgroup,
        orderMarkersForDisplay: CairnHealthMarkerOrder.orderMarkersForDisplay,
        lipidGroupNoteHtml: CairnHealthMarkerOrder.lipidGroupNoteHtml,
    };
    Object.assign(globalThis, { CairnHealthClient: CAIRN_HEALTH_CLIENT });
    if (typeof window !== "undefined") {
        window.CairnHealthClient = CAIRN_HEALTH_CLIENT;
    }
})();
})();
