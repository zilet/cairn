// @ts-check
// Exercise detail modal controller: guide wiring, explanation hydration, and exercise actions.

type ExerciseDetailControllerRecord = Record<string, unknown>;
type ExerciseDetailControllerWiredElement = Element & { _wired?: boolean };
type ExerciseDetailExplanationPayload = { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
type ExerciseDetailControllerRow = ExerciseDetailControllerRecord & {
  found?: boolean;
  name?: string;
  muscle_group?: string;
  mode?: string;
  unit?: string;
  recent?: ExerciseDetailDataSetRow[];
  progress?: { points?: ExerciseDetailDataProgressPoint[] };
  appears?: ExerciseDetailDataPlanAppearance[];
  constraint_note?: string;
  cues?: string;
};
type ExerciseDetailApi = {
  explanation(row: ExerciseDetailControllerRow | null | undefined): ExerciseDetailExplanationPayload;
  explanationHtml(row: ExerciseDetailControllerRow | null | undefined, explanation?: ExerciseDetailExplanationPayload | null): string;
  validExplanationPayload(row: { ok?: unknown; explanation?: ExerciseDetailExplanationPayload | null | undefined; stale?: unknown } | null | undefined): boolean;
};
type ExerciseDetailControllerDeps = {
  root: ParentNode;
  state: { tab?: string; exModes?: Record<string, string> };
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  art(kind: string, ...args: unknown[]): string;
  artImg(kind: string, query: unknown, className?: string, svg?: string | null): string;
  closeDetail(instant?: boolean): void;
  escapeHtml(value: unknown): string;
  exerciseDetail: ExerciseDetailApi;
  fmtDur(seconds: unknown): string;
  fmtWeight(weight: unknown): string;
  gotoChatWith(text: string): void;
  mountDetail(html: string, photoSrc?: string | null): HTMLElement;
  openDetailFrom(fromEl: Element | null | undefined, build: () => unknown): void;
  postExerciseMode(name: string, mode: string): Promise<unknown>;
  renderToday(): unknown;
  runCountUps(scope?: ParentNode | null, options?: { snap?: boolean }): void;
  sparklineSvg(values: unknown, width?: number, height?: number): string;
  toast(message: string): void;
  wireDetailCommon(): void;
};

(() => {
  function exerciseExplanation(row: ExerciseDetailControllerRow | null | undefined, deps: ExerciseDetailControllerDeps): ExerciseDetailExplanationPayload {
    return CairnExerciseDetailExplanation.exerciseExplanation(row, deps);
  }

  function exerciseExplanationHtml(
    row: ExerciseDetailControllerRow | null | undefined,
    explanation: ExerciseDetailExplanationPayload | null | undefined,
    deps: ExerciseDetailControllerDeps,
  ): string {
    return CairnExerciseDetailExplanation.exerciseExplanationHtml(row, explanation, deps);
  }

  function replaceExerciseExplanation(el: ParentNode, row: ExerciseDetailControllerRow, explanation: ExerciseDetailExplanationPayload | null | undefined, deps: ExerciseDetailControllerDeps): void {
    CairnExerciseDetailExplanation.replaceExerciseExplanation(el, row, explanation, deps);
  }

  async function hydrateExerciseExplanation(el: ParentNode, row: ExerciseDetailControllerRow, deps: ExerciseDetailControllerDeps): Promise<void> {
    await CairnExerciseDetailExplanation.hydrateExerciseExplanation(el, row, deps);
  }

  function wireGuides(scope: ParentNode | null | undefined, deps: ExerciseDetailControllerDeps): void {
    (scope || deps.root).querySelectorAll<HTMLElement>("[data-guide]").forEach((button) => {
      const wiredButton = button as HTMLElement & ExerciseDetailControllerWiredElement;
      if (wiredButton._wired) return;
      wiredButton._wired = true;
      const name = decodeURIComponent(String(button.dataset.guide || ""));
      const tileOf = () => button.closest(".ex, .prog-row")?.querySelector(".artile") || null;
      button.addEventListener("click", () => {
        void openExerciseModal(name, tileOf(), deps);
      });
      const tile = tileOf() as (HTMLElement & ExerciseDetailControllerWiredElement) | null;
      if (tile && !tile._wired) {
        tile._wired = true;
        tile.style.cursor = "pointer";
        tile.addEventListener("click", () => {
          void openExerciseModal(name, tile, deps);
        });
      }
    });
  }

  async function openExerciseModal(nameInput: unknown, fromTile: Element | null | undefined, deps: ExerciseDetailControllerDeps): Promise<void> {
    const name = String(nameInput || "");
    const row = CairnExerciseDetailData.record(await deps.api("/exercise/" + encodeURIComponent(name))) as ExerciseDetailControllerRow;
    const svg = deps.art("exercise", name, row?.muscle_group);
    if (!row || !row.found) {
      deps.openDetailFrom(fromTile, () => {
        const el = deps.mountDetail(CairnExerciseDetailRender.missingHtml(name, svg, deps));
        deps.wireDetailCommon();
        // Even without a stored row, offer the useful path: ask the coach. (The
        // 'exercise' enrichment may still be building the guide in the background;
        // reopening in a moment picks it up.)
        el.querySelector("#askForm")?.addEventListener("click", () => {
          deps.closeDetail(true);
          deps.gotoChatWith(`How should I perform ${name} with good form? Flag anything for my injury constraints.`);
        });
      });
      return;
    }

    const view = CairnExerciseDetailData.view(row, deps);

    deps.openDetailFrom(fromTile, () => {
      const el = deps.mountDetail(CairnExerciseDetailRender.modalHtml(
        row,
        name,
        svg,
        view,
        exerciseExplanationHtml(row, null, deps),
        deps,
      ));
      deps.runCountUps(el);
      deps.wireDetailCommon();
      CairnExerciseGuide.wire(el, { api: deps.api });
      void hydrateExerciseExplanation(el, row, deps);
      CairnExerciseDetailActions.wireActions(el, row, name, view.timed, deps);
    });
  }

  const CAIRN_EXERCISE_DETAIL_CONTROLLER = {
    exerciseExplanation,
    exerciseExplanationHtml,
    hydrateExerciseExplanation,
    openExerciseModal,
    replaceExerciseExplanation,
    wireGuides,
  };

  Object.assign(globalThis, { CairnExerciseDetailController: CAIRN_EXERCISE_DETAIL_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnExerciseDetailController = CAIRN_EXERCISE_DETAIL_CONTROLLER;
  }
})();
