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
    lastSet?: unknown
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
  // Same fold as server `normalizeExerciseName`: lowercase, collapse
  // non-alphanumerics to a single space, trim. Client-local — do not import
  // server modules into the PWA bundle.
  function exerciseNameKey(raw: string): string {
    return String(raw ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function lookupExModeEntry(
    exModes: Record<string, string> | undefined,
    name: string
  ): { name: string; mode: string } | null {
    if (!exModes || !name) return null;
    const direct = exModes[name];
    if (direct) return { name, mode: direct };
    const folded = exerciseNameKey(name);
    if (!folded) return null;
    for (const [key, mode] of Object.entries(exModes)) {
      if (exerciseNameKey(key) === folded) return { name: key, mode };
    }
    return null;
  }

  function rememberExMode(state: TodayAddExerciseState, name: string, mode: string): void {
    const modes = (state.exModes ??= {});
    modes[name] = mode;
  }

  function forgetExMode(state: TodayAddExerciseState, name: string): void {
    const modes = state.exModes;
    if (!modes) return;
    delete modes[name];
  }

  function exerciseRowFromResponse(value: unknown): { name: string; mode?: string; muscle_group?: string } | null {
    if (!value || typeof value !== "object") return null;
    const rec = value as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    if (!name) return null;
    return {
      name,
      mode: rec.mode == null || rec.mode === "" ? undefined : String(rec.mode),
      muscle_group: rec.muscle_group == null || rec.muscle_group === "" ? undefined : String(rec.muscle_group),
    };
  }

  function setEncodedData(el: HTMLElement | null, attr: string, value: string): void {
    if (!el) return;
    el.dataset[attr] = encodeURIComponent(value);
  }

  function renamePendingOffPlan(state: TodayAddExerciseState, fromName: string, toName: string, mode?: string): void {
    const list = state.pendingOffPlan?.[state.logDate];
    if (!list) return;
    const fromKey = exerciseNameKey(fromName);
    const toKey = exerciseNameKey(toName);
    const kept: TodayAddExercisePending[] = [];
    const seen = new Set<string>();
    for (const pending of list) {
      const nextName = exerciseNameKey(pending.name) === fromKey ? toName : pending.name;
      const key = exerciseNameKey(nextName);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({
        name: nextName,
        mode: (exerciseNameKey(pending.name) === fromKey && mode) || pending.mode || "reps",
      });
    }
    if (toKey && !seen.has(toKey) && fromKey !== toKey) {
      kept.push({ name: toName, mode: mode || "reps" });
    }
    state.pendingOffPlan![state.logDate] = kept;
  }

  // Rewrite an optimistic off-plan card to the server's canonical row: title,
  // data-card / data-ex (what POST /sets reads), exModes, pendingOffPlan. If a
  // card for that canonical name is already on the surface, merge rather than
  // leave two. Exported for unit tests.
  function applyCanonicalExerciseName(
    cardEl: HTMLElement | null,
    typedName: string,
    row: { name: string; mode?: string; muscle_group?: string },
    deps: TodayAddExerciseDeps
  ): HTMLElement | null {
    if (!cardEl) return null;
    const canonical = String(row.name || "").trim();
    if (!canonical) return cardEl;
    const canonicalKey = exerciseNameKey(canonical);
    const nextMode = row.mode || cardEl.dataset.mode || "reps";

    const other =
      [...deps.root.querySelectorAll<HTMLElement>(".ex[data-card]")].find(
        (el) => el !== cardEl && exerciseNameKey(el.dataset.card || "") === canonicalKey
      ) || null;
    if (other) {
      const optimisticHasSets = !!cardEl.querySelector(".logged .chip");
      const otherHasSets = !!other.querySelector(".logged .chip");
      if (!optimisticHasSets) {
        cardEl.remove();
        forgetExMode(deps.state, typedName);
        rememberExMode(deps.state, canonical, nextMode);
        renamePendingOffPlan(deps.state, typedName, canonical, nextMode);
        other.scrollIntoView({ behavior: "smooth", block: "center" });
        (other.querySelector<HTMLElement>(".in-r") || other.querySelector<HTMLElement>(".in-dur"))?.focus();
        return other;
      }
      if (!otherHasSets) other.remove();
    }

    cardEl.dataset.card = canonical;
    if (row.mode) cardEl.dataset.mode = row.mode;
    const logRow = cardEl.querySelector<HTMLElement>(".logrow");
    setEncodedData(logRow, "ex", canonical);
    if (row.mode && logRow) logRow.dataset.mode = row.mode;
    const nameBtn = cardEl.querySelector<HTMLElement>(".ex-name");
    if (nameBtn) {
      setEncodedData(nameBtn, "guide", canonical);
      const icon = nameBtn.querySelector(".guide-i");
      nameBtn.innerHTML = `${deps.escapeHtml(canonical)} `;
      if (icon) nameBtn.appendChild(icon);
      else {
        const span = document.createElement("span");
        span.className = "guide-i";
        span.textContent = "ⓘ";
        nameBtn.appendChild(span);
      }
    }
    const skipBtn = cardEl.querySelector<HTMLElement>("[data-skip]");
    if (skipBtn) {
      setEncodedData(skipBtn, "skip", canonical);
      skipBtn.setAttribute?.("aria-label", `Skip ${canonical} today`);
    }
    const removeBtn = cardEl.querySelector<HTMLElement>("[data-remove-card]");
    if (removeBtn) removeBtn.setAttribute?.("aria-label", `Remove ${canonical}`);
    if (logRow) {
      const dur = logRow.querySelector<HTMLElement>(".in-dur");
      if (dur) dur.setAttribute?.("aria-label", `${canonical} duration`);
    }

    if (typedName !== canonical) forgetExMode(deps.state, typedName);
    rememberExMode(deps.state, canonical, nextMode);
    renamePendingOffPlan(deps.state, typedName, canonical, nextMode);
    return cardEl;
  }

  async function reconcilePostedExercise(
    cardEl: HTMLElement | null,
    typedName: string,
    posted: Promise<unknown>,
    deps: TodayAddExerciseDeps
  ): Promise<void> {
    try {
      const row = exerciseRowFromResponse(await posted);
      if (!row || !cardEl) return;
      const next = applyCanonicalExerciseName(cardEl, typedName, row, deps);
      if (next && exerciseNameKey(row.name) !== exerciseNameKey(typedName)) {
        void hydrateFromNetwork(next, row.name, deps);
      }
    } catch {
      // The optimistic card stays as typed; a failed POST only means no rewrite.
    }
  }

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
      deps.state.exModes = Object.fromEntries(
        exercises
          .map((row) => {
            const ex = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
            return [String(ex.name || ""), String(ex.mode || "reps")];
          })
          .filter(([name]) => name)
      );
      datalist.innerHTML = exercises
        .map((row) => {
          const ex = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
          return `<option value="${deps.escapeAttr(ex.name)}">${deps.escapeHtml(ex.muscle_group || "")}</option>`;
        })
        .join("");
    } catch {
      // Free-typed names still work.
    }
  }

  function existingCardFor(root: ParentNode, name: string): HTMLElement | null {
    const folded = exerciseNameKey(name);
    return (
      [...root.querySelectorAll<HTMLElement>(".ex[data-card]")].find(
        (el) => exerciseNameKey(el.dataset.card || "") === folded
      ) || null
    );
  }

  function skippedButtonFor(root: ParentNode, name: string): HTMLElement | null {
    const folded = exerciseNameKey(name);
    return (
      [...root.querySelectorAll<HTMLElement>("#skipLine [data-unskip]")].find((button) => {
        // A malformed %-sequence in the dataset (never expected, but not worth a
        // thrown exception over) must not blow up the whole lookup — just skip
        // that button rather than crashing the add-exercise flow around it.
        let decoded = "";
        try {
          decoded = decodeURIComponent(button.dataset.unskip || "");
        } catch {
          return false;
        }
        return exerciseNameKey(decoded) === folded;
      }) || null
    );
  }

  // Shared GET /last-set fetch — feeds both the "Last time: …" prefill/line and the
  // live "That beats last time" wiring, for a freshly-inserted off-plan card exactly
  // like a plan card gets via loadLastSets. Failure (offline, unknown exercise) just
  // means no last-set line this time; the card still renders.
  async function fetchLastSet(name: string, deps: TodayAddExerciseDeps): Promise<Record<string, unknown> | null> {
    try {
      const last = await deps.api("/last-set?exercise=" + encodeURIComponent(name));
      return last && typeof last === "object" ? (last as Record<string, unknown>) : null;
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
      return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
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
    deps: TodayAddExerciseDeps
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

  function applyPrefill(logRow: HTMLElement, lastSet: Record<string, unknown>, deps: TodayAddExerciseDeps): void {
    if (logRow.dataset.mode === "timed") {
      const seconds = Number(lastSet.duration_sec);
      const text =
        lastSet.duration_sec == null || !Number.isFinite(seconds)
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
    deps: TodayAddExerciseDeps
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

  async function hydrateFromNetwork(
    cardEl: HTMLElement | null,
    name: string,
    deps: TodayAddExerciseDeps
  ): Promise<void> {
    if (!cardEl) return;
    hydrateLastSet(cardEl, await fetchLastSet(name, deps), deps);
  }

  function replaceEmptyExistingCard(
    existing: HTMLElement,
    name: string,
    mode: string,
    deps: TodayAddExerciseDeps
  ): HTMLElement | null {
    const cached = peekLastSet(name);
    const fresh = buildCard(name, mode, cached, deps);
    if (!fresh) return null;
    existing.replaceWith(fresh);
    wireCard(fresh, cached, deps);
    fresh.scrollIntoView({ behavior: "smooth", block: "center" });
    (fresh.querySelector<HTMLElement>(".in-dur") || fresh.querySelector<HTMLElement>(".in-r"))?.focus();
    return fresh;
  }

  function insertOffPlanCard(
    name: string,
    mode: string | null | undefined,
    deps: TodayAddExerciseDeps
  ): HTMLElement | null {
    deps.state.pendingOffPlan ??= {};
    const list = (deps.state.pendingOffPlan[deps.state.logDate] ??= []);
    if (!list.some((pending) => exerciseNameKey(pending.name) === exerciseNameKey(name))) {
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
    const cancel = deps.root.querySelector<HTMLElement>("#addExCancel");
    const datalist = deps.root.querySelector("#exOptions");
    const modeWrap = deps.root.querySelector("#addExMode");
    if (!btn || !form || !input || !go || !cancel || !datalist || !modeWrap) return;

    // Opening the form has no way back except typing something and submitting —
    // a Cancel affordance (and Escape, the platform convention for "back out of
    // this") restores the trigger button and clears whatever was typed.
    const cancelAdd = (): void => {
      resetAddForm(input, form, btn, modeWrap);
      btn.focus();
    };
    cancel.addEventListener("click", cancelAdd);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelAdd();
      }
    });

    let mode = "reps";
    modeWrap.querySelectorAll<HTMLElement>("[data-exmode]").forEach((button) =>
      button.addEventListener("click", () => {
        mode = button.dataset.exmode || "reps";
        setMode(modeWrap, mode);
      })
    );
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
      const knownMode = lookupExModeEntry(deps.state.exModes, input.value.trim())?.mode;
      if (knownMode) chooseMode(knownMode);
    });

    // Everything the athlete sees happens in this synchronous pass: the card is
    // inserted and the form is reset before any request is made. Only the
    // "Last time" hydration trails behind, and it is never awaited here.
    const addNow = (): void => {
      const typed = (input.value || "").trim();
      if (!typed) {
        input.focus();
        return;
      }

      const catalog = lookupExModeEntry(deps.state.exModes, typed);
      const name = catalog?.name ?? typed;

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
        rememberExMode(deps.state, name, mode);
        const posted = deps.postExerciseMode(typed, mode);
        const fresh = replaceEmptyExistingCard(existing, name, mode, deps);
        resetAddForm(input, form, btn, modeWrap);
        void hydrateFromNetwork(fresh, name, deps);
        void reconcilePostedExercise(fresh, name, posted, deps);
        return;
      }

      const skippedButton = skippedButtonFor(deps.root, name);
      if (skippedButton) {
        resetAddForm(input, form, btn, modeWrap);
        skippedButton.click();
        return;
      }

      const known = catalog?.mode;
      let posted: Promise<unknown> | null = null;
      if (!known) {
        // A genuinely-new off-plan movement. Persist it now so the exercises row
        // exists immediately — that lets the background brain canonicalize it,
        // write a how-to guide, and generate good art (the 'exercise' enrichment
        // kind). Fire-and-forget: the card renders regardless, and a failed POST
        // just means no enrichment this time. Optimistically mark it known so a
        // rapid re-add doesn't double-post. When POST resolves, rewrite the card
        // to the canonical name so later POST /sets use it.
        rememberExMode(deps.state, name, mode || "reps");
        posted = deps.postExerciseMode(typed, mode || "reps");
      } else if (mode === "timed" && known !== "timed") {
        // Known reps exercise being re-added as timed — the card is built with the
        // requested mode locally, so this write never gates the insertion either.
        rememberExMode(deps.state, name, "timed");
        posted = deps.postExerciseMode(typed, "timed");
      }
      const cardEl = insertOffPlanCard(name, mode, deps);
      resetAddForm(input, form, btn, modeWrap);
      void hydrateFromNetwork(cardEl, name, deps);
      if (posted) void reconcilePostedExercise(cardEl, name, posted, deps);
    };

    // One tap means one card. Insertion is synchronous, and addNow() no-ops when
    // the name already has a card (existingCardFor), so a tap+Enter in the same
    // breath still lands as one insert.
    const add = (): void => {
      addNow();
    };

    go.addEventListener("click", () => {
      add();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        add();
      }
    });
  }

  const CAIRN_TODAY_ADD_EXERCISE_CONTROLLER = {
    exerciseNameKey,
    applyCanonicalExerciseName,
    appendOffPlanCard,
    setupAddExercise,
  };

  Object.assign(globalThis, { CairnTodayAddExerciseController: CAIRN_TODAY_ADD_EXERCISE_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodayAddExerciseController = CAIRN_TODAY_ADD_EXERCISE_CONTROLLER;
  }
})();
