// @ts-check
// Today add/off-plan exercise controller: form wiring and transient card insertion.

type TodayAddExercisePending = { name: string; mode?: string | null };
type TodayAddExerciseState = {
  logDate: string;
  exModes?: Record<string, string>;
  pendingOffPlan?: Record<string, TodayAddExercisePending[]>;
};
type TodayAddExerciseDeps = {
  root: Element;
  state: TodayAddExerciseState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  postExerciseMode(name: string, mode: string): Promise<unknown>;
  exCard(
    item: Record<string, unknown>,
    logged: Array<Record<string, unknown>>,
    prefill: Record<string, unknown>,
    revealIdx: unknown,
    rx: unknown,
    lastSet?: unknown,
  ): string;
  wireGuides(card: Element): void;
  wireLogRow(row: Element | null): void;
  wireSkips(): void;
  toast(message: string): void;
  escapeHtml(value: unknown): string;
  escapeAttr(value: unknown): string;
  parseDur(value: string): number | null;
};

(() => {
  function setMode(modeWrap: Element, mode: string): void {
    modeWrap.querySelectorAll<HTMLElement>(".modebtn").forEach((button) => {
      button.classList.toggle("active", button.dataset.exmode === mode);
    });
  }

  function resetAddForm(input: HTMLInputElement, form: HTMLElement, button: HTMLElement, modeWrap: Element): void {
    input.value = "";
    form.hidden = true;
    button.hidden = false;
    setMode(modeWrap, "reps");
  }

  async function loadExerciseOptions(datalist: Element, deps: TodayAddExerciseDeps): Promise<void> {
    if (datalist.children.length) return;
    try {
      const rows = await deps.api("/exercises");
      const exercises = Array.isArray(rows) ? rows : [];
      deps.state.exModes = Object.fromEntries(exercises.map((row) => {
        const ex = row && typeof row === "object" ? row as Record<string, unknown> : {};
        return [String(ex.name || ""), String(ex.mode || "reps")];
      }).filter(([name]) => name));
      datalist.innerHTML = exercises.map((row) => {
        const ex = row && typeof row === "object" ? row as Record<string, unknown> : {};
        return `<option value="${deps.escapeAttr(ex.name)}">${deps.escapeHtml(ex.muscle_group || "")}</option>`;
      }).join("");
    } catch {
      // Free-typed names still work.
    }
  }

  function existingCardFor(root: ParentNode, name: string): HTMLElement | null {
    return [...root.querySelectorAll<HTMLElement>(".ex[data-card]")]
      .find((el) => (el.dataset.card || "").toLowerCase() === name.toLowerCase()) || null;
  }

  function skippedButtonFor(root: ParentNode, name: string): HTMLElement | null {
    return [...root.querySelectorAll<HTMLElement>("#skipLine [data-unskip]")]
      .find((button) => decodeURIComponent(button.dataset.unskip || "").toLowerCase() === name.toLowerCase()) || null;
  }

  // Shared GET /last-set fetch — feeds both the "Last time: …" prefill/line and the
  // live "That beats last time" wiring, for a freshly-inserted off-plan card exactly
  // like a plan card gets via loadLastSets. Failure (offline, unknown exercise) just
  // means no last-set line this time; the card still renders.
  async function fetchLastSet(name: string, deps: TodayAddExerciseDeps): Promise<Record<string, unknown> | null> {
    try {
      const last = await deps.api("/last-set?exercise=" + encodeURIComponent(name));
      return last && typeof last === "object" ? last as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  async function replaceEmptyExistingCard(existing: HTMLElement, name: string, mode: string, deps: TodayAddExerciseDeps): Promise<HTMLElement | null> {
    const lastSet = await fetchLastSet(name, deps);
    const tpl = document.createElement("template");
    tpl.innerHTML = deps.exCard({ exercise: name, fromPlan: false, mode }, [], {
      weight: null,
      reps: null,
      rir: null,
      duration_sec: null,
    }, null, null, lastSet).trim();
    const fresh = tpl.content.firstElementChild as HTMLElement | null;
    if (!fresh) return null;
    existing.replaceWith(fresh);
    deps.wireGuides(fresh);
    const logRow = fresh.querySelector(".logrow");
    deps.wireLogRow(logRow);
    CairnTodaySessionSetModel.wireLastSetLine(logRow, lastSet, deps);
    deps.wireSkips();
    fresh.scrollIntoView({ behavior: "smooth", block: "center" });
    (fresh.querySelector<HTMLElement>(".in-dur") || fresh.querySelector<HTMLElement>(".in-r"))?.focus();
    return fresh;
  }

  async function appendOffPlanCard(name: string, mode: string | null | undefined, deps: TodayAddExerciseDeps): Promise<void> {
    deps.state.pendingOffPlan ??= {};
    const list = (deps.state.pendingOffPlan[deps.state.logDate] ??= []);
    if (!list.some((pending) => pending.name.toLowerCase() === name.toLowerCase())) {
      list.push({ name, mode: mode || "reps" });
    }

    const lastSet = await fetchLastSet(name, deps);
    const prefill: Record<string, unknown> = lastSet
      ? {
          weight: lastSet.weight ?? null,
          reps: lastSet.reps ?? null,
          rir: lastSet.rir ?? null,
          duration_sec: lastSet.duration_sec ?? null,
        }
      : { weight: null, reps: null, rir: null, duration_sec: null };

    const tpl = document.createElement("template");
    tpl.innerHTML = deps.exCard({ exercise: name, fromPlan: false, mode: mode || null }, [], prefill, null, null, lastSet).trim();
    const cardEl = tpl.content.firstElementChild as HTMLElement | null;
    if (!cardEl) return;
    const addBlock = deps.root.querySelector(".addex");
    if (addBlock) addBlock.before(cardEl);
    else (deps.root.querySelector(".plansurface") || deps.root).appendChild(cardEl);
    deps.wireGuides(cardEl);
    const logRow = cardEl.querySelector(".logrow");
    deps.wireLogRow(logRow);
    CairnTodaySessionSetModel.wireLastSetLine(logRow, lastSet, deps);
    deps.wireSkips();
    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
    (cardEl.querySelector<HTMLElement>(".in-r") || cardEl.querySelector<HTMLElement>(".in-dur"))?.focus();
  }

  async function setupAddExercise(deps: TodayAddExerciseDeps): Promise<void> {
    const btn = deps.root.querySelector<HTMLElement>("#addExBtn");
    const form = deps.root.querySelector<HTMLElement>("#addExForm");
    const input = deps.root.querySelector<HTMLInputElement>("#addExInput");
    const go = deps.root.querySelector<HTMLElement>("#addExGo");
    const datalist = deps.root.querySelector("#exOptions");
    const modeWrap = deps.root.querySelector("#addExMode");
    if (!btn || !form || !input || !go || !datalist || !modeWrap) return;

    let mode = "reps";
    modeWrap.querySelectorAll<HTMLElement>("[data-exmode]").forEach((button) => button.addEventListener("click", () => {
      mode = button.dataset.exmode || "reps";
      setMode(modeWrap, mode);
    }));
    const chooseMode = (nextMode: string) => {
      mode = nextMode;
      setMode(modeWrap, mode);
    };

    btn.addEventListener("click", async () => {
      form.hidden = false;
      btn.hidden = true;
      input.focus();
      await loadExerciseOptions(datalist, deps);
    });

    input.addEventListener("input", () => {
      const knownMode = (deps.state.exModes || {})[input.value.trim()];
      if (knownMode) chooseMode(knownMode);
    });

    const add = async () => {
      const name = (input.value || "").trim();
      if (!name) {
        input.focus();
        return;
      }

      const existing = existingCardFor(deps.root, name);
      if (existing) {
        const curMode = existing.dataset.mode || "reps";
        const hasSets = !!existing.querySelector(".logged .chip");
        if (curMode === mode || hasSets) {
          existing.scrollIntoView({ behavior: "smooth", block: "center" });
          (existing.querySelector<HTMLElement>(".in-r") || existing.querySelector<HTMLElement>(".in-dur"))?.focus();
          resetAddForm(input, form, btn, modeWrap);
          if (curMode !== mode && hasSets) deps.toast(`${name} already has sets — delete them to change its type`);
          return;
        }
        try {
          await deps.postExerciseMode(name, mode);
          (deps.state.exModes ??= {})[name] = mode;
        } catch {}
        await replaceEmptyExistingCard(existing, name, mode, deps);
        resetAddForm(input, form, btn, modeWrap);
        return;
      }

      const skippedButton = skippedButtonFor(deps.root, name);
      if (skippedButton) {
        resetAddForm(input, form, btn, modeWrap);
        skippedButton.click();
        return;
      }

      const known = (deps.state.exModes || {})[name];
      if (!known) {
        // A genuinely-new off-plan movement. Persist it now so the exercises row
        // exists immediately — that lets the background brain canonicalize it,
        // write a how-to guide, and generate good art (the 'exercise' enrichment
        // kind). Fire-and-forget: the card renders regardless, and a failed POST
        // just means no enrichment this time. Optimistically mark it known so a
        // rapid re-add doesn't double-post.
        (deps.state.exModes ??= {})[name] = mode || "reps";
        deps.postExerciseMode(name, mode || "reps").catch(() => {});
      } else if (mode === "timed" && known !== "timed") {
        // Known reps exercise being re-added as timed — await so the card renders
        // with the right mode.
        try {
          await deps.postExerciseMode(name, "timed");
          (deps.state.exModes ??= {})[name] = "timed";
        } catch {}
      }
      await appendOffPlanCard(name, mode, deps);
      resetAddForm(input, form, btn, modeWrap);
    };

    go.addEventListener("click", () => { void add(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void add();
    });
  }

  const CAIRN_TODAY_ADD_EXERCISE_CONTROLLER = {
    appendOffPlanCard,
    setupAddExercise,
  };

  Object.assign(globalThis, { CairnTodayAddExerciseController: CAIRN_TODAY_ADD_EXERCISE_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodayAddExerciseController = CAIRN_TODAY_ADD_EXERCISE_CONTROLLER;
  }
})();
