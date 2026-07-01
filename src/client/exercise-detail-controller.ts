// @ts-check
// Exercise detail modal controller: guide wiring, explanation hydration, and exercise actions.

type ExerciseDetailControllerRecord = Record<string, unknown>;
type ExerciseDetailControllerWiredElement = Element & { _wired?: boolean };
type ExerciseDetailExplanationPayload = { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
type ExerciseDetailSetRow = ExerciseDetailControllerRecord & {
  date?: string;
  duration_sec?: number | string | null;
  weight?: number | string | null;
  reps?: number | string | null;
  rir?: number | string | null;
  pr?: boolean;
};
type ExerciseDetailProgressPoint = ExerciseDetailControllerRecord & { best1rm?: number | string | null };
type ExerciseDetailPlanAppearance = ExerciseDetailControllerRecord & { day_number?: number | string; day_name?: string };
type ExerciseDetailControllerRow = ExerciseDetailControllerRecord & {
  found?: boolean;
  name?: string;
  muscle_group?: string;
  mode?: string;
  unit?: string;
  recent?: ExerciseDetailSetRow[];
  progress?: { points?: ExerciseDetailProgressPoint[] };
  appears?: ExerciseDetailPlanAppearance[];
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
  const exerciseExplainMisses = new Set<string>();

  function detailRecord(value: unknown): ExerciseDetailControllerRecord {
    return value && typeof value === "object" ? value as ExerciseDetailControllerRecord : {};
  }

  function detailRows<T extends ExerciseDetailControllerRecord = ExerciseDetailControllerRecord>(value: unknown): T[] {
    return Array.isArray(value) ? value.filter((row): row is T => !!row && typeof row === "object") : [];
  }

  function detailNumber(value: unknown, fallback = 0): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function exerciseExplanation(row: ExerciseDetailControllerRow | null | undefined, deps: ExerciseDetailControllerDeps): ExerciseDetailExplanationPayload {
    return deps.exerciseDetail.explanation(row);
  }

  function exerciseExplanationHtml(
    row: ExerciseDetailControllerRow | null | undefined,
    explanation: ExerciseDetailExplanationPayload | null | undefined,
    deps: ExerciseDetailControllerDeps,
  ): string {
    return deps.exerciseDetail.explanationHtml(row, explanation);
  }

  function validExerciseExplanationPayload(value: unknown, deps: ExerciseDetailControllerDeps): value is { explanation?: ExerciseDetailExplanationPayload | null; stale?: boolean } {
    return deps.exerciseDetail.validExplanationPayload(detailRecord(value) as { ok?: unknown; explanation?: ExerciseDetailExplanationPayload | null | undefined; stale?: unknown });
  }

  function replaceExerciseExplanation(el: ParentNode, row: ExerciseDetailControllerRow, explanation: ExerciseDetailExplanationPayload | null | undefined, deps: ExerciseDetailControllerDeps): void {
    const current = el.querySelector<HTMLElement>("[data-exercise-explain]");
    if (!current || current.dataset.exercise !== String(row?.name || "")) return;
    const wrap = document.createElement("template");
    wrap.innerHTML = exerciseExplanationHtml(row, explanation, deps).trim();
    const next = wrap.content.firstElementChild;
    if (next) current.replaceWith(next);
  }

  async function hydrateExerciseExplanation(el: ParentNode, row: ExerciseDetailControllerRow, deps: ExerciseDetailControllerDeps): Promise<void> {
    const key = String(row?.name || "");
    if (!key || exerciseExplainMisses.has(key)) return;
    try {
      const cached = await deps.api("/exercise/" + encodeURIComponent(key) + "/explanation");
      if (validExerciseExplanationPayload(cached, deps)) {
        replaceExerciseExplanation(el, row, cached.explanation, deps);
        if (!cached.stale) return;
      }
    } catch {
      return;
    }
    try {
      const generated = await deps.api("/exercise/" + encodeURIComponent(key) + "/explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "auto" }),
      });
      if (validExerciseExplanationPayload(generated, deps)) {
        replaceExerciseExplanation(el, row, generated.explanation, deps);
      } else {
        exerciseExplainMisses.add(key);
      }
    } catch {
      exerciseExplainMisses.add(key);
    }
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
    const row = detailRecord(await deps.api("/exercise/" + encodeURIComponent(name))) as ExerciseDetailControllerRow;
    const svg = deps.art("exercise", name, row?.muscle_group);
    if (!row || !row.found) {
      deps.openDetailFrom(fromTile, () => {
        deps.mountDetail(`
        <div class="detail-art"><div class="detail-art-zoom">${deps.artImg("exercise", name, "artile-xl", svg)}</div></div>
        <h2 class="detail-title">${deps.escapeHtml(name)}</h2>
        <div class="empty">No data for this exercise yet.</div>
        <div class="detail-actions"><button class="pillbtn" data-close>Close</button></div>`);
        deps.wireDetailCommon();
      });
      return;
    }

    const recent = detailRows<ExerciseDetailSetRow>(row.recent);
    const timed = row.mode === "timed" || recent.some((set) => set.duration_sec != null);
    const points = detailRows<ExerciseDetailProgressPoint>(row.progress?.points);
    const latest = points.slice(-1)[0];
    const hasPR = recent.some((set) => set.pr);

    let heroVal = 0;
    let heroLbl = "";
    let heroTxt = "";
    let sparkVals: unknown[] = [];
    if (timed) {
      const durations = recent.filter((set) => set.duration_sec != null).map((set) => detailNumber(set.duration_sec));
      const best = durations.length ? Math.max(...durations) : 0;
      heroVal = best;
      heroLbl = "best duration";
      heroTxt = deps.fmtDur(best);
      sparkVals = durations.slice().reverse();
    } else if (latest) {
      heroVal = detailNumber(latest.best1rm);
      heroLbl = `est 1RM · ${deps.escapeHtml(row.unit || "lb")} · epley`;
      sparkVals = points.map((point) => point.best1rm);
    }
    const appears = detailRows<ExerciseDetailPlanAppearance>(row.appears)
      .map((appearance) => `D${appearance.day_number} ${deps.escapeHtml(appearance.day_name)}`)
      .join(" · ");
    const recentLines = recent.map((set) => {
      const fig = set.duration_sec != null
        ? deps.fmtDur(set.duration_sec)
        : `${deps.fmtWeight(set.weight)}×${set.reps}${set.rir != null ? ` @${set.rir}` : ""}`;
      return `<div class="detail-setline"><span>${deps.escapeHtml(set.date || "")}</span><span class="numeral">${fig}${set.pr ? ` <span class="prbadge">PR</span>` : ""}</span></div>`;
    }).join("");

    deps.openDetailFrom(fromTile, () => {
      const el = deps.mountDetail(`
      <div class="detail-art"><div class="detail-art-zoom">${deps.artImg("exercise", row.name || name, "artile-xl", svg)}</div></div>
      <h2 class="detail-title">${deps.escapeHtml(row.name || name)}</h2>
      <div class="detail-ctx lbl">${deps.escapeHtml(row.muscle_group || "exercise")}${hasPR ? ` <span class="prbadge">PR</span>` : ""}</div>
      ${heroVal ? `<div class="detail-kcal"><span class="numeral detail-num" ${timed ? "" : `data-cu="${heroVal}"`}>${timed ? heroTxt : "0"}</span><span class="detail-unit lbl">${heroLbl}</span></div>` : ""}
      ${sparkVals.length > 1 ? `<div class="detail-spark">${deps.sparklineSvg(sparkVals)}</div>` : ""}
      ${row.constraint_note ? `<div class="ex-flag">${deps.escapeHtml(row.constraint_note)}</div>` : ""}
      ${exerciseExplanationHtml(row, null, deps)}
      ${row.cues ? `<div class="detail-section"><div class="lbl">Form cues</div><div class="detail-body">${deps.escapeHtml(row.cues)}</div></div>` : ""}
      ${appears ? `<div class="detail-section"><div class="lbl">In your plan</div><div class="detail-body">${appears}</div></div>` : ""}
      <div class="detail-section"><div class="lbl">Recent sets</div>
        ${recentLines || `<div class="detail-body" style="color:var(--muted)">None logged yet.</div>`}</div>
      <div class="detail-section detail-manage">
        <div class="lbl">This exercise</div>
        <div class="manage-row">
          <button class="pillbtn pill-sm" id="exType">Make ${timed ? "reps-based" : "timed (hold)"}</button>
          <button class="pillbtn pill-sm pill-warn" id="exDelete">Delete</button>
        </div>
      </div>
      <div class="detail-actions">
        <button class="pillbtn" id="askForm">Ask coach</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`);
      deps.runCountUps(el);
      deps.wireDetailCommon();
      void hydrateExerciseExplanation(el, row, deps);
      el.querySelector("#askForm")?.addEventListener("click", () => {
        deps.closeDetail(true);
        deps.gotoChatWith(`How should I perform ${name} with good form? Flag anything for my injury constraints.`);
      });
      const typeBtn = el.querySelector<HTMLButtonElement>("#exType");
      if (typeBtn) typeBtn.addEventListener("click", async () => {
        typeBtn.disabled = true;
        const next = timed ? "reps" : "timed";
        try {
          await deps.postExerciseMode(String(row.name || name), next);
          if (deps.state.exModes) deps.state.exModes[String(row.name || name)] = next;
          deps.toast(`${row.name || name} is now ${next === "timed" ? "timed (hold)" : "reps-based"}`);
          deps.closeDetail(true);
          if (deps.state.tab === "today") deps.renderToday();
        } catch {
          typeBtn.disabled = false;
          deps.toast("Couldn't change type — try again");
        }
      });
      const deleteBtn = el.querySelector<HTMLButtonElement>("#exDelete");
      if (deleteBtn) deleteBtn.addEventListener("click", async () => {
        deleteBtn.disabled = true;
        let result: ExerciseDetailControllerRecord;
        try {
          result = detailRecord(await deps.api("/exercises/" + encodeURIComponent(String(row.name || name)), { method: "DELETE" }));
        } catch {
          deleteBtn.disabled = false;
          deps.toast("Couldn't delete — try again");
          return;
        }
        if (result && result.ok) {
          deps.toast(`Deleted ${row.name || name}`);
          deps.closeDetail(true);
          if (deps.state.tab === "today") deps.renderToday();
        } else {
          deleteBtn.disabled = false;
          deps.toast(result && result.error ? `Can't delete ${row.name || name}. ${result.error}` : "Couldn't delete");
        }
      });
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
