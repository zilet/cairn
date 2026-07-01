(() => {
// @ts-check
// Health picture/review orchestration: shared cache, review run state, and slot painting.
(() => {
    let healthReviewRun = null;
    let healthReviewError = null;
    function cacheRoot() {
        return globalThis;
    }
    function getHealthPictureCache() {
        return cacheRoot()._hPic ?? null;
    }
    function setHealthPictureCache(cache) {
        cacheRoot()._hPic = cache;
        return cache;
    }
    function rows(value) {
        return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
    }
    function storageFor(deps) {
        if (deps && "storage" in deps)
            return deps.storage ?? null;
        try {
            return typeof localStorage !== "undefined" ? localStorage : null;
        }
        catch {
            return null;
        }
    }
    function healthDocsKnownEmpty(deps) {
        const pic = getHealthPictureCache();
        if (pic && Number.isFinite(pic.docCount))
            return pic.docCount === 0;
        try {
            const cached = storageFor(deps)?.getItem("cairn:healthDocCount");
            if (cached != null)
                return Number(cached) === 0;
        }
        catch { }
        return false;
    }
    function isHealthReviewRunning() {
        return !!healthReviewRun;
    }
    function pictureSlot(deps) {
        const slot = deps.root.querySelector("#hPicture");
        return slot instanceof HTMLElement ? slot : null;
    }
    function paintHealthPicture(deps) {
        const wrap = pictureSlot(deps);
        if (!wrap || !deps.onHealthReadView() || !wrap.isConnected)
            return;
        if (healthReviewRun) {
            wrap.innerHTML = CairnHealthPicture.reviewBusyHtml();
            return;
        }
        const pic = getHealthPictureCache() ?? {};
        const err = healthReviewError ? `<div class="hpic-err">${deps.escapeHtml(healthReviewError)}</div>` : "";
        const parsed = CairnHealthPicture.parsedReview(pic.review);
        if (!parsed && !((pic.docCount ?? 0) > 0)) {
            wrap.innerHTML = CairnHealthPicture.healthHeroHtml(err);
            wrap.querySelector("#hHeroShare")?.addEventListener("click", () => deps.switchHealthSeg("records", { openPicker: true }));
            return;
        }
        if (!parsed) {
            wrap.innerHTML = CairnHealthPicture.buildPictureHtml(err, pic.docCount ?? 0);
            wrap.querySelector("#hRevBtn")?.addEventListener("click", () => { void runHealthReview(deps); });
            return;
        }
        const review = (pic.review || {});
        const rT = Date.parse(String(review.created_at || "")) || 0;
        const dT = Date.parse(pic.newestDocAt || "") || 0;
        wrap.innerHTML = CairnHealthPicture.reviewHtml(review, rT > 0 && dT > rT, err);
        wrap.querySelector("#hRevBtn")?.addEventListener("click", () => { void runHealthReview(deps); });
    }
    async function runHealthReview(deps) {
        if (healthReviewRun)
            return;
        healthReviewError = null;
        healthReviewRun = deps.api("/health/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        })
            .then((res) => (res && typeof res === "object" ? res : null))
            .catch(() => null);
        paintHealthPicture(deps);
        const res = await healthReviewRun;
        healthReviewRun = null;
        if (res && res.ok && res.review) {
            deps.state.healthReview = res.review;
            setHealthPictureCache({ ...(getHealthPictureCache() || {}), review: res.review });
            deps.toast("Your picture is ready");
        }
        else {
            healthReviewError = res && res.error
                ? `The review didn't finish: ${res.error}`
                : "The review didn't come back — give it another try in a bit.";
        }
        paintHealthPicture(deps);
    }
    async function loadHealthPicture(token, docsPromise, deps) {
        let review = null;
        let docs = [];
        let docsOk = false;
        try {
            const rawReview = await deps.api("/health/review");
            review = rawReview && typeof rawReview === "object" ? rawReview : null;
        }
        catch {
            review = null;
        }
        try {
            docs = rows(await docsPromise);
            docsOk = true;
        }
        catch {
            docs = [];
        }
        if (review && review.error)
            review = null;
        if (review)
            deps.state.healthReview = review;
        if (token !== deps.pollToken())
            return;
        const newest = docs.reduce((memo, doc) => (doc.created_at && (!memo || doc.created_at > memo) ? doc.created_at : memo), null);
        setHealthPictureCache({ review, docCount: docs.length, newestDocAt: newest });
        if (docsOk) {
            try {
                storageFor(deps)?.setItem("cairn:healthDocCount", String(docs.length));
            }
            catch { }
        }
        paintHealthPicture(deps);
    }
    const CAIRN_HEALTH_PICTURE_CONTROLLER = {
        getHealthPictureCache,
        healthDocsKnownEmpty,
        isHealthReviewRunning,
        loadHealthPicture,
        paintHealthPicture,
        runHealthReview,
        setHealthPictureCache,
    };
    Object.assign(globalThis, { CairnHealthPictureController: CAIRN_HEALTH_PICTURE_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnHealthPictureController = CAIRN_HEALTH_PICTURE_CONTROLLER;
    }
})();
})();
