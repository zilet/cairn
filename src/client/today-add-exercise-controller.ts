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
  fmtDur?(seconds: number): string;
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

  // The plan surface primes GET /last-set under exactly this key (loadLastSets in
  // today-plan-session-data-client.ts). A warm entry therefore already knows the
  // last time for most movements, and the card can render its line and prefill in
  // the same frame as the tap instead of waiting on a round-trip.
  function peekLastSet(name: string): Record<string, unknown> | null {
    try {
      if (typeof peekCached !== "function") return null;
      const peek = peekCached<unknown>("last-set:" + name);
      const data = peek ? peek.data : null;
      return data && typeof data === "object" ? data as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  function prefillFromLastSet(lastSet: Record<string, unknown> | null): Record<string, unknown> {
    return {
      weight: lastSet?.weight ?? null,
      reps: lastSet?.reps ?? null,
      rir: lastSet?.rir ?? null,
      duration_sec: lastSet?.duration_sec ?? null,
    };
  }

  function buildCard(
    name: string,
    mode: string | null,
    lastSet: Record<string, unknown> | null,
    deps: TodayAddExerciseDeps,
  ): HTMLElement | null {
    const tpl = document.createElement("template");
    tpl.innerHTML = deps
      .exCard({ exercise: name, fromPlan: false, mode }, [], prefillFromLastSet(lastSet), null, null, lastSet)
      .trim();
    return tpl.content.firstElementChild as HTMLElement | null;
  }

  function wireCard(cardEl: HTMLElement, lastSet: Record<string, unknown> | null, deps: TodayAddExerciseDeps): void {
    deps.wireGuides(cardEl);
    const logRow = cardEl.querySelector(".logrow");
    deps.wireLogRow(logRow);
    CairnTodaySessionSetModel.wireLastSetLine(logRow, lastSet, deps);
    deps.wireSkips();
  }

  function fillInput(el: HTMLInputElement | null | undefined, value: unknown): void {
    if (!el || value == null) return;
    if (el.dataset.dirty === "1") return;
    if (typeof document !== "undefined" && document.activeElement === el) return;
    const next = String(value);
    if (el.value === next) return;
    el.value = next;
  }

  function applyPrefill(
    logRow: HTMLElement,
    lastSet: Record<string, unknown>,
    deps: TodayAddExerciseDeps,
  ): void {
    if (logRow.dataset.mode === "timed") {
      const seconds = Number(lastSet.duration_sec);
      const text = lastSet.duration_sec == null || !Number.isFinite(seconds)
        ? null
        : deps.fmtDur
          ? deps.fmtDur(seconds)
          : String(seconds);
      fillInput(logRow.querySelector<HTMLInputElement>(".in-dur"), text);
      return;
    }
    fillInput(logRow.querySelector<HTMLInputElement>(".in-w"), lastSet.weight);
    fillInput(logRow.querySelector<HTMLInputElement>(".in-r"), lastSet.reps);
    fillInput(logRow.querySelector<HTMLInputElement>(".in-rir"), lastSet.rir);
  }

  function lastSetLineText(lastSet: Record<string, unknown>, deps: TodayAddExerciseDeps): string {
    try {
      return CairnTodaySessionSetModel.lastSetLineText(lastSet, deps as never) || "";
    } catch {
      return "";
    }
  }

  // The "Last time: …" line is the ONLY part of a fresh card that needs the network,
  // so the card is inserted from a (possibly stale) peek and this reconciles when
  // GET /last-set answers. If that never resolves the card is still complete — it
  // just doesn't carry a target. Typed fields (dataset.dirty) and the focused
  // input are left alone; an untouched peek prefill is replaced when the network
  // row differs, and the last-time line is rebuilt so its beat-this wiring tracks
  // the fresh baseline.
  function hydrateLastSet(
    cardEl: HTMLElement | null,
    lastSet: Record<string, unknown> | null,
    deps: TodayAddExerciseDeps,
  ): void {
    if (!cardEl || !lastSet || cardEl.isConnected === false) return;
    const logRow = cardEl.querySelector<HTMLElement>(".logrow");
    if (!logRow) return;
    applyPrefill(logRow, lastSet, deps);
    const text = lastSetLineText(lastSet, deps);
    const existing = cardEl.querySelector<HTMLElement>(".ex-lastset");
    if (!text) {
      existing?.remove();
      return;
    }
    const line = document.createElement("div");
    line.classList.add("ex-lastset");
    line.textContent = text;
    if (existing) existing.replaceWith(line);
    else logRow.before(line);
    CairnTodaySessionSetModel.wireLastSetLine(logRow, lastSet, deps);
  }

  async function hydrateFromNetwork(cardEl: HTMLElement | null, name: string, deps: TodayAddExerciseDeps): Promise<void> {
    if (!cardEl) return;
    hydrateLastSet(cardEl, await fetchLastSet(name, deps), deps);
  }

  function replaceEmptyExistingCard(existing: HTMLElement, name: string, mode: string, deps: TodayAddExerciseDeps): HTMLElement | null {
    const cached = peekLastSet(name);
    const fresh = buildCard(name, mode, cached, deps);
    if (!fresh) return null;
    existing.replaceWith(fresh);
    wireCard(fresh, cached, deps);
    fresh.scrollIntoView({ behavior: "smooth", block: "center" });
    (fresh.querySelector<HTMLElement>(".in-dur") || fresh.querySelector<HTMLElement>(".in-r"))?.focus();
    return fresh;
  }

  function insertOffPlanCard(name: string, mode: string | null | undefined, deps: TodayAddExerciseDeps): HTMLElement | null {
    deps.state.pendingOffPlan ??= {};
    const list = (deps.state.pendingOffPlan[deps.state.logDate] ??= []);
    if (!list.some((pending) => pending.name.toLowerCase() === name.toLowerCase())) {
      list.push({ name, mode: mode || "reps" });
    }

    const cached = peekLastSet(name);
    const cardEl = buildCard(name, mode || null, cached, deps);
    if (!cardEl) return null;
    const addBlock = deps.root.querySelector(".addex");
    if (addBlock) addBlock.before(cardEl);
    else (deps.root.querySelector(".plansurface") || deps.root).appendChild(cardEl);
    wireCard(cardEl, cached, deps);
    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
    (cardEl.querySelector<HTMLElement>(".in-r") || cardEl.querySelector<HTMLElement>(".in-dur"))?.focus();
    return cardEl;
  }

  async function appendOffPlanCard(name: string, mode: string | null | undefined, deps: TodayAddExerciseDeps): Promise<void> {
    await hydrateFromNetwork(insertOffPlanCard(name, mode, deps), name, deps);
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

    // Everything the athlete sees happens in this synchronous pass: the card is
    // inserted and the form is reset before any request is made. Only the
    // "Last time" hydration trails behind, and it is never awaited here.
    const addNow = (): void => {
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
        // The mode is the athlete's own statement about the movement, and the card
        // is rebuilt from it locally either way — so paint it now and let the write
        // catch up. A failed POST costs only the server-side memory of the mode.
        (deps.state.exModes ??= {})[name] = mode;
        deps.postExerciseMode(name, mode).catch(() => {});
        const fresh = replaceEmptyExistingCard(existing, name, mode, deps);
        resetAddForm(input, form, btn, modeWrap);
        void hydrateFromNetwork(fresh, name, deps);
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
        // Known reps exercise being re-added as timed — the card is built with the
        // requested mode locally, so this write never gates the insertion either.
        (deps.state.exModes ??= {})[name] = "timed";
        deps.postExerciseMode(name, "timed").catch(() => {});
      }
      const cardEl = insertOffPlanCard(name, mode, deps);
      resetAddForm(input, form, btn, modeWrap);
      void hydrateFromNetwork(cardEl, name, deps);
    };

    // One tap means one card. Insertion is synchronous, and addNow() no-ops when
    // the name already has a card (existingCardFor), so a tap+Enter in the same
    // breath still lands as one insert.
    const add = (): void => { addNow(); };

    go.addEventListener("click", () => { add(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") add();
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
