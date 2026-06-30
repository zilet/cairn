// @ts-check
// Pure Health picture/review rendering helpers for the vanilla PWA.
(() => {
    function asObject(value) {
        return value && typeof value === "object" ? value : null;
    }
    // review.parsed may arrive as a JSON string or an object.
    function parsedReview(review) {
        if (!review || review.error)
            return null;
        let parsed = review.parsed;
        if (typeof parsed === "string") {
            try {
                parsed = JSON.parse(parsed);
            }
            catch {
                parsed = null;
            }
        }
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    // flag/status -> dot modifier. Colors mirror the marker flag pills:
    // low/high -> warn, "watch" -> gold, normal -> sage, none -> neutral hairline.
    function healthDotClass(flag) {
        const f = String(flag || "").toLowerCase();
        if (f === "low" || f === "high" || f === "abnormal" || f === "critical")
            return "hdot-warn";
        if (f === "normal" || f === "ok")
            return "hdot-ok";
        return f ? "hdot-watch" : "hdot-mute";
    }
    function reviewBusyHtml() {
        return `<div class="hpic hpic-busy">
    <div class="hpic-top"><span class="lbl">Your picture</span><span class="hpic-when">reviewing…</span></div>
    <div class="hshimmer hshimmer-lg"></div>
    <div class="hshimmer"></div>
    <div class="hshimmer hshimmer-sm"></div>
    <div class="hpic-busynote">Reading every record and trend — this can take a few minutes. You can keep using Cairn.</div>
  </div>`;
    }
    function healthHeroHtml(errorHtml) {
        return `<div class="hpic hpic-hero reveal" style="${stagger(0)}">
    <div class="artile artile-lg hpic-hero-art">${CairnHealthClient.HEALTH_HERO_ART}</div>
    <div class="hpic-hero-title">Build your whole picture</div>
    <div class="hpic-hero-sub">Share your bloodwork or a DEXA scan and Cairn reads it — markers, trends, and a coach's-eye view of what to do next.</div>
    ${String(errorHtml || "")}
    <button id="hHeroShare" class="logbtn hpic-cta-btn">SHARE A DOCUMENT</button>
  </div>`;
    }
    function buildPictureHtml(errorHtml, docCount) {
        const n = Number(docCount) || 0;
        return `<div class="hpic hpic-build reveal" style="${stagger(0)}">
    <span class="lbl">Your picture</span>
    <div class="hpic-headline">Your records are in.</div>
    <div class="hpic-hero-sub">One review across ${n === 1 ? "your document" : `all ${n} documents`} — what's strong, what to watch, and what to do this week.</div>
    ${String(errorHtml || "")}
    <button id="hRevBtn" class="logbtn hpic-cta-btn">BUILD MY PICTURE</button>
  </div>`;
    }
    function reviewHtml(review, stale, errorHtml) {
        const parsed = parsedReview(review) || {};
        const latestISO = latestReviewDate(parsed);
        const hz = (text) => escHtml(humanizeReviewText(String(text || ""), latestISO));
        const focus = (Array.isArray(parsed.focus) ? parsed.focus : [])
            .map(asObject)
            .filter((item) => !!item && !!(item.title || item.action))
            .map((item) => `
    <div class="hfocus">
      ${item.title ? `<div class="hfocus-title">${hz(item.title)}</div>` : ""}
      ${item.why ? `<div class="hfocus-why">${hz(item.why)}</div>` : ""}
      ${item.action ? `<div class="hfocus-act">→ ${hz(item.action)}</div>` : ""}
    </div>`)
            .join("");
        const watch = (Array.isArray(parsed.watchlist) ? parsed.watchlist : [])
            .map(asObject)
            .filter((item) => !!item && !!(item.marker || item.why))
            .map((item) => `
    <div class="hwatch">
      <span class="hdot ${healthDotClass(item.status)}"></span>
      <div class="hwatch-main">
        <div class="hwatch-line"><span class="hwatch-name">${escHtml(item.marker || "")}</span>${item.status ? `<span class="hwatch-st">${escHtml(item.status)}</span>` : ""}</div>
        ${item.why ? `<div class="hwatch-why">${hz(item.why)}</div>` : ""}
        ${item.action ? `<div class="hwatch-act">${hz(item.action)}</div>` : ""}
      </div>
    </div>`)
            .join("");
        const wins = (Array.isArray(parsed.wins) ? parsed.wins : [])
            .filter(Boolean)
            .map((win) => `<li>${hz(win)}</li>`)
            .join("");
        const followups = (Array.isArray(parsed.followups) ? parsed.followups : [])
            .map(asObject)
            .filter((item) => !!item && !!item.what)
            .map((item) => `
    <div class="hfu"><span class="hfu-what">${hz(item.what)}</span>${item.when ? `<span class="hfu-when">${escHtml(item.when)}</span>` : ""}</div>`)
            .join("");
        const impacts = [["Training", parsed.training_impact], ["Nutrition", parsed.nutrition_impact]]
            .filter(([, value]) => value)
            .map(([label, value]) => `<div class="himpact"><span class="lbl">${label}</span><span class="himpact-t">${hz(value)}</span></div>`)
            .join("");
        const createdAt = typeof review.created_at === "string" ? review.created_at : "";
        const when = createdAt ? `Reviewed ${relTime(createdAt)}` : "Reviewed";
        const asOf = latestISO ? `<span class="hpic-asof lbl">As of ${escHtml(humanDate(latestISO))}</span>` : "";
        const refresh = stale
            ? `<button id="hRevBtn" class="hpic-refresh hpic-refresh-stale" title="New results since this review"><span class="hdot hdot-warn"></span>New results — refresh</button>`
            : `<button id="hRevBtn" class="hpic-refresh">↻ refresh</button>`;
        const agent = review.agent ? String(review.agent) : "";
        return `<div class="hpic reveal" style="${stagger(0)}">
    <span class="lbl">Your picture</span>
    ${parsed.headline ? `<div class="hpic-headline">${hz(parsed.headline)}</div>` : ""}
    ${asOf}
    ${focus ? `<span class="hpic-sub lbl">This week's focus</span><div class="hfocus-list">${focus}</div>` : ""}
    ${watch ? `<span class="hpic-sub lbl">Watchlist</span><div class="hwatch-list">${watch}</div>` : ""}
    ${wins ? `<span class="hpic-sub lbl">Going well</span><ul class="hwins">${wins}</ul>` : ""}
    ${followups ? `<span class="hpic-sub lbl">Follow-ups</span><div class="hfu-list">${followups}</div>` : ""}
    ${impacts ? `<div class="himpacts">${impacts}</div>` : ""}
    ${String(errorHtml || "")}
    <div class="hpic-foot">
      <span class="hpic-when">${escHtml(when)}${agent ? ` · ${escHtml(agent)}` : ""}</span>
      ${refresh}
    </div>
  </div>`;
    }
    const CAIRN_HEALTH_PICTURE = {
        parsedReview,
        healthDotClass,
        reviewBusyHtml,
        healthHeroHtml,
        buildPictureHtml,
        reviewHtml,
    };
    Object.assign(globalThis, { CairnHealthPicture: CAIRN_HEALTH_PICTURE });
    if (typeof window !== "undefined") {
        window.CairnHealthPicture = CAIRN_HEALTH_PICTURE;
    }
})();
