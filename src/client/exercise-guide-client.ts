// @ts-check
// The "How to" layer inside the exercise detail overlay.
//
// Calm and pulled, never pushed: the section arrives COLLAPSED behind one quiet
// summary row, so an athlete who already knows the lift sees a single line, and one
// tap opens the steps. It renders only when a guide was matched confidently — an
// un-imported library or an unmatched movement produces an empty string, and the
// sheet reads exactly as it did before. No scores, no grades; "level" is the
// dataset's own word for how technical the movement is, shown as plain context.

type ExerciseGuideImage = { index?: unknown; url?: unknown };
type ExerciseGuideSuggestionPayload = { exercise?: unknown; guide_id?: unknown; guide_name?: unknown };
type ExerciseGuideWireOptions = {
  api?: (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;
};
type ExerciseGuidePayload = {
  guide_id?: unknown;
  match_confidence?: unknown;
  name?: unknown;
  level?: unknown;
  mechanic?: unknown;
  force?: unknown;
  equipment?: unknown;
  category?: unknown;
  primary_muscles?: unknown;
  secondary_muscles?: unknown;
  instructions?: unknown;
  images?: unknown;
  source?: unknown;
  license?: unknown;
  source_url?: unknown;
};

(() => {
  function textList(value: unknown, limit: number): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
      .slice(0, limit);
  }

  function words(value: unknown): string {
    return String(value ?? "").trim();
  }

  // "body only" is the dataset's phrasing; the athlete's word for it is bodyweight.
  function equipmentWords(value: unknown): string {
    const raw = words(value).toLowerCase();
    if (!raw) return "";
    if (raw === "body only") return "bodyweight";
    if (raw === "e-z curl bar") return "EZ bar";
    if (raw === "bands") return "a band";
    if (raw === "kettlebells") return "a kettlebell";
    if (raw === "other") return "";
    return raw;
  }

  // A single tracked-caps context line: what it works, with what, how technical.
  function contextLine(guide: ExerciseGuidePayload): string {
    const parts: string[] = [];
    const primary = textList(guide.primary_muscles, 3);
    if (primary.length) parts.push(primary.join(" · "));
    const equipment = equipmentWords(guide.equipment);
    if (equipment) parts.push(equipment);
    const level = words(guide.level);
    if (level) parts.push(level);
    return parts.join(" — ");
  }

  function photosHtml(guide: ExerciseGuidePayload): string {
    const images = Array.isArray(guide.images) ? (guide.images as ExerciseGuideImage[]) : [];
    const name = words(guide.name) || "this movement";
    // Two frames: the start position and the finish. Labelled so the pair reads as a
    // movement rather than as two unrelated photographs.
    const frames = images
      .map((image, position) => {
        const url = String(image?.url ?? "");
        if (!url) return "";
        const label = position === 0 ? "Start" : position === 1 ? "Finish" : `Frame ${position + 1}`;
        return `<figure class="exguide-shot">
            <img class="exguide-img" data-exguide-img="1" loading="lazy" decoding="async"
              alt="${escAttr(`${label} position for ${name}`)}" src="${escAttr(withToken(url))}">
            <figcaption class="lbl">${escHtml(label)}</figcaption>
          </figure>`;
      })
      .filter(Boolean);
    if (!frames.length) return "";
    return `<div class="exguide-shots" data-exguide-shots="1">${frames.join("")}</div>`;
  }

  function stepsHtml(guide: ExerciseGuidePayload): string {
    const steps = textList(guide.instructions, 40);
    if (!steps.length) return "";
    return `<ol class="exguide-steps">${steps.map((step) => `<li>${escHtml(step)}</li>`).join("")}</ol>`;
  }

  function alsoWorksHtml(guide: ExerciseGuidePayload): string {
    const secondary = textList(guide.secondary_muscles, 6);
    if (!secondary.length) return "";
    return `<div class="exguide-also"><span class="lbl">Also works</span> ${escHtml(secondary.join(", "))}</div>`;
  }

  // The dataset is public domain, but saying where the words came from is the honest
  // thing to do — and it marks the section as imported reference material rather
  // than the coach speaking.
  function creditHtml(guide: ExerciseGuidePayload): string {
    const source = words(guide.source);
    if (!source) return "";
    const license = words(guide.license);
    const url = words(guide.source_url);
    const label = license ? `${source} · ${license}` : source;
    const inner = /^https:\/\//.test(url)
      ? `<a class="exguide-src" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`
      : `<span class="exguide-src">${escHtml(label)}</span>`;
    return `<div class="exguide-credit">${inner}</div>`;
  }

  // The way back out, kept inside the opened section rather than on the summary row:
  // an athlete who never opens "How to" never sees an affordance for undoing it.
  function unlinkHtml(guide: ExerciseGuidePayload): string {
    const guideId = words(guide.guide_id);
    if (!guideId) return "";
    return `<button type="button" class="exguide-unlink" data-exguide-unlink="${escAttr(guideId)}">Not this movement</button>`;
  }

  /** The collapsed "How to" section, or "" when there is no confident guide to show. */
  function exerciseGuideSectionHtml(guide: unknown): string {
    if (!guide || typeof guide !== "object") return "";
    const payload = guide as ExerciseGuidePayload;
    const steps = stepsHtml(payload);
    if (!steps) return "";
    const context = contextLine(payload);
    return `<details class="detail-section exguide" data-exguide="1">
        <summary class="exguide-summary">
          <span class="lbl">How to</span>
          ${context ? `<span class="exguide-ctx">${escHtml(context)}</span>` : ""}
        </summary>
        <div class="exguide-body">
          ${photosHtml(payload)}
          ${steps}
          ${alsoWorksHtml(payload)}
          <div class="exguide-foot">
            ${creditHtml(payload)}
            ${unlinkHtml(payload)}
          </div>
        </div>
      </details>`;
  }

  /**
   * The one-line question behind a low-confidence match: the matcher found something
   * plausible but will not show it uninvited. A quiet ask with two quiet answers — no
   * badge, no count, no alarm, and nothing at all when there is no candidate.
   */
  function exerciseGuideSuggestionHtml(suggestion: unknown): string {
    if (!suggestion || typeof suggestion !== "object") return "";
    const payload = suggestion as ExerciseGuideSuggestionPayload;
    const guideId = words(payload.guide_id);
    const guideName = words(payload.guide_name);
    const exercise = words(payload.exercise);
    if (!guideId || !guideName || !exercise) return "";
    return `<div class="detail-section exguide-ask" data-exguide-ask="1"
        data-exguide-id="${escAttr(guideId)}" data-exguide-exercise="${escAttr(exercise)}">
        <span class="exguide-ask-line">Looks like ${escHtml(guideName)} — use its guide?</span>
        <span class="exguide-ask-acts">
          <button type="button" class="exguide-ask-btn" data-exguide-yes="1">Yes</button>
          <button type="button" class="exguide-ask-btn" data-exguide-no="1">No</button>
        </span>
      </div>`;
  }

  /**
   * A demonstration photo that has not been cached yet answers 204 (no body), which
   * an <img> reports as an error. Drop the frame quietly rather than leave a broken
   * icon, and drop the whole strip once every frame has failed — the steps stand on
   * their own.
   */
  function wireExerciseGuide(scope: ParentNode | null | undefined, options: ExerciseGuideWireOptions = {}): void {
    const root = scope || document;
    root.querySelectorAll<HTMLImageElement>("[data-exguide-img]").forEach((img) => {
      img.addEventListener(
        "error",
        () => {
          const figure = img.closest(".exguide-shot");
          figure?.remove();
          const strip = root.querySelector("[data-exguide-shots]");
          if (strip && !strip.querySelector(".exguide-shot")) strip.remove();
        },
        { once: true }
      );
    });
    wireExerciseGuideAnswer(root, options);
  }

  function post(apiFn: ExerciseGuideWireOptions["api"], path: string, body: unknown): Promise<unknown> {
    if (!apiFn) return Promise.reject(new Error("no api"));
    return apiFn(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function ok(result: unknown): boolean {
    return Boolean(result && typeof result === "object" && (result as { ok?: unknown }).ok);
  }

  /** Swap one node for the first element of `html`, or just remove it when empty. */
  function replaceNode(node: Element, html: string): Element | null {
    if (!html) {
      node.remove();
      return null;
    }
    const host = (node.ownerDocument || document).createElement("div");
    host.innerHTML = html;
    const next = host.firstElementChild;
    if (!next) {
      node.remove();
      return null;
    }
    node.replaceWith(next);
    return next;
  }

  // Yes attaches the guide and shows it in place — the answer IS the feedback, so no
  // toast and no confirmation step. No dismisses it, and the server remembers the no
  // so the next import does not ask again.
  function wireExerciseGuideAnswer(root: ParentNode, options: ExerciseGuideWireOptions): void {
    const apiFn = options.api || (typeof api !== "undefined" ? api : undefined);
    if (!apiFn) return;

    root.querySelectorAll<HTMLElement>("[data-exguide-ask]").forEach((ask) => {
      const guideId = String(ask.dataset.exguideId || "");
      const exercise = String(ask.dataset.exguideExercise || "");
      if (!guideId || !exercise) return;
      ask.querySelector("[data-exguide-yes]")?.addEventListener("click", async () => {
        let guide: unknown = null;
        try {
          if (!ok(await post(apiFn, "/exercise-guides/attach", { exercise, guide_id: guideId }))) return;
          guide = await apiFn(`/exercise-guides/${encodeURIComponent(exercise)}`);
        } catch {
          return;
        }
        if (!ask.isConnected) return;
        const next = replaceNode(ask, exerciseGuideSectionHtml(guide));
        if (next) wireExerciseGuide(next, options);
      });
      ask.querySelector("[data-exguide-no]")?.addEventListener("click", async () => {
        try {
          if (!ok(await post(apiFn, "/exercise-guides/detach", { guide_id: guideId }))) return;
        } catch {
          return;
        }
        ask.remove();
      });
    });

    root.querySelectorAll<HTMLElement>("[data-exguide-unlink]").forEach((button) => {
      const guideId = String(button.dataset.exguideUnlink || "");
      if (!guideId) return;
      button.addEventListener("click", async () => {
        try {
          if (!ok(await post(apiFn, "/exercise-guides/detach", { guide_id: guideId }))) return;
        } catch {
          return;
        }
        (button.closest("[data-exguide]") || button).remove();
      });
    });
  }

  const CAIRN_EXERCISE_GUIDE = {
    sectionHtml: exerciseGuideSectionHtml,
    suggestionHtml: exerciseGuideSuggestionHtml,
    wire: wireExerciseGuide,
  };

  Object.assign(globalThis, { CairnExerciseGuide: CAIRN_EXERCISE_GUIDE });

  if (typeof window !== "undefined") {
    window.CairnExerciseGuide = CAIRN_EXERCISE_GUIDE;
  }
})();
