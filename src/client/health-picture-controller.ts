// @ts-check
// Health picture/review orchestration: shared cache, review run state, and slot painting.

type HealthPictureCache = { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null };
type HealthPictureCacheRoot = typeof globalThis & { _hPic?: HealthPictureCache | null };
type HealthReviewRunResult = { ok?: boolean; review?: Record<string, unknown>; error?: string } | null;
type HealthReviewRecord = Record<string, unknown> & { created_at?: string; error?: unknown };
type HealthDocumentRow = Record<string, unknown> & { created_at?: string };

type HealthPictureControllerDeps = {
  root: ParentNode;
  state: { healthReview?: unknown };
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): Promise<unknown>;
  toast(message: string): void;
  switchHealthSeg(seg: "read" | "markers" | "records" | "share" | "learned", opts?: { openPicker?: boolean }): void;
  onHealthReadView(): boolean;
  pollToken(): number;
  escapeHtml(value: unknown): string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};

(() => {
  let healthReviewRunning = false;
  let healthReviewError: string | null = null;

  function cacheRoot(): HealthPictureCacheRoot {
    return globalThis as HealthPictureCacheRoot;
  }

  function getHealthPictureCache(): HealthPictureCache | null {
    return cacheRoot()._hPic ?? null;
  }

  function setHealthPictureCache(cache: HealthPictureCache | null): HealthPictureCache | null {
    cacheRoot()._hPic = cache;
    return cache;
  }

  function rows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[] {
    return Array.isArray(value) ? (value.filter((row) => !!row && typeof row === "object") as T[]) : [];
  }

  function storageFor(deps?: Partial<HealthPictureControllerDeps>): Pick<Storage, "getItem" | "setItem"> | null {
    if (deps && "storage" in deps) return deps.storage ?? null;
    try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
  }

  function healthDocsKnownEmpty(deps?: Partial<HealthPictureControllerDeps>): boolean {
    const pic = getHealthPictureCache();
    if (pic && Number.isFinite(pic.docCount)) return pic.docCount === 0;
    try {
      const cached = storageFor(deps)?.getItem("cairn:healthDocCount");
      if (cached != null) return Number(cached) === 0;
    } catch {}
    return false;
  }

  function isHealthReviewRunning(): boolean {
    return healthReviewRunning;
  }

  function pictureSlot(deps: HealthPictureControllerDeps): HTMLElement | null {
    const slot = deps.root.querySelector("#hPicture");
    return slot instanceof HTMLElement ? slot : null;
  }

  function paintHealthPicture(deps: HealthPictureControllerDeps): void {
    const wrap = pictureSlot(deps);
    if (!wrap || !deps.onHealthReadView() || !wrap.isConnected) return;
    if (healthReviewRunning) {
      wrap.innerHTML = CairnHealthPicture.reviewBusyHtml();
      return;
    }
    const pic: HealthPictureCache = getHealthPictureCache() ?? {};
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
    const review = (pic.review || {}) as HealthReviewRecord;
    const rT = Date.parse(String(review.created_at || "")) || 0;
    const dT = Date.parse(pic.newestDocAt || "") || 0;
    wrap.innerHTML = CairnHealthPicture.reviewHtml(review, rT > 0 && dT > rT, err);
    wrap.querySelector("#hRevBtn")?.addEventListener("click", () => { void runHealthReview(deps); });
  }

  // A whole-picture review is a durable background agent job (default bg_ops): the
  // route returns {ok, job} and the review streams to completion off the request
  // path, so this uses the shared runOp pattern (like the health-synthesis caller)
  // instead of a blocking POST — which, under bg_ops, always read `res.review` as
  // undefined and showed "The review didn't come back" while the job ran invisibly.
  // With bg_ops OFF the route responds inline with {ok, review} and runOp renders
  // that synchronously, so both paths land here.
  function reviewFailed(result: unknown): boolean {
    const res = result && typeof result === "object" ? (result as HealthReviewRunResult) : null;
    return !res || res.ok === false || !res.review;
  }

  function reviewOpOpts(deps: HealthPictureControllerDeps): ClientAgentOpHandlers {
    return {
      path: "/health/review",
      guard: () => !pictureSlot(deps)?.isConnected,
      isFail: reviewFailed,
      render: (result: unknown) => {
        healthReviewRunning = false;
        const res = result as HealthReviewRunResult;
        if (res && res.ok && res.review) {
          deps.state.healthReview = res.review;
          setHealthPictureCache({ ...(getHealthPictureCache() || {}), review: res.review });
          deps.toast("Your picture is ready");
        }
        paintHealthPicture(deps);
      },
      onFail: (error: unknown) => {
        healthReviewRunning = false;
        const res = error && typeof error === "object" ? (error as HealthReviewRunResult) : null;
        healthReviewError = res && res.error
          ? `The review didn't finish: ${res.error}`
          : "The review didn't come back — give it another try in a bit.";
        paintHealthPicture(deps);
      },
    };
  }

  async function runHealthReview(deps: HealthPictureControllerDeps): Promise<void> {
    if (healthReviewRunning) return;
    healthReviewError = null;
    healthReviewRunning = true;
    paintHealthPicture(deps); // busy card immediately; render/onFail flip it back
    await deps.runOp("health_review", {}, reviewOpOpts(deps));
  }

  // Reattach to an in-flight review job after a reload (registered for the
  // "health_review" job kind). Only when the user is actually on the health read
  // view; otherwise the finished review is picked up by loadHealthPicture on the
  // next visit (it's persisted server-side).
  function reconnectHealthReview(deps: HealthPictureControllerDeps): ClientAgentOpHandlers | null {
    if (!deps.onHealthReadView()) return null;
    if (!pictureSlot(deps)) return null;
    healthReviewRunning = true;
    healthReviewError = null;
    paintHealthPicture(deps);
    const opts = reviewOpOpts(deps);
    return {
      guard: opts.guard,
      onDone: (result: unknown) => {
        if (reviewFailed(result)) opts.onFail?.(result);
        else opts.render?.(result);
      },
      onError: (message?: unknown) => opts.onFail?.(message ?? null),
      onCanceled: () => opts.onFail?.(null),
    };
  }

  async function loadHealthPicture(token: number, docsPromise: Promise<unknown>, deps: HealthPictureControllerDeps): Promise<void> {
    let review: HealthReviewRecord | null = null;
    let docs: HealthDocumentRow[] = [];
    let docsOk = false;
    try {
      const rawReview = await deps.api("/health/review");
      review = rawReview && typeof rawReview === "object" ? (rawReview as HealthReviewRecord) : null;
    } catch { review = null; }
    try {
      docs = rows<HealthDocumentRow>(await docsPromise);
      docsOk = true;
    } catch { docs = []; }
    if (review && review.error) review = null;
    if (review) deps.state.healthReview = review;
    if (token !== deps.pollToken()) return;
    const newest = docs.reduce<string | null>(
      (memo, doc) => (doc.created_at && (!memo || doc.created_at > memo) ? doc.created_at : memo),
      null,
    );
    setHealthPictureCache({ review, docCount: docs.length, newestDocAt: newest });
    if (docsOk) {
      try { storageFor(deps)?.setItem("cairn:healthDocCount", String(docs.length)); } catch {}
    }
    paintHealthPicture(deps);
  }

  const CAIRN_HEALTH_PICTURE_CONTROLLER = {
    getHealthPictureCache,
    healthDocsKnownEmpty,
    isHealthReviewRunning,
    loadHealthPicture,
    paintHealthPicture,
    reconnectHealthReview,
    runHealthReview,
    setHealthPictureCache,
  };

  Object.assign(globalThis, { CairnHealthPictureController: CAIRN_HEALTH_PICTURE_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnHealthPictureController = CAIRN_HEALTH_PICTURE_CONTROLLER;
  }
})();
