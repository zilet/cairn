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
    let LOADP = null;
    // domain-detail catalog state (mirrors the Markers view): which domain is open,
    // the free-text search, and the out-of-range filter. Reset each time a domain opens.
    let curDomain = null;
    let standQuery = "";
    let standOff = false;
    // Every Stand sub-view is a first-class, deep-linkable route (/app/stand/<seg>).
    // state.standSeg is the single source of which view is open; setting it keeps the
    // URL in step so reload/back land where you were.
    function setStandSeg(seg) {
        state.standSeg = seg;
        if (state.tab === "stand")
            syncRouteFromState();
    }
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
    // ---- overview: Your Read (the synthesis as focus-zones, not a scroll) ----------
    function askLink(topic) {
        const q = `Tell me more about ${topic} — what should I focus on?`;
        return `<button class="linkbtn linkbtn-plain linkbtn-sm stand-ask" type="button" data-ask="${escAttr(q)}">Ask the coach<span aria-hidden="true"> →</span></button>`;
    }
    // The agentic whole-picture read is generated and refreshed right here — Stand is
    // where the read lives, so the trigger lives with it (calm: one small control).
    function readRefreshHtml() {
        return DATA?.synthStale
            ? `<button class="linkbtn linkbtn-plain linkbtn-sm stand-read-refresh" data-readrefresh type="button"><span class="hdot hdot-warn"></span>New results — refresh</button>`
            : `<button class="linkbtn linkbtn-plain linkbtn-sm stand-read-refresh" data-readrefresh type="button">refresh</button>`;
    }
    function readGenHtml() {
        if (!(DATA?.markers || []).length)
            return "";
        return `<div class="stand-read reveal">
      <span class="stand-read-k lbl">Your read</span>
      <p class="stand-read-lede">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn stand-read-gen" data-readgen type="button">Read my whole picture</button>
    </div>`;
    }
    function readHtml() {
        const syn = DATA?.synthesis;
        const headline = syn && typeof syn.headline === "string" ? syn.headline.trim() : "";
        const prios = (syn?.priorities || []).slice(0, 3);
        // No synthesis yet → the conductor focus line still leads, with a quiet invite
        // to generate the whole-picture read once there are markers to read.
        if (!headline && !prios.length)
            return focusHeroHtml() + readGenHtml();
        const age = syn && typeof syn.generated_at === "string" ? ` · ${relAge(syn.generated_at)}` : "";
        const zones = prios.map((p, i) => {
            const label = String(p.label || "");
            const move = String(p.the_move || p.move || "");
            const why = String(p.why_it_matters || p.why || "");
            const tone = i === 0 ? "warn" : "watch"; // the lead reads strongest
            return `<div class="stand-zone tone-${tone}" data-zone>
        <div class="stand-zt"><span class="hdot hdot-${tone}"></span><span class="stand-zlabel">${escHtml(label)}</span><span class="stand-zchev" aria-hidden="true">▾</span></div>
        ${move ? `<div class="stand-zmove">${escHtml(move)}</div>` : ""}
        <div class="stand-zwhy">${why ? escHtml(why) : ""}${askLink(label || "this")}</div>
      </div>`;
        }).join("");
        const oc = syn && typeof syn.one_change === "string" && syn.one_change.trim()
            ? `<div class="stand-onechange well-accent-sm"><span class="lbl">If you change one thing</span><span>${escHtml(syn.one_change.trim())}</span></div>`
            : "";
        const conns = (DATA?.connections || [])
            .filter((c) => typeof c.text === "string" && String(c.text).trim())
            .slice(0, 2)
            .map((c) => `<div class="stand-conn"><span class="stand-conn-i" aria-hidden="true">◇</span><span>${escHtml(String(c.text))}</span></div>`)
            .join("");
        return `<div class="stand-read reveal">
      <span class="stand-read-top"><span class="stand-read-k lbl">Your read${age}</span>${readRefreshHtml()}</span>
      ${headline ? `<p class="stand-read-lede">${escHtml(headline)}</p>` : ""}
      ${zones ? `<div class="stand-zones">${zones}</div>` : ""}
      ${oc}
      ${conns ? `<div class="stand-conns"><div class="stand-conns-h lbl">Quiet connections</div>${conns}</div>` : ""}
    </div>`;
    }
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
    // ---- recovery (condensed tile + detail, from wearable/daily metrics) -----------
    function recoveryData() {
        const r = DATA?.recovery;
        if (!r || r.has_data === false)
            return null;
        return r.recovery && typeof r.recovery === "object" ? r.recovery : null;
    }
    function sleepWord(min) {
        const m = Number(min);
        if (!Number.isFinite(m) || m <= 0)
            return "";
        return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
    }
    function recoveryStatus() {
        const rec = recoveryData();
        if (!rec)
            return "mute";
        const score = Number(rec.avg_sleep_score);
        if (Number.isFinite(score))
            return score >= 75 ? "ok" : score >= 60 ? "watch" : "warn";
        return "ok";
    }
    function recoveryTile() {
        const rec = recoveryData();
        if (!rec)
            return "";
        const st = recoveryStatus();
        const sleep = sleepWord(rec.avg_sleep_min);
        const hrv = Number(rec.avg_hrv_ms);
        const read = sleep
            ? `sleep <b>${escHtml(sleep)}</b>${Number.isFinite(hrv) && hrv > 0 ? ` · HRV ${Math.round(hrv)}` : ""}`
            : "no wearable data yet";
        return `<button class="stand-tile reveal" data-recovery>
      <span class="stand-tile-top"><span class="hdot hdot-${st}"></span><span class="stand-tile-name">Recovery</span></span>
      <span class="stand-tile-read ${st === "ok" ? "" : st}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
    }
    function recoveryDetailHtml() {
        const rec = recoveryData();
        const card = (label, value, sub = "") => value ? `<div class="stand-mcard"><span class="stand-mcard-l">${escHtml(label)}</span><span class="stand-mcard-v">${escHtml(value)}</span>${sub ? `<span class="stand-mcard-sub">${escHtml(sub)}</span>` : ""}</div>` : "";
        const cards = rec ? [
            card("Sleep", sleepWord(rec.avg_sleep_min), Number.isFinite(Number(rec.avg_sleep_score)) ? `score ${Math.round(Number(rec.avg_sleep_score))}` : ""),
            card("HRV", Number.isFinite(Number(rec.avg_hrv_ms)) && Number(rec.avg_hrv_ms) > 0 ? `${Math.round(Number(rec.avg_hrv_ms))} ms` : ""),
            card("Resting HR", Number.isFinite(Number(rec.avg_resting_hr)) ? `${Math.round(Number(rec.avg_resting_hr))} bpm` : ""),
            card("Body battery", Number.isFinite(Number(rec.avg_body_battery)) ? `${Math.round(Number(rec.avg_body_battery))}` : ""),
        ].filter(Boolean).join("") : "";
        return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">Recovery</h2>
      <p class="stand-read-lede" style="font-size:1rem">A 14-day read from your wearable — sleep, HRV and resting heart rate holding steady.</p>
      ${cards ? `<div class="stand-mcards">${cards}</div>` : `<p class="stand-empty">No wearable data yet.</p>`}
    </div>`;
    }
    // ---- supplements (condensed tile + list; informational, no traffic-light) ------
    function supplementsTile() {
        const list = DATA?.supplements || [];
        if (!list.length)
            return "";
        const names = list.map((s) => String(s.name || "")).filter(Boolean);
        const read = names.length
            ? `${escHtml(names.slice(0, 2).join(", "))}${names.length > 2 ? ` +${names.length - 2}` : ""}`
            : `${list.length} tracked`;
        return `<button class="stand-tile reveal" data-supps>
      <span class="stand-tile-top"><span class="hdot hdot-ok"></span><span class="stand-tile-name">Supplements</span></span>
      <span class="stand-tile-read">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
    }
    // ---- connections (the connected brain: active directives, managed in-place) ----
    function activeDirectives() {
        return (DATA?.directives || []).filter((d) => !d.status || d.status === "active");
    }
    function connectionsTile() {
        const n = activeDirectives().length;
        if (!n && !(DATA?.markers || []).length)
            return "";
        const read = n
            ? `<b>${n}</b> shaping your plan`
            : "nothing in effect";
        return `<button class="stand-tile reveal" data-connections>
      <span class="stand-tile-top"><span class="hdot hdot-${n ? "watch" : "mute"}"></span><span class="stand-tile-name">Connections</span></span>
      <span class="stand-tile-read ${n ? "watch" : ""}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
    }
    // ---- age (the biological-age / percentile standing read, hosted one tap down) ---
    function ageTile() {
        if (!(DATA?.markers || []).length)
            return "";
        return `<button class="stand-tile reveal" data-age>
      <span class="stand-tile-top"><span class="hdot hdot-mute"></span><span class="stand-tile-name">Age</span></span>
      <span class="stand-tile-read">how you compare</span><span class="stand-tile-arw" aria-hidden="true">›</span>
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
        const rec = recoveryTile();
        if (rec)
            tiles.push({ st: recoveryStatus(), html: rec });
        const conn = connectionsTile();
        if (conn)
            tiles.push({ st: activeDirectives().length ? "watch" : "mute", html: conn });
        const supp = supplementsTile();
        if (supp)
            tiles.push({ st: "ok", html: supp });
        const age = ageTile();
        if (age)
            tiles.push({ st: "mute", html: age });
        for (const d of DOMAINS) {
            const markers = markersOfDomain(d);
            if (!markers.length)
                continue;
            const st = worstOf(markers);
            tiles.push({ st, html: domainTileHtml(d, st) });
        }
        tiles.sort((a, b2) => RANK[b2.st] - RANK[a.st]);
        return `<div class="stand-root">
      ${actionBarHtml()}
      ${readHtml()}
      <div class="stand-browse lbl">Your markers<button class="stand-allmk linkbtn linkbtn-plain linkbtn-sm" type="button" data-allmarkers>All markers<span aria-hidden="true"> →</span></button></div>
      <div class="stand-grid">${tiles.map((t) => t.html).join("")}</div>
    </div>`;
    }
    // The health depth + the clinician-facing exports are Stand's OWN sub-views now —
    // Records, the doctor Share (clinical order + trends, untouched), and the learned
    // timeline all render in place, never warping to another tab.
    // A sticky bar pinned to the top of Stand — Add labs is always one tap away
    // (never buried at the scroll bottom); the rest of the health tools sit behind a
    // quiet "⋯" menu in the same bar.
    function actionBarHtml() {
        return `<div class="stand-actionbar">
      <button class="stand-addbtn" data-tool="add" type="button"><span class="stand-addbtn-p" aria-hidden="true">＋</span>Add labs or scan</button>
      <div class="stand-more">
        <button class="stand-morebtn" type="button" aria-label="More health tools" aria-expanded="false" data-morebtn>⋯</button>
        <div class="stand-moremenu" data-moremenu hidden>
          <button class="stand-moreitem" data-tool="share" type="button">Share with your doctor</button>
          <button class="stand-moreitem" data-tool="records" type="button">Records</button>
          <button class="stand-moreitem" data-tool="learned" type="button">Learned</button>
        </div>
      </div>
    </div>`;
    }
    // ---- hosted health tools (records / share / learned / connections / age) -------
    // These reuse the shipped controllers with Stand-shaped deps: same upload flow,
    // same doctor report, same directive flips — rendered inside Stand's shell.
    function toolShellHtml(title, mounts, lede = "") {
        return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">${escHtml(title)}</h2>
      ${lede ? `<p class="stand-read-lede" style="font-size:1rem">${escHtml(lede)}</p>` : ""}
      ${mounts}
    </div>`;
    }
    // Refresh Stand's own marker snapshot after an upload/re-analysis lands, so the
    // overview tiles are warm and current when the athlete steps back.
    async function refreshStandMarkers() {
        try {
            const priority = await api("/markers/priority");
            if (DATA && priority && typeof priority === "object") {
                DATA.markers = Array.isArray(priority.markers) ? priority.markers : DATA.markers;
                DATA.groups = Array.isArray(priority.groups) ? priority.groups : DATA.groups;
            }
        }
        catch { /* the overview simply repaints from the last snapshot */ }
    }
    function pictureDeps() {
        return {
            root: view,
            state,
            api,
            toast,
            switchHealthSeg: (seg, opts) => { if (seg === "records")
                showRecords(opts || {});
            else
                showOverview(); },
            onHealthReadView: () => state.tab === "stand" && state.standSeg === "connections",
            pollToken: () => pollToken,
            escapeHtml: escHtml,
        };
    }
    function recordsDeps() {
        return {
            state,
            api,
            toast,
            armDelete,
            pollEnrichment,
            enrichmentActive,
            pollToken: () => pollToken,
            loadHealthMarkers: () => { void refreshStandMarkers(); },
            paintHealthPicture: () => CairnHealthPictureController.paintHealthPicture(pictureDeps()),
            getHealthPictureCache: () => CairnHealthPictureController.getHealthPictureCache(),
            setHealthPictureCache: (cache) => CairnHealthPictureController.setHealthPictureCache(cache),
        };
    }
    function shareDeps() {
        return {
            root: view,
            api,
            cachedApi,
            peekCached,
            swrInvalidate,
            toast,
            btnBusy,
            downloadFile,
            select: $,
            stagger,
            switchHealthSeg: (seg, opts) => { if (seg === "records")
                showRecords(opts || {});
            else
                showOverview(); },
            withToken,
        };
    }
    function readDeps() {
        return {
            root: view,
            state,
            api,
            cachedApi,
            peekCached,
            markRefreshing,
            swrInvalidate,
            runOp,
            toast,
            pollToken: () => pollToken,
            select: $,
            escapeAttr: escAttr,
            escapeHtml: escHtml,
            relTime,
            stagger,
            reducedMotion,
            switchHealthSeg: (seg) => { if (seg === "markers")
                showAllMarkers();
            else
                showOverview(); },
            isHealthReviewRunning: () => CairnHealthPictureController.isHealthReviewRunning(),
            loadHealthPicture: (token, docsPromise) => CairnHealthPictureController.loadHealthPicture(token, docsPromise, pictureDeps()),
            paintHealthPicture: () => CairnHealthPictureController.paintHealthPicture(pictureDeps()),
            setReadSpy: () => { },
            teardownReadSpy: () => { },
        };
    }
    function standingDeps() {
        return {
            root: view,
            document,
            state,
            api,
            swrInvalidate,
            toast,
            activateTab,
            pollToken: () => pollToken,
            select: $,
            escapeAttr: escAttr,
            loadDexaTargeting: (slotId) => loadDexaTargeting(slotId),
        };
    }
    function showRecords(opts = {}) {
        setStandSeg("records");
        paint(toolShellHtml("Records", `<div id="hContent"></div>`, "Lab reports, DEXA scans and other documents — everything Cairn reads your markers from."));
        wireBack();
        void CairnHealthRecordsController.render(recordsDeps());
        if (opts.openPicker)
            view.querySelector("#hFile")?.click();
    }
    function showShare() {
        setStandSeg("share");
        paint(toolShellHtml("Share with your doctor", `<div id="hContent"></div><div id="hbSymptomLinks"></div>`));
        wireBack();
        CairnHealthShareController.render(shareDeps());
        // "Worth mentioning to your doctor" belongs with the clinician-facing tools.
        void CairnHealthReadController.loadSymptomLinks(readDeps(), pollToken);
    }
    function showLearned() {
        setStandSeg("learned");
        paint(toolShellHtml("Learned", `<div id="standLearned">${skelLines(4)}</div>`));
        wireBack();
        const token = pollToken;
        api("/learned-timeline")
            .then((data) => paintLearned(data, token))
            .catch(() => paintLearned({ items: [] }, token));
    }
    function paintLearned(data, token) {
        const wrap = view.querySelector("#standLearned");
        if (!wrap || !wrap.isConnected || token !== pollToken)
            return;
        wrap.innerHTML = learnedTimelineHtml((data || { items: [] }));
        // Curation lives in the about-you home (Settings → You → Memory).
        wrap.querySelector("#learnedToMemory")?.addEventListener("click", () => {
            state.meSeg = "memory";
            activateTab("me");
        });
    }
    function showConnections() {
        setStandSeg("connections");
        paint(toolShellHtml("Connections", `<div id="hbDirectives"><div class="hb-load">Gathering connections…</div></div>
     <div id="hPicture"></div>`, "One brain across your whole picture: a finding in your labs quietly shapes your meals, training, and what to watch. Informational — never medical advice; nothing changes your plan on its own."));
        wireBack();
        void CairnHealthDirectiveLoader.load(pollToken);
        const deps = pictureDeps();
        if (CairnHealthPictureController.isHealthReviewRunning())
            CairnHealthPictureController.paintHealthPicture(deps);
        else
            void CairnHealthPictureController.loadHealthPicture(pollToken, api("/health-docs"), deps);
    }
    function showAge() {
        setStandSeg("age");
        paint(toolShellHtml("How you compare", `<div id="hContent"></div>`));
        wireBack();
        CairnHealthStandingController.paintReview(standingDeps());
    }
    // ---- domain detail — the Markers catalog, scoped to one domain -----------------
    // The old Markers affordances come along: search (when there are many), an
    // out-of-range filter, clinical sub-group sections, and expandable rows carrying
    // the chart, the range/optimal target, and the trend. Controls render ONCE (so the
    // search field keeps focus); only #standResults re-fills on filter/search.
    const HC = () => globalThis.CairnHealthClient;
    function markerOutOfRange(m) { return !!HM()?.markerOutOfRange?.(m); }
    function matchesQuery(m) {
        const q = standQuery.toLowerCase().replace(/\s+/g, " ").trim();
        if (!q)
            return true;
        return `${String(m.name || m.key || "")} ${String(m.group_label || "")}`.toLowerCase().includes(q);
    }
    function standControlsHtml(total, outCount) {
        const search = total > 5
            ? `<div class="hmk-search"><svg class="hmk-search-i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><input id="standSearch" type="search" class="hmk-search-in" placeholder="Search…" aria-label="Search markers" autocomplete="off" spellcheck="false" enterkeyhint="search"></div>`
            : "";
        const pill = outCount
            ? `<button id="standOut" class="hmk-filter-toggle${standOff ? " on" : ""}" aria-pressed="${standOff ? "true" : "false"}"><span class="hdot hdot-warn"></span>Out of range · ${outCount}</button>`
            : "";
        return search || pill ? `<div class="hmk-controls reveal">${search}${pill}</div>` : "";
    }
    function domainResultsHtml() {
        const all = curDomain === "__all__";
        const d = all ? null : DOMAINS.find((x) => x.key === curDomain);
        if (!all && !d)
            return "";
        // Sections = clinical groups, each with its own head + sub-group sub-heads so the
        // fine taxonomy stays usable one tap down. A domain view sorts its groups worst-
        // first (what needs attention rises); the full "All markers" catalog keeps the
        // backend's canonical clinical-review order (CBC → CMP → lipids → …).
        const present = (DATA?.groups || []).filter((g) => (all || d.groups.includes(g.key)) && markersOfGroup(g.key).length);
        if (!all)
            present.sort((a, b) => RANK[worstOf(markersOfGroup(b.key))] - RANK[worstOf(markersOfGroup(a.key))]);
        let rowIndex = 0;
        const sections = present.map((g, gi) => {
            let list = markersOfGroup(g.key);
            if (standOff)
                list = list.filter(markerOutOfRange);
            list = list.filter(matchesQuery);
            if (!list.length)
                return "";
            const ordered = HC()?.orderMarkersForDisplay?.(g.key, list) || list;
            let lastSub = "";
            const rows = ordered.map((m) => {
                const sub = HC()?.markerSubgroup?.(g.key, String(m.name || m.key || ""));
                const subhead = sub && sub !== lastSub ? `<div class="hmk-subhead">${escHtml(sub)}</div>` : "";
                if (sub)
                    lastSub = sub;
                return subhead + HM()?.hmkRowHtml?.(m, rowIndex++);
            }).join("");
            const off = ordered.filter(markerOutOfRange).length;
            const badge = off ? `<span class="hmk-headcount">${off} off</span>` : "";
            const head = `<div class="hmk-grouphead lbl reveal" style="--i:${Math.min(gi, 12)}">${escHtml(g.label)}${badge}</div>`;
            const note = g.key === "lipids" ? (HC()?.lipidGroupNoteHtml?.(ordered, { relAge }) || "") : "";
            return `<section class="hmk-section">${head}${note}<div class="hmk-card">${rows}</div></section>`;
        }).join("");
        return sections || `<p class="stand-empty">${standQuery || standOff ? "Nothing matches — clear the filter." : "No readings here yet."}</p>`;
    }
    function showDomain(key) {
        curDomain = key;
        standQuery = "";
        standOff = false;
        const all = key === "__all__";
        setStandSeg(all ? "markers" : null);
        const d = all ? null : DOMAINS.find((x) => x.key === key);
        const markers = all ? (DATA?.markers || []) : d ? markersOfDomain(d) : [];
        const outCount = markers.filter(markerOutOfRange).length;
        paint(`<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">${escHtml(all ? "All markers" : d?.label || "Markers")}</h2>
      ${standControlsHtml(markers.length, outCount)}
      <div id="standResults"></div>
    </div>`);
        wireBack();
        wireControls();
        renderResults();
    }
    function showAllMarkers() { showDomain("__all__"); }
    function renderResults() {
        const el = view.querySelector("#standResults");
        if (!el)
            return;
        el.innerHTML = domainResultsHtml();
        wireRows(el);
    }
    function wireControls() {
        const search = view.querySelector("#standSearch");
        search?.addEventListener("input", () => { standQuery = search.value; renderResults(); });
        const pill = view.querySelector("#standOut");
        pill?.addEventListener("click", () => {
            standOff = !standOff;
            pill.classList.toggle("on", standOff);
            pill.setAttribute("aria-pressed", standOff ? "true" : "false");
            renderResults();
        });
    }
    function bodyDetailHtml() {
        // The Body detail is the full body-progress home: the shipped body-metrics
        // surface (the glowing figure, "where you stand" indicators, height, one-tap
        // tape logging, and per-site + weight trend sparklines) mounts into
        // #standBodyMetrics on showBody(). We keep only the DEXA / body-composition
        // markers (the "body" clinical group) below it, for their inline charts.
        const dexa = markersOfGroup("body").map((m) => HM()?.hmkRowHtml?.(m)).filter(Boolean).join("");
        return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">Body</h2>
      <div id="standBodyMetrics" class="stand-bodymetrics"></div>
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
    function showOverview() {
        setStandSeg(null);
        // Stepped back from a self-contained tool before the overview data landed →
        // hold the calm loading state until the in-flight fetch resolves.
        if (!DATA) {
            paint(`<div class="stand-loading loadstate"><span class="loadstate-label">Reading where you stand…</span></div>`);
            (LOADP || loadStandData()).then(() => {
                if (state.tab === "stand" && !state.standSeg && DATA) {
                    paint(overviewHtml());
                    wireOverview();
                }
                else if (state.tab === "stand" && !state.standSeg)
                    paint(standErrorHtml());
            });
            return;
        }
        paint(overviewHtml());
        wireOverview();
    }
    function showBody() {
        setStandSeg("body");
        paint(bodyDetailHtml());
        wireBack();
        // Hand the mount to the self-contained body-metrics surface (log + trends).
        BM()?.renderBodyMetrics?.(view.querySelector("#standBodyMetrics"));
        wireRows(view);
    }
    function showRecovery() { setStandSeg("recovery"); paint(recoveryDetailHtml()); wireBack(); }
    function showSupplements() {
        setStandSeg("supplements");
        // The manageable supplements card (plain-words add + remove) hosts in place of
        // the old read-only list — say it once, Cairn folds it into your reads.
        paint(toolShellHtml("Supplements", `<div id="hbSupplements"></div>`, "What you take — Cairn folds these into your reads (e.g. creatine nudges eGFR)."));
        wireBack();
        CairnHealthReadSupplements.load(readDeps(), pollToken);
    }
    function wireOverview() {
        view.querySelectorAll("[data-domain]").forEach((b) => b.addEventListener("click", () => showDomain(b.dataset.domain || "")));
        view.querySelector("[data-body]")?.addEventListener("click", () => showBody());
        view.querySelector("[data-recovery]")?.addEventListener("click", () => showRecovery());
        view.querySelector("[data-supps]")?.addEventListener("click", () => showSupplements());
        view.querySelector("[data-connections]")?.addEventListener("click", () => showConnections());
        view.querySelector("[data-age]")?.addEventListener("click", () => showAge());
        view.querySelector("[data-allmarkers]")?.addEventListener("click", () => showAllMarkers());
        view.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => {
            const tool = b.dataset.tool || "";
            if (tool === "add")
                showRecords({ openPicker: true });
            else if (tool === "records")
                showRecords();
            else if (tool === "share")
                showShare();
            else if (tool === "learned")
                showLearned();
        }));
        // The agentic whole-picture read: generate on first run, refresh after new labs.
        view.querySelector("[data-readrefresh]")?.addEventListener("click", () => triggerStandRead());
        view.querySelector("[data-readgen]")?.addEventListener("click", () => triggerStandRead());
        // the "⋯ more" tools menu in the sticky action bar
        const moreBtn = view.querySelector("[data-morebtn]");
        const moreMenu = view.querySelector("[data-moremenu]");
        moreBtn?.addEventListener("click", (e) => {
            e.stopPropagation();
            const open = moreMenu?.hasAttribute("hidden");
            if (open)
                moreMenu?.removeAttribute("hidden");
            else
                moreMenu?.setAttribute("hidden", "");
            moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
        });
        document.addEventListener("click", () => moreMenu?.setAttribute("hidden", ""), { once: true });
        // Your Read focus-zones: tap to expand the "why"; ask-the-coach deep-links.
        view.querySelectorAll("[data-zone]").forEach((z) => z.addEventListener("click", (e) => {
            if (e.target.closest(".stand-ask"))
                return;
            z.classList.toggle("open");
        }));
        view.querySelectorAll(".stand-ask").forEach((b) => b.addEventListener("click", (e) => {
            e.stopPropagation();
            const g = globalThis;
            g.CairnHealthClient?.askCoach?.(b.getAttribute("data-ask"));
        }));
    }
    function wireBack() {
        view.querySelector("[data-back]")?.addEventListener("click", () => showOverview());
    }
    // marker row expand + chart + ask (mirrors the Markers catalog wiring)
    function wireRows(wrap) {
        wrap.querySelectorAll(".hmk-x .hmk-row").forEach((button) => button.addEventListener("click", () => {
            const item = button.closest(".hmk");
            if (!item)
                return;
            const open = item.classList.toggle("open");
            button.setAttribute("aria-expanded", open ? "true" : "false");
        }));
        wrap.querySelectorAll("svg.hchart").forEach((svg) => HM()?.wireMarkerChart?.(svg));
        wrap.querySelectorAll(".hmk-ask").forEach((button) => button.addEventListener("click", (event) => {
            event.stopPropagation();
            const g = globalThis;
            g.CairnHealthClient?.askCoach?.(button.getAttribute("data-ask"));
        }));
    }
    function standErrorHtml() {
        return `<div class="stand-error loadstate"><span class="loadstate-label">Couldn't read your standing right now.</span></div>`;
    }
    // One fetch fills the whole overview snapshot; hosted tool views fetch their own
    // data so a deep link paints immediately while this warms behind them.
    function loadStandData() {
        const p = (async () => {
            const [priority, focus, body, synthRes, insightsRes, recoveryRes, suppRes, dirRes] = await Promise.all([
                api("/markers/priority"),
                api("/coaching-focus").catch(() => null),
                api("/body-metrics?unit=in").catch(() => null),
                api("/health/synthesis").catch(() => null),
                api("/insights").catch(() => null),
                api("/recovery").catch(() => null),
                api("/supplements").catch(() => null),
                api("/directives").catch(() => null),
            ]);
            const insightsArr = Array.isArray(insightsRes)
                ? insightsRes
                : Array.isArray(insightsRes?.insights)
                    ? (insightsRes.insights)
                    : [];
            const syn = synthRes && typeof synthRes === "object" ? synthRes.synthesis : null;
            DATA = {
                markers: Array.isArray(priority?.markers) ? priority.markers : [],
                groups: Array.isArray(priority?.groups) ? priority.groups : [],
                focus,
                body,
                synthesis: syn || null,
                synthStale: !!(synthRes && typeof synthRes === "object" && (synthRes.stale ?? syn?.stale)),
                connections: insightsArr.filter((c) => c && String(c.kind || "") === "connection"),
                recovery: recoveryRes && typeof recoveryRes === "object" ? recoveryRes : null,
                supplements: (Array.isArray(suppRes) ? suppRes : suppRes?.supplements || [])
                    .filter((s) => !!s && typeof s === "object" && s.active !== 0),
                directives: Array.isArray(dirRes?.directives)
                    ? dirRes.directives.filter((d) => !!d && typeof d === "object")
                    : [],
            };
        })();
        LOADP = p.catch(() => { });
        return p;
    }
    // Regenerate the whole-picture read in place (the same background job the old
    // health Read tab ran), then repaint the overview with the fresh synthesis.
    function triggerStandRead() {
        void runOp("health_synthesis", {}, {
            path: "/health/synthesis",
            anchor: ".stand-read",
            caption: ["reading your labs", "connecting it to your training & recovery", "finding what matters most", "writing your picture"],
            guard: () => !(state.tab === "stand" && !state.standSeg),
            render: () => { void reloadStandRead(); },
            onFail: () => {
                toast("Couldn't read the picture right now — try again in a bit.");
            },
        });
    }
    async function reloadStandRead() {
        try {
            const res = await api("/health/synthesis");
            if (DATA && res && typeof res === "object") {
                DATA.synthesis = res.synthesis || DATA.synthesis;
                DATA.synthStale = !!res.stale;
            }
        }
        catch { /* keep the last read */ }
        if (state.tab === "stand" && !state.standSeg)
            showOverview();
    }
    async function renderStand() {
        headerTitle.textContent = "Stand";
        const seg = state.standSeg || null;
        const load = loadStandData();
        // Self-contained tool views paint immediately (they fetch their own data); the
        // overview snapshot warms behind them for the "‹ Stand" step back.
        if (seg === "records") {
            showRecords();
            return;
        }
        if (seg === "share") {
            showShare();
            return;
        }
        if (seg === "learned") {
            showLearned();
            return;
        }
        if (seg === "connections") {
            showConnections();
            return;
        }
        if (seg === "age") {
            showAge();
            return;
        }
        if (seg === "supplements") {
            showSupplements();
            return;
        }
        paint(`<div class="stand-loading loadstate"><span class="loadstate-label">Reading where you stand…</span></div>`);
        try {
            await load;
        }
        catch {
            paint(standErrorHtml());
            return;
        }
        if (state.tab !== "stand")
            return;
        if (seg === "markers") {
            showAllMarkers();
            return;
        }
        if (seg === "body") {
            showBody();
            return;
        }
        if (seg === "recovery") {
            showRecovery();
            return;
        }
        showOverview();
    }
    const CAIRN_STAND = { renderStand };
    Object.assign(globalThis, { CairnStand: CAIRN_STAND, renderStand });
    if (typeof window !== "undefined") {
        window.CairnStand = CAIRN_STAND;
    }
})();
})();
